"""Tài khoản, đăng nhập, lớp học.

Quyền quản lý:
- admin: mọi tài khoản và lớp.
- teacher: chỉ học sinh thuộc lớp mình dạy; chỉ gán học sinh vào lớp của mình; tạo lớp mới (tự thành giáo viên lớp đó).
"""
import csv
import io
import re
import secrets
import unicodedata

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.config import settings
from app.core.errors import AppError
from app.core.passwords import burn_time, check_policy, generate_password, hash_password, verify_password
from app.core.security import ROLES, Principal, create_token
from app.core.utils import utcnow
from app.models.accounts import ClassRoom, User
from app.models.learning import UserProfile

USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")
CLASS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# ---------------------------------------------------------------- tiện ích

def normalize_username(raw: str | None) -> str:
    u = (raw or "").strip().lower()
    if not USERNAME_RE.match(u):
        raise AppError(400, "INVALID_USERNAME",
                       "Tên đăng nhập 3–64 ký tự, chỉ gồm chữ thường không dấu, số, dấu chấm, gạch ngang, gạch dưới.")
    return u


def _email(raw: str | None) -> str | None:
    e = (raw or "").strip().lower()
    if not e:
        return None
    if not EMAIL_RE.match(e):
        raise AppError(400, "INVALID_EMAIL", "Email không hợp lệ.")
    return e


def _check_email_free(db: Session, email: str | None, except_user: str | None = None) -> None:
    if not email:
        return
    q = db.query(User).filter(func.lower(User.email) == email)
    if except_user:
        q = q.filter(User.user_id != except_user)
    if q.first():
        raise AppError(409, "EMAIL_TAKEN", "Email này đã được dùng cho tài khoản khác.")


def _class_list(raw) -> list[str]:
    if raw is None:
        return []
    items = raw if isinstance(raw, list) else re.split(r"[;,\s]+", str(raw))
    out = []
    for c in items:
        c = str(c).strip()
        if c and c not in out:
            if not CLASS_RE.match(c):
                raise AppError(400, "INVALID_CLASS", f"Mã lớp không hợp lệ: {c}")
            out.append(c)
    return out


def _existing_classes(db: Session, ids: list[str]) -> None:
    if not ids:
        return
    found = {c for (c,) in db.query(ClassRoom.class_id).filter(ClassRoom.class_id.in_(ids)).all()}
    missing = [c for c in ids if c not in found]
    if missing:
        raise AppError(400, "CLASS_NOT_FOUND", f"Chưa có lớp: {', '.join(missing)}. Tạo lớp trước ở mục Lớp học.")


def user_dict(u: User, admin_view: bool = False) -> dict:
    d = {"user_id": u.user_id, "name": u.display_name or u.user_id, "display_name": u.display_name, "email": u.email,
         "role": u.role, "class_ids": list(u.class_ids or []), "must_change_password": bool(u.must_change_password),
         "has_password": bool(u.password_hash)}
    if admin_view:
        d.update({"is_active": bool(u.is_active),
                  "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
                  "created_at": u.created_at.isoformat() if u.created_at else None, "created_by": u.created_by})
    return d


def issue(u: User) -> dict:
    token = create_token(u.user_id, u.role, list(u.class_ids or []), name=u.display_name,
                         token_version=int(u.token_version or 0))
    return {"access_token": token, "token_type": "bearer", "expires_in_minutes": settings.jwt_ttl_minutes,
            "user": user_dict(u)}


def _sync_profile(db: Session, u: User) -> None:
    p = db.get(UserProfile, u.user_id)
    if p is None:
        p = UserProfile(user_id=u.user_id, daily_goal_xp=settings.default_daily_goal_xp)
        db.add(p)
    p.display_name, p.role, p.class_ids, p.last_seen_at = u.display_name, u.role, list(u.class_ids or []), utcnow()


def get_user(db: Session, user_id: str) -> User:
    u = db.get(User, (user_id or "").strip().lower())
    if not u:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy tài khoản.")
    return u


# ---------------------------------------------------------------- đăng nhập / tự phục vụ

