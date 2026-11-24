"""File video bài giảng (tải lên, phát với Range) và file gốc tài liệu (PDF/PPTX cho trình xem slide)."""
import mimetypes

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.core.errors import AppError
from app.core.security import Principal, ensure_class_access, get_user_for_media, require_teacher
from app.core.utils import clean_id, generate_code, parse_uuid
from app.database import get_db
from app.models.documents import AIDocument
from app.models.learning import Lesson, LessonItem, MediaVideo
from app.models.observability import AIJob
from app.models.transcript import VideoTranscript
from app.models.video_question import VideoQuestion
from app.services.courses.course_admin import link_video_sources
from app.services.media.object_store import get_store
from app.services.media.storage import safe_extension, save_upload
from app.services.system import jobs
from app.services.system.jobs import job_to_dict

router = APIRouter(prefix="/ai", tags=["media"])
VIDEO_TYPES = ("mp4", "webm", "mov", "m4v", "mkv", "mp3", "m4a", "wav", "ogg")


def _target_lesson(db: Session, user: Principal, target_lesson_id: str | None) -> Lesson | None:
    if not target_lesson_id:
        return None
    lesson = (db.query(Lesson).filter(Lesson.id == parse_uuid(target_lesson_id, "target_lesson_id"))
              .with_for_update().first())
    from app.services.courses import learning
    if not lesson or not learning.can_see_course(db, user, lesson.chapter.course):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bài học để gắn video.")
    return lesson


def _attach_video(db: Session, video: MediaVideo, lesson: Lesson | None) -> None:
    if lesson is None:
        return
    exists = db.query(LessonItem.id).filter(LessonItem.lesson_id == lesson.id,
                                           LessonItem.video_id == video.video_id).first()
    if not exists:
        position = db.query(func.max(LessonItem.position)).filter(LessonItem.lesson_id == lesson.id).scalar()
        db.add(LessonItem(lesson_id=lesson.id, type="video", title=video.title or "Video bài giảng",
                          video_id=video.video_id, duration_seconds=video.duration_seconds,
                          position=(position if position is not None else -1) + 1))
    link_video_sources(db, video.video_id, lesson)


