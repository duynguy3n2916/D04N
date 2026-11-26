"""Tutor Agent: hội thoại có căn cứ trên RAG, ưu tiên lời giảng quanh thời điểm video, khóa đáp án khi đang kiểm tra."""
import logging
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.core.context import get_request_id
from app.core.errors import AppError
from app.core.security import Principal
from app.core.utils import fmt_ts, normalize_text, redact_pii, strip_option_label, utcnow
from app.models.conversation import AIConversation, AIMessage
from app.models.documents import AIChunk, AIDocument
from app.services.ai import llm
from app.services.ai.grading import correct_answer_text
from app.services.ai.prompts import CONVERSATION_SUMMARY, TUTOR_ANSWER, TUTOR_HINT, wrap_documents
from app.services.courses import learning, workflow
from app.services.rag.hybrid import rrf
from app.services.rag.retrieval import (
    RetrievalScope,
    _apply_scope,
    _row_to_dict,
    build_context,
    contextual_query,
    expand_neighbors,
    format_segments,
    retrieve,
    transcript_window,
)

log = logging.getLogger("app.tutor")

REFUSAL = ("Mình chưa tìm thấy thông tin liên quan trong học liệu của bài này. "
           "Bạn thử hỏi cụ thể hơn, hoặc nhờ giáo viên bổ sung tài liệu nhé.")
HINT_REDACTED = ("Câu hỏi kiểm tra đang diễn ra nên mình chưa thể nói đáp án. Gợi ý: hãy nhớ lại khái niệm chính "
                 "vừa được giảng ngay trước đó và loại dần các lựa chọn không phù hợp với định nghĩa.")
MAX_GUARDED_QUESTIONS_IN_PROMPT = 10
REFUSAL_MARK = "chưa tìm thấy thông tin"  # khớp câu từ chối trong prompt TUTOR_ANSWER
QUIZ_LOCKED = ("Bạn đang làm bài trắc nghiệm nên Tutor AI tạm khóa để bài làm công bằng. "
               "Nộp bài xong bạn hỏi lại nhé, mình sẽ giải thích các câu còn chưa chắc.")

# "phút 2:30", "ở 02:30", "1:02:03", "phút thứ 3", "phút 3 giây 20", "giây 45"
_TS_CLOCK = re.compile(r"(?<![\d:])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?![\d:])")
_TS_WORDS = re.compile(r"phút\s*(?:thứ\s*)?(\d{1,3})(?:\s*(?:giây|:)\s*(\d{1,2}))?|(\d{1,4})\s*giây|giây\s*(?:thứ\s*)?(\d{1,4})", re.IGNORECASE)


def mentioned_time(question: str) -> float | None:
    """Thời điểm video học sinh nêu trong câu hỏi (giây), nếu có."""
    m = _TS_CLOCK.search(question or "")
    if m:
        h, mi, se = int(m.group(1) or 0), int(m.group(2)), int(m.group(3))
        if se < 60:
            return float(h * 3600 + mi * 60 + se)
    m = _TS_WORDS.search(question or "")
    if m:
        if m.group(1):
            return float(int(m.group(1)) * 60 + int(m.group(2) or 0))
        return float(int(m.group(3) or m.group(4)))
    return None


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


def _leaks_answer(answer: str, q) -> bool:
    """q: VideoQuestion hoặc câu ngân hàng (cùng các thuộc tính type/options/correct_index/answer)."""
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


@dataclass
class TurnPlan:
    """Mọi thứ đã quyết định trước khi gọi LLM cho một lượt hỏi (dùng chung cho trả lời thường và streaming)."""
    conv: AIConversation
    question: str
    lesson_id: str | None
    video_id: str | None
    video_time: float | None
    hint_mode: bool
    guarded: list
    sources: list[dict]
    history: list[dict]
    meta: dict
    transcript_block: dict | None
    prompt: object | None = None  # None -> từ chối, không gọi LLM
    user_content: str = ""
    chunk_ids: list[str] = field(default_factory=list)


