"""Học tập: cây khóa học + trạng thái mở khóa, tiến độ từng mục, XP / chuỗi ngày / bảng xếp hạng, bài kiểm tra cuối bài."""
import random
from datetime import datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.config import settings
from app.core.errors import AppError
from app.core.security import Principal
from app.core.utils import utcnow
from app.models.documents import AIDocument
from app.models.learning import (Chapter, Course, ItemProgress, Lesson, LessonItem, MediaVideo, UserProfile,
                                 XPEvent)
from app.models.transcript import VideoTranscript
from app.models.video_question import QuestionBankItem, VideoQuestion
from app.services import grading

ITEM_TYPES = ("video", "slide", "reading", "quiz")


def _tz() -> ZoneInfo:
    try:
        return ZoneInfo(settings.app_timezone)
    except Exception:
        return ZoneInfo("UTC")


# ----------------------------------------------------------------------------
# Hồ sơ & XP
# ----------------------------------------------------------------------------

def touch_profile(db: Session, user: Principal, display_name: str | None = None) -> UserProfile:
    p = db.get(UserProfile, user.user_id)
    if p is None:
        p = UserProfile(user_id=user.user_id, daily_goal_xp=settings.default_daily_goal_xp)
        db.add(p)
    if display_name or user.name:
        p.display_name = display_name or user.name
    p.role = user.role
    p.class_ids = user.class_ids
    p.last_seen_at = utcnow()
    db.commit()
    return p


def award_xp(db: Session, student_id: str, amount: int, reason: str, ref_id: str,
             class_id: str | None = None) -> int:
    """Cộng XP một lần cho mỗi (lý do, đối tượng). Trả về số XP thực cộng (0 nếu đã cộng trước đó)."""
    if amount <= 0:
        return 0
    stmt = pg_insert(XPEvent).values(student_id=student_id, amount=amount, reason=reason, ref_id=str(ref_id),
                                     class_id=class_id).on_conflict_do_nothing(constraint="ux_xp_once")
    res = db.execute(stmt)
    db.commit()
    return amount if res.rowcount else 0


def _local_day(dt: datetime):
    return dt.astimezone(_tz()).date()


def stats(db: Session, user: Principal) -> dict:
    tz = _tz()
    now_local = datetime.now(tz)
    today = now_local.date()
    total = db.query(func.coalesce(func.sum(XPEvent.amount), 0)).filter(XPEvent.student_id == user.user_id).scalar()
    since = (now_local - timedelta(days=400)).astimezone(ZoneInfo("UTC"))
    rows = db.query(XPEvent.created_at, XPEvent.amount).filter(XPEvent.student_id == user.user_id,
                                                               XPEvent.created_at >= since).all()
    per_day: dict = {}
    for created, amount in rows:
        d = _local_day(created)
        per_day[d] = per_day.get(d, 0) + amount
    streak = 0
    day = today if per_day.get(today) else today - timedelta(days=1)
    while per_day.get(day):
        streak += 1
        day -= timedelta(days=1)
    week_start = today - timedelta(days=today.weekday())
    profile = db.get(UserProfile, user.user_id)
    goal = profile.daily_goal_xp if profile else settings.default_daily_goal_xp
    return {
        "total_xp": int(total or 0),
        "today_xp": int(per_day.get(today, 0)),
        "week_xp": int(sum(v for d, v in per_day.items() if d >= week_start)),
        "daily_goal_xp": goal,
        "streak_days": streak,
        "studied_today": bool(per_day.get(today)),
        "last_7_days": [{"date": (today - timedelta(days=i)).isoformat(), "xp": int(per_day.get(today - timedelta(days=i), 0))}
                        for i in range(6, -1, -1)],
    }


def set_daily_goal(db: Session, user: Principal, goal: int) -> dict:
    if goal not in (10, 20, 30, 50, 100):
        raise AppError(400, "INVALID_GOAL", "Mục tiêu ngày phải là 10, 20, 30, 50 hoặc 100 XP.")
    p = touch_profile(db, user)
    p.daily_goal_xp = goal
    db.commit()
    return stats(db, user)


