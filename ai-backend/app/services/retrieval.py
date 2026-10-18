"""RAG Engine dùng chung: lọc phạm vi -> vector + từ khóa (hybrid, RRF) -> ngưỡng điểm -> rerank
-> mở rộng lân cận -> context có nhãn nguồn."""
import re
from dataclasses import dataclass, field

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.core.security import Principal
from app.core.utils import fmt_ts
from app.models.documents import AIChunk, AIDocument
from app.models.learning import Chapter, Course, CourseClass, Lesson, LessonItem
from app.models.transcript import TranscriptSegment, VideoTranscript
from app.services.embedding import embed_query
from app.services.hybrid import lexical_accept, query_terms, rerank, rrf, tsquery_text

_WORDS = re.compile(r"\w+")
# dấu hiệu câu hỏi nối tiếp, phụ thuộc câu trước ("còn X thì sao?", "nó dùng để làm gì?", "cho ví dụ")
_FOLLOW_UP = re.compile(r"^(còn|vậy|thế|và)\b|thì sao|\bnó\b|\bcái (đó|này)\b|\bđiều (đó|này)\b|\bví dụ\b"
                        r"|\bgiải thích (thêm|rõ hơn)\b|\btiếp\b|\bở trên\b|\bvừa (rồi|nói)\b")


@dataclass
class RetrievalScope:
    """Phạm vi truy xuất. allowed_class_ids=None nghĩa là không giới hạn lớp (admin / evaluation)."""
    allowed_class_ids: list[str] | None = field(default_factory=list)
    course_id: str | None = None
    class_id: str | None = None
    lesson_id: str | None = None
    document_ids: list[str] | None = None
    source_types: list[str] | None = None
    video_id: str | None = None

    @classmethod
    def for_user(cls, user: Principal, **kw) -> "RetrievalScope":
        return cls(allowed_class_ids=None if user.is_admin else list(user.class_ids), **kw)


def _apply_scope(stmt, scope: RetrievalScope):
    stmt = stmt.where(AIDocument.status == "ready", AIDocument.is_active.is_not(False))
    # Các nguồn của bài LMS phải còn được gắn trong mục học. File giữ trong thư viện
    # để tái sử dụng, nhưng bỏ/thay slide hoặc bài đọc sẽ loại nguồn cũ ngay khỏi RAG.
    managed_lesson = select(Lesson.id).where(Lesson.code == AIDocument.lesson_id).exists()
    attached_source = (select(LessonItem.id).join(Lesson, LessonItem.lesson_id == Lesson.id)
                       .where(Lesson.code == AIDocument.lesson_id,
                              or_(LessonItem.document_id == AIDocument.id,
                                  and_(AIDocument.source_type == "video", LessonItem.type == "video",
                                       LessonItem.video_id == AIDocument.source_id))).exists())
    stmt = stmt.where(or_(~managed_lesson, ~AIDocument.source_type.in_(["pdf", "pptx", "lesson", "video"]),
                          attached_source))
    if scope.allowed_class_ids is not None:
        allowed = scope.allowed_class_ids or [""]
        # tài liệu của lớp chính, hoặc tài liệu thuộc bài của khóa học được gắn cho một lớp người dùng thuộc về
        shared_codes = (select(Lesson.code).join(Chapter, Lesson.chapter_id == Chapter.id)
                        .join(Course, Chapter.course_id == Course.id)
                        .where(or_(Course.class_id.in_(allowed),
                                   Course.id.in_(select(CourseClass.course_id).where(CourseClass.class_id.in_(allowed))))))
        stmt = stmt.where(or_(AIDocument.class_id.is_(None), AIDocument.class_id.in_(allowed),
                              AIDocument.lesson_id.in_(shared_codes)))
    if scope.course_id:
        stmt = stmt.where(AIDocument.course_id == scope.course_id)
    if scope.class_id:
        stmt = stmt.where(AIDocument.class_id == scope.class_id)
    if scope.lesson_id:
        stmt = stmt.where(AIDocument.lesson_id == scope.lesson_id)
    if scope.document_ids is not None:
        stmt = stmt.where(AIDocument.id.in_(scope.document_ids))
    if scope.source_types:
        stmt = stmt.where(AIDocument.source_type.in_(scope.source_types))
    if scope.video_id:
        stmt = stmt.where(and_(AIDocument.source_type == "video", AIDocument.source_id == scope.video_id))
    return stmt


