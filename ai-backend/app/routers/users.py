"""Quản lý tài khoản và lớp học (admin: toàn bộ; giáo viên: học sinh và lớp của mình)."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import Principal, require_teacher
from app.database import get_db
from app.services import accounts

router = APIRouter(prefix="/ai", tags=["users"])


@router.get("/users")
def list_users(q: str | None = None, role: str | None = None, class_id: str | None = None, active: bool | None = None,
               user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    return accounts.list_users(db, user, q=q, role=role, class_id=class_id, active=active)


class CreateUserRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    display_name: str | None = Field(default=None, max_length=200)
    role: str = "student"
    class_ids: list[str] = []
    email: str | None = Field(default=None, max_length=255)
    password: str | None = Field(default=None, max_length=128)  # bỏ trống -> sinh mật khẩu tạm


@router.post("/users", status_code=201)
def create_user(req: CreateUserRequest, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    """Tạo tài khoản. Mật khẩu tạm (nếu có) chỉ trả về một lần; người dùng phải đổi ở lần đăng nhập đầu."""
    u, pw = accounts.create_user(db, user, req.model_dump())
    return {"user": accounts.user_dict(u, admin_view=True), "temporary_password": pw}


class ImportRequest(BaseModel):
    csv: str = Field(min_length=1, max_length=2_000_000)
    default_class_id: str | None = None
    default_role: str = "student"


@router.post("/users/import")
def import_users(req: ImportRequest, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    """Nhập danh sách từ CSV (cột: username, display_name, class_ids, email, role, password). Lỗi từng dòng không chặn dòng khác."""
    return accounts.import_csv(db, user, req.csv, req.default_class_id, req.default_role)


class UpdateUserRequest(BaseModel):
    display_name: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=255)
    role: str | None = None
    class_ids: list[str] | None = None
    is_active: bool | None = None


@router.patch("/users/{user_id}")
def update_user(user_id: str, req: UpdateUserRequest, user: Principal = Depends(require_teacher),
                db: Session = Depends(get_db)):
    return accounts.update_user(db, user, user_id, req.model_dump())


@router.post("/users/{user_id}/reset-password")
def reset_password(user_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    """Cấp mật khẩu tạm mới (hiện một lần), thu hồi mọi phiên đăng nhập của tài khoản đó."""
    return accounts.reset_password(db, user, user_id)


# ---------------------------------------------------------------- lớp học

@router.get("/classes")
def list_classes(user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    return accounts.list_classes(db, user)


class CreateClassRequest(BaseModel):
    class_id: str = Field(min_length=1, max_length=64)
    name: str = Field(default="", max_length=200)


@router.post("/classes", status_code=201)
def create_class(req: CreateClassRequest, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    return accounts.create_class(db, user, req.class_id, req.name)


class UpdateClassRequest(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    is_active: bool | None = None
    rotate_code: bool = False


@router.patch("/classes/{class_id}")
def update_class(class_id: str, req: UpdateClassRequest, user: Principal = Depends(require_teacher),
                 db: Session = Depends(get_db)):
    return accounts.update_class(db, user, class_id, req.name, req.is_active, req.rotate_code)
