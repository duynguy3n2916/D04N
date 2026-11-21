"""Study Coach Agent: trợ lý học tập tự gọi tool trên dữ liệu thật của học sinh.

Vòng lặp: model đọc câu hỏi -> yêu cầu gọi tool (tiến độ, câu hay sai, thẻ đến hạn, học liệu, đề luyện)
-> server chạy tool trong phạm vi quyền của học sinh -> trả kết quả cho model -> ... -> câu trả lời cuối.

Nguyên tắc an toàn (do code kiểm soát, không phó mặc cho prompt):
- Số bước có giới hạn (settings.coach_max_steps); hết bước thì trả lời dựa trên những gì đã có.
- Tool chỉ đọc dữ liệu của chính học sinh và học liệu thuộc lớp của học sinh. Tool ghi duy nhất là
  queue_flashcards: chỉ đưa thẻ (câu đã duyệt) vào lịch ôn của chính học sinh đó.
- Không tool nào trả đáp án câu hỏi kiểm tra. Đang làm dở bài kiểm tra thì agent không chạy.
"""
import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.core.errors import AppError
from app.core.prompts import STUDY_COACH
from app.core.security import Principal
from app.core.utils import as_aware, parse_uuid, redact_pii, utcnow
from app.models.learning import FlashcardReview, ItemProgress, Lesson, LessonItem, QuizAnswerLog
from app.models.video_question import QuestionBankItem
from app.services import flashcards, learning, llm
from app.services.retrieval import RetrievalScope, retrieve, source_label

log = logging.getLogger("app.coach")

QUIZ_GUARD_MESSAGE = ("Bạn đang làm dở một bài kiểm tra. Trợ lý học tập tạm dừng để bài làm công bằng. "
                      "Hãy nộp bài xong rồi quay lại, mình sẽ giúp bạn ôn những câu còn yếu.")


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    handler: Callable[[Session, Principal, dict, "RunState"], dict]
    writes: bool = False

    def spec(self) -> dict:
        return {"name": self.name, "description": self.description, "parameters": self.parameters}


class RunState:
    """Những gì một lượt agent thu được: nguồn học liệu (nhãn S1, S2...) và các nút hành động cho giao diện."""

    def __init__(self):
        self.sources: list[dict] = []
        self.actions: list[dict] = []
        self._action_keys: set = set()

    def add_source(self, chunk: dict) -> str:
        for s in self.sources:
            if s.get("chunk_id") == chunk.get("chunk_id"):
                return s["label"]
        label = f"S{len(self.sources) + 1}"
        src = {k: v for k, v in chunk.items() if k != "content"}
        src["label"], src["display"] = label, source_label(chunk)
        self.sources.append(src)
        return label

    def add_action(self, kind: str, label: str, **data) -> None:
        key = (kind, data.get("item_id") or data.get("lesson_code"))
        if key in self._action_keys:
            return
        self._action_keys.add(key)
        self.actions.append({"type": kind, "label": label, **data})


# ----------------------------------------------------------------------------
# Tools
# ----------------------------------------------------------------------------

def _visible_lessons(db: Session, user: Principal) -> dict[str, Lesson]:
    return {ls.code: ls for c in learning.visible_courses(db, user) for ch in c.chapters for ls in ch.lessons}


def _lesson_or_error(db: Session, user: Principal, code: str | None) -> Lesson | None:
    if not code:
        return None
    lesson = _visible_lessons(db, user).get(str(code))
    if lesson is None:
        raise AppError(404, "NOT_FOUND", f"Không có bài học mã {code} trong các khóa học của bạn.")
    return lesson


def tool_get_progress(db: Session, user: Principal, args: dict, state: RunState) -> dict:
    out = []
    for course in learning.visible_courses(db, user):
        items, progress, status_of, current_id = learning._status_map(db, user, course)
        if not items:
            continue
        done = sum(1 for i in items if status_of[i.id] == "done")
        current = next((i for i in items if i.id == current_id), None)
        lessons = []
        for ch in course.chapters:
            for ls in ch.lessons:
                its = ls.items
                quiz = [{"item_id": str(i.id), "title": i.title,
                         "best_score": round(progress[i.id].score, 2) if progress.get(i.id) and progress[i.id].score is not None else None,
                         "passed": bool(progress.get(i.id) and progress[i.id].status == "completed")}
                        for i in its if i.type == "quiz"]
                lessons.append({"lesson_code": ls.code, "title": ls.title, "items_total": len(its),
                                "items_done": sum(1 for i in its if status_of[i.id] == "done"), "quizzes": quiz})
        out.append({"course": course.title, "items_total": len(items), "items_done": done,
                    "current_item": {"item_id": str(current.id), "lesson_id": str(current.lesson_id), "title": current.title,
                                     "type": current.type, "lesson_code": current.lesson.code} if current else None,
                    "lessons": lessons})
        if current:
            state.add_action("item", f"Học tiếp: {current.title}", item_id=str(current.id), lesson_id=str(current.lesson_id))
    stats = learning.stats(db, user)
    return {"courses": out, "streak_days": stats["streak_days"], "today_xp": stats["today_xp"],
            "daily_goal_xp": stats["daily_goal_xp"]}


def tool_get_weak_points(db: Session, user: Principal, args: dict, state: RunState) -> dict:
    lesson = _lesson_or_error(db, user, args.get("lesson_code"))
    limit = max(1, min(int(args.get("limit") or 8), 20))
    since = utcnow() - timedelta(days=60)
    rows = (db.query(QuizAnswerLog.question_id, QuizAnswerLog.correct, QuizAnswerLog.created_at)
            .filter(QuizAnswerLog.student_id == user.user_id, QuizAnswerLog.created_at >= since)
            .order_by(QuizAnswerLog.created_at).all())
    stat: dict[str, dict] = {}
    for qid, ok, at in rows:
        s = stat.setdefault(str(qid), {"wrong": 0, "right": 0, "last_correct": None})
        s["right" if ok else "wrong"] += 1
        s["last_correct"] = bool(ok)
    weak_ids = [k for k, s in stat.items() if s["wrong"] and not (s["last_correct"] and s["right"] >= 2)]
    if not weak_ids:
        return {"weak_questions": [], "note": "Chưa có câu nào làm sai trong 60 ngày qua."}
    visible = _visible_lessons(db, user)
    bank = db.query(QuestionBankItem).filter(QuestionBankItem.id.in_(weak_ids)).all()
    out = []
    for b in bank:
        if b.lesson_id not in visible or (lesson is not None and b.lesson_id != lesson.code):
            continue
        s = stat[str(b.id)]
        # Cố ý KHÔNG trả đáp án / lời giải: agent chỉ được chỉ hướng ôn.
        out.append({"question_id": str(b.id), "lesson_code": b.lesson_id, "lesson_title": visible[b.lesson_id].title,
                    "question": (b.payload or {}).get("question"), "times_wrong": s["wrong"], "times_right": s["right"],
                    "last_attempt_correct": s["last_correct"]})
    out.sort(key=lambda x: (-x["times_wrong"], x["times_right"]))
    return {"weak_questions": out[:limit], "total_weak": len(out)}


def tool_get_due_flashcards(db: Session, user: Principal, args: dict, state: RunState) -> dict:
    lesson = _lesson_or_error(db, user, args.get("lesson_code"))
    codes = [lesson.code] if lesson else list(_visible_lessons(db, user))
    out = []
    for code in codes:
        try:
            sm = flashcards.summary(db, user, code)
        except AppError:
            continue
        if sm["total"]:
            out.append(sm)
            if sm["due"]:
                state.add_action("flashcards", f"Ôn {sm['due']} thẻ · {code}", lesson_code=code)
    return {"lessons": out}


def tool_search_materials(db: Session, user: Principal, args: dict, state: RunState) -> dict:
    query = str(args.get("query") or "").strip()
    if not query:
        raise AppError(400, "INVALID_ARGS", "Thiếu query.")
    lesson = _lesson_or_error(db, user, args.get("lesson_code"))
    scope = RetrievalScope.for_user(user, lesson_id=lesson.code if lesson else None)
    chunks = retrieve(db, query, scope, top_k=4)
    visible = _visible_lessons(db, user)
    results = []
    for c in chunks:
        if c.get("lesson_id") and c["lesson_id"] not in visible and not user.is_admin:
            continue
        label = state.add_source(c)
        results.append({"label": label, "where": source_label(c), "lesson_code": c.get("lesson_id"),
                        "excerpt": (c.get("content") or "")[:500]})
    return {"results": results} if results else {"results": [], "note": "Không tìm thấy học liệu phù hợp."}


