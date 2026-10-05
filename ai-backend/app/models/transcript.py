import uuid

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class VideoTranscript(Base):
    """Một phiên bản transcript của video. Mỗi lần import / phiên âm / sửa tạo phiên bản mới."""
    __tablename__ = "video_transcripts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    video_id = Column(String(128), nullable=False, index=True)
    course_id = Column(String(128), nullable=True)
    class_id = Column(String(128), nullable=True)
    lesson_id = Column(String(128), nullable=True)
    version = Column(Integer, nullable=True, server_default=text("1"))
    is_active = Column(Boolean, nullable=True, server_default=text("true"))
    source = Column(String(32), nullable=True)  # import | whisper | manual
    language = Column(String(16), default="vi")
    model_version = Column(String(64), nullable=True)
    status = Column(String(32), default="pending")  # pending, processing, ready, failed
    error_message = Column(Text, nullable=True)
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    segments = relationship("TranscriptSegment", back_populates="transcript", cascade="all, delete-orphan",
                            order_by="TranscriptSegment.start_time")


class TranscriptSegment(Base):
    __tablename__ = "transcript_segments"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    transcript_id = Column(UUID(as_uuid=True), ForeignKey("video_transcripts.id", ondelete="CASCADE"), nullable=False, index=True)
    start_time = Column(Float, nullable=False)
    end_time = Column(Float, nullable=False)
    text = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    transcript = relationship("VideoTranscript", back_populates="segments")
