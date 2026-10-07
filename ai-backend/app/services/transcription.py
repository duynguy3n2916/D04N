"""Transcript video:
1. Parse phụ đề có sẵn (.srt, .vtt, .json)
2. Phiên âm bằng Whisper API (Groq / OpenAI), tự tách audio và cắt đoạn bằng ffmpeg
3. Lưu transcript theo phiên bản và index vào Knowledge Base
"""
import json
import logging
import re
import subprocess
import tempfile
from pathlib import Path

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.core.errors import AppError
from app.core.utils import fmt_ts
from app.models.documents import AIChunk, AIDocument
from app.models.transcript import TranscriptSegment, VideoTranscript
from app.services import jobs
from app.services.embedding import embed_batched

log = logging.getLogger("app.transcription")

# ----------------------------------------------------------------------------
# Parse phụ đề
# ----------------------------------------------------------------------------

_TS = re.compile(r"((?:\d+:)?\d{1,2}:\d{1,2}(?:[\.,]\d+)?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[\.,]\d+)?)")


def parse_timestamp(ts: str) -> float:
    ts = ts.strip().replace(",", ".")
    parts = ts.split(":")
    if len(parts) == 3:
        return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
    if len(parts) == 2:
        return float(parts[0]) * 60 + float(parts[1])
    return float(ts)


def parse_srt(content: str) -> list[dict]:
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    segments = []
    for block in re.split(r"\n\s*\n", content.strip()):
        lines = [ln.strip() for ln in block.split("\n") if ln.strip()]
        for i, line in enumerate(lines):
            m = _TS.search(line)
            if not m:
                continue
            text = re.sub(r"<[^>]+>", "", " ".join(lines[i + 1:])).strip()
            text = re.sub(r"\{\\[^}]+\}", "", text).strip()
            if text:
                segments.append({"start_time": round(parse_timestamp(m.group(1)), 2),
                                 "end_time": round(parse_timestamp(m.group(2)), 2), "text": text})
            break
    return segments


def parse_vtt(content: str) -> list[dict]:
    content = content.lstrip("﻿")
    if content.startswith("WEBVTT"):
        content = content.split("\n", 1)[1] if "\n" in content else ""
    return parse_srt(content)


def parse_json_transcript(content: str) -> list[dict]:
    data = json.loads(content)
    if isinstance(data, dict):
        data = data.get("segments") or data.get("transcript") or []
    if not isinstance(data, list):
        raise AppError(400, "INVALID_TRANSCRIPT", "JSON transcript phải là mảng các đoạn hoặc {\"segments\": [...]}.")
    segments = []
    for item in data:
        text = str(item.get("text") or item.get("content") or "").strip()
        if not text:
            continue
        start = float(item.get("start", item.get("start_time", 0.0)) or 0.0)
        if item.get("end") is not None or item.get("end_time") is not None:
            end = float(item.get("end", item.get("end_time")))
        elif item.get("duration") is not None:
            end = start + float(item["duration"])
        else:
            end = start + 2.0
        segments.append({"start_time": round(start, 2), "end_time": round(end, 2), "text": text})
    return segments


def parse_transcript_content(content: str, filename: str = "") -> list[dict]:
    c = content.lstrip("﻿").strip()
    fn = filename.lower()
    if fn.endswith(".json") or c.startswith("[") or c.startswith("{"):
        return parse_json_transcript(c)
    if fn.endswith(".vtt") or c.startswith("WEBVTT"):
        return parse_vtt(c)
    return parse_srt(c)


def normalize_segments(segments: list[dict]) -> list[dict]:
    out = []
    for s in segments:
        try:
            start, end = float(s["start_time"]), float(s["end_time"])
        except (KeyError, TypeError, ValueError):
            raise AppError(400, "INVALID_SEGMENT", "Mỗi segment cần start_time, end_time (số) và text.")
        text = str(s.get("text", "")).strip()
        if not text:
            continue
        start = max(0.0, start)
        end = max(start, end)
        out.append({"start_time": round(start, 2), "end_time": round(end, 2), "text": text})
    out.sort(key=lambda x: x["start_time"])
    if not out:
        raise AppError(400, "EMPTY_TRANSCRIPT", "Transcript không có đoạn nào hợp lệ.")
    return out


# ----------------------------------------------------------------------------
# Speech-to-Text
# ----------------------------------------------------------------------------

def _ffmpeg_exe() -> str | None:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        import shutil
        return shutil.which("ffmpeg")


