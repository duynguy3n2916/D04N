"""API học tập cho học sinh (và giáo viên xem trước) + API soạn khóa học cho giáo viên."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import Principal, get_current_user, require_teacher
from app.core.utils import clean_id, parse_uuid
from app.database import get_db
from app.models.learning import Chapter, Course, Lesson, LessonItem
from app.services import course_admin, learning

router = APIRouter(prefix="/ai", tags=["learning"])


# ----------------------------------------------------------------------------
# Học sinh
# ----------------------------------------------------------------------------

@router.get("/learn/me")
def learn_me(user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    p = learning.touch_profile(db, user)
    return {"user_id": user.user_id, "name": p.display_name or user.user_id, "role": user.role,
            "class_ids": user.class_ids, "stats": learning.stats(db, user)}


class GoalRequest(BaseModel):
    daily_goal_xp: int


@router.put("/learn/goal")
def set_goal(req: GoalRequest, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return learning.set_daily_goal(db, user, req.daily_goal_xp)


@router.get("/learn/leaderboard")
def get_leaderboard(user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return learning.leaderboard(db, user)


@router.get("/learn/courses")
def my_courses(user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    out = []
    for c in learning.visible_courses(db, user):
        t = learning.course_tree(db, user, c)
        out.append({k: t[k] for k in ("course_id", "code", "title", "description", "class_id", "items_total",
                                      "items_done", "current_item_id")})
    return out


@router.get("/learn/courses/{course_id}")
def course_path(course_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return learning.course_tree(db, user, learning.get_course(db, user, parse_uuid(course_id, "course_id")))


@router.get("/learn/lessons/{lesson_id}")
def lesson_view(lesson_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return learning.lesson_view(db, user, learning.get_lesson(db, user, parse_uuid(lesson_id, "lesson_id")))


@router.get("/learn/items/{item_id}")
def item_detail(item_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return learning.item_detail(db, user, learning.get_item(db, user, parse_uuid(item_id, "item_id")))


class PositionRequest(BaseModel):
    position: float = Field(ge=0)


@router.post("/learn/items/{item_id}/position")
def save_position(item_id: str, req: PositionRequest, user: Principal = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    return learning.save_position(db, user, learning.get_item(db, user, parse_uuid(item_id, "item_id")), req.position)


@router.post("/learn/items/{item_id}/complete")
def complete(item_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return learning.complete_item(db, user, learning.get_item(db, user, parse_uuid(item_id, "item_id")))


@router.post("/learn/items/{item_id}/quiz/start")
def quiz_start(item_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return learning.start_quiz(db, user, learning.get_item(db, user, parse_uuid(item_id, "item_id")))


class QuizAnswer(BaseModel):
    question_id: str
    selected_index: int | None = Field(default=None, ge=0, le=7)
    answer: str | None = None


@router.post("/learn/items/{item_id}/quiz/answer")
def quiz_answer(item_id: str, req: QuizAnswer, user: Principal = Depends(get_current_user),
                db: Session = Depends(get_db)):
    if req.selected_index is None and not (req.answer or "").strip():
        raise AppError(400, "EMPTY_ANSWER", "Cần chọn đáp án hoặc nhập câu trả lời.")
    item = learning.get_item(db, user, parse_uuid(item_id, "item_id"))
    return learning.answer_quiz(db, user, item, str(parse_uuid(req.question_id, "question_id")), req.selected_index,
                                req.answer)


@router.post("/learn/items/{item_id}/quiz/finish")
def quiz_finish(item_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return learning.finish_quiz(db, user, learning.get_item(db, user, parse_uuid(item_id, "item_id")))


@router.get("/learn/locate")
def locate(video_id: str | None = None, document_id: str | None = None, lesson_id: str | None = None,
           user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    """Tìm mục học chứa một video / tài liệu (để chip nguồn của Tutor mở đúng chỗ)."""
    lesson = db.get(Lesson, parse_uuid(lesson_id, "lesson_id")) if lesson_id else None
    found = learning.locate(db, user, lesson, video_id=clean_id(video_id),
                            document_id=parse_uuid(document_id, "document_id") if document_id else None)
    if not found:
        raise AppError(404, "NOT_FOUND", "Nguồn này không thuộc mục học nào.")
    return found


# ----------------------------------------------------------------------------
# Giáo viên soạn khóa học
# ----------------------------------------------------------------------------

def _course(db, user, cid) -> Course:
    return learning.get_course(db, user, parse_uuid(cid, "course_id"))


def _chapter(db, user, cid) -> Chapter:
    ch = db.get(Chapter, parse_uuid(cid, "chapter_id"))
    if not ch or not user.can_access_class(ch.course.class_id):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy chương.")
    return ch


def _tree(db: Session, course) -> dict:
    """Cây khóa học sau khi sửa. Session dùng expire_on_commit=False nên phải làm mới các quan hệ đã nạp."""
    db.expire_all()
    return course_admin.admin_tree(course)


class CourseIn(BaseModel):
    code: str | None = None
    title: str | None = None
    description: str | None = None
    class_id: str | None = None


@router.get("/courses")
def list_courses_admin(user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    rows = learning.visible_courses(db, user)
    out = []
    for c in rows:
        n_items = (db.query(func.count(LessonItem.id)).join(Lesson).join(Chapter)
                   .filter(Chapter.course_id == c.id).scalar())
        out.append({"course_id": str(c.id), "code": c.code, "title": c.title, "class_id": c.class_id,
                    "chapters": len(c.chapters), "items": int(n_items or 0)})
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
    db.delete(c)
    db.commit()
    return {"deleted": True}


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
