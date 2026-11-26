"""API soạn khóa học cho giáo viên: khóa / chương / bài / mục, ảnh bìa, lớp dùng khóa, bài nộp của lớp."""
import mimetypes

from fastapi import APIRouter, Depends, File, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import Principal, get_user_for_media, require_teacher
from app.core.utils import clean_id, parse_uuid
from app.database import get_db
from app.models.learning import Chapter, Course
from app.services.courses import course_admin, learning
from app.services.media.object_store import get_store

router = APIRouter(prefix="/ai", tags=["courses"])




@router.get("/classes/{class_id}/submissions")
def class_submissions(class_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    """Giáo viên xem bài kiểm tra từng học viên trong lớp đã làm, chưa làm, đạt hay chưa."""
    return learning.class_submissions(db, user, clean_id(class_id))


@router.get("/classes/{class_id}/submissions.csv")
def class_submissions_csv(class_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    """Bảng bài nộp của lớp dạng CSV (UTF-8 có BOM để Excel đọc đúng tiếng Việt)."""
    import csv
    import io
    from urllib.parse import quote

    from fastapi.responses import Response
    data = learning.class_submissions(db, user, clean_id(class_id))
    labels = {"passed": "Đạt", "failed": "Chưa đạt", "in_progress": "Đang làm", "not_started": "Chưa làm"}
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Mã học viên", "Họ tên", "Khóa học", "Bài", "Bài kiểm tra", "Kết quả", "Số câu đúng", "Tổng câu",
                "Điểm (%)", "Hết giờ", "Bắt đầu", "Nộp lúc"])
    for r in data["rows"]:
        w.writerow([r["student_id"], r["student_name"], r["course_title"], r["lesson_code"], r["quiz_title"],
                    labels.get(r["status"], r["status"]), r["correct"] if r["correct"] is not None else "",
                    r["total"] or "", round(r["score"] * 100) if r["score"] is not None else "",
                    "Có" if r["time_up"] else "", r["started_at"] or "", r["finished_at"] or ""])
    name = quote(f"bai-nop-{data['class_id']}.csv")
    return Response("\ufeff" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename=\"bai-nop.csv\"; filename*=UTF-8''{name}"})


def _course(db, user, cid) -> Course:
    return learning.get_course(db, user, parse_uuid(cid, "course_id"))


def _chapter(db, user, cid) -> Chapter:
    ch = db.get(Chapter, parse_uuid(cid, "chapter_id"))
    if not ch or not learning.can_see_course(db, user, ch.course):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy chương.")
    return ch


def _tree(db: Session, course) -> dict:
    """Cây khóa học sau khi sửa. Session dùng expire_on_commit=False nên phải làm mới các quan hệ đã nạp."""
    db.expire_all()
    out = course_admin.admin_tree(course)
    out["class_ids"] = learning.course_class_ids(db, course)
    return out


class CourseClassIn(BaseModel):
    class_id: str = Field(min_length=1, max_length=64)


@router.post("/courses/{course_id}/classes", status_code=201)
def add_course_class(course_id: str, req: CourseClassIn, user: Principal = Depends(require_teacher),
                     db: Session = Depends(get_db)):
    """Cho một lớp (mà giáo viên phụ trách) học khóa này."""
    course = learning.set_course_class(db, user, parse_uuid(course_id, "course_id"), clean_id(req.class_id), add=True)
    return _tree(db, course)


@router.delete("/courses/{course_id}/classes/{class_id}")
def remove_course_class(course_id: str, class_id: str, user: Principal = Depends(require_teacher),
                        db: Session = Depends(get_db)):
    course = learning.set_course_class(db, user, parse_uuid(course_id, "course_id"), clean_id(class_id), add=False)
    return _tree(db, course)


class CourseIn(BaseModel):
    code: str | None = None
    title: str | None = None
    description: str | None = None
    class_id: str | None = None


