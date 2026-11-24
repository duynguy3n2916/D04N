"""Hàng đợi job nền chạy trong tiến trình (ThreadPoolExecutor), trạng thái lưu ở bảng ai_jobs.

Đủ cho demo / triển khai một máy (kể cả Windows) mà không cần worker riêng.
Khi cần mở rộng có thể thay `submit` bằng Celery/RQ mà không đổi API.
"""
import contextvars
import logging
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from sqlalchemy import event
from sqlalchemy.orm import Session

from app.config import settings
from app.core.context import get_request_id, set_request_id
from app.core.utils import utcnow
from app.database import SessionLocal
from app.models.observability import AIJob

log = logging.getLogger("app.jobs")
_executor: ThreadPoolExecutor | None = None
_registry: dict[str, Callable] = {}
_inline = False  # True trong test: chạy đồng bộ


def register(job_type: str):
    def deco(fn: Callable):
        _registry[job_type] = fn
        return fn
    return deco


def set_inline(value: bool) -> None:
    global _inline
    _inline = value


def _get_executor() -> ThreadPoolExecutor:
    global _executor
    if _executor is None:
        _executor = ThreadPoolExecutor(max_workers=max(1, settings.job_workers), thread_name_prefix="job")
    return _executor


def shutdown() -> None:
    global _executor
    if _executor is not None:
        _executor.shutdown(wait=False, cancel_futures=True)
        _executor = None


class JobContext:
    def __init__(self, db: Session, job: AIJob):
        self.db = db
        self.job = job

    def progress(self, value: float, message: str | None = None) -> None:
        self.job.progress = round(max(0.0, min(1.0, value)), 3)
        if message:
            self.job.message = message
        self.db.commit()


def submit_after_commit(db: Session, job_type: str, payload: dict, created_by: str | None = None) -> None:
    """Xếp job để gửi ngay SAU khi transaction hiện tại commit (job đọc được dữ liệu vừa ghi, không phá khóa dòng)."""
    if job_type not in _registry:
        raise ValueError(f"Job type chưa đăng ký: {job_type}")
    db.info.setdefault("_after_commit_jobs", []).append((job_type, payload, created_by))


@event.listens_for(Session, "after_commit")
def _flush_after_commit_jobs(session: Session) -> None:
    pending = session.info.pop("_after_commit_jobs", None)
    for job_type, payload, created_by in pending or []:
        other = SessionLocal()
        try:
            submit(other, job_type, payload, created_by)
        except Exception:
            log.exception("submit_after_commit_failed", extra={"extra_fields": {"job_type": job_type}})
        finally:
            other.close()


@event.listens_for(Session, "after_rollback")
def _drop_after_rollback(session: Session) -> None:
    session.info.pop("_after_commit_jobs", None)


def submit(db: Session, job_type: str, payload: dict, created_by: str | None = None) -> AIJob:
    if job_type not in _registry:
        raise ValueError(f"Job type chưa đăng ký: {job_type}")
    job = AIJob(job_type=job_type, status="queued", payload=payload, created_by=created_by,
                correlation_id=get_request_id(), progress=0.0)
    db.add(job)
    db.commit()
    db.refresh(job)
    job_id = job.id
    if _inline:
        _run(job_id)
        db.refresh(job)
    else:
        ctx = contextvars.copy_context()
        _get_executor().submit(ctx.run, _run, job_id)
    return job


def _run(job_id: uuid.UUID) -> None:
    db = SessionLocal()
    try:
        job = db.get(AIJob, job_id)
        if job is None:
            return
        set_request_id(job.correlation_id or f"job_{job_id.hex[:12]}")
        job.status, job.started_at = "running", utcnow()
        db.commit()
        fn = _registry[job.job_type]
        result = fn(JobContext(db, job), **(job.payload or {}))
        job = db.get(AIJob, job_id)
        job.status, job.result, job.progress, job.finished_at = "succeeded", result, 1.0, utcnow()
        db.commit()
    except Exception as e:
        db.rollback()
        log.exception("job_failed", extra={"extra_fields": {"job_id": str(job_id)}})
        job = db.get(AIJob, job_id)
        if job is not None:
            detail = getattr(e, "detail", None) or str(e)
            job.status, job.error, job.finished_at = "failed", f"{detail}"[:4000], utcnow()
            job.message = traceback.format_exception_only(type(e), e)[-1][:500]
            db.commit()
    finally:
        db.close()


def recover_interrupted() -> int:
    """Gọi khi khởi động: job đang chạy dở do tắt server được đánh dấu failed."""
    db = SessionLocal()
    try:
        n = db.query(AIJob).filter(AIJob.status.in_(["queued", "running"])).update(
            {"status": "failed", "error": "Server khởi động lại khi job đang chạy. Hãy chạy lại.", "finished_at": utcnow()},
            synchronize_session=False)
        db.commit()
        return n
    finally:
        db.close()


def job_to_dict(job: AIJob) -> dict:
    return {
        "job_id": str(job.id),
        "job_type": job.job_type,
        "status": job.status,
        "progress": job.progress,
        "message": job.message,
        "result": job.result,
        "error": job.error,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }
