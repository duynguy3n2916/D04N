"""Chấm câu trả lời học sinh."""
from app.core.llm_schemas import GradeOutput
from app.core.prompts import GRADER
from app.core.utils import resolve_option_index, strip_option_label
from app.models.video_question import VideoQuestion
from app.services import llm


def correct_answer_text(q: VideoQuestion) -> str:
    if q.options and q.correct_index is not None and 0 <= q.correct_index < len(q.options):
        return q.options[q.correct_index]
    return q.answer or ""


def grade(q: VideoQuestion, student_answer: str | None, selected_index: int | None,
          user_id: str | None = None) -> dict:
    """Trả về {verdict, is_correct, feedback, feedback_status}. Không raise khi LLM lỗi (dùng phản hồi dự phòng)."""
    correct = correct_answer_text(q)
    explanation = q.explanation or ""
    if q.type in ("multiple_choice", "true_false") and q.options:
        idx = selected_index if selected_index is not None else resolve_option_index(q.options, student_answer)
        if q.correct_index is None:
            q.correct_index = resolve_option_index(q.options, q.answer)
        ok = idx is not None and idx == q.correct_index
        if ok:
            fb = f"Chính xác! {explanation}".strip()
        else:
            picked = f"Bạn chọn \"{strip_option_label(q.options[idx])}\". " if idx is not None and 0 <= idx < len(q.options) else ""
            fb = f"Chưa chính xác. {picked}Đáp án đúng: {correct}. {explanation}".strip()
        return {"verdict": "correct" if ok else "incorrect", "is_correct": ok, "feedback": fb,
                "feedback_status": "ready", "selected_index": idx}

    answer = (student_answer or "").strip()
    if not answer:
        return {"verdict": "incorrect", "is_correct": False, "feedback_status": "ready",
                "feedback": f"Bạn chưa nhập câu trả lời. Đáp án mẫu: {correct}. {explanation}".strip()}
    prompt = (f"Câu hỏi: {q.question}\nĐáp án mẫu: {correct}\nGiải thích: {explanation}\n\n"
              f"Câu trả lời của học sinh: {answer}\n\n"
              "Đánh giá verdict (correct / partial / incorrect) và viết feedback 2-3 câu.")
    try:
        out, _ = llm.complete_json("grade", GRADER, prompt, GradeOutput, max_tokens=600, user_id=user_id)
        return {"verdict": out.verdict, "is_correct": out.verdict == "correct", "feedback": out.feedback,
                "feedback_status": "ready"}
    except Exception:
        return {"verdict": "partial", "is_correct": None, "feedback_status": "fallback",
                "feedback": f"Hệ thống chưa chấm tự động được câu này. Đáp án mẫu: {correct}. {explanation}".strip()}
