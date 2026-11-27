"""API Trợ lý học tập (Study Coach Agent)."""
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import Principal, get_current_user
from app.core.sse import sse_response
from app.database import get_db
from app.services.ai import coach

router = APIRouter(prefix="/ai", tags=["coach"])


class CoachTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=8000)


class CoachRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    conversation_id: str | None = None
    course_id: str | None = Field(default=None, max_length=64)
    history: list[CoachTurn] = Field(default_factory=list, max_length=20)


class RenameRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)


@router.post("/coach/chat")
def coach_chat(req: CoachRequest, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    """Một lượt hỏi Trợ lý học tập: agent tự gọi tool trên dữ liệu của chính học sinh rồi trả lời.
    Lượt hỏi được lưu vào lịch sử; gửi conversation_id để chat tiếp một cuộc trò chuyện cũ."""
    return coach.chat(db, user, req.message, req.conversation_id, [t.model_dump() for t in req.history],
                      course_id=req.course_id)


@router.post("/coach/chat/stream")
def coach_chat_stream(req: CoachRequest, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    """Như /coach/chat nhưng trả Server-Sent Events để giao diện hiện tiến trình và chữ ngay khi có:
    `step_start` / `step` (agent gọi tool), `delta` (đoạn chữ), `reset` (bỏ phần chữ nháp), cuối cùng `done`
    (cùng dữ liệu như /coach/chat) hoặc `error`. Lỗi quyền / không tìm thấy vẫn trả JSON lỗi bình thường."""
    plan = coach.prepare_chat(db, user, req.message, req.conversation_id, [t.model_dump() for t in req.history],
                              course_id=req.course_id)
    return sse_response(lambda session: coach.chat_events(session, user, plan, stream=True), name="coach")


@router.get("/coach/conversations")
def coach_conversations(user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    """Danh sách cuộc trò chuyện của chính người dùng, mới nhất trước."""
    return coach.list_conversations(db, user)


@router.get("/coach/conversations/{conversation_id}")
def coach_conversation(conversation_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return coach.get_conversation(db, user, conversation_id)


@router.patch("/coach/conversations/{conversation_id}")
def coach_rename(conversation_id: str, req: RenameRequest, user: Principal = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    return coach.rename_conversation(db, user, conversation_id, req.title)


@router.delete("/coach/conversations/{conversation_id}", status_code=204)
def coach_delete(conversation_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    coach.delete_conversation(db, user, conversation_id)


@router.get("/coach/tools")
def coach_tools(user: Principal = Depends(get_current_user)):
    """Danh sách tool của agent (hiển thị minh bạch cho người dùng và phục vụ báo cáo)."""
    return [{"name": t.name, "description": t.description, "writes": t.writes} for t in coach.TOOLS.values()]


class PracticeSubmit(BaseModel):
    answers: dict[str, int] = Field(default_factory=dict)


@router.get("/coach/practice/{quiz_id}")
def coach_practice(quiz_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    """Quiz luyện tập Trợ lý đã soạn (chưa nộp: chỉ có đề, không có đáp án)."""
    from app.services.ai import practice_quiz
    return practice_quiz.get(db, user, quiz_id)


@router.post("/coach/practice/{quiz_id}/submit")
def coach_practice_submit(quiz_id: str, req: PracticeSubmit, user: Principal = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    """Nộp quiz luyện tập (một lần): trả đúng/sai từng câu, lời giải và nguồn học liệu."""
    from app.services.ai import practice_quiz
    return practice_quiz.submit(db, user, quiz_id, req.answers)
