"""Interaction Orchestrator: state machine của phiên xem video và Question Agent.

Mọi chuyển trạng thái đi qua `_transition` (kiểm tra hợp lệ + ghi session_transitions).
Phiên được khóa dòng (SELECT ... FOR UPDATE) khi thay đổi để tránh hai câu hỏi xuất hiện cùng lúc.
Thời hạn trả lời do server quản lý (question_deadline_at): kiểm tra lười ở mỗi request + quét nền định kỳ.
"""
import logging
from datetime import timedelta
from enum import Enum

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.core.context import get_request_id
from app.core.errors import AppError
from app.core.llm_schemas import AgentQuestionItem
from app.core.prompts import QUESTION_AGENT, wrap_documents
from app.core.security import Principal
from app.core.utils import as_aware, fmt_ts, normalize_text, utcnow
from app.models.video_question import AIInteraction, VideoQuestion
from app.models.workflow import SessionTransition, VideoSession
from app.services import grading, llm
from app.services.retrieval import format_segments, transcript_window

log = logging.getLogger("app.workflow")


class S(str, Enum):
    VIDEO_PLAYING = "VIDEO_PLAYING"
    GENERATE_QUESTION = "GENERATE_QUESTION"
    PAUSE_VIDEO = "PAUSE_VIDEO"
    WAITING_FOR_STUDENT = "WAITING_FOR_STUDENT"
    STUDENT_ANSWER = "STUDENT_ANSWER"
    TIMEOUT = "TIMEOUT"
    TUTOR_FEEDBACK = "TUTOR_FEEDBACK"
    TUTOR_SELF_ANSWER = "TUTOR_SELF_ANSWER"
    RESUME_VIDEO = "RESUME_VIDEO"
    COOLDOWN = "COOLDOWN"


InteractionState = S  # tên cũ, giữ tương thích

TRANSITIONS: dict[S, set[S]] = {
    S.VIDEO_PLAYING: {S.GENERATE_QUESTION, S.PAUSE_VIDEO},
    S.COOLDOWN: {S.VIDEO_PLAYING, S.PAUSE_VIDEO},
    S.GENERATE_QUESTION: {S.PAUSE_VIDEO, S.VIDEO_PLAYING},
    S.PAUSE_VIDEO: {S.WAITING_FOR_STUDENT},
    S.WAITING_FOR_STUDENT: {S.STUDENT_ANSWER, S.TIMEOUT},
    S.STUDENT_ANSWER: {S.TUTOR_FEEDBACK},
    S.TIMEOUT: {S.TUTOR_SELF_ANSWER},
    S.TUTOR_FEEDBACK: {S.RESUME_VIDEO},
    S.TUTOR_SELF_ANSWER: {S.RESUME_VIDEO},
    S.RESUME_VIDEO: {S.COOLDOWN},
}

QUESTION_ACTIVE_STATES = {S.PAUSE_VIDEO.value, S.WAITING_FOR_STUDENT.value, S.STUDENT_ANSWER.value}
GENERATE_STALE_SECONDS = 120
STUDENT_ANSWER_STALE_SECONDS = 300


class InvalidTransition(AppError):
    def __init__(self, src: str, dst: str):
        super().__init__(409, "INVALID_TRANSITION", f"Không thể chuyển {src} -> {dst}.", {"from": src, "to": dst})


# ----------------------------------------------------------------------------
# Hạ tầng phiên
# ----------------------------------------------------------------------------

def lock_session(db: Session, student_id: str, video_id: str) -> VideoSession:
    """Lấy (hoặc tạo) phiên và khóa dòng tới hết transaction hiện tại."""
    q = db.query(VideoSession).filter(VideoSession.student_id == student_id, VideoSession.video_id == video_id)
    s = q.with_for_update().first()
    if s:
        return s
    try:
        with db.begin_nested():
            s = VideoSession(student_id=student_id, video_id=video_id, current_state=S.VIDEO_PLAYING.value,
                             state_changed_at=utcnow(), current_video_time=0.0)
            db.add(s)
    except IntegrityError:
        pass  # request song song vừa tạo
    return q.with_for_update().one()


