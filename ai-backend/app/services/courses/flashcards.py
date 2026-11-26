"""Ôn thẻ ngắt quãng (SM-2 đơn giản). Thẻ = câu hỏi đã duyệt của bài, hoặc thẻ AI soạn từ học liệu đã được duyệt."""
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import and_, func, select, true, union_all
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import Principal
from app.core.utils import utcnow
from app.models.learning import Chapter, Course, FlashcardCard, FlashcardReview, ItemProgress, Lesson, LessonItem
from app.models.video_question import QuestionBankItem
from app.services.ai import llm
from app.services.ai.grading import correct_answer_text
from app.services.ai.lesson_ai import lesson_by_code, lesson_context, resolve_sources
from app.services.ai.prompts import FLASHCARD_GEN, wrap_documents
from app.services.ai.schemas import FlashcardsOutput
from app.services.courses import learning

RATINGS = {"again": 0, "hard": 1, "good": 2, "easy": 3}
AGAIN_MINUTES = 10  # thẻ sai được hỏi lại sau 10 phút trong cùng phiên


@dataclass
class Schedule:
    ease: float
    interval_days: float
    reps: int
    lapses: int


def next_schedule(s: Schedule, rating: str) -> tuple[Schedule, timedelta]:
    """Trả về lịch mới và khoảng thời gian tới lần ôn tiếp theo."""
    r = RATINGS[rating]
    ease, interval, reps, lapses = s.ease, s.interval_days, s.reps, s.lapses
    if r == 0:  # lại: quên, hỏi lại sớm và giảm độ dễ
        lapses += 1
        reps = 0
        ease = max(1.3, ease - 0.2)
        return Schedule(ease, 0.0, reps, lapses), timedelta(minutes=AGAIN_MINUTES)
    if r == 1:  # khó: tăng chậm hơn và giảm độ dễ
        ease = max(1.3, ease - 0.15)
        interval = max(1.0, interval * 1.2) if reps else 1.0
    else:
        if reps == 0:
            interval = 1.0
        elif reps == 1:
            interval = 3.0
        else:
            interval = interval * ease
        if r == 3:  # dễ: tăng khoảng cách nhiều hơn và tăng độ dễ
            ease += 0.15
            interval = max(interval * 1.3, interval + 1.0)
    reps += 1
    interval = round(interval, 2)
    return Schedule(ease, interval, reps, lapses), timedelta(days=interval)


@dataclass
class Card:
    """Thẻ ôn: câu hỏi đã duyệt trong ngân hàng, hoặc thẻ AI soạn đã được giáo viên duyệt."""
    id: str
    lesson_code: str
    front: str
    back: str
    explanation: str
    type: str
    sources: list | None = None


def _from_bank(b: QuestionBankItem) -> Card:
    q = learning._bank_as_question(b)
    return Card(str(b.id), b.lesson_id, q.question, correct_answer_text(q), q.explanation or "", q.type or "question")


def _from_ai(c: FlashcardCard) -> Card:
    return Card(str(c.id), c.lesson_code, c.front, c.back, "", "flashcard", c.sources)


def _card_dict(card: Card, reps: int | None) -> dict:
    return {"card_id": card.id, "front": card.front, "back": card.back, "explanation": card.explanation,
            "type": card.type, "sources": card.sources or [], "reps": reps or 0,
            "new": reps is None, "remembered": bool(reps)}


def _has_completed_item(user: Principal):
    return (select(LessonItem.id).join(ItemProgress, ItemProgress.item_id == LessonItem.id)
            .where(LessonItem.lesson_id == Lesson.id, ItemProgress.student_id == user.user_id,
                   ItemProgress.status == "completed").exists())


def _visible_lessons(db: Session, user: Principal):
    return (db.query(Lesson.code.label("code"), Lesson.title.label("title"), Lesson.id.label("lesson_id"),
                     Chapter.title.label("chapter_title"), Course.id.label("course_id"))
            .join(Chapter, Lesson.chapter_id == Chapter.id).join(Course, Chapter.course_id == Course.id)
            .filter(learning.visible_course_filter(user)))


