"""State machine Video Learning & Question Agent. student_id luôn lấy từ token."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import Principal, get_current_user
from app.core.utils import clean_id, parse_uuid
from app.database import get_db
from app.services import workflow

router = APIRouter(prefix="/ai", tags=["workflow"])


class TriggerAgentRequest(BaseModel):
    video_id: str
    current_time: float = Field(ge=0)
    advanced_mode: bool = True
    student_id: str | None = None  # bỏ qua
    cooldown_seconds: int | None = None  # bỏ qua: cooldown do server cấu hình


@router.post("/question-agent/trigger")
def trigger_question_agent(req: TriggerAgentRequest, user: Principal = Depends(get_current_user),
                           db: Session = Depends(get_db)):
    """Heartbeat từ player (mỗi 30–60s). Server kiểm tra điều kiện, có thể sinh 1 câu hỏi mở rộng."""
    return workflow.trigger_agent(db, user, clean_id(req.video_id), req.current_time, req.advanced_mode)


class QuestionStartRequest(BaseModel):
    video_id: str
    question_id: str
    current_time: float | None = Field(default=None, ge=0)


@router.post("/workflow/question-start")
def question_start(req: QuestionStartRequest, user: Principal = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """Player tới mốc câu hỏi của giáo viên -> pause + mở câu hỏi, server bắt đầu đếm thời hạn."""
    return workflow.start_question(db, user, clean_id(req.video_id), parse_uuid(req.question_id, "question_id"),
                                   req.current_time)


class VideoRef(BaseModel):
    video_id: str
    current_time: float | None = Field(default=None, ge=0)
    student_id: str | None = None
    question_id: str | None = None
    cooldown_seconds: int | None = None


@router.post("/workflow/timeout")
def report_question_timeout(req: VideoRef, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    """Client báo hết giờ; server chỉ chấp nhận khi thời hạn thực sự đã qua."""
    return workflow.report_timeout(db, user, clean_id(req.video_id))


@router.post("/workflow/resume")
def resume_video(req: VideoRef, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return workflow.resume(db, user, clean_id(req.video_id), req.current_time)


@router.get("/workflow/session")
def get_session_status(video_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return workflow.get_status(db, user, clean_id(video_id))
