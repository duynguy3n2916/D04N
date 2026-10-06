"""File video bài giảng (tải lên, phát với Range) và file gốc tài liệu (PDF/PPTX cho trình xem slide)."""
import mimetypes
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.core.errors import AppError
from app.core.security import Principal, ensure_class_access, get_user_for_media, require_teacher
from app.core.utils import clean_id, parse_uuid
from app.database import get_db
from app.models.documents import AIDocument
from app.models.learning import MediaVideo
from app.models.observability import AIJob
from app.models.transcript import VideoTranscript
from app.models.video_question import VideoQuestion
from app.services import jobs
from app.services.jobs import job_to_dict
from app.services.storage import safe_extension, save_upload

router = APIRouter(prefix="/ai", tags=["media"])
VIDEO_TYPES = ("mp4", "webm", "mov", "m4v", "mkv", "mp3", "m4a", "wav", "ogg")


def _duration(path: str) -> float | None:
    try:
        from app.services.transcription import _ffmpeg_exe, _media_duration
        exe = _ffmpeg_exe()
        return _media_duration(exe, path) if exe else None
    except Exception:
        return None


def _video_dict(db: Session, v: MediaVideo | None, video_id: str) -> dict:
    tr = (db.query(VideoTranscript).filter(VideoTranscript.video_id == video_id, VideoTranscript.is_active.is_not(False))
          .first())
    counts = dict(db.query(VideoQuestion.status, func.count()).filter(VideoQuestion.video_id == video_id,
                                                                     VideoQuestion.origin != "agent")
                  .group_by(VideoQuestion.status).all())
    return {"video_id": video_id, "title": (v.title if v else None) or video_id,
            "has_file": bool(v and v.file_path), "source_url": v.source_url if v else None,
            "duration_seconds": v.duration_seconds if v else None, "size_mb": round((v.size_bytes or 0) / 1048576, 1) if v else None,
            "class_id": v.class_id if v else None,
            "transcript": {"version": tr.version, "source": tr.source} if tr else None,
            "questions": {"approved": counts.get("approved", 0), "draft": counts.get("draft", 0)},
            "created_at": v.created_at.isoformat() if v and v.created_at else None}


