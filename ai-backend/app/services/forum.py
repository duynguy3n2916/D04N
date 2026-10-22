"""Mạng xã hội học tập của lớp (diễn đàn): bảng tin bài đăng (câu hỏi / chia sẻ / thông báo), thích, bình luận lồng 1 tầng,
@nhắc tên, ảnh đính kèm, thẻ chủ đề, tìm kiếm; giáo viên ghim / khóa / ẩn / đánh dấu câu đúng / xử lý báo cáo.
AI chỉ soạn bản nháp để giáo viên duyệt, không tự đăng.
"""
import re
from datetime import timedelta

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.prompts import TUTOR_ANSWER, wrap_documents
from app.core.security import Principal
from app.core.utils import clean_id, redact_pii, utcnow
from app.models.accounts import User
from app.models.learning import ForumReply, ForumReport, ForumThread, Lesson
from app.models.social import ForumImage, ForumReaction, UserNotification
from app.services import llm
from app.services.retrieval import RetrievalScope, build_context, retrieve

MAX_TITLE = 200
MAX_BODY = 5000
MAX_TAGS = 5
MAX_IMAGES = 4
KINDS = ("question", "post", "announcement")
SORTS = ("new", "top", "unanswered")
_MENTION = re.compile(r"(?<![\w@])@([a-z0-9][a-z0-9._-]{2,63})")
_TAG = re.compile(r"^[\w.-]{1,30}$", re.UNICODE)


def _is_member(user: Principal, class_id: str) -> bool:
    return user.is_admin or class_id in (user.class_ids or [])


def _is_moderator(user: Principal, class_id: str) -> bool:
    return user.is_admin or (user.is_teacher and class_id in (user.class_ids or []))


def _require_member(user: Principal, class_id: str) -> None:
    if not _is_member(user, class_id):
        raise AppError(403, "FORBIDDEN", "Bạn không thuộc lớp này.")


def _text(value: str, field: str, limit: int) -> str:
    v = (value or "").strip()
    if not v:
        raise AppError(400, "EMPTY", f"{field} không được để trống.")
    if len(v) > limit:
        raise AppError(400, "TOO_LONG", f"{field} tối đa {limit} ký tự.")
    return v


def _names(db: Session, user_ids: set[str]) -> dict[str, str]:
    users = db.query(User).filter(User.user_id.in_(list(user_ids))).all() if user_ids else []
    return {u.user_id: (u.display_name or u.user_id) for u in users}


def _iso(dt) -> str | None:
    return dt.isoformat() if dt else None


# ---------------------------------------------------------------- thẻ, ảnh, nhắc tên

def _clean_tags(tags: list[str] | None) -> list[str]:
    out: list[str] = []
    for t in tags or []:
        t = str(t).strip().lstrip("#").lower()
        if t and _TAG.match(t) and t not in out:
            out.append(t)
    return out[:MAX_TAGS]


def _check_images(db: Session, user: Principal, class_id: str, image_ids: list | None) -> list[str]:
    ids = [str(i) for i in (image_ids or [])][:MAX_IMAGES]
    if not ids:
        return []
    rows = {str(r.id): r for r in db.query(ForumImage).filter(ForumImage.id.in_(ids)).all()}
    for i in ids:
        r = rows.get(i)
        if r is None or r.class_id != class_id or r.uploader_id != user.user_id:
            raise AppError(400, "INVALID_IMAGE", "Ảnh đính kèm không hợp lệ.")
    return ids


def class_members(db: Session, class_id: str) -> list[User]:
    return (db.query(User).filter(User.class_ids.contains([class_id]), User.is_active.is_(True))
            .order_by(User.role.desc(), User.user_id).all())


def list_members(db: Session, user: Principal, class_id: str) -> list[dict]:
    """Thành viên lớp (để gợi ý @nhắc tên và mở tin nhắn riêng)."""
    class_id = clean_id(class_id) or ""
    _require_member(user, class_id)
    return [{"user_id": u.user_id, "name": u.display_name or u.user_id, "role": u.role} for u in class_members(db, class_id)]


