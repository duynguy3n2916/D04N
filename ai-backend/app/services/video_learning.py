"""AI Video Learning phía giáo viên: sinh câu hỏi tại mốc thời gian, AI đề xuất mốc, quản lý / duyệt câu hỏi video."""
import logging

from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.llm_schemas import QuestionItem, SuggestOutput
from app.core.prompts import VIDEO_QUESTION, VIDEO_SUGGEST, wrap_documents
from app.core.security import Principal
from app.core.utils import fmt_ts, resolve_option_index
from app.models.transcript import TranscriptSegment
from app.models.video_question import VideoQuestion
from app.services import llm
from app.services.retrieval import (RetrievalScope, active_transcript, build_context, format_segments, retrieve,
                                    transcript_window)

log = logging.getLogger("app.video")
MAX_SUGGEST_WINDOWS = 15


def teacher_question_dict(q: VideoQuestion) -> dict:
    return {
        "question_id": str(q.id), "video_id": q.video_id, "timestamp": q.timestamp, "type": q.type,
        "difficulty": q.difficulty, "question": q.question, "options": q.options, "correct_answer": q.answer,
        "answer": q.answer, "correct_index": q.correct_index, "explanation": q.explanation, "sources": q.sources,
        "origin": q.origin, "status": q.status, "edited": bool(q.edited), "importance_score": q.importance_score,
        "created_at": q.created_at.isoformat() if q.created_at else None,
    }


def _new_question(video_id: str, timestamp: float, item: QuestionItem, *, origin: str, user: Principal,
                  sources: dict | None, status: str = "draft", importance: float | None = None) -> VideoQuestion:
    payload = item.model_dump()
    return VideoQuestion(
        video_id=video_id, timestamp=round(float(timestamp), 2), question=item.question, type=item.type,
        difficulty=item.difficulty, answer=item.correct_answer, correct_index=item.correct_index,
        explanation=item.explanation, options=item.options, sources=sources, origin=origin, status=status,
        original_payload=payload, edited=False, created_by=user.user_id, importance_score=importance,
    )


def generate_at_timestamp(db: Session, user: Principal, video_id: str, *, timestamp: float, window_seconds: float = 90,
                          qtype: str = "multiple_choice", difficulty: str = "medium", lesson_id: str | None = None,
                          use_lesson_context: bool = True, language: str = "vi") -> dict:
    start, end = max(0.0, timestamp - window_seconds), timestamp + 10
    segs, tr = transcript_window(db, video_id, start, end)
    if tr is None:
        raise AppError(400, "NO_TRANSCRIPT", f"Video {video_id} chưa có transcript. Hãy import hoặc phiên âm trước.")
    if not segs:
        raise AppError(400, "NO_SEGMENTS", f"Không có lời giảng trong khoảng {fmt_ts(start)}–{fmt_ts(end)}.")
    transcript_text = format_segments(segs)
    block = {"content": transcript_text, "source_type": "video", "source_id": video_id,
             "label": f"Lời giảng video {video_id} {fmt_ts(segs[0].start_time)}–{fmt_ts(segs[-1].end_time)}"}
    extra: list[dict] = []
    lesson_id = lesson_id or tr.lesson_id
    if use_lesson_context and lesson_id:
        extra = retrieve(db, transcript_text[-1500:], RetrievalScope.for_user(user, lesson_id=lesson_id),
                         top_k=3, min_score=0.35)
        extra = [c for c in extra if c["source_type"] != "video"]
    context, sources = build_context(extra, block, max_chars=8000)
    prompt = (f"{wrap_documents(context)}\n\nSinh 1 câu hỏi tại thời điểm {fmt_ts(timestamp)}.\n"
              f"- Loại: {qtype}\n- Độ khó: {difficulty}\n- Ngôn ngữ: {language}\n"
              "Câu hỏi phải dựa chủ yếu vào phần lời giảng video (nguồn đầu tiên).")
    item, res = llm.complete_json("video_question", VIDEO_QUESTION, prompt, QuestionItem, max_tokens=1200,
                                  user_id=user.user_id)
    q =_new_question(video_id, timestamp, item, origin="teacher", user=user, sources={
        "transcript_id": str(tr.id), "window": [start, end], "labels": [s["display"] for s in sources],
        "llm_call_ids": res.call_ids, "prompt_version": res.prompt_version})
    db.add(q)
    db.commit()
    out = teacher_question_dict(q)
    out["transcript_context"] = transcript_text
    return out


