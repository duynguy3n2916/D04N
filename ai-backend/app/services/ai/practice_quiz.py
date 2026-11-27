"""Quiz luyện tập trong khung chat Trợ lý học tập.

Học sinh đã chọn khóa, nêu chủ đề muốn ôn -> tìm học liệu của khóa theo chủ đề (qua ngưỡng RAG_MIN_SCORE) ->
không có căn cứ thì KHÔNG tạo (trả lý do + các bài của khóa để gợi ý), có thì AI soạn tối đa 10 câu chỉ từ học liệu đó.
Đáp án giữ ở server: client chỉ nhận đề, nộp bài xong mới thấy đúng/sai, lời giải và nguồn.
Không tính vào điểm bài kiểm tra chính thức (bài kiểm tra vẫn làm ở trang bài học).
"""
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import Principal
from app.core.utils import parse_uuid, utcnow
from app.models.coach import CoachPracticeQuiz
from app.services.ai import guardrails, llm
from app.services.ai.guardrails import wrap_documents
from app.services.ai.lesson_ai import resolve_sources
from app.services.ai.prompts import PRACTICE_QUIZ
from app.services.ai.schemas import QuizOutput
from app.services.rag.retrieval import RetrievalScope, build_context, retrieve

MAX_QUESTIONS = 10


def find_course_material(db: Session, user: Principal, topic: str, lessons: dict, lesson_code: str | None = None,
                         top_k: int = 6) -> list[dict]:
    """Đoạn học liệu của khóa (các bài trong `lessons`) nói về chủ đề; rỗng = chủ đề không có trong khóa."""
    scope = RetrievalScope.for_user(user, lesson_id=lesson_code, lesson_ids=list(lessons))
    return [c for c in retrieve(db, topic, scope, top_k=top_k) if c.get("lesson_id") in lessons]


def create(db: Session, user: Principal, course, lessons: dict, topic: str, count: int = 5,
           lesson_code: str | None = None) -> dict:
    topic = (guardrails.clean_user_text(topic) or "").strip()[:200]
    if not guardrails.content_words(topic):
        raise AppError(400, "TOPIC_VAGUE", "Chủ đề chưa rõ. Hãy hỏi lại học sinh muốn luyện khái niệm / phần nào.")
    count = max(1, min(MAX_QUESTIONS, int(count or 5)))
    chunks = find_course_material(db, user, topic, lessons, lesson_code)
    if not chunks:
        return {"created": False, "reason": "not_in_course",
                "note": f"Không tìm thấy học liệu về «{topic}» trong khóa này nên không tạo quiz.",
                "course_lessons": [f"{code}: {ls.title}" for code, ls in lessons.items()][:20]}
    context, sources = build_context(chunks)
    prompt = (f"{wrap_documents(context)}\n\nChủ đề học sinh muốn luyện: «{topic}».\n"
              f"Yêu cầu: sinh {count} câu hỏi trắc nghiệm luyện tập về đúng chủ đề này. Mỗi câu ghi sources theo nhãn S1, S2…")
    out, _ = llm.complete_json("coach_practice", PRACTICE_QUIZ, prompt, QuizOutput, max_tokens=3500,
                               chunk_ids=[s["chunk_id"] for s in sources if s.get("chunk_id")], user_id=user.user_id)
    questions = []
    for q in out.questions:
        if not q.options or q.correct_index is None or q.type not in ("multiple_choice", "true_false"):
            continue  # chỉ giữ câu bấm chọn được và có đáp án xác định
        questions.append({"question": q.question.strip(), "options": q.options, "correct_index": q.correct_index,
                          "explanation": q.explanation.strip(), "sources": resolve_sources(q.sources, sources)})
        if len(questions) >= count:
            break
    if not questions:
        return {"created": False, "reason": "no_questions",
                "note": f"Học liệu của khóa chưa đủ để soạn câu hỏi về «{topic}»."}
    quiz = CoachPracticeQuiz(student_id=user.user_id, course_id=str(course.id) if course is not None else None,
                             lesson_code=lesson_code, topic=topic, questions=questions)
    db.add(quiz)
    db.commit()
    return {"created": True, "quiz_id": str(quiz.id), "topic": topic, "count": len(questions),
            "lessons": sorted({c["lesson_id"] for c in chunks if c.get("lesson_id")})}


def _own(db: Session, user: Principal, quiz_id) -> CoachPracticeQuiz:
    quiz = db.get(CoachPracticeQuiz, parse_uuid(quiz_id, "quiz_id"))
    if quiz is None or quiz.student_id != user.user_id:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy quiz luyện tập.")
    return quiz


def _result(quiz: CoachPracticeQuiz) -> dict:
    answers = quiz.answers or {}
    rows = []
    for i, q in enumerate(quiz.questions):
        chosen = answers.get(str(i))
        rows.append({"index": i, "chosen": chosen, "correct_index": q["correct_index"],
                     "correct": chosen == q["correct_index"], "explanation": q.get("explanation") or "",
                     "sources": q.get("sources") or []})
    return {"score": quiz.score, "correct": sum(1 for r in rows if r["correct"]), "total": len(rows), "questions": rows}


def public(quiz: CoachPracticeQuiz) -> dict:
    """Đề cho client. Chưa nộp: không có đáp án, lời giải, nguồn."""
    data = {"quiz_id": str(quiz.id), "topic": quiz.topic, "lesson_code": quiz.lesson_code,
            "questions": [{"index": i, "question": q["question"], "options": q["options"]}
                          for i, q in enumerate(quiz.questions)],
            "submitted": quiz.submitted_at is not None, "result": None}
    if quiz.submitted_at is not None:
        data["result"] = _result(quiz)
    return data


def get(db: Session, user: Principal, quiz_id) -> dict:
    return public(_own(db, user, quiz_id))


def submit(db: Session, user: Principal, quiz_id, answers: dict) -> dict:
    quiz = _own(db, user, quiz_id)
    if quiz.submitted_at is not None:  # nộp một lần; nộp lại trả kết quả cũ
        return public(quiz)
    clean: dict[str, int] = {}
    for i, q in enumerate(quiz.questions):
        v = answers.get(str(i), answers.get(i)) if isinstance(answers, dict) else None
        if isinstance(v, int) and 0 <= v < len(q["options"]):
            clean[str(i)] = v
    quiz.answers = clean
    quiz.score = round(sum(1 for i, q in enumerate(quiz.questions) if clean.get(str(i)) == q["correct_index"])
                       / len(quiz.questions), 4)
    quiz.submitted_at = utcnow()
    db.commit()
    return public(quiz)


def recent_mistakes(db: Session, user: Principal, course_id: str | None, limit: int = 8) -> list[dict]:
    """Câu làm sai trong các quiz luyện tập gần đây (chỉ đề + chủ đề), để Trợ lý biết học sinh còn yếu chỗ nào."""
    q = db.query(CoachPracticeQuiz).filter(CoachPracticeQuiz.student_id == user.user_id,
                                           CoachPracticeQuiz.submitted_at.isnot(None))
    if course_id:
        q = q.filter(CoachPracticeQuiz.course_id == course_id)
    out = []
    for quiz in q.order_by(CoachPracticeQuiz.submitted_at.desc()).limit(10):
        answers = quiz.answers or {}
        for i, item in enumerate(quiz.questions):
            if answers.get(str(i)) != item["correct_index"]:
                out.append({"topic": quiz.topic, "question": item["question"]})
    return out[:limit]