def _row_to_dict(chunk: AIChunk, doc: AIDocument, score: float | None) -> dict:
    return {
        "chunk_id": str(chunk.id),
        "content": chunk.content,
        "score": round(score, 4) if score is not None else None,
        "page": chunk.page,
        "section": chunk.section,
        "chunk_index": chunk.chunk_index,
        "start_time": chunk.start_time,
        "end_time": chunk.end_time,
        "document_id": str(doc.id),
        "document_title": doc.title,
        "source_type": doc.source_type,
        "source_id": doc.source_id,
        "lesson_id": doc.lesson_id,
    }


def retrieve(db: Session, query: str, scope: RetrievalScope, top_k: int | None = None,
             min_score: float | None = None, hybrid: bool | None = None) -> list[dict]:
    """Dense (pgvector) [+ sparse full-text, hợp nhất RRF] [+ rerank]; mỗi kết quả có `score` = cosine.

    Một chunk được nhận khi cosine >= min_score, hoặc (hybrid) khớp đủ từ khóa có nghĩa của câu hỏi
    (`lexical_match`) — nên ngưỡng từ chối vẫn có tác dụng với câu ngoài học liệu.
    """
    top_k = top_k or settings.rag_top_k
    min_score = settings.rag_min_score if min_score is None else min_score
    hybrid = settings.rag_hybrid if hybrid is None else hybrid
    pool = top_k * 3 if (hybrid or settings.rag_rerank != "none") else top_k * 2
    q_emb = embed_query(query)
    distance = AIChunk.embedding.cosine_distance(q_emb).label("distance")
    base = select(AIChunk, AIDocument, distance).join(AIDocument, AIChunk.document_id == AIDocument.id)
    base = _apply_scope(base, scope).where(AIChunk.embedding.is_not(None))

    found: dict[str, dict] = {}
    dense_rank: list[str] = []
    for chunk, doc, dist in db.execute(base.order_by(distance).limit(pool)).all():
        d = _row_to_dict(chunk, doc, 1.0 - float(dist))
        found[d["chunk_id"]] = d
        dense_rank.append(d["chunk_id"])

    sparse_rank: list[str] = []
    terms = query_terms(query) if hybrid else []
    tsq_text = tsquery_text(terms)
    if tsq_text:
        tsv = func.to_tsvector("simple", AIChunk.content)
        tsq = func.to_tsquery("simple", tsq_text)
        rank = func.ts_rank_cd(tsv, tsq).label("lex_rank")
        stmt = base.add_columns(rank).where(tsv.op("@@")(tsq)).order_by(rank.desc()).limit(pool)
        for chunk, doc, dist, lex in db.execute(stmt).all():
            if not lexical_accept(terms, chunk.content):
                continue
            key = str(chunk.id)
            d = found.get(key) or _row_to_dict(chunk, doc, 1.0 - float(dist))
            d["lexical_match"] = True
            d["lexical_rank"] = round(float(lex), 4)
            found[key] = d
            sparse_rank.append(key)

    if min_score > 0:
        accepted = [k for k, d in found.items() if (d["score"] or 0) >= min_score or d.get("lexical_match")]
    else:
        accepted = list(found)
    if sparse_rank:
        fused = rrf([dense_rank, sparse_rank])
        for k in accepted:
            found[k]["rrf"] = round(fused.get(k, 0.0), 6)
        accepted.sort(key=lambda k: fused.get(k, 0.0), reverse=True)
    else:
        order = {k: i for i, k in enumerate(dense_rank)}
        accepted.sort(key=lambda k: order.get(k, len(order)))
    candidates = [found[k] for k in accepted]
    return rerank(query, candidates, top_k) if settings.rag_rerank != "none" else candidates[:top_k]