def _transition(db: Session, s: VideoSession, dst: S, reason: str) -> None:
    src = S(s.current_state) if s.current_state in S.__members__ else S.VIDEO_PLAYING
    if dst not in TRANSITIONS.get(src, set()):
        raise InvalidTransition(src.value, dst.value)
    db.add(SessionTransition(session_id=s.id, from_state=src.value, to_state=dst.value, reason=reason,
                             video_time=s.current_video_time, correlation_id=get_request_id()))
    s.current_state = dst.value
    s.state_changed_at = utcnow()


def _seconds_in_state(s: VideoSession) -> float:
    changed = as_aware(s.state_changed_at) or as_aware(s.updated_at) or utcnow()
    return (utcnow() - changed).total_seconds()


def _apply_timeout(db: Session, s: VideoSession, reason: str) -> None:
    q = db.get(VideoQuestion, s.active_question_id) if s.active_question_id else None
    _transition(db, s, S.TIMEOUT, reason)
    correct = grading.correct_answer_text(q) if q else ""
    explanation = (q.explanation or "") if q else ""
    feedback = ("Đã hết thời gian trả lời. " + (f"Đáp án đúng là: {correct}. " if correct else "") + explanation +
                " Mình cùng xem tiếp bài giảng nhé!").strip()
    it = AIInteraction(student_id=s.student_id, video_id=s.video_id, session_id=s.id, interaction_type="timeout",
                       question_id=q.id if q else None, student_answer=None, is_correct=False, verdict="timeout",
                       ai_feedback=feedback, feedback_status="ready", timestamp=s.current_video_time)
    db.add(it)
    db.flush()
    _transition(db, s, S.TUTOR_SELF_ANSWER, "tutor_self_answer")
    s.last_result = {"type": "timeout", "question_id": str(q.id) if q else None, "correct_answer": correct,
                     "correct_index": q.correct_index if q else None, "interaction_id": str(it.id),
                     "explanation": explanation, "feedback": feedback, "is_correct": False,
                     "tutor_status": "pending" if q else None}
    if q is not None:  # AI thứ hai (Tutor) giải thích đáp án, chạy nền sau khi commit
        from app.services import tutor_explain
        tutor_explain.queue(db, it)
    s.active_question_id = None
    s.question_deadline_at = None
    s.last_interaction_at = utcnow()


def _resume(db: Session, s: VideoSession, reason: str) -> None:
    _transition(db, s, S.RESUME_VIDEO, reason)
    _transition(db, s, S.COOLDOWN, "start_cooldown")
    s.cooldown_until = utcnow() + timedelta(seconds=settings.agent_cooldown_seconds)
    s.last_interaction_at = utcnow()


def refresh(db: Session, s: VideoSession) -> None:
    """Xử lý các chuyển trạng thái theo thời gian (phải đang giữ khóa phiên)."""
    for _ in range(4):
        state = s.current_state
        now = utcnow()
        if state == S.WAITING_FOR_STUDENT.value and s.question_deadline_at and as_aware(s.question_deadline_at) <= now:
            _apply_timeout(db, s, "deadline_passed")
        elif state == S.GENERATE_QUESTION.value and _seconds_in_state(s) > GENERATE_STALE_SECONDS:
            _transition(db, s, S.VIDEO_PLAYING, "generation_stale")
        elif state == S.STUDENT_ANSWER.value and _seconds_in_state(s) > STUDENT_ANSWER_STALE_SECONDS:
            _transition(db, s, S.TUTOR_FEEDBACK, "grading_stale")
            s.active_question_id, s.question_deadline_at = None, None
        elif state in (S.TUTOR_FEEDBACK.value, S.TUTOR_SELF_ANSWER.value) and \
                _seconds_in_state(s) > settings.feedback_auto_resume_seconds:
            _resume(db, s, "auto_resume")
        elif state == S.COOLDOWN.value and (not s.cooldown_until or as_aware(s.cooldown_until) <= now):
            _transition(db, s, S.VIDEO_PLAYING, "cooldown_finished")
        elif state in (S.PAUSE_VIDEO.value, S.TIMEOUT.value, S.RESUME_VIDEO.value):
            # trạng thái trung gian bị kẹt (server dừng giữa chừng) -> đưa về trạng thái ổn định
            s.current_state, s.state_changed_at = S.VIDEO_PLAYING.value, now
            s.active_question_id, s.question_deadline_at = None, None
        else:
            return


