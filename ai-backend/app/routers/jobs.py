from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import Principal, require_teacher
from app.core.utils import parse_uuid
from app.database import get_db
from app.models.observability import AIJob
from app.services.jobs import job_to_dict

router = APIRouter(prefix="/ai/jobs", tags=["jobs"])


@router.get("/{job_id}")
def get_job(job_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    job = db.get(AIJob, parse_uuid(job_id, "job_id"))
    if not job or (job.created_by != user.user_id and not user.is_admin):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy job.")
    return job_to_dict(job)


@router.get("")
def list_jobs(user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    q = db.query(AIJob)
    if not user.is_admin:
        q = q.filter(AIJob.created_by == user.user_id)
    return [job_to_dict(j) for j in q.order_by(AIJob.created_at.desc()).limit(30).all()]
