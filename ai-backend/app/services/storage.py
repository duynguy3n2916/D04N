"""Lưu file upload an toàn: tên file sinh bằng uuid, giới hạn dung lượng, tính SHA-256."""
import hashlib
import uuid
from pathlib import Path

from fastapi import UploadFile

from app.config import settings
from app.core.errors import AppError


def storage_dir(sub: str) -> Path:
    p = Path(settings.storage_path) / sub
    p.mkdir(parents=True, exist_ok=True)
    return p


def safe_extension(filename: str | None, allowed: tuple[str, ...]) -> str:
    ext = Path(filename or "").suffix.lower().lstrip(".")
    if ext not in allowed:
        raise AppError(400, "UNSUPPORTED_FILE", f"Định dạng .{ext or '?'} không hỗ trợ. Cho phép: {', '.join(allowed)}")
    return ext


def save_upload(file: UploadFile, sub: str, ext: str, max_mb: int) -> tuple[Path, str, int]:
    """Ghi file theo từng khối, trả về (đường dẫn, sha256, số byte)."""
    path = storage_dir(sub) / f"{uuid.uuid4().hex}.{ext}"
    limit = max_mb * 1024 * 1024
    h = hashlib.sha256()
    size = 0
    try:
        with open(path, "wb") as out:
            while True:
                block = file.file.read(1024 * 1024)
                if not block:
                    break
                size += len(block)
                if size > limit:
                    raise AppError(413, "FILE_TOO_LARGE", f"File vượt quá {max_mb} MB.")
                h.update(block)
                out.write(block)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    if size == 0:
        path.unlink(missing_ok=True)
        raise AppError(400, "EMPTY_FILE", "File rỗng.")
    return path, h.hexdigest(), size


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
