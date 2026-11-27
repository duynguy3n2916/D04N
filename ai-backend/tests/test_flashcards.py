"""Flashcard ôn ngắt quãng: lịch SM-2, lấy thẻ đến hạn, chấm lại, quyền truy cập."""
from datetime import timedelta

from app.core.utils import utcnow
from app.database import SessionLocal
from app.models.learning import FlashcardReview
from app.services.courses.flashcards import Schedule, next_schedule
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


def _add_reading_items(client, teacher, course_code, count=1):
    course = next(c for c in client.get("/ai/courses", headers=teacher).json() if c["code"] == course_code)
    tree = client.get(f"/ai/courses/{course['course_id']}", headers=teacher).json()
    lesson_id = tree["chapters"][0]["lessons"][0]["lesson_id"]
    for index in range(count):
        tree = client.post(f"/ai/lessons/{lesson_id}/items", headers=teacher,
                           json={"type": "reading", "title": f"Đọc {index + 1}", "content_md": LESSON_TEXT}).json()
    return lesson_id, [item["item_id"] for item in tree["chapters"][0]["lessons"][0]["items"]]


def _complete_first_item(client, teacher, student, course_code):
    _, (first_item,) = _add_reading_items(client, teacher, course_code)
    assert client.post(f"/ai/learn/items/{first_item}/complete", headers=student).status_code == 200


def test_flashcard_flow(client, teacher, fake_llm):
    cards = _lesson_with_bank(client, teacher, "fc1", n=2)
    sv = token(client, "sv-fc1", "student", ["lop-a"])
    _complete_first_item(client, teacher, sv, "course-fc1")
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
    _complete_first_item(client, teacher, sv, "course-fc2")
    client.post(f"/ai/learn/flashcards/{cards[0]}/review", headers=sv, json={"rating": "easy"})
    db = SessionLocal()
    try:
        rv = db.query(FlashcardReview).filter(FlashcardReview.student_id == "sv-fc2").one()
        assert rv.due_at > utcnow() + timedelta(days=1)
    finally:
        db.close()
    assert client.get("/ai/learn/flashcards/lesson-fc2/summary", headers=sv).json()["due"] == 0


def _ai_lesson(client, teacher, code):
    cid = client.post("/ai/courses", headers=teacher, json={"code": f"course-{code}", "title": "AI theo bài", "class_id": "lop-a"}).json()["course_id"]
    tree = client.post(f"/ai/courses/{cid}/chapters", headers=teacher, json={"title": "C1"}).json()
    ch = tree["chapters"][0]["chapter_id"]
    client.post(f"/ai/chapters/{ch}/lessons", headers=teacher, json={"code": code, "title": "Bài OOP"})
    upload(client, teacher, f"{code}.md", LESSON_TEXT, lesson_id=code, class_id="lop-a")


def test_ai_flashcards_need_approval(client, teacher, fake_llm):
    _ai_lesson(client, teacher, "lesson-fcai")
    sv = token(client, "sv-fcai", "student", ["lop-a"])
    _complete_first_item(client, teacher, sv, "course-lesson-fcai")
    assert client.post("/ai/lessons/lesson-fcai/flashcards/generate", headers=sv, json={"count": 2}).status_code == 403

    cards = client.post("/ai/lessons/lesson-fcai/flashcards/generate", headers=teacher, json={"count": 2}).json()
    assert len(cards) == 2 and all(c["status"] == "draft" for c in cards)
    assert cards[0]["sources"] and cards[0]["sources"][0]["label"] == "S1"  # nhãn đã được giải thành nguồn đầy đủ

    # chưa duyệt: học sinh chưa có thẻ để ôn
    assert client.get("/ai/learn/flashcards/lesson-fcai/summary", headers=sv).json()["total"] == 0
    r = client.patch(f"/ai/flashcard-cards/{cards[0]['card_id']}", headers=teacher,
                     json={"front": "Tính đóng gói là gì?", "status": "approved"}).json()
    assert r["status"] == "approved" and r["front"] == "Tính đóng gói là gì?"
    client.patch(f"/ai/flashcard-cards/{cards[1]['card_id']}", headers=teacher, json={"status": "rejected"})

    due = client.get("/ai/learn/flashcards/lesson-fcai/due", headers=sv).json()
    assert [c["front"] for c in due["cards"]] == ["Tính đóng gói là gì?"] and due["cards"][0]["type"] == "flashcard"
    rv = client.post(f"/ai/learn/flashcards/{cards[0]['card_id']}/review", headers=sv, json={"rating": "good"})
    assert rv.status_code == 200 and rv.json()["reps"] == 1
    # thẻ bị từ chối không ôn được
    assert client.post(f"/ai/learn/flashcards/{cards[1]['card_id']}/review", headers=sv, json={"rating": "good"}).status_code == 404