def _duration(path: str) -> float | None:
    try:
        from app.services.media.transcription import _ffmpeg_exe, _media_duration
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
def upload_video(video_id: str | None = Form(None), title: str | None = Form(None), file: UploadFile = File(...),
                 class_id: str | None = Form(None), lesson_id: str | None = Form(None),
                 target_lesson_id: str | None = Form(None),
                 transcribe: bool = Form(False), language: str = Form("vi"),
                 user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    video_id, class_id = clean_id(video_id) or generate_code("VD"), clean_id(class_id)
    lesson = _target_lesson(db, user, target_lesson_id)
    if lesson:
        class_id = lesson.chapter.course.class_id
        lesson_id = lesson.code
    ensure_class_access(user, class_id)
    v = db.get(MediaVideo, video_id)
    if v:
        ensure_class_access(user, v.class_id)
    ext = safe_extension(file.filename, VIDEO_TYPES)
    store = get_store()
    key, _, size = save_upload(file, "media", ext, settings.max_media_mb)
    if v is None:
        v = MediaVideo(video_id=video_id, created_by=user.user_id)
        db.add(v)
    elif v.file_path and store.exists(v.file_path) and v.file_path != key:
        store.delete(v.file_path)
    v.title = title or v.title or (file.filename or video_id)
    v.file_path, v.size_bytes, v.class_id = key, size, class_id or v.class_id
    v.mime = mimetypes.guess_type(f"x.{ext}")[0] or "video/mp4"
    with store.local_path(key) as local:
        v.duration_seconds = _duration(local)
    if lesson:
        v.class_id = class_id
    _attach_video(db, v, lesson)
    db.commit()
    out = _video_dict(db, v, video_id)
    if transcribe:
        job = jobs.submit(db, "transcribe_video", {"video_id": video_id, "file_path": key, "language": language,
                                                   "lesson_id": clean_id(lesson_id), "class_id": v.class_id,
                                                   "course_id": lesson.chapter.course.code if lesson else None,
                                                   "created_by": user.user_id, "delete_file": False},
                          created_by=user.user_id)
        out["job_id"] = str(job.id)
    return JSONResponse(status_code=201, content=out)


class VideoUrlIn(BaseModel):
    video_id: str | None = Field(default=None, max_length=128)
    title: str | None = None
    source_url: str = Field(pattern=r"^https?://")
    duration_seconds: float | None = None
    class_id: str | None = None
    target_lesson_id: str | None = None


@router.post("/media/videos/url")
def register_video_url(req: VideoUrlIn, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    """Video đặt ở nơi khác (link .mp4 trực tiếp)."""
    vid = clean_id(req.video_id) or generate_code("VD")
    lesson = _target_lesson(db, user, req.target_lesson_id)
    class_id = lesson.chapter.course.class_id if lesson else clean_id(req.class_id)
    ensure_class_access(user, class_id)
    v = db.get(MediaVideo, vid) or MediaVideo(video_id=vid, created_by=user.user_id)
    ensure_class_access(user, v.class_id)
    v.title, v.source_url, v.duration_seconds = req.title or v.title or vid, req.source_url, req.duration_seconds
    db.add(v)
    if lesson or class_id:
        v.class_id = class_id
    _attach_video(db, v, lesson)
    db.commit()
    return _video_dict(db, v, vid)


# Hàm phụ trợ để xóa file chạy ngầm
def _cleanup_r2_file(file_path: str):
    try:
        store = get_store()
        if store.exists(file_path):
            store.delete(file_path)
    except Exception as e:
        # Ghi log lỗi nếu R2 gặp sự cố (file rác không ảnh hưởng đến app)
        print(f"[CẢNH BÁO] Không thể xóa file trên R2: {file_path}. Chi tiết: {e}")
        

@router.post("/media/videos/inline-upload", status_code=201)
def inline_upload_video(
    file: UploadFile = File(...),
    title: str | None = Form(None),
    class_id: str | None = Form(None),
    user: Principal = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """API tải lên nhanh video trực tiếp từ modal cấu hình Mục học."""
    class_id = clean_id(class_id)
    ensure_class_access(user, class_id)
    
    # 1. Sinh mã video
    video_id = generate_code("VD")
    
    # 2. Kiểm tra định dạng file an toàn
    ext = safe_extension(file.filename, VIDEO_TYPES)
    store = get_store()
    
    # 3. Tiến hành đẩy file lên Cloudflare R2 (hoặc storage cấu hình)
    key, _, size = save_upload(file, "media", ext, settings.max_media_mb)
    
    # 4. Lưu bản ghi vào bảng MediaVideo
    v = MediaVideo(
        video_id=video_id,
        title=title or file.filename.rsplit('.', 1)[0] or video_id,
        file_path=key,
        size_bytes=size,
        class_id=class_id,
        mime=mimetypes.guess_type(f"x.{ext}")[0] or "video/mp4",
        created_by=user.user_id
    )
    
    # Đo thời lượng video nếu có ffmpeg hỗ trợ
    try:
        with store.local_path(key) as local:
            v.duration_seconds = _duration(local)
    except Exception:
        v.duration_seconds = None

    db.add(v)
    db.commit()
    db.refresh(v)
    
    return {
        "video_id": v.video_id,
        "title": v.title,
        "has_file": True,
        "duration_seconds": v.duration_seconds,
        "size_mb": round((v.size_bytes or 0) / 1048576, 1)
    }


@router.delete("/media/videos/{video_id}", status_code=200)
def delete_video(video_id: str, background_tasks: BackgroundTasks, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    """Xóa video an toàn: Commit DB thành công mới tiến hành xóa file vật lý."""
    
    # 1. Tìm video
    v = db.get(MediaVideo, video_id)
    if not v:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy video.")
        
    ensure_class_access(user, v.class_id)
    
    # Trích xuất file_path ra một biến độc lập trước khi xóa object `v`
    target_file_path = v.file_path
    
    try:
        # 2. Xóa các bản ghi liên quan trong DB (Sử dụng Try-Except để Rollback)
        db.query(LessonItem).filter(LessonItem.video_id == video_id).delete()
        db.query(VideoTranscript).filter(VideoTranscript.video_id == video_id).delete()
        db.query(VideoQuestion).filter(VideoQuestion.video_id == video_id).delete()
        db.query(AIDocument).filter(AIDocument.source_type == "video", AIDocument.source_id == video_id).delete()
        db.query(AIJob).filter(AIJob.job_type == "transcribe_video", AIJob.payload["video_id"].astext == video_id).delete()

        # 3. Xóa bản ghi Video chính
        db.delete(v)
        
        # 4. CHỐT GIAO DỊCH DATABASE
        db.commit()
        
    except Exception as e:
        # NẾU CÓ BẤT KỲ LỖI NÀO LÚC XÓA DB -> ĐẢO NGƯỢC TOÀN BỘ
        db.rollback()
        raise AppError(500, "DB_DELETE_ERROR", f"Không thể xóa dữ liệu: {str(e)}")

    # 5. CHỈ XÓA FILE TRÊN R2 KHI DATABASE ĐÃ COMMIT THÀNH CÔNG CHẮC CHẮN 100%
    if target_file_path:
        # Đẩy tiến trình xóa file ra chạy nền. 
        # API sẽ lập tức trả về 200 OK cho Frontend mà không cần chờ R2 xóa xong.
        background_tasks.add_task(_cleanup_r2_file, target_file_path)
    
    return {"message": "Đã xóa video thành công."}


@router.post("/media/videos/{video_id}/transcribe", status_code=202)
def transcribe_stored(video_id: str, language: str = "vi", user: Principal = Depends(require_teacher),
                      db: Session = Depends(get_db)):
    v = db.get(MediaVideo, video_id)
    if not v or not v.file_path or not get_store().exists(v.file_path):
        raise AppError(404, "NO_FILE", "Video chưa có file trên server.")
    ensure_class_access(user, v.class_id)
    linked = (db.query(LessonItem).filter(LessonItem.video_id == video_id, LessonItem.type == "video")
              .order_by(LessonItem.created_at, LessonItem.id).first())
    lesson = linked.lesson if linked else None
    job = jobs.submit(db, "transcribe_video", {"video_id": video_id, "file_path": v.file_path, "language": language,
                                               "class_id": v.class_id, "created_by": user.user_id,
                                               "lesson_id": lesson.code if lesson else None,
                                               "course_id": lesson.chapter.course.code if lesson else None,
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
def stream_video(video_id: str, request: Request, user: Principal = Depends(get_user_for_media),
                 db: Session = Depends(get_db)):
    v = db.get(MediaVideo, video_id)
    store = get_store()
    if not v or not v.file_path or not store.exists(v.file_path) or not user.can_access_class(v.class_id):
        raise AppError(404, "NOT_FOUND", "Không có file video.")
    return store.response(v.file_path, request, media_type=v.mime or "video/mp4")


@router.post("/media/parse-markdown")
async def parse_markdown_file(
    file: UploadFile = File(...),
    user: Principal = Depends(require_teacher)
):
    """API đọc file .md từ máy tính và trả về nội dung dạng text cho Frontend."""
    
    # 1. Kiểm tra đuôi file
    if not file.filename.lower().endswith(".md"):
        raise AppError(400, "INVALID_FILE", "Chỉ hỗ trợ tải lên file định dạng Markdown (.md).")
    
    try:
        # 2. Đọc nội dung file vào bộ nhớ
        content = await file.read()
        
        # 3. Giải mã định dạng chuẩn UTF-8 (hỗ trợ tiếng Việt)
        text = content.decode("utf-8")
        
        # Trả về nguyên văn nội dung
        return {"content_md": text}
        
    except UnicodeDecodeError:
        raise AppError(400, "INVALID_ENCODING", "File không đúng chuẩn mã hóa UTF-8. Vui lòng kiểm tra lại file.")
    except Exception as e:
        raise AppError(500, "PARSE_ERROR", f"Không thể đọc file: {str(e)}")


@router.get("/documents/{document_id}/file")
def document_file(document_id: str, request: Request, user: Principal = Depends(get_user_for_media),
                  db: Session = Depends(get_db)):
    doc = db.get(AIDocument, parse_uuid(document_id, "document_id"))
    store = get_store()
    if not doc or not doc.file_path or not store.exists(doc.file_path) or not user.can_access_class(doc.class_id):
        raise AppError(404, "NOT_FOUND", "Không có file gốc của tài liệu.")
    media = {"pdf": "application/pdf",
             "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
             "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}.get(doc.source_type,
                                                                                                    "application/octet-stream")
    return store.response(doc.file_path, request, media_type=media, filename=doc.title, inline=True)


@router.get("/documents/{document_id}/slides")
def document_slides(document_id: str, user: Principal = Depends(get_user_for_media), db: Session = Depends(get_db)):
    """Nội dung chữ theo từng trang/slide (để hiển thị PPTX và làm ngữ cảnh cho Tutor)."""
    doc = db.get(AIDocument, parse_uuid(document_id, "document_id"))
    if not doc or not doc.file_path or not user.can_access_class(doc.class_id):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy tài liệu.")
    from app.services.rag.parsers import extract_pdf, extract_pptx
    if doc.source_type not in ("pptx", "pdf"):
        raise AppError(400, "NOT_SLIDES", "Chỉ hỗ trợ PDF / PPTX.")
    with get_store().local_path(doc.file_path) as local:
        pages = extract_pptx(local) if doc.source_type == "pptx" else extract_pdf(local)
    return {"document_id": str(doc.id), "source_type": doc.source_type, "title": doc.title,
            "slides": [{"page": p.get("page"), "title": p.get("section"), "text": p["text"]} for p in pages]}
