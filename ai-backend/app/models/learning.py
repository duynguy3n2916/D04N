"""Cấu trúc khóa học và tiến độ học tập.

Course -> Chapter -> Lesson -> LessonItem (video | slide | reading | quiz)
- Lesson.code là mã bài học dùng chung với Knowledge Base (ai_documents.lesson_id), ví dụ "lesson-oop-01".
- LessonItem trỏ tới video (video_id), tài liệu (document_id: slide PDF/PPTX) hoặc chứa nội dung bài đọc (content_md).
"""
import uuid

from sqlalchemy import Column, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
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