def contextual_query(question: str, history: list[dict]) -> str:
    """Viết lại câu hỏi nối tiếp ("còn kế thừa thì sao?") thành truy vấn đủ ngữ cảnh để truy xuất.

    Chế độ `history` (mặc định, không tốn LLM): câu ngắn CÓ dấu hiệu hỏi nối tiếp thì ghép câu hỏi trước
    của học sinh vào truy vấn. Câu không có dấu hiệu đó giữ nguyên, để câu lạc đề vẫn bị từ chối đúng.
    """
    if settings.rag_query_rewrite == "none" or len(_WORDS.findall(question)) > 8:
        return question
    if not _FOLLOW_UP.search(question.lower()):
        return question
    prev = next((m["content"] for m in reversed(history) if m.get("role") == "user"
                 and not m["content"].startswith("(Tóm tắt")), None)
    return f"{prev[:300]} {question}" if prev else question


def expand_neighbors(db: Session, chunks: list[dict], top_n: int = 2) -> list[dict]:
    """Ghép thêm chunk liền trước/sau cho các kết quả tốt nhất (tài liệu, không áp dụng video)."""
    out = []
    for i, c in enumerate(chunks):
        if i >= top_n or c["source_type"] == "video":
            out.append(c)
            continue
        rows = (db.query(AIChunk)
                .filter(AIChunk.document_id == c["document_id"],
                        AIChunk.chunk_index.in_([c["chunk_index"] - 1, c["chunk_index"] + 1]))
                .order_by(AIChunk.chunk_index).all())
        before = [r.content for r in rows if r.chunk_index < c["chunk_index"]]
        after = [r.content for r in rows if r.chunk_index > c["chunk_index"]]
        merged = dict(c)
        merged["content"] = "\n".join(
            ([f"(đoạn trước) {before[0][-300:]}"] if before else []) + [c["content"]] +
            ([f"(đoạn sau) {after[0][:300]}"] if after else []))
        out.append(merged)
    return out


def active_transcript(db: Session, video_id: str) -> VideoTranscript | None:
    return (db.query(VideoTranscript)
            .filter(VideoTranscript.video_id == video_id, VideoTranscript.status == "ready",
                    VideoTranscript.is_active.is_not(False))
            .order_by(VideoTranscript.created_at.desc()).first())


def transcript_window(db: Session, video_id: str, start: float, end: float,
                      transcript: VideoTranscript | None = None) -> tuple[list[TranscriptSegment], VideoTranscript | None]:
    tr = transcript or active_transcript(db, video_id)
    if not tr:
        return [], None
    segs = (db.query(TranscriptSegment)
            .filter(TranscriptSegment.transcript_id == tr.id,
                    TranscriptSegment.end_time >= max(0.0, start),
                    TranscriptSegment.start_time <= end)
            .order_by(TranscriptSegment.start_time).all())
    return segs, tr


def format_segments(segs: list[TranscriptSegment]) -> str:
    return "\n".join(f"[{fmt_ts(s.start_time)}–{fmt_ts(s.end_time)}] {s.text}" for s in segs)


def source_label(c: dict) -> str:
    if c.get("source_type") == "video":
        return f"Video {c.get('source_id')} {fmt_ts(c.get('start_time'))}–{fmt_ts(c.get('end_time'))}"
    loc = f"trang {c['page']}" if c.get("page") else (c.get("section") or "")
    return f"{c.get('document_title')}" + (f" — {loc}" if loc else "")


def build_context(chunks: list[dict], transcript_block: dict | None = None,
                  max_chars: int | None = None) -> tuple[str, list[dict]]:
    """Ghép context với nhãn [S1], [S2]...; trả về (context, danh sách nguồn kèm nhãn)."""
    max_chars = max_chars or settings.rag_max_context_chars
    parts: list[str] = []
    sources: list[dict] = []
    used = 0
    items: list[dict] = []
    if transcript_block:
        items.append(transcript_block)
    items.extend(chunks)
    for item in items:
        n = len(sources) + 1
        label = f"S{n}"
        header = f"[{label}] {item.get('label') or source_label(item)}"
        body = item["content"]
        if used + len(body) > max_chars:
            body = body[: max(0, max_chars - used)]
            if len(body) < 200:
                break
        parts.append(f"{header}\n{body}")
        used += len(body)
        src = {k: v for k, v in item.items() if k != "content"}
        src["label"] = label
        src["display"] = item.get("label") or source_label(item)
        sources.append(src)
    return "\n\n".join(parts), sources