def login(db: Session, username: str, password: str) -> dict:
    uname = (username or "").strip().lower()
    u = db.get(User, uname) if uname else None
    if u is None:
        u = db.query(User).filter(func.lower(User.email) == uname).first() if "@" in uname else None
    if u is None or not u.password_hash:
        burn_time(password or "")
        raise AppError(401, "INVALID_CREDENTIALS", "Sai tên đăng nhập hoặc mật khẩu.")
    if not verify_password(password or "", u.password_hash):
        raise AppError(401, "INVALID_CREDENTIALS", "Sai tên đăng nhập hoặc mật khẩu.")
    if not u.is_active:
        raise AppError(403, "ACCOUNT_DISABLED", "Tài khoản đã bị khóa. Liên hệ giáo viên hoặc quản trị viên.")
    u.last_login_at = utcnow()
    _sync_profile(db, u)
    db.commit()
    return issue(u)


def register(db: Session, username: str, password: str, display_name: str | None, email: str | None,
             class_code: str | None) -> dict:
    if not settings.allow_registration:
        raise AppError(403, "REGISTRATION_DISABLED", "Hệ thống không cho tự đăng ký. Liên hệ giáo viên để được cấp tài khoản.")
    uname = normalize_username(username)
    check_policy(password, uname)
    if db.get(User, uname):
        raise AppError(409, "USERNAME_TAKEN", "Tên đăng nhập đã có người dùng.")
    em = _email(email)
    _check_email_free(db, em)
    classes = []
    if (class_code or "").strip():
        classes = [_class_by_code(db, class_code).class_id]
    u = User(user_id=uname, display_name=(display_name or "").strip() or None, email=em,
             password_hash=hash_password(password), role="student", class_ids=classes, created_by=uname,
             last_login_at=utcnow())
    db.add(u)
    _sync_profile(db, u)
    db.commit()
    return issue(u)


def update_me(db: Session, me: Principal, display_name: str | None, email: str | None) -> dict:
    u = get_user(db, me.user_id)
    if display_name is not None:
        u.display_name = display_name.strip() or None
    if email is not None:
        em = _email(email)
        _check_email_free(db, em, u.user_id)
        u.email = em
    _sync_profile(db, u)
    db.commit()
    return user_dict(u)


def change_password(db: Session, me: Principal, current: str, new: str) -> dict:
    u = get_user(db, me.user_id)
    if u.password_hash and not verify_password(current or "", u.password_hash):
        raise AppError(400, "WRONG_PASSWORD", "Mật khẩu hiện tại không đúng.")
    if u.password_hash and verify_password(new, u.password_hash):
        raise AppError(400, "SAME_PASSWORD", "Mật khẩu mới phải khác mật khẩu hiện tại.")
    check_policy(new, u.user_id)
    u.password_hash = hash_password(new)
    u.must_change_password = False
    u.token_version = int(u.token_version or 0) + 1  # đăng xuất các thiết bị khác
    db.commit()
    return issue(u)


def logout_all(db: Session, me: Principal) -> None:
    u = get_user(db, me.user_id)
    u.token_version = int(u.token_version or 0) + 1
    db.commit()


# ---------------------------------------------------------------- quản lý tài khoản

def _can_manage(actor: Principal, u: User) -> bool:
    if actor.is_admin:
        return True
    return actor.is_teacher and u.role == "student" and bool(set(u.class_ids or []) & set(actor.class_ids))


def _managed(db: Session, actor: Principal, user_id: str) -> User:
    u = get_user(db, user_id)
    if not _can_manage(actor, u):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy tài khoản (hoặc học sinh không thuộc lớp của bạn).")
    return u


def _teacher_classes(actor: Principal, requested: list[str]) -> list[str]:
    if actor.is_admin:
        return requested
    outside = [c for c in requested if c not in actor.class_ids]
    if outside:
        raise AppError(403, "CLASS_FORBIDDEN", f"Bạn không dạy lớp: {', '.join(outside)}.")
    return requested