def unlocked_lessons(db: Session, user: Principal):
    return _visible_lessons(db, user).filter(true() if user.is_teacher else _has_completed_item(user))


def _require_unlocked(db: Session, user: Principal, lesson_code: str) -> str:
    unlocked = true() if user.is_teacher else _has_completed_item(user)
    lesson = (_visible_lessons(db, user).with_entities(Lesson.title, unlocked.label("unlocked"))
              .filter(Lesson.code == lesson_code).first())
    if lesson is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bài học.")
    if not lesson.unlocked:
        raise AppError(403, "FLASHCARDS_LOCKED", "Hoàn thành ít nhất một mục trong bài để mở khóa thẻ ghi nhớ.")
    return lesson.title


def _card_rows(db: Session, user: Principal, lesson_codes):
    refs = union_all(
        select(QuestionBankItem.id.label("card_id"), QuestionBankItem.lesson_id.label("lesson_code"),
               QuestionBankItem.created_at.label("created_at"))
        .where(QuestionBankItem.lesson_id.in_(lesson_codes), QuestionBankItem.status == "approved"),
        select(FlashcardCard.id, FlashcardCard.lesson_code, FlashcardCard.created_at)
        .where(FlashcardCard.lesson_code.in_(lesson_codes), FlashcardCard.status == "approved"),
    ).subquery()
    return (db.query(refs.c.card_id, refs.c.lesson_code, refs.c.created_at,
                     FlashcardReview.reps, FlashcardReview.due_at)
            .outerjoin(FlashcardReview, and_(FlashcardReview.student_id == user.user_id,
                                            FlashcardReview.card_id == refs.c.card_id,
                                            FlashcardReview.lesson_code == refs.c.lesson_code)))


def _card_details(db: Session, rows) -> list[dict]:
    if not rows:
        return []
    ids = [row.card_id for row in rows]
    cards = {str(b.id): _from_bank(b) for b in db.query(QuestionBankItem).filter(
        QuestionBankItem.id.in_(ids), QuestionBankItem.status == "approved")}
    cards.update({str(c.id): _from_ai(c) for c in db.query(FlashcardCard).filter(
        FlashcardCard.id.in_(ids), FlashcardCard.status == "approved")})
    return [{**_card_dict(cards[str(row.card_id)], row.reps), "lesson_code": row.lesson_code}
            for row in rows if str(row.card_id) in cards]


def _counts_by_lesson(db: Session, user: Principal, lesson_codes) -> dict:
    rows = _card_rows(db, user, lesson_codes).subquery()
    return {r.lesson_code: {"total": r.total, "new": r.new, "due": r.due, "learned": r.learned}
            for r in db.query(
                rows.c.lesson_code,
                func.count().label("total"),
                func.count().filter(rows.c.reps.is_(None)).label("new"),
                func.count().filter((rows.c.due_at.is_(None)) | (rows.c.due_at <= utcnow())).label("due"),
                func.count().filter(rows.c.reps > 0).label("learned"),
            ).group_by(rows.c.lesson_code)}


EMPTY_COUNTS = {"total": 0, "new": 0, "due": 0, "learned": 0}


def summary(db: Session, user: Principal, lesson_code: str) -> dict:
    title = _require_unlocked(db, user, lesson_code)
    counts = _counts_by_lesson(db, user, [lesson_code])
    return {"lesson_code": lesson_code, "lesson_title": title, **counts.get(lesson_code, EMPTY_COUNTS)}


