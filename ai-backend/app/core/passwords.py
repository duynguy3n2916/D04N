"""Băm và kiểm tra mật khẩu bằng scrypt (thư viện chuẩn của Python, không cần cài thêm).

Định dạng lưu: scrypt$<n>$<r>$<p>$<salt_b64>$<hash_b64>
"""
import base64
import hashlib
import hmac
import re
import secrets
import string

from app.core.errors import AppError

_N, _R, _P, _DKLEN = 2 ** 14, 8, 1, 32
MIN_LENGTH = 8


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=_N, r=_R, p=_P, dklen=_DKLEN)
    return "scrypt${}${}${}${}${}".format(_N, _R, _P, base64.b64encode(salt).decode(), base64.b64encode(dk).decode())


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        algo, n, r, p, salt_b64, hash_b64 = stored.split("$")
        if algo != "scrypt":
            return False
        expected = base64.b64decode(hash_b64)
        dk = hashlib.scrypt(password.encode("utf-8"), salt=base64.b64decode(salt_b64), n=int(n), r=int(r), p=int(p),
                            dklen=len(expected))
        return hmac.compare_digest(dk, expected)
    except (ValueError, TypeError):
        return False


# Băm sẵn để khi tên đăng nhập không tồn tại vẫn tốn thời gian như bình thường (không lộ tài khoản nào tồn tại).
_DUMMY = hash_password("dummy-password-for-timing")


def burn_time(password: str) -> None:
    verify_password(password, _DUMMY)


def check_policy(password: str, username: str | None = None) -> None:
    """Tối thiểu 8 ký tự, có cả chữ và số, không trùng tên đăng nhập."""
    problems = []
    if len(password) < MIN_LENGTH:
        problems.append(f"ít nhất {MIN_LENGTH} ký tự")
    if not re.search(r"[A-Za-zÀ-ỹ]", password) or not re.search(r"\d", password):
        problems.append("có cả chữ và số")
    if username and password.lower() == username.lower():
        problems.append("khác tên đăng nhập")
    if len(password) > 128:
        problems.append("tối đa 128 ký tự")
    if problems:
        raise AppError(400, "WEAK_PASSWORD", "Mật khẩu cần " + ", ".join(problems) + ".")


def generate_password(length: int = 10) -> str:
    """Mật khẩu tạm dễ đọc (bỏ các ký tự dễ nhầm: 0/O, 1/l/I)."""
    letters = "".join(c for c in string.ascii_letters if c not in "OlI")
    digits = "23456789"
    while True:
        pw = "".join(secrets.choice(letters + digits) for _ in range(length))
        if any(c in digits for c in pw) and any(c in letters for c in pw):
            return pw
