"""Tutor Agent: hội thoại có căn cứ trên RAG, ưu tiên lời giảng quanh thời điểm video, khóa đáp án khi đang kiểm tra."""
import logging
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.core.context import get_request_id
from app.core.errors import AppError
from app.core.prompts import CONVERSATION_SUMMARY, TUTOR_ANSWER, TUTOR_HINT, wrap_documents
from app.core.security import Principal
from app.core.utils import fmt_ts, normalize_text, strip_option_label, utcnow
from app.models.conversation import AIConversation, AIMessage
from app.models.documents import AIChunk, AIDocument
from app.models.video_question import VideoQuestion
from app.services import llm, workflow
from app.services.grading import correct_answer_text
from app.services.retrieval import (RetrievalScope, _row_to_dict, build_context, expand_neighbors, format_segments, retrieve,
                                    transcript_window)

log = logging.getLogger("app.tutor")

REFUSAL = ("Mình chưa tìm thấy thông tin liên quan trong học liệu của bài này. "
           "Bạn thử hỏi cụ thể hơn, hoặc nhờ giáo viên bổ sung tài liệu nhé.")
HINT_REDACTED = ("Câu hỏi kiểm tra đang diễn ra nên mình chưa thể nói đáp án. Gợi ý: hãy nhớ lại khái niệm chính "
                 "vừa được giảng ngay trước đó và loại dần các lựa chọn không phù hợp với định nghĩa.")


def get_or_create_conversation(db: Session, user: Principal, conversation_id, *, course_id=None, class_id=None,
                               lesson_id=None, video_id=None) -> AIConversation:
    if conversation_id:
        conv = db.get(AIConversation, conversation_id)
        if not conv:
            raise AppError(404, "CONVERSATION_NOT_FOUND", "Không tìm thấy hội thoại.")
        if conv.student_id != user.user_id and not user.is_admin:
            raise AppError(403, "FORBIDDEN", "Hội thoại thuộc người dùng khác.")
        return conv
    conv = AIConversation(student_id=user.user_id, course_id=course_id, class_id=class_id, lesson_id=lesson_id,
                          video_id=video_id)
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return conv


def _history(db: Session, conv: AIConversation) -> list[dict]:
    rows = (db.query(AIMessage).filter(AIMessage.conversation_id == conv.id)
            .order_by(AIMessage.created_at.desc()).limit(settings.chat_history_turns * 2).all())
    rows.reverse()
    hist = [{"role": r.role, "content": r.content} for r in rows]
    if conv.summary:
        hist = [{"role": "user", "content": f"(Tóm tắt phần trò chuyện trước: {conv.summary})"},
                {"role": "assistant", "content": "Mình đã nắm nội dung trước đó."}] + hist
    return hist


def _maybe_summarize(db: Session, conv: AIConversation, user: Principal) -> None:
    total = db.query(AIMessage).filter(AIMessage.conversation_id == conv.id).count()
    done = conv.summary_message_count or 0
    if total < settings.chat_summary_after_messages or total - done < settings.chat_summary_after_messages // 2:
        return
    keep = settings.chat_history_turns * 2
    older = (db.query(AIMessage).filter(AIMessage.conversation_id == conv.id)
             .order_by(AIMessage.created_at).limit(max(0, total - keep)).all())
    if not older:
        return
    transcript = "\n".join(f"{'Học sinh' if m.role == 'user' else 'Tutor'}: {m.content[:600]}" for m in older)
    if conv.summary:
        transcript = f"Tóm tắt cũ: {conv.summary}\n\n{transcript}"
    try:
        res = llm.complete_text("tutor_summary", CONVERSATION_SUMMARY, transcript, max_tokens=300, user_id=user.user_id)
        conv.summary = res.text.strip()[:2000]
        conv.summary_message_count = total
        db.commit()
    except Exception:
        db.rollback()  # tóm tắt là phụ, không làm hỏng lượt chat


