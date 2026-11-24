import asyncio
import logging
import mimetypes
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app.config import settings
from app.core.context import setup_logging
from app.core.errors import RequestContextMiddleware, install_error_handlers
from app.database import SessionLocal, engine
from app.routers import (
    admin,
    auth,
    chat,
    coach,
    documents,
    evaluation,
    forum,
    learn,
    media,
    messages,
    teacher,
    users,
    videos,
    workflow,
)
from app.routers import jobs as jobs_router
from app.services.ai import evaluation as _ev  # noqa: F401 (đăng ký job)
from app.services.ai import tutor_explain as _te  # noqa: F401 (đăng ký job tutor_explain)
from app.services.courses.workflow import sweep_expired
from app.services.media import transcription as _tr  # noqa: F401 (đăng ký job)
from app.services.rag import ingestion as _ing  # noqa: F401 (đăng ký job)
from app.services.system import jobs  # noqa: F401 (đăng ký job)
from app.services.system.retention import purge_expired

# Windows lấy kiểu file từ registry: .mjs (pdf.js worker) hay .js có thể bị trả về text/plain,
# trình duyệt sẽ từ chối nạp như JavaScript module. Khai báo cố định để chạy giống nhau trên mọi máy.
for _ext, _type in ((".js", "text/javascript"), (".mjs", "text/javascript"), (".css", "text/css"),
                    (".wasm", "application/wasm"), (".svg", "image/svg+xml"), (".json", "application/json")):
    mimetypes.add_type(_type, _ext)

log = logging.getLogger("app")


class FrontendFiles(StaticFiles):
    """Phục vụ frontend/dist. index.html luôn hỏi lại server (không bao giờ hiện bản cũ sau khi build/pull);
    file trong assets/ có mã băm trong tên nên cho trình duyệt cache lâu."""

    def file_response(self, full_path, *args, **kwargs):
        resp = super().file_response(full_path, *args, **kwargs)
        hashed = Path(full_path).parent.name == "assets"
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable" if hashed else "no-cache"
        return resp

RETENTION_INTERVAL_SECONDS = 6 * 3600  # dọn dữ liệu quá hạn lưu mỗi 6 giờ
FRONTEND_DIST = Path(os.environ.get("FRONTEND_DIST", Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"))


async def _sweeper(stop: asyncio.Event) -> None:
    """Quét định kỳ các phiên quá hạn trả lời / trạng thái kẹt."""
    def run_once():
        db = SessionLocal()
        try:
            return sweep_expired(db)
        finally:
            db.close()

    def purge_once():
        db = SessionLocal()
        try:
            return purge_expired(db)
        finally:
            db.close()

    last_purge = 0.0
    while not stop.is_set():
        try:
            await asyncio.to_thread(run_once)
        except Exception:
            log.exception("sweeper_error")
        if time.monotonic() - last_purge >= RETENTION_INTERVAL_SECONDS:
            last_purge = time.monotonic()
            try:
                await asyncio.to_thread(purge_once)
            except Exception:
                log.exception("retention_error")
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.timeout_sweep_interval_seconds)
        except asyncio.TimeoutError:
            pass


@asynccontextmanager
async def lifespan(_: FastAPI):
    setup_logging()
    from app.migrate import migrate_if_needed
    report = migrate_if_needed()
    if report.get("added_columns") or report.get("changed_types"):
        log.info("schema_migrated", extra={"extra_fields": report})
    if report.get("warning"):
        log.warning(report["warning"])
    n = jobs.recover_interrupted()
    if n:
        log.warning(f"{n} job bị gián đoạn do khởi động lại đã được đánh dấu failed")
    if settings.jwt_secret in ("dev-secret-change-me", "doi-chuoi-nay-thanh-mot-chuoi-ngau-nhien-dai") or len(settings.jwt_secret) < 32:
        log.warning("JWT_SECRET đang là giá trị mặc định hoặc quá ngắn — ai biết chuỗi này có thể giả token. "
                    "Đặt chuỗi ngẫu nhiên >= 32 ký tự trong .env.")
    if settings.allow_test_login:
        log.warning("ALLOW_TEST_LOGIN=true: ai cũng đăng nhập được không cần mật khẩu. Chỉ dùng cho kiểm thử.")
    from app.services.rag.embedding import warmup
    threading.Thread(target=warmup, daemon=True, name="embedding-warmup").start()
    stop = asyncio.Event()
    task = asyncio.create_task(_sweeper(stop))
    yield
    stop.set()
    await task
    jobs.shutdown()


app = FastAPI(title="AI Learning Support", version="1.0.0", lifespan=lifespan)

app.add_middleware(RequestContextMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID"],
)
install_error_handlers(app)

for r in (auth, users, documents, chat, teacher, videos, workflow, evaluation, jobs_router, admin, learn, media, forum, messages, coach):
    app.include_router(r.router)


@app.get("/health")
def health():
    db_ok = True
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        db_ok = False
    return {"status": "ok" if db_ok else "degraded", "database": db_ok, "llm_provider": settings.llm_provider,
            "llm_model": settings.current_llm_model(), "embedding_provider": settings.embedding_provider,
            "test_login": settings.allow_test_login}


if FRONTEND_DIST.joinpath("index.html").exists():
    @app.get("/app/pdf.worker.min.mjs", include_in_schema=False)
    def pdf_worker():
        """Worker của pdf.js (trình xem slide): luôn trả đúng kiểu JavaScript, kể cả trên Windows."""
        return FileResponse(FRONTEND_DIST / "pdf.worker.min.mjs", media_type="text/javascript",
                            headers={"Cache-Control": "no-cache"})

    app.mount("/app", FrontendFiles(directory=FRONTEND_DIST, html=True), name="frontend")


@app.get("/", include_in_schema=False)
def root():
    if FRONTEND_DIST.joinpath("index.html").exists():
        return RedirectResponse("/app/")
    return {"message": "AI Learning Support API", "docs": "/docs",
            "frontend": "Chưa có frontend/dist. Chạy: cd frontend && npm install && npm run build"}
