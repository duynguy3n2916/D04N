from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import settings
from app.core.errors import AppError
from app.core.llm_schemas import Difficulty, QuestionType
from app.core.security import Principal, ensure_class_access, get_current_user, require_teacher
from app.core.utils import clean_id, parse_uuid
from app.database import get_db
from app.models.transcript import TranscriptSegment, VideoTranscript
from app.models.learning import MediaVideo
from app.services import jobs, video_learning, workflow
from app.services.retrieval import active_transcript
from app.services.storage import safe_extension, save_upload
from app.services.transcription import parse_transcript_content, save_transcript_version, transcript_to_dict

router = APIRouter(prefix="/ai", tags=["videos"])

MEDIA_TYPES = ("mp4", "mp3", "m4a", "wav", "webm", "mkv", "mov", "ogg", "flac", "mpeg", "mpga")


def _video_id(v: str) -> str:
    vid = clean_id(v)
    if not vid:
        raise AppError(400, "INVALID_VIDEO_ID", "Thiếu video_id.")
    return vid


def _check_transcript_access(user: Principal, tr: VideoTranscript | None) -> None:
    if tr is not None and not user.can_access_class(tr.class_id):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy video.")


def _check_media_access(db: Session, user: Principal, video_id: str) -> None:
    media = db.get(MediaVideo, video_id)
    if media:
        ensure_class_access(user, media.class_id)


# ----------------------------------------------------------------------------
# Transcript
# ----------------------------------------------------------------------------

