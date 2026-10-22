from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import Principal, get_current_user
from app.core.utils import parse_uuid
from app.database import get_db
from app.services import messages

router = APIRouter(prefix="/ai/messages", tags=["messages"])


class StartIn(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)


class SendIn(BaseModel):
    body: str = Field(min_length=1, max_length=2000)


class BlockIn(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)
    blocked: bool = True


class ReportIn(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class ResolveIn(BaseModel):
    action: str = Field(pattern="^(hide|dismiss)$")


@router.get("/conversations")
def list_conversations(user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return messages.list_conversations(db, user)


@router.post("/conversations")
def start(req: StartIn, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    """Mở (hoặc lấy lại) hội thoại riêng với một thành viên cùng lớp."""
    return messages.start(db, user, req.user_id)


@router.get("/conversations/{conversation_id}")
def get_messages(conversation_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return messages.get_messages(db, user, parse_uuid(conversation_id, "conversation_id"))


@router.post("/conversations/{conversation_id}", status_code=201)
def send(conversation_id: str, req: SendIn, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return messages.send(db, user, parse_uuid(conversation_id, "conversation_id"), req.body)


@router.post("/blocks")
def block(req: BlockIn, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return messages.set_block(db, user, req.user_id, req.blocked)


@router.post("/{message_id}/report", status_code=201)
def report(message_id: str, req: ReportIn, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return messages.report_message(db, user, parse_uuid(message_id, "message_id"), req.reason)


@router.get("/reports/{class_id}")
def list_reports(class_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    """Giáo viên: tin nhắn riêng bị báo cáo trong lớp (chỉ đúng tin bị báo cáo)."""
    return messages.list_reports(db, user, class_id)


@router.post("/reports/{report_id}/resolve")
def resolve(report_id: str, req: ResolveIn, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return messages.resolve_report(db, user, parse_uuid(report_id, "report_id"), req.action)