# ----------------------------------------------------------------------------
# Biểu diễn trạng thái
# ----------------------------------------------------------------------------

def public_question(q: VideoQuestion) -> dict:
    """Câu hỏi gửi cho học sinh: không có đáp án."""
    return {"question_id": str(q.id), "video_id": q.video_id, "timestamp": q.timestamp, "type": q.type,
            "difficulty": q.difficulty, "question": q.question, "options": q.options, "origin": q.origin}


def session_status(db: Session, s: VideoSession, include_transitions: bool = True) -> dict:
    now = utcnow()
    remaining_cd = 0.0
    if s.current_state == S.COOLDOWN.value and s.cooldown_until:
        remaining_cd = max(0.0, (as_aware(s.cooldown_until) - now).total_seconds())
    deadline_left = None
    if s.question_deadline_at and s.current_state == S.WAITING_FOR_STUDENT.value:
        deadline_left = max(0.0, (as_aware(s.question_deadline_at) - now).total_seconds())
    active = db.get(VideoQuestion, s.active_question_id) if s.active_question_id else None
    out = {
        "session_id": str(s.id),
        "student_id": s.student_id,
        "video_id": s.video_id,
        "state": s.current_state,
        "current_state": s.current_state,
        "current_video_time": s.current_video_time,
        "video_question_active": s.current_state in QUESTION_ACTIVE_STATES,
        "in_cooldown": s.current_state == S.COOLDOWN.value,
        "remaining_cooldown_seconds": round(remaining_cd, 1),
        "deadline_at": as_aware(s.question_deadline_at).isoformat() if s.question_deadline_at else None,
        "deadline_remaining_seconds": round(deadline_left, 1) if deadline_left is not None else None,
        "active_question": public_question(active) if active else None,
        "last_result": s.last_result,
        "can_resume": s.current_state in (S.TUTOR_FEEDBACK.value, S.TUTOR_SELF_ANSWER.value),
    }
    if include_transitions:
        rows = (db.query(SessionTransition).filter(SessionTransition.session_id == s.id)
                .order_by(SessionTransition.created_at.desc()).limit(12).all())
        out["transitions"] = [{"from": r.from_state, "to": r.to_state, "reason": r.reason,
                               "video_time": r.video_time, "at": r.created_at.isoformat() if r.created_at else None}
                              for r in rows]
    return out


# ----------------------------------------------------------------------------
# Các thao tác
# ----------------------------------------------------------------------------

def get_status(db: Session, user: Principal, video_id: str) -> dict:
    s = lock_session(db, user.user_id, video_id)
    refresh(db, s)
    db.commit()
    return session_status(db, s)


def _recent_agent_questions(db: Session, s: VideoSession, limit: int = 5) -> list[str]:
    rows = (db.query(VideoQuestion.question).filter(VideoQuestion.session_id == s.id, VideoQuestion.origin == "agent")
            .order_by(VideoQuestion.created_at.desc()).limit(limit).all())
    return [r[0] for r in rows]


