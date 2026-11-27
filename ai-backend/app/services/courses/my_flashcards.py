"""Thẻ ghi nhớ riêng của học sinh: tự viết hoặc nhờ AI soạn (từ bài học hay ghi chú tự dán), ôn theo SM-2."""
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import Principal
from app.core.utils import utcnow
from app.models.learning import PersonalFlashcard
from app.services.ai import llm
from app.services.ai.guardrails import wrap_documents
from app.services.ai.lesson_ai import lesson_by_code, lesson_context, resolve_sources
from app.services.ai.prompts import STUDENT_FLASHCARD_GEN
from app.services.ai.schemas import FlashcardsOutput
from app.services.courses.flashcards import RATINGS, Schedule, next_schedule

MAX_CARDS = 1000  # mỗi học sinh tối đa bấy nhiêu thẻ riêng


def _dict(c: PersonalFlashcard) -> dict:
    now = utcnow()
    return {"card_id": str(c.id), "deck": c.deck or "", "lesson_code": c.lesson_code, "front": c.front,
            "back": c.back, "origin": c.origin, "sources": c.sources or [], "reps": c.reps,
            "new": c.last_reviewed_at is None, "remembered": c.reps > 0,
            "due": c.due_at is None or c.due_at <= now,
            "due_at": c.due_at.isoformat() if c.due_at else None,
            "created_at": c.created_at.isoformat() if c.created_at else None}


def _clean(text: str | None, limit: int, field: str) -> str:
    v = (text or "").strip()
    if not v:
        raise AppError(400, "EMPTY", f"{field} không được để trống.")
    return v[:limit]


def _deck(deck: str | None) -> str | None:
    return (deck or "").strip()[:120] or None


def _own(db: Session, user: Principal, card_id) -> PersonalFlashcard:
    c = db.get(PersonalFlashcard, card_id)
    if c is None or c.owner_id != user.user_id:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy thẻ.")
    return c


def _check_quota(db: Session, user: Principal, adding: int) -> None:
    n = db.query(func.count(PersonalFlashcard.id)).filter(PersonalFlashcard.owner_id == user.user_id).scalar() or 0
    if n + adding > MAX_CARDS:
        raise AppError(400, "TOO_MANY_CARDS", f"Bạn đã có {n} thẻ, tối đa {MAX_CARDS}. Xóa bớt thẻ cũ trước nhé.")


def list_cards(db: Session, user: Principal, deck: str | None = None, due_only: bool = False) -> dict:
    q = db.query(PersonalFlashcard).filter(PersonalFlashcard.owner_id == user.user_id)
    rows = q.order_by(PersonalFlashcard.created_at.desc(), PersonalFlashcard.id).all()
    decks = sorted({c.deck for c in rows if c.deck})
    if deck is not None:
        rows = [c for c in rows if (c.deck or "") == deck]
    cards = [_dict(c) for c in rows]
    due = [c for c in cards if c["due"]]
    if due_only:
        # đến hạn lâu nhất trước, thẻ mới xếp sau
        cards = sorted(due, key=lambda c: (c["new"], c["due_at"] or ""))
    return {"cards": cards, "decks": decks, "total": len(rows), "due": len(due),
            "learned": sum(1 for c in rows if c.reps > 0)}


def create_card(db: Session, user: Principal, front: str, back: str, deck: str | None) -> dict:
    _check_quota(db, user, 1)
    c = PersonalFlashcard(owner_id=user.user_id, front=_clean(front, 300, "Mặt trước"),
                          back=_clean(back, 600, "Mặt sau"), deck=_deck(deck), origin="manual", due_at=utcnow())
    db.add(c)
    db.commit()
    return _dict(c)


def update_card(db: Session, user: Principal, card_id, front: str | None, back: str | None,
                deck: str | None) -> dict:
    c = _own(db, user, card_id)
    if front is not None:
        c.front = _clean(front, 300, "Mặt trước")
    if back is not None:
        c.back = _clean(back, 600, "Mặt sau")
    if deck is not None:
        c.deck = _deck(deck)
    db.commit()
    return _dict(c)


def delete_card(db: Session, user: Principal, card_id) -> dict:
    c = _own(db, user, card_id)
    db.delete(c)
    db.commit()
    return {"ok": True}


def review(db: Session, user: Principal, card_id, rating: str) -> dict:
    if rating not in RATINGS:
        raise AppError(400, "INVALID_RATING", "rating phải là again, hard, good hoặc easy.")
    c = _own(db, user, card_id)
    sched, delta = next_schedule(Schedule(c.ease, c.interval_days, c.reps, c.lapses), rating)
    now = utcnow()
    c.ease, c.interval_days, c.reps, c.lapses = sched.ease, sched.interval_days, sched.reps, sched.lapses
    c.due_at, c.last_reviewed_at = now + delta, now
    db.commit()
    return {"card_id": str(c.id), "rating": rating, "next_due_at": c.due_at.isoformat(),
            "interval_days": c.interval_days, "remembered": c.reps > 0}


def generate(db: Session, user: Principal, count: int, lesson_code: str | None, text: str | None,
             deck: str | None, grounded: tuple[str, list[dict]] | None = None) -> list[dict]:
    """AI soạn thẻ từ học liệu một bài học (học sinh xem được) hoặc từ ghi chú/chủ đề học sinh tự nhập.
    grounded=(context, sources): học liệu đã truy xuất theo chủ đề (Trợ lý dùng để thẻ bám đúng học liệu của khóa)."""
    _check_quota(db, user, count)
    sources: list[dict] = []
    if grounded is not None:
        context, sources = grounded
        topic = f"chủ đề «{(text or '').strip()[:200]}» (chỉ dùng phần học liệu nói về chủ đề này)"
    elif lesson_code:
        lesson = lesson_by_code(db, user, lesson_code)
        context, sources = lesson_context(db, lesson)
        topic = f"bài {lesson.title}"
        deck = deck or lesson.title
    else:
        context = (text or "").strip()
        if len(context) < 3:
            raise AppError(400, "EMPTY", "Nhập chủ đề hoặc dán ghi chú để AI soạn thẻ.")
        context = context[:12000]
        topic = "nội dung trên"
    prompt = f"{wrap_documents(context)}\n\nHãy soạn {count} thẻ ghi nhớ cho {topic}."
    out, _ = llm.complete_json("student_flashcards", STUDENT_FLASHCARD_GEN, prompt, FlashcardsOutput, max_tokens=2500,
                               user_id=user.user_id,
                               chunk_ids=[s["chunk_id"] for s in sources if s.get("chunk_id")] or None)
    now = utcnow()
    rows = []
    for item in out.cards[:count]:
        c = PersonalFlashcard(owner_id=user.user_id, front=item.front.strip()[:300], back=item.back.strip()[:600],
                              deck=_deck(deck), lesson_code=lesson_code or None, origin="ai",
                              sources=resolve_sources(item.sources, sources) if sources else None, due_at=now)
        db.add(c)
        rows.append(c)
    db.commit()
    return [_dict(c) for c in rows]
