"""Study Coach Agent: trợ lý học tập tự gọi tool trên dữ liệu thật của học sinh.

Vòng lặp: model đọc câu hỏi -> yêu cầu gọi tool (tiến độ, câu hay sai, thẻ đến hạn, học liệu, đề luyện)
-> server chạy tool trong phạm vi quyền của học sinh -> trả kết quả cho model -> ... -> câu trả lời cuối.

Nguyên tắc an toàn (do code kiểm soát, không phó mặc cho prompt):
- Số bước có giới hạn (settings.coach_max_steps); hết bước thì trả lời dựa trên những gì đã có.
- Tool chỉ đọc dữ liệu của chính học sinh và học liệu thuộc lớp của học sinh. Hai tool ghi:
  queue_flashcards đưa thẻ (câu đã duyệt) vào lịch ôn của chính học sinh đó;
  create_my_flashcards nhờ AI soạn thẻ mới vào "Thẻ của tôi" (thẻ riêng, chỉ học sinh đó thấy).
  create_practice_quiz soạn quiz luyện tập (tối đa 10 câu) làm ngay trong chat, đáp án giữ ở server.
- Không tool nào trả đáp án câu hỏi kiểm tra. Đang làm dở bài kiểm tra thì agent không chạy.
- Mỗi lượt gắn với MỘT khóa học sinh chọn; tool và tìm học liệu chỉ trong khóa đó.
- Hỏi lại khi mơ hồ: tool ask_clarification kết thúc lượt bằng một câu hỏi kèm lựa chọn để học sinh bấm.
  Tạo thẻ / tạo quiz với chủ đề không rõ, hoặc chủ đề không có trong học liệu của khóa, thì tool từ chối
  (không tạo bừa) để model hỏi lại hoặc nói rõ là không tìm thấy.
- Nhãn nguồn [S9] mà model tự bịa (không có trong kết quả tool) bị gỡ khỏi câu trả lời.
"""
import json
import logging
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.core.errors import AppError
from app.core.security import Principal
from app.core.utils import parse_uuid, utcnow
from app.models.coach import CoachConversation, CoachMessage
from app.models.learning import Course, ItemProgress, Lesson, QuizAnswerLog
from app.models.video_question import QuestionBankItem
from app.services.ai import guardrails, llm
from app.services.ai.prompts import STUDY_COACH
from app.services.courses import flashcards, learning
from app.services.rag.retrieval import RetrievalScope, retrieve, source_label

log = logging.getLogger("app.coach")



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

    def __init__(self, course=None):
        self.course = course  # khóa học học sinh chọn để ôn; None = mọi khóa
        self.sources: list[dict] = []
        self.actions: list[dict] = []
        self.clarify: dict | None = None
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
        key = (kind, data.get("item_id") or data.get("lesson_code") or data.get("quiz_id"))
        if key in self._action_keys:
            return
        self._action_keys.add(key)
        self.actions.append({"type": kind, "label": label, **data})


# ----------------------------------------------------------------------------
# Tools
# ----------------------------------------------------------------------------

def _courses(db: Session, user: Principal, state: "RunState | None" = None) -> list:
    if state is not None and state.course is not None:
        return [state.course]
    return learning.visible_courses(db, user, with_tree=True)


def _visible_lessons(db: Session, user: Principal, state: "RunState | None" = None) -> dict[str, Lesson]:
    return {ls.code: ls for c in _courses(db, user, state) for ch in c.chapters for ls in ch.lessons}


def _lesson_or_error(db: Session, user: Principal, code: str | None, state: "RunState | None" = None) -> Lesson | None:
    if not code:
        return None
    lesson = _visible_lessons(db, user, state).get(str(code))
    if lesson is None:
        where = f"khóa {state.course.title}" if state is not None and state.course is not None else "các khóa học của bạn"
        raise AppError(404, "NOT_FOUND", f"Không có bài học mã {code} trong {where}.")
    return lesson


def _chapter_label(index: int, ch) -> str:
    return f"Chương {index}: {ch.title}"


