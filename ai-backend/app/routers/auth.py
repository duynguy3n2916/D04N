"""Đăng nhập, đăng ký, hồ sơ tài khoản, đổi mật khẩu, tham gia lớp."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import settings
from app.core.errors import AppError
from app.core.passwords import MIN_LENGTH
from app.core.security import Principal, get_current_user
from app.database import get_db
from app.services import accounts

router = APIRouter(prefix="/ai/auth", tags=["auth"])


@router.get("/config")
def auth_config():
    """Cho màn hình đăng nhập biết bật/tắt đăng ký và đăng nhập demo."""
    return {"allow_registration": settings.allow_registration, "allow_test_login": settings.allow_test_login,
            "password_min_length": MIN_LENGTH, "login_hint": settings.login_hint or None}


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=256)


@router.post("/login")
def login(req: LoginRequest, db: Session = Depends(get_db)):
    """Đăng nhập bằng tên đăng nhập (hoặc email) + mật khẩu."""
    return accounts.login(db, req.username, req.password)


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=1, max_length=128)
    display_name: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=255)
    class_code: str | None = Field(default=None, max_length=16)


@router.post("/register")
def register(req: RegisterRequest, db: Session = Depends(get_db)):
    """Học sinh tự tạo tài khoản (khi ALLOW_REGISTRATION=true); có mã lớp thì vào lớp luôn."""
    return accounts.register(db, req.username, req.password, req.display_name, req.email, req.class_code)


@router.get("/me")
def me(user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.models.accounts import User
    u = db.get(User, user.user_id)
    if u is None:  # token LMS cho người dùng chưa có tài khoản
        return {"user_id": user.user_id, "role": user.role, "class_ids": user.class_ids, "name": user.name or user.user_id,
                "must_change_password": False, "has_password": False, "classes": []}
    return {**accounts.user_dict(u), "classes": accounts.my_classes(db, user)}


class UpdateMeRequest(BaseModel):
    display_name: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=255)


@router.patch("/me")
def update_me(req: UpdateMeRequest, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return accounts.update_me(db, user, req.display_name, req.email)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(default="", max_length=256)
    new_password: str = Field(min_length=1, max_length=128)


@router.post("/change-password")
def change_password(req: ChangePasswordRequest, user: Principal = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    """Đổi mật khẩu. Các phiên đăng nhập khác bị thu hồi; trả về token mới cho phiên hiện tại."""
    return accounts.change_password(db, user, req.current_password, req.new_password)


@router.post("/logout-all")
def logout_all(user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    """Đăng xuất khỏi mọi thiết bị (mọi token đã cấp mất hiệu lực)."""
    accounts.logout_all(db, user)
    return {"ok": True}


class JoinClassRequest(BaseModel):
    code: str = Field(min_length=4, max_length=16)


@router.post("/join-class")
def join_class(req: JoinClassRequest, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return accounts.join_class(db, user, req.code)


@router.post("/leave-class/{class_id}")
def leave_class(class_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    return accounts.leave_class(db, user, class_id)


# ---------------------------------------------------------------- chỉ dùng cho kiểm thử

class DemoLoginRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)
    role: str = Field(pattern="^(student|teacher|admin)$")
    class_ids: list[str] = []
    display_name: str | None = Field(default=None, max_length=200)


@router.post("/demo-login", include_in_schema=False)
def demo_login(req: DemoLoginRequest, db: Session = Depends(get_db)):
    """Cấp token không cần mật khẩu. Chỉ hoạt động khi ALLOW_TEST_LOGIN=true (môi trường kiểm thử)."""
    if not settings.allow_test_login:
        raise AppError(403, "DEMO_LOGIN_DISABLED", "Đăng nhập demo đã tắt. Hãy đăng nhập bằng tài khoản.")
    class_ids = [c.strip() for c in req.class_ids if c.strip()]
    u = accounts.ensure_demo_user(db, req.user_id, req.role, class_ids, (req.display_name or "").strip() or None)
    return accounts.issue(u)
