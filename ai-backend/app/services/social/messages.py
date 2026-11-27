"""Nhắn tin riêng giữa thành viên cùng lớp.

Quy tắc an toàn:
- Chỉ nhắn được với người cùng ít nhất một lớp, tài khoản còn hoạt động, không ai chặn ai.
- Người nhận có thể chặn và báo cáo tin nhắn. Giáo viên của lớp chỉ xem được đúng tin nhắn bị báo cáo
  (không đọc được cả hội thoại), có thể ẩn tin đó.
- Tin nhắn cũ bị xóa theo CHAT_RETENTION_DAYS (xem services/retention.py).
"""
from sqlalchemy import and_, func, or_
from sqlalchemy.dialects.postgresql import array
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import Principal
from app.core.utils import clean_id, utcnow
from app.models.accounts import ClassRoom, User
from app.models.social import DirectBlock, DirectConversation, DirectMessage, DirectRead, DirectReport

MAX_BODY = 2000

# đính kèm: loại -> (đuôi file cho phép, dung lượng tối đa MB)
ATTACH_RULES = {
    "image": (("png", "jpg", "jpeg", "webp", "gif"), 10),
    "video": (("mp4", "webm", "mov", "m4v"), 50),
    "audio": (("webm", "ogg", "m4a", "mp4", "mp3", "wav", "aac", "caf"), 10),
}
_MIME = {
    "image": {"jpg": "image/jpeg", "jpeg": "image/jpeg"},
    "video": {"mov": "video/quicktime", "m4v": "video/mp4"},
    "audio": {"m4a": "audio/mp4", "mp4": "audio/mp4", "mp3": "audio/mpeg", "aac": "audio/aac", "caf": "audio/x-caf"},
}
PREVIEW = {"image": "📷 Ảnh", "video": "🎬 Video", "audio": "🎤 Tin nhắn thoại"}


def _iso(dt) -> str | None:
    return dt.isoformat() if dt else None


def _shared_class(me: Principal, other: User) -> str | None:
    shared = [c for c in (me.class_ids or []) if c in (other.class_ids or [])]
    return shared[0] if shared else None


def _blocked(db: Session, a: str, b: str) -> bool:
    return db.query(DirectBlock.id).filter(or_(and_(DirectBlock.blocker_id == a, DirectBlock.blocked_id == b),
                                               and_(DirectBlock.blocker_id == b, DirectBlock.blocked_id == a))).first() is not None


def _conv_for(db: Session, user: Principal, conversation_id) -> DirectConversation:
    c = db.get(DirectConversation, conversation_id)
    if c is None or user.user_id not in (c.user_a, c.user_b):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy hội thoại.")
    return c


def _other(c: DirectConversation, me: str) -> str:
    return c.user_b if c.user_a == me else c.user_a


def _kind(m: DirectMessage) -> str:
    return m.kind or "text"


def _preview(m: DirectMessage, me: str) -> str:
    """Dòng xem trước ở danh sách hội thoại, kiểu "Bạn: 📷 Ảnh"."""
    k = _kind(m)
    text = m.body if k == "text" else (PREVIEW.get(k, "Tệp") + (f" {m.body}" if m.body else ""))
    return ("Bạn: " if m.sender_id == me else "") + (text or "")[:120]


def _message_out(m: DirectMessage, me: str) -> dict:
    k = _kind(m)
    out = {"message_id": str(m.id), "sender_id": m.sender_id, "mine": m.sender_id == me,
           "body": "(Tin nhắn đã bị ẩn)" if m.hidden else m.body, "hidden": bool(m.hidden),
           "kind": "text" if m.hidden else k, "created_at": _iso(m.created_at)}
    if k != "text" and not m.hidden:
        out.update(url=f"/ai/messages/files/{m.id}", mime=m.mime, duration=m.duration, size_bytes=m.size_bytes)
    return out