def prepare_turn(db: Session, user: Principal, *, question: str, conversation_id=None, course_id=None, class_id=None,
                 lesson_id=None, video_id=None, video_time: float | None = None, top_k: int | None = None,
                 focus_document_id=None, focus_page: int | None = None, selected_text: str | None = None) -> TurnPlan:
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

    if settings.redact_pii:
        question = redact_pii(question)
        selected_text = redact_pii(selected_text) if selected_text else selected_text

    # Hint mode do server quyết định (câu hỏi video đang mở hoặc bài kiểm tra đang làm dở), không tin cờ client
    # Đang làm bài trắc nghiệm: khóa hẳn Tutor (không gọi LLM, không tính lượt).
    # Câu hỏi bật lên giữa video vẫn dùng chế độ gợi ý (không lộ đáp án).
    guarded: list = []
    if not user.is_teacher:
        if learning.active_quiz_questions(db, user):
            raise AppError(403, "TUTOR_LOCKED_QUIZ", QUIZ_LOCKED)
        active_q = workflow.active_question_for_hint(db, user, video_id)
        guarded = [active_q] if active_q else []
    hint_mode = bool(guarded)
    asked_time = mentioned_time(question) if video_id else None

    history = _history(db, conv)
    scope = RetrievalScope.for_user(user, course_id=course_id, class_id=class_id, lesson_id=lesson_id)
    chunks = retrieve(db, question, scope, top_k=top_k)
    follow_up = contextual_query(question, history)
    if follow_up != question:
        # Câu hỏi nối tiếp: truy xuất thêm với câu đã ghép ngữ cảnh rồi hợp nhất RRF; danh sách của câu hiện tại
        # đứng trước để chủ đề mới ("còn kế thừa...") không bị chủ đề cũ lấn át.
        extra = retrieve(db, follow_up, scope, top_k=top_k)
        by_id = {c["chunk_id"]: c for c in extra + chunks}
        fused = rrf([[c["chunk_id"] for c in chunks], [c["chunk_id"] for c in extra]])
        chunks = [by_id[k] for k in sorted(fused, key=fused.get, reverse=True)][:top_k or settings.rag_top_k]
    if video_id:
        # chunk transcript của video hiện tại đã được đưa riêng qua cửa sổ thời gian
        focus_t = asked_time if asked_time is not None else video_time
        if focus_t is not None:
            chunks = [c for c in chunks if not (c["source_type"] == "video" and c["source_id"] == video_id
                                                and c["start_time"] is not None
                                                and abs((c["start_time"] or 0) - focus_t) < 120)]
    if settings.rag_expand_neighbors:
        chunks = expand_neighbors(db, chunks)

    transcript_block = None
    if video_id and (video_time is not None or asked_time is not None):
        # Hỏi về một mốc cụ thể ("phút 2:30 nói gì") -> lấy quanh mốc đó; không thì lấy đoạn VỪA nghe
        # (90 giây trước tới 15 giây sau vị trí đang phát) để hiểu "đoạn này", "video đang nói gì".
        center = asked_time if asked_time is not None else video_time
        start, end = (center - 45, center + 60) if asked_time is not None else (center - 90, center + 15)
        segs, _ = transcript_window(db, video_id, start, end)
        if segs:
            transcript_block = {
                "content": format_segments(segs), "source_type": "video", "source_id": video_id,
                # nút nguồn tua tới ngay trước đoạn đang hỏi (không phải đầu cửa sổ 90 giây)
                "start_time": next((x.start_time for x in reversed(segs) if x.start_time <= center - 15), segs[0].start_time),
                "end_time": segs[-1].end_time,
                "label": f"Lời giảng video {video_id} quanh {fmt_ts(center)} "
                         f"({fmt_ts(segs[0].start_time)}–{fmt_ts(segs[-1].end_time)})",
                "document_title": f"Video {video_id}",
            }

    # Slide / tài liệu đang mở: ưu tiên nội dung đúng trang học sinh đang xem
    if focus_document_id is not None:
        doc = db.execute(_apply_scope(select(AIDocument), scope).where(AIDocument.id == focus_document_id)).scalar_one_or_none()
        if doc and user.can_access_class(doc.class_id):
            q = db.query(AIChunk).filter(AIChunk.document_id == doc.id)
            if focus_page is not None:
                q = q.filter(AIChunk.page == focus_page)
            focus = [_row_to_dict(c, doc, None) for c in q.order_by(AIChunk.chunk_index).limit(3).all()]
            focus_ids = {f["chunk_id"] for f in focus}
            chunks = focus + [c for c in chunks if c["chunk_id"] not in focus_ids]

    meta = {"hint_mode": hint_mode, "request_id": get_request_id()}
    if selected_text and not chunks and not transcript_block:
        # Đoạn bôi đen do client gửi lên nên KHÔNG được dùng làm học liệu (sẽ lách được cơ chế từ chối).
        # Dùng nó để truy xuất lại; vẫn phải qua ngưỡng điểm và phạm vi quyền như câu hỏi thường.
        chunks = retrieve(db, selected_text[:2000], scope, top_k=top_k)
    plan = TurnPlan(conv=conv, question=question, lesson_id=lesson_id, video_id=video_id, video_time=video_time,
                    hint_mode=hint_mode, guarded=guarded, sources=[], history=history, meta=meta,
                    transcript_block=transcript_block)
    if not chunks and not transcript_block:
        meta["refused"] = True
        return plan

    context, plan.sources = build_context(chunks, transcript_block)
    plan.prompt = TUTOR_HINT if hint_mode else TUTOR_ANSWER
    user_content = f"{wrap_documents(context)}\n\n"
    if video_id and video_time is not None:
        user_content += (f"Học sinh đang xem video, vị trí phát hiện tại: {fmt_ts(video_time)}. "
                         "Câu hỏi không nêu rõ chủ đề (\"đoạn này\", \"video đang nói gì\", \"vừa nói gì\"...) "
                         "là hỏi về lời giảng ngay trước vị trí này.\n")
    if asked_time is not None:
        user_content += f"Học sinh hỏi về mốc {fmt_ts(asked_time)} trong video.\n"
    if video_id and (video_time is not None or asked_time is not None):
        user_content += "\n"
    if selected_text:
        user_content += f"Học sinh đang hỏi về đoạn sau trong bài:\n«{selected_text[:2000]}»\n\n"
    user_content += f"Câu hỏi của học sinh: {question}"
    if hint_mode:
        open_qs = "\n".join(f"- {q.question}" for q in guarded[:MAX_GUARDED_QUESTIONS_IN_PROMPT])
        user_content += f"\n\n(Câu hỏi kiểm tra đang mở, không được nêu đáp án:\n{open_qs})"
    plan.user_content = user_content
    plan.chunk_ids = [s["chunk_id"] for s in plan.sources if s.get("chunk_id")]
    return plan