def leaderboard(db: Session, user: Principal, limit: int = 10) -> dict:
    tz = _tz()
    today = datetime.now(tz).date()
    week_start = datetime.combine(today - timedelta(days=today.weekday()), datetime.min.time(), tz)
    q = db.query(XPEvent.student_id, func.sum(XPEvent.amount).label("xp")).filter(XPEvent.created_at >= week_start)
    scope = "Toàn trường"
    if user.class_ids:
        q = q.filter(XPEvent.class_id.in_(user.class_ids))
        scope = "Lớp " + ", ".join(user.class_ids)
    rows = q.group_by(XPEvent.student_id).order_by(func.sum(XPEvent.amount).desc()).limit(limit).all()
    names = {p.user_id: p.display_name for p in db.query(UserProfile).filter(
        UserProfile.user_id.in_([r[0] for r in rows] or [""])).all()}
    return {"scope": scope, "week_start": week_start.date().isoformat(), "rows": [
        {"rank": i + 1, "user_id": sid, "name": names.get(sid) or sid, "xp": int(xp), "me": sid == user.user_id}
        for i, (sid, xp) in enumerate(rows)]}


# ----------------------------------------------------------------------------
# Khóa học
# ----------------------------------------------------------------------------

def visible_courses(db: Session, user: Principal) -> list[Course]:
    q = db.query(Course)
    if not user.is_admin:
        q = q.filter((Course.class_id.is_(None)) | (Course.class_id.in_(user.class_ids or [""])))
    return q.order_by(Course.created_at).all()


def get_course(db: Session, user: Principal, course_id) -> Course:
    c = db.get(Course, course_id)
    if not c or not user.can_access_class(c.class_id):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy khóa học.")
    return c


def get_lesson(db: Session, user: Principal, lesson_id) -> Lesson:
    lesson = db.get(Lesson, lesson_id)
    if not lesson or not user.can_access_class(lesson.chapter.course.class_id):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy bài học.")
    return lesson


def get_item(db: Session, user: Principal, item_id) -> LessonItem:
    item = db.get(LessonItem, item_id)
    if not item or not user.can_access_class(item.lesson.chapter.course.class_id):
        raise AppError(404, "NOT_FOUND", "Không tìm thấy mục học.")
    return item


def _progress_map(db: Session, user: Principal, item_ids: list) -> dict:
    if not item_ids:
        return {}
    rows = db.query(ItemProgress).filter(ItemProgress.student_id == user.user_id, ItemProgress.item_id.in_(item_ids)).all()
    return {r.item_id: r for r in rows}


def _item_meta_text(item: LessonItem) -> str:
    if item.type == "video":
        d = item.duration_seconds
        return "Video" + (f" · {int(d // 60):02d}:{int(d % 60):02d}" if d else "")
    if item.type == "slide":
        n = (item.meta or {}).get("pages")
        return "Slide" + (f" · {n} trang" if n else "")
    if item.type == "reading":
        words = len((item.content_md or "").split())
        return f"Bài đọc · {max(1, round(words / 200))} phút"
    m = item.meta or {}
    return f"Kiểm tra · {m.get('count', 5)} câu · cần {int(m.get('pass_ratio', 0.8) * 100)}%"


def item_summary(item: LessonItem, prog: ItemProgress | None, status: str) -> dict:
    return {"item_id": str(item.id), "lesson_id": str(item.lesson_id), "type": item.type, "title": item.title,
            "position": item.position, "meta_text": _item_meta_text(item), "status": status,
            "completed": bool(prog and prog.status == "completed"),
            "progress_position": prog.position if prog else None, "score": prog.score if prog else None}


