from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import Principal, ensure_class_access, get_current_user, require_teacher
from app.core.utils import clean_id, parse_uuid
from app.database import get_db
from app.models.conversation import AIConversation, AIMessage
from app.services import tutor
from app.services.retrieval import RetrievalScope, retrieve

router = APIRouter(prefix="/ai", tags=["chat"])


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    conversation_id: str | None = None
    course_id: str | None = None
    class_id: str | None = None
    lesson_id: str | None = None
    video_id: str | None = None
    video_time: float | None = Field(default=None, ge=0)
    top_k: int | None = Field(default=None, ge=1, le=10)
    focus_document_id: str | None = None  # slide / tài liệu đang mở
    focus_page: int | None = Field(default=None, ge=1)
    selected_text: str | None = Field(default=None, max_length=4000)  # đoạn học sinh bôi đen trong bài đọc
    # Các trường cũ: bị bỏ qua (student_id lấy từ token, hint mode do server quyết định)
    student_id: str | None = None
    video_question_active: bool | None = None


@router.post("/chat")
def chat(req: ChatRequest, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    class_id = clean_id(req.class_id)
    ensure_class_access(user, class_id)
    return tutor.ask(
        db, user, question=req.question.strip(),
        conversation_id=parse_uuid(req.conversation_id, "conversation_id", required=False),
        course_id=clean_id(req.course_id), class_id=class_id, lesson_id=clean_id(req.lesson_id),
        video_id=clean_id(req.video_id), video_time=req.video_time, top_k=req.top_k,
        focus_document_id=parse_uuid(req.focus_document_id, "focus_document_id", required=False),
        focus_page=req.focus_page, selected_text=(req.selected_text or "").strip() or None,
    )


@router.get("/chat/quota")
def tutor_quota(lesson_id: str | None = None, user: Principal = Depends(get_current_user),
                db: Session = Depends(get_db)):
    """Số lượt hỏi Tutor còn lại cho bài này hôm nay (None = không giới hạn, vd giáo viên)."""
    return {"quota": tutor.tutor_quota(db, user, clean_id(lesson_id))}


@router.post("/retrieve")
def retrieve_only(req: ChatRequest, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    """Kiểm tra retrieval (không gọi LLM). min_score=0 để thấy cả các kết quả dưới ngưỡng."""
    scope = RetrievalScope.for_user(user, course_id=clean_id(req.course_id), class_id=clean_id(req.class_id),
                                    lesson_id=clean_id(req.lesson_id))
    results = retrieve(db, req.question, scope, top_k=req.top_k or 5, min_score=0.0)
    from app.config import settings
    for r in results:
        r["above_threshold"] = (r["score"] or 0) >= settings.rag_min_score
    return {"query": req.question, "min_score": settings.rag_min_score, "results": results}


def _conv_dict(conv: AIConversation, messages: list[AIMessage] | None = None) -> dict:
    out = {"conversation_id": str(conv.id), "student_id": conv.student_id, "lesson_id": conv.lesson_id,
           "video_id": conv.video_id, "summary": conv.summary,
           "created_at": conv.created_at.isoformat() if conv.created_at else None}
    if messages is not None:
        out["messages"] = [{"role": m.role, "content": m.content, "sources": m.sources, "meta": m.meta,
                            "created_at": m.created_at.isoformat() if m.created_at else None} for m in messages]
    return out


@router.get("/conversations")
def my_conversations(user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(AIConversation).filter(AIConversation.student_id == user.user_id)
            .order_by(AIConversation.created_at.desc()).limit(50).all())
    return [_conv_dict(c) for c in rows]


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    conv = db.get(AIConversation, parse_uuid(conversation_id, "conversation_id"))
    if not conv:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy hội thoại.")
    if conv.student_id != user.user_id and not user.is_teacher:
        raise AppError(403, "FORBIDDEN", "Hội thoại thuộc người dùng khác.")
    msgs = db.query(AIMessage).filter(AIMessage.conversation_id == conv.id).order_by(AIMessage.created_at).all()
    return _conv_dict(conv, msgs)
