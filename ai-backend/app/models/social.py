"""Mạng xã hội học tập của lớp: tương tác (thích), ảnh đính kèm, hộp thông báo, nhắn tin riêng giữa thành viên lớp."""
import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base


class ForumReaction(Base):
    """Một lượt "thích" của người dùng cho một bài đăng hoặc một bình luận (mỗi người một lần)."""
    __tablename__ = "forum_reactions"
    __table_args__ = (UniqueConstraint("user_id", "target_type", "target_id", name="ux_forum_reaction"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String(128), nullable=False, index=True)
    target_type = Column(String(8), nullable=False)  # thread | reply
    target_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class ForumImage(Base):
    """Ảnh tải lên cho diễn đàn của một lớp; chỉ thành viên lớp xem được."""
    __tablename__ = "forum_images"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    class_id = Column(String(128), nullable=False, index=True)
    uploader_id = Column(String(128), nullable=False)
    file_key = Column(String(512), nullable=False)
    mime = Column(String(64), nullable=False)
    size_bytes = Column(String(16), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class UserNotification(Base):
    """Hộp thông báo: được nhắc tên, có người trả lời bài / bình luận của mình, tin nhắn riêng mới."""
    __tablename__ = "user_notifications"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String(128), nullable=False, index=True)
    kind = Column(String(16), nullable=False)  # mention | reply | dm
    actor_id = Column(String(128), nullable=True)
    class_id = Column(String(128), nullable=True)
    thread_id = Column(UUID(as_uuid=True), nullable=True)
    conversation_id = Column(UUID(as_uuid=True), nullable=True)
    text = Column(String(300), nullable=False)
    read_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class DirectConversation(Base):
    """Hội thoại riêng giữa hai thành viên cùng lớp (user_a < user_b để không trùng cặp)."""
    __tablename__ = "direct_conversations"
    __table_args__ = (UniqueConstraint("user_a", "user_b", name="ux_direct_pair"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    class_id = Column(String(128), nullable=False, index=True)
    user_a = Column(String(128), nullable=False, index=True)
    user_b = Column(String(128), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    last_message_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class DirectMessage(Base):
    __tablename__ = "direct_messages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey("direct_conversations.id", ondelete="CASCADE"),
                             nullable=False, index=True)
    sender_id = Column(String(128), nullable=False)
    body = Column(Text, nullable=False)
    hidden = Column(Boolean, nullable=False, default=False)  # giáo viên ẩn sau khi xử lý báo cáo
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class DirectRead(Base):
    """Lần cuối mỗi người đọc một hội thoại (để đếm tin chưa đọc)."""
    __tablename__ = "direct_reads"
    __table_args__ = (UniqueConstraint("conversation_id", "user_id", name="ux_direct_read"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey("direct_conversations.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(String(128), nullable=False)
    read_at = Column(DateTime(timezone=True), nullable=False)


class DirectBlock(Base):
    """Người dùng chặn người khác: hai người không nhắn tin riêng được cho nhau."""
    __tablename__ = "direct_blocks"
    __table_args__ = (UniqueConstraint("blocker_id", "blocked_id", name="ux_direct_block"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    blocker_id = Column(String(128), nullable=False, index=True)
    blocked_id = Column(String(128), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class DirectReport(Base):
    """Báo cáo một tin nhắn riêng: giáo viên của lớp chỉ xem được đúng tin nhắn bị báo cáo, không đọc cả hội thoại."""
    __tablename__ = "direct_reports"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    class_id = Column(String(128), nullable=False, index=True)
    message_id = Column(UUID(as_uuid=True), ForeignKey("direct_messages.id", ondelete="CASCADE"), nullable=False)
    reporter_id = Column(String(128), nullable=False)
    reason = Column(String(500), nullable=False)
    status = Column(String(16), nullable=False, default="open")  # open | hidden | dismissed
    handled_by = Column(String(128), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    handled_at = Column(DateTime(timezone=True), nullable=True)