def _status_map(db: Session, user: Principal, course: Course):
    """Trạng thái mỗi mục: done | current | open | locked. Học sinh học tuần tự; giáo viên mở hết."""
    items = [it for ch in course.chapters for ls in ch.lessons for it in ls.items]
    progress = _progress_map(db, user, [i.id for i in items])
    current_id = next((i.id for i in items if not (progress.get(i.id) and progress[i.id].status == "completed")), None)
    reached_current = False
    status_of = {}
    for it in items:
        done = bool(progress.get(it.id) and progress[it.id].status == "completed")
        if it.id == current_id:
            status_of[it.id] = "current"
            reached_current = True
        elif done:
            status_of[it.id] = "done"
        else:
            status_of[it.id] = "open" if (user.is_teacher or not reached_current) else "locked"
    return items, progress, status_of, current_id


def item_status(db: Session, user: Principal, item: LessonItem) -> str:
    return _status_map(db, user, item.lesson.chapter.course)[2][item.id]


def ensure_unlocked(db: Session, user: Principal, item: LessonItem) -> str:
    st = item_status(db, user, item)
    if st == "locked":
        raise AppError(403, "ITEM_LOCKED", "Mục này chưa mở khóa. Hãy hoàn thành các mục phía trước.")
    return st


def course_tree(db: Session, user: Principal, course: Course) -> dict:
    items, progress, status_of, current_id = _status_map(db, user, course)
    done_count = sum(1 for s in status_of.values() if s == "done")
    return {
        "course_id": str(course.id), "code": course.code, "title": course.title, "description": course.description,
        "class_id": course.class_id, "items_total": len(items), "items_done": done_count,
        "current_item_id": str(current_id) if current_id else None,
        "chapters": [{
            "chapter_id": str(ch.id), "title": ch.title, "position": ch.position,
            "lessons": [{
                "lesson_id": str(ls.id), "code": ls.code, "title": ls.title, "position": ls.position,
                "items_total": len(ls.items),
                "items_done": sum(1 for it in ls.items if status_of[it.id] == "done"),
                "items": [item_summary(it, progress.get(it.id), status_of[it.id]) for it in ls.items],
            } for ls in ch.lessons],
        } for ch in course.chapters],
    }


def lesson_view(db: Session, user: Principal, lesson: Lesson) -> dict:
    course = lesson.chapter.course
    tree = course_tree(db, user, course)
    lesson_node = next(ls for ch in tree["chapters"] for ls in ch["lessons"] if ls["lesson_id"] == str(lesson.id))
    return {"lesson_id": str(lesson.id), "code": lesson.code, "title": lesson.title, "description": lesson.description,
            "chapter_title": lesson.chapter.title, "course_id": str(course.id), "course_title": course.title,
            "items": lesson_node["items"], "items_total": lesson_node["items_total"],
            "items_done": lesson_node["items_done"]}


def item_detail(db: Session, user: Principal, item: LessonItem) -> dict:
    prog = db.query(ItemProgress).filter(ItemProgress.student_id == user.user_id, ItemProgress.item_id == item.id).first()
    out = item_summary(item, prog, ensure_unlocked(db, user, item))
    out["lesson_code"] = item.lesson.code
    out["course_class_id"] = item.lesson.chapter.course.class_id
    if item.type == "video":
        media = db.get(MediaVideo, item.video_id) if item.video_id else None
        tr = (db.query(VideoTranscript).filter(VideoTranscript.video_id == item.video_id,
                                               VideoTranscript.is_active.is_not(False)).first() if item.video_id else None)
        nq = db.query(func.count(VideoQuestion.id)).filter(VideoQuestion.video_id == item.video_id,
                                                           VideoQuestion.status == "approved",
                                                           VideoQuestion.origin != "agent").scalar()
        out["video"] = {"video_id": item.video_id, "has_file": bool(media and (media.file_path or media.source_url)),
                        "source_url": media.source_url if media else None,
                        "stream_path": f"/ai/media/videos/{item.video_id}/file" if media and media.file_path else None,
                        "duration_seconds": (media.duration_seconds if media else None) or item.duration_seconds,
                        "has_transcript": tr is not None, "question_count": int(nq or 0)}
    elif item.type == "slide":
        doc = db.get(AIDocument, item.document_id) if item.document_id else None
        out["slide"] = {"document_id": str(doc.id) if doc else None, "source_type": doc.source_type if doc else None,
                        "title": doc.title if doc else None, "status": doc.status if doc else None,
                        "file_path": f"/ai/documents/{doc.id}/file" if doc and doc.file_path else None,
                        "notes": (item.meta or {}).get("notes"), "pages": (item.meta or {}).get("pages")}
    elif item.type == "reading":
        out["reading"] = {"content_md": item.content_md or "", "document_id": str(item.document_id) if item.document_id else None}
    else:
        m = item.meta or {}
        out["quiz"] = {"count": m.get("count", 5), "pass_ratio": m.get("pass_ratio", 0.8),
                       "available": _quiz_pool_size(db, item)}
    return out


