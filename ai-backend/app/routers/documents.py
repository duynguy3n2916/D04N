from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.core.errors import AppError
from app.core.security import Principal, ensure_class_access, get_current_user, require_teacher
from app.core.utils import clean_id, parse_uuid
from app.database import get_db
from app.models.documents import AIChunk, AIDocument
from app.services import jobs
from app.services.ingestion import create_document, find_duplicate
from app.services.parsers import SUPPORTED_DOC_TYPES
from app.services.storage import safe_extension, save_upload, sha256_text

router = APIRouter(prefix="/ai", tags=["documents"])


def doc_to_dict(d: AIDocument, chunks: int | None = None) -> dict:
    return {"document_id": str(d.id), "title": d.title, "source_type": d.source_type, "source_id": d.source_id,
            "status": d.status, "error": d.error_message, "version": d.version, "is_active": d.is_active is not False,
            "course_id": d.course_id, "class_id": d.class_id, "lesson_id": d.lesson_id, "uploaded_by": d.uploaded_by,
            "chunks": chunks, "created_at": d.created_at.isoformat() if d.created_at else None}


def _accepted(doc: AIDocument, job) -> JSONResponse:
    return JSONResponse(status_code=202, content={**doc_to_dict(doc), "job_id": str(job.id), "job_status": job.status})


def _get_doc(db: Session, user: Principal, document_id: str) -> AIDocument:
    doc = db.get(AIDocument, parse_uuid(document_id, "document_id"))
    if not doc or not user.can_access_class(doc.class_id):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy tài liệu.")
    return doc


@router.post("/documents/index", status_code=202)
def index_document(
    file: UploadFile = File(...),
    course_id: str | None = Form(None),
    class_id: str | None = Form(None),
    lesson_id: str | None = Form(None),
    replace_document_id: str | None = Form(None),
    user: Principal = Depends(require_teacher),
    db: Session = Depends(get_db),
):
    """Upload PDF/DOCX/PPTX/TXT/MD. Xử lý nền, trả 202 + job_id để theo dõi qua /ai/jobs/{job_id}."""
    course_id, class_id, lesson_id = clean_id(course_id), clean_id(class_id), clean_id(lesson_id)
    ensure_class_access(user, class_id)
    ext = safe_extension(file.filename, SUPPORTED_DOC_TYPES)
    replaces = _get_doc(db, user, replace_document_id) if replace_document_id else None
    path, digest, _ = save_upload(file, "documents", ext, settings.max_document_mb)
    dup = find_duplicate(db, digest, lesson_id, class_id)
    if dup and not replaces:
        path.unlink(missing_ok=True)
        return JSONResponse(status_code=200, content={**doc_to_dict(dup), "duplicate": True,
                                                      "message": "Tài liệu giống hệt đã được nạp trước đó."})
    doc = create_document(db, title=file.filename or f"document.{ext}", source_type=ext, file_path=str(path),
                          content_hash=digest, course_id=course_id, class_id=class_id, lesson_id=lesson_id,
                          uploaded_by=user.user_id, replaces=replaces)
    job = jobs.submit(db, "ingest_document", {"document_id": str(doc.id)}, created_by=user.user_id)
    db.refresh(doc)
    return _accepted(doc, job)


class LessonIndexRequest(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    content: str = Field(min_length=20)
    course_id: str | None = None
    class_id: str | None = None


@router.post("/lessons/{lesson_id}/index", status_code=202)
def index_lesson_text(lesson_id: str, req: LessonIndexRequest, user: Principal = Depends(require_teacher),
                      db: Session = Depends(get_db)):
    """Nạp nội dung bài học dạng văn bản (từ LMS) vào Knowledge Base."""
    lesson_id, class_id = clean_id(lesson_id), clean_id(req.class_id)
    ensure_class_access(user, class_id)
    digest = sha256_text(req.content)
    dup = find_duplicate(db, digest, lesson_id, class_id)
    if dup:
        return JSONResponse(status_code=200, content={**doc_to_dict(dup), "duplicate": True})
    old = (db.query(AIDocument).filter(AIDocument.source_type == "lesson", AIDocument.lesson_id == lesson_id,
                                       AIDocument.title == req.title, AIDocument.is_active.is_not(False)).first())
    doc = create_document(db, title=req.title, source_type="lesson", file_path=None, content_hash=digest,
                          course_id=clean_id(req.course_id), class_id=class_id, lesson_id=lesson_id,
                          uploaded_by=user.user_id, replaces=old)
    job = jobs.submit(db, "ingest_document", {"document_id": str(doc.id), "text": req.content},
                      created_by=user.user_id)
    db.refresh(doc)
    return _accepted(doc, job)


@router.get("/documents")
def list_documents(lesson_id: str | None = None, course_id: str | None = None, include_inactive: bool = False,
                   source_type: str | None = None, user: Principal = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    q = db.query(AIDocument)
    if not include_inactive:
        q = q.filter(AIDocument.is_active.is_not(False), AIDocument.status != "deleted")
    if not user.is_admin:
        q = q.filter((AIDocument.class_id.is_(None)) | (AIDocument.class_id.in_(user.class_ids or [""])))
    if lesson_id:
        q = q.filter(AIDocument.lesson_id == lesson_id)
    if course_id:
        q = q.filter(AIDocument.course_id == course_id)
    if source_type:
        q = q.filter(AIDocument.source_type == source_type)
    docs = q.order_by(AIDocument.created_at.desc()).limit(200).all()
    counts = dict(db.query(AIChunk.document_id, func.count()).filter(AIChunk.document_id.in_([d.id for d in docs]))
                  .group_by(AIChunk.document_id).all()) if docs else {}
    return [doc_to_dict(d, counts.get(d.id, 0)) for d in docs]


@router.get("/documents/{document_id}")
def get_document(document_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    doc = _get_doc(db, user, document_id)
    n = db.query(func.count(AIChunk.id)).filter(AIChunk.document_id == doc.id).scalar()
    return doc_to_dict(doc, n)


@router.get("/documents/{document_id}/chunks")
def get_document_chunks(document_id: str, limit: int = 50, offset: int = 0, user: Principal = Depends(require_teacher),
                        db: Session = Depends(get_db)):
    doc = _get_doc(db, user, document_id)
    rows = (db.query(AIChunk).filter(AIChunk.document_id == doc.id).order_by(AIChunk.chunk_index)
            .offset(offset).limit(min(limit, 200)).all())
    return {"document_id": str(doc.id), "chunks": [
        {"chunk_index": c.chunk_index, "page": c.page, "section": c.section, "start_time": c.start_time,
         "end_time": c.end_time, "content": c.content} for c in rows]}


@router.delete("/documents/{document_id}")
def delete_document(document_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    """Xóa mềm: tài liệu không còn được truy xuất nhưng vẫn giữ để truy vết."""
    doc = _get_doc(db, user, document_id)
    if doc.uploaded_by and doc.uploaded_by != user.user_id and not user.is_admin:
        raise AppError(403, "FORBIDDEN", "Chỉ người tải lên hoặc admin được xóa tài liệu.")
    doc.is_active = False
    doc.status = "deleted"
    db.commit()
    return {"document_id": str(doc.id), "status": doc.status}
