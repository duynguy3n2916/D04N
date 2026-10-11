"""Lưu file upload an toàn: tên file sinh bằng uuid, giới hạn dung lượng, tính SHA-256, đưa vào kho file."""
import hashlib
import os
import tempfile
import uuid
from pathlib import Path

from fastapi import UploadFile

from app.core.errors import AppError
from app.services.object_store import get_store


def safe_extension(filename: str | None, allowed: tuple[str, ...]) -> str:
    ext = Path(filename or "").suffix.lower().lstrip(".")
    if ext not in allowed:
        raise AppError(400, "UNSUPPORTED_FILE", f"Định dạng .{ext or '?'} không hỗ trợ. Cho phép: {', '.join(allowed)}")
    return ext


def save_upload(file: UploadFile, sub: str, ext: str, max_mb: int) -> tuple[str, str, int]:
    """Ghi upload qua file tạm (kiểm tra dung lượng, tính SHA-256) rồi đưa vào kho.

    Trả về (khóa file, sha256, số byte). Khóa có dạng ``<sub>/<uuid>.<ext>``.
    """
    key = f"{sub}/{uuid.uuid4().hex}.{ext}"
    fd, tmp = tempfile.mkstemp(suffix=f".{ext}")
    os.close(fd)
    limit = max_mb * 1024 * 1024
    h = hashlib.sha256()
    size = 0
    try:
        with open(tmp, "wb") as out:
            while True:
                block = file.file.read(1024 * 1024)
                if not block:
                    break
                size += len(block)
                if size > limit:
                    raise AppError(413, "FILE_TOO_LARGE", f"File vượt quá {max_mb} MB.")
                h.update(block)
                out.write(block)
        if size == 0:
            raise AppError(400, "EMPTY_FILE", "File rỗng.")
        get_store().put_file(key, tmp)
    except Exception:
        Path(tmp).unlink(missing_ok=True)
        raise
    return key, h.hexdigest(), size


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