def _class_for_xp(user: Principal, item: LessonItem | None = None) -> str | None:
    if item is not None and item.lesson.chapter.course.class_id:
        return item.lesson.chapter.course.class_id
    return user.class_ids[0] if user.class_ids else None


def _get_progress(db: Session, user: Principal, item: LessonItem) -> ItemProgress:
    p = db.query(ItemProgress).filter(ItemProgress.student_id == user.user_id, ItemProgress.item_id == item.id).first()
    if p is None:
        p = ItemProgress(student_id=user.user_id, item_id=item.id, status="in_progress")
        db.add(p)
        db.flush()
    return p


def save_position(db: Session, user: Principal, item: LessonItem, position: float) -> dict:
    p = _get_progress(db, user, item)
    p.position = position
    db.commit()
    return {"item_id": str(item.id), "position": position}


def complete_item(db: Session, user: Principal, item: LessonItem) -> dict:
    if item.type == "quiz":
        raise AppError(400, "QUIZ_COMPLETION", "Bài kiểm tra hoàn thành khi đạt điểm yêu cầu.")
    ensure_unlocked(db, user, item)
    p = _get_progress(db, user, item)
    first = p.status != "completed"
    p.status, p.completed_at = "completed", p.completed_at or utcnow()
    db.commit()
    xp = award_xp(db, user.user_id, settings.xp_item_complete, "item_complete", str(item.id), _class_for_xp(user, item)) if first else 0
    return {"item_id": str(item.id), "completed": True, "xp_awarded": xp}


def locate(db: Session, user: Principal, lesson: Lesson | None, video_id: str | None = None,
           document_id=None) -> dict | None:
    q = db.query(LessonItem)
    if video_id:
        q = q.filter(LessonItem.video_id == video_id)
    elif document_id:
        q = q.filter(LessonItem.document_id == document_id)
    else:
        return None
    items = q.all()
    if lesson is not None:
        items.sort(key=lambda i: 0 if i.lesson_id == lesson.id else 1)
    for it in items:
        if user.can_access_class(it.lesson.chapter.course.class_id):
            return {"lesson_id": str(it.lesson_id), "item_id": str(it.id), "type": it.type}
    return None


# ----------------------------------------------------------------------------
# Kiểm tra cuối bài (lấy từ ngân hàng câu hỏi đã duyệt của bài)
# ----------------------------------------------------------------------------

def _quiz_pool(db: Session, item: LessonItem) -> list[QuestionBankItem]:
    return (db.query(QuestionBankItem).filter(QuestionBankItem.lesson_id == item.lesson.code,
                                              QuestionBankItem.status == "approved")
            .order_by(QuestionBankItem.created_at).all())


def _quiz_pool_size(db: Session, item: LessonItem) -> int:
    return db.query(func.count(QuestionBankItem.id)).filter(QuestionBankItem.lesson_id == item.lesson.code,
                                                            QuestionBankItem.status == "approved").scalar() or 0


