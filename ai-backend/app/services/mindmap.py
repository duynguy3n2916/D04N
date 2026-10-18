"""Sơ đồ tư duy theo bài: AI tổng hợp học liệu thành cây kiến thức; mỗi nút gắn nguồn để nhảy về đúng đoạn bài giảng.

Giáo viên bấm tạo (không tự động, để kiểm soát chi phí), xem / sửa tên nút, rồi duyệt. Học sinh chỉ thấy bản đã duyệt.
"""
import uuid

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.llm_schemas import MindmapNode, MindmapOutput
from app.core.prompts import MINDMAP, wrap_documents
from app.core.security import Principal
from app.core.utils import utcnow
from app.models.learning import LessonMindmap
from app.services import llm
from app.services.lesson_ai import SOURCE_KEYS, lesson_by_code, lesson_context, resolve_sources

MAX_NODES = 120


def _node(n: MindmapNode, sources: list[dict]) -> dict:
    return {"id": uuid.uuid4().hex[:12], "title": n.title.strip(), "note": n.note.strip(),
            "sources": resolve_sources(n.sources, sources), "children": [_node(c, sources) for c in n.children]}


def _count(nodes: list[dict]) -> int:
    return sum(1 + _count(n.get("children") or []) for n in nodes)


def _dict(m: LessonMindmap) -> dict:
    return {"mindmap_id": str(m.id), "lesson_code": m.lesson_code, "version": m.version, "status": m.status,
            "tree": m.tree, "created_at": m.created_at.isoformat() if m.created_at else None,
            "approved_at": m.approved_at.isoformat() if m.approved_at else None}


def generate(db: Session, user: Principal, lesson_code: str) -> dict:
    lesson = lesson_by_code(db, user, lesson_code, teacher=True)
    context, sources = lesson_context(db, lesson)
    out, _ = llm.complete_json("lesson_mindmap", MINDMAP,
                               f"{wrap_documents(context)}\n\nBài học: {lesson.title}. Hãy lập sơ đồ tư duy cho bài này.",
                               MindmapOutput, max_tokens=3000, user_id=user.user_id,
                               chunk_ids=[s["chunk_id"] for s in sources if s.get("chunk_id")])
    tree = {"id": "root", "title": out.title.strip() or lesson.title, "note": "", "sources": [],
            "children": [_node(c, sources) for c in out.children]}
    if _count(tree["children"]) > MAX_NODES:
        raise AppError(502, "MINDMAP_TOO_LARGE", "Sơ đồ quá lớn, hãy thử tạo lại.")
    version = (db.query(func.max(LessonMindmap.version)).filter(LessonMindmap.lesson_code == lesson.code).scalar() or 0) + 1
    m = LessonMindmap(lesson_code=lesson.code, version=version, status="draft", tree=tree, created_by=user.user_id)
    db.add(m)
    db.commit()
    db.refresh(m)
    return _dict(m)


def get_for_lesson(db: Session, user: Principal, lesson_code: str) -> dict:
    """Học sinh: bản đã duyệt mới nhất. Giáo viên: thêm bản mới nhất (có thể là nháp) để xem trước và duyệt."""
    lesson = lesson_by_code(db, user, lesson_code)
    q = db.query(LessonMindmap).filter(LessonMindmap.lesson_code == lesson.code)
    approved = q.filter(LessonMindmap.status == "approved").order_by(LessonMindmap.version.desc()).first()
    out = {"lesson_code": lesson.code, "lesson_title": lesson.title, "approved": _dict(approved) if approved else None}
    if user.is_teacher:
        latest = q.filter(LessonMindmap.status != "archived").order_by(LessonMindmap.version.desc()).first()
        out["latest"] = _dict(latest) if latest else None
    return out


def _clean_tree(node: dict, depth: int = 0) -> dict:
    """Giáo viên sửa cây: chỉ nhận tên / ghi chú / nguồn đã có / con; giới hạn độ sâu."""
    if depth > 4:
        raise AppError(400, "INVALID_TREE", "Sơ đồ quá sâu.")
    title = str(node.get("title") or "").strip()
    if not title or len(title) > 120:
        raise AppError(400, "INVALID_TREE", "Mỗi nút cần tên (tối đa 120 ký tự).")
    return {"id": str(node.get("id") or uuid.uuid4().hex[:12])[:24], "title": title,
            "note": str(node.get("note") or "").strip()[:300],
            "sources": [{k: s.get(k) for k in SOURCE_KEYS} for s in (node.get("sources") or []) if isinstance(s, dict)][:10],
            "children": [_clean_tree(c, depth + 1) for c in (node.get("children") or [])][:12]}


def update(db: Session, user: Principal, mindmap_id, tree: dict | None, status: str | None) -> dict:
    m = db.get(LessonMindmap, mindmap_id)
    if m is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy sơ đồ.")
    lesson_by_code(db, user, m.lesson_code, teacher=True)
    if tree is not None:
        cleaned = _clean_tree(tree)
        if _count(cleaned["children"]) > MAX_NODES:
            raise AppError(400, "INVALID_TREE", "Sơ đồ quá lớn.")
        m.tree = cleaned
    if status is not None:
        if status not in ("draft", "approved"):
            raise AppError(400, "INVALID_STATUS", "status phải là draft hoặc approved.")
        if status == "approved":
            # chỉ một bản được duyệt cho mỗi bài: bản duyệt cũ chuyển sang lưu trữ
            (db.query(LessonMindmap).filter(LessonMindmap.lesson_code == m.lesson_code, LessonMindmap.id != m.id,
                                            LessonMindmap.status == "approved").update({"status": "archived"}))
            m.approved_by, m.approved_at = user.user_id, utcnow()
        m.status = status
    db.commit()
    db.refresh(m)
    return _dict(m)
