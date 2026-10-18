"""Thông báo chưa đọc: bài / trả lời mới trong diễn đàn lớp, thẻ flashcard đến hạn ôn.

Không gửi push hay email: giao diện hỏi định kỳ và hiện số trên thanh menu.
"""
from datetime import timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import Principal
from app.core.utils import utcnow
from app.models.learning import FlashcardReview, ForumReply, ForumThread, Lesson, UserSeen

DEFAULT_LOOKBACK_DAYS = 7  # chưa từng xem: chỉ tính nội dung 7 ngày gần nhất để không báo quá nhiều


def _seen_at(db: Session, user: Principal, key: str):
    row = db.query(UserSeen).filter(UserSeen.user_id == user.user_id, UserSeen.key == key).first()
    return row.seen_at if row else func.now() - timedelta(days=DEFAULT_LOOKBACK_DAYS)


def mark_seen(db: Session, user: Principal, key: str) -> dict:
    key = (key or "").strip()
    if not key.startswith("forum:") or len(key) > 160:
        raise AppError(400, "INVALID_KEY", "key không hợp lệ.")
    if key[len("forum:"):] not in (user.class_ids or []) and not user.is_admin:
        raise AppError(403, "FORBIDDEN", "Bạn không thuộc lớp này.")
    row = db.query(UserSeen).filter(UserSeen.user_id == user.user_id, UserSeen.key == key).first()
    # dùng giờ của database (giống created_at của bài viết) để không lệch giữa đồng hồ app và DB
    if row is None:
        row = UserSeen(user_id=user.user_id, key=key, seen_at=func.now())
        db.add(row)
    else:
        row.seen_at = func.now()
    db.commit()
    db.refresh(row)
    return {"key": key, "seen_at": row.seen_at.isoformat()}


def summary(db: Session, user: Principal) -> dict:
    forum: dict[str, int] = {}
    for cid in user.class_ids or []:
        since = _seen_at(db, user, f"forum:{cid}")
        threads = (db.query(func.count(ForumThread.id))
                   .filter(ForumThread.class_id == cid, ForumThread.created_at > since,
                           ForumThread.author_id != user.user_id, ForumThread.hidden.isnot(True)).scalar() or 0)
        replies = (db.query(func.count(ForumReply.id)).join(ForumThread, ForumReply.thread_id == ForumThread.id)
                   .filter(ForumThread.class_id == cid, ForumReply.created_at > since,
                           ForumReply.author_id != user.user_id, ForumReply.hidden.isnot(True),
                           ForumThread.hidden.isnot(True)).scalar() or 0)
        forum[cid] = int(threads) + int(replies)

    now = utcnow()
    due_rows = (db.query(FlashcardReview.lesson_code, func.count(FlashcardReview.id))
                .filter(FlashcardReview.student_id == user.user_id, FlashcardReview.due_at <= now)
                .group_by(FlashcardReview.lesson_code).all())
    titles = dict(db.query(Lesson.code, Lesson.title).filter(Lesson.code.in_([c for c, _ in due_rows])).all()) if due_rows else {}
    flashcards = [{"lesson_code": code, "lesson_title": titles.get(code, code), "due": int(n)} for code, n in due_rows]
    return {"forum_new": sum(forum.values()), "forum_by_class": forum,
            "flashcards_due": sum(f["due"] for f in flashcards), "flashcards": flashcards}
