"""Đề kiểm tra có giờ: đặt giới hạn, chặn trả lời sau giờ, nộp tự động (câu chưa làm tính là sai)."""
from datetime import timedelta

from app.database import SessionLocal
from app.models.learning import ItemProgress
from app.core.utils import utcnow
from tests.conftest import LESSON_TEXT, token


def _timed_quiz(client, teacher, code, minutes):
    r = client.post("/ai/courses", headers=teacher, json={"code": f"course-{code}", "title": "Thi", "class_id": "lop-a"})
    cid = r.json()["course_id"]
    tree = client.post(f"/ai/courses/{cid}/chapters", headers=teacher, json={"title": "C1"}).json()
    ch = tree["chapters"][0]["chapter_id"]
    tree = client.post(f"/ai/chapters/{ch}/lessons", headers=teacher, json={"code": f"lesson-{code}", "title": "B1"}).json()
    lid = tree["chapters"][0]["lessons"][0]["lesson_id"]
    client.post(f"/ai/lessons/{lid}/items", headers=teacher, json={"type": "reading", "title": "Đọc", "content_md": LESSON_TEXT})
    tree = client.post(f"/ai/lessons/{lid}/items", headers=teacher,
                       json={"type": "quiz", "title": "Thi", "count": 2, "pass_ratio": 0.5, "time_limit_minutes": minutes}).json()
    reading, quiz = (i["item_id"] for i in tree["chapters"][0]["lessons"][0]["items"])
    gen = client.post("/ai/teacher/generate-quiz", headers=teacher,
                      json={"lesson_id": f"lesson-{code}", "count": 2, "question_types": ["multiple_choice"]}).json()
    for q in gen["questions"]:
        client.patch(f"/ai/question-bank/{q['item_id']}", headers=teacher, json={"status": "approved"})
    return reading, quiz


def _expire(student_id, quiz_item_id):
    """Đưa hạn làm bài về quá khứ để mô phỏng đã hết giờ."""
    import uuid
    db = SessionLocal()
    try:
        p = db.query(ItemProgress).filter(ItemProgress.student_id == student_id,
                                          ItemProgress.item_id == uuid.UUID(quiz_item_id)).one()
        p.meta = {**(p.meta or {}), "deadline_at": (utcnow() - timedelta(seconds=5)).isoformat()}
        db.commit()
    finally:
        db.close()


def test_timed_quiz_blocks_late_answers_and_auto_finishes(client, teacher, fake_llm):
    reading, quiz = _timed_quiz(client, teacher, "exam1", 30)
    assert client.get(f"/ai/learn/items/{quiz}", headers=teacher).json()["quiz"]["time_limit_minutes"] == 30
    sv = token(client, "sv-exam1", "student", ["lop-a"])
    client.post(f"/ai/learn/items/{reading}/complete", headers=sv)

    start = client.post(f"/ai/learn/items/{quiz}/quiz/start", headers=sv).json()
    assert start["time_limit_minutes"] == 30 and start["deadline_at"]
    first = start["questions"][0]["question_id"]
    a = client.post(f"/ai/learn/items/{quiz}/quiz/answer", headers=sv,
                    json={"question_id": first, "selected_index": 1}).json()
    assert a["is_correct"] is True  # còn giờ: trả lời bình thường

    _expire("sv-exam1", quiz)
    second = start["questions"][1]["question_id"]
    r = client.post(f"/ai/learn/items/{quiz}/quiz/answer", headers=sv, json={"question_id": second, "selected_index": 0})
    assert r.status_code == 409 and r.json()["error"]["code"] == "QUIZ_TIME_UP"

    fin = client.post(f"/ai/learn/items/{quiz}/quiz/finish", headers=sv).json()
    assert fin["time_up"] is True and fin["unanswered"] == 1
    assert fin["correct"] == 1 and fin["total"] == 2 and fin["passed"] is True  # 1/2 đạt ngưỡng 50%


def test_untimed_quiz_has_no_deadline(client, teacher, fake_llm):
    reading, quiz = _timed_quiz(client, teacher, "exam2", 0)
    sv = token(client, "sv-exam2", "student", ["lop-a"])
    client.post(f"/ai/learn/items/{reading}/complete", headers=sv)
    start = client.post(f"/ai/learn/items/{quiz}/quiz/start", headers=sv).json()
    assert start["time_limit_minutes"] is None and start["deadline_at"] is None
    fin = client.post(f"/ai/learn/items/{quiz}/quiz/finish", headers=sv).json()
    assert fin["time_up"] is False