def _leaks_answer(answer: str, q: VideoQuestion) -> bool:
    text = normalize_text(answer)
    if q.options and q.correct_index is not None:
        letter = "abcdefgh"[q.correct_index]
        if re.search(rf"(đáp án|lựa chọn|phương án|chọn|câu)\s*(đúng\s*)?(là\s*)?[:\-]?\s*\(?{letter}\b", text):
            return True
    body = normalize_text(strip_option_label(correct_answer_text(q)))
    # nội dung đáp án đúng (đủ dài để không trùng ngẫu nhiên) xuất hiện nguyên văn
    return q.type == "multiple_choice" and len(body) > 12 and body in text


def _day_start_utc() -> tuple[datetime, datetime]:
    """0 giờ hôm nay theo múi giờ ứng dụng, quy về UTC (để so với created_at lưu dạng UTC)."""
    try:
        tz = ZoneInfo(settings.app_timezone)
    except Exception:
        tz = timezone.utc
    local = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    return local, local.astimezone(timezone.utc)


def tutor_quota(db: Session, user: Principal, lesson_id: str | None) -> dict | None:
    """Số lượt hỏi Tutor còn lại cho (học sinh, bài, hôm nay). None nếu không áp dụng giới hạn."""
    limit = settings.tutor_daily_limit_per_lesson
    if user.is_teacher or not lesson_id or limit <= 0:
        return None
    day_local, day_utc = _day_start_utc()
    used = (db.query(func.count(AIMessage.id))
            .join(AIConversation, AIMessage.conversation_id == AIConversation.id)
            .filter(AIConversation.student_id == user.user_id, AIConversation.lesson_id == lesson_id,
                    AIMessage.role == "user", AIMessage.created_at >= day_utc)
            .scalar() or 0)
    return {"used": int(used), "limit": limit, "remaining": max(0, limit - int(used)),
            "resets_at": (day_local + timedelta(days=1)).isoformat()}


