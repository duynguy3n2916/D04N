"""Xác thực JWT và phân quyền theo vai trò + phạm vi lớp học.

Token (HS256, ký bằng JWT_SECRET) có claim: sub (tên đăng nhập), role, class_ids, tv (token_version).
Mỗi request đọc lại tài khoản trong bảng users nên:
  - khóa tài khoản, đổi vai trò / lớp có hiệu lực ngay;
  - đổi mật khẩu / "đăng xuất mọi thiết bị" (tăng token_version) làm token cũ mất hiệu lực.
Token do LMS ký cho người dùng chưa có tài khoản chỉ được chấp nhận khi ALLOW_EXTERNAL_TOKENS=true.
"""
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, Query, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.config import settings
from app.core.errors import AppError
from app.database import get_db

ROLES = ("student", "teacher", "admin")
_bearer = HTTPBearer(auto_error=False)
# Khi tài khoản bị buộc đổi mật khẩu, chỉ các API này dùng được.
_ALLOWED_WHEN_MUST_CHANGE = ("/ai/auth/",)


@dataclass
class Principal:
    user_id: str
    role: str
    class_ids: list[str] = field(default_factory=list)
    name: str | None = None
    must_change_password: bool = False

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def is_teacher(self) -> bool:
        return self.role in ("teacher", "admin")

    def can_access_class(self, class_id: str | None) -> bool:
        if class_id is None or self.is_admin:
            return True
        return class_id in self.class_ids


def create_token(user_id: str, role: str, class_ids: list[str] | None = None, ttl_minutes: int | None = None,
                 name: str | None = None, token_version: int = 0) -> str:
    if role not in ROLES:
        raise AppError(400, "INVALID_ROLE", f"role phải là một trong {ROLES}")
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "role": role,
        "class_ids": class_ids or [],
        "tv": token_version,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=ttl_minutes or settings.jwt_ttl_minutes)).timestamp()),
    }
    if name:
        payload["name"] = name
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def _decode(token: str) -> dict:
    try:
        data = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.ExpiredSignatureError:
        raise AppError(401, "TOKEN_EXPIRED", "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.")
    except jwt.PyJWTError:
        raise AppError(401, "INVALID_TOKEN", "Token không hợp lệ.")
    if data.get("role") not in ROLES or not data.get("sub"):
        raise AppError(401, "INVALID_TOKEN", "Token thiếu sub/role hợp lệ.")
    return data


def decode_token(token: str) -> Principal:
    """Chỉ giải mã chữ ký (không tra DB). Dùng cho tiện ích / test; request thật dùng resolve_principal."""
    data = _decode(token)
    return Principal(user_id=str(data["sub"]), role=data["role"], class_ids=[str(c) for c in data.get("class_ids") or []],
                     name=data.get("name"))


def resolve_principal(db: Session, token: str, path: str = "") -> Principal:
    from app.models.accounts import User

    data = _decode(token)
    user = db.get(User, str(data["sub"]))
    if user is None:
        if not settings.allow_external_tokens:
            raise AppError(401, "UNKNOWN_USER", "Tài khoản không tồn tại hoặc đã bị xóa.")
        return Principal(user_id=str(data["sub"]), role=data["role"],
                         class_ids=[str(c) for c in data.get("class_ids") or []], name=data.get("name"))
    if not user.is_active:
        raise AppError(401, "ACCOUNT_DISABLED", "Tài khoản đã bị khóa. Liên hệ giáo viên hoặc quản trị viên.")
    if int(data.get("tv", 0)) != int(user.token_version or 0):
        raise AppError(401, "SESSION_REVOKED", "Phiên đăng nhập đã bị thu hồi (mật khẩu vừa đổi). Vui lòng đăng nhập lại.")
    p = Principal(user_id=user.user_id, role=user.role, class_ids=list(user.class_ids or []),
                  name=user.display_name, must_change_password=bool(user.must_change_password))
    if p.must_change_password and path and not path.startswith(_ALLOWED_WHEN_MUST_CHANGE):
        raise AppError(403, "PASSWORD_CHANGE_REQUIRED", "Bạn cần đổi mật khẩu trước khi tiếp tục.")
    return p


def get_current_user(request: Request, creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
                     db: Session = Depends(get_db)) -> Principal:
    if creds is None or not creds.credentials:
        raise AppError(401, "UNAUTHORIZED", "Chưa đăng nhập.")
    return resolve_principal(db, creds.credentials, request.url.path)


def get_user_for_media(request: Request, creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
                       access_token: str | None = Query(default=None), db: Session = Depends(get_db)) -> Principal:
    """Cho file media (thẻ <video>, pdf.js) không gửi được header: chấp nhận ?access_token=."""
    token = creds.credentials if creds is not None and creds.credentials else access_token
    if not token:
        raise AppError(401, "UNAUTHORIZED", "Thiếu token.")
    return resolve_principal(db, token, request.url.path)


def require_teacher(user: Principal = Depends(get_current_user)) -> Principal:
    if not user.is_teacher:
        raise AppError(403, "FORBIDDEN", "Chức năng này chỉ dành cho giáo viên.")
    return user


def require_admin(user: Principal = Depends(get_current_user)) -> Principal:
    if not user.is_admin:
        raise AppError(403, "FORBIDDEN", "Chức năng này chỉ dành cho quản trị viên.")
    return user


def ensure_class_access(user: Principal, class_id: str | None) -> None:
    if not user.can_access_class(class_id):
        raise AppError(403, "CLASS_FORBIDDEN", f"Bạn không có quyền với lớp {class_id}.")
