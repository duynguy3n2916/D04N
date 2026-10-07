"""Giáo viên quản lý cấu trúc khóa học: khóa → chương → bài → mục (video / slide / bài đọc / kiểm tra)."""
import re

from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import Principal, ensure_class_access
from app.core.utils import generate_code
from app.models.documents import AIDocument
from app.models.learning import Chapter, Course, Lesson, LessonItem, MediaVideo
from app.models.transcript import VideoTranscript
from app.services import jobs
from app.services.ingestion import create_document, find_duplicate
from app.services.learning import ITEM_TYPES
from app.services.storage import sha256_text

_CODE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def _check_code(code: str) -> str:
    code = (code or "").strip()
    if not _CODE.match(code):
        raise AppError(400, "INVALID_CODE", "Mã chỉ gồm chữ, số, dấu chấm, gạch ngang, gạch dưới (tối đa 128 ký tự).")
    return code


def _next_pos(items) -> int:
    return (max((i.position for i in items), default=-1) + 1)


def admin_tree(course: Course) -> dict:
    """Cấu trúc đầy đủ cho màn hình soạn khóa học (không có trạng thái học)."""
    return {
        "course_id": str(course.id), "code": course.code, "title": course.title, "description": course.description,
        "class_id": course.class_id,
        "chapters": [{
            "chapter_id": str(ch.id), "title": ch.title, "position": ch.position,
            "lessons": [{
                "lesson_id": str(ls.id), "code": ls.code, "title": ls.title, "description": ls.description,
                "position": ls.position,
                "items": [{"item_id": str(it.id), "type": it.type, "title": it.title, "position": it.position,
                           "video_id": it.video_id, "document_id": str(it.document_id) if it.document_id else None,
                           "meta": it.meta, "has_content": bool(it.content_md)} for it in ls.items],
            } for ls in ch.lessons],
        } for ch in course.chapters],
    }


def create_course(db: Session, user: Principal, code: str | None, title: str, description: str | None,
                  class_id: str | None) -> Course:
    ensure_class_access(user, class_id)
    code = _check_code(code) if code and code.strip() else generate_code("KH")
    if db.query(Course).filter(Course.code == code).first():
        raise AppError(409, "DUPLICATE_CODE", f"Mã khóa học {code} đã tồn tại.")
    c = Course(code=code, title=title.strip(), description=description, class_id=class_id, created_by=user.user_id)
    db.add(c)
    db.commit()
    return c


def update_course(db: Session, user: Principal, course: Course, data: dict) -> Course:
    if "class_id" in data:
        ensure_class_access(user, data["class_id"])
        course.class_id = data["class_id"]
    for k in ("title", "description"):
        if data.get(k) is not None:
            setattr(course, k, data[k])
    db.commit()
    return course


def add_chapter(db: Session, course: Course, title: str) -> Chapter:
    ch = Chapter(course_id=course.id, title=title.strip(), position=_next_pos(course.chapters))
    db.add(ch)
    db.commit()
    return ch


def add_lesson(db: Session, chapter: Chapter, code: str | None, title: str, description: str | None) -> Lesson:
    code = _check_code(code) if code and code.strip() else generate_code("BH")
    if db.query(Lesson).filter(Lesson.code == code).first():
        raise AppError(409, "DUPLICATE_CODE", f"Mã bài học {code} đã tồn tại.")
    ls = Lesson(chapter_id=chapter.id, code=code, title=title.strip(), description=description,
                position=_next_pos(chapter.lessons))
    db.add(ls)
    db.commit()
    return ls


def _index_reading(db: Session, user: Principal, item: LessonItem) -> None:
    """Bài đọc được nạp vào Knowledge Base để Tutor trả lời được."""
    content = item.content_md or ""
    if len(content.strip()) < 20:
        return
    lesson = item.lesson
    class_id = lesson.chapter.course.class_id
    digest = sha256_text(content)
    dup = find_duplicate(db, digest, lesson.code, class_id)
    if dup:
        item.document_id = dup.id
        db.commit()
        return
    old = db.get(AIDocument, item.document_id) if item.document_id else None
    doc = create_document(db, title=item.title, source_type="lesson", file_path=None, content_hash=digest,
                          course_id=lesson.chapter.course.code, class_id=class_id, lesson_id=lesson.code,
                          uploaded_by=user.user_id, replaces=old)
    item.document_id = doc.id
    db.commit()
    jobs.submit(db, "ingest_document", {"document_id": str(doc.id), "text": content}, created_by=user.user_id)