def start(db: Session, user: Principal, other_id: str) -> dict:
    other_id = (clean_id(other_id) or "").lower()
    if other_id == user.user_id:
        raise AppError(400, "SELF", "Không thể nhắn tin cho chính mình.")
    other = db.get(User, other_id)
    if other is None or not other.is_active:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy người dùng.")
    class_id = _shared_class(user, other)
    if class_id is None:
        raise AppError(403, "NOT_CLASSMATE", "Chỉ nhắn tin được với thành viên cùng lớp.")
    # người kia chặn mình thì không mở được; mình chặn người kia thì vẫn mở (để bấm "Bỏ chặn"), chỉ không gửi được tin
    if db.query(DirectBlock.id).filter(DirectBlock.blocker_id == other_id, DirectBlock.blocked_id == user.user_id).first():
        raise AppError(403, "BLOCKED", "Không thể nhắn tin với người này.")
    a, b = sorted([user.user_id, other_id])
    c = db.query(DirectConversation).filter(DirectConversation.user_a == a, DirectConversation.user_b == b).first()
    if c is None:
        c = DirectConversation(class_id=class_id, user_a=a, user_b=b)
        db.add(c)
        db.commit()
        db.refresh(c)
    return {"conversation_id": str(c.id), "other_id": other_id, "other_name": other.display_name or other_id}


def contacts(db: Session, user: Principal) -> dict:
    """Danh bạ để chọn người nhắn tin: các lớp của tôi (làm thẻ lọc) và mọi thành viên cùng lớp, kèm lớp chung."""
    my_classes = [c for c in (user.class_ids or []) if c]
    if not my_classes:
        return {"classes": [], "people": []}
    names = {c.class_id: c.name for c in db.query(ClassRoom).filter(ClassRoom.class_id.in_(my_classes)).all()}
    rows = (db.query(User).filter(User.class_ids.has_any(array(my_classes)), User.is_active.is_(True), User.user_id != user.user_id)
            .order_by(User.display_name, User.user_id).limit(1000).all())
    blocked = {b for (b,) in db.query(DirectBlock.blocked_id).filter(DirectBlock.blocker_id == user.user_id).all()}
    convs = {_other(c, user.user_id): str(c.id) for c in db.query(DirectConversation).filter(
        or_(DirectConversation.user_a == user.user_id, DirectConversation.user_b == user.user_id)).all()}
    people = [{"user_id": u.user_id, "name": u.display_name or u.user_id, "role": u.role,
               "class_ids": [c for c in (u.class_ids or []) if c in my_classes],
               "conversation_id": convs.get(u.user_id), "blocked": u.user_id in blocked} for u in rows]
    counts = {c: sum(1 for p in people if c in p["class_ids"]) for c in my_classes}
    return {"classes": [{"class_id": c, "name": names.get(c) or c, "count": counts[c]} for c in my_classes],
            "people": people}


def _unread(db: Session, c: DirectConversation, me: str) -> int:
    read = db.query(DirectRead.read_at).filter(DirectRead.conversation_id == c.id, DirectRead.user_id == me).scalar()
    q = db.query(func.count(DirectMessage.id)).filter(DirectMessage.conversation_id == c.id,
                                                      DirectMessage.sender_id != me, DirectMessage.hidden.is_(False))
    if read is not None:
        q = q.filter(DirectMessage.created_at > read)
    return int(q.scalar() or 0)


def list_conversations(db: Session, user: Principal) -> list[dict]:
    convs = (db.query(DirectConversation).filter(or_(DirectConversation.user_a == user.user_id,
                                                     DirectConversation.user_b == user.user_id))
             .order_by(DirectConversation.last_message_at.desc()).limit(100).all())
    others = {_other(c, user.user_id) for c in convs}
    users = {u.user_id: u for u in db.query(User).filter(User.user_id.in_(list(others))).all()} if others else {}
    out = []
    for c in convs:
        last = (db.query(DirectMessage).filter(DirectMessage.conversation_id == c.id, DirectMessage.hidden.is_(False))
                .order_by(DirectMessage.created_at.desc()).first())
        oid = _other(c, user.user_id)
        u = users.get(oid)
        out.append({"conversation_id": str(c.id), "other_id": oid, "other_name": (u.display_name if u else None) or oid,
                    "last_message": (_preview(last, user.user_id) if last else ""), "last_at": _iso(last.created_at if last else c.created_at),
                    "unread": _unread(db, c, user.user_id), "blocked": _blocked(db, user.user_id, oid)})
    return out


def _mark_read(db: Session, c: DirectConversation, me: str) -> None:
    row = db.query(DirectRead).filter(DirectRead.conversation_id == c.id, DirectRead.user_id == me).first()
    if row is None:
        db.add(DirectRead(conversation_id=c.id, user_id=me, read_at=func.now()))
    else:
        row.read_at = func.now()  # giờ của DB, cùng nguồn với created_at của tin nhắn
    db.commit()