def test_flashcard_overview_by_course(client, teacher, fake_llm):
    cards = _lesson_with_bank(client, teacher, "fco", n=2)
    sv = token(client, "sv-fco", "student", ["lop-a"])
    locked = _lesson_with_bank(client, teacher, "fco-locked", n=1)
    _complete_first_item(client, teacher, sv, "course-fco")
    lesson_id, (first_item, last_item) = _add_reading_items(client, teacher, "course-fco-locked", count=2)
    assert client.post(f"/ai/learn/items/{first_item}/complete", headers=sv).status_code == 200
    lesson_url = f"/ai/learn/lessons/{lesson_id}"
    assert client.get(lesson_url, headers=sv).json()["flashcards_unlocked"] is False
    overview_url = "/ai/learn/flashcards"
    rows = client.get(overview_url, headers=sv).json()
    course = next(c for c in rows if c["code"] == "course-fco")
    assert course["total"] == 2 and course["due"] == 2
    assert course["lessons"][0]["lesson_code"] == "lesson-fco" and course["lessons"][0]["new"] == 2
    assert course["lessons"][0]["locked"] is False
    locked_course = next(c for c in rows if c["code"] == "course-fco-locked")
    assert locked_course["total"] == 0 and locked_course["due"] == 0
    (locked_deck,) = locked_course["lessons"]
    assert locked_deck["lesson_code"] == "lesson-fco-locked" and locked_deck["locked"] is True
    for view in ("summary", "due"):
        assert client.get(f"/ai/learn/flashcards/lesson-fco-locked/{view}", headers=sv).status_code == 403
    assert client.post(f"/ai/learn/flashcards/{locked[0]}/review", headers=sv, json={"rating": "good"}).status_code == 403
    assert client.put(f"/ai/learn/flashcards/{locked[0]}/memory", headers=sv, json={"remembered": True}).status_code == 403
    # học sinh lớp khác không thấy khóa này
    other = token(client, "sv-fco-z", "student", ["lop-z"])
    assert all(c["code"] != "course-fco" for c in client.get("/ai/learn/flashcards", headers=other).json())

    library = "/ai/learn/flashcards/library"
    page = client.get(library, headers=sv, params={"limit": 1}).json()
    assert len(page["cards"]) == 1 and page["next_offset"] == 1
    last = client.get(library, headers=sv, params={"limit": 1, "offset": page["next_offset"]}).json()
    assert {page["cards"][0]["card_id"], last["cards"][0]["card_id"]} == set(cards)
    assert last["next_offset"] is None and not last["cards"][0]["remembered"]
    assert client.get(library, headers=other).json()["cards"] == []
    path = f"/ai/learn/flashcards/{cards[0]}/memory"
    first = client.put(path, headers=sv, json={"remembered": True}).json()
    assert first["remembered"] and first["reps"] == 1
    assert client.put(path, headers=sv, json={"remembered": True}).json() == first
    remembered = client.get(library, headers=sv, params={"status": "remembered"}).json()["cards"]
    assert [c["card_id"] for c in remembered] == cards[:1]
    forgotten = client.put(path, headers=sv, json={"remembered": False}).json()
    assert not forgotten["remembered"] and forgotten["reps"] == 0
    unremembered = client.get(library, headers=sv, params={"status": "unremembered"}).json()["cards"]
    assert {c["card_id"] for c in unremembered} == set(cards)

    assert client.post(f"/ai/learn/items/{last_item}/complete", headers=sv).status_code == 200
    assert client.get(lesson_url, headers=sv).json()["flashcards_unlocked"] is True
    unlocked_course = next(c for c in client.get(overview_url, headers=sv).json() if c["code"] == "course-fco-locked")
    assert unlocked_course["due"] == 1 and unlocked_course["lessons"][0]["locked"] is False
    assert client.get("/ai/learn/flashcards/lesson-fco-locked/due", headers=sv).json()["cards"][0]["card_id"] == locked[0]


def test_my_flashcards_crud_review_and_privacy(client):
    me = token(client, "hs-my-fc", "student", ["lop-a"])
    other = token(client, "hs-my-fc-2", "student", ["lop-a"])
    c = client.post("/ai/learn/my-flashcards", headers=me, json={"front": "Đóng gói là gì?", "back": "Giấu dữ liệu", "deck": "OOP"})
    assert c.status_code == 200, c.text
    cid = c.json()["card_id"]
    data = client.get("/ai/learn/my-flashcards", headers=me).json()
    assert data["total"] == 1 and data["due"] == 1 and data["decks"] == ["OOP"]
    assert client.get("/ai/learn/my-flashcards", headers=other).json()["total"] == 0
    assert client.patch(f"/ai/learn/my-flashcards/{cid}", headers=other, json={"front": "x"}).status_code == 404
    assert client.patch(f"/ai/learn/my-flashcards/{cid}", headers=me, json={"back": "Ẩn chi tiết bên trong"}).json()["back"] == "Ẩn chi tiết bên trong"
    r = client.post(f"/ai/learn/my-flashcards/{cid}/review", headers=me, json={"rating": "good"})
    assert r.status_code == 200 and r.json()["remembered"]
    assert client.get("/ai/learn/my-flashcards?due=true", headers=me).json()["cards"] == []
    assert client.delete(f"/ai/learn/my-flashcards/{cid}", headers=me).status_code == 200
    assert client.get("/ai/learn/my-flashcards", headers=me).json()["total"] == 0


def test_my_flashcards_ai_from_notes(client, fake_llm):
    me = token(client, "hs-my-fc-ai", "student", ["lop-a"])
    assert client.post("/ai/learn/my-flashcards/generate", headers=me, json={"count": 3}).status_code == 400
    r = client.post("/ai/learn/my-flashcards/generate", headers=me,
                    json={"count": 2, "text": "Đóng gói, kế thừa, đa hình trong OOP", "deck": "Ghi chú"})
    assert r.status_code == 200, r.text
    cards = r.json()
    assert 1 <= len(cards) <= 2 and all(c["origin"] == "ai" and c["deck"] == "Ghi chú" for c in cards)
    assert client.get("/ai/learn/my-flashcards", headers=me).json()["total"] == len(cards)