def finish_turn(db: Session, user: Principal, plan: TurnPlan, raw_answer: str | None,
                res: "llm.LLMResult | None") -> dict:
    """Guardrail đầu ra + lưu hai tin nhắn + kết quả trả về client."""
    meta = plan.meta
    if plan.prompt is None:
        answer = REFUSAL
    else:
        answer = (raw_answer or "").strip() or REFUSAL
        if plan.hint_mode and any(_leaks_answer(answer, q) for q in plan.guarded):
            answer = HINT_REDACTED
            meta["guardrail"] = "answer_redacted"
        elif REFUSAL_MARK in answer.lower():
            # LLM tự từ chối theo đúng câu trong prompt: vẫn đếm vào tỉ lệ từ chối.
            # Không dùng cụm rộng như "không tìm thấy" vì hay xuất hiện trong lời giải thích bình thường.
            meta["refused"] = True
        if res is not None:
            meta["llm_call_ids"] = res.call_ids
            meta["prompt_version"] = f"{res.prompt_id}:{res.prompt_version}"

    asked_at = utcnow()
    db.add(AIMessage(conversation_id=plan.conv.id, role="user", content=plan.question, created_at=asked_at,
                     meta={"video_id": plan.video_id, "video_time": plan.video_time}))
    db.add(AIMessage(conversation_id=plan.conv.id, role="assistant", content=answer, sources=plan.sources, meta=meta,
                     created_at=asked_at + timedelta(milliseconds=1)))
    db.commit()
    _maybe_summarize(db, plan.conv, user)

    return {
        "answer": answer,
        "sources": plan.sources,
        "conversation_id": str(plan.conv.id),
        "hint_mode": plan.hint_mode,
        "video_question_active": plan.hint_mode,
        "refused": bool(meta.get("refused")),
        "redacted": meta.get("guardrail") == "answer_redacted",
        "transcript_context": plan.transcript_block["content"] if plan.transcript_block else None,
        "model": res.model if res else None,
        "prompt_version": meta.get("prompt_version"),
        "request_id": get_request_id(),
        "quota": tutor_quota(db, user, plan.lesson_id),
    }


def ask(db: Session, user: Principal, **kw) -> dict:
    plan = prepare_turn(db, user, **kw)
    res = None
    if plan.prompt is not None:
        res = llm.complete_text("tutor", plan.prompt, plan.user_content, history=plan.history, max_tokens=1500,
                                chunk_ids=plan.chunk_ids, user_id=user.user_id)
    return finish_turn(db, user, plan, res.text if res else None, res)


def ask_stream(db: Session, user: Principal, plan: TurnPlan) -> Iterator[dict]:
    """Sự kiện streaming: `meta` (nguồn, hint mode) -> nhiều `delta` -> `done` (câu trả lời cuối đã qua guardrail).

    Ở hint mode KHÔNG phát từng phần: phải có đủ câu trả lời mới kiểm tra được lộ đáp án, nên chỉ gửi ở `done`.
    """
    yield {"event": "meta", "data": {"conversation_id": str(plan.conv.id), "sources": plan.sources,
                                     "hint_mode": plan.hint_mode, "refused": plan.prompt is None}}
    res = None
    text = None
    if plan.prompt is not None:
        parts: list[str] = []
        try:
            stream = llm.stream_text("tutor", plan.prompt, plan.user_content, history=plan.history, max_tokens=1500,
                                     chunk_ids=plan.chunk_ids, user_id=user.user_id)
            for piece in stream:
                if isinstance(piece, llm.LLMResult):
                    res = piece
                    continue
                parts.append(piece)
                if not plan.hint_mode:
                    yield {"event": "delta", "data": {"text": piece}}
        except AppError as e:
            yield {"event": "error", "data": {"code": e.code, "message": str(e.detail)}}
            return
        text = "".join(parts)
    yield {"event": "done", "data": finish_turn(db, user, plan, text, res)}