def get_messages(db: Session, user: Principal, conversation_id, limit: int = 100) -> dict:
    c = _conv_for(db, user, conversation_id)
    rows = (db.query(DirectMessage).filter(DirectMessage.conversation_id == c.id)
            .order_by(DirectMessage.created_at.desc()).limit(min(limit, 300)).all())
    rows.reverse()
    _mark_read(db, c, user.user_id)
    oid = _other(c, user.user_id)
    other = db.get(User, oid)
    # người kia đọc tới đâu: để hiện "Đã xem" dưới tin cuối của mình như các app chat
    other_read = db.query(DirectRead.read_at).filter(DirectRead.conversation_id == c.id, DirectRead.user_id == oid).scalar()
    return {"conversation_id": str(c.id), "other_id": oid, "other_name": (other.display_name if other else None) or oid,
            "blocked": _blocked(db, user.user_id, oid),
            "blocked_by_me": db.query(DirectBlock.id).filter(DirectBlock.blocker_id == user.user_id,
                                                             DirectBlock.blocked_id == oid).first() is not None,
            "other_read_at": _iso(other_read),
            "messages": [_message_out(m, user.user_id) for m in rows]}


def _check_can_send(db: Session, user: Principal, c: DirectConversation) -> None:
    oid = _other(c, user.user_id)
    if _blocked(db, user.user_id, oid):
        raise AppError(403, "BLOCKED", "Không thể nhắn tin với người này.")
    other = db.get(User, oid)
    if other is None or not other.is_active or _shared_class(user, other) is None:
        raise AppError(403, "NOT_CLASSMATE", "Hai người không còn chung lớp nên không nhắn tin được.")


def send(db: Session, user: Principal, conversation_id, body: str) -> dict:
    c = _conv_for(db, user, conversation_id)
    _check_can_send(db, user, c)
    text = (body or "").strip()
    if not text:
        raise AppError(400, "EMPTY", "Tin nhắn không được để trống.")
    if len(text) > MAX_BODY:
        raise AppError(400, "TOO_LONG", f"Tin nhắn tối đa {MAX_BODY} ký tự.")
    m = DirectMessage(conversation_id=c.id, sender_id=user.user_id, body=text)
    db.add(m)
    c.last_message_at = func.now()
    db.commit()
    db.refresh(m)
    return {"message_id": str(m.id), "created_at": _iso(m.created_at)}


def send_file(db: Session, user: Principal, conversation_id, file, kind: str, body: str | None = None,
              duration: float | None = None) -> dict:
    """Gửi ảnh, video hoặc tin nhắn thoại (kèm chú thích tùy chọn). File lưu trong kho file, chỉ hai người xem được."""
    from app.services.media.storage import safe_extension, save_upload
    if kind not in ATTACH_RULES:
        raise AppError(400, "INVALID_KIND", "kind phải là image, video hoặc audio.")
    c = _conv_for(db, user, conversation_id)
    _check_can_send(db, user, c)
    text = (body or "").strip()
    if len(text) > MAX_BODY:
        raise AppError(400, "TOO_LONG", f"Tin nhắn tối đa {MAX_BODY} ký tự.")
    exts, max_mb = ATTACH_RULES[kind]
    ext = safe_extension(file.filename, exts)
    key, _, size = save_upload(file, "messages", ext, max_mb)
    mime = _MIME[kind].get(ext) or f"{kind}/{ext}"
    dur = float(duration) if duration is not None and 0 <= float(duration) < 24 * 3600 else None
    m = DirectMessage(conversation_id=c.id, sender_id=user.user_id, body=text, kind=kind, file_key=key, mime=mime,
                      size_bytes=size, duration=dur)
    db.add(m)
    c.last_message_at = func.now()
    db.commit()
    db.refresh(m)
    return _message_out(m, user.user_id)


def get_file(db: Session, user: Principal, message_id) -> DirectMessage:
    """Hai người trong hội thoại xem được file; giáo viên của lớp chỉ xem được file của tin đang bị báo cáo."""
    m = db.get(DirectMessage, message_id)
    if m is None or not m.file_key:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy tệp.")
    c = db.get(DirectConversation, m.conversation_id)
    if c is not None and user.user_id in (c.user_a, c.user_b):
        if m.hidden:
            raise AppError(404, "NOT_FOUND", "Không tìm thấy tệp.")
        return m
    if c is not None and _is_moderator(user, c.class_id) and db.query(DirectReport.id).filter(
            DirectReport.message_id == m.id).first() is not None:
        return m
    raise AppError(404, "NOT_FOUND", "Không tìm thấy tệp.")


