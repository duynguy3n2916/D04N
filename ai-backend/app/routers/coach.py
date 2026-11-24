"""API Trợ lý học tập (Study Coach Agent)."""
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import Principal, get_current_user
from app.database import get_db
from app.services import coach

router = APIRouter(prefix="/ai", tags=["coach"])


class CoachTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=8000)


class CoachRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    history: list[CoachTurn] = Field(default_factory=list, max_length=20)


@router.post("/coach/chat")
def coach_chat(req: CoachRequest, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    """Một lượt hỏi Trợ lý học tập: agent tự gọi tool trên dữ liệu của chính học sinh rồi trả lời."""
    return coach.ask(db, user, req.message, [t.model_dump() for t in req.history])


@router.get("/coach/tools")
def coach_tools(user: Principal = Depends(get_current_user)):
    """Danh sách tool của agent (hiển thị minh bạch cho người dùng và phục vụ báo cáo)."""
    return [{"name": t.name, "description": t.description, "writes": t.writes} for t in coach.TOOLS.values()]