def _apply_item_fields(db: Session, item: LessonItem, data: dict) -> None:
    t = item.type
    if data.get("title") is not None:
        item.title = data["title"].strip()
    if t == "video" and data.get("video_id") is not None:
        vid = data["video_id"].strip()
        media = db.get(MediaVideo, vid)
        has_tr = db.query(VideoTranscript.id).filter(VideoTranscript.video_id == vid).first()
        if not media and not has_tr:
            raise AppError(400, "UNKNOWN_VIDEO", f"Chưa có video {vid}. Tải video lên ở mục Video trước.")
        item.video_id = vid
        if media and media.duration_seconds:
            item.duration_seconds = media.duration_seconds
    if t == "slide":
        if data.get("document_id") is not None:
            doc = db.get(AIDocument, data["document_id"])
            if not doc or doc.source_type not in ("pdf", "pptx"):
                raise AppError(400, "INVALID_SLIDE", "Slide phải là tài liệu PDF hoặc PPTX đã nạp.")
            item.document_id = doc.id
            meta = dict(item.meta or {})
            if doc.file_path:
                try:
                    if doc.source_type == "pdf":
                        from pypdf import PdfReader
                        meta["pages"] = len(PdfReader(doc.file_path).pages)
                    else:
                        from pptx import Presentation
                        meta["pages"] = len(Presentation(doc.file_path).slides)
                except Exception:
                    pass
            item.meta = meta
        if data.get("notes") is not None:
            item.meta = {**(item.meta or {}), "notes": data["notes"]}
    if t == "reading" and data.get("content_md") is not None:
        item.content_md = data["content_md"]
    if t == "quiz":
        meta = dict(item.meta or {"count": 5, "pass_ratio": 0.8})
        if data.get("count") is not None:
            meta["count"] = max(1, min(30, int(data["count"])))
        if data.get("pass_ratio") is not None:
            meta["pass_ratio"] = max(0.1, min(1.0, float(data["pass_ratio"])))
        item.meta = meta


def add_item(db: Session, user: Principal, lesson: Lesson, data: dict) -> LessonItem:
    t = data.get("type")
    if t not in ITEM_TYPES:
        raise AppError(400, "INVALID_TYPE", f"type phải là một trong {ITEM_TYPES}")
    item = LessonItem(lesson_id=lesson.id, type=t, title=(data.get("title") or "").strip() or t,
                      position=_next_pos(lesson.items), meta={"count": 5, "pass_ratio": 0.8} if t == "quiz" else None)
    db.add(item)
    db.flush()
    db.refresh(item)
    _apply_item_fields(db, item, data)
    if t == "video" and not item.video_id:
        raise AppError(400, "VIDEO_REQUIRED", "Mục video cần video_id.")
    if t == "slide" and not item.document_id:
        raise AppError(400, "DOCUMENT_REQUIRED", "Mục slide cần document_id (PDF/PPTX đã nạp).")
    db.commit()
    if t == "reading":
        _index_reading(db, user, item)
    return item


def update_item(db: Session, user: Principal, item: LessonItem, data: dict) -> LessonItem:
    before = item.content_md
    _apply_item_fields(db, item, data)
    db.commit()
    if item.type == "reading" and item.content_md != before:
        _index_reading(db, user, item)
    return item


def move(db: Session, obj, siblings: list, direction: int) -> None:
    ordered = sorted(siblings, key=lambda x: x.position)
    idx = next(i for i, x in enumerate(ordered) if x.id == obj.id)
    j = idx + direction
    if 0 <= j < len(ordered):
        ordered[idx], ordered[j] = ordered[j], ordered[idx]
        for pos, x in enumerate(ordered):
            x.position = pos
        db.commit()
