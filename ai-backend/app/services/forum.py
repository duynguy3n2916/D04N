"""Diễn đàn lớp: bài đăng, trả lời, giáo viên ghim / khóa / đánh dấu câu đúng; AI chỉ soạn bản nháp để giáo viên duyệt."""
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.prompts import TUTOR_ANSWER, wrap_documents
from app.core.security import Principal
from app.core.utils import clean_id, redact_pii
from app.models.accounts import User
from app.core.utils import utcnow
from app.models.learning import ForumReply, ForumReport, ForumThread, Lesson
from app.services import llm
from app.services.retrieval import RetrievalScope, build_context, retrieve

MAX_TITLE = 200
MAX_BODY = 5000


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


def _thread_dict(t: ForumThread, names: dict[str, str], replies: int = 0, has_answer: bool = False) -> dict:
    return {"thread_id": str(t.id), "class_id": t.class_id, "lesson_code": t.lesson_code, "title": t.title,
            "body": t.body, "author_id": t.author_id, "author_name": names.get(t.author_id, t.author_id),
            "pinned": bool(t.pinned), "locked": bool(t.locked), "hidden": bool(t.hidden),
            "reply_count": replies, "has_answer": has_answer,
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "updated_at": t.updated_at.isoformat() if t.updated_at else None}


def list_threads(db: Session, user: Principal, class_id: str, lesson_code: str | None = None) -> list[dict]:
    class_id = clean_id(class_id) or ""
    _require_member(user, class_id)
    q = db.query(ForumThread).filter(ForumThread.class_id == class_id)
    if not _is_moderator(user, class_id):
        q = q.filter(ForumThread.hidden.isnot(True))
    if lesson_code:
        q = q.filter(ForumThread.lesson_code == lesson_code)
    threads = q.order_by(ForumThread.pinned.desc(), ForumThread.created_at.desc()).limit(200).all()
    if not threads:
        return []
    ids = [t.id for t in threads]
    counts = dict(db.query(ForumReply.thread_id, func.count(ForumReply.id))
                  .filter(ForumReply.thread_id.in_(ids), ForumReply.hidden.isnot(True))
                  .group_by(ForumReply.thread_id).all())
    accepted = {r for (r,) in db.query(ForumReply.thread_id).filter(ForumReply.thread_id.in_(ids),
                                                                  ForumReply.accepted.is_(True)).all()}
    names = _names(db, {t.author_id for t in threads})
    return [_thread_dict(t, names, int(counts.get(t.id, 0)), t.id in accepted) for t in threads]


def create_thread(db: Session, user: Principal, class_id: str, title: str, body: str, lesson_code: str | None) -> dict:
    class_id = clean_id(class_id) or ""
    _require_member(user, class_id)
    lesson_code = clean_id(lesson_code)
    if lesson_code and not db.query(Lesson.id).filter(Lesson.code == lesson_code).first():
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bài học.")
    t = ForumThread(class_id=class_id, lesson_code=lesson_code, author_id=user.user_id,
                    title=_text(title, "Tiêu đề", MAX_TITLE), body=_text(body, "Nội dung", MAX_BODY))
    db.add(t)
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
    out = _thread_dict(t, names, len(replies), any(r.accepted for r in replies))
    out["replies"] = [{"reply_id": str(r.id), "body": r.body, "author_id": r.author_id,
                       "author_name": names.get(r.author_id, r.author_id), "author_is_teacher": bool(r.author_is_teacher),
                       "accepted": bool(r.accepted), "hidden": bool(r.hidden),
                       "created_at": r.created_at.isoformat() if r.created_at else None}
                      for r in replies]
    out["can_moderate"] = moderator
    return out


def reply(db: Session, user: Principal, thread_id, body: str) -> dict:
    t = db.get(ForumThread, thread_id)
    if t is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bài đăng.")
    _require_member(user, t.class_id)
    moderator = _is_moderator(user, t.class_id)
    if t.locked and not moderator:
        raise AppError(409, "THREAD_LOCKED", "Bài này đã bị khóa, không thể trả lời thêm.")
    r = ForumReply(thread_id=t.id, author_id=user.user_id, author_is_teacher=moderator,
                   body=_text(body, "Nội dung trả lời", MAX_BODY))
    db.add(r)
    db.commit()
    return {"reply_id": str(r.id), "thread_id": str(t.id)}


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
                    "reporter_id": rp.reporter_id, "status": rp.status,
                    "created_at": rp.created_at.isoformat() if rp.created_at else None})
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
    else:
        obj = db.get(ForumReply, obj_id)
        if obj is None:
            raise AppError(404, "NOT_FOUND", "Không tìm thấy nội dung.")
        class_id, author = db.get(ForumThread, obj.thread_id).class_id, obj.author_id
    if not (user.user_id == author or _is_moderator(user, class_id)):
        raise AppError(403, "FORBIDDEN", "Chỉ người viết hoặc giáo viên của lớp mới xóa được.")
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
