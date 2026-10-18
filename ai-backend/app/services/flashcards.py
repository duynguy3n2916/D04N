"""Ôn thẻ ngắt quãng (SM-2 đơn giản). Thẻ = câu hỏi đã duyệt của bài, hoặc thẻ AI soạn từ học liệu đã được duyệt."""
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import Principal
from app.core.utils import as_aware, utcnow
from app.core.llm_schemas import FlashcardsOutput
from app.core.prompts import FLASHCARD_GEN, wrap_documents
from app.models.learning import FlashcardCard, FlashcardReview, Lesson
from app.models.video_question import QuestionBankItem
from app.services import learning, llm
from app.services.grading import correct_answer_text
from app.services.lesson_ai import lesson_by_code, lesson_context, resolve_sources

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


def _card_dict(card: Card, review: FlashcardReview | None) -> dict:
    return {"card_id": card.id, "front": card.front, "back": card.back, "explanation": card.explanation,
            "type": card.type, "sources": card.sources or [], "reps": review.reps if review else 0, "new": review is None}


def _lesson_cards(db: Session, user: Principal, lesson_code: str) -> list[Card]:
    lesson = db.query(Lesson).filter(Lesson.code == lesson_code).first()
    if lesson is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bài học.")
    learning.get_lesson(db, user, lesson.id)  # kiểm tra quyền xem bài
    bank = (db.query(QuestionBankItem).filter(QuestionBankItem.lesson_id == lesson_code,
                                              QuestionBankItem.status == "approved")
            .order_by(QuestionBankItem.created_at).all())
    ai = (db.query(FlashcardCard).filter(FlashcardCard.lesson_code == lesson_code, FlashcardCard.status == "approved")
          .order_by(FlashcardCard.created_at).all())
    return [_from_bank(b) for b in bank] + [_from_ai(c) for c in ai]


def _reviews(db: Session, user: Principal, lesson_code: str) -> dict:
    return {str(r.card_id): r for r in db.query(FlashcardReview).filter(
        FlashcardReview.student_id == user.user_id, FlashcardReview.lesson_code == lesson_code).all()}


def summary(db: Session, user: Principal, lesson_code: str) -> dict:
    cards = _lesson_cards(db, user, lesson_code)
    reviews = _reviews(db, user, lesson_code)
    now = utcnow()
    due = sum(1 for c in cards if c.id not in reviews or as_aware(reviews[c.id].due_at) <= now)
    new = sum(1 for c in cards if c.id not in reviews)
    return {"lesson_code": lesson_code, "total": len(cards), "new": new, "due": due,
            "learned": sum(1 for c in cards if c.id in reviews and reviews[c.id].reps >= 2)}


def due_cards(db: Session, user: Principal, lesson_code: str, limit: int = 20) -> dict:
    cards = _lesson_cards(db, user, lesson_code)
    reviews = _reviews(db, user, lesson_code)
    now = utcnow()
    due = [c for c in cards if c.id not in reviews or as_aware(reviews[c.id].due_at) <= now]
    due.sort(key=lambda c: (as_aware(reviews[c.id].due_at) if c.id in reviews else now))
    return {"lesson_code": lesson_code, "cards": [_card_dict(c, reviews.get(c.id)) for c in due[:limit]],
            "remaining": len(due)}


def _find_card(db: Session, card_id) -> Card | None:
    b = db.get(QuestionBankItem, card_id)
    if b is not None and b.status == "approved":
        return _from_bank(b)
    c = db.get(FlashcardCard, card_id)
    if c is not None and c.status == "approved":
        return _from_ai(c)
    return None


def review(db: Session, user: Principal, card_id, rating: str) -> dict:
    if rating not in RATINGS:
        raise AppError(400, "INVALID_RATING", "rating phải là again, hard, good hoặc easy.")
    card = _find_card(db, card_id)
    if card is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy thẻ.")
    lesson = db.query(Lesson).filter(Lesson.code == card.lesson_code).first()
    if lesson is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bài học của thẻ.")
    learning.get_lesson(db, user, lesson.id)
    rv = db.query(FlashcardReview).filter(FlashcardReview.student_id == user.user_id,
                                          FlashcardReview.card_id == card_id).first()
    if rv is None:
        rv = FlashcardReview(student_id=user.user_id, card_id=card_id, lesson_code=card.lesson_code,
                             due_at=utcnow(), ease=2.5, interval_days=0.0, reps=0, lapses=0)
        db.add(rv)
    sched, delta = next_schedule(Schedule(rv.ease, rv.interval_days, rv.reps, rv.lapses), rating)
    now = utcnow()
    rv.ease, rv.interval_days, rv.reps, rv.lapses = sched.ease, sched.interval_days, sched.reps, sched.lapses
    rv.due_at, rv.last_reviewed_at = now + delta, now
    db.commit()
    return {"card_id": card.id, "rating": rating, "next_due_at": rv.due_at.isoformat(),
            "interval_days": rv.interval_days, "reps": rv.reps}


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
