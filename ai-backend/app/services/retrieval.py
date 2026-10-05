"""RAG Engine dùng chung: lọc phạm vi -> vector search -> ngưỡng điểm -> mở rộng lân cận -> context có nhãn nguồn."""
from dataclasses import dataclass, field

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.core.security import Principal
from app.core.utils import fmt_ts
from app.models.documents import AIChunk, AIDocument
from app.models.transcript import TranscriptSegment, VideoTranscript
from app.services.embedding import embed_query


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
    if scope.allowed_class_ids is not None:
        stmt = stmt.where(or_(AIDocument.class_id.is_(None), AIDocument.class_id.in_(scope.allowed_class_ids or [""])))
    if scope.course_id:
        stmt = stmt.where(AIDocument.course_id == scope.course_id)
    if scope.class_id:
        stmt = stmt.where(AIDocument.class_id == scope.class_id)
    if scope.lesson_id:
        stmt = stmt.where(AIDocument.lesson_id == scope.lesson_id)
    if scope.document_ids:
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
             min_score: float | None = None) -> list[dict]:
    top_k = top_k or settings.rag_top_k
    min_score = settings.rag_min_score if min_score is None else min_score
    q_emb = embed_query(query)
    distance = AIChunk.embedding.cosine_distance(q_emb).label("distance")
    stmt = select(AIChunk, AIDocument, distance).join(AIDocument, AIChunk.document_id == AIDocument.id)
    stmt = _apply_scope(stmt, scope).where(AIChunk.embedding.is_not(None)).order_by(distance).limit(top_k * 2)
    results = []
    for chunk, doc, dist in db.execute(stmt).all():
        score = 1.0 - float(dist)
        if score < min_score:
            continue
        results.append(_row_to_dict(chunk, doc, score))
        if len(results) >= top_k:
            break
    return results


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