@router.post("/videos/import-transcript")
async def import_transcript(
    video_id: str = Form(...), file: UploadFile = File(...), lesson_id: str | None = Form(None),
    course_id: str | None = Form(None), class_id: str | None = Form(None), language: str = Form("vi"),
    user: Principal = Depends(require_teacher), db: Session = Depends(get_db),
):
    """Nạp phụ đề .srt / .vtt / .json -> tạo phiên bản transcript mới + index Knowledge Base."""
    video_id, class_id = _video_id(video_id), clean_id(class_id)
    _check_media_access(db, user, video_id)
    ensure_class_access(user, class_id)
    safe_extension(file.filename, ("srt", "vtt", "json", "txt"))
    raw = await file.read()
    if len(raw) > settings.max_document_mb * 1024 * 1024:
        raise AppError(413, "FILE_TOO_LARGE", "File phụ đề quá lớn.")
    text = None
    for enc in ("utf-8-sig", "utf-16", "cp1258", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    try:
        segments = parse_transcript_content(text or "", filename=file.filename or "")
    except ValueError as e:
        raise AppError(400, "INVALID_TRANSCRIPT", f"Không đọc được file phụ đề: {e}")
    if not segments:
        raise AppError(400, "INVALID_TRANSCRIPT", "Không tìm thấy đoạn phụ đề nào. Hỗ trợ .srt, .vtt, .json.")
    tr, kb = save_transcript_version(db, video_id, segments, source="import", language=language,
                                     model_version="imported_subtitle", created_by=user.user_id,
                                     lesson_id=clean_id(lesson_id), course_id=clean_id(course_id), class_id=class_id)
    return {"video_id": video_id, "transcript_id": str(tr.id), "version": tr.version, "total_segments": len(segments),
            "status": tr.status, "knowledge_base": kb,
            "message": "Đã nạp phụ đề." + ("" if kb["status"] == "ready" else " (Index Knowledge Base lỗi, xem knowledge_base.error)")}


@router.post("/videos/transcribe", status_code=202)
def transcribe_video(
    video_id: str = Form(...), file: UploadFile = File(...), lesson_id: str | None = Form(None),
    course_id: str | None = Form(None), class_id: str | None = Form(None), language: str = Form("vi"),
    user: Principal = Depends(require_teacher), db: Session = Depends(get_db),
):
    """Phiên âm video/audio bằng Whisper (chạy nền). Theo dõi tiến độ qua /ai/jobs/{job_id}."""
    video_id, class_id = _video_id(video_id), clean_id(class_id)
    _check_media_access(db, user, video_id)
    ensure_class_access(user, class_id)
    ext = safe_extension(file.filename, MEDIA_TYPES)
    path, _, size = save_upload(file, "media", ext, settings.max_media_mb)
    job = jobs.submit(db, "transcribe_video", {
        "video_id": video_id, "file_path": str(path), "language": language, "lesson_id": clean_id(lesson_id),
        "course_id": clean_id(course_id), "class_id": class_id, "created_by": user.user_id}, created_by=user.user_id)
    return JSONResponse(status_code=202, content={"video_id": video_id, "job_id": str(job.id), "status": job.status,
                                                  "size_mb": round(size / 1048576, 1)})


@router.get("/videos/{video_id}/transcript")
def get_video_transcript(video_id: str, version: int | None = None, user: Principal = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    if version is not None:
        tr = db.query(VideoTranscript).filter(VideoTranscript.video_id == video_id,
                                              VideoTranscript.version == version).first()
    else:
        tr = active_transcript(db, video_id)
    if not tr:
        raise AppError(404, "NO_TRANSCRIPT", f"Chưa có transcript cho video {video_id}.")
    _check_transcript_access(user, tr)
    segs = (db.query(TranscriptSegment).filter(TranscriptSegment.transcript_id == tr.id)
            .order_by(TranscriptSegment.start_time).all())
    return transcript_to_dict(tr, segs)


@router.get("/videos/{video_id}/transcript/versions")
def list_transcript_versions(video_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    rows = (db.query(VideoTranscript).filter(VideoTranscript.video_id == video_id)
            .order_by(VideoTranscript.version.desc()).all())
    return [{"transcript_id": str(r.id), "version": r.version, "is_active": r.is_active is not False,
             "source": r.source, "model_version": r.model_version, "created_by": r.created_by,
             "created_at": r.created_at.isoformat() if r.created_at else None} for r in rows]


class Segment(BaseModel):
    start_time: float = Field(ge=0)
    end_time: float = Field(ge=0)
    text: str


class UpdateTranscriptRequest(BaseModel):
    segments: list[Segment] = Field(min_length=1)
    language: str = "vi"


@router.put("/videos/{video_id}/transcript")
def update_video_transcript(video_id: str, req: UpdateTranscriptRequest, user: Principal = Depends(require_teacher),
                            db: Session = Depends(get_db)):
    """Giáo viên sửa transcript -> tạo phiên bản mới (bản cũ được giữ lại để rollback)."""
    _check_media_access(db, user, video_id)
    prev = active_transcript(db, video_id)
    _check_transcript_access(user, prev)
    tr, kb = save_transcript_version(db, video_id, [s.model_dump() for s in req.segments], source="manual",
                                     language=req.language, model_version="manual_edited", created_by=user.user_id)
    return {"video_id": video_id, "transcript_id": str(tr.id), "version": tr.version,
            "total_segments": len(req.segments), "knowledge_base": kb, "message": "Đã lưu phiên bản transcript mới."}


@router.post("/videos/{video_id}/transcript/rollback/{version}")
def rollback_transcript(video_id: str, version: int, user: Principal = Depends(require_teacher),
                        db: Session = Depends(get_db)):
    old = db.query(VideoTranscript).filter(VideoTranscript.video_id == video_id, VideoTranscript.version == version).first()
    if not old:
        raise AppError(404, "NOT_FOUND", "Không có phiên bản này.")
    _check_transcript_access(user, old)
    segs = [{"start_time": s.start_time, "end_time": s.end_time, "text": s.text} for s in old.segments]
    tr, kb = save_transcript_version(db, video_id, segs, source="manual", language=old.language,
                                     model_version=f"rollback_v{version}", created_by=user.user_id)
    return {"video_id": video_id, "transcript_id": str(tr.id), "version": tr.version, "knowledge_base": kb}


# ----------------------------------------------------------------------------
# Câu hỏi video (giáo viên)
# ----------------------------------------------------------------------------

class SuggestTimestampsRequest(BaseModel):
    max_suggestions: int = Field(default=3, ge=1, le=10)
    min_interval_seconds: float = Field(default=120.0, ge=0)
    save_drafts: bool = True
    language: str = "vi"


@router.post("/videos/{video_id}/suggest-timestamps")
def suggest_timestamps(video_id: str, req: SuggestTimestampsRequest | None = None,
                       user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    req = req or SuggestTimestampsRequest()
    _check_transcript_access(user, active_transcript(db, video_id))
    return video_learning.suggest_timestamps(db, user, video_id, max_suggestions=req.max_suggestions,
                                             min_interval_seconds=req.min_interval_seconds,
                                             save_drafts=req.save_drafts, language=req.language)


class GenerateVideoQuestionRequest(BaseModel):
    timestamp: float = Field(..., ge=0)
    window_seconds: float = Field(default=90.0, ge=10, le=600)
    type: QuestionType = "multiple_choice"
    difficulty: Difficulty = "medium"
    lesson_id: str | None = None
    use_lesson_context: bool = True
    language: str = "vi"


@router.post("/videos/{video_id}/generate-question")
def generate_question_at_timestamp(video_id: str, req: GenerateVideoQuestionRequest,
                                   user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    """Cách 1: GV chọn mốc -> AI sinh câu hỏi nháp (status=draft) để GV sửa / duyệt."""
    _check_transcript_access(user, active_transcript(db, video_id))
    return video_learning.generate_at_timestamp(
        db, user, video_id, timestamp=req.timestamp, window_seconds=req.window_seconds, qtype=req.type,
        difficulty=req.difficulty, lesson_id=clean_id(req.lesson_id), use_lesson_context=req.use_lesson_context,
        language=req.language)


class SaveVideoQuestionRequest(BaseModel):
    timestamp: float = Field(ge=0)
    question: str
    type: QuestionType = "multiple_choice"
    difficulty: Difficulty = "medium"
    answer: str | None = None
    correct_answer: str | None = None
    correct_index: int | None = None
    explanation: str | None = ""
    options: list[str] | None = None
    sources: list[str] | None = None
    status: str = "approved"


@router.post("/videos/{video_id}/questions")
def save_video_question(video_id: str, req: SaveVideoQuestionRequest, user: Principal = Depends(require_teacher),
                        db: Session = Depends(get_db)):
    """GV tự soạn câu hỏi cho video (mặc định approved vì chính GV soạn)."""
    data = req.model_dump()
    status = data.pop("status")
    return video_learning.save_question(db, user, _video_id(video_id), data, status=status)


@router.get("/videos/{video_id}/questions")
def get_video_questions_for_player(video_id: str, user: Principal = Depends(get_current_user),
                                   db: Session = Depends(get_db)):
    """Danh sách câu hỏi đã duyệt cho player (không có đáp án)."""
    _check_transcript_access(user, active_transcript(db, video_id))
    return video_learning.list_questions(db, video_id, manage=False)


@router.get("/videos/{video_id}/questions/manage")
def manage_video_questions(video_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    """Toàn bộ câu hỏi (nháp + đã duyệt + từ chối) kèm đáp án, cho màn hình giáo viên."""
    return video_learning.list_questions(db, video_id, manage=True)


class UpdateVideoQuestionRequest(BaseModel):
    timestamp: float | None = Field(default=None, ge=0)
    question: str | None = None
    type: QuestionType | None = None
    difficulty: Difficulty | None = None
    options: list[str] | None = None
    correct_answer: str | None = None
    correct_index: int | None = None
    explanation: str | None = None
    status: str | None = None


@router.patch("/video-questions/{question_id}")
def update_video_question(question_id: str, req: UpdateVideoQuestionRequest, user: Principal = Depends(require_teacher),
                          db: Session = Depends(get_db)):
    return video_learning.update_question(db, user, parse_uuid(question_id, "question_id"), req.model_dump())


@router.delete("/video-questions/{question_id}")
def archive_video_question(question_id: str, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    return video_learning.update_question(db, user, parse_uuid(question_id, "question_id"), {"status": "archived"})


# ----------------------------------------------------------------------------
# Học sinh trả lời
# ----------------------------------------------------------------------------

class SubmitAnswerRequest(BaseModel):
    student_answer: str | None = None
    selected_index: int | None = Field(default=None, ge=0, le=7)
    video_time: float | None = None
    # trường cũ (bỏ qua): student_id lấy từ token
    student_id: str | None = None
    video_id: str | None = None
    timestamp: float | None = None


@router.post("/video-questions/{question_id}/answer")
def submit_question_answer(question_id: str, req: SubmitAnswerRequest, user: Principal = Depends(get_current_user),
                           db: Session = Depends(get_db)):
    if req.student_answer is None and req.selected_index is None:
        raise AppError(400, "EMPTY_ANSWER", "Cần student_answer hoặc selected_index.")
    return workflow.submit_answer(db, user, parse_uuid(question_id, "question_id"), req.student_answer,
                                  req.selected_index, req.video_time or req.timestamp)