def list_users(db: Session, actor: Principal, q: str | None = None, role: str | None = None,
               class_id: str | None = None, active: bool | None = None, limit: int = 500) -> list[dict]:
    query = db.query(User)
    if not actor.is_admin:
        if not actor.class_ids:
            return []
        query = query.filter(User.role == "student",
                             or_(*[User.class_ids.contains([c]) for c in actor.class_ids]))
    if q:
        like = f"%{q.strip().lower()}%"
        query = query.filter(or_(User.user_id.ilike(like), func.lower(User.display_name).like(like),
                                 func.lower(User.email).like(like)))
    if role:
        query = query.filter(User.role == role)
    if class_id:
        query = query.filter(User.class_ids.contains([class_id]))
    if active is not None:
        query = query.filter(User.is_active.is_(active))
    rows = query.order_by(User.role, User.user_id).limit(min(limit, 2000)).all()
    return [user_dict(u, admin_view=True) for u in rows]


def create_user(db: Session, actor: Principal, data: dict, commit: bool = True) -> tuple[User, str | None]:
    uname = normalize_username(data.get("username") or data.get("user_id"))
    if db.get(User, uname):
        raise AppError(409, "USERNAME_TAKEN", f"Tên đăng nhập {uname} đã tồn tại.")
    role = (data.get("role") or "student").strip().lower()
    if role not in ROLES:
        raise AppError(400, "INVALID_ROLE", "Vai trò phải là student, teacher hoặc admin.")
    if not actor.is_admin and role != "student":
        raise AppError(403, "FORBIDDEN", "Giáo viên chỉ tạo được tài khoản học sinh.")
    classes = _teacher_classes(actor, _class_list(data.get("class_ids")))
    if not actor.is_admin and not classes:
        raise AppError(400, "CLASS_REQUIRED", "Chọn ít nhất một lớp bạn dạy cho học sinh.")
    _existing_classes(db, classes)
    em = _email(data.get("email"))
    _check_email_free(db, em)
    password = (data.get("password") or "").strip()
    temp = None
    if password:
        check_policy(password, uname)
    else:
        password = temp = generate_password()
    u = User(user_id=uname, display_name=(data.get("display_name") or "").strip() or None, email=em,
             password_hash=hash_password(password), role=role, class_ids=classes, created_by=actor.user_id,
             must_change_password=bool(temp) or bool(data.get("must_change_password", True)))
    db.add(u)
    _sync_profile(db, u)
    if commit:
        db.commit()
    else:
        db.flush()
    return u, password if (temp or data.get("return_password")) else None


_HEADER_ALIASES = {
    "username": "username", "user_id": "username", "ten_dang_nhap": "username", "tendangnhap": "username",
    "ma": "username", "ma_hoc_sinh": "username", "mssv": "username", "tai_khoan": "username",
    "display_name": "display_name", "name": "display_name", "ho_ten": "display_name", "hoten": "display_name",
    "ten": "display_name", "ho_va_ten": "display_name",
    "role": "role", "vai_tro": "role",
    "class_ids": "class_ids", "classes": "class_ids", "class": "class_ids", "lop": "class_ids",
    "email": "email", "password": "password", "mat_khau": "password",
}


def _norm_header(h: str) -> str:
    h = unicodedata.normalize("NFD", (h or "").strip().lower()).replace("đ", "d")
    h = "".join(c for c in h if unicodedata.category(c) != "Mn")
    return _HEADER_ALIASES.get(re.sub(r"[^a-z0-9]+", "_", h).strip("_"), "")


def import_csv(db: Session, actor: Principal, text: str, default_class_id: str | None = None,
               default_role: str = "student") -> dict:
    text = (text or "").lstrip("﻿")
    if not text.strip():
        raise AppError(400, "EMPTY_CSV", "File CSV trống.")
    sample = text[:2000]
    delimiter = ";" if sample.count(";") > sample.count(",") else ","
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    rows = [r for r in reader if any(c.strip() for c in r)]
    header = [_norm_header(h) for h in rows[0]]
    if "username" not in header:
        raise AppError(400, "CSV_HEADER", "Dòng đầu cần có cột username (hoặc ten_dang_nhap / mssv). "
                                          "Các cột khác: display_name (ho_ten), class_ids (lop), email, role, password.")
    if len(rows) > 1001:
        raise AppError(400, "CSV_TOO_LARGE", "Tối đa 1000 dòng mỗi lần nhập.")
    created, errors = [], []
    for i, r in enumerate(rows[1:], start=2):
        rec = {header[j]: (r[j].strip() if j < len(r) else "") for j in range(len(header)) if header[j]}
        if not rec.get("class_ids") and default_class_id:
            rec["class_ids"] = default_class_id
        rec["role"] = rec.get("role") or default_role
        try:
            with db.begin_nested():
                u, pw = create_user(db, actor, {**rec, "return_password": True}, commit=False)
            created.append({"row": i, "user_id": u.user_id, "name": u.display_name, "role": u.role,
                            "class_ids": u.class_ids, "password": pw,
                            "temporary": not bool(rec.get("password"))})
        except AppError as e:
            errors.append({"row": i, "username": rec.get("username"), "error": e.detail})
    db.commit()
    return {"created": created, "errors": errors, "total_rows": len(rows) - 1}


