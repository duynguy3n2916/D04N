"""API thẻ ghi nhớ: học sinh ôn thẻ (SM-2); giáo viên sinh thẻ bằng AI, duyệt và sửa thẻ."""
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import Principal, get_current_user, require_teacher
from app.core.utils import clean_id, parse_uuid
from app.database import get_db

router = APIRouter(prefix="/ai", tags=["flashcards"])


@router.get("/learn/flashcards")
def flashcards_overview(user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    """Tổng quan các bộ thẻ theo khóa học, kèm trạng thái khóa của từng bộ."""
    from app.services.courses import flashcards
    return flashcards.overview(db, user)


@router.get("/learn/flashcards/library")
def flashcards_library(status: Literal["all", "remembered", "unremembered"] = "all",
                       offset: int = 0, limit: int = 20, user: Principal = Depends(get_current_user),
                       db: Session = Depends(get_db)):
    from app.services.courses import flashcards
    return flashcards.library_cards(db, user, status, max(0, offset), max(1, min(50, limit)))


@router.get("/learn/flashcards/{lesson_code}/summary")
def flashcards_summary(lesson_code: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.services.courses import flashcards
    return flashcards.summary(db, user, clean_id(lesson_code))


@router.get("/learn/flashcards/{lesson_code}/due")
def flashcards_due(lesson_code: str, limit: int = 20, user: Principal = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """Các thẻ đến hạn ôn (thẻ mới xếp sau thẻ đã đến hạn lâu nhất)."""
    from app.services.courses import flashcards
    return flashcards.due_cards(db, user, clean_id(lesson_code), limit=max(1, min(50, limit)))


class FlashcardReviewIn(BaseModel):
    rating: str = Field(pattern="^(again|hard|good|easy)$")


@router.post("/learn/flashcards/{card_id}/review")
def flashcards_review(card_id: str, req: FlashcardReviewIn, user: Principal = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    from app.services.courses import flashcards
    return flashcards.review(db, user, parse_uuid(card_id, "card_id"), req.rating)


class FlashcardMemoryIn(BaseModel):
    remembered: bool


@router.put("/learn/flashcards/{card_id}/memory")
def flashcards_memory(card_id: str, req: FlashcardMemoryIn, user: Principal = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    from app.services.courses import flashcards
    return flashcards.review(db, user, parse_uuid(card_id, "card_id"),
                             "good" if req.remembered else "again", remembered=req.remembered)


class GenerateCardsIn(BaseModel):
    count: int = Field(default=10, ge=1, le=20)


@router.post("/lessons/{lesson_code}/flashcards/generate")
def generate_flashcards(lesson_code: str, req: GenerateCardsIn, user: Principal = Depends(require_teacher),
                        db: Session = Depends(get_db)):
    """AI soạn thẻ ghi nhớ từ học liệu của bài (lưu nháp, giáo viên duyệt rồi học sinh mới ôn)."""
    from app.services.courses import flashcards
    return flashcards.generate_cards(db, user, clean_id(lesson_code), req.count)


@router.get("/lessons/{lesson_code}/flashcards")
def list_flashcard_cards(lesson_code: str, status: str | None = None, user: Principal = Depends(require_teacher),
                         db: Session = Depends(get_db)):
    from app.services.courses import flashcards
    return flashcards.list_ai_cards(db, user, clean_id(lesson_code), status)


class CardUpdateIn(BaseModel):
    front: str | None = Field(default=None, max_length=300)
    back: str | None = Field(default=None, max_length=600)
    status: str | None = Field(default=None, pattern="^(draft|approved|rejected)$")


@router.patch("/flashcard-cards/{card_id}")
def update_flashcard_card(card_id: str, req: CardUpdateIn, user: Principal = Depends(require_teacher),
                          db: Session = Depends(get_db)):
    from app.services.courses import flashcards
    return flashcards.update_ai_card(db, user, parse_uuid(card_id, "card_id"), req.front, req.back, req.status)


# ---------------------------------------------------------------- thẻ riêng của học sinh ("Thẻ của tôi")

@router.get("/learn/my-flashcards")
def my_flashcards(deck: str | None = None, due: bool = False, user: Principal = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    from app.services.courses import my_flashcards as svc
    return svc.list_cards(db, user, deck, due)


class MyCardIn(BaseModel):
    front: str = Field(min_length=1, max_length=300)
    back: str = Field(min_length=1, max_length=600)
    deck: str | None = Field(default=None, max_length=120)
    course_id: str | None = None


@router.post("/learn/my-flashcards")
def create_my_flashcard(req: MyCardIn, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.services.courses import my_flashcards as svc
    return svc.create_card(db, user, req.front, req.back, req.deck, req.course_id)


class MyGenerateIn(BaseModel):
    count: int = Field(default=10, ge=1, le=20)
    lesson_code: str | None = Field(default=None, max_length=128)
    text: str | None = Field(default=None, max_length=12000)
    deck: str | None = Field(default=None, max_length=120)
    course_id: str | None = None


@router.post("/learn/my-flashcards/generate")
def generate_my_flashcards(req: MyGenerateIn, user: Principal = Depends(get_current_user),
                           db: Session = Depends(get_db)):
    """AI soạn thẻ riêng cho học sinh từ một bài học hoặc từ ghi chú/chủ đề học sinh nhập; lưu thẳng vào Thẻ của tôi."""
    from app.services.courses import my_flashcards as svc
    return svc.generate(db, user, req.count, clean_id(req.lesson_code) if req.lesson_code else None, req.text, req.deck,
                        course_id=req.course_id)


class MyCardUpdateIn(BaseModel):
    front: str | None = Field(default=None, max_length=300)
    back: str | None = Field(default=None, max_length=600)
    deck: str | None = Field(default=None, max_length=120)
    course_id: str | None = None  # "" = chuyển ra ngoài khóa; bỏ trống trường = giữ nguyên


@router.patch("/learn/my-flashcards/{card_id}")
def update_my_flashcard(card_id: str, req: MyCardUpdateIn, user: Principal = Depends(get_current_user),
                        db: Session = Depends(get_db)):
    from app.services.courses import my_flashcards as svc
    return svc.update_card(db, user, parse_uuid(card_id, "card_id"), req.front, req.back, req.deck,
                           req.course_id, move_course="course_id" in req.model_fields_set)


class DeckRenameIn(BaseModel):
    course_id: str | None = None
    deck: str = Field(default="", max_length=120)
    new_deck: str | None = Field(default=None, max_length=120)
    new_course_id: str | None = None


@router.post("/learn/my-flashcards/decks/rename")
def rename_my_deck(req: DeckRenameIn, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    """Đổi tên một bộ thẻ (khóa + tên bộ), có thể chuyển cả bộ sang khóa khác."""
    from app.services.courses import my_flashcards as svc
    return svc.rename_deck(db, user, req.course_id, req.deck, req.new_deck, req.new_course_id,
                           move_course="new_course_id" in req.model_fields_set)


class DeckRef(BaseModel):
    course_id: str | None = None
    deck: str = Field(default="", max_length=120)


@router.post("/learn/my-flashcards/decks/delete")
def delete_my_deck(req: DeckRef, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.services.courses import my_flashcards as svc
    return svc.delete_deck(db, user, req.course_id, req.deck)


@router.delete("/learn/my-flashcards/{card_id}")
def delete_my_flashcard(card_id: str, user: Principal = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.services.courses import my_flashcards as svc
    return svc.delete_card(db, user, parse_uuid(card_id, "card_id"))


@router.post("/learn/my-flashcards/{card_id}/review")
def review_my_flashcard(card_id: str, req: FlashcardReviewIn, user: Principal = Depends(get_current_user),
                        db: Session = Depends(get_db)):
    from app.services.courses import my_flashcards as svc
    return svc.review(db, user, parse_uuid(card_id, "card_id"), req.rating)