def list_lessons(db: Session, user: Principal, class_id: str) -> list[dict]:
    """Bài học trong các khóa của lớp (để gắn thẻ bài học vào bài đăng và lọc bảng tin)."""
    from sqlalchemy import select
    from app.models.learning import Chapter, Course, CourseClass
    class_id = clean_id(class_id) or ""
    _require_member(user, class_id)
    rows = (db.query(Lesson.code, Lesson.title, Course.title).join(Chapter, Lesson.chapter_id == Chapter.id)
            .join(Course, Chapter.course_id == Course.id)
            .filter(or_(Course.class_id == class_id, Course.class_id.is_(None),
                        Course.id.in_(select(CourseClass.course_id).where(CourseClass.class_id == class_id))))
            .order_by(Course.title, Chapter.position, Lesson.position).limit(500).all())
    return [{"code": code, "title": title, "course_title": course} for code, title, course in rows]


def _notify(db: Session, user_id: str, kind: str, actor: Principal, class_id: str, thread_id, text: str) -> None:
    if user_id and user_id != actor.user_id:
        db.add(UserNotification(user_id=user_id, kind=kind, actor_id=actor.user_id, class_id=class_id,
                                thread_id=thread_id, text=text[:300]))


def _notify_mentions(db: Session, actor: Principal, class_id: str, thread_id, body: str, title: str,
                     skip: set[str]) -> list[str]:
    """Gửi thông báo cho người được @nhắc (chỉ thành viên cùng lớp). Trả về danh sách đã nhắc."""
    wanted = {m.lower() for m in _MENTION.findall(body or "")} - skip - {actor.user_id}
    if not wanted:
        return []
    found = (db.query(User.user_id).filter(User.user_id.in_(list(wanted)), User.class_ids.contains([class_id]),
                                           User.is_active.is_(True)).all())
    names = _names(db, {actor.user_id})
    for (uid,) in found:
        _notify(db, uid, "mention", actor, class_id, thread_id, f"{names.get(actor.user_id)} nhắc bạn trong “{title}”")
    return [uid for (uid,) in found]


# ---------------------------------------------------------------- bài đăng

def _thread_dict(t: ForumThread, names: dict[str, str], replies: int = 0, has_answer: bool = False,
                 likes: int = 0, liked: bool = False) -> dict:
    return {"thread_id": str(t.id), "class_id": t.class_id, "lesson_code": t.lesson_code, "title": t.title,
            "body": t.body, "kind": t.kind or "question", "tags": t.tags or [],
            "images": [f"/ai/forum/images/{i}" for i in (t.images or [])],
            "author_id": t.author_id, "author_name": names.get(t.author_id, t.author_id),
            "pinned": bool(t.pinned), "locked": bool(t.locked), "hidden": bool(t.hidden),
            "reply_count": replies, "has_answer": has_answer, "like_count": likes, "liked": liked,
            "created_at": _iso(t.created_at), "updated_at": _iso(t.updated_at)}


def _likes(db: Session, user: Principal, target_type: str, ids: list) -> tuple[dict, set]:
    if not ids:
        return {}, set()
    counts = dict(db.query(ForumReaction.target_id, func.count(ForumReaction.id))
                  .filter(ForumReaction.target_type == target_type, ForumReaction.target_id.in_(ids))
                  .group_by(ForumReaction.target_id).all())
    mine = {r for (r,) in db.query(ForumReaction.target_id).filter(
        ForumReaction.target_type == target_type, ForumReaction.target_id.in_(ids),
        ForumReaction.user_id == user.user_id).all()}
    return counts, mine


