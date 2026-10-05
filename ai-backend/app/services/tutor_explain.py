"""Tutor AI tự giải thích đáp án sau câu hỏi trong video.

Luồng "2 AI": Question Agent (hoặc giáo viên) đặt câu hỏi -> học sinh hết giờ / trả lời sai ->
Tutor AI (LLM thứ hai, độc lập với AI ra đề) đọc lại lời giảng quanh mốc câu hỏi + học liệu của bài
và giải thích vì sao đáp án đúng, có trích nguồn [S#].

Chạy nền (job "tutor_explain") để popup hiện ngay đáp án; lời giải thích của Tutor được cập nhật vào
`video_sessions.last_result` và `ai_interactions`, giao diện thăm dò `/ai/workflow/session` để hiển thị.
Lỗi LLM không ảnh hưởng luồng học: học sinh vẫn thấy đáp án + lời giải gốc.
"""
import logging

from sqlalchemy.orm import Session

from app.core.prompts import TUTOR_EXPLAIN, wrap_documents
from app.core.utils import fmt_ts
from app.models.video_question import AIInteraction, VideoQuestion
from app.models.workflow import VideoSession
from app.services import jobs, llm
from app.services.retrieval import RetrievalScope, build_context, format_segments, retrieve, transcript_window

log = logging.getLogger("app.tutor_explain")


def _context(db: Session, q: VideoQuestion, class_ids: list[str] | None) -> tuple[str, list[dict]]:
    segs, tr = transcript_window(db, q.video_id, (q.timestamp or 0) - 90, (q.timestamp or 0) + 15)
    block = None
    if segs:
        block = {"content": format_segments(segs), "source_type": "video", "source_id": q.video_id,
                 "start_time": segs[0].start_time, "end_time": segs[-1].end_time,
                 "label": f"Lời giảng video {q.video_id} {fmt_ts(segs[0].start_time)}–{fmt_ts(segs[-1].end_time)}",
                 "document_title": f"Video {q.video_id}"}
    lesson_id = tr.lesson_id if tr is not None else None
    chunks: list[dict] = []
    if lesson_id:
        scope = RetrievalScope(allowed_class_ids=class_ids, lesson_id=lesson_id)
        query = q.question + " " + (q.answer or "")
        chunks = [c for c in retrieve(db, query, scope, top_k=3)
                  if not (c.get("source_type") == "video" and c.get("source_id") == q.video_id)]
    return build_context(chunks, block)


def _prompt(q: VideoQuestion, it: AIInteraction, context: str) -> str:
    opts = "\n".join(q.options or [])
    if it.interaction_type == "timeout":
        situation = "Học sinh KHÔNG trả lời kịp (hết giờ)."
    else:
        chosen = it.student_answer or ""
        if q.options and chosen.isdigit() and int(chosen) < len(q.options):
            chosen = q.options[int(chosen)]
        situation = f"Học sinh trả lời: {chosen} — chưa đúng."
    return (f"{wrap_documents(context) if context else ''}\n\n"
            f"Câu hỏi tại {fmt_ts(q.timestamp)}: {q.question}\n"
            + (f"Các lựa chọn:\n{opts}\n" if opts else "")
            + f"Đáp án đúng: {q.answer}\n"
            + (f"Lời giải gợi ý (của người ra đề): {q.explanation}\n" if q.explanation else "")
            + f"{situation}\nHãy giải thích cho học sinh.")


@jobs.register("tutor_explain")
def run_tutor_explain(ctx, interaction_id: str) -> dict:
    db = ctx.db
    it = db.get(AIInteraction, interaction_id)
    if it is None or it.question_id is None:
        return {"skipped": "no_interaction"}
    from app.models.accounts import User
    owner = db.get(User, it.student_id) if it.student_id else None
    class_ids = list(owner.class_ids or []) if owner else []
    q = db.get(VideoQuestion, it.question_id)
    try:
        context, sources = _context(db, q, class_ids)
        res = llm.complete_text("tutor_explain", TUTOR_EXPLAIN, _prompt(q, it, context), max_tokens=600,
                                user_id=it.student_id)
        text = res.text.strip()
        used = [s for s in sources if f"[{s['label']}]" in text] or sources[:1]
        status, explanation, src = "ready", text, used
    except Exception as e:  # LLM lỗi: giữ nguyên đáp án + lời giải gốc
        log.warning("tutor_explain_failed", extra={"extra_fields": {"interaction_id": interaction_id, "error": str(e)[:200]}})
        status, explanation, src = "failed", None, []

    it = db.get(AIInteraction, interaction_id)
    it.tutor_status, it.tutor_explanation, it.tutor_sources = status, explanation, src
    s = (db.query(VideoSession).filter(VideoSession.id == it.session_id).with_for_update().first()
         if it.session_id else None)
    if s is not None and s.last_result and s.last_result.get("interaction_id") == str(it.id):
        s.last_result = {**s.last_result, "tutor_status": status, "tutor_explanation": explanation, "tutor_sources": src}
    db.commit()
    return {"status": status}


def queue(db: Session, interaction: AIInteraction) -> None:
    """Gọi trong transaction đang mở; job chạy sau khi commit."""
    interaction.tutor_status = "pending"
    jobs.submit_after_commit(db, "tutor_explain", {"interaction_id": str(interaction.id)},
                             created_by=interaction.student_id)