def _chapter_or_error(db: Session, user: Principal, ref, state: "RunState"):
    """Chương học sinh nói tới: số thứ tự ("1", "chương 1") hoặc tên chương. Không khớp -> lỗi kèm danh sách chương."""
    if ref is None or str(ref).strip() == "":
        return None, None
    chapters = [ch for c in _courses(db, user, state) for ch in c.chapters]
    text = str(ref).strip().lower()
    m = re.fullmatch(r"(?:chương|chuong|chapter|module|phần)?\s*(\d+)", text)
    if m and 1 <= int(m.group(1)) <= len(chapters):
        i = int(m.group(1))
        return i, chapters[i - 1]
    for i, ch in enumerate(chapters, 1):
        if text and (text == ch.title.lower() or text in ch.title.lower()):
            return i, ch
    listing = "; ".join(_chapter_label(i, ch) for i, ch in enumerate(chapters, 1)) or "khóa chưa có chương nào"
    raise AppError(404, "NOT_FOUND", f"Không có chương «{ref}» trong khóa. Các chương: {listing}. "
                                     "Hãy hỏi lại học sinh (ask_clarification) với các chương này.")


def resolve_course(db: Session, user: Principal, course_id):
    """Khóa học học sinh chọn để ôn (phải là khóa học sinh được học)."""
    if not course_id:
        return None
    cid = parse_uuid(course_id, "course_id", required=False)
    course = next((c for c in learning.visible_courses(db, user) if c.id == cid), None) if cid else None
    if course is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy khóa học này trong các khóa bạn đang học.")
    return course


