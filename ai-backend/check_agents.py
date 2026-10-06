"""Chẩn đoán 2 AI trong video: Question Agent (hỏi) và Tutor AI (giải thích đáp án).

Chạy trong thư mục ai-backend (cùng .env với server):
    python check_agents.py            # kiểm tra cấu hình + dữ liệu + gọi thử LLM
    python check_agents.py --no-llm   # chỉ kiểm tra dữ liệu, không gọi LLM

Script không in khóa API.
"""
import sys
from datetime import timedelta

from app.config import settings
from app.core.utils import fmt_ts, utcnow

OK, WARN, BAD = "  [OK] ", "  [!]  ", "  [X]  "


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def check_config() -> bool:
    section("Cấu hình LLM")
    provider = settings.llm_provider.lower()
    print(f"  LLM_PROVIDER = {provider}, model = {settings.current_llm_model()}")
    key = settings.claude_api_key if provider == "claude" else settings.openai_api_key
    if provider not in ("claude", "openai"):
        print(BAD + "LLM_PROVIDER phải là 'claude' hoặc 'openai'.")
        return False
    if not key:
        print(BAD + f"Chưa có khóa API cho provider '{provider}' trong .env -> cả 2 AI đều không chạy được.")
        return False
    print(OK + "Đã có khóa API (không hiển thị).")
    print(f"  Cooldown giữa 2 lần AI hỏi: {settings.agent_cooldown_seconds}s · không hỏi trong ±"
          f"{settings.scheduled_question_proximity_seconds:.0f}s quanh câu hỏi của giáo viên · cửa sổ lời giảng "
          f"{settings.agent_transcript_window_seconds:.0f}s")
    return True


def check_data() -> str | None:
    """Trả về video_id có transcript để gọi thử."""
    from app.database import SessionLocal
    from app.models.learning import MediaVideo
    from app.models.observability import AIJob, AILLMCall
    from app.models.video_question import VideoQuestion
    from app.models.workflow import VideoSession
    from app.services.retrieval import active_transcript, transcript_window

    db = SessionLocal()
    sample = None
    try:
        section("Video & phụ đề (Question Agent cần phụ đề)")
        videos = db.query(MediaVideo).all()
        if not videos:
            print(WARN + "Chưa có video nào.")
        for v in videos:
            tr = active_transcript(db, v.video_id)
            qs = (db.query(VideoQuestion.timestamp).filter(VideoQuestion.video_id == v.video_id,
                                                           VideoQuestion.status == "approved",
                                                           VideoQuestion.origin != "agent")
                  .order_by(VideoQuestion.timestamp).all())
            marks = ", ".join(fmt_ts(t) for (t,) in qs) or "không có"
            if tr is None:
                print(BAD + f"{v.video_id} ({v.title}): CHƯA có phụ đề sẵn sàng -> Question Agent sẽ không hỏi.")
            else:
                segs, _ = transcript_window(db, v.video_id, 0, 10 ** 7)
                print(OK + f"{v.video_id} ({v.title}): {len(segs)} đoạn phụ đề; câu hỏi GV tại: {marks}")
                sample = sample or v.video_id

        section("Phiên học chưa về trạng thái xem video (AI sẽ chưa hỏi thêm)")
        stuck = db.query(VideoSession).filter(VideoSession.current_state.notin_(["VIDEO_PLAYING", "COOLDOWN"])).all()
        for s in stuck:
            print(WARN + f"{s.student_id} / {s.video_id}: {s.current_state} (đổi lúc {s.state_changed_at})")
        if not stuck:
            print(OK + "Không có.")

        section("Lỗi gần đây của 2 AI (24 giờ)")
        since = utcnow() - timedelta(hours=24)
        calls = (db.query(AILLMCall).filter(AILLMCall.task.in_(["agent_question", "tutor_explain"]),
                                            AILLMCall.created_at >= since)
                 .order_by(AILLMCall.created_at.desc()).limit(30).all())
        if not calls:
            print(WARN + "Không có lượt gọi nào trong 24 giờ: AI chưa từng được kích hoạt "
                         "(kiểm tra đã bật 'AI hỏi mở rộng' trên trình phát chưa).")
        for c in calls[:10]:
            mark = OK if c.status == "ok" else BAD
            print(mark + f"{c.created_at:%H:%M:%S} {c.task:15s} {c.status:14s} {c.model or ''} "
                         f"{(c.error or '')[:160]}")
        jobs = (db.query(AIJob).filter(AIJob.job_type == "tutor_explain", AIJob.status == "failed",
                                       AIJob.created_at >= since).order_by(AIJob.created_at.desc()).limit(5).all())
        for j in jobs:
            print(BAD + f"job tutor_explain lỗi: {(j.error or '')[:200]}")
    finally:
        db.close()
    return sample


def check_llm(video_id: str | None) -> None:
    from app.core.llm_schemas import QuestionItem
    from app.core.prompts import QUESTION_AGENT, TUTOR_EXPLAIN, wrap_documents
    from app.services import llm

    if video_id:
        from app.database import SessionLocal
        from app.services.retrieval import format_segments, transcript_window
        db = SessionLocal()
        try:
            segs, _ = transcript_window(db, video_id, 0, settings.agent_transcript_window_seconds)
            context = format_segments(segs)
        finally:
            db.close()
    else:
        context = ("[00:00–00:10] Đóng gói là gom dữ liệu và phương thức vào trong một lớp.\n"
                   "[00:10–00:20] Đóng gói giúp che giấu chi tiết cài đặt bên trong lớp.")

    section("Gọi thử Question Agent (AI hỏi)")
    q = None
    try:
        q, res = llm.complete_json("agent_question", QUESTION_AGENT,
                                   f"{wrap_documents(context)}\n\nHãy sinh 1 câu hỏi mở rộng.", QuestionItem,
                                   max_tokens=1200)
        print(OK + f"{res.latency_ms:.0f} ms · {q.question}")
        for o in q.options or []:
            print(f"         {o}")
        print(f"         Đáp án: {q.correct_answer}")
    except Exception as e:
        print(BAD + f"{type(e).__name__}: {getattr(e, 'detail', e)}")

    section("Gọi thử Tutor AI (AI trả lời / giải thích)")
    try:
        question = q.question if q else "Đóng gói là gì?"
        answer = q.correct_answer if q else "Gom dữ liệu và phương thức vào lớp"
        res = llm.complete_text("tutor_explain", TUTOR_EXPLAIN,
                                f"{wrap_documents(context)}\n\nCâu hỏi: {question}\nĐáp án đúng: {answer}\n"
                                "Học sinh KHÔNG trả lời kịp (hết giờ).\nHãy giải thích cho học sinh.", max_tokens=600)
        print(OK + f"{res.latency_ms:.0f} ms · {res.text.strip()[:400]}")
    except Exception as e:
        print(BAD + f"{type(e).__name__}: {getattr(e, 'detail', e)}")


if __name__ == "__main__":
    config_ok = check_config()
    try:
        vid = check_data()
    except Exception as e:
        print(BAD + f"Không đọc được database: {e}")
        vid = None
    if "--no-llm" not in sys.argv and config_ok:
        check_llm(vid)
    print()