def set_block(db: Session, user: Principal, other_id: str, blocked: bool) -> dict:
    other_id = (clean_id(other_id) or "").lower()
    if other_id == user.user_id:
        raise AppError(400, "SELF", "Không thể chặn chính mình.")
    row = db.query(DirectBlock).filter(DirectBlock.blocker_id == user.user_id, DirectBlock.blocked_id == other_id).first()
    if blocked and row is None:
        db.add(DirectBlock(blocker_id=user.user_id, blocked_id=other_id))
    elif not blocked and row is not None:
        db.delete(row)
    db.commit()
    return {"other_id": other_id, "blocked": blocked}


def report_message(db: Session, user: Principal, message_id, reason: str) -> dict:
    m = db.get(DirectMessage, message_id)
    if m is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy tin nhắn.")
    c = _conv_for(db, user, m.conversation_id)
    if m.sender_id == user.user_id:
        raise AppError(400, "OWN_CONTENT", "Không thể báo cáo tin nhắn của chính bạn.")
    reason = (reason or "").strip()
    if not reason:
        raise AppError(400, "EMPTY", "Cần nêu lý do báo cáo.")
    dup = db.query(DirectReport.id).filter(DirectReport.message_id == m.id, DirectReport.reporter_id == user.user_id,
                                           DirectReport.status == "open").first()
    if dup:
        return {"report_id": str(dup[0]), "duplicate": True}
    rp = DirectReport(class_id=c.class_id, message_id=m.id, reporter_id=user.user_id, reason=reason[:500])
    db.add(rp)
    db.commit()
    return {"report_id": str(rp.id), "duplicate": False}


def _is_moderator(user: Principal, class_id: str) -> bool:
    return user.is_admin or (user.is_teacher and class_id in (user.class_ids or []))


def list_reports(db: Session, user: Principal, class_id: str) -> list[dict]:
    """Giáo viên: chỉ thấy đúng các tin nhắn bị báo cáo trong lớp mình, không thấy phần còn lại của hội thoại."""
    class_id = clean_id(class_id) or ""
    if not _is_moderator(user, class_id):
        raise AppError(403, "FORBIDDEN", "Chỉ giáo viên của lớp mới xem báo cáo.")
    rows = (db.query(DirectReport, DirectMessage).join(DirectMessage, DirectReport.message_id == DirectMessage.id)
            .filter(DirectReport.class_id == class_id, DirectReport.status == "open")
            .order_by(DirectReport.created_at.desc()).limit(200).all())
    ids = {m.sender_id for _, m in rows} | {r.reporter_id for r, _ in rows}
    names = {u.user_id: u.display_name or u.user_id for u in db.query(User).filter(User.user_id.in_(list(ids))).all()} if ids else {}
    return [{"report_id": str(r.id), "message_id": str(m.id), "body": m.body, "kind": _kind(m),
             "url": f"/ai/messages/files/{m.id}" if m.file_key else None, "mime": m.mime, "sender_id": m.sender_id,
             "sender_name": names.get(m.sender_id, m.sender_id), "reporter_name": names.get(r.reporter_id, r.reporter_id),
             "reason": r.reason, "created_at": _iso(r.created_at)} for r, m in rows]


def resolve_report(db: Session, user: Principal, report_id, action: str) -> dict:
    r = db.get(DirectReport, report_id)
    if r is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy báo cáo.")
    if not _is_moderator(user, r.class_id):
        raise AppError(403, "FORBIDDEN", "Chỉ giáo viên của lớp mới xử lý báo cáo.")
    if action not in ("hide", "dismiss"):
        raise AppError(400, "INVALID_ACTION", "action phải là hide hoặc dismiss.")
    if action == "hide":
        m = db.get(DirectMessage, r.message_id)
        if m is not None:
            m.hidden = True
    for x in db.query(DirectReport).filter(DirectReport.message_id == r.message_id, DirectReport.status == "open").all():
        x.status = "hidden" if action == "hide" else "dismissed"
        x.handled_by, x.handled_at = user.user_id, utcnow()
    db.commit()
    return {"report_id": str(r.id), "status": r.status}


def unread_total(db: Session, user: Principal) -> int:
    convs = db.query(DirectConversation).filter(or_(DirectConversation.user_a == user.user_id,
                                                    DirectConversation.user_b == user.user_id)).all()
    return sum(_unread(db, c, user.user_id) for c in convs)