def tool_get_progress(db: Session, user: Principal, args: dict, state: RunState) -> dict:
    out = []
    for course in _courses(db, user, state):
        items, progress, status_of, current_id = learning._status_map(db, user, course)
        if not items:
            continue
        done = sum(1 for i in items if status_of[i.id] == "done")
        current = next((i for i in items if i.id == current_id), None)
        lessons = []
        for ch_index, ch in enumerate(course.chapters, 1):
            for ls in ch.lessons:
                its = ls.items
                quiz = [{"item_id": str(i.id), "title": i.title,
                         "best_score": round(progress[i.id].score, 2) if progress.get(i.id) and progress[i.id].score is not None else None,
                         "passed": bool(progress.get(i.id) and progress[i.id].status == "completed")}
                        for i in its if i.type == "quiz"]
                lessons.append({"chapter": _chapter_label(ch_index, ch), "lesson_code": ls.code, "title": ls.title,
                                "items_total": len(its),
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


def weak_questions(db: Session, user: Principal, visible: dict, lesson: Lesson | None = None) -> list[dict]:
    """Các câu kiểm tra học sinh hay sai (60 ngày) trong các bài `visible`, sai nhiều nhất trước. KHÔNG có đáp án."""
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
        return []
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
    return out


def tool_get_weak_points(db: Session, user: Principal, args: dict, state: RunState) -> dict:
    from app.services.ai import practice_quiz
    lesson = _lesson_or_error(db, user, args.get("lesson_code"), state)
    limit = max(1, min(int(args.get("limit") or 8), 20))
    visible = _visible_lessons(db, user, state)
    out = weak_questions(db, user, visible, lesson)
    course_id = str(state.course.id) if state.course is not None else None
    practice = practice_quiz.recent_mistakes(db, user, course_id)
    if not out and not practice:
        return {"weak_questions": [], "practice_mistakes": [],
                "note": "Chưa có câu nào làm sai trong 60 ngày qua, nên chưa xác định được điểm yếu cụ thể."}
    by_lesson: dict[str, dict] = {}
    for w in out:
        b = by_lesson.setdefault(w["lesson_code"], {"lesson_code": w["lesson_code"], "lesson_title": w["lesson_title"],
                                                    "weak_count": 0, "times_wrong": 0})
        b["weak_count"] += 1
        b["times_wrong"] += w["times_wrong"]
    # Gắn sẵn đoạn học liệu để xem lại cho vài câu sai nhiều nhất: lời khuyên chỉ đúng chỗ, có nguồn.
    for w in out[:3]:
        if not w.get("question"):
            continue
        try:
            hits = tool_search_materials(db, user, {"query": w["question"], "lesson_code": w["lesson_code"]}, state)["results"]
        except AppError:
            hits = []
        if hits:
            w["review"] = {"label": hits[0]["label"], "where": hits[0]["where"]}
    return {"weak_questions": out[:limit], "total_weak": len(out),
            "weak_by_lesson": sorted(by_lesson.values(), key=lambda b: -b["times_wrong"]),
            "practice_mistakes": practice}


def tool_get_due_flashcards(db: Session, user: Principal, args: dict, state: RunState) -> dict:
    lesson = _lesson_or_error(db, user, args.get("lesson_code"), state)
    codes = {lesson.code} if lesson else _visible_lessons(db, user, state)
    out = []
    for course in flashcards.overview(db, user):
        for sm in course["lessons"]:
            code = sm["lesson_code"]
            if sm["locked"] or code not in codes:
                continue
            out.append(sm)
            if sm["due"]:
                state.add_action("flashcards", f"Ôn {sm['due']} thẻ · {code}", lesson_code=code)
    return {"lessons": out}


def tool_search_materials(db: Session, user: Principal, args: dict, state: RunState) -> dict:
    query = str(args.get("query") or "").strip()
    if not query:
        raise AppError(400, "INVALID_ARGS", "Thiếu query.")
    lesson = _lesson_or_error(db, user, args.get("lesson_code"), state)
    visible = _visible_lessons(db, user, state)
    scope = RetrievalScope.for_user(user, lesson_id=lesson.code if lesson else None,
                                    lesson_ids=list(visible) if state.course is not None else None)
    chunks = retrieve(db, query, scope, top_k=4)
    results = []
    for c in chunks:
        if c.get("lesson_id") and c["lesson_id"] not in visible and not user.is_admin:
            continue
        label = state.add_source(c)
        results.append({"label": label, "where": source_label(c), "lesson_code": c.get("lesson_id"),
                        "excerpt": (c.get("content") or "")[:500]})
    return {"results": results} if results else {"results": [], "note": "Không tìm thấy học liệu phù hợp."}


def tool_get_practice_quiz(db: Session, user: Principal, args: dict, state: RunState) -> dict:
    lesson = _lesson_or_error(db, user, args.get("lesson_code"), state)
    lessons = [lesson] if lesson is not None else list(_visible_lessons(db, user, state).values())
    status_cache: dict = {}
    out = []
    for ls in lessons:
        course = ls.chapter.course
        if course.id not in status_cache:
            status_cache[course.id] = learning._status_map(db, user, course)[2]
        status_of = status_cache[course.id]
        for it in ls.items:
            if it.type != "quiz":
                continue
            m = it.meta or {}
            prog = db.query(ItemProgress).filter(ItemProgress.student_id == user.user_id, ItemProgress.item_id == it.id).first()
            st = status_of.get(it.id)
            window = learning.quiz_window_state(it)
            out.append({"item_id": str(it.id), "title": it.title, "lesson_code": ls.code, "lesson_title": ls.title,
                        "covers": [i.title for i in ls.items if i.type != "quiz"],
                        "status": st, "window": window, "open_at": m.get("open_at"), "close_at": m.get("close_at"),
                        "question_count": m.get("count", 5), "pass_ratio": m.get("pass_ratio", 0.8),
                        "best_score": round(prog.score, 2) if prog and prog.score is not None else None,
                        "passed": bool(prog and prog.status == "completed"),
                        "pool_size": learning._quiz_pool_size(db, it)})
            if lesson is not None and st != "locked" and window == "open":
                state.add_action("item", f"Làm bài: {it.title}", item_id=str(it.id), lesson_id=str(it.lesson_id))
    if not out:
        return {"quizzes": [], "note": "Bài này chưa có bài kiểm tra." if lesson else "Khóa này chưa có bài kiểm tra nào."}
    note = "Bài kiểm tra lấy câu từ ngân hàng câu đã duyệt của bài, ưu tiên lại các câu bạn hay sai."
    if lesson is None and len(out) > 1:
        note += " Có nhiều bài kiểm tra: nếu học sinh chưa nói rõ bài nào thì hỏi lại (ask_clarification)."
    return {"quizzes": out, "note": note}


def tool_queue_flashcards(db: Session, user: Principal, args: dict, state: RunState) -> dict:
    ids = [str(x) for x in (args.get("question_ids") or [])][:30]
    if not ids:
        raise AppError(400, "INVALID_ARGS", "Thiếu question_ids.")
    visible = _visible_lessons(db, user, state)
    uuids = [u for u in (parse_uuid(i, "question_id", required=False) for i in ids) if u]
    bank = db.query(QuestionBankItem).filter(QuestionBankItem.id.in_(uuids), QuestionBankItem.status == "approved").all()
    unlocked = {row.code for row in flashcards.unlocked_lessons(db, user)
                .filter(Lesson.code.in_({b.lesson_id for b in bank}))} if bank else set()
    now = utcnow()
    queued, lessons = 0, set()
    for b in sorted(bank, key=lambda card: card.id):
        if b.lesson_id not in visible or b.lesson_id not in unlocked:
            continue
        flashcards.queue_bank_card(db, user, b, now)
        queued += 1
        lessons.add(b.lesson_id)
    db.commit()
    for code in sorted(lessons):
        state.add_action("flashcards", f"Ôn thẻ ngay · {code}", lesson_code=code)
    return {"queued": queued, "lessons": sorted(lessons)}


def tool_create_my_flashcards(db: Session, user: Principal, args: dict, state: RunState) -> dict:
    from app.services.courses import my_flashcards
    from app.services.ai import practice_quiz
    topic = str(args.get("topic") or "").strip()
    lesson = _lesson_or_error(db, user, args.get("lesson_code"), state)
    ch_index, chapter = _chapter_or_error(db, user, args.get("chapter"), state) if lesson is None else (None, None)
    if chapter is not None:
        return _chapter_flashcards(db, user, args, state, ch_index, chapter, topic)
    if lesson is None and not guardrails.content_words(topic):
        raise AppError(400, "TOPIC_VAGUE", "Chủ đề chưa rõ. Hãy hỏi lại học sinh muốn tạo thẻ về bài / khái niệm nào "
                                           "(ask_clarification), đừng tự chọn.")
    try:
        count = max(1, min(10, int(args.get("count") or 5)))
    except (TypeError, ValueError):
        count = 5
    grounded = None
    if lesson is None:
        # Thẻ theo chủ đề vẫn phải bám học liệu của khóa: không có căn cứ thì không tạo.
        visible = _visible_lessons(db, user, state)
        chunks = practice_quiz.find_course_material(db, user, topic, visible)
        if not chunks:
            return {"created": 0, "reason": "not_in_course",
                    "note": f"Không tìm thấy học liệu về «{topic}» trong khóa nên không tạo thẻ.",
                    "course_lessons": [f"{c}: {ls.title}" for c, ls in visible.items()][:20]}
        from app.services.rag.retrieval import build_context
        grounded = build_context(chunks)
    # bộ thẻ thuộc khóa: theo bài nguồn, hoặc khóa học sinh đang chọn khi soạn theo chủ đề
    course_id = None if lesson else (state.course.id if state.course is not None else None)
    if lesson is None and course_id is None and grounded:
        course_id = my_flashcards._course_of_lesson(db, chunks[0].get("lesson_id"))
    cards = my_flashcards.generate(db, user, count, lesson.code if lesson else None,
                                   None if lesson else topic, None if lesson else topic[:120], grounded=grounded,
                                   course_id=course_id)
    if cards:
        state.add_action("my_flashcards", f"Xem {len(cards)} thẻ vừa tạo", deck=cards[0]["deck"],
                         course_id=cards[0]["course_id"])
    return {"created": len(cards), "deck": cards[0]["deck"] if cards else "",
            "cards": [{"front": c["front"], "back": c["back"]} for c in cards]}


def _count(args: dict, default: int = 5) -> int:
    try:
        return max(1, min(10, int(args.get("count") or default)))
    except (TypeError, ValueError):
        return default


def _chapter_flashcards(db: Session, user: Principal, args: dict, state: RunState, ch_index: int, chapter,
                        topic: str) -> dict:
    """Thẻ cho cả một chương: học liệu của mọi bài trong chương (có chủ đề thì chỉ phần nói về chủ đề đó)."""
    from app.services.ai import practice_quiz
    from app.services.ai.lesson_ai import lessons_context
    from app.services.courses import my_flashcards
    from app.services.rag.retrieval import build_context
    lessons = {ls.code: ls for ls in chapter.lessons}
    label = _chapter_label(ch_index, chapter)
    if not lessons:
        return {"created": 0, "reason": "no_material", "note": f"{label} chưa có bài nào."}
    if guardrails.content_words(topic):
        chunks = practice_quiz.find_course_material(db, user, topic, lessons)
        if not chunks:
            return {"created": 0, "reason": "not_in_course", "note": f"Không tìm thấy «{topic}» trong {label}."}
        grounded, text = build_context(chunks), topic
    else:
        try:
            grounded = lessons_context(db, list(lessons))
        except AppError:
            return {"created": 0, "reason": "no_material", "note": f"{label} chưa có học liệu đã nạp."}
        text = label
    cards = my_flashcards.generate(db, user, _count(args), None, text, label[:120], grounded=grounded,
                                   course_id=chapter.course_id)
    if cards:
        state.add_action("my_flashcards", f"Xem {len(cards)} thẻ vừa tạo", deck=cards[0]["deck"],
                         course_id=cards[0]["course_id"])
    return {"created": len(cards), "deck": cards[0]["deck"] if cards else "", "chapter": label,
            "lessons": [f"{c}: {ls.title}" for c, ls in lessons.items()],
            "cards": [{"front": c["front"], "back": c["back"]} for c in cards]}


def tool_create_practice_quiz(db: Session, user: Principal, args: dict, state: RunState) -> dict:
    from app.services.ai import practice_quiz
    if state.course is None:
        raise AppError(400, "COURSE_REQUIRED", "Học sinh chưa chọn khóa học.")
    lesson = _lesson_or_error(db, user, args.get("lesson_code"), state)
    ch_index, chapter = _chapter_or_error(db, user, args.get("chapter"), state) if lesson is None else (None, None)
    topic = str(args.get("topic") or "").strip()
    count = _count(args)
    has_topic = bool(guardrails.content_words(topic))
    if chapter is not None:
        lessons = {ls.code: ls for ls in chapter.lessons}
        res = practice_quiz.create(db, user, state.course, lessons, topic if has_topic else _chapter_label(ch_index, chapter),
                                   count, whole=not has_topic)
    elif lesson is not None and not has_topic:  # cả bài: soạn từ toàn bộ học liệu của bài
        res = practice_quiz.create(db, user, state.course, {lesson.code: lesson}, lesson.title, count, lesson.code, whole=True)
    else:
        res = practice_quiz.create(db, user, state.course, _visible_lessons(db, user, state), topic, count,
                                   lesson.code if lesson else None)
    if res.get("created"):
        state.add_action("practice_quiz", f"Làm quiz luyện tập: {res['topic']} ({res['count']} câu)",
                         quiz_id=res["quiz_id"], count=res["count"], topic=res["topic"])
    return res


def tool_ask_clarification(db: Session, user: Principal, args: dict, state: RunState) -> dict:
    question = re.sub(r"\s+", " ", str(args.get("question") or "")).strip()[:300]
    options = [re.sub(r"\s+", " ", str(o)).strip()[:120] for o in (args.get("options") or []) if str(o).strip()][:5]
    if not question:
        raise AppError(400, "INVALID_ARGS", "Thiếu question.")
    state.clarify = {"question": question, "options": options}
    return {"ok": True}


_CHAPTER_ARG = {"type": "string", "description": "Chương khi học sinh nói \"chương N\" (số thứ tự chương hoặc tên chương): "
                "dùng học liệu của MỌI bài trong chương. Không dùng lesson_code cho yêu cầu theo chương."}
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
    Tool("get_practice_quiz", "Các bài kiểm tra chính thức (của một bài, hoặc cả khóa nếu bỏ trống lesson_code): bài kiểm tra "
         "bao phủ phần học nào, số câu, điểm cần đạt, lịch mở/đóng, trạng thái và điểm cao nhất của học sinh.",
         {"type": "object", "properties": {"lesson_code": _LESSON_ARG}, "additionalProperties": False},
         tool_get_practice_quiz),
    Tool("queue_flashcards", "Đưa các câu hay sai (question_id lấy từ get_weak_points) vào lịch ôn thẻ ngay hôm nay của học sinh.",
         {"type": "object", "properties": {"question_ids": {"type": "array", "items": {"type": "string"}, "maxItems": 30}},
          "required": ["question_ids"], "additionalProperties": False}, tool_queue_flashcards, writes=True),
    Tool("create_my_flashcards", "AI soạn thẻ ghi nhớ mới về một chương (chapter), một bài học (lesson_code) hoặc một chủ đề (topic) rồi lưu vào \"Thẻ của tôi\" của học sinh.",
         {"type": "object", "properties": {"lesson_code": {"type": "string", "description": "Mã bài học để soạn thẻ từ học liệu của bài."},
                                           "topic": {"type": "string", "description": "Chủ đề/khái niệm khi không soạn theo bài."},
                                           "count": {"type": "integer", "minimum": 1, "maximum": 10},
                                           "chapter": _CHAPTER_ARG},
          "additionalProperties": False}, tool_create_my_flashcards, writes=True),
    Tool("create_practice_quiz", "Soạn quiz luyện tập (tối đa 10 câu trắc nghiệm) về một chương, một bài hoặc một chủ đề trong khóa để học sinh làm ngay "
         "trong khung chat. Chỉ tạo được khi học liệu của khóa có nói về chủ đề đó; không tính vào điểm bài kiểm tra.",
         {"type": "object", "properties": {"topic": {"type": "string", "description": "Chủ đề / khái niệm cụ thể học sinh muốn luyện."},
                                           "lesson_code": {"type": "string", "description": "Mã bài học nếu học sinh chọn một bài."},
                                           "count": {"type": "integer", "minimum": 1, "maximum": 10},
                                           "chapter": _CHAPTER_ARG},
          "additionalProperties": False}, tool_create_practice_quiz, writes=True),
    Tool("ask_clarification", "Hỏi lại học sinh khi yêu cầu mơ hồ (bài kiểm tra nào, bài/chủ đề nào, yếu phần nào...). "
         "Kết thúc lượt: question hiện cho học sinh, options (2-5 lựa chọn cụ thể lấy từ dữ liệu tool) hiện thành nút bấm.",
         {"type": "object", "properties": {"question": {"type": "string"},
                                           "options": {"type": "array", "items": {"type": "string"}, "maxItems": 5}},
          "required": ["question"], "additionalProperties": False}, tool_ask_clarification),
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


def _course_note(course) -> str:
    """Cấu trúc khóa (chương -> bài) để model phân biệt "chương 1" (cả chương) với "bài 1" (một bài)."""
    parts = []
    for i, ch in enumerate(course.chapters, 1):
        lessons = ", ".join(f"{ls.code} «{ls.title}»" for ls in ch.lessons) or "chưa có bài"
        parts.append(f"{_chapter_label(i, ch)} gồm các bài: {lessons}")
    structure = "; ".join(parts) or "chưa có chương nào"
    return (f"(Học sinh đang ôn khóa học «{course.title}». Chỉ dùng dữ liệu và học liệu của khóa này. "
            f"Cấu trúc khóa: {structure}. \"Chương N\" là cả chương (tham số chapter), \"bài\" là một bài (lesson_code).)\n\n")


def ask_events(db: Session, user: Principal, message: str, history: list[dict] | None = None, course=None,
               stream: bool = False) -> Iterator[dict]:
    """Vòng lặp agent dạng sự kiện: `step_start` (sắp gọi tool), `step` (tool xong), `delta` (đoạn chữ của câu trả lời,
    chỉ khi stream=True), `reset` (bỏ phần chữ vừa phát vì model chuyển sang gọi tool), cuối cùng `result`."""
    message = (message or "").strip()
    if not message:
        raise AppError(400, "EMPTY_MESSAGE", "Hãy nhập câu hỏi.")
    message = guardrails.clean_user_text(message)
    if guardrails.quiz_in_progress(db, user):
        yield {"event": "result", "data": {"answer": guardrails.COACH_PAUSED_MESSAGE, "steps": [], "sources": [], "actions": [],
                                           "guarded": True, "stopped": None, "llm_calls": 0}}
        return

    state = RunState(course)
    content = (_course_note(course) + message) if course is not None else message
    messages = _history(history) + [{"role": "user", "content": content}]
    specs = [t.spec() for t in TOOLS.values()]
    steps: list[dict] = []
    answer, stopped, calls = "", None, 0
    for step in range(settings.coach_max_steps + 1):
        final_round = step == settings.coach_max_steps
        if final_round:  # hết lượt gọi tool: buộc model trả lời bằng những gì đã có
            messages.append({"role": "user", "content": "Đã đủ thông tin. Hãy trả lời học sinh ngay, không gọi thêm tool."})
        tools = [] if final_round else specs
        if stream:
            msg, streamed = None, False
            for piece in llm.stream_with_tools("coach", STUDY_COACH, messages, tools,
                                               user_id=user.user_id, attempt=step + 1):
                if isinstance(piece, tuple):
                    msg = piece[0]
                else:
                    streamed = True
                    yield {"event": "delta", "data": {"text": piece}}
        else:
            msg, _ = llm.complete_with_tools("coach", STUDY_COACH, messages, tools,
                                             user_id=user.user_id, attempt=step + 1)
            streamed = False
        calls += 1
        tool_calls = msg.get("tool_calls") or []
        if not tool_calls or final_round:
            answer = (msg.get("content") or "").strip()
            if final_round and tool_calls:
                stopped = "max_steps"
            break
        if streamed:  # model nói vài câu rồi mới gọi tool: phần chữ đó không phải câu trả lời cuối
            yield {"event": "reset", "data": {}}
        messages.append({"role": "assistant", "content": msg.get("content") or None,
                         "tool_calls": [{"id": c["id"], "type": "function",
                                         "function": {"name": c["name"], "arguments": c["arguments"]}} for c in tool_calls]})
        for c in tool_calls:
            yield {"event": "step_start", "data": {"tool": c["name"], "arguments": c["arguments"]}}
            result, ok = run_tool(db, user, c["name"], c["arguments"], state)
            info = {"tool": c["name"], "arguments": c["arguments"], "ok": ok,
                    "writes": bool(TOOLS.get(c["name"]) and TOOLS[c["name"]].writes)}
            steps.append(info)
            yield {"event": "step", "data": info}
            messages.append({"role": "tool", "tool_call_id": c["id"], "content": _clip(result)})
        if state.clarify is not None:  # hỏi lại học sinh: dừng lượt, chờ học sinh trả lời
            answer = state.clarify["question"]
            break
    if not answer:
        answer = "Mình chưa lập được kế hoạch lúc này. Bạn thử hỏi cụ thể hơn, ví dụ: \"Mình nên ôn gì cho bài kiểm tra chương 1?\""
    answer = strip_unknown_labels(answer, {s["label"] for s in state.sources})
    used = set(_labels_in(answer))
    yield {"event": "result", "data": {
        "answer": answer, "steps": steps, "sources": [s for s in state.sources if s["label"] in used] or state.sources,
        "actions": state.actions, "guarded": False, "stopped": stopped, "llm_calls": calls, "clarify": state.clarify}}


def ask(db: Session, user: Principal, message: str, history: list[dict] | None = None, course=None) -> dict:
    res: dict = {}
    for ev in ask_events(db, user, message, history, course):
        if ev["event"] == "result":
            res = ev["data"]
    return res


def _labels_in(text: str) -> list[str]:
    return re.findall(r"\[(S\d+)\]", text or "")


def strip_unknown_labels(text: str, known: set[str]) -> str:
    """Gỡ nhãn nguồn model tự bịa (không có trong kết quả tool): câu trả lời không được dẫn nguồn không tồn tại."""
    return re.sub(r"\s?\[(S\d+)\]", lambda m: m.group(0) if m.group(1) in known else "", text or "")


# ----------------------------------------------------------------------------
# Lịch sử trò chuyện (lưu DB để xem lại và chat tiếp)
# ----------------------------------------------------------------------------

_RESULT_KEYS = ("steps", "sources", "actions", "guarded", "stopped", "clarify")


def _title_from(message: str) -> str:
    text = re.sub(r"\s+", " ", message).strip()
    return text if len(text) <= 60 else text[:57].rstrip() + "…"


def _own_conversation(db: Session, user: Principal, conversation_id) -> CoachConversation:
    cid = parse_uuid(conversation_id, "conversation_id")
    conv = db.get(CoachConversation, cid)
    if conv is None or conv.student_id != user.user_id:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy cuộc trò chuyện.")
    return conv


def _conv_summary(conv: CoachConversation) -> dict:
    return {"id": str(conv.id), "title": conv.title, "course_id": conv.course_id,
            "created_at": conv.created_at, "updated_at": conv.updated_at}


def prepare_chat(db: Session, user: Principal, message: str, conversation_id=None, history: list[dict] | None = None,
                 course_id=None) -> dict:
    """Kiểm tra quyền và gom ngữ cảnh cho một lượt hỏi (lỗi ở đây trả JSON bình thường, trước khi stream)."""
    conv = _own_conversation(db, user, conversation_id) if conversation_id else None
    if conv is not None and not course_id:
        course_id = conv.course_id
    course = resolve_course(db, user, course_id)
    if course is None:
        # Trợ lý luôn gắn với một khóa để trả lời đúng dữ liệu của khóa đó. Chỉ có một khóa thì chọn sẵn.
        courses = learning.visible_courses(db, user)
        if len(courses) != 1:
            raise AppError(400, "COURSE_REQUIRED", "Hãy chọn khóa học bạn muốn ôn trước khi hỏi Trợ lý.")
        course = courses[0]
    message = guardrails.clean_user_text(message or "")
    if conv is not None:
        history = [{"role": m.role, "content": m.content} for m in conv.messages]
    return {"conv_id": conv.id if conv is not None else None, "course_id": course.id if course is not None else None,
            "message": message, "history": history}


def _save_turn(db: Session, user: Principal, plan: dict, course, res: dict) -> dict:
    conv = db.get(CoachConversation, plan["conv_id"]) if plan["conv_id"] else None
    if conv is None:
        conv = CoachConversation(student_id=user.user_id, title=_title_from(plan["message"]))
        db.add(conv)
        db.flush()
    conv.course_id = str(course.id) if course is not None else None
    db.add(CoachMessage(conversation_id=conv.id, role="user", content=plan["message"].strip()))
    db.add(CoachMessage(conversation_id=conv.id, role="assistant", content=res["answer"],
                        result={k: res.get(k) for k in _RESULT_KEYS}))
    conv.updated_at = func.now()
    db.commit()
    db.refresh(conv)
    return {**res, "conversation": _conv_summary(conv)}


def chat_events(db: Session, user: Principal, plan: dict, stream: bool = True) -> Iterator[dict]:
    """Chạy một lượt đã chuẩn bị bằng prepare_chat; phát sự kiện của ask_events, cuối cùng `done` (đã lưu lịch sử)."""
    course = db.get(Course, plan["course_id"]) if plan["course_id"] else None
    for ev in ask_events(db, user, plan["message"], plan["history"], course, stream=stream):
        if ev["event"] == "result":
            yield {"event": "done", "data": _save_turn(db, user, plan, course, ev["data"])}
        else:
            yield ev


def chat(db: Session, user: Principal, message: str, conversation_id=None, history: list[dict] | None = None,
         course_id=None) -> dict:
    """Một lượt hỏi có lưu lịch sử. Có conversation_id: lấy ngữ cảnh từ DB và nối tiếp; không có: tạo cuộc mới.
    course_id: khóa học đang ôn; mọi tool và tìm học liệu chỉ trong khóa đó (cuộc cũ giữ khóa đã chọn)."""
    plan = prepare_chat(db, user, message, conversation_id, history, course_id)
    out: dict = {}
    for ev in chat_events(db, user, plan, stream=False):
        if ev["event"] == "done":
            out = ev["data"]
    return out


def list_conversations(db: Session, user: Principal, limit: int = 100) -> list[dict]:
    rows = (db.query(CoachConversation).filter(CoachConversation.student_id == user.user_id)
            .order_by(CoachConversation.updated_at.desc()).limit(max(1, min(limit, 200))).all())
    return [_conv_summary(c) for c in rows]


def get_conversation(db: Session, user: Principal, conversation_id) -> dict:
    conv = _own_conversation(db, user, conversation_id)
    msgs = [{"id": str(m.id), "role": m.role, "content": m.content, "created_at": m.created_at,
             "res": ({"answer": m.content, **(m.result or {})} if m.role == "assistant" else None)}
            for m in conv.messages]
    return {**_conv_summary(conv), "messages": msgs}


def rename_conversation(db: Session, user: Principal, conversation_id, title: str) -> dict:
    conv = _own_conversation(db, user, conversation_id)
    title = re.sub(r"\s+", " ", title or "").strip()
    if not title:
        raise AppError(400, "EMPTY_TITLE", "Tên cuộc trò chuyện không được để trống.")
    conv.title = title[:200]
    db.commit()
    db.refresh(conv)
    return _conv_summary(conv)


def delete_conversation(db: Session, user: Principal, conversation_id) -> None:
    conv = _own_conversation(db, user, conversation_id)
    db.delete(conv)
    db.commit()
