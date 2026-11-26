"""API học tập của học sinh (giáo viên xem trước được): khóa / bài / mục học, tiến độ, XP, bài kiểm tra."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import Principal, get_current_user
from app.core.utils import clean_id, parse_uuid
from app.database import get_db
from app.models.learning import Lesson
from app.services.courses import learning

router = APIRouter(prefix="/ai", tags=["learning"])


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
    for c in learning.visible_courses(db, user, with_tree=True):
        t = learning.course_tree(db, user, c)
        out.append({k: t[k] for k in ("course_id", "code", "title", "description", "class_id", "cover_url",
                                      "items_total", "items_done", "current_item_id")})
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


@router.get("/learn/progress-report")
def progress_report(user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    """Báo cáo tiến độ của chính học sinh, tải về dạng DOCX."""
    from urllib.parse import quote

    from fastapi.responses import Response

    from app.services.courses import progress_report as pr
    content = pr.to_docx(pr.collect(db, user))
    name = quote(f"bao-cao-tien-do-{user.user_id}.docx")
    return Response(content, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    headers={"Content-Disposition": f"attachment; filename=\"bao-cao-tien-do.docx\"; filename*=UTF-8''{name}"})


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