def tool_get_practice_quiz(db: Session, user: Principal, args: dict, state: RunState) -> dict:
    lesson = _lesson_or_error(db, user, args.get("lesson_code"))
    if lesson is None:
        raise AppError(400, "INVALID_ARGS", "Cần lesson_code.")
    status_of = learning._status_map(db, user, lesson.chapter.course)[2]
    out = []
    for it in lesson.items:
        if it.type != "quiz":
            continue
        prog = db.query(ItemProgress).filter(ItemProgress.student_id == user.user_id, ItemProgress.item_id == it.id).first()
        st = status_of.get(it.id)
        window = learning.quiz_window_state(it)
        out.append({"item_id": str(it.id), "title": it.title, "status": st, "window": window,
                    "best_score": round(prog.score, 2) if prog and prog.score is not None else None,
                    "pool_size": learning._quiz_pool_size(db, it)})
        if st != "locked" and window == "open":
            state.add_action("item", f"Làm bài: {it.title}", item_id=str(it.id), lesson_id=str(it.lesson_id))
    note = "Bài kiểm tra ưu tiên lại các câu bạn hay sai." if out else "Bài này chưa có bài kiểm tra."
    return {"quizzes": out, "note": note}


def tool_queue_flashcards(db: Session, user: Principal, args: dict, state: RunState) -> dict:
    ids = [str(x) for x in (args.get("question_ids") or [])][:30]
    if not ids:
        raise AppError(400, "INVALID_ARGS", "Thiếu question_ids.")
    visible = _visible_lessons(db, user)
    uuids = [u for u in (parse_uuid(i, "question_id", required=False) for i in ids) if u]
    bank = db.query(QuestionBankItem).filter(QuestionBankItem.id.in_(uuids), QuestionBankItem.status == "approved").all()
    now = utcnow()
    queued, lessons = 0, set()
    for b in bank:
        if b.lesson_id not in visible:
            continue
        rv = db.query(FlashcardReview).filter(FlashcardReview.student_id == user.user_id,
                                              FlashcardReview.card_id == b.id).first()
        if rv is None:
            db.add(FlashcardReview(student_id=user.user_id, card_id=b.id, lesson_code=b.lesson_id, due_at=now,
                                   ease=2.5, interval_days=0.0, reps=0, lapses=0))
        elif as_aware(rv.due_at) > now:
            rv.due_at = now
        queued += 1
        lessons.add(b.lesson_id)
    db.commit()
    for code in sorted(lessons):
        state.add_action("flashcards", f"Ôn thẻ ngay · {code}", lesson_code=code)
    return {"queued": queued, "lessons": sorted(lessons)}


_LESSON_ARG = {"type": "string", "description": "Mã bài học (lesson_code), ví dụ lesson-oop-01. Bỏ trống = mọi bài."}

TOOLS: dict[str, Tool] = {t.name: t for t in [
    Tool("get_progress", "Tiến độ học của học sinh: các khóa, bài, số mục đã xong, mục đang học, điểm cao nhất các bài kiểm tra, chuỗi ngày học.",
         {"type": "object", "properties": {}, "additionalProperties": False}, tool_get_progress),
    Tool("get_weak_points", "Các câu kiểm tra học sinh hay làm sai gần đây (không kèm đáp án), sắp theo số lần sai.",
         {"type": "object", "properties": {"lesson_code": _LESSON_ARG,
                                           "limit": {"type": "integer", "minimum": 1, "maximum": 20}},
          "additionalProperties": False}, tool_get_weak_points),
    Tool("get_due_flashcards", "Số thẻ ghi nhớ đến hạn ôn / mới / đã thuộc theo từng bài.",
         {"type": "object", "properties": {"lesson_code": _LESSON_ARG}, "additionalProperties": False},
         tool_get_due_flashcards),
    Tool("search_materials", "Tìm đoạn học liệu (video, slide, bài đọc) liên quan một khái niệm để học sinh xem lại. Trả nhãn nguồn S1, S2...",
         {"type": "object", "properties": {"query": {"type": "string", "description": "Khái niệm / chủ đề cần tìm"},
                                           "lesson_code": _LESSON_ARG},
          "required": ["query"], "additionalProperties": False}, tool_search_materials),
    Tool("get_practice_quiz", "Các bài kiểm tra của một bài học, trạng thái mở khóa và điểm cao nhất, để gợi ý làm bài luyện tập.",
         {"type": "object", "properties": {"lesson_code": _LESSON_ARG}, "required": ["lesson_code"],
          "additionalProperties": False}, tool_get_practice_quiz),
    Tool("queue_flashcards", "Đưa các câu hay sai (question_id lấy từ get_weak_points) vào lịch ôn thẻ ngay hôm nay của học sinh.",
         {"type": "object", "properties": {"question_ids": {"type": "array", "items": {"type": "string"}, "maxItems": 30}},
          "required": ["question_ids"], "additionalProperties": False}, tool_queue_flashcards, writes=True),
]}