def update_user(db: Session, actor: Principal, user_id: str, changes: dict) -> dict:
    u = _managed(db, actor, user_id)
    if "display_name" in changes and changes["display_name"] is not None:
        u.display_name = changes["display_name"].strip() or None
    if "email" in changes and changes["email"] is not None:
        em = _email(changes["email"])
        _check_email_free(db, em, u.user_id)
        u.email = em
    if changes.get("role") and changes["role"] != u.role:
        if not actor.is_admin:
            raise AppError(403, "FORBIDDEN", "Chỉ quản trị viên được đổi vai trò.")
        if changes["role"] not in ROLES:
            raise AppError(400, "INVALID_ROLE", "Vai trò không hợp lệ.")
        if u.user_id == actor.user_id:
            raise AppError(400, "SELF_ROLE", "Không thể tự đổi vai trò của chính mình.")
        u.role = changes["role"]
    if changes.get("class_ids") is not None:
        requested = _class_list(changes["class_ids"])
        if actor.is_admin:
            new = requested
        else:  # giáo viên chỉ thay đổi phần lớp mình dạy, giữ nguyên lớp khác
            _teacher_classes(actor, requested)
            new = [c for c in (u.class_ids or []) if c not in actor.class_ids] + requested
            if not set(new) & set(actor.class_ids):
                raise AppError(400, "CLASS_REQUIRED", "Học sinh phải còn ít nhất một lớp của bạn (hoặc hãy khóa tài khoản).")
        _existing_classes(db, new)
        u.class_ids = new
    if changes.get("is_active") is not None:
        if u.user_id == actor.user_id and not changes["is_active"]:
            raise AppError(400, "SELF_DISABLE", "Không thể tự khóa tài khoản của chính mình.")
        u.is_active = bool(changes["is_active"])
        if not u.is_active:
            u.token_version = int(u.token_version or 0) + 1
    _sync_profile(db, u)
    db.commit()
    return user_dict(u, admin_view=True)


def reset_password(db: Session, actor: Principal, user_id: str) -> dict:
    u = _managed(db, actor, user_id)
    if u.user_id == actor.user_id:
        raise AppError(400, "SELF_RESET", "Hãy dùng chức năng đổi mật khẩu trong Hồ sơ.")
    temp = generate_password()
    u.password_hash = hash_password(temp)
    u.must_change_password = True
    u.token_version = int(u.token_version or 0) + 1
    db.commit()
    return {"user_id": u.user_id, "temporary_password": temp}


def ensure_demo_user(db: Session, user_id: str, role: str, class_ids: list[str], name: str | None) -> User:
    """Chỉ dùng khi ALLOW_TEST_LOGIN=true (kiểm thử): tạo/cập nhật tài khoản không mật khẩu."""
    uid = user_id.strip().lower()[:64]
    u = db.get(User, uid)
    if u is None:
        u = User(user_id=uid, role=role, class_ids=class_ids, display_name=name, created_by="demo-login")
        db.add(u)
    else:
        u.role, u.class_ids, u.is_active = role, class_ids, True
        if name:
            u.display_name = name
    for c in class_ids:
        if not db.get(ClassRoom, c):
            db.add(ClassRoom(class_id=c, name=c, join_code=_new_code(db), created_by="demo-login"))
    _sync_profile(db, u)
    db.commit()
    return u


# ---------------------------------------------------------------- lớp học

def _new_code(db: Session) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(6))
        if not db.query(ClassRoom).filter(ClassRoom.join_code == code).first():
            return code