def _windows(segs: list[TranscriptSegment], seconds: float = 300, max_chars: int = 6000) -> list[list[TranscriptSegment]]:
    windows: list[list[TranscriptSegment]] = []
    cur: list[TranscriptSegment] = []
    chars = 0
    for s in segs:
        if cur and (s.start_time - cur[0].start_time > seconds or chars + len(s.text) > max_chars):
            windows.append(cur)
            cur, chars = [], 0
        cur.append(s)
        chars += len(s.text) + 20
    if cur:
        windows.append(cur)
    return windows


def suggest_timestamps(db: Session, user: Principal, video_id: str, *, max_suggestions: int = 3,
                       min_interval_seconds: float = 120, save_drafts: bool = True, language: str = "vi") -> dict:
    tr = active_transcript(db, video_id)
    if tr is None:
        raise AppError(400, "NO_TRANSCRIPT", f"Video {video_id} chưa có transcript.")
    segs = (db.query(TranscriptSegment).filter(TranscriptSegment.transcript_id == tr.id)
            .order_by(TranscriptSegment.start_time).all())
    if len(segs) < 3:
        raise AppError(400, "TRANSCRIPT_TOO_SHORT", "Transcript quá ngắn để đề xuất mốc.")
    windows = _windows(segs)
    warnings = []
    if len(windows) > MAX_SUGGEST_WINDOWS:
        warnings.append(f"Video dài: chỉ phân tích {MAX_SUGGEST_WINDOWS} đoạn rải đều trên {len(windows)} đoạn.")
        step = len(windows) / MAX_SUGGEST_WINDOWS
        windows = [windows[int(i * step)] for i in range(MAX_SUGGEST_WINDOWS)]
    per_window = max(1, min(3, -(-max_suggestions * 2 // len(windows))))
    candidates = []
    for w in windows:
        w_start, w_end = w[0].start_time, w[-1].end_time
        prompt = (f"{wrap_documents(format_segments(w))}\n\nĐoạn từ {fmt_ts(w_start)} đến {fmt_ts(w_end)} "
                  f"(tức {w_start:.0f}s–{w_end:.0f}s). Đề xuất tối đa {per_window} mốc, timestamp tính bằng giây. "
                  f"Ngôn ngữ: {language}.")
        try:
            out, res = llm.complete_json("video_suggest", VIDEO_SUGGEST, prompt, SuggestOutput, max_tokens=2500,
                                         user_id=user.user_id)
        except Exception as e:
            warnings.append(f"Bỏ qua đoạn {fmt_ts(w_start)}–{fmt_ts(w_end)}: {getattr(e, 'detail', e)}")
            continue
        for sg in out.suggestions[:per_window]:
            ts = min(max(sg.timestamp, w_start), w_end)
            candidates.append((sg, ts, res))
    candidates.sort(key=lambda x: x[0].importance_score, reverse=True)
    chosen = []
    for sg, ts, res in candidates:
        if all(abs(ts - c[1]) >= min_interval_seconds for c in chosen):
            chosen.append((sg, ts, res))
        if len(chosen) >= max_suggestions:
            break
    chosen.sort(key=lambda x: x[1])
    suggestions = []
    for sg, ts, res in chosen:
        entry = {"timestamp": round(ts, 1), "time": fmt_ts(ts), "concept": sg.concept,
                 "importance_score": sg.importance_score, "reason": sg.reason,
                 "sample_question": sg.sample_question.model_dump() if sg.sample_question else None}
        if save_drafts and sg.sample_question:
            q = _new_question(video_id, ts, sg.sample_question, origin="ai_suggest", user=user,
                              importance=sg.importance_score,
                              sources={"transcript_id": str(tr.id), "concept": sg.concept, "reason": sg.reason,
                                       "llm_call_ids": res.call_ids, "prompt_version": res.prompt_version})
            db.add(q)
            db.flush()
            entry["question_id"] = str(q.id)
            entry["status"] = "draft"
        suggestions.append(entry)
    db.commit()
    if not suggestions and warnings:
        raise AppError(502, "LLM_ERROR", "Không đề xuất được mốc nào. " + " ".join(warnings[:3]))
    return {"video_id": video_id, "transcript_version": tr.version, "total_suggestions": len(suggestions),
            "suggestions": suggestions, "warnings": warnings}


def save_question(db: Session, user: Principal, video_id: str, data: dict, status: str = "approved") -> dict:
    """Giáo viên tự soạn câu hỏi (hoặc lưu lại bản đã chỉnh) cho video."""
    data = dict(data)
    if data.get("correct_answer") is None and data.get("answer") is not None:
        data["correct_answer"] = data["answer"]
    if data.get("correct_answer") is None and data.get("correct_index") is not None and data.get("options"):
        data["correct_answer"] = data["options"][int(data["correct_index"])]
    data.pop("correct_index", None)
    try:
        item = QuestionItem.model_validate({k: data.get(k) for k in QuestionItem.model_fields if k in data})
    except Exception as e:
        raise AppError(422, "INVALID_QUESTION", f"Câu hỏi không hợp lệ: {e}")
    if status not in ("draft", "approved"):
        raise AppError(400, "INVALID_STATUS", "status phải là draft hoặc approved")
    q = VideoQuestion(video_id=video_id, timestamp=round(float(data["timestamp"]), 2), question=item.question,
                      type=item.type, difficulty=item.difficulty, answer=item.correct_answer,
                      correct_index=item.correct_index, explanation=item.explanation, options=item.options,
                      sources={"manual": True, "sources": item.sources} if item.sources else {"manual": True},
                      origin="teacher", status=status, created_by=user.user_id,
                      reviewed_by=user.user_id if status == "approved" else None)
    db.add(q)
    db.commit()
    return teacher_question_dict(q)


def update_question(db: Session, user: Principal, question_id, changes: dict) -> dict:
    q = db.get(VideoQuestion, question_id)
    if not q or q.origin == "agent":
        raise AppError(404, "NOT_FOUND", "Không tìm thấy câu hỏi video.")
    content_keys = {"question", "type", "difficulty", "options", "correct_answer", "answer", "explanation"}
    if content_keys & {k for k, v in changes.items() if v is not None}:
        merged = {"type": q.type, "difficulty": q.difficulty, "question": q.question, "options": q.options,
                  "correct_answer": q.answer, "explanation": q.explanation or ""}
        for k in content_keys:
            if changes.get(k) is not None:
                merged["correct_answer" if k == "answer" else k] = changes[k]
        if changes.get("correct_index") is not None and merged.get("options"):
            merged["correct_answer"] = merged["options"][int(changes["correct_index"])]
        try:
            item = QuestionItem.model_validate(merged)
        except Exception as e:
            raise AppError(422, "INVALID_QUESTION", f"Câu hỏi không hợp lệ: {e}")
        before = (q.question, q.type, q.options, q.answer, q.explanation, q.difficulty)
        q.question, q.type, q.difficulty = item.question, item.type, item.difficulty
        q.options, q.answer, q.correct_index, q.explanation = item.options, item.correct_answer, item.correct_index, item.explanation
        if before != (q.question, q.type, q.options, q.answer, q.explanation, q.difficulty):
            q.edited = True
    elif changes.get("correct_index") is not None and q.options:
        idx = int(changes["correct_index"])
        if not 0 <= idx < len(q.options):
            raise AppError(422, "INVALID_QUESTION", "correct_index ngoài phạm vi lựa chọn.")
        if idx != q.correct_index:
            q.correct_index, q.answer, q.edited = idx, q.options[idx], True
    if changes.get("timestamp") is not None:
        q.timestamp = round(float(changes["timestamp"]), 2)
    status = changes.get("status")
    if status:
        if status not in ("draft", "approved", "rejected", "archived"):
            raise AppError(400, "INVALID_STATUS", "status phải là draft / approved / rejected / archived")
        q.status = status
        q.reviewed_by = user.user_id
    if q.correct_index is None and q.options:
        q.correct_index = resolve_option_index(q.options, q.answer)
    db.commit()
    return teacher_question_dict(q)


def list_questions(db: Session, video_id: str, *, manage: bool) -> list[dict]:
    from app.services.workflow import public_question
    q = db.query(VideoQuestion).filter(VideoQuestion.video_id == video_id)
    if manage:
        q = q.filter(VideoQuestion.origin != "agent", VideoQuestion.status != "archived")
        return [teacher_question_dict(r) for r in q.order_by(VideoQuestion.timestamp).all()]
    q = q.filter(VideoQuestion.status == "approved", VideoQuestion.origin != "agent")
    return [public_question(r) for r in q.order_by(VideoQuestion.timestamp).all()]