# ----------------------------------------------------------------------------
# Vòng lặp agent
# ----------------------------------------------------------------------------

def run_tool(db: Session, user: Principal, name: str, raw_args: str, state: RunState) -> tuple[dict, bool]:
    """Chạy một tool. Lỗi (tool lạ, tham số sai, không có quyền) trả về dạng dữ liệu để model tự xử lý."""
    tool = TOOLS.get(name)
    if tool is None:
        return {"error": f"Không có tool {name}."}, False
    try:
        args = json.loads(raw_args or "{}")
        if not isinstance(args, dict):
            raise ValueError("arguments phải là object")
    except (json.JSONDecodeError, ValueError) as e:
        return {"error": f"Tham số không hợp lệ: {e}"}, False
    try:
        return tool.handler(db, user, args, state), True
    except AppError as e:
        db.rollback()
        return {"error": e.detail if isinstance(e.detail, str) else str(e.detail)}, False
    except Exception as e:  # tool lỗi không làm hỏng cả lượt
        db.rollback()
        log.exception("coach_tool_failed")
        return {"error": f"Tool lỗi: {type(e).__name__}"}, False


def _clip(data: dict, limit: int = 6000) -> str:
    text = json.dumps(data, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + "...(đã cắt bớt)"


def _history(history: list[dict] | None) -> list[dict]:
    out = []
    for m in (history or [])[-settings.coach_history_turns * 2:]:
        if m.get("role") in ("user", "assistant") and m.get("content"):
            out.append({"role": m["role"], "content": str(m["content"])[:2000]})
    while out and out[0]["role"] != "user":
        out.pop(0)
    return out


def ask(db: Session, user: Principal, message: str, history: list[dict] | None = None) -> dict:
    message = (message or "").strip()
    if not message:
        raise AppError(400, "EMPTY_MESSAGE", "Hãy nhập câu hỏi.")
    if settings.redact_pii:
        message = redact_pii(message)
    if learning.active_quiz_questions(db, user):
        return {"answer": QUIZ_GUARD_MESSAGE, "steps": [], "sources": [], "actions": [], "guarded": True,
                "stopped": None, "llm_calls": 0}

    state = RunState()
    messages = _history(history) + [{"role": "user", "content": message}]
    specs = [t.spec() for t in TOOLS.values()]
    steps: list[dict] = []
    answer, stopped, calls = "", None, 0
    for step in range(settings.coach_max_steps + 1):
        final_round = step == settings.coach_max_steps
        if final_round:  # hết lượt gọi tool: buộc model trả lời bằng những gì đã có
            messages.append({"role": "user", "content": "Đã đủ thông tin. Hãy trả lời học sinh ngay, không gọi thêm tool."})
        msg, _ = llm.complete_with_tools("coach", STUDY_COACH, messages, [] if final_round else specs,
                                         user_id=user.user_id, attempt=step + 1)
        calls += 1
        tool_calls = msg.get("tool_calls") or []
        if not tool_calls or final_round:
            answer = (msg.get("content") or "").strip()
            if final_round and tool_calls:
                stopped = "max_steps"
            break
        messages.append({"role": "assistant", "content": msg.get("content") or None,
                         "tool_calls": [{"id": c["id"], "type": "function",
                                         "function": {"name": c["name"], "arguments": c["arguments"]}} for c in tool_calls]})
        for c in tool_calls:
            result, ok = run_tool(db, user, c["name"], c["arguments"], state)
            steps.append({"tool": c["name"], "arguments": c["arguments"], "ok": ok,
                          "writes": bool(TOOLS.get(c["name"]) and TOOLS[c["name"]].writes)})
            messages.append({"role": "tool", "tool_call_id": c["id"], "content": _clip(result)})
    if not answer:
        answer = "Mình chưa lập được kế hoạch lúc này. Bạn thử hỏi cụ thể hơn, ví dụ: \"Mình nên ôn gì cho bài kiểm tra chương 1?\""
    used = set(_labels_in(answer))
    return {"answer": answer, "steps": steps, "sources": [s for s in state.sources if s["label"] in used] or state.sources,
            "actions": state.actions, "guarded": False, "stopped": stopped, "llm_calls": calls}


def _labels_in(text: str) -> list[str]:
    return re.findall(r"\[(S\d+)\]", text or "")