def list_threads(db: Session, user: Principal, class_id: str, lesson_code: str | None = None, sort: str = "new",
                 tag: str | None = None, q: str | None = None, kind: str | None = None) -> list[dict]:
    """Bảng tin của lớp. Thông báo và bài ghim luôn ở đầu; sort = new | top (nhiều thích, 30 ngày) | unanswered."""
    class_id = clean_id(class_id) or ""
    _require_member(user, class_id)
    sort = sort if sort in SORTS else "new"
    query = db.query(ForumThread).filter(ForumThread.class_id == class_id)
    if not _is_moderator(user, class_id):
        query = query.filter(ForumThread.hidden.isnot(True))
    if lesson_code:
        query = query.filter(ForumThread.lesson_code == lesson_code)
    if kind in KINDS:
        query = query.filter(ForumThread.kind == kind)
    if tag:
        query = query.filter(ForumThread.tags.contains([tag.strip().lstrip("#").lower()]))
    if q and q.strip():
        like = f"%{q.strip()[:100]}%"
        query = query.filter(or_(ForumThread.title.ilike(like), ForumThread.body.ilike(like)))
    if sort == "top":
        query = query.filter(ForumThread.created_at >= utcnow() - timedelta(days=30))
    threads = query.order_by(ForumThread.created_at.desc()).limit(300).all()
    if not threads:
        return []
    ids = [t.id for t in threads]
    counts = dict(db.query(ForumReply.thread_id, func.count(ForumReply.id))
                  .filter(ForumReply.thread_id.in_(ids), ForumReply.hidden.isnot(True))
                  .group_by(ForumReply.thread_id).all())
    accepted = {r for (r,) in db.query(ForumReply.thread_id).filter(ForumReply.thread_id.in_(ids),
                                                                  ForumReply.accepted.is_(True)).all()}
    likes, mine = _likes(db, user, "thread", ids)
    names = _names(db, {t.author_id for t in threads})
    rows = [_thread_dict(t, names, int(counts.get(t.id, 0)), t.id in accepted, int(likes.get(t.id, 0)), t.id in mine)
            for t in threads]
    if sort == "unanswered":
        rows = [r for r in rows if r["kind"] == "question" and not r["has_answer"] and r["reply_count"] == 0]
    elif sort == "top":
        rows.sort(key=lambda r: (r["like_count"], r["reply_count"]), reverse=True)
    # thông báo của giáo viên và bài ghim lên đầu (giữ thứ tự bên trong mỗi nhóm)
    rows.sort(key=lambda r: (r["kind"] != "announcement", not r["pinned"]))
    return rows[:200]


def create_thread(db: Session, user: Principal, class_id: str, title: str, body: str, lesson_code: str | None,
                  kind: str = "question", tags: list[str] | None = None, images: list | None = None) -> dict:
    class_id = clean_id(class_id) or ""
    _require_member(user, class_id)
    kind = kind if kind in KINDS else "question"
    if kind == "announcement" and not _is_moderator(user, class_id):
        raise AppError(403, "FORBIDDEN", "Chỉ giáo viên của lớp mới đăng thông báo.")
    lesson_code = clean_id(lesson_code)
    if lesson_code and not db.query(Lesson.id).filter(Lesson.code == lesson_code).first():
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bài học.")
    t = ForumThread(class_id=class_id, lesson_code=lesson_code, author_id=user.user_id, kind=kind,
                    title=_text(title, "Tiêu đề", MAX_TITLE), body=_text(body, "Nội dung", MAX_BODY),
                    tags=_clean_tags(tags) or None, images=_check_images(db, user, class_id, images) or None)
    db.add(t)
    db.flush()
    _notify_mentions(db, user, class_id, t.id, t.body, t.title, set())
    db.commit()
    db.refresh(t)
    return _thread_dict(t, _names(db, {t.author_id}))


def get_thread(db: Session, user: Principal, thread_id) -> dict:
    t = db.get(ForumThread, thread_id)
    if t is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bài đăng.")
    _require_member(user, t.class_id)
    moderator = _is_moderator(user, t.class_id)
    if t.hidden and not moderator:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bài đăng.")
    replies = db.query(ForumReply).filter(ForumReply.thread_id == t.id).order_by(ForumReply.created_at).all()
    if not moderator:
        replies = [r for r in replies if not r.hidden]
    names = _names(db, {t.author_id} | {r.author_id for r in replies})
    t_likes, t_mine = _likes(db, user, "thread", [t.id])
    r_likes, r_mine = _likes(db, user, "reply", [r.id for r in replies])
    out = _thread_dict(t, names, len(replies), any(r.accepted for r in replies), int(t_likes.get(t.id, 0)), t.id in t_mine)
    out["replies"] = [{"reply_id": str(r.id), "parent_id": str(r.parent_id) if r.parent_id else None, "body": r.body,
                       "images": [f"/ai/forum/images/{i}" for i in (r.images or [])],
                       "author_id": r.author_id, "author_name": names.get(r.author_id, r.author_id),
                       "author_is_teacher": bool(r.author_is_teacher), "accepted": bool(r.accepted),
                       "hidden": bool(r.hidden), "like_count": int(r_likes.get(r.id, 0)), "liked": r.id in r_mine,
                       "created_at": _iso(r.created_at)} for r in replies]
    out["can_moderate"] = moderator
    return out