def ask(db: Session, user: Principal, *, question: str, conversation_id=None, course_id=None, class_id=None,
        lesson_id=None, video_id=None, video_time: float | None = None, top_k: int | None = None,
        focus_document_id=None, focus_page: int | None = None, selected_text: str | None = None) -> dict:
    conv = get_or_create_conversation(db, user, conversation_id, course_id=course_id, class_id=class_id,
                                      lesson_id=lesson_id, video_id=video_id)
    lesson_id = lesson_id or conv.lesson_id
    course_id = course_id or conv.course_id
    video_id = video_id or conv.video_id

    # Giới hạn số lượt hỏi Tutor mỗi bài / ngày (đếm trước khi gọi LLM, không tạo tin nhắn nếu vượt)
    quota = tutor_quota(db, user, lesson_id)
    if quota and quota["remaining"] <= 0:
        raise AppError(429, "TUTOR_QUOTA_EXCEEDED",
                       f"Bạn đã dùng hết {quota['limit']} lượt hỏi Tutor cho bài này hôm nay. "
                       "Hãy xem lại các nguồn Tutor đã trích hoặc quay lại vào ngày mai nhé. "
                       "Video, slide và bài kiểm tra vẫn học bình thường.", quota)

    # Hint mode do server quyết định từ trạng thái phiên video, không tin cờ phía client
    active_q = workflow.active_question_for_hint(db, user, video_id) if not user.is_teacher else None
    hint_mode = active_q is not None

    scope = RetrievalScope.for_user(user, course_id=course_id, class_id=class_id, lesson_id=lesson_id)
    chunks = retrieve(db, question, scope, top_k=top_k)
    if video_id:
        # chunk transcript của video hiện tại đã được đưa riêng qua cửa sổ thời gian
        if video_time is not None:
            chunks = [c for c in chunks if not (c["source_type"] == "video" and c["source_id"] == video_id
                                                and c["start_time"] is not None
                                                and abs((c["start_time"] or 0) - video_time) < 120)]
    if settings.rag_expand_neighbors:
        chunks = expand_neighbors(db, chunks)

    transcript_block = None
    if video_id and video_time is not None:
        segs, _ = transcript_window(db, video_id, video_time - 90, video_time + 15)
        if segs:
            transcript_block = {
                "content": format_segments(segs), "source_type": "video", "source_id": video_id,
                "start_time": segs[0].start_time, "end_time": segs[-1].end_time,
                "label": f"Lời giảng video {video_id} quanh {fmt_ts(video_time)} "
                         f"({fmt_ts(segs[0].start_time)}–{fmt_ts(segs[-1].end_time)})",
                "document_title": f"Video {video_id}",
            }

    # Slide / tài liệu đang mở: ưu tiên nội dung đúng trang học sinh đang xem
    if focus_document_id is not None:
        doc = db.get(AIDocument, focus_document_id)
        if doc and user.can_access_class(doc.class_id):
            q = db.query(AIChunk).filter(AIChunk.document_id == doc.id)
            if focus_page is not None:
                q = q.filter(AIChunk.page == focus_page)
            focus = [_row_to_dict(c, doc, None) for c in q.order_by(AIChunk.chunk_index).limit(3).all()]
            focus_ids = {f["chunk_id"] for f in focus}
            chunks = focus + [c for c in chunks if c["chunk_id"] not in focus_ids]

    history = _history(db, conv)
    meta = {"hint_mode": hint_mode, "request_id": get_request_id()}
    if selected_text and not chunks and not transcript_block:
        chunks = [{"chunk_id": None, "content": selected_text[:2000], "source_type": "selection",
                   "label": "Đoạn học sinh đang chọn", "document_title": "Đoạn đang chọn"}]
    if not chunks and not transcript_block:
        answer, sources, res = REFUSAL, [], None
        meta["refused"] = True
    else:
        context, sources = build_context(chunks, transcript_block)
        prompt = TUTOR_HINT if hint_mode else TUTOR_ANSWER
        user_content = f"{wrap_documents(context)}\n\n"
        if selected_text:
            user_content += f"Học sinh đang hỏi về đoạn sau trong bài:\n«{selected_text[:2000]}»\n\n"
        user_content += f"Câu hỏi của học sinh: {question}"
        if hint_mode:
            user_content += f"\n\n(Câu hỏi kiểm tra đang mở: {active_q.question})"
        res = llm.complete_text("tutor", prompt, user_content, history=history, max_tokens=1500,
                                chunk_ids=[s["chunk_id"] for s in sources if s.get("chunk_id")],
                                user_id=user.user_id)
        answer = res.text.strip() or REFUSAL
        if hint_mode and _leaks_answer(answer, active_q):
            answer = HINT_REDACTED
            meta["guardrail"] = "answer_redacted"
        meta["llm_call_ids"] = res.call_ids
        meta["prompt_version"] = f"{res.prompt_id}:{res.prompt_version}"

    asked_at = utcnow()
    db.add(AIMessage(conversation_id=conv.id, role="user", content=question, created_at=asked_at,
                     meta={"video_id": video_id, "video_time": video_time}))
    db.add(AIMessage(conversation_id=conv.id, role="assistant", content=answer, sources=sources, meta=meta,
                     created_at=asked_at + timedelta(milliseconds=1)))
    db.commit()
    _maybe_summarize(db, conv, user)

    return {
        "answer": answer,
        "sources": sources,
        "conversation_id": str(conv.id),
        "hint_mode": hint_mode,
        "video_question_active": hint_mode,
        "refused": bool(meta.get("refused")),
        "transcript_context": transcript_block["content"] if transcript_block else None,
        "model": res.model if res else None,
        "prompt_version": meta.get("prompt_version"),
        "request_id": get_request_id(),
        "quota": tutor_quota(db, user, lesson_id),
    }
