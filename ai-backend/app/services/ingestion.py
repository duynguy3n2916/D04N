"""Pipeline ingest học liệu: parse -> chunk -> embed -> lưu. Chạy trong job nền."""
import logging
import uuid

from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.models.documents import AIChunk, AIDocument
from app.services import jobs
from app.services.chunking import chunk_text
from app.services.embedding import embed_batched
from app.services.parsers import extract, extract_plain_text

log = logging.getLogger("app.ingestion")


def find_duplicate(db: Session, content_hash: str, lesson_id: str | None, class_id: str | None) -> AIDocument | None:
    q = db.query(AIDocument).filter(AIDocument.content_hash == content_hash, AIDocument.is_active.is_not(False),
                                    AIDocument.status.in_(["pending", "processing", "ready"]))
    q = q.filter(AIDocument.lesson_id == lesson_id) if lesson_id else q.filter(AIDocument.lesson_id.is_(None))
    q = q.filter(AIDocument.class_id == class_id) if class_id else q.filter(AIDocument.class_id.is_(None))
    return q.first()


def create_document(db: Session, *, title: str, source_type: str, file_path: str | None, content_hash: str,
                    course_id=None, class_id=None, lesson_id=None, uploaded_by=None,
                    replaces: AIDocument | None = None) -> AIDocument:
    doc = AIDocument(
        title=title, source_type=source_type, file_path=file_path, content_hash=content_hash,
        course_id=course_id, class_id=class_id, lesson_id=lesson_id, uploaded_by=uploaded_by,
        status="pending", is_active=True, version=(replaces.version or 1) + 1 if replaces else 1,
        replaces_id=replaces.id if replaces else None,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return doc


def _chunk_sections(sections: list[dict]) -> list[dict]:
    all_chunks: list[dict] = []
    for item in sections:
        for c in chunk_text(item["text"], section=item.get("section")):
            c["page"] = item.get("page")
            all_chunks.append(c)
    return all_chunks


def index_document(db: Session, doc: AIDocument, sections: list[dict], ctx: "jobs.JobContext | None" = None) -> int:
    doc.status = "processing"
    doc.error_message = None
    db.commit()
    all_chunks = _chunk_sections(sections)
    if not all_chunks:
        raise AppError(422, "NO_TEXT", "Không trích xuất được văn bản nào (file scan ảnh hoặc rỗng?).")
    if ctx:
        ctx.progress(0.2, f"Đã chia {len(all_chunks)} chunk, đang tạo embedding…")
    embeddings = embed_batched([c["content"] for c in all_chunks])
    db.query(AIChunk).filter(AIChunk.document_id == doc.id).delete()
    for idx, (c, emb) in enumerate(zip(all_chunks, embeddings)):
        db.add(AIChunk(document_id=doc.id, content=c["content"], chunk_index=idx, page=c.get("page"),
                       section=(c.get("section") or None) and c["section"][:500], embedding=emb))
    doc.status = "ready"
    # phiên bản mới sẵn sàng -> vô hiệu bản cũ
    if doc.replaces_id:
        old = db.get(AIDocument, doc.replaces_id)
        if old and old.id != doc.id:
            old.is_active = False
    db.commit()
    return len(all_chunks)


@jobs.register("ingest_document")
def ingest_document_job(ctx: "jobs.JobContext", document_id: str, text: str | None = None) -> dict:
    db = ctx.db
    doc = db.get(AIDocument, uuid.UUID(document_id))
    if doc is None:
        raise AppError(404, "NOT_FOUND", "Tài liệu không tồn tại.")
    try:
        ctx.progress(0.05, "Đang trích xuất văn bản…")
        sections = extract_plain_text(text) if text is not None else extract(doc.file_path, doc.source_type)
        n = index_document(db, doc, sections, ctx)
    except Exception as e:
        db.rollback()
        doc = db.get(AIDocument, uuid.UUID(document_id))
        doc.status = "failed"
        doc.error_message = str(getattr(e, "detail", None) or e)[:2000]
        db.commit()
        raise
    return {"document_id": document_id, "chunks": n, "status": "ready"}


def reembed_all(db: Session) -> int:
    """Tạo lại embedding cho toàn bộ chunk (sau khi đổi model embedding)."""
    total = 0
    while True:
        rows = db.query(AIChunk).filter(AIChunk.embedding.is_(None)).limit(256).all()
        if not rows:
            break
        embs = embed_batched([r.content for r in rows])
        for r, e in zip(rows, embs):
            r.embedding = e
        db.commit()
        total += len(rows)
    return total