def start_quiz(db: Session, user: Principal, item: LessonItem) -> dict:
    if item.type != "quiz":
        raise AppError(400, "NOT_QUIZ", "Mục này không phải bài kiểm tra.")
    ensure_unlocked(db, user, item)
    pool = _quiz_pool(db, item)
    if not pool:
        raise AppError(409, "QUIZ_EMPTY", "Giáo viên chưa duyệt câu hỏi nào cho bài này.")
    count = int((item.meta or {}).get("count", 5))
    rnd = random.Random(f"{user.user_id}:{item.id}:{utcnow().date()}")
    chosen = rnd.sample(pool, min(count, len(pool)))
    p = _get_progress(db, user, item)
    p.meta = {"question_ids": [str(q.id) for q in chosen], "answers": {}}
    db.commit()
    return {"item_id": str(item.id), "pass_ratio": (item.meta or {}).get("pass_ratio", 0.8),
            "questions": [{"question_id": str(q.id), "type": q.payload.get("type"), "question": q.payload.get("question"),
                           "options": q.payload.get("options"), "difficulty": q.payload.get("difficulty")} for q in chosen]}


def answer_quiz(db: Session, user: Principal, item: LessonItem, question_id: str, selected_index: int | None,
                answer: str | None) -> dict:
    p = _get_progress(db, user, item)
    meta = dict(p.meta or {})
    if question_id not in (meta.get("question_ids") or []):
        raise AppError(409, "QUIZ_NOT_STARTED", "Câu hỏi không thuộc lượt làm bài hiện tại. Hãy bắt đầu lại.")
    bank = db.get(QuestionBankItem, question_id)
    pl = bank.payload or {}
    q = SimpleNamespace(type=pl.get("type"), options=pl.get("options"), correct_index=pl.get("correct_index"),
                        answer=pl.get("correct_answer"), explanation=pl.get("explanation"), question=pl.get("question"))
    result = grading.grade(q, answer, selected_index, user_id=user.user_id)
    answers = dict(meta.get("answers") or {})
    if question_id not in answers:  # chỉ tính lần trả lời đầu tiên
        answers[question_id] = bool(result["is_correct"])
    meta["answers"] = answers
    p.meta = meta
    db.commit()
    xp = 0
    if result["is_correct"]:
        xp = award_xp(db, user.user_id, settings.xp_quiz_question, "quiz_question", f"{item.id}:{question_id}",
                      _class_for_xp(user, item))
    return {"question_id": question_id, "is_correct": result["is_correct"], "verdict": result["verdict"],
            "correct_answer": grading.correct_answer_text(q), "correct_index": q.correct_index,
            "explanation": q.explanation, "feedback": result["feedback"], "xp_awarded": xp}


def finish_quiz(db: Session, user: Principal, item: LessonItem) -> dict:
    p = _get_progress(db, user, item)
    meta = p.meta or {}
    qids = meta.get("question_ids") or []
    answers = meta.get("answers") or {}
    if not qids:
        raise AppError(409, "QUIZ_NOT_STARTED", "Chưa bắt đầu bài kiểm tra.")
    correct = sum(1 for q in qids if answers.get(q))
    ratio = correct / len(qids)
    pass_ratio = float((item.meta or {}).get("pass_ratio", 0.8))
    passed = ratio >= pass_ratio
    p.score = max(p.score or 0, ratio)
    xp = 0
    if passed:
        first = p.status != "completed"
        p.status, p.completed_at = "completed", p.completed_at or utcnow()
        db.commit()
        if first:
            xp = award_xp(db, user.user_id, settings.xp_quiz_pass, "quiz_pass", str(item.id), _class_for_xp(user, item))
    else:
        db.commit()
    return {"item_id": str(item.id), "correct": correct, "total": len(qids), "score": round(ratio, 4),
            "pass_ratio": pass_ratio, "passed": passed, "xp_awarded": xp}
