import uuid

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class VideoQuestion(Base):
    """Câu hỏi gắn với một mốc thời gian của video.

    origin: teacher (GV tự soạn / sinh tại mốc GV chọn), ai_suggest (AI đề xuất), agent (Question Agent sinh khi học)
    status: draft -> approved | rejected | archived. Chỉ approved mới đến học sinh.
    """
    __tablename__ = "video_questions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    video_id = Column(String(128), nullable=False, index=True)
    timestamp = Column(Float, nullable=False)
    question = Column(Text, nullable=False)
    type = Column(String(32), nullable=False, default="multiple_choice")
    difficulty = Column(String(16), default="medium")
    answer = Column(Text, nullable=True)
    correct_index = Column(Integer, nullable=True)
    explanation = Column(Text, nullable=True)
    options = Column(JSONB, nullable=True)
    sources = Column(JSONB, nullable=True)
    origin = Column(String(16), nullable=True)
    session_id = Column(UUID(as_uuid=True), nullable=True, index=True)  # câu do Agent sinh cho 1 phiên học
    importance_score = Column(Float, nullable=True)
    original_payload = Column(JSONB, nullable=True)  # bản AI sinh ban đầu, để đo tỷ lệ GV chấp nhận
    edited = Column(Boolean, nullable=True)
    status = Column(String(32), default="draft", index=True)
    created_by = Column(String(128), nullable=True)
    reviewed_by = Column(String(128), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())


class AIInteraction(Base):
    """Một lần học sinh trả lời (hoặc hết giờ) câu hỏi video."""
    __tablename__ = "ai_interactions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    student_id = Column(String(128), nullable=True, index=True)
    video_id = Column(String(128), nullable=True, index=True)
    session_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    interaction_type = Column(String(32), nullable=False)  # video_question | timeout
    question_id = Column(UUID(as_uuid=True), ForeignKey("video_questions.id", ondelete="SET NULL"), nullable=True)
    student_answer = Column(Text, nullable=True)
    is_correct = Column(Boolean, nullable=True)
    verdict = Column(String(16), nullable=True)  # correct | partial | incorrect | timeout
    ai_feedback = Column(Text, nullable=True)
    feedback_status = Column(String(16), nullable=True)  # pending | ready | fallback
    # Tutor AI giải thích sau khi hết giờ / trả lời sai (sinh nền)
    tutor_status = Column(String(16), nullable=True)  # pending | ready | failed
    tutor_explanation = Column(Text, nullable=True)
    tutor_sources = Column(JSONB, nullable=True)
    timestamp = Column(Float, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class AIGeneration(Base):
    """Một lần giáo viên yêu cầu AI sinh câu hỏi (lịch sử). Câu hỏi cụ thể nằm ở question_bank."""
    __tablename__ = "ai_generations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    teacher_id = Column(String(128), nullable=True, index=True)
    lesson_id = Column(String(128), nullable=True, index=True)
    generation_type = Column(String(32), nullable=False)  # quiz | question
    request = Column(JSONB, nullable=True)
    prompt = Column(Text, nullable=True)
    result = Column(JSONB, nullable=True)
    status = Column(String(32), default="draft")
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class QuestionBankItem(Base):
    """Từng câu hỏi do Teacher AI sinh, được giáo viên sửa / duyệt riêng lẻ."""
    __tablename__ = "question_bank"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    generation_id = Column(UUID(as_uuid=True), ForeignKey("ai_generations.id", ondelete="CASCADE"), nullable=True, index=True)
    teacher_id = Column(String(128), nullable=True, index=True)
    course_id = Column(String(128), nullable=True)
    class_id = Column(String(128), nullable=True)
    lesson_id = Column(String(128), nullable=True, index=True)
    payload = Column(JSONB, nullable=False)
    original_payload = Column(JSONB, nullable=True)
    edited = Column(Boolean, nullable=True, default=False)
    status = Column(String(16), default="draft", index=True)  # draft | approved | rejected
    reviewed_by = Column(String(128), nullable=True)
    reviewed_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())
