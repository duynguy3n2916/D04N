"""Tài khoản người dùng và lớp học.

- users: tài khoản đăng nhập bằng tên đăng nhập + mật khẩu (băm scrypt). Vai trò và danh sách lớp lưu ở đây,
  được đọc lại mỗi request nên đổi quyền / khóa tài khoản có hiệu lực ngay.
- token_version: tăng khi đổi mật khẩu, cấp lại mật khẩu hoặc "đăng xuất mọi thiết bị" -> mọi token cũ mất hiệu lực.
- classes: lớp học có mã tham gia (join_code) để học sinh tự vào lớp.
"""
from sqlalchemy import Boolean, Column, DateTime, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func

from app.database import Base


class User(Base):
    __tablename__ = "users"

    user_id = Column(String(64), primary_key=True)  # tên đăng nhập (chữ thường)
    display_name = Column(String(200), nullable=True)
    email = Column(String(255), nullable=True, unique=True)
    password_hash = Column(String(255), nullable=True)  # null = tài khoản chỉ đăng nhập qua token LMS / demo
    role = Column(String(16), nullable=False, default="student")
    class_ids = Column(JSONB, nullable=False, default=list)
    is_active = Column(Boolean, nullable=False, default=True)
    must_change_password = Column(Boolean, nullable=False, default=False)
    token_version = Column(Integer, nullable=False, default=0)
    last_login_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ClassRoom(Base):
    __tablename__ = "classes"

    class_id = Column(String(64), primary_key=True)  # mã lớp, ví dụ "CS101"
    name = Column(String(200), nullable=False)
    join_code = Column(String(16), nullable=False, unique=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
