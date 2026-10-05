"""Teacher AI: sinh câu hỏi / bộ đề có cấu trúc, lưu từng câu vào ngân hàng để giáo viên sửa và duyệt."""
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.llm_schemas import QuestionItem, QuizOutput
from app.core.prompts import TEACHER_QUIZ, wrap_documents
from app.core.security import Principal
from app.core.utils import utcnow
from app.models.documents import AIChunk, AIDocument
from app.models.video_question import AIGeneration, QuestionBankItem, VideoQuestion
from app.services import llm
from app.services.retrieval import RetrievalScope, _apply_scope, _row_to_dict, build_context, retrieve


def sample_scope_chunks(db: Session, scope: RetrievalScope, limit: int = 14) -> list[dict]:
    """Lấy các chunk rải đều trong phạm vi (bài học / tài liệu) để câu hỏi phủ toàn bài."""
    stmt = select(AIChunk, AIDocument).join(AIDocument, AIChunk.document_id == AIDocument.id)
    stmt = _apply_scope(stmt, scope).order_by(AIDocument.created_at, AIChunk.chunk_index)
    rows = db.execute(stmt.limit(400)).all()
    if not rows:
        return []
    if len(rows) > limit:
        step = len(rows) / limit
        rows = [rows[int(i * step)] for i in range(limit)]
    return [_row_to_dict(c, d, None) for c, d in rows]


def build_teacher_context(db: Session, user: Principal, *, lesson_id=None, course_id=None, document_id=None,
                          context_query: str | None = None) -> tuple[str, list[dict]]:
    scope = RetrievalScope.for_user(user, course_id=course_id, lesson_id=lesson_id,
                                    document_ids=[document_id] if document_id else None)
    if context_query:
        chunks = retrieve(db, context_query, scope, top_k=10, min_score=0.15)
    else:
        chunks = sample_scope_chunks(db, scope)
    if not chunks:
        raise AppError(400, "NO_CONTEXT", "Không tìm thấy học liệu trong phạm vi đã chọn. Hãy nạp tài liệu cho bài học trước.")
    return build_context(chunks, max_chars=12000)


def _bank_to_dict(item: QuestionBankItem) -> dict:
    return {"item_id": str(item.id), "generation_id": str(item.generation_id) if item.generation_id else None,
            "status": item.status, "edited": bool(item.edited), "lesson_id": item.lesson_id,
            "created_at": item.created_at.isoformat() if item.created_at else None, **(item.payload or {})}


def generate_quiz(db: Session, user: Principal, *, count: int, question_types: list[str] | None,
                  difficulties: list[str] | None, lesson_id=None, course_id=None, class_id=None, document_id=None,
                  context_query=None, language: str = "vi", generation_type: str = "quiz") -> dict:
    context, sources = build_teacher_context(db, user, lesson_id=lesson_id, course_id=course_id,
                                             document_id=document_id, context_query=context_query)
    type_hint = ", ".join(question_types) if question_types else "kết hợp multiple_choice, true_false, short_answer"
    diff_hint = ", ".join(difficulties) if difficulties else "phân bổ easy / medium / hard"
    base_prompt = (f"{wrap_documents(context)}\n\nYêu cầu: sinh {{n}} câu hỏi.\n- Loại câu hỏi: {type_hint}\n"
                   f"- Độ khó: {diff_hint}\n- Ngôn ngữ: {language}\n- Mỗi câu ghi sources theo nhãn S1, S2…")
    chunk_ids = [s["chunk_id"] for s in sources if s.get("chunk_id")]
    out, res = llm.complete_json("teacher_quiz", TEACHER_QUIZ, base_prompt.replace("{n}", str(count)), QuizOutput,
                                 chunk_ids=chunk_ids, user_id=user.user_id)
    questions = list(out.questions)
    if len(questions) < count:  # sinh bù số câu còn thiếu một lần
        missing = count - len(questions)
        existing = "\n".join(f"- {q.question}" for q in questions)
        try:
            extra, _ = llm.complete_json(
                "teacher_quiz", TEACHER_QUIZ,
                base_prompt.replace("{n}", str(missing)) + f"\n\nKhông trùng các câu đã có:\n{existing}",
                QuizOutput, chunk_ids=chunk_ids, user_id=user.user_id)
            questions += extra.questions[:missing]
        except Exception:
            pass
    questions = questions[:count]

    gen = AIGeneration(teacher_id=user.user_id, lesson_id=lesson_id, generation_type=generation_type,
                       request={"count": count, "question_types": question_types, "difficulties": difficulties,
                                "lesson_id": lesson_id, "course_id": course_id, "document_id": document_id,
                                "context_query": context_query},
                       prompt=f"{res.prompt_id}:{res.prompt_version}",
                       result={"sources": sources, "llm_call_ids": res.call_ids}, status="draft")
    db.add(gen)
    db.flush()
    items = []
    for q in questions:
        payload = q.model_dump()
        item = QuestionBankItem(generation_id=gen.id, teacher_id=user.user_id, course_id=course_id,
                                class_id=class_id, lesson_id=lesson_id, payload=payload, original_payload=payload,
                                edited=False, status="draft")
        db.add(item)
        items.append(item)
    db.commit()
    return {"generation_id": str(gen.id), "status": "draft", "questions": [_bank_to_dict(i) for i in items],
            "sources": sources, "requested": count, "generated": len(items)}