def _class_by_code(db: Session, code: str) -> ClassRoom:
    c = db.query(ClassRoom).filter(ClassRoom.join_code == (code or "").strip().upper(),
                                   ClassRoom.is_active.is_(True)).first()
    if not c:
        raise AppError(404, "INVALID_CLASS_CODE", "Mã tham gia lớp không đúng hoặc lớp đã đóng.")
    return c


def _count_members(db: Session, class_ids: list[str]) -> dict[str, dict]:
    out = {c: {"students": 0, "teachers": 0} for c in class_ids}
    for u in db.query(User.role, User.class_ids).filter(User.is_active.is_(True)).all():
        for c in u.class_ids or []:
            if c in out:
                out[c]["students" if u.role == "student" else "teachers"] += 1
    return out


def class_dict(c: ClassRoom, counts: dict | None = None, show_code: bool = True) -> dict:
    d = {"class_id": c.class_id, "name": c.name, "is_active": bool(c.is_active), "created_by": c.created_by,
         "created_at": c.created_at.isoformat() if c.created_at else None}
    if show_code:
        d["join_code"] = c.join_code
    if counts is not None:
        d.update(counts)
    return d


def list_classes(db: Session, actor: Principal) -> list[dict]:
    q = db.query(ClassRoom)
    if not actor.is_admin:
        if not actor.class_ids:
            return []
        q = q.filter(ClassRoom.class_id.in_(actor.class_ids))
    rows = q.order_by(ClassRoom.class_id).all()
    counts = _count_members(db, [c.class_id for c in rows])
    return [class_dict(c, counts.get(c.class_id), show_code=actor.is_teacher) for c in rows]


def create_class(db: Session, actor: Principal, class_id: str, name: str) -> dict:
    cid = (class_id or "").strip()
    if not CLASS_RE.match(cid):
        raise AppError(400, "INVALID_CLASS", "Mã lớp chỉ gồm chữ, số, dấu chấm, gạch ngang (tối đa 64 ký tự).")
    if db.get(ClassRoom, cid):
        raise AppError(409, "CLASS_EXISTS", f"Lớp {cid} đã tồn tại.")
    c = ClassRoom(class_id=cid, name=(name or "").strip() or cid, join_code=_new_code(db), created_by=actor.user_id)
    db.add(c)
    if not actor.is_admin:  # giáo viên tạo lớp thì dạy lớp đó
        me = get_user(db, actor.user_id)
        me.class_ids = list(me.class_ids or []) + [cid]
    db.commit()
    return class_dict(c, {"students": 0, "teachers": 0 if actor.is_admin else 1})


def _managed_class(db: Session, actor: Principal, class_id: str) -> ClassRoom:
    c = db.get(ClassRoom, class_id)
    if not c or not actor.can_access_class(class_id):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy lớp.")
    return c


def update_class(db: Session, actor: Principal, class_id: str, name: str | None, is_active: bool | None,
                 rotate_code: bool = False) -> dict:
    c = _managed_class(db, actor, class_id)
    if name is not None and name.strip():
        c.name = name.strip()
    if is_active is not None:
        c.is_active = is_active
    if rotate_code:
        c.join_code = _new_code(db)
    db.commit()
    return class_dict(c, _count_members(db, [c.class_id])[c.class_id])


def join_class(db: Session, me: Principal, code: str) -> dict:
    c = _class_by_code(db, code)
    u = get_user(db, me.user_id)
    if c.class_id not in (u.class_ids or []):
        u.class_ids = list(u.class_ids or []) + [c.class_id]
        _sync_profile(db, u)
        db.commit()
    return {"class": class_dict(c, show_code=False), "user": user_dict(u)}


def leave_class(db: Session, me: Principal, class_id: str) -> dict:
    u = get_user(db, me.user_id)
    if u.role != "student":
        raise AppError(400, "NOT_STUDENT", "Giáo viên rời lớp qua quản trị viên.")
    u.class_ids = [c for c in (u.class_ids or []) if c != class_id]
    _sync_profile(db, u)
    db.commit()
    return user_dict(u)


def my_classes(db: Session, me: Principal) -> list[dict]:
    rows = db.query(ClassRoom).filter(ClassRoom.class_id.in_(me.class_ids or [""])).all()
    return [class_dict(c, show_code=me.is_teacher) for c in rows]
