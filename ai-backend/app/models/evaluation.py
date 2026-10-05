import uuid

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class EvalSample(Base):
    """Câu hỏi chuẩn của bộ đánh giá, kèm nguồn đúng (ground truth) để đo retrieval.

    relevant_sources: danh sách nguồn đúng, mỗi phần tử một trong hai dạng
        {"document_title": "lesson_oop.md", "pages": [1, 2]}   (pages có thể bỏ trống)
        {"video_id": "video-01", "start": 30, "end": 95}
    """
    __tablename__ = "eval_samples"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    suite = Column(String(128), nullable=False, default="default", index=True)
    external_id = Column(String(64), nullable=True)
    split = Column(String(8), nullable=False, default="test")  # dev | test
    question = Column(Text, nullable=False)
    expected_answer = Column(Text, nullable=True)
    relevant_sources = Column(JSONB, nullable=True)
    key_terms = Column(JSONB, nullable=True)
    course_id = Column(String(128), nullable=True)
    lesson_id = Column(String(128), nullable=True)
    answerable = Column(Boolean, nullable=True, default=True)  # False = câu ngoài học liệu, kỳ vọng hệ thống từ chối
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class AIEvaluation(Base):
    """Một lần chạy đánh giá."""
    __tablename__ = "ai_evaluations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    test_suite_name = Column(String(128), default="default")
    split = Column(String(8), nullable=True)
    total_samples = Column(Integer, nullable=False)
    error_count = Column(Integer, nullable=True)
    hit_at_k = Column(Float, nullable=False)
    groundedness_score = Column(Float, nullable=False)
    avg_latency_ms = Column(Float, nullable=False)
    config = Column(JSONB, nullable=True)
    metrics_summary = Column(JSONB, nullable=True)
    report_markdown = Column(Text, nullable=True)
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class EvalResult(Base):
    __tablename__ = "eval_results"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    evaluation_id = Column(UUID(as_uuid=True), ForeignKey("ai_evaluations.id", ondelete="CASCADE"), nullable=False, index=True)
    sample_id = Column(UUID(as_uuid=True), ForeignKey("eval_samples.id", ondelete="SET NULL"), nullable=True)
    question = Column(Text, nullable=True)
    status = Column(String(16), nullable=False)  # ok | error
    hit = Column(Boolean, nullable=True)
    hit_method = Column(String(16), nullable=True)  # ground_truth | key_terms | none
    first_relevant_rank = Column(Integer, nullable=True)
    recall = Column(Float, nullable=True)
    groundedness = Column(Float, nullable=True)
    correctness = Column(Float, nullable=True)
    context_relevance = Column(Float, nullable=True)
    refused = Column(Boolean, nullable=True)
    retrieval_ms = Column(Float, nullable=True)
    latency_ms = Column(Float, nullable=True)
    retrieved = Column(JSONB, nullable=True)
    answer = Column(Text, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
