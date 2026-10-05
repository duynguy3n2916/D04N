import uuid

from sqlalchemy import Column, DateTime, Float, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class AILLMCall(Base):
    """Nhật ký mỗi lượt gọi LLM: phục vụ đo latency, token, chi phí và truy vết."""
    __tablename__ = "ai_llm_calls"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    correlation_id = Column(String(64), nullable=True, index=True)
    task = Column(String(64), nullable=False, index=True)  # tutor, teacher_quiz, video_question, agent, grade, eval_judge...
    prompt_id = Column(String(64), nullable=True)
    prompt_version = Column(String(16), nullable=True)
    provider = Column(String(32), nullable=True)
    model = Column(String(128), nullable=True)
    input_tokens = Column(Integer, nullable=True)
    output_tokens = Column(Integer, nullable=True)
    latency_ms = Column(Float, nullable=True)
    cost_usd = Column(Float, nullable=True)
    chunk_ids = Column(JSONB, nullable=True)
    status = Column(String(16), nullable=False, default="ok")  # ok | error | invalid_output
    attempt = Column(Integer, nullable=True)
    error = Column(Text, nullable=True)
    user_id = Column(String(128), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class AIJob(Base):
    """Tác vụ chạy nền: ingest tài liệu, phiên âm video, chạy evaluation."""
    __tablename__ = "ai_jobs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_type = Column(String(32), nullable=False, index=True)
    status = Column(String(16), nullable=False, default="queued", index=True)  # queued | running | succeeded | failed
    progress = Column(Float, nullable=True)
    message = Column(Text, nullable=True)
    payload = Column(JSONB, nullable=True)
    result = Column(JSONB, nullable=True)
    error = Column(Text, nullable=True)
    created_by = Column(String(128), nullable=True)
    correlation_id = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    started_at = Column(DateTime(timezone=True), nullable=True)
    finished_at = Column(DateTime(timezone=True), nullable=True)