def overview(db: Session, user: Principal) -> list[dict]:
    courses = learning.visible_courses(db, user)
    lessons = unlocked_lessons(db, user).order_by(Chapter.position, Chapter.id, Lesson.position, Lesson.id).all()
    counts = _counts_by_lesson(db, user, [ls.code for ls in lessons]) if lessons else {}
    by_course: dict = {}
    for ls in lessons:
        if ls.code in counts:
            by_course.setdefault(ls.course_id, []).append({
                "lesson_code": ls.code, "lesson_title": ls.title, "lesson_id": str(ls.lesson_id),
                "chapter_title": ls.chapter_title, **counts[ls.code],
            })
    return [{"course_id": str(c.id), "code": c.code, "title": c.title,
             "total": sum(x["total"] for x in by_course.get(c.id, [])),
             "due": sum(x["due"] for x in by_course.get(c.id, [])),
             "lessons": by_course.get(c.id, [])} for c in courses]


def library_cards(db: Session, user: Principal, status: str, offset: int, limit: int) -> dict:
    lessons = unlocked_lessons(db, user).subquery()
    rows = _card_rows(db, user, select(lessons.c.code)).subquery()
    query = (db.query(rows, lessons.c.title.label("lesson_title")).select_from(rows)
             .join(lessons, lessons.c.code == rows.c.lesson_code))
    if status == "remembered":
        query = query.filter(rows.c.reps > 0)
    elif status == "unremembered":
        query = query.filter((rows.c.reps.is_(None)) | (rows.c.reps == 0))
    page = query.order_by(rows.c.lesson_code, rows.c.created_at, rows.c.card_id).offset(offset).limit(limit + 1).all()
    titles = {row.lesson_code: row.lesson_title for row in page}
    cards = _card_details(db, page[:limit])
    return {"cards": [{**card, "lesson_title": titles[card["lesson_code"]]} for card in cards],
            "next_offset": offset + limit if len(page) > limit else None}


def due_cards(db: Session, user: Principal, lesson_code: str, limit: int = 20) -> dict:
    _require_unlocked(db, user, lesson_code)
    rows = _card_rows(db, user, [lesson_code]).subquery()
    query = db.query(rows).filter((rows.c.due_at.is_(None)) | (rows.c.due_at <= utcnow()))
    due = query.order_by(rows.c.due_at.asc().nulls_last(), rows.c.created_at, rows.c.card_id).limit(limit).all()
    return {"lesson_code": lesson_code, "cards": _card_details(db, due), "remaining": query.count()}


def due_notifications(db: Session, user: Principal) -> list[dict]:
    lessons = unlocked_lessons(db, user).subquery()
    rows = _card_rows(db, user, select(lessons.c.code)).subquery()
    return [{"lesson_code": code, "lesson_title": title, "due": due}
            for code, title, due in (db.query(rows.c.lesson_code, lessons.c.title, func.count())
                                      .select_from(rows)
                                      .join(lessons, lessons.c.code == rows.c.lesson_code)
                                      .filter(rows.c.due_at <= utcnow())
                                      .group_by(rows.c.lesson_code, lessons.c.title))]


def queue_bank_card(db: Session, user: Principal, card: QuestionBankItem, now) -> None:
    db.execute(pg_insert(FlashcardReview).values(
        student_id=user.user_id, card_id=card.id, lesson_code=card.lesson_id, due_at=now,
    ).on_conflict_do_update(constraint="ux_flashcard_student_card",
                            set_={"due_at": func.least(FlashcardReview.due_at, now)}))


def _find_card(db: Session, card_id) -> Card | None:
    b = db.get(QuestionBankItem, card_id)
    if b is not None and b.status == "approved":
        return _from_bank(b)
    c = db.get(FlashcardCard, card_id)
    if c is not None and c.status == "approved":
        return _from_ai(c)
    return None


