import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class AIConversation(Base):
    __tablename__ = "ai_conversations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    student_id = Column(String(128), nullable=True, index=True)
    course_id = Column(String(128), nullable=True)
    class_id = Column(String(128), nullable=True)
    lesson_id = Column(String(128), nullable=True, index=True)
    video_id = Column(String(128), nullable=True, index=True)
    summary = Column(Text, nullable=True)
    summary_message_count = Column(Integer, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())

    messages = relationship("AIMessage", back_populates="conversation", cascade="all, delete-orphan")


class AIMessage(Base):
    __tablename__ = "ai_messages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey("ai_conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(16), nullable=False)  # user | assistant
    content = Column(Text, nullable=False)
    sources = Column(JSONB, nullable=True)
    meta = Column(JSONB, nullable=True)  # hint_mode, request_id, llm_call_id, refused...
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    conversation = relationship("AIConversation", back_populates="messages")
