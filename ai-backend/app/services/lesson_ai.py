"""Dùng chung cho các tác vụ AI theo bài học (sơ đồ tư duy, flashcard): lấy học liệu của bài và giải nhãn nguồn."""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import Principal
from app.models.documents import AIChunk, AIDocument
from app.models.learning import Lesson
from app.services import learning
from app.services.retrieval import RetrievalScope, _apply_scope, _row_to_dict, build_context

SOURCE_KEYS = ("label", "display", "source_type", "source_id", "document_id", "document_title", "page", "section",
               "start_time", "end_time", "chunk_id")


def lesson_by_code(db: Session, user: Principal, lesson_code: str, teacher: bool = False) -> Lesson:
    lesson = db.query(Lesson).filter(Lesson.code == lesson_code).first()
    if lesson is None or not learning.can_see_course(db, user, lesson.chapter.course):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bài học.")
    if teacher and not user.is_teacher:
        raise AppError(403, "FORBIDDEN", "Chỉ giáo viên mới dùng được chức năng này.")
    return lesson


def lesson_context(db: Session, lesson: Lesson, max_chars: int = 12000, max_chunks: int = 40) -> tuple[str, list[dict]]:
    """Toàn bộ học liệu của bài theo thứ tự tài liệu (bài đọc, slide, lời giảng video), kèm nhãn [S1]..."""
    scope = RetrievalScope(allowed_class_ids=None, lesson_id=lesson.code)
    stmt = (_apply_scope(select(AIChunk, AIDocument).join(AIDocument, AIChunk.document_id == AIDocument.id), scope)
            .order_by(AIDocument.created_at, AIChunk.chunk_index).limit(max_chunks * 4))
    rows = [_row_to_dict(c, d, None) for c, d in db.execute(stmt).all()]
    if not rows:
        raise AppError(400, "NO_CONTEXT", "Bài này chưa có học liệu đã nạp (bài đọc, slide hoặc phụ đề video).")
    # Xen kẽ giữa các tài liệu (bài đọc, slide, video) để tài liệu nạp trước không chiếm hết giới hạn ký tự:
    # nhờ vậy sơ đồ / thẻ có nguồn từ mọi loại học liệu của bài.
    by_doc: dict[str, list[dict]] = {}
    for r in rows:
        by_doc.setdefault(r["document_id"], []).append(r)
    queues = list(by_doc.values())
    chunks: list[dict] = []
    while len(chunks) < max_chunks and any(queues):
        for q in queues:
            if q and len(chunks) < max_chunks:
                chunks.append(q.pop(0))
    return build_context(chunks, max_chars=max_chars)


def resolve_sources(labels: list[str] | None, sources: list[dict]) -> list[dict]:
    """Đổi nhãn "S1" mà model trả về thành thông tin nguồn đầy đủ; bỏ nhãn không tồn tại."""
    by_label = {s["label"]: s for s in sources}
    out, seen = [], set()
    for lab in labels or []:
        key = str(lab).strip().strip("[]").upper()
        if key in by_label and key not in seen:
            seen.add(key)
            out.append({k: by_label[key].get(k) for k in SOURCE_KEYS})
    return out