def reply(db: Session, user: Principal, thread_id, body: str, parent_id=None, images: list | None = None) -> dict:
    t = db.get(ForumThread, thread_id)
    if t is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bài đăng.")
    _require_member(user, t.class_id)
    moderator = _is_moderator(user, t.class_id)
    if t.locked and not moderator:
        raise AppError(409, "THREAD_LOCKED", "Bài này đã bị khóa, không thể trả lời thêm.")
    parent = None
    if parent_id:
        parent = db.get(ForumReply, parent_id)
        if parent is None or parent.thread_id != t.id:
            raise AppError(400, "INVALID_PARENT", "Bình luận được trả lời không thuộc bài này.")
        if parent.parent_id:  # chỉ lồng 1 tầng: trả lời một câu trả lời con thì gắn vào bình luận gốc
            parent = db.get(ForumReply, parent.parent_id)
    r = ForumReply(thread_id=t.id, author_id=user.user_id, author_is_teacher=moderator,
                   parent_id=parent.id if parent else None,
                   body=_text(body, "Nội dung trả lời", MAX_BODY),
                   images=_check_images(db, user, t.class_id, images) or None)
    db.add(r)
    db.flush()
    name = _names(db, {user.user_id}).get(user.user_id, user.user_id)
    notified = {t.author_id}
    _notify(db, t.author_id, "reply", user, t.class_id, t.id, f"{name} đã trả lời bài “{t.title}”")
    if parent is not None and parent.author_id not in notified:
        _notify(db, parent.author_id, "reply", user, t.class_id, t.id, f"{name} đã trả lời bình luận của bạn trong “{t.title}”")
        notified.add(parent.author_id)
    _notify_mentions(db, user, t.class_id, t.id, r.body, t.title, notified)
    db.commit()
    return {"reply_id": str(r.id), "thread_id": str(t.id), "parent_id": str(r.parent_id) if r.parent_id else None}


def toggle_like(db: Session, user: Principal, target_type: str, target_id) -> dict:
    if target_type not in ("thread", "reply"):
        raise AppError(400, "INVALID_TARGET", "target_type phải là thread hoặc reply.")
    if target_type == "thread":
        t = db.get(ForumThread, target_id)
    else:
        r = db.get(ForumReply, target_id)
        t = db.get(ForumThread, r.thread_id) if r else None
    if t is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy nội dung.")
    _require_member(user, t.class_id)
    if t.hidden and not _is_moderator(user, t.class_id):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy nội dung.")
    row = db.query(ForumReaction).filter(ForumReaction.user_id == user.user_id, ForumReaction.target_type == target_type,
                                         ForumReaction.target_id == target_id).first()
    if row is None:
        db.add(ForumReaction(user_id=user.user_id, target_type=target_type, target_id=target_id))
        liked = True
    else:
        db.delete(row)
        liked = False
    db.commit()
    count = db.query(func.count(ForumReaction.id)).filter(ForumReaction.target_type == target_type,
                                                          ForumReaction.target_id == target_id).scalar() or 0
    return {"liked": liked, "like_count": int(count)}


def moderate(db: Session, user: Principal, thread_id, pinned: bool | None, locked: bool | None,
             hidden: bool | None = None) -> dict:
    t = db.get(ForumThread, thread_id)
    if t is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bài đăng.")
    if not _is_moderator(user, t.class_id):
        raise AppError(403, "FORBIDDEN", "Chỉ giáo viên của lớp mới ghim hoặc khóa bài.")
    if pinned is not None:
        t.pinned = pinned
    if locked is not None:
        t.locked = locked
    if hidden is not None:
        t.hidden = hidden
    db.commit()
    return {"thread_id": str(t.id), "pinned": bool(t.pinned), "locked": bool(t.locked), "hidden": bool(t.hidden)}


def set_reply_hidden(db: Session, user: Principal, reply_id, hidden: bool) -> dict:
    r = db.get(ForumReply, reply_id)
    if r is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy câu trả lời.")
    t = db.get(ForumThread, r.thread_id)
    if not _is_moderator(user, t.class_id):
        raise AppError(403, "FORBIDDEN", "Chỉ giáo viên của lớp mới ẩn nội dung.")
    r.hidden = hidden
    db.commit()
    return {"reply_id": str(r.id), "hidden": bool(r.hidden)}


# ---------------------------------------------------------------- báo cáo nội dung

def _same_target(thread_id, reply_id):
    cond = ForumReport.reply_id == reply_id if reply_id else ForumReport.reply_id.is_(None)
    return (ForumReport.thread_id == thread_id), cond


