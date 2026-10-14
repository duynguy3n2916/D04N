"""Thành phần phụ của RAG Engine: tìm theo từ khóa (Postgres full-text), hợp nhất RRF, rerank cross-encoder.

- Sparse: to_tsvector('simple', content) (không stemming, hợp với tiếng Việt theo âm tiết) + GIN index.
  Câu hỏi tách thành các âm tiết có nghĩa (bỏ hư từ), nối OR; kết quả chỉ được nhận khi phủ đủ tỉ lệ
  từ khóa (RAG_HYBRID_MIN_COVERAGE) để không lọt chunk chỉ trùng vài từ phổ biến.
- RRF (Reciprocal Rank Fusion): score = Σ 1 / (k + rank) trên các danh sách dense / sparse.
- Rerank (tùy chọn, RAG_RERANK=cross_encoder): chấm lại cặp (câu hỏi, chunk) bằng cross-encoder đa ngôn ngữ.
"""
import logging
import re
import threading
import unicodedata

from app.config import settings

log = logging.getLogger("app.retrieval")

# Hư từ / từ hỏi tiếng Việt và vài từ tiếng Anh phổ biến: không mang nội dung để so khớp từ khóa
STOPWORDS = {
    "là", "gì", "của", "và", "có", "các", "những", "một", "được", "cho", "trong", "này", "thì", "như", "với",
    "khi", "nào", "sao", "thế", "vì", "để", "ra", "vào", "bị", "do", "đó", "đây", "kia", "ở", "tại", "từ",
    "theo", "về", "rồi", "cũng", "nhưng", "hay", "hoặc", "nếu", "mà", "nên", "không", "chưa", "đã", "đang",
    "sẽ", "bao", "nhiêu", "ai", "đâu", "em", "anh", "chị", "bạn", "mình", "tôi", "ạ", "nhé", "hãy", "giúp",
    "giải", "thích", "cho", "biết", "the", "a", "an", "of", "to", "is", "are", "what", "how", "in", "and", "or",
}
_TOKEN = re.compile(r"\w+", re.UNICODE)


def query_terms(text: str) -> list[str]:
    """Các từ có nghĩa (giữ thứ tự, không trùng) dùng cho tìm từ khóa."""
    seen, out = set(), []
    for t in _TOKEN.findall(unicodedata.normalize("NFC", (text or "").lower())):
        if len(t) < 2 and not t.isdigit() or t in STOPWORDS or t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out[:32]


def tsquery_text(terms: list[str]) -> str | None:
    """Biểu thức to_tsquery dạng 'a | b | c' (chỉ chữ/số nên không thể chèn toán tử)."""
    safe = [t for t in terms if t.isalnum()]
    return " | ".join(safe) if safe else None


def coverage(terms: list[str], content: str) -> float:
    if not terms:
        return 0.0
    words = set(_TOKEN.findall(unicodedata.normalize("NFC", (content or "").lower())))
    return sum(1 for t in terms if t in words) / len(terms)


def lexical_accept(terms: list[str], content: str) -> bool:
    """Chunk chỉ khớp từ khóa được coi là liên quan khi phủ đủ tỉ lệ từ có nghĩa của câu hỏi."""
    if not terms:
        return False
    cov = coverage(terms, content)
    need_terms = 1 if len(terms) == 1 else 2
    return cov >= settings.rag_hybrid_min_coverage and cov * len(terms) >= need_terms


def rrf(rank_lists: list[list[str]], k: int = 60) -> dict[str, float]:
    scores: dict[str, float] = {}
    for ranks in rank_lists:
        for i, key in enumerate(ranks):
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + i + 1)
    return scores


# ----------------------------------------------------------------------------
# Rerank
# ----------------------------------------------------------------------------

_reranker = None
_rerank_lock = threading.Lock()
_rerank_failed = False


def _get_reranker():
    global _reranker, _rerank_failed
    if _reranker is None and not _rerank_failed:
        with _rerank_lock:
            if _reranker is None and not _rerank_failed:
                try:
                    from sentence_transformers import CrossEncoder
                    _reranker = CrossEncoder(settings.rag_rerank_model, max_length=512)
                except Exception:
                    _rerank_failed = True  # không tải được model: giữ thứ tự cũ, không làm hỏng Tutor
                    log.exception("reranker_load_failed")
    return _reranker


def rerank(query: str, chunks: list[dict], top_k: int) -> list[dict]:
    """Sắp lại theo cross-encoder nếu bật RAG_RERANK=cross_encoder; lỗi thì giữ nguyên thứ tự."""
    if settings.rag_rerank != "cross_encoder" or len(chunks) < 2:
        return chunks[:top_k]
    model = _get_reranker()
    if model is None:
        return chunks[:top_k]
    try:
        scores = model.predict([(query, c["content"][:2000]) for c in chunks])
    except Exception:
        log.exception("rerank_failed")
        return chunks[:top_k]
    for c, s in zip(chunks, scores):
        c["rerank_score"] = round(float(s), 4)
    return sorted(chunks, key=lambda c: c["rerank_score"], reverse=True)[:top_k]
