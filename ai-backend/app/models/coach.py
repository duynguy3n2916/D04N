"""Lịch sử trò chuyện với Trợ lý học tập (Study Coach): mỗi học sinh có nhiều cuộc trò chuyện để xem lại và chat tiếp."""
import uuid

from sqlalchemy import Column, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class CoachConversation(Base):
    __tablename__ = "coach_conversations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    student_id = Column(String(128), nullable=False, index=True)
    title = Column(String(200), nullable=False)
    course_id = Column(String(64), nullable=True)  # khóa học đang ôn (None = mọi khóa)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)

    messages = relationship("CoachMessage", back_populates="conversation", cascade="all, delete-orphan",
                            order_by="CoachMessage.created_at")


class CoachMessage(Base):
    __tablename__ = "coach_messages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey("coach_conversations.id", ondelete="CASCADE"),
                             nullable=False, index=True)
    role = Column(String(16), nullable=False)  # user | assistant
    content = Column(Text, nullable=False)
    result = Column(JSONB, nullable=True)  # assistant: steps, sources, actions, guarded, stopped
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    conversation = relationship("CoachConversation", back_populates="messages")