def report(db: Session, user: Principal, thread_id, reply_id, reason: str) -> dict:
    t = db.get(ForumThread, thread_id) if thread_id else None
    r = db.get(ForumReply, reply_id) if reply_id else None
    if r is not None:
        t = db.get(ForumThread, r.thread_id)
    if t is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy nội dung cần báo cáo.")
    _require_member(user, t.class_id)
    author = r.author_id if r is not None else t.author_id
    if author == user.user_id:
        raise AppError(400, "OWN_CONTENT", "Không thể báo cáo nội dung của chính bạn.")
    by_thread, by_reply = _same_target(t.id, r.id if r is not None else None)
    dup = db.query(ForumReport.id).filter(ForumReport.reporter_id == user.user_id, ForumReport.status == "open",
                                          by_thread, by_reply).first()
    if dup:
        return {"report_id": str(dup[0]), "duplicate": True}
    rp = ForumReport(class_id=t.class_id, thread_id=t.id, reply_id=r.id if r is not None else None,
                     reporter_id=user.user_id, reason=_text(reason, "Lý do", 500))
    db.add(rp)
    db.commit()
    return {"report_id": str(rp.id), "duplicate": False}


def list_reports(db: Session, user: Principal, class_id: str, status: str = "open") -> list[dict]:
    class_id = clean_id(class_id) or ""
    if not _is_moderator(user, class_id):
        raise AppError(403, "FORBIDDEN", "Chỉ giáo viên của lớp mới xem báo cáo.")
    rows = (db.query(ForumReport).filter(ForumReport.class_id == class_id, ForumReport.status == status)
            .order_by(ForumReport.created_at.desc()).limit(200).all())
    out = []
    for rp in rows:
        t = db.get(ForumThread, rp.thread_id)
        r = db.get(ForumReply, rp.reply_id) if rp.reply_id else None
        target = r if r is not None else t
        out.append({"report_id": str(rp.id), "thread_id": str(rp.thread_id),
                    "reply_id": str(rp.reply_id) if rp.reply_id else None,
                    "thread_title": t.title if t else "", "kind": "reply" if r is not None else "thread",
                    "excerpt": (target.body if target else "")[:300],
                    "author_id": target.author_id if target else None,
                    "hidden": bool(target.hidden) if target else False, "reason": rp.reason,
                    "reporter_id": rp.reporter_id, "status": rp.status, "created_at": _iso(rp.created_at)})
    names = _names(db, {o["author_id"] for o in out if o["author_id"]} | {o["reporter_id"] for o in out})
    for o in out:
        o["author_name"] = names.get(o["author_id"], o["author_id"])
        o["reporter_name"] = names.get(o["reporter_id"], o["reporter_id"])
    return out


def resolve_report(db: Session, user: Principal, report_id, action: str) -> dict:
    """action = hide (ẩn nội dung bị báo cáo) | dismiss (bỏ qua, nội dung giữ nguyên)."""
    rp = db.get(ForumReport, report_id)
    if rp is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy báo cáo.")
    if not _is_moderator(user, rp.class_id):
        raise AppError(403, "FORBIDDEN", "Chỉ giáo viên của lớp mới xử lý báo cáo.")
    if action not in ("hide", "dismiss"):
        raise AppError(400, "INVALID_ACTION", "action phải là hide hoặc dismiss.")
    if action == "hide":
        target = db.get(ForumReply, rp.reply_id) if rp.reply_id else db.get(ForumThread, rp.thread_id)
        if target is not None:
            target.hidden = True
    # các báo cáo khác cùng nội dung cũng được đóng
    by_thread, by_reply = _same_target(rp.thread_id, rp.reply_id)
    same = db.query(ForumReport).filter(ForumReport.status == "open", by_thread, by_reply).all()
    for x in same:
        x.status = "hidden" if action == "hide" else "dismissed"
        x.handled_by, x.handled_at = user.user_id, utcnow()
    db.commit()
    return {"report_id": str(rp.id), "status": rp.status, "closed": len(same)}


def accept_reply(db: Session, user: Principal, reply_id) -> dict:
    r = db.get(ForumReply, reply_id)
    if r is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy câu trả lời.")
    t = db.get(ForumThread, r.thread_id)
    if not (_is_moderator(user, t.class_id) or user.user_id == t.author_id):
        raise AppError(403, "FORBIDDEN", "Chỉ người đăng bài hoặc giáo viên mới đánh dấu câu trả lời đúng.")
    db.query(ForumReply).filter(ForumReply.thread_id == t.id).update({"accepted": False})
    r.accepted = True
    db.commit()
    return {"reply_id": str(r.id), "accepted": True}


