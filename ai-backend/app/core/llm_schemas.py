"""Schema đầu ra có cấu trúc của LLM. Mọi JSON từ model đều được validate bằng các lớp này trước khi lưu."""
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.core.utils import resolve_option_index

QuestionType = Literal["multiple_choice", "short_answer", "essay", "open", "true_false"]
Difficulty = Literal["easy", "medium", "hard"]
CHOICE_TYPES = ("multiple_choice", "true_false")


class QuestionItem(BaseModel):
    type: QuestionType = "multiple_choice"
    difficulty: Difficulty = "medium"
    question: str = Field(min_length=5)
    options: list[str] | None = None
    correct_answer: str = Field(min_length=1)
    explanation: str = ""
    sources: list[str] | None = None
    correct_index: int | None = None  # do backend tính, không yêu cầu model trả

    @field_validator("difficulty", mode="before")
    @classmethod
    def _norm_difficulty(cls, v):
        mapping = {"dễ": "easy", "trung bình": "medium", "khó": "hard"}
        return mapping.get(str(v).strip().lower(), str(v).strip().lower()) if v else "medium"

    @field_validator("sources", mode="before")
    @classmethod
    def _norm_sources(cls, v):
        if v is None:
            return None
        if isinstance(v, str):
            return [v]
        return [str(x) for x in v]

    @model_validator(mode="after")
    def _check_options(self):
        if self.type == "true_false" and not self.options:
            self.options = ["Đúng", "Sai"]
        if self.type in CHOICE_TYPES:
            if not self.options or len(self.options) < 2:
                raise ValueError(f"Câu hỏi {self.type} phải có ít nhất 2 lựa chọn")
            if self.type == "multiple_choice" and len(self.options) != 4:
                raise ValueError("Câu trắc nghiệm phải có đúng 4 lựa chọn")
            idx = resolve_option_index(self.options, self.correct_answer)
            if idx is None:
                raise ValueError(f"correct_answer '{self.correct_answer}' không khớp lựa chọn nào")
            self.correct_index = idx
        else:
            self.options = None
            self.correct_index = None
        return self


class AgentQuestionItem(QuestionItem):
    type: Literal["multiple_choice", "true_false"] = "multiple_choice"


class QuizOutput(BaseModel):
    questions: list[QuestionItem]


class SuggestedTimestamp(BaseModel):
    timestamp: float
    concept: str = ""
    importance_score: float = Field(default=5, ge=0, le=10)
    reason: str = ""
    sample_question: QuestionItem | None = None


class SuggestOutput(BaseModel):
    suggestions: list[SuggestedTimestamp] = []


class GradeOutput(BaseModel):
    verdict: Literal["correct", "partial", "incorrect"]
    feedback: str


class JudgeOutput(BaseModel):
    groundedness: float = Field(ge=0, le=1)
    correctness: float = Field(ge=0, le=1)
    context_relevance: float = Field(ge=0, le=1)
    reason: str = ""


class FlashcardItem(BaseModel):
    front: str = Field(min_length=3, max_length=300)
    back: str = Field(min_length=1, max_length=600)
    sources: list[str] | None = None

    @field_validator("sources", mode="before")
    @classmethod
    def _norm_sources(cls, v):
        if v is None:
            return None
        return [v] if isinstance(v, str) else [str(x) for x in v]


class FlashcardsOutput(BaseModel):
    cards: list[FlashcardItem] = Field(min_length=1, max_length=30)


class MindmapNode(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    note: str = Field(default="", max_length=300)
    sources: list[str] = Field(default_factory=list)
    children: list["MindmapNode"] = Field(default_factory=list, max_length=12)

    @field_validator("sources", mode="before")
    @classmethod
    def _norm_sources(cls, v):
        if not v:
            return []
        return [v] if isinstance(v, str) else [str(x) for x in v]


class MindmapOutput(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    children: list[MindmapNode] = Field(min_length=1, max_length=12)

    @model_validator(mode="after")
    def _depth(self):
        def depth(n: MindmapNode) -> int:
            return 1 + max((depth(c) for c in n.children), default=0)
        if max(depth(c) for c in self.children) > 3:
            raise ValueError("Sơ đồ tối đa 3 tầng dưới chủ đề gốc.")
        return self


def schema_hint(model: type[BaseModel]) -> str:
    """Ví dụ JSON ngắn gọn gửi kèm prompt (dễ đọc cho model hơn JSON Schema đầy đủ)."""
    examples = {
        "QuestionItem": '{"type": "multiple_choice", "difficulty": "medium", "question": "...", '
                        '"options": ["A. ...", "B. ...", "C. ...", "D. ..."], "correct_answer": "B", '
                        '"explanation": "...", "sources": ["S1"]}',
        "QuizOutput": '{"questions": [ <QuestionItem>, ... ]}  với QuestionItem = '
                      '{"type": "multiple_choice | true_false | short_answer | essay | open", '
                      '"difficulty": "easy | medium | hard", "question": "...", "options": ["A. ...", "B. ...", "C. ...", "D. ..."] hoặc null, '
                      '"correct_answer": "B", "explanation": "...", "sources": ["S1"]}',
        "SuggestOutput": '{"suggestions": [{"timestamp": 125.0, "concept": "...", "importance_score": 8, "reason": "...", '
                         '"sample_question": {"type": "multiple_choice", "difficulty": "medium", "question": "...", '
                         '"options": ["A. ...", "B. ...", "C. ...", "D. ..."], "correct_answer": "A", "explanation": "..."}}]}',
        "GradeOutput": '{"verdict": "correct | partial | incorrect", "feedback": "..."}',
        "JudgeOutput": '{"groundedness": 0.9, "correctness": 0.8, "context_relevance": 0.7, "reason": "..."}',
        "FlashcardsOutput": '{"cards": [{"front": "Câu hỏi / khái niệm ngắn", "back": "Câu trả lời ngắn gọn", "sources": ["S1"]}]}',
        "MindmapOutput": '{"title": "Chủ đề bài học", "children": [{"title": "Ý chính", "note": "Tóm tắt 1 câu", '
                         '"sources": ["S1"], "children": [{"title": "Ý con", "note": "...", "sources": ["S2"], "children": []}]}]}',
    }
    if model is AgentQuestionItem:
        return "Trả về DUY NHẤT một JSON hợp lệ theo mẫu, không kèm markdown:\n" + examples["QuestionItem"]
    return "Trả về DUY NHẤT một JSON hợp lệ theo mẫu, không kèm markdown:\n" + examples.get(model.__name__, "{}")