def trigger_agent(db: Session, user: Principal, video_id: str, current_time: float, advanced_mode: bool = True) -> dict:
    s = lock_session(db, user.user_id, video_id)
    s.current_video_time = current_time
    s.advanced_mode = advanced_mode
    refresh(db, s)

    def no(reason: str, **extra) -> dict:
        db.commit()
        return {"triggered": False, "reason": reason, **extra, **session_status(db, s, include_transitions=False)}

    if not advanced_mode:
        return no("advanced_mode_disabled")
    if s.current_state == S.COOLDOWN.value:
        return no("in_cooldown")
    if s.current_state != S.VIDEO_PLAYING.value:
        return no("interaction_in_progress")
    prox = settings.scheduled_question_proximity_seconds
    near = (db.query(VideoQuestion.id).filter(
        VideoQuestion.video_id == video_id, VideoQuestion.status == "approved", VideoQuestion.origin != "agent",
        VideoQuestion.timestamp >= current_time - prox, VideoQuestion.timestamp <= current_time + prox).first())
    if near:
        return no("near_scheduled_question")
    window_start = max(0.0, current_time - settings.agent_transcript_window_seconds)
    segs, tr = transcript_window(db, video_id, window_start, current_time)
    if tr is None:
        return no("no_transcript")
    # cần ít nhất 2 đoạn, HOẶC 1 đoạn đủ dài (video có phụ đề gộp thành đoạn lớn)
    enough = len(segs) >= 2 or (len(segs) == 1 and len(segs[0].text.split()) >= 12)
    if not enough:
        return no("insufficient_recent_transcript")

    _transition(db, s, S.GENERATE_QUESTION, "agent_trigger")
    recent = _recent_agent_questions(db, s)
    session_id = s.id
    db.commit()  # nhả khóa trong lúc gọi LLM; trạng thái GENERATE_QUESTION chặn trigger song song

    prompt = (f"{wrap_documents(format_segments(segs))}\n\n"
              f"Học sinh đang ở {fmt_ts(current_time)}. Hãy sinh 1 câu hỏi mở rộng.")
    if recent:
        prompt += "\n\nCác câu đã hỏi (không lặp lại):\n" + "\n".join(f"- {q}" for q in recent)
    try:
        item, res = llm.complete_json("agent_question", QUESTION_AGENT, prompt, AgentQuestionItem, max_tokens=1200,
                                      user_id=user.user_id)
        if normalize_text(item.question) in {normalize_text(q) for q in recent}:
            raise ValueError("Câu hỏi trùng câu đã hỏi")
    except Exception as e:
        log.warning("agent_generation_failed", extra={"extra_fields": {
            "video_id": video_id, "error": f"{type(e).__name__}: {str(getattr(e, 'detail', e))[:300]}"}})
        s = lock_session(db, user.user_id, video_id)
        if s.current_state == S.GENERATE_QUESTION.value:
            _transition(db, s, S.VIDEO_PLAYING, f"generation_failed: {str(getattr(e, 'detail', e))[:200]}")
        return no("generation_failed", error=str(getattr(e, "detail", e))[:300])

    s = lock_session(db, user.user_id, video_id)
    refresh(db, s)
    if s.current_state != S.GENERATE_QUESTION.value or s.id != session_id:
        return no("superseded")
    q = VideoQuestion(
        video_id=video_id, timestamp=current_time, question=item.question, type=item.type,
        difficulty=item.difficulty, answer=item.correct_answer, correct_index=item.correct_index,
        explanation=item.explanation, options=item.options, origin="agent", session_id=s.id, status="approved",
        created_by="agent",
        sources={"transcript_id": str(tr.id), "window": [window_start, current_time],
                 "llm_call_ids": res.call_ids, "prompt_version": res.prompt_version},
    )
    db.add(q)
    db.flush()
    _open_question(db, s, q, "agent_question_ready")
    db.commit()
    return {"triggered": True, "reason": "ok", "timeout_seconds": settings.question_timeout_seconds,
            "question": public_question(q), **session_status(db, s, include_transitions=False)}


def _open_question(db: Session, s: VideoSession, q: VideoQuestion, reason: str) -> None:
    _transition(db, s, S.PAUSE_VIDEO, reason)
    _transition(db, s, S.WAITING_FOR_STUDENT, "waiting_for_student")
    s.active_question_id = q.id
    s.question_deadline_at = utcnow() + timedelta(seconds=settings.question_timeout_seconds)
    s.last_result = None
    s.last_interaction_at = utcnow()