def delete(db: Session, user: Principal, kind: str, obj_id) -> dict:
    if kind == "thread":
        obj = db.get(ForumThread, obj_id)
        if obj is None:
            raise AppError(404, "NOT_FOUND", "Không tìm thấy nội dung.")
        class_id, author = obj.class_id, obj.author_id
        reply_ids = [r for (r,) in db.query(ForumReply.id).filter(ForumReply.thread_id == obj.id).all()]
        targets = [("thread", [obj.id]), ("reply", reply_ids)]
    else:
        obj = db.get(ForumReply, obj_id)
        if obj is None:
            raise AppError(404, "NOT_FOUND", "Không tìm thấy nội dung.")
        class_id, author = db.get(ForumThread, obj.thread_id).class_id, obj.author_id
        children = [r for (r,) in db.query(ForumReply.id).filter(ForumReply.parent_id == obj.id).all()]
        targets = [("reply", [obj.id] + children)]
    if not (user.user_id == author or _is_moderator(user, class_id)):
        raise AppError(403, "FORBIDDEN", "Chỉ người viết hoặc giáo viên của lớp mới xóa được.")
    for ttype, ids in targets:  # dọn lượt thích của nội dung bị xóa
        if ids:
            db.query(ForumReaction).filter(ForumReaction.target_type == ttype, ForumReaction.target_id.in_(ids)) \
                .delete(synchronize_session=False)
    if kind == "reply":  # bình luận con của bình luận bị xóa cũng bị xóa
        db.query(ForumReply).filter(ForumReply.parent_id == obj.id).delete(synchronize_session=False)
    db.delete(obj)
    db.commit()
    return {"deleted": True}


def ai_draft(db: Session, user: Principal, thread_id) -> dict:
    """Soạn bản nháp trả lời từ học liệu của lớp/bài. Không tự đăng: giáo viên sửa rồi tự đăng."""
    t = db.get(ForumThread, thread_id)
    if t is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bài đăng.")
    if not _is_moderator(user, t.class_id):
        raise AppError(403, "FORBIDDEN", "Chỉ giáo viên của lớp mới dùng AI soạn nháp.")
    question = redact_pii(f"{t.title}\n{t.body}")
    scope = RetrievalScope(allowed_class_ids=None, class_id=t.class_id, lesson_id=t.lesson_code)
    chunks = retrieve(db, question, scope, top_k=5)
    if not chunks:
        return {"draft": None, "refused": True,
                "message": "Học liệu của bài chưa có nội dung liên quan. Hãy tự trả lời hoặc bổ sung tài liệu."}
    context, sources = build_context(chunks)
    res = llm.complete_text("forum_draft", TUTOR_ANSWER,
                            f"{wrap_documents(context)}\n\nCâu hỏi của học sinh: {question}", max_tokens=800,
                            chunk_ids=[s["chunk_id"] for s in sources if s.get("chunk_id")], user_id=user.user_id)
    return {"draft": res.text.strip(), "refused": "chưa tìm thấy thông tin" in res.text.lower(), "sources": sources}


# ---------------------------------------------------------------- ảnh đính kèm

IMAGE_EXTS = ("png", "jpg", "jpeg", "webp", "gif")
IMAGE_MAX_MB = 5


def upload_image(db: Session, user: Principal, class_id: str, file) -> dict:
    from app.services.storage import safe_extension, save_upload
    class_id = clean_id(class_id) or ""
    _require_member(user, class_id)
    ext = safe_extension(file.filename, IMAGE_EXTS)
    key, _, size = save_upload(file, "forum", ext, IMAGE_MAX_MB)
    mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
    img = ForumImage(class_id=class_id, uploader_id=user.user_id, file_key=key, mime=mime, size_bytes=str(size))
    db.add(img)
    db.commit()
    return {"image_id": str(img.id), "url": f"/ai/forum/images/{img.id}"}


def get_image(db: Session, user: Principal, image_id) -> ForumImage:
    img = db.get(ForumImage, image_id)
    if img is None or not _is_member(user, img.class_id):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy ảnh.")
    return img