def list_bank(db: Session, user: Principal, lesson_id=None, status=None, limit: int = 100) -> list[dict]:
    q = db.query(QuestionBankItem)
    if not user.is_admin:
        q = q.filter(QuestionBankItem.teacher_id == user.user_id)
    if lesson_id:
        q = q.filter(QuestionBankItem.lesson_id == lesson_id)
    if status:
        q = q.filter(QuestionBankItem.status == status)
    return [_bank_to_dict(i) for i in q.order_by(QuestionBankItem.created_at.desc()).limit(limit).all()]


def update_bank_item(db: Session, user: Principal, item_id, payload: dict | None, status: str | None) -> dict:
    item = db.get(QuestionBankItem, item_id)
    if not item:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy câu hỏi.")
    if item.teacher_id != user.user_id and not user.is_admin:
        raise AppError(403, "FORBIDDEN", "Câu hỏi thuộc giáo viên khác.")
    if payload is not None:
        merged = {**(item.payload or {}), **payload}
        merged.pop("correct_index", None)
        try:
            validated = QuestionItem.model_validate(merged).model_dump()
        except Exception as e:
            raise AppError(422, "INVALID_QUESTION", f"Câu hỏi không hợp lệ: {e}")
        if validated != item.payload:
            item.payload = validated
            item.edited = True
    if status:
        if status not in ("draft", "approved", "rejected"):
            raise AppError(400, "INVALID_STATUS", "status phải là draft / approved / rejected")
        item.status = status
        item.reviewed_by, item.reviewed_at = user.user_id, utcnow()
    db.commit()
    return _bank_to_dict(item)


def set_generation_status(db: Session, user: Principal, generation_id, status: str) -> dict:
    if status not in ("draft", "approved", "rejected"):
        raise AppError(400, "INVALID_STATUS", "status phải là draft / approved / rejected")
    gen = db.get(AIGeneration, generation_id)
    if not gen:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy lần sinh.")
    if gen.teacher_id != user.user_id and not user.is_admin:
        raise AppError(403, "FORBIDDEN", "Lần sinh thuộc giáo viên khác.")
    gen.status = status
    db.query(QuestionBankItem).filter(QuestionBankItem.generation_id == gen.id).update(
        {"status": status, "reviewed_by": user.user_id, "reviewed_at": utcnow()}, synchronize_session=False)
    db.commit()
    return {"generation_id": str(gen.id), "status": status}


def list_generations(db: Session, user: Principal, lesson_id=None, limit: int = 50) -> list[dict]:
    q = db.query(AIGeneration)
    if not user.is_admin:
        q = q.filter(AIGeneration.teacher_id == user.user_id)
    if lesson_id:
        q = q.filter(AIGeneration.lesson_id == lesson_id)
    rows = q.order_by(AIGeneration.created_at.desc()).limit(limit).all()
    out = []
    for r in rows:
        items = db.query(QuestionBankItem).filter(QuestionBankItem.generation_id == r.id).all()
        legacy = (r.result or {}).get("questions", []) if isinstance(r.result, dict) else []
        out.append({"generation_id": str(r.id), "generation_type": r.generation_type, "status": r.status,
                    "lesson_id": r.lesson_id, "created_at": r.created_at.isoformat() if r.created_at else None,
                    "questions": [_bank_to_dict(i) for i in items] or legacy})
    return out


def acceptance_stats(db: Session, user: Principal) -> dict:
    """Tỷ lệ giáo viên chấp nhận câu hỏi AI sinh (chỉ số đánh giá Teacher AI)."""
    def counts(model, owner_col, extra_filter=None):
        q = db.query(model.status, model.edited, func.count()).group_by(model.status, model.edited)
        if not user.is_admin and owner_col is not None:
            q = q.filter(owner_col == user.user_id)
        if extra_filter is not None:
            q = q.filter(extra_filter)
        return q.all()

    rows = counts(QuestionBankItem, QuestionBankItem.teacher_id)
    rows += counts(VideoQuestion, VideoQuestion.created_by,
                   VideoQuestion.origin.in_(["teacher", "ai_suggest"]) & VideoQuestion.original_payload.is_not(None))
    approved = sum(n for st, ed, n in rows if st == "approved")
    approved_edited = sum(n for st, ed, n in rows if st == "approved" and ed)
    rejected = sum(n for st, ed, n in rows if st == "rejected")
    pending = sum(n for st, ed, n in rows if st == "draft")
    reviewed = approved + rejected
    return {
        "reviewed": reviewed, "approved": approved, "approved_without_edit": approved - approved_edited,
        "approved_with_edit": approved_edited, "rejected": rejected, "pending": pending,
        "acceptance_rate": round(approved / reviewed, 4) if reviewed else None,
        "acceptance_rate_without_edit": round((approved - approved_edited) / reviewed, 4) if reviewed else None,
    }
