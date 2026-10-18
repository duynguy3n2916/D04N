"""Flashcard ôn ngắt quãng: lịch SM-2, lấy thẻ đến hạn, chấm lại, quyền truy cập."""
from datetime import timedelta

from app.core.utils import utcnow
from app.database import SessionLocal
from app.models.learning import FlashcardReview
from app.services.flashcards import Schedule, next_schedule
from tests.conftest import LESSON_TEXT, token
from tests.test_api_core import upload


def test_sm2_schedule_grows_and_resets():
    s = Schedule(2.5, 0.0, 0, 0)
    s, d = next_schedule(s, "good")
    assert d == timedelta(days=1) and s.reps == 1
    s, d = next_schedule(s, "good")
    assert d == timedelta(days=3)
    s, d = next_schedule(s, "good")
    assert d > timedelta(days=3)  # khoảng cách tăng dần
    s, d = next_schedule(s, "again")
    assert d == timedelta(minutes=10) and s.reps == 0 and s.lapses == 1 and s.ease < 2.5
    s, d = next_schedule(Schedule(2.5, 3.0, 2, 0), "hard")
    assert d < timedelta(days=4) and s.ease < 2.5


def _lesson_with_bank(client, teacher, code, n=2):
    upload(client, teacher, f"{code}.md", LESSON_TEXT, lesson_id=f"lesson-{code}", class_id="lop-a")
    client.post("/ai/courses", headers=teacher, json={"code": f"course-{code}", "title": "FC", "class_id": "lop-a"})
    cid = client.get("/ai/courses", headers=teacher).json()
    cid = next(c["course_id"] for c in cid if c["code"] == f"course-{code}")
    tree = client.post(f"/ai/courses/{cid}/chapters", headers=teacher, json={"title": "C"}).json()
    ch = tree["chapters"][0]["chapter_id"]
    client.post(f"/ai/chapters/{ch}/lessons", headers=teacher, json={"code": f"lesson-{code}", "title": "B"})
    client.post("/ai/teacher/generate-quiz", headers=teacher,
                json={"lesson_id": f"lesson-{code}", "count": n, "question_types": ["multiple_choice"]})
    rows = client.get("/ai/teacher/question-bank?lesson_id=lesson-" + code, headers=teacher).json()
    for r in rows:
        client.patch(f"/ai/question-bank/{r['item_id']}", headers=teacher, json={"status": "approved"})
    return [r["item_id"] for r in rows]


def test_flashcard_flow(client, teacher, fake_llm):
    cards = _lesson_with_bank(client, teacher, "fc1", n=2)
    sv = token(client, "sv-fc1", "student", ["lop-a"])
    sm = client.get("/ai/learn/flashcards/lesson-fc1/summary", headers=sv).json()
    assert sm["total"] == 2 and sm["new"] == 2 and sm["due"] == 2

    due = client.get("/ai/learn/flashcards/lesson-fc1/due", headers=sv).json()
    assert len(due["cards"]) == 2 and due["cards"][0]["front"] and due["cards"][0]["back"]
    assert "correct_index" not in due["cards"][0] and due["cards"][0]["new"] is True

    r = client.post(f"/ai/learn/flashcards/{cards[0]}/review", headers=sv, json={"rating": "good"}).json()
    assert r["reps"] == 1
    sm = client.get("/ai/learn/flashcards/lesson-fc1/summary", headers=sv).json()
    assert sm["due"] == 1 and sm["new"] == 1  # thẻ vừa ôn đã được lên lịch ngày mai

    r = client.post(f"/ai/learn/flashcards/{cards[1]}/review", headers=sv, json={"rating": "again"}).json()
    sm = client.get("/ai/learn/flashcards/lesson-fc1/summary", headers=sv).json()
    assert sm["due"] == 0  # thẻ sai hỏi lại sau 10 phút, thẻ đúng ngày mai: chưa có thẻ nào đến hạn

    assert client.post(f"/ai/learn/flashcards/{cards[0]}/review", headers=sv, json={"rating": "meh"}).status_code == 422


def test_flashcard_access_and_due_order(client, teacher, fake_llm):
    cards = _lesson_with_bank(client, teacher, "fc2", n=1)
    other = token(client, "sv-fc2-khac", "student", ["lop-z"])
    assert client.get("/ai/learn/flashcards/lesson-fc2/summary", headers=other).status_code in (403, 404)
    assert client.post(f"/ai/learn/flashcards/{cards[0]}/review", headers=other, json={"rating": "good"}).status_code in (403, 404)

    sv = token(client, "sv-fc2", "student", ["lop-a"])
    client.post(f"/ai/learn/flashcards/{cards[0]}/review", headers=sv, json={"rating": "easy"})
    db = SessionLocal()
    try:
        rv = db.query(FlashcardReview).filter(FlashcardReview.student_id == "sv-fc2").one()
        assert rv.due_at > utcnow() + timedelta(days=1)
    finally:
        db.close()
    assert client.get("/ai/learn/flashcards/lesson-fc2/summary", headers=sv).json()["due"] == 0