def start_question(db: Session, user: Principal, video_id: str, question_id, current_time: float | None) -> dict:
    """Player tới mốc câu hỏi của giáo viên: dừng video và mở câu hỏi."""
    q = db.get(VideoQuestion, question_id)
    if not q or q.video_id != video_id or q.status != "approved":
        raise AppError(404, "QUESTION_NOT_FOUND", "Không tìm thấy câu hỏi đã duyệt của video này.")
    s = lock_session(db, user.user_id, video_id)
    if current_time is not None:
        s.current_video_time = current_time
    refresh(db, s)
    if s.current_state == S.WAITING_FOR_STUDENT.value and s.active_question_id == q.id:
        db.commit()
        return {"question": public_question(q), **session_status(db, s)}
    if s.current_state in QUESTION_ACTIVE_STATES:
        db.commit()
        raise AppError(409, "INTERACTION_IN_PROGRESS", "Đang có câu hỏi khác chưa hoàn thành.",
                       {"state": s.current_state, "active_question_id": str(s.active_question_id)})
    if s.current_state in (S.TUTOR_FEEDBACK.value, S.TUTOR_SELF_ANSWER.value):
        _resume(db, s, "auto_resume_next_question")
    _open_question(db, s, q, "scheduled_question")
    db.commit()
    return {"question": public_question(q), "timeout_seconds": settings.question_timeout_seconds,
            **session_status(db, s)}


def submit_answer(db: Session, user: Principal, question_id, student_answer: str | None,
                  selected_index: int | None, video_time: float | None = None) -> dict:
    q = db.get(VideoQuestion, question_id)
    if not q or q.status != "approved":
        raise AppError(404, "QUESTION_NOT_FOUND", "Không tìm thấy câu hỏi.")
    if q.origin == "agent":
        owner = db.get(VideoSession, q.session_id) if q.session_id else None
        if not owner or owner.student_id != user.user_id:
            raise AppError(403, "FORBIDDEN", "Câu hỏi này thuộc phiên học khác.")
    s = lock_session(db, user.user_id, q.video_id)
    refresh(db, s)
    in_flow = s.current_state == S.WAITING_FOR_STUDENT.value and s.active_question_id == q.id
    if not in_flow and s.last_result and s.last_result.get("question_id") == str(q.id) \
            and s.last_result.get("type") == "timeout" and s.current_state == S.TUTOR_SELF_ANSWER.value:
        db.commit()
        raise AppError(409, "QUESTION_EXPIRED", "Đã hết thời gian trả lời câu hỏi này.", {"last_result": s.last_result})

    interaction = AIInteraction(student_id=user.user_id, video_id=q.video_id, session_id=s.id,
                                interaction_type="video_question", question_id=q.id,
                                student_answer=student_answer if student_answer is not None else
                                (str(selected_index) if selected_index is not None else None),
                                feedback_status="pending", timestamp=video_time or q.timestamp)
    db.add(interaction)
    if in_flow:
        _transition(db, s, S.STUDENT_ANSWER, "student_answered")
    db.commit()  # lưu câu trả lời trước khi chấm (không mất dữ liệu nếu chấm lỗi)

    result = grading.grade(q, student_answer, selected_index, user_id=user.user_id)

    s = lock_session(db, user.user_id, q.video_id)
    interaction = db.get(AIInteraction, interaction.id)
    interaction.is_correct = result["is_correct"]
    interaction.verdict = result["verdict"]
    interaction.ai_feedback = result["feedback"]
    interaction.feedback_status = result["feedback_status"]
    xp = 0
    if result["is_correct"]:
        from app.services.learning import award_xp
        amount = settings.xp_agent_question if q.origin == "agent" else settings.xp_video_question
        db.commit()
        xp = award_xp(db, user.user_id, amount, "video_question", str(q.id),
                      user.class_ids[0] if user.class_ids else None)
        s = lock_session(db, user.user_id, q.video_id)
    payload = {"type": "answer", "question_id": str(q.id), "is_correct": result["is_correct"],
               "verdict": result["verdict"], "correct_answer": grading.correct_answer_text(q),
               "correct_index": q.correct_index, "explanation": q.explanation, "feedback": result["feedback"],
               "xp_awarded": xp, "interaction_id": str(interaction.id), "tutor_status": None}
    if not result["is_correct"]:  # sai / đúng một phần: Tutor AI giải thích thêm (nền)
        from app.services import tutor_explain
        tutor_explain.queue(db, interaction)
        payload["tutor_status"] = "pending"
    if in_flow and s.current_state == S.STUDENT_ANSWER.value:
        _transition(db, s, S.TUTOR_FEEDBACK, "feedback_ready")
        s.active_question_id, s.question_deadline_at = None, None
        s.last_result = payload
        s.last_interaction_at = utcnow()
    db.commit()
    return {**payload, "interaction_id": str(interaction.id), "in_flow": in_flow,
            "feedback_status": result["feedback_status"], "state": s.current_state,
            "video_question_active": s.current_state in QUESTION_ACTIVE_STATES}