def _media_duration(ffmpeg: str, path: str) -> float | None:
    proc = subprocess.run([ffmpeg, "-hide_banner", "-i", path], capture_output=True, text=True, errors="ignore")
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", proc.stderr)
    if not m:
        return None
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def prepare_audio_parts(path: str, workdir: str) -> list[tuple[str, float]]:
    """Tách audio mono 16kHz và cắt thành các đoạn <= STT_CHUNK_SECONDS. Trả về [(file, offset_giây)]."""
    ffmpeg = _ffmpeg_exe()
    size_mb = Path(path).stat().st_size / (1024 * 1024)
    if not ffmpeg:
        if size_mb > 24:
            raise AppError(400, "FFMPEG_REQUIRED", "File > 24MB cần ffmpeg để tách/cắt audio. Cài gói imageio-ffmpeg.")
        return [(path, 0.0)]
    duration = _media_duration(ffmpeg, path)
    if duration is None:
        raise AppError(400, "INVALID_MEDIA", "Không đọc được thời lượng file audio/video.")
    step = max(60, settings.stt_chunk_seconds)
    parts = []
    start = 0.0
    idx = 0
    while start < duration:
        out = str(Path(workdir) / f"part_{idx:03d}.mp3")
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{start:.2f}", "-t", f"{step}",
               "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", out]
        proc = subprocess.run(cmd, capture_output=True, text=True, errors="ignore")
        if proc.returncode != 0:
            raise AppError(400, "FFMPEG_FAILED", f"ffmpeg lỗi: {proc.stderr[-500:]}")
        if Path(out).exists() and Path(out).stat().st_size > 1024:
            parts.append((out, start))
        start += step
        idx += 1
    return parts


def _whisper_client():
    from openai import OpenAI
    if settings.whisper_provider.lower() == "groq":
        if not settings.groq_api_key:
            raise AppError(400, "STT_NOT_CONFIGURED", "Chưa cấu hình GROQ_API_KEY.")
        return OpenAI(api_key=settings.groq_api_key, base_url="https://api.groq.com/openai/v1", timeout=300), \
            settings.groq_whisper_model
    if not settings.openai_api_key:
        raise AppError(400, "STT_NOT_CONFIGURED", "Chưa cấu hình OPENAI_API_KEY cho Whisper.")
    return OpenAI(api_key=settings.openai_api_key, timeout=300), "whisper-1"


def transcribe_file(path: str, language: str = "vi") -> list[dict]:
    """Gọi Whisper cho một file audio. Có thể thay trong test."""
    client, model = _whisper_client()
    with open(path, "rb") as f:
        resp = client.audio.transcriptions.create(model=model, file=f, language=language,
                                                  response_format="verbose_json", timestamp_granularities=["segment"])
    raw = getattr(resp, "segments", None)
    if raw is None and isinstance(resp, dict):
        raw = resp.get("segments")
    segments = []
    for s in raw or []:
        d = s if isinstance(s, dict) else (s.model_dump() if hasattr(s, "model_dump") else vars(s))
        text = (d.get("text") or "").strip()
        if text:
            segments.append({"start_time": float(d.get("start", 0)), "end_time": float(d.get("end", 0)), "text": text})
    if not segments:
        full = (getattr(resp, "text", "") or "").strip()
        if full:
            segments.append({"start_time": 0.0, "end_time": 0.0, "text": full})
    return segments


def transcribe_media(path: str, language: str = "vi", ctx: "jobs.JobContext | None" = None) -> list[dict]:
    with tempfile.TemporaryDirectory() as tmp:
        parts = prepare_audio_parts(path, tmp)
        all_segments: list[dict] = []
        for i, (part, offset) in enumerate(parts):
            if ctx:
                ctx.progress(0.1 + 0.7 * i / max(1, len(parts)), f"Đang phiên âm đoạn {i + 1}/{len(parts)}…")
            for s in transcribe_file(part, language):
                end = s["end_time"] or (s["start_time"] + 5)
                all_segments.append({"start_time": round(s["start_time"] + offset, 2),
                                     "end_time": round(end + offset, 2), "text": s["text"]})
    return all_segments


# ----------------------------------------------------------------------------
# Lưu phiên bản + index Knowledge Base
# ----------------------------------------------------------------------------

def save_transcript_version(db: Session, video_id: str, segments: list[dict], *, source: str,
                            language: str = "vi", model_version: str | None = None, created_by: str | None = None,
                            lesson_id=None, course_id=None, class_id=None) -> tuple[VideoTranscript, dict]:
    segments = normalize_segments(segments)
    prev = (db.query(VideoTranscript).filter(VideoTranscript.video_id == video_id, VideoTranscript.is_active.is_not(False))
            .order_by(VideoTranscript.created_at.desc()).first())
    max_version = db.query(func.max(VideoTranscript.version)).filter(VideoTranscript.video_id == video_id).scalar() or 0
    if prev is None:
        from app.models.learning import LessonItem, MediaVideo
        linked = (db.query(LessonItem).filter(LessonItem.video_id == video_id, LessonItem.type == "video")
                  .order_by(LessonItem.created_at, LessonItem.id).first())
        if linked:
            lesson = linked.lesson
            lesson_id = lesson_id or lesson.code
            course_id = course_id or lesson.chapter.course.code
            if class_id is None:
                class_id = lesson.chapter.course.class_id
        else:
            media = db.get(MediaVideo, video_id)
            if media and class_id is None:
                class_id = media.class_id
    tr = VideoTranscript(
        video_id=video_id, version=max_version + 1, is_active=True, source=source, language=language,
        model_version=model_version, status="ready", created_by=created_by,
        lesson_id=lesson_id if lesson_id is not None else (prev.lesson_id if prev else None),
        course_id=course_id if course_id is not None else (prev.course_id if prev else None),
        class_id=class_id if class_id is not None else (prev.class_id if prev else None),
    )
    db.add(tr)
    db.flush()
    db.query(VideoTranscript).filter(VideoTranscript.video_id == video_id, VideoTranscript.id != tr.id) \
        .update({"is_active": False}, synchronize_session=False)
    for s in segments:
        db.add(TranscriptSegment(transcript_id=tr.id, **s))
    db.commit()
    db.refresh(tr)
    kb = index_transcript(db, tr, segments)
    return tr, kb


