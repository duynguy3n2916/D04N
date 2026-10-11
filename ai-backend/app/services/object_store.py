"""Kho file: local (thư mục STORAGE_PATH) hoặc Cloudflare R2 (API tương thích S3).

DB chỉ lưu *khóa* file, ví dụ ``documents/<uuid>.pdf``, không lưu đường dẫn máy.
- ``put_file`` đưa file mới vào kho, ``delete`` và ``exists`` quản lý file.
- ``local_path`` cho thư viện cần đường dẫn thật (PDF, PPTX, ffmpeg). Với R2 file được tải tạm rồi xóa.
- ``response`` phát file cho trình duyệt, hỗ trợ ``Range`` để tua video.
"""
import contextlib
import mimetypes
import os
import re
import shutil
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Iterator
from urllib.parse import quote

from fastapi import Request
from fastapi.responses import FileResponse, Response, StreamingResponse

from app.config import settings

_RANGE = re.compile(r"bytes=(\d*)-(\d*)$")


def _disposition(filename: str | None, inline: bool) -> str:
    kind = "inline" if inline else "attachment"
    if not filename:
        return kind
    return f"{kind}; filename*=UTF-8''{quote(filename)}"


class LocalStore:
    backend = "local"

    def _root(self, key: str) -> Path:
        return Path(settings.storage_path) / key

    def _path(self, key: str) -> Path:
        # Bản ghi cũ lưu đường dẫn đầy đủ (ví dụ storage/documents/x.pdf); khóa mới nối với STORAGE_PATH.
        p = Path(key)
        if p.is_absolute() or p.exists():
            return p
        return self._root(key)

    def put_file(self, key: str, src: str) -> None:
        dst = self._root(key)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(src, dst)  # file tạm có thể nằm khác ổ đĩa nên không dùng os.replace

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    @contextlib.contextmanager
    def local_path(self, key: str) -> Iterator[str]:
        yield str(self._path(key))

    def response(self, key: str, request: Request, *, media_type: str, filename: str | None = None,
                 inline: bool = True, cache_control: str | None = None) -> Response:
        headers = {"Content-Disposition": _disposition(filename, inline)}
        if cache_control:
            headers["Cache-Control"] = cache_control
        return FileResponse(self._path(key), media_type=media_type, headers=headers)


class R2Store:
    backend = "r2"

    def __init__(self) -> None:
        import boto3
        from botocore.config import Config
        if not (settings.r2_account_id and settings.r2_bucket and settings.r2_access_key_id and settings.r2_secret_access_key):
            raise RuntimeError("MEDIA_STORAGE=r2 nhưng thiếu R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.")
        self.bucket = settings.r2_bucket
        self.client = boto3.client(
            "s3", endpoint_url=f"https://{settings.r2_account_id}.r2.cloudflarestorage.com", region_name="auto",
            aws_access_key_id=settings.r2_access_key_id, aws_secret_access_key=settings.r2_secret_access_key,
            config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
        )

    def put_file(self, key: str, src: str) -> None:
        ctype = mimetypes.guess_type(key)[0] or "application/octet-stream"
        self.client.upload_file(src, self.bucket, key, ExtraArgs={"ContentType": ctype})
        os.unlink(src)

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)

    def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    @contextlib.contextmanager
    def local_path(self, key: str) -> Iterator[str]:
        fd, tmp = tempfile.mkstemp(suffix=Path(key).suffix)
        os.close(fd)
        try:
            self.client.download_file(self.bucket, key, tmp)
            yield tmp
        finally:
            Path(tmp).unlink(missing_ok=True)

    def response(self, key: str, request: Request, *, media_type: str, filename: str | None = None,
                 inline: bool = True, cache_control: str | None = None) -> Response:
        from botocore.exceptions import ClientError
        try:
            head = self.client.head_object(Bucket=self.bucket, Key=key)
        except ClientError:
            return Response(status_code=404)
        size = int(head["ContentLength"])
        headers = {"Accept-Ranges": "bytes", "Content-Disposition": _disposition(filename, inline)}
        if cache_control:
            headers["Cache-Control"] = cache_control
        rng = request.headers.get("range")
        start, end, status = 0, size - 1, 200
        if rng:
            m = _RANGE.match(rng.strip())
            if not m or (m.group(1) == "" and m.group(2) == ""):
                return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
            if m.group(1) == "":  # bytes=-N: N byte cuối
                start = max(0, size - int(m.group(2)))
            else:
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
            if start > end or start >= size:
                return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
            status = 206
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        obj = self.client.get_object(Bucket=self.bucket, Key=key, Range=f"bytes={start}-{end}")
        body = obj["Body"]
        headers["Content-Length"] = str(end - start + 1)

        def chunks() -> Iterator[bytes]:
            try:
                yield from body.iter_chunks(chunk_size=1024 * 1024)
            finally:
                body.close()

        return StreamingResponse(chunks(), status_code=status, media_type=media_type, headers=headers)


@lru_cache(maxsize=1)
def get_store() -> LocalStore | R2Store:
    if settings.media_storage.lower() == "r2":
        return R2Store()
    return LocalStore()