@router.get("/courses")
def list_courses_admin(user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    rows = learning.visible_courses(db, user, with_tree=True)
    out = []
    for c in rows:
        n_items = sum(len(ls.items) for ch in c.chapters for ls in ch.lessons)
        out.append({"course_id": str(c.id), "code": c.code, "title": c.title, "class_id": c.class_id,
                    "class_ids": learning.course_class_ids(db, c),
                    "cover_url": learning.cover_url(c), "chapters": len(c.chapters), "items": int(n_items or 0)})
    return out


@router.post("/courses")
def create_course(req: CourseIn, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    if not req.title or not req.title.strip():
        raise AppError(400, "BAD_REQUEST", "Cần tên khóa học.")
    c = course_admin.create_course(db, user, req.code, req.title, req.description, clean_id(req.class_id))
    return _tree(db, c)


@router.get("/courses/{course_id}")
def get_course_admin(course_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    return _tree(db, _course(db, user, course_id))


@router.patch("/courses/{course_id}")
def update_course(course_id: str, req: CourseIn, user: Principal = Depends(require_teacher),
                  db: Session = Depends(get_db)):
    c = course_admin.update_course(db, user, _course(db, user, course_id),
                                   {k: v for k, v in req.model_dump().items() if k != "code" and v is not None})
    return _tree(db, c)


@router.delete("/courses/{course_id}")
def delete_course(course_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    c = _course(db, user, course_id)
    cover = c.cover_path
    db.delete(c)
    db.commit()
    if cover:
        get_store().delete(cover)
    return {"deleted": True}


@router.get("/courses/{course_id}/cover")
def course_cover(course_id: str, request: Request, user: Principal = Depends(get_user_for_media),
                 db: Session = Depends(get_db)):
    c = _course(db, user, course_id)
    store = get_store()
    if not c.cover_path or not store.exists(c.cover_path):
        raise AppError(404, "NOT_FOUND", "Khóa học chưa có ảnh bìa.")
    return store.response(c.cover_path, request, media_type=mimetypes.guess_type(c.cover_path)[0] or "image/png",
                          inline=True, cache_control="private, max-age=86400")


@router.post("/courses/{course_id}/cover")
def upload_course_cover(course_id: str, file: UploadFile = File(...), user: Principal = Depends(require_teacher),
                        db: Session = Depends(get_db)):
    c = course_admin.set_cover(db, _course(db, user, course_id), file)
    return _tree(db, c)


@router.delete("/courses/{course_id}/cover")
def remove_course_cover(course_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    c = course_admin.clear_cover(db, _course(db, user, course_id))
    return _tree(db, c)


class TitleIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)


class MoveIn(BaseModel):
    direction: int = Field(ge=-1, le=1)


@router.post("/courses/{course_id}/chapters")
def add_chapter(course_id: str, req: TitleIn, user: Principal = Depends(require_teacher),
                db: Session = Depends(get_db)):
    c = _course(db, user, course_id)
    course_admin.add_chapter(db, c, req.title)
    return _tree(db, c)


@router.patch("/chapters/{chapter_id}")
def rename_chapter(chapter_id: str, req: TitleIn, user: Principal = Depends(require_teacher),
                   db: Session = Depends(get_db)):
    ch = _chapter(db, user, chapter_id)
    ch.title = req.title
    db.commit()
    return _tree(db, ch.course)


@router.post("/chapters/{chapter_id}/move")
def move_chapter(chapter_id: str, req: MoveIn, user: Principal = Depends(require_teacher),
                 db: Session = Depends(get_db)):
    ch = _chapter(db, user, chapter_id)
    course_admin.move(db, ch, ch.course.chapters, req.direction)
    db.refresh(ch.course)
    return _tree(db, ch.course)


@router.delete("/chapters/{chapter_id}")
def delete_chapter(chapter_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    ch = _chapter(db, user, chapter_id)
    course = ch.course
    db.delete(ch)
    db.commit()
    db.refresh(course)
    return _tree(db, course)


class LessonIn(BaseModel):
    code: str | None = None
    title: str | None = None
    description: str | None = None


@router.post("/chapters/{chapter_id}/lessons")
def add_lesson(chapter_id: str, req: LessonIn, user: Principal = Depends(require_teacher),
               db: Session = Depends(get_db)):
    if not req.title or not req.title.strip():
        raise AppError(400, "BAD_REQUEST", "Cần tên bài học.")
    ch = _chapter(db, user, chapter_id)
    course_admin.add_lesson(db, ch, req.code, req.title, req.description)
    db.refresh(ch.course)
    return _tree(db, ch.course)


@router.patch("/lessons/{lesson_id}")
def update_lesson(lesson_id: str, req: LessonIn, user: Principal = Depends(require_teacher),
                  db: Session = Depends(get_db)):
    ls = learning.get_lesson(db, user, parse_uuid(lesson_id, "lesson_id"))
    if req.title:
        ls.title = req.title
    if req.description is not None:
        ls.description = req.description
    db.commit()
    return _tree(db, ls.chapter.course)


@router.post("/lessons/{lesson_id}/move")
def move_lesson(lesson_id: str, req: MoveIn, user: Principal = Depends(require_teacher),
                db: Session = Depends(get_db)):
    ls = learning.get_lesson(db, user, parse_uuid(lesson_id, "lesson_id"))
    course_admin.move(db, ls, ls.chapter.lessons, req.direction)
    db.refresh(ls.chapter)
    return _tree(db, ls.chapter.course)


@router.delete("/lessons/{lesson_id}")
def delete_lesson(lesson_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    ls = learning.get_lesson(db, user, parse_uuid(lesson_id, "lesson_id"))
    course = ls.chapter.course
    db.delete(ls)
    db.commit()
    db.refresh(course)
    return _tree(db, course)


class ItemIn(BaseModel):
    type: str | None = None
    title: str | None = None
    video_id: str | None = None
    document_id: str | None = None
    content_md: str | None = None
    notes: str | None = None
    count: int | None = None
    pass_ratio: float | None = None
    time_limit_minutes: int | None = None  # bài kiểm tra có giờ: 0 = không giới hạn
    open_at: str | None = None  # lịch làm bài (ISO-8601); "" = bỏ lịch
    close_at: str | None = None


@router.post("/lessons/{lesson_id}/items")
def add_item(lesson_id: str, req: ItemIn, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    ls = learning.get_lesson(db, user, parse_uuid(lesson_id, "lesson_id"))
    data = req.model_dump()
    if data.get("document_id"):
        data["document_id"] = parse_uuid(data["document_id"], "document_id")
    course_admin.add_item(db, user, ls, data)
    db.refresh(ls)
    return _tree(db, ls.chapter.course)


@router.get("/items/{item_id}")
def get_item_admin(item_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    it = learning.get_item(db, user, parse_uuid(item_id, "item_id"))
    return {"item_id": str(it.id), "type": it.type, "title": it.title, "video_id": it.video_id,
            "document_id": str(it.document_id) if it.document_id else None, "content_md": it.content_md,
            "meta": it.meta}


@router.patch("/items/{item_id}")
def update_item(item_id: str, req: ItemIn, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    it = learning.get_item(db, user, parse_uuid(item_id, "item_id"))
    data = {k: v for k, v in req.model_dump().items() if v is not None and k != "type"}
    if data.get("document_id"):
        data["document_id"] = parse_uuid(data["document_id"], "document_id")
    course_admin.update_item(db, user, it, data)
    return _tree(db, it.lesson.chapter.course)


@router.post("/items/{item_id}/move")
def move_item(item_id: str, req: MoveIn, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    it = learning.get_item(db, user, parse_uuid(item_id, "item_id"))
    course_admin.move(db, it, it.lesson.items, req.direction)
    db.refresh(it.lesson)
    return _tree(db, it.lesson.chapter.course)


@router.delete("/items/{item_id}")
def delete_item(item_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    it = learning.get_item(db, user, parse_uuid(item_id, "item_id"))
    course = it.lesson.chapter.course
    db.delete(it)
    db.commit()
    db.refresh(course)
    return _tree(db, course)
