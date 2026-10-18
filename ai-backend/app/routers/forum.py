from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import Principal, get_current_user
from app.core.utils import parse_uuid
from app.database import get_db
from app.services import forum

router = APIRouter(prefix="/ai/forum", tags=["forum"])


class ThreadIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=5000)
    lesson_code: str | None = Field(default=None, max_length=128)


class ReplyIn(BaseModel):
    body: str = Field(min_length=1, max_length=5000)


class ModerateIn(BaseModel):
    pinned: bool | None = None
    locked: bool | None = None
    hidden: bool | None = None


class HiddenIn(BaseModel):
    hidden: bool


class ReportIn(BaseModel):
    thread_id: str | None = None
    reply_id: str | None = None
    reason: str = Field(min_length=1, max_length=500)


class ResolveIn(BaseModel):
    action: str = Field(pattern="^(hide|dismiss)$")


@router.get("/classes/{class_id}/threads")
def list_threads(class_id: str, lesson_code: str | None = None, user: Principal = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    return forum.list_threads(db, user, class_id, lesson_code)


@router.post("/classes/{class_id}/threads", status_code=201)
def create_thread(class_id: str, req: ThreadIn, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return forum.create_thread(db, user, class_id, req.title, req.body, req.lesson_code)


@router.get("/threads/{thread_id}")
def get_thread(thread_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return forum.get_thread(db, user, parse_uuid(thread_id, "thread_id"))


@router.post("/threads/{thread_id}/replies", status_code=201)
def reply(thread_id: str, req: ReplyIn, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return forum.reply(db, user, parse_uuid(thread_id, "thread_id"), req.body)


@router.patch("/threads/{thread_id}")
def moderate(thread_id: str, req: ModerateIn, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return forum.moderate(db, user, parse_uuid(thread_id, "thread_id"), req.pinned, req.locked, req.hidden)


@router.patch("/replies/{reply_id}")
def hide_reply(reply_id: str, req: HiddenIn, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return forum.set_reply_hidden(db, user, parse_uuid(reply_id, "reply_id"), req.hidden)


@router.post("/reports", status_code=201)
def report(req: ReportIn, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    """Học sinh báo cáo bài đăng hoặc câu trả lời không phù hợp."""
    return forum.report(db, user, parse_uuid(req.thread_id, "thread_id", required=False),
                        parse_uuid(req.reply_id, "reply_id", required=False), req.reason)


@router.get("/classes/{class_id}/reports")
def list_reports(class_id: str, status: str = "open", user: Principal = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    return forum.list_reports(db, user, class_id, status)


@router.post("/reports/{report_id}/resolve")
def resolve_report(report_id: str, req: ResolveIn, user: Principal = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    return forum.resolve_report(db, user, parse_uuid(report_id, "report_id"), req.action)


@router.post("/replies/{reply_id}/accept")
def accept(reply_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return forum.accept_reply(db, user, parse_uuid(reply_id, "reply_id"))


@router.delete("/threads/{thread_id}", status_code=204)
def delete_thread(thread_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    forum.delete(db, user, "thread", parse_uuid(thread_id, "thread_id"))
    return Response(status_code=204)


@router.delete("/replies/{reply_id}", status_code=204)
def delete_reply(reply_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    forum.delete(db, user, "reply", parse_uuid(reply_id, "reply_id"))
    return Response(status_code=204)


@router.post("/threads/{thread_id}/ai-draft")
def ai_draft(thread_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    """Giáo viên: AI soạn nháp trả lời từ học liệu. Nháp không được đăng tự động."""
    return forum.ai_draft(db, user, parse_uuid(thread_id, "thread_id"))
