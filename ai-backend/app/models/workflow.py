"""State machine tương tác video: phiên học (VideoSession) và nhật ký chuyển trạng thái (SessionTransition)."""
import uuid

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class VideoSession(Base):
    """Một học sinh x một video = một phiên (unique)."""
    __tablename__ = "video_sessions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    student_id = Column(String(128), nullable=False, index=True)
    video_id = Column(String(128), nullable=False, index=True)
    current_state = Column(String(32), default="VIDEO_PLAYING")
    state_changed_at = Column(DateTime(timezone=True), nullable=True)
    current_video_time = Column(Float, default=0.0)
    advanced_mode = Column(Boolean, nullable=True)
    active_question_id = Column(UUID(as_uuid=True), ForeignKey("video_questions.id", ondelete="SET NULL"), nullable=True)
    question_deadline_at = Column(DateTime(timezone=True), nullable=True)
    last_result = Column(JSONB, nullable=True)  # phản hồi gần nhất (feedback / tutor self answer) để client hiển thị lại
    last_interaction_at = Column(DateTime(timezone=True), server_default=func.now())
    cooldown_until = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())


class SessionTransition(Base):
    __tablename__ = "session_transitions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id = Column(UUID(as_uuid=True), ForeignKey("video_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    from_state = Column(String(32), nullable=False)
    to_state = Column(String(32), nullable=False)
    reason = Column(Text, nullable=True)
    video_time = Column(Float, nullable=True)
    correlation_id = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