def test_teacher_sees_class_submissions(client, teacher, fake_llm):
    # sv-exam1 đã làm bài có giờ ở test trên; sv-exam3 có trong lớp nhưng chưa làm bài nào
    reading, quiz = _timed_quiz(client, teacher, "exam3", 30)
    token(client, "sv-exam3", "student", ["lop-a"])
    sv = token(client, "sv-exam4", "student", ["lop-a"])
    client.post(f"/ai/learn/items/{reading}/complete", headers=sv)
    client.post(f"/ai/learn/items/{quiz}/quiz/start", headers=sv)  # bắt đầu nhưng chưa nộp
    body = client.get("/ai/classes/lop-a/submissions", headers=teacher).json()
    rows = {(r["student_id"], r["item_id"]): r for r in body["rows"]}
    assert body["quizzes"] >= 1 and body["students"] >= 3
    mine = rows[("sv-exam4", quiz)]
    assert mine["status"] == "in_progress" and mine["passed"] is None
    assert rows[("sv-exam3", quiz)]["status"] == "not_started"

    # học sinh không xem được; giáo viên lớp khác cũng không
    assert client.get("/ai/classes/lop-a/submissions", headers=sv).status_code == 403
    other = token(client, "gv-khac-lop", "teacher", ["lop-z"])
    assert client.get("/ai/classes/lop-a/submissions", headers=other).status_code == 403


def test_student_progress_report_docx(client, teacher, fake_llm):
    import io
    from docx import Document
    reading, quiz = _timed_quiz(client, teacher, "exam5", 0)
    sv = token(client, "sv-report", "student", ["lop-a"])
    client.post(f"/ai/learn/items/{reading}/complete", headers=sv)
    r = client.get("/ai/learn/progress-report", headers=sv)
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/vnd.openxmlformats")
    text = "\n".join(p.text for p in Document(io.BytesIO(r.content)).paragraphs)
    assert "BÁO CÁO TIẾN ĐỘ HỌC TẬP" in text and "sv-report" in text
    assert client.get("/ai/learn/progress-report").status_code == 401


def test_adaptive_sampling_prefers_wrong_questions(client, teacher, fake_llm):
    import random
    import uuid
    from app.models.video_question import QuestionBankItem
    from app.models.learning import QuizAnswerLog
    from app.services.learning import _adaptive_sample
    from app.core.security import Principal
    _, quiz = _timed_quiz(client, teacher, "exam6", 0)
    db = SessionLocal()
    try:
        pool = db.query(QuestionBankItem).filter(QuestionBankItem.lesson_id == "lesson-exam6").all()
        assert len(pool) == 2
        wrong, other = pool[0], pool[1]
        sv = Principal(user_id="sv-adapt", role="student", class_ids=["lop-a"])
        db.add(QuizAnswerLog(student_id="sv-adapt", item_id=uuid.UUID(quiz), question_id=wrong.id, correct=False))
        db.commit()
        hits = 0
        for seed in range(200):
            chosen = _adaptive_sample(db, sv, pool, 1, random.Random(seed))
            hits += chosen[0].id == wrong.id
        assert hits > 100  # trọng số 4 : 2 -> khoảng 2/3 số lần
    finally:
        db.close()


def test_quiz_open_close_window(client, teacher, fake_llm):
    from datetime import timedelta
    reading, quiz = _timed_quiz(client, teacher, "exam7", 0)
    sv = token(client, "sv-window", "student", ["lop-a"])
    client.post(f"/ai/learn/items/{reading}/complete", headers=sv)
    future = (utcnow() + timedelta(days=1)).isoformat()
    past = (utcnow() - timedelta(days=1)).isoformat()

    # chưa đến giờ mở: học sinh không bắt đầu được, giáo viên vẫn thử được
    assert client.patch(f"/ai/items/{quiz}", headers=teacher, json={"open_at": future}).status_code == 200
    assert client.get(f"/ai/learn/items/{quiz}", headers=sv).json()["quiz"]["window"] == "not_yet"
    r = client.post(f"/ai/learn/items/{quiz}/quiz/start", headers=sv)
    assert r.status_code == 409 and r.json()["error"]["code"] == "QUIZ_NOT_OPEN"
    assert client.post(f"/ai/learn/items/{quiz}/quiz/start", headers=teacher).status_code == 200

    # đã đóng
    client.patch(f"/ai/items/{quiz}", headers=teacher, json={"open_at": "", "close_at": past})
    r = client.post(f"/ai/learn/items/{quiz}/quiz/start", headers=sv)
    assert r.status_code == 409 and r.json()["error"]["code"] == "QUIZ_CLOSED"

    # đang mở: hạn làm bài không vượt quá giờ đóng
    soon = (utcnow() + timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
    client.patch(f"/ai/items/{quiz}", headers=teacher, json={"close_at": soon})
    start = client.post(f"/ai/learn/items/{quiz}/quiz/start", headers=sv).json()
    assert start["deadline_at"] and start["deadline_at"][:16] == soon[:16]

    # đóng trước khi mở -> lỗi
    r = client.patch(f"/ai/items/{quiz}", headers=teacher, json={"open_at": future, "close_at": past})
    assert r.status_code == 400 and r.json()["error"]["code"] == "INVALID_WINDOW"


def test_class_submissions_csv(client, teacher, admin, fake_llm):
    _timed_quiz(client, teacher, "exam8", 0)
    token(client, "sv-csv", "student", ["lop-a"])
    r = client.get("/ai/classes/lop-a/submissions.csv", headers=teacher)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    text = r.content.decode("utf-8")
    assert text.startswith("﻿") and "Mã học viên" in text and "sv-csv" in text and "Chưa làm" in text
    sv = token(client, "sv-csv2", "student", ["lop-a"])
    assert client.get("/ai/classes/lop-a/submissions.csv", headers=sv).status_code == 403