@router.get("/media/videos")
def list_videos(user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    vids = {v.video_id: v for v in db.query(MediaVideo).all() if user.can_access_class(v.class_id)}
    for (vid,) in db.query(VideoTranscript.video_id).distinct().all():
        vids.setdefault(vid, None)
    return [_video_dict(db, v, vid) for vid, v in sorted(vids.items())]


@router.post("/media/videos", status_code=201)
def upload_video(video_id: str = Form(...), title: str | None = Form(None), file: UploadFile = File(...),
                 class_id: str | None = Form(None), lesson_id: str | None = Form(None),
                 transcribe: bool = Form(False), language: str = Form("vi"),
                 user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    video_id, class_id = clean_id(video_id), clean_id(class_id)
    if not video_id:
        raise AppError(400, "INVALID_VIDEO_ID", "Thiếu video_id.")
    ensure_class_access(user, class_id)
    ext = safe_extension(file.filename, VIDEO_TYPES)
    path, _, size = save_upload(file, "media", ext, settings.max_media_mb)
    v = db.get(MediaVideo, video_id)
    if v is None:
        v = MediaVideo(video_id=video_id, created_by=user.user_id)
        db.add(v)
    elif v.file_path and Path(v.file_path).exists() and v.file_path != str(path):
        Path(v.file_path).unlink(missing_ok=True)
    v.title = title or v.title or (file.filename or video_id)
    v.file_path, v.size_bytes, v.class_id = str(path), size, class_id or v.class_id
    v.mime = mimetypes.guess_type(f"x.{ext}")[0] or "video/mp4"
    v.duration_seconds = _duration(str(path))
    db.commit()
    out = _video_dict(db, v, video_id)
    if transcribe:
        job = jobs.submit(db, "transcribe_video", {"video_id": video_id, "file_path": str(path), "language": language,
                                                   "lesson_id": clean_id(lesson_id), "class_id": class_id,
                                                   "created_by": user.user_id, "delete_file": False},
                          created_by=user.user_id)
        out["job_id"] = str(job.id)
    return JSONResponse(status_code=201, content=out)


class VideoUrlIn(BaseModel):
    video_id: str = Field(min_length=1, max_length=128)
    title: str | None = None
    source_url: str = Field(pattern=r"^https?://")
    duration_seconds: float | None = None


@router.post("/media/videos/url")
def register_video_url(req: VideoUrlIn, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    """Video đặt ở nơi khác (link .mp4 trực tiếp)."""
    vid = clean_id(req.video_id)
    v = db.get(MediaVideo, vid) or MediaVideo(video_id=vid, created_by=user.user_id)
    v.title, v.source_url, v.duration_seconds = req.title or v.title or vid, req.source_url, req.duration_seconds
    db.add(v)
    db.commit()
    return _video_dict(db, v, vid)


@router.post("/media/videos/{video_id}/transcribe", status_code=202)
def transcribe_stored(video_id: str, language: str = "vi", user: Principal = Depends(require_teacher),
                      db: Session = Depends(get_db)):
    v = db.get(MediaVideo, video_id)
    if not v or not v.file_path or not Path(v.file_path).exists():
        raise AppError(404, "NO_FILE", "Video chưa có file trên server.")
    job = jobs.submit(db, "transcribe_video", {"video_id": video_id, "file_path": v.file_path, "language": language,
                                               "class_id": v.class_id, "created_by": user.user_id,
                                               "delete_file": False}, created_by=user.user_id)
    return JSONResponse(status_code=202, content=jobs.job_to_dict(job))


@router.get("/media/videos/{video_id}/transcription-job")
def latest_transcription_job(video_id: str, user: Principal = Depends(require_teacher),
                             db: Session = Depends(get_db)):
    v = db.get(MediaVideo, video_id)
    if not v or not user.can_access_class(v.class_id):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy video.")
    q = db.query(AIJob).filter(AIJob.job_type == "transcribe_video",
                               AIJob.payload["video_id"].astext == video_id)
    if not user.is_admin:
        q = q.filter(AIJob.created_by == user.user_id)
    job = q.order_by(AIJob.created_at.desc(), AIJob.id.desc()).first()
    return job_to_dict(job) if job else None


@router.get("/media/videos/{video_id}/file")
def stream_video(video_id: str, user: Principal = Depends(get_user_for_media), db: Session = Depends(get_db)):
    v = db.get(MediaVideo, video_id)
    if not v or not v.file_path or not Path(v.file_path).exists() or not user.can_access_class(v.class_id):
        raise AppError(404, "NOT_FOUND", "Không có file video.")
    return FileResponse(v.file_path, media_type=v.mime or "video/mp4")


@router.get("/documents/{document_id}/file")
def document_file(document_id: str, user: Principal = Depends(get_user_for_media), db: Session = Depends(get_db)):
    doc = db.get(AIDocument, parse_uuid(document_id, "document_id"))
    if not doc or not doc.file_path or not Path(doc.file_path).exists() or not user.can_access_class(doc.class_id):
        raise AppError(404, "NOT_FOUND", "Không có file gốc của tài liệu.")
    media = {"pdf": "application/pdf",
             "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
             "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}.get(doc.source_type,
                                                                                                    "application/octet-stream")
    return FileResponse(doc.file_path, media_type=media, filename=doc.title, content_disposition_type="inline")


@router.get("/documents/{document_id}/slides")
def document_slides(document_id: str, user: Principal = Depends(get_user_for_media), db: Session = Depends(get_db)):
    """Nội dung chữ theo từng trang/slide (để hiển thị PPTX và làm ngữ cảnh cho Tutor)."""
    doc = db.get(AIDocument, parse_uuid(document_id, "document_id"))
    if not doc or not doc.file_path or not user.can_access_class(doc.class_id):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy tài liệu.")
    from app.services.parsers import extract_pdf, extract_pptx
    if doc.source_type == "pptx":
        pages = extract_pptx(doc.file_path)
    elif doc.source_type == "pdf":
        pages = extract_pdf(doc.file_path)
    else:
        raise AppError(400, "NOT_SLIDES", "Chỉ hỗ trợ PDF / PPTX.")
    return {"document_id": str(doc.id), "source_type": doc.source_type, "title": doc.title,
            "slides": [{"page": p.get("page"), "title": p.get("section"), "text": p["text"]} for p in pages]}