def report_timeout(db: Session, user: Principal, video_id: str) -> dict:
    """Client báo hết giờ; server chỉ chấp nhận khi thời hạn thực sự đã qua (cho phép lệch 2 giây)."""
    s = lock_session(db, user.user_id, video_id)
    refresh(db, s)
    if s.current_state == S.WAITING_FOR_STUDENT.value:
        left = (as_aware(s.question_deadline_at) - utcnow()).total_seconds() if s.question_deadline_at else 0
        if left > 2:
            db.commit()
            raise AppError(409, "TOO_EARLY", f"Còn {left:.0f} giây để trả lời.", {"remaining_seconds": round(left, 1)})
        _apply_timeout(db, s, "client_reported_timeout")
    db.commit()
    status = session_status(db, s)
    lr = s.last_result or {}
    status["tutor_self_answer"] = lr.get("feedback") if lr.get("type") == "timeout" else None
    status["cooldown_seconds"] = settings.agent_cooldown_seconds
    return status


def resume(db: Session, user: Principal, video_id: str, current_time: float | None = None) -> dict:
    s = lock_session(db, user.user_id, video_id)
    if current_time is not None:
        s.current_video_time = current_time
    refresh(db, s)
    if s.current_state in QUESTION_ACTIVE_STATES:
        db.commit()
        raise AppError(409, "ANSWER_REQUIRED", "Hãy trả lời câu hỏi (hoặc chờ hết giờ) trước khi tiếp tục video.",
                       {"state": s.current_state})
    if s.current_state in (S.TUTOR_FEEDBACK.value, S.TUTOR_SELF_ANSWER.value):
        _resume(db, s, "student_resumed")
    db.commit()
    return {**session_status(db, s), "message": "Video tiếp tục phát."}


def active_question_for_hint(db: Session, user: Principal, video_id: str | None = None) -> VideoQuestion | None:
    """Câu hỏi đang mở của học sinh (dùng để bật hint mode cho Tutor). Không khóa, không đổi trạng thái."""
    q = db.query(VideoSession).filter(VideoSession.student_id == user.user_id,
                                      VideoSession.current_state.in_(list(QUESTION_ACTIVE_STATES)))
    if video_id:
        q = q.filter(VideoSession.video_id == video_id)
    now = utcnow()
    for s in q.all():
        if s.current_state == S.WAITING_FOR_STUDENT.value and s.question_deadline_at \
                and as_aware(s.question_deadline_at) <= now:
            continue
        if s.active_question_id:
            return db.get(VideoQuestion, s.active_question_id)
    return None


def sweep_expired(db: Session) -> int:
    """Quét nền: áp dụng timeout / giải phóng trạng thái kẹt cho các phiên không còn request."""
    now = utcnow()
    candidates = db.query(VideoSession.student_id, VideoSession.video_id).filter(
        ((VideoSession.current_state == S.WAITING_FOR_STUDENT.value) & (VideoSession.question_deadline_at <= now)) |
        (VideoSession.current_state.in_([S.GENERATE_QUESTION.value, S.STUDENT_ANSWER.value, S.PAUSE_VIDEO.value,
                                         S.TIMEOUT.value, S.RESUME_VIDEO.value]))
    ).all()
    n = 0
    for student_id, video_id in candidates:
        try:
            s = lock_session(db, student_id, video_id)
            before = s.current_state
            refresh(db, s)
            db.commit()
            n += int(before != s.current_state)
        except Exception:
            db.rollback()
            log.exception("sweep_failed")
    return n
