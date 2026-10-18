"""Ôn thẻ ngắt quãng (SM-2 đơn giản). Thẻ = câu hỏi đã duyệt của bài; mặt sau là đáp án và giải thích."""
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import Principal
from app.core.utils import as_aware, utcnow
from app.models.learning import FlashcardReview, Lesson
from app.models.video_question import QuestionBankItem
from app.services import learning
from app.services.grading import correct_answer_text

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


def _card_dict(card: QuestionBankItem, review: FlashcardReview | None) -> dict:
    q = learning._bank_as_question(card)
    return {"card_id": str(card.id), "front": q.question, "back": correct_answer_text(q),
            "explanation": q.explanation or "", "type": q.type,
            "reps": review.reps if review else 0, "new": review is None}


def _lesson_cards(db: Session, user: Principal, lesson_code: str) -> list[QuestionBankItem]:
    lesson = db.query(Lesson).filter(Lesson.code == lesson_code).first()
    if lesson is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bài học.")
    learning.get_lesson(db, user, lesson.id)  # kiểm tra quyền xem bài
    return (db.query(QuestionBankItem).filter(QuestionBankItem.lesson_id == lesson_code,
                                              QuestionBankItem.status == "approved")
            .order_by(QuestionBankItem.created_at).all())


def summary(db: Session, user: Principal, lesson_code: str) -> dict:
    cards = _lesson_cards(db, user, lesson_code)
    reviews = {str(r.card_id): r for r in db.query(FlashcardReview).filter(
        FlashcardReview.student_id == user.user_id, FlashcardReview.lesson_code == lesson_code).all()}
    now = utcnow()
    due = sum(1 for c in cards if str(c.id) not in reviews or as_aware(reviews[str(c.id)].due_at) <= now)
    new = sum(1 for c in cards if str(c.id) not in reviews)
    return {"lesson_code": lesson_code, "total": len(cards), "new": new, "due": due,
            "learned": sum(1 for r in reviews.values() if r.reps >= 2)}


def due_cards(db: Session, user: Principal, lesson_code: str, limit: int = 20) -> dict:
    cards = _lesson_cards(db, user, lesson_code)
    reviews = {str(r.card_id): r for r in db.query(FlashcardReview).filter(
        FlashcardReview.student_id == user.user_id, FlashcardReview.lesson_code == lesson_code).all()}
    now = utcnow()
    due = [c for c in cards if str(c.id) not in reviews or as_aware(reviews[str(c.id)].due_at) <= now]
    due.sort(key=lambda c: (as_aware(reviews[str(c.id)].due_at) if str(c.id) in reviews else now))
    picked = due[:limit]
    return {"lesson_code": lesson_code, "cards": [_card_dict(c, reviews.get(str(c.id))) for c in picked],
            "remaining": len(due)}


def review(db: Session, user: Principal, card_id, rating: str) -> dict:
    if rating not in RATINGS:
        raise AppError(400, "INVALID_RATING", "rating phải là again, hard, good hoặc easy.")
    card = db.get(QuestionBankItem, card_id)
    if card is None or card.status != "approved":
        raise AppError(404, "NOT_FOUND", "Không tìm thấy thẻ.")
    lesson = db.query(Lesson).filter(Lesson.code == card.lesson_id).first()
    if lesson is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bài học của thẻ.")
    learning.get_lesson(db, user, lesson.id)
    rv = db.query(FlashcardReview).filter(FlashcardReview.student_id == user.user_id,
                                          FlashcardReview.card_id == card.id).first()
    if rv is None:
        rv = FlashcardReview(student_id=user.user_id, card_id=card.id, lesson_code=card.lesson_id,
                             due_at=utcnow(), ease=2.5, interval_days=0.0, reps=0, lapses=0)
        db.add(rv)
    sched, delta = next_schedule(Schedule(rv.ease, rv.interval_days, rv.reps, rv.lapses), rating)
    now = utcnow()
    rv.ease, rv.interval_days, rv.reps, rv.lapses = sched.ease, sched.interval_days, sched.reps, sched.lapses
    rv.due_at, rv.last_reviewed_at = now + delta, now
    db.commit()
    return {"card_id": str(card.id), "rating": rating, "next_due_at": rv.due_at.isoformat(),
            "interval_days": rv.interval_days, "reps": rv.reps}
