"""Cấu trúc khóa học và tiến độ học tập.

Course -> Chapter -> Lesson -> LessonItem (video | slide | reading | quiz)
- Lesson.code là mã bài học dùng chung với Knowledge Base (ai_documents.lesson_id), ví dụ "lesson-oop-01".
- LessonItem trỏ tới video (video_id), tài liệu (document_id: slide PDF/PPTX) hoặc chứa nội dung bài đọc (content_md).
"""
import uuid

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class Course(Base):
    __tablename__ = "courses"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code = Column(String(128), nullable=False, unique=True)
    title = Column(String(300), nullable=False)
    description = Column(Text, nullable=True)
    class_id = Column(String(128), nullable=True, index=True)
    cover_path = Column(String(512), nullable=True)  # ảnh bìa khóa học, lưu trong storage
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    chapters = relationship("Chapter", back_populates="course", cascade="all, delete-orphan",
                            order_by="Chapter.position")


class Chapter(Base):
    __tablename__ = "course_chapters"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    course_id = Column(UUID(as_uuid=True), ForeignKey("courses.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(String(300), nullable=False)
    position = Column(Integer, nullable=False, default=0)

    course = relationship("Course", back_populates="chapters")
    lessons = relationship("Lesson", back_populates="chapter", cascade="all, delete-orphan",
                           order_by="Lesson.position")


class Lesson(Base):
    __tablename__ = "course_lessons"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    chapter_id = Column(UUID(as_uuid=True), ForeignKey("course_chapters.id", ondelete="CASCADE"), nullable=False, index=True)
    code = Column(String(128), nullable=False, unique=True)
    title = Column(String(300), nullable=False)
    description = Column(Text, nullable=True)
    position = Column(Integer, nullable=False, default=0)

    chapter = relationship("Chapter", back_populates="lessons")
    items = relationship("LessonItem", back_populates="lesson", cascade="all, delete-orphan",
                         order_by="LessonItem.position")


class LessonItem(Base):
    __tablename__ = "lesson_items"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    lesson_id = Column(UUID(as_uuid=True), ForeignKey("course_lessons.id", ondelete="CASCADE"), nullable=False, index=True)
    type = Column(String(16), nullable=False)  # video | slide | reading | quiz
    title = Column(String(300), nullable=False)
    position = Column(Integer, nullable=False, default=0)
    video_id = Column(String(128), nullable=True, index=True)
    document_id = Column(UUID(as_uuid=True), nullable=True)
    content_md = Column(Text, nullable=True)
    duration_seconds = Column(Float, nullable=True)
    meta = Column(JSONB, nullable=True)  # quiz: {"count": 10, "pass_ratio": 0.8}; slide: {"notes": "..."}
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    lesson = relationship("Lesson", back_populates="items")


class MediaVideo(Base):
    """File video bài giảng (để phát) — gắn với video_id dùng chung với transcript và câu hỏi."""
    __tablename__ = "media_videos"

    video_id = Column(String(128), primary_key=True)
    title = Column(String(300), nullable=True)
    file_path = Column(String(1024), nullable=True)
    source_url = Column(String(2048), nullable=True)
    mime = Column(String(64), nullable=True)
    size_bytes = Column(Integer, nullable=True)
    duration_seconds = Column(Float, nullable=True)
    class_id = Column(String(128), nullable=True)
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class ItemProgress(Base):
    __tablename__ = "item_progress"
    __table_args__ = (UniqueConstraint("student_id", "item_id", name="ux_item_progress"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    student_id = Column(String(128), nullable=False, index=True)
    item_id = Column(UUID(as_uuid=True), ForeignKey("lesson_items.id", ondelete="CASCADE"), nullable=False, index=True)
    status = Column(String(16), nullable=False, default="in_progress")  # in_progress | completed
    position = Column(Float, nullable=True)  # giây video / trang slide / % bài đọc
    score = Column(Float, nullable=True)  # quiz
    meta = Column(JSONB, nullable=True)  # quiz: {"answers": {"<bank_item_id>": true/false}}
    completed_at = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class XPEvent(Base):
    __tablename__ = "xp_events"
    __table_args__ = (UniqueConstraint("student_id", "reason", "ref_id", name="ux_xp_once"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    student_id = Column(String(128), nullable=False, index=True)
    amount = Column(Integer, nullable=False)
    reason = Column(String(32), nullable=False)
    ref_id = Column(String(128), nullable=False)
    class_id = Column(String(128), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class UserProfile(Base):
    __tablename__ = "user_profiles"

    user_id = Column(String(128), primary_key=True)
    display_name = Column(String(200), nullable=True)
    role = Column(String(16), nullable=True)
    class_ids = Column(JSONB, nullable=True)
    daily_goal_xp = Column(Integer, nullable=False, default=50)
    last_seen_at = Column(DateTime(timezone=True), server_default=func.now())


class QuizAnswerLog(Base):
    """Lịch sử trả lời từng câu của học sinh (qua mọi lượt làm bài), dùng để ưu tiên câu hay sai khi luyện tập."""
    __tablename__ = "quiz_answer_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    student_id = Column(String(128), nullable=False, index=True)
    item_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    question_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    correct = Column(Boolean, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class FlashcardReview(Base):
    """Lịch ôn của học sinh với một thẻ (câu trong ngân hàng đã duyệt), theo thuật toán SM-2 đơn giản."""
    __tablename__ = "flashcard_reviews"
    __table_args__ = (UniqueConstraint("student_id", "card_id", name="ux_flashcard_student_card"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    student_id = Column(String(128), nullable=False, index=True)
    card_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    lesson_code = Column(String(128), nullable=False, index=True)
    ease = Column(Float, nullable=False, default=2.5)
    interval_days = Column(Float, nullable=False, default=0.0)
    reps = Column(Integer, nullable=False, default=0)
    lapses = Column(Integer, nullable=False, default=0)
    due_at = Column(DateTime(timezone=True), nullable=False, index=True)
    last_reviewed_at = Column(DateTime(timezone=True), nullable=True)



class ForumThread(Base):
    """Bài đăng trong diễn đàn của một lớp. Có thể gắn với một bài học."""
    __tablename__ = "forum_threads"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    class_id = Column(String(128), nullable=False, index=True)
    lesson_code = Column(String(128), nullable=True, index=True)
    author_id = Column(String(128), nullable=False)
    title = Column(String(200), nullable=False)
    body = Column(Text, nullable=False)
    pinned = Column(Boolean, nullable=False, default=False)
    locked = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ForumReply(Base):
    __tablename__ = "forum_replies"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    thread_id = Column(UUID(as_uuid=True), ForeignKey("forum_threads.id", ondelete="CASCADE"), nullable=False, index=True)
    author_id = Column(String(128), nullable=False)
    author_is_teacher = Column(Boolean, nullable=False, default=False)
    body = Column(Text, nullable=False)
    accepted = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)



class CourseClass(Base):
    """Một khóa học có thể dùng cho nhiều lớp. Lớp chính vẫn là Course.class_id (tương thích dữ liệu cũ)."""
    __tablename__ = "course_class_links"
    __table_args__ = (UniqueConstraint("course_id", "class_id", name="ux_course_class"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    course_id = Column(UUID(as_uuid=True), ForeignKey("courses.id", ondelete="CASCADE"), nullable=False, index=True)
    class_id = Column(String(128), nullable=False, index=True)