def review(db: Session, user: Principal, card_id, rating: str, remembered: bool | None = None) -> dict:
    if rating not in RATINGS:
        raise AppError(400, "INVALID_RATING", "rating phải là again, hard, good hoặc easy.")
    card = _find_card(db, card_id)
    if card is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy thẻ.")
    _require_unlocked(db, user, card.lesson_code)
    db.execute(pg_insert(FlashcardReview).values(
        student_id=user.user_id, card_id=card_id, lesson_code=card.lesson_code, due_at=utcnow(),
    ).on_conflict_do_nothing(constraint="ux_flashcard_student_card"))
    rv = db.query(FlashcardReview).filter(FlashcardReview.student_id == user.user_id,
                                         FlashcardReview.card_id == card_id).with_for_update().one()
    if remembered is None or (rv.last_reviewed_at is None or bool(rv.reps) != remembered):
        _apply_rating(rv, rating)
    db.commit()
    return {"card_id": card.id, "rating": rating, "next_due_at": rv.due_at.isoformat(),
            "interval_days": rv.interval_days, "reps": rv.reps, "remembered": bool(rv.reps)}


def _apply_rating(rv: FlashcardReview, rating: str) -> None:
    sched, delta = next_schedule(Schedule(rv.ease, rv.interval_days, rv.reps, rv.lapses), rating)
    now = utcnow()
    rv.ease, rv.interval_days, rv.reps, rv.lapses = sched.ease, sched.interval_days, sched.reps, sched.lapses
    rv.due_at, rv.last_reviewed_at = now + delta, now


# ---------------------------------------------------------------- giáo viên: AI soạn thẻ từ học liệu

def _ai_dict(c: FlashcardCard) -> dict:
    return {"card_id": str(c.id), "lesson_code": c.lesson_code, "front": c.front, "back": c.back,
            "sources": c.sources or [], "status": c.status,
            "created_at": c.created_at.isoformat() if c.created_at else None}


def generate_cards(db: Session, user: Principal, lesson_code: str, count: int = 10) -> list:
    """AI soạn thẻ ghi nhớ từ học liệu của bài; lưu dạng nháp để giáo viên duyệt."""
    lesson = lesson_by_code(db, user, lesson_code, teacher=True)
    context, sources = lesson_context(db, lesson)
    prompt = f"{wrap_documents(context)}\n\nHãy soạn {count} thẻ ghi nhớ cho bài: {lesson.title}."
    out, _ = llm.complete_json("teacher_flashcards", FLASHCARD_GEN, prompt, FlashcardsOutput, max_tokens=2500,
                               user_id=user.user_id, chunk_ids=[s["chunk_id"] for s in sources if s.get("chunk_id")])
    rows = []
    for item in out.cards[:count]:
        c = FlashcardCard(lesson_code=lesson.code, front=item.front.strip(), back=item.back.strip(),
                          sources=resolve_sources(item.sources, sources), status="draft", created_by=user.user_id)
        db.add(c)
        rows.append(c)
    db.commit()
    return [_ai_dict(c) for c in rows]


def list_ai_cards(db: Session, user: Principal, lesson_code: str, status: str | None = None) -> list:
    lesson = lesson_by_code(db, user, lesson_code, teacher=True)
    q = db.query(FlashcardCard).filter(FlashcardCard.lesson_code == lesson.code)
    if status:
        q = q.filter(FlashcardCard.status == status)
    return [_ai_dict(c) for c in q.order_by(FlashcardCard.created_at.desc()).limit(200).all()]


def update_ai_card(db: Session, user: Principal, card_id, front: str | None, back: str | None,
                   status: str | None) -> dict:
    c = db.get(FlashcardCard, card_id)
    if c is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy thẻ.")
    lesson_by_code(db, user, c.lesson_code, teacher=True)
    if front is not None:
        if not front.strip():
            raise AppError(400, "EMPTY", "Mặt trước không được để trống.")
        c.front = front.strip()[:300]
    if back is not None:
        if not back.strip():
            raise AppError(400, "EMPTY", "Mặt sau không được để trống.")
        c.back = back.strip()[:600]
    if status is not None:
        if status not in ("draft", "approved", "rejected"):
            raise AppError(400, "INVALID_STATUS", "status phải là draft, approved hoặc rejected.")
        c.status = status
    db.commit()
    return _ai_dict(c)
