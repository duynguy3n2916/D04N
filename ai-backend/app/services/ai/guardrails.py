"""Guardrail của các tính năng AI, gom một chỗ để dễ kiểm tra và trình bày.

1. Dữ liệu cá nhân: che email / số điện thoại trước khi lưu và trước khi gửi cho nhà cung cấp LLM.
2. Prompt injection: học liệu được bọc trong thẻ <tai_lieu>, không tự đóng/mở thẻ được để "thoát" ra ngoài.
3. Không bịa: nhận ra câu từ chối khi học liệu không có thông tin (ngưỡng liên quan: RAG_MIN_SCORE ở retrieval).
4. Công bằng khi kiểm tra: học sinh đang làm bài kiểm tra thì Tutor khóa hẳn, Trợ lý học tập tạm dừng.
5. Giới hạn dùng: số lượt hỏi Tutor mỗi học sinh / bài / ngày.
6. Hỏi lại khi mơ hồ: câu hỏi không nêu nội dung ("giải thích lại", "ôn gì") thì hỏi lại kèm các phần cụ thể
   của bài thay vì trả lời chung chung; nhận ra câu hỏi về chuẩn bị bài kiểm tra để lấy dữ liệu thật.

Các ngưỡng nằm trong app/config.py (nhóm "Guardrail / lưu trữ"); test: tests/test_guardrails.py.
Những guardrail gắn chặt với luồng xử lý vẫn ở nơi dùng: chế độ gợi ý và lọc lộ đáp án (tutor.py),
tool của Trợ lý không gửi đáp án cho model và giới hạn số bước (coach.py), phân quyền theo lớp (learning.py),
thời hạn lưu dữ liệu (services/system/retention.py).
"""
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.core.errors import AppError
from app.core.security import Principal

# ----------------------------------------------------------------------------
# 1. Dữ liệu cá nhân
# ----------------------------------------------------------------------------

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
# số điện thoại VN: 0xxxxxxxxx hoặc +84xxxxxxxxx, cho phép dấu cách / chấm / gạch giữa các nhóm
_PHONE = re.compile(r"(?<![\w])(?:\+?84|0)(?:[\s.\-]?\d){8,10}(?![\w])")


def redact_pii(text: str) -> str:
    """Che email và số điện thoại."""
    return _PHONE.sub("[số điện thoại]", _EMAIL.sub("[email]", text or ""))


def clean_user_text(text: str | None) -> str | None:
    """Che PII nếu bật REDACT_PII (giữ nguyên None)."""
    return redact_pii(text) if text and settings.redact_pii else text


# ----------------------------------------------------------------------------
# 2. Prompt injection
# ----------------------------------------------------------------------------

_DOC_TAG = re.compile(r"<\s*/?\s*tai_lieu\s*>", re.IGNORECASE)


def wrap_documents(context: str) -> str:
    """Bọc học liệu trong <tai_lieu>; thẻ giả bên trong bị loại để học liệu không "thoát" ra thành chỉ thị."""
    return f"<tai_lieu>\n{_DOC_TAG.sub('[thẻ tài liệu đã bị loại]', context)}\n</tai_lieu>"


# ----------------------------------------------------------------------------
# 3. Nhận ra câu từ chối
# ----------------------------------------------------------------------------

_REFUSAL_PHRASES = ("chưa tìm thấy", "không tìm thấy", "không có thông tin", "không đủ thông tin")


def is_refusal(answer: str) -> bool:
    a = (answer or "").lower()
    return any(p in a for p in _REFUSAL_PHRASES)


_FILLER_WORDS = set("""
giải thích lại cái này đó kia ấy là gì sao vậy thế nào mình em tôi tớ bạn ơi giúp với nhé nha nhá đi hiểu không
chưa ko k hok phần đoạn bài chỗ nữa hơn rõ cho hỏi câu ôn tập học thêm được đc nói về có thể xíu chút tí nói
làm ạ a à ừ ok vâng dạ còn thì mà và hay nên cần muốn biết xem coi trên dưới đây kỹ kĩ dễ hiểu ví dụ vd lần
""".split())


def content_words(text: str | None) -> list[str]:
    """Các từ mang nội dung (bỏ từ đệm, đại từ, "giải thích", "cái này"...)."""
    return [w for w in re.findall(r"\w+", (text or "").lower()) if w not in _FILLER_WORDS and not w.isdigit()]


