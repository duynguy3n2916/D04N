"""Thẻ ghi nhớ riêng của học sinh: tự viết hoặc nhờ AI soạn (từ bài học hay ghi chú tự dán), ôn theo SM-2."""
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import Principal
from app.core.utils import utcnow
from app.core.utils import parse_uuid
from app.models.learning import Chapter, Lesson, PersonalFlashcard
from app.services.ai import llm
from app.services.ai.guardrails import wrap_documents
from app.services.ai.lesson_ai import lesson_by_code, lesson_context, resolve_sources
from app.services.ai.prompts import STUDENT_FLASHCARD_GEN
from app.services.ai.schemas import FlashcardsOutput
from app.services.courses import learning
from app.services.courses.flashcards import RATINGS, Schedule, next_schedule

MAX_CARDS = 1000  # mỗi học sinh tối đa bấy nhiêu thẻ riêng


def _dict(c: PersonalFlashcard) -> dict:
    now = utcnow()
    return {"card_id": str(c.id), "course_id": str(c.course_id) if c.course_id else None, "deck": c.deck or "", "lesson_code": c.lesson_code, "front": c.front,
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


def _course_of_lesson(db: Session, lesson_code: str | None):
    if not lesson_code:
        return None
    return (db.query(Chapter.course_id).join(Lesson, Lesson.chapter_id == Chapter.id)
            .filter(Lesson.code == lesson_code).scalar())


def _resolve_course(db: Session, user: Principal, course_id) -> object | None:
    """course_id học sinh chọn ("" / None = thẻ ngoài khóa); phải là khóa học sinh được học."""
    if not course_id:
        return None
    cid = parse_uuid(str(course_id), "course_id")
    if not any(c.id == cid for c in learning.visible_courses(db, user)):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy khóa học.")
    return cid


def list_cards(db: Session, user: Principal, deck: str | None = None, due_only: bool = False) -> dict:
    rows = (db.query(PersonalFlashcard).filter(PersonalFlashcard.owner_id == user.user_id)
            .order_by(PersonalFlashcard.created_at.desc(), PersonalFlashcard.id).all())
    # thẻ cũ chưa có course_id: suy ra từ bài học nguồn (backfill dần, mỗi bài một truy vấn)
    missing = {c.lesson_code for c in rows if c.course_id is None and c.lesson_code}
    if missing:
        found = {code: _course_of_lesson(db, code) for code in missing}
        for c in rows:
            if c.course_id is None and found.get(c.lesson_code):
                c.course_id = found[c.lesson_code]
        db.commit()
    courses = learning.visible_courses(db, user)
    titles = {c.id: c.title for c in courses}
    if deck is not None:
        rows = [c for c in rows if (c.deck or "") == deck]
    cards = [_dict(c) for c in rows]
    groups: dict = {}
    for c in cards:
        g = groups.setdefault((c["course_id"], c["deck"]), {"course_id": c["course_id"], "deck": c["deck"],
                                                          "total": 0, "due": 0, "learned": 0})
        g["total"] += 1
        g["due"] += int(c["due"])
        g["learned"] += int(c["remembered"])
    due = [c for c in cards if c["due"]]
    if due_only:
        # đến hạn lâu nhất trước, thẻ mới xếp sau
        cards = sorted(due, key=lambda c: (c["new"], c["due_at"] or ""))
    return {"cards": cards, "decks": sorted(groups.values(), key=lambda g: (g["deck"] == "", g["deck"].lower())),
            "courses": [{"course_id": str(c.id), "title": c.title} for c in courses],
            "course_titles": {str(k): v for k, v in titles.items()},
            "total": len(rows), "due": len(due), "learned": sum(1 for c in rows if c.reps > 0)}


def rename_deck(db: Session, user: Principal, course_id, deck: str, new_deck: str | None, new_course_id=None,
                move_course: bool = False) -> dict:
    """Đổi tên bộ thẻ (và có thể chuyển sang khóa khác): áp cho mọi thẻ trong bộ."""
    cid = parse_uuid(str(course_id), "course_id") if course_id else None
    q = db.query(PersonalFlashcard).filter(PersonalFlashcard.owner_id == user.user_id,
                                           PersonalFlashcard.course_id.is_(None) if cid is None
                                           else PersonalFlashcard.course_id == cid)
    q = q.filter(PersonalFlashcard.deck.is_(None) | (PersonalFlashcard.deck == "")) if not deck else q.filter(PersonalFlashcard.deck == deck)
    values: dict = {"deck": _deck(new_deck)}
    if move_course:
        values["course_id"] = _resolve_course(db, user, new_course_id)
    n = q.update(values, synchronize_session=False)
    db.commit()
    return {"updated": n}


def delete_deck(db: Session, user: Principal, course_id, deck: str) -> dict:
    cid = parse_uuid(str(course_id), "course_id") if course_id else None
    q = db.query(PersonalFlashcard).filter(PersonalFlashcard.owner_id == user.user_id,
                                           PersonalFlashcard.course_id.is_(None) if cid is None
                                           else PersonalFlashcard.course_id == cid)
    q = q.filter(PersonalFlashcard.deck.is_(None) | (PersonalFlashcard.deck == "")) if not deck else q.filter(PersonalFlashcard.deck == deck)
    n = q.delete(synchronize_session=False)
    db.commit()
    return {"deleted": n}


def create_card(db: Session, user: Principal, front: str, back: str, deck: str | None, course_id=None) -> dict:
    _check_quota(db, user, 1)
    c = PersonalFlashcard(owner_id=user.user_id, course_id=_resolve_course(db, user, course_id),
                          front=_clean(front, 300, "Mặt trước"),
                          back=_clean(back, 600, "Mặt sau"), deck=_deck(deck), origin="manual", due_at=utcnow())
    db.add(c)
    db.commit()
    return _dict(c)


def update_card(db: Session, user: Principal, card_id, front: str | None, back: str | None,
                deck: str | None, course_id=None, move_course: bool = False) -> dict:
    c = _own(db, user, card_id)
    if move_course:
        c.course_id = _resolve_course(db, user, course_id)
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
             deck: str | None, grounded: tuple[str, list[dict]] | None = None, course_id=None) -> list[dict]:
    """AI soạn thẻ từ học liệu một bài học (học sinh xem được) hoặc từ ghi chú/chủ đề học sinh tự nhập.
    grounded=(context, sources): học liệu đã truy xuất theo chủ đề (Trợ lý dùng để thẻ bám đúng học liệu của khóa)."""
    _check_quota(db, user, count)
    course = _resolve_course(db, user, course_id)
    sources: list[dict] = []
    if grounded is not None:
        context, sources = grounded
        topic = f"chủ đề «{(text or '').strip()[:200]}» (chỉ dùng phần học liệu nói về chủ đề này)"
    elif lesson_code:
        lesson = lesson_by_code(db, user, lesson_code)
        context, sources = lesson_context(db, lesson)
        topic = f"bài {lesson.title}"
        deck = deck or lesson.title
        course = lesson.chapter.course_id
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
                              deck=_deck(deck), lesson_code=lesson_code or None, origin="ai", course_id=course,
                              sources=resolve_sources(item.sources, sources) if sources else None, due_at=now)
        db.add(c)
        rows.append(c)
    db.commit()
    return [_dict(c) for c in rows]
