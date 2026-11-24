"""Thời hạn lưu dữ liệu: xóa hội thoại Tutor và nhật ký gọi LLM quá hạn (cấu hình trong .env)."""
import logging
from datetime import timedelta

from sqlalchemy.orm import Session

from app.config import settings
from app.core.utils import utcnow
from app.models.conversation import AIConversation, AIMessage
from app.models.observability import AILLMCall
from app.models.social import DirectMessage, UserNotification

log = logging.getLogger("app.retention")


def purge_expired(db: Session) -> dict:
    """Xóa tin nhắn / hội thoại / log LLM cũ hơn thời hạn. Giá trị 0 nghĩa là giữ mãi."""
    out = {"messages": 0, "conversations": 0, "llm_calls": 0, "direct_messages": 0, "notifications": 0}
    if settings.chat_retention_days > 0:
        cutoff = utcnow() - timedelta(days=settings.chat_retention_days)
        out["messages"] = (db.query(AIMessage).filter(AIMessage.created_at < cutoff)
                           .delete(synchronize_session=False))
        has_msg = db.query(AIMessage.id).filter(AIMessage.conversation_id == AIConversation.id).exists()
        out["conversations"] = (db.query(AIConversation)
                                .filter(AIConversation.created_at < cutoff, ~has_msg)
                                .delete(synchronize_session=False))
    if settings.chat_retention_days > 0:  # tin nhắn riêng và thông báo dùng cùng thời hạn với hội thoại Tutor
        cutoff = utcnow() - timedelta(days=settings.chat_retention_days)
        out["direct_messages"] = (db.query(DirectMessage).filter(DirectMessage.created_at < cutoff)
                                  .delete(synchronize_session=False))
        out["notifications"] = (db.query(UserNotification).filter(UserNotification.created_at < cutoff)
                                .delete(synchronize_session=False))
    if settings.llm_log_retention_days > 0:
        cutoff = utcnow() - timedelta(days=settings.llm_log_retention_days)
        out["llm_calls"] = (db.query(AILLMCall).filter(AILLMCall.created_at < cutoff)
                            .delete(synchronize_session=False))
    db.commit()
    if any(out.values()):
        log.info("retention_purged", extra={"extra_fields": out})
    return out