def is_vague_question(text: str | None) -> bool:
    """Câu hỏi không có từ nội dung nào: "giải thích lại đi", "cái này là sao", "ôn gì"."""
    return not content_words(text)


_EXAM_PREP = re.compile(r"kiểm\s*tra|\bthi\b|bài\s*test|\bquiz\b|trắc\s*nghiệm|chuẩn\s*bị|ôn\s*(tập|thi|bài|gì|lại)"
                        r"|điểm\s*yếu|đang\s*yếu|yếu\s*(chỗ|phần|ở|gì)|hay\s*sai",
                        re.IGNORECASE)


def is_exam_prep(text: str | None) -> bool:
    """Học sinh hỏi nên ôn / chuẩn bị gì cho bài kiểm tra."""
    return bool(_EXAM_PREP.search(text or ""))


# ----------------------------------------------------------------------------
# 4. Khóa khi đang làm bài kiểm tra
# ----------------------------------------------------------------------------

TUTOR_LOCKED_MESSAGE = ("Bạn đang làm bài trắc nghiệm nên Tutor AI tạm khóa để bài làm công bằng. "
                        "Nộp bài xong bạn hỏi lại nhé, mình sẽ giải thích các câu còn chưa chắc.")
COACH_PAUSED_MESSAGE = ("Bạn đang làm dở một bài kiểm tra. Trợ lý học tập tạm dừng để bài làm công bằng. "
                        "Hãy nộp bài xong rồi quay lại, mình sẽ giúp bạn ôn những câu còn yếu.")


def quiz_in_progress(db: Session, user: Principal) -> bool:
    """Học sinh có bài kiểm tra đang làm dở (xác định phía server, không tin cờ client)."""
    from app.services.courses import learning  # tránh import vòng
    return not user.is_teacher and bool(learning.active_quiz_questions(db, user))


def ensure_tutor_unlocked(db: Session, user: Principal) -> None:
    if quiz_in_progress(db, user):
        raise AppError(403, "TUTOR_LOCKED_QUIZ", TUTOR_LOCKED_MESSAGE)


# ----------------------------------------------------------------------------
# 5. Giới hạn số lượt hỏi Tutor
# ----------------------------------------------------------------------------

def _day_start() -> tuple[datetime, datetime]:
    """0 giờ hôm nay theo múi giờ ứng dụng, và giờ đó quy về UTC (để so với created_at lưu dạng UTC)."""
    try:
        tz = ZoneInfo(settings.app_timezone)
    except Exception:
        tz = timezone.utc
    local = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    return local, local.astimezone(timezone.utc)


def tutor_quota(db: Session, user: Principal, lesson_id: str | None) -> dict | None:
    """Số lượt hỏi Tutor còn lại cho (học sinh, bài, hôm nay). None nếu không áp dụng giới hạn."""
    from app.models.conversation import AIConversation, AIMessage
    limit = settings.tutor_daily_limit_per_lesson
    if user.is_teacher or not lesson_id or limit <= 0:
        return None
    day_local, day_utc = _day_start()
    used = int(db.query(func.count(AIMessage.id))
               .join(AIConversation, AIMessage.conversation_id == AIConversation.id)
               .filter(AIConversation.student_id == user.user_id, AIConversation.lesson_id == lesson_id,
                       AIMessage.role == "user", AIMessage.created_at >= day_utc)
               .scalar() or 0)
    return {"used": used, "limit": limit, "remaining": max(0, limit - used),
            "resets_at": (day_local + timedelta(days=1)).isoformat()}


def ensure_tutor_quota(db: Session, user: Principal, lesson_id: str | None) -> None:
    """Đếm trước khi gọi LLM; vượt giới hạn thì báo lỗi, không tạo tin nhắn."""
    quota = tutor_quota(db, user, lesson_id)
    if quota and quota["remaining"] <= 0:
        raise AppError(429, "TUTOR_QUOTA_EXCEEDED",
                       f"Bạn đã dùng hết {quota['limit']} lượt hỏi Tutor cho bài này hôm nay. "
                       "Hãy xem lại các nguồn Tutor đã trích hoặc quay lại vào ngày mai nhé. "
                       "Video, slide và bài kiểm tra vẫn học bình thường.", quota)