def group_segments(segments: list[dict], max_chars: int = 700, max_segments: int = 8) -> list[dict]:
    """Gộp segment liên tiếp thành chunk, overlap 1 segment; giữ chỉ số segment để truy ngược."""
    groups: list[dict] = []
    i = 0
    n = len(segments)
    while i < n:
        j = i
        length = 0
        while j < n and (j == i or (length + len(segments[j]["text"]) <= max_chars and j - i < max_segments)):
            length += len(segments[j]["text"]) + 1
            j += 1
        groups.append({
            "content": " ".join(s["text"] for s in segments[i:j]),
            "start_time": segments[i]["start_time"],
            "end_time": segments[j - 1]["end_time"],
            "segment_from": i,
            "segment_to": j - 1,
        })
        if j >= n:
            break
        i = j - 1 if j - 1 > i else j  # overlap 1 segment
    return groups


def index_transcript(db: Session, tr: VideoTranscript, segments: list[dict]) -> dict:
    doc = AIDocument(
        title=f"Lời giảng video {tr.video_id} (v{tr.version})", source_type="video", source_id=tr.video_id,
        lesson_id=tr.lesson_id, course_id=tr.course_id, class_id=tr.class_id, status="processing",
        is_active=True, version=tr.version, uploaded_by=tr.created_by,
    )
    db.add(doc)
    db.commit()
    try:
        groups = group_segments(segments)
        embeddings = embed_batched([g["content"] for g in groups])
        for idx, (g, emb) in enumerate(zip(groups, embeddings)):
            db.add(AIChunk(
                document_id=doc.id, content=g["content"], chunk_index=idx,
                start_time=g["start_time"], end_time=g["end_time"],
                section=f"Video {fmt_ts(g['start_time'])} - {fmt_ts(g['end_time'])}",
                meta={"transcript_id": str(tr.id), "segment_from": g["segment_from"], "segment_to": g["segment_to"]},
                embedding=emb,
            ))
        doc.status = "ready"
        # vô hiệu các document transcript cũ của video
        db.query(AIDocument).filter(AIDocument.source_type == "video", AIDocument.source_id == tr.video_id,
                                    AIDocument.id != doc.id).update({"is_active": False}, synchronize_session=False)
        db.commit()
        return {"status": "ready", "document_id": str(doc.id), "chunks": len(groups)}
    except Exception as e:
        db.rollback()
        doc = db.get(AIDocument, doc.id)
        doc.status, doc.error_message = "failed", str(e)[:2000]
        db.commit()
        log.exception("transcript_index_failed")
        return {"status": "failed", "document_id": str(doc.id), "error": str(e)[:500]}


@jobs.register("transcribe_video")
def transcribe_video_job(ctx: "jobs.JobContext", video_id: str, file_path: str, language: str = "vi",
                         lesson_id=None, course_id=None, class_id=None, created_by=None,
                         delete_file: bool = True) -> dict:
    try:
        segments = transcribe_media(file_path, language, ctx)
        if not segments:
            raise AppError(422, "NO_SPEECH", "Không nhận diện được lời nói nào trong file.")
        ctx.progress(0.85, "Đang lưu transcript và index Knowledge Base…")
        tr, kb = save_transcript_version(
            ctx.db, video_id, segments, source="whisper", language=language,
            model_version=f"{settings.whisper_provider}:{settings.groq_whisper_model if settings.whisper_provider == 'groq' else 'whisper-1'}",
            created_by=created_by, lesson_id=lesson_id, course_id=course_id, class_id=class_id)
    finally:
        if delete_file:
            Path(file_path).unlink(missing_ok=True)
    return {"video_id": video_id, "transcript_id": str(tr.id), "version": tr.version,
            "total_segments": len(segments), "knowledge_base": kb}


def transcript_to_dict(tr: VideoTranscript, segments: list[TranscriptSegment]) -> dict:
    return {
        "video_id": tr.video_id, "transcript_id": str(tr.id), "version": tr.version, "source": tr.source,
        "language": tr.language, "status": tr.status, "lesson_id": tr.lesson_id,
        "total_segments": len(segments),
        "segments": [{"start_time": s.start_time, "end_time": s.end_time, "text": s.text} for s in segments],
    }
