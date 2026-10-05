import uuid

from pgvector.sqlalchemy import Vector
from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.config import settings
from app.database import Base


class AIDocument(Base):
    """Một nguồn học liệu đã ingest (PDF/DOCX/PPTX/TXT, nội dung bài học, transcript video)."""
    __tablename__ = "ai_documents"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    course_id = Column(String(128), nullable=True, index=True)
    class_id = Column(String(128), nullable=True, index=True)
    lesson_id = Column(String(128), nullable=True, index=True)
    source_type = Column(String(32), nullable=False)  # pdf, docx, pptx, txt, lesson, video
    source_id = Column(String(128), nullable=True, index=True)  # video_id với source_type=video
    title = Column(String(512), nullable=False)
    file_path = Column(String(1024), nullable=True)
    content_hash = Column(String(64), nullable=True, index=True)
    version = Column(Integer, nullable=True, server_default=text("1"))
    is_active = Column(Boolean, nullable=True, server_default=text("true"))
    replaces_id = Column(UUID(as_uuid=True), nullable=True)  # phiên bản trước của tài liệu này
    uploaded_by = Column(String(128), nullable=True)
    status = Column(String(32), default="pending", index=True)  # pending, processing, ready, failed, deleted
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())

    chunks = relationship("AIChunk", back_populates="document", cascade="all, delete-orphan")


class AIChunk(Base):
    """Đơn vị truy xuất của RAG."""
    __tablename__ = "ai_chunks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    document_id = Column(UUID(as_uuid=True), ForeignKey("ai_documents.id", ondelete="CASCADE"), nullable=False, index=True)
    content = Column(Text, nullable=False)
    chunk_index = Column(Integer, nullable=False)
    page = Column(Integer, nullable=True)
    section = Column(String(512), nullable=True)
    start_time = Column(Float, nullable=True)  # giây, cho chunk transcript video
    end_time = Column(Float, nullable=True)
    meta = Column(JSONB, nullable=True)  # vd. {"transcript_id": ..., "segment_from": 3, "segment_to": 8}
    embedding = Column(Vector(settings.embedding_dim), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    document = relationship("AIDocument", back_populates="chunks")
