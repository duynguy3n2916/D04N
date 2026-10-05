import re
import uuid
from datetime import datetime, timezone

from app.core.errors import AppError


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def parse_uuid(value, field: str = "id", required: bool = True) -> uuid.UUID | None:
    if value is None or value == "":
        if required:
            raise AppError(400, "INVALID_ID", f"Thiếu {field}.")
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except ValueError:
        raise AppError(400, "INVALID_ID", f"{field} không phải UUID hợp lệ: {value}")


def clean_id(value: str | None) -> str | None:
    """Chuẩn hóa mã nghiệp vụ (course/class/lesson/video) do LMS cấp: chuỗi tự do, bỏ khoảng trắng."""
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def fmt_ts(seconds: float | None) -> str:
    if seconds is None:
        return "?"
    s = int(round(seconds))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


_OPTION_PREFIX = re.compile(r"^\s*([A-Ha-h])\s*[\.\)\:\-]\s*")


def strip_option_label(option: str) -> str:
    return _OPTION_PREFIX.sub("", option or "").strip()


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower()).strip(" .:;")


def resolve_option_index(options: list[str] | None, answer: str | None) -> int | None:
    """Tìm chỉ số lựa chọn ứng với một đáp án: chấp nhận 'B', 'B.', 'B. nội dung' hoặc đúng nội dung lựa chọn."""
    if not options or answer is None:
        return None
    ans = str(answer).strip()
    if not ans:
        return None
    letters = [chr(ord("a") + i) for i in range(len(options))]
    # 1) chỉ là chữ cái
    m = re.fullmatch(r"\s*([A-Ha-h])\s*[\.\)\:]?\s*", ans)
    if m and m.group(1).lower() in letters:
        return letters.index(m.group(1).lower())
    # 2) trùng nguyên văn hoặc trùng nội dung sau khi bỏ nhãn
    n_ans = normalize_text(ans)
    n_ans_body = normalize_text(strip_option_label(ans))
    for i, opt in enumerate(options):
        if normalize_text(opt) == n_ans or normalize_text(strip_option_label(opt)) == n_ans_body:
            return i
    # 3) có nhãn chữ cái ở đầu, nội dung hơi khác
    m = _OPTION_PREFIX.match(ans)
    if m and m.group(1).lower() in letters:
        return letters.index(m.group(1).lower())
    return None
