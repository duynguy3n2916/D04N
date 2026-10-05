from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.llm_schemas import Difficulty, QuestionType
from app.core.security import Principal, ensure_class_access, require_teacher
from app.core.utils import clean_id, parse_uuid
from app.database import get_db
from app.services import question_gen

router = APIRouter(prefix="/ai", tags=["teacher"])


class GenerateQuizRequest(BaseModel):
    lesson_id: str | None = None
    course_id: str | None = None
    class_id: str | None = None
    document_id: str | None = None
    context_query: str | None = None
    count: int = Field(default=5, ge=1, le=20)
    question_types: list[QuestionType] | None = None
    difficulties: list[Difficulty] | None = None
    language: str = "vi"
    teacher_id: str | None = None  # bỏ qua, lấy từ token


class GenerateQuestionRequest(BaseModel):
    context_query: str | None = None
    lesson_id: str | None = None
    course_id: str | None = None
    document_id: str | None = None
    type: QuestionType = "multiple_choice"
    difficulty: Difficulty = "medium"
    teacher_id: str | None = None


def _ids(req) -> dict:
    return {"lesson_id": clean_id(req.lesson_id), "course_id": clean_id(req.course_id),
            "document_id": str(parse_uuid(req.document_id, "document_id")) if req.document_id else None}


@router.post("/teacher/generate-quiz")
def generate_quiz(req: GenerateQuizRequest, user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    ensure_class_access(user, clean_id(req.class_id))
    return question_gen.generate_quiz(db, user, count=req.count, question_types=req.question_types,
                                      difficulties=req.difficulties, class_id=clean_id(req.class_id),
                                      context_query=req.context_query, language=req.language, **_ids(req))


@router.post("/questions/generate")
def generate_single(req: GenerateQuestionRequest, user: Principal = Depends(require_teacher),
                    db: Session = Depends(get_db)):
    return question_gen.generate_quiz(db, user, count=1, question_types=[req.type], difficulties=[req.difficulty],
                                      context_query=req.context_query, generation_type="question", **_ids(req))


@router.get("/teacher/generations")
def list_generations(lesson_id: str | None = None, user: Principal = Depends(require_teacher),
                     db: Session = Depends(get_db)):
    return question_gen.list_generations(db, user, lesson_id=clean_id(lesson_id))


class GenerationStatus(BaseModel):
    status: str


@router.patch("/teacher/generations/{generation_id}")
def update_generation_status(generation_id: str, status: str | None = Query(default=None),
                             body: GenerationStatus | None = None, user: Principal = Depends(require_teacher),
                             db: Session = Depends(get_db)):
    """Duyệt / từ chối toàn bộ câu hỏi của một lần sinh (status qua query hoặc body)."""
    return question_gen.set_generation_status(db, user, parse_uuid(generation_id, "generation_id"),
                                              status or (body.status if body else ""))


@router.get("/teacher/question-bank")
def list_question_bank(lesson_id: str | None = None, status: str | None = None,
                       user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    return question_gen.list_bank(db, user, lesson_id=clean_id(lesson_id), status=status)


class BankItemUpdate(BaseModel):
    question: str | None = None
    type: QuestionType | None = None
    difficulty: Difficulty | None = None
    options: list[str] | None = None
    correct_answer: str | None = None
    explanation: str | None = None
    status: str | None = None


@router.patch("/question-bank/{item_id}")
def update_question_bank_item(item_id: str, req: BankItemUpdate, user: Principal = Depends(require_teacher),
                              db: Session = Depends(get_db)):
    changes = req.model_dump(exclude_none=True)
    status = changes.pop("status", None)
    return question_gen.update_bank_item(db, user, parse_uuid(item_id, "item_id"), changes or None, status)


@router.get("/teacher/stats")
def teacher_stats(user: Principal = Depends(require_teacher), db: Session = Depends(get_db)):
    return question_gen.acceptance_stats(db, user)
