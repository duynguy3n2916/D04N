"""Thông báo chưa đọc: nội dung mới của người khác trong diễn đàn lớp, đánh dấu đã xem, thẻ flashcard đến hạn."""
from datetime import timedelta

from app.core.utils import utcnow
from app.database import SessionLocal
from app.models.learning import FlashcardReview
from tests.conftest import token


def test_forum_unread_counts_and_mark_seen(client, teacher):
    a = token(client, "sv-noti-a", "student", ["lop-noti"])
    b = token(client, "sv-noti-b", "student", ["lop-noti"])
    gv = token(client, "gv-noti", "teacher", ["lop-noti"])
    client.post("/ai/notifications/seen", headers=a, json={"key": "forum:lop-noti"})
    assert client.get("/ai/notifications/summary", headers=a).json()["forum_new"] == 0

    tid = client.post("/ai/forum/classes/lop-noti/threads", headers=b, json={"title": "Hỏi", "body": "?"}).json()["thread_id"]
    client.post(f"/ai/forum/threads/{tid}/replies", headers=gv, json={"body": "Trả lời"})
    s = client.get("/ai/notifications/summary", headers=a).json()
    assert s["forum_new"] == 2 and s["forum_by_class"]["lop-noti"] == 2
    # nội dung của chính mình không tính là "mới"
    assert client.get("/ai/notifications/summary", headers=b).json()["forum_by_class"]["lop-noti"] == 1

    assert client.post("/ai/notifications/seen", headers=a, json={"key": "forum:lop-noti"}).status_code == 200
    assert client.get("/ai/notifications/summary", headers=a).json()["forum_new"] == 0
    # không đánh dấu được lớp mình không thuộc, hoặc key lạ
    assert client.post("/ai/notifications/seen", headers=a, json={"key": "forum:lop-khac"}).status_code == 403
    assert client.post("/ai/notifications/seen", headers=a, json={"key": "khac"}).status_code == 400


def test_flashcards_due_in_summary(client):
    sv = token(client, "sv-noti-fc", "student", ["lop-noti"])
    db = SessionLocal()
    try:
        import uuid
        db.add(FlashcardReview(student_id="sv-noti-fc", card_id=uuid.uuid4(), lesson_code="lesson-noti",
                               due_at=utcnow() - timedelta(hours=1), ease=2.5, interval_days=1.0, reps=1, lapses=0))
        db.add(FlashcardReview(student_id="sv-noti-fc", card_id=uuid.uuid4(), lesson_code="lesson-noti",
                               due_at=utcnow() + timedelta(days=2), ease=2.5, interval_days=3.0, reps=2, lapses=0))
        db.commit()
    finally:
        db.close()
    s = client.get("/ai/notifications/summary", headers=sv).json()
    assert s["flashcards_due"] == 1 and s["flashcards"][0]["lesson_code"] == "lesson-noti"
