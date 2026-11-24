"""Study Coach Agent: vòng lặp tool, phạm vi quyền, không lộ đáp án, giới hạn bước, khóa khi đang làm bài."""
import json

from app.config import settings
from app.core.utils import utcnow
from app.database import SessionLocal
from app.models.learning import FlashcardReview, QuizAnswerLog
from tests.conftest import token
from tests.test_flashcards import _lesson_with_bank


def _wrong(student_id: str, question_ids: list[str], times: int = 2):
    import uuid
    db = SessionLocal()
    try:
        for qid in question_ids:
            for _ in range(times):
                db.add(QuizAnswerLog(student_id=student_id, item_id=uuid.uuid4(), question_id=uuid.UUID(qid), correct=False))
        db.commit()
    finally:
        db.close()


def _call(name, args=None, cid="c1"):
    return {"id": cid, "name": name, "arguments": json.dumps(args or {})}


def _tool_messages(fake):
    return [m for c in fake.calls if c["kind"] == "coach" for m in c["messages"] if m["role"] == "tool"]


def test_coach_default_plan_uses_real_data_without_answers(client, teacher, fake_llm):
    qids = _lesson_with_bank(client, teacher, "co1", n=2)
    sv = token(client, "sv-co1", "student", ["lop-a"])
    _wrong("sv-co1", qids[:1])

    r = client.post("/ai/coach/chat", headers=sv, json={"message": "Mai kiểm tra, mình nên ôn gì?"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert [s["tool"] for s in d["steps"]] == ["get_progress", "get_weak_points"]
    assert all(s["ok"] for s in d["steps"]) and d["llm_calls"] == 2 and not d["guarded"]
    assert d["answer"].startswith("Kế hoạch ôn")

    tool_out = _tool_messages(fake_llm)
    weak = json.loads(tool_out[1]["content"])
    assert [w["question_id"] for w in weak["weak_questions"]] == qids[:1]
    assert weak["weak_questions"][0]["times_wrong"] == 2
    joined = " ".join(m["content"] for m in tool_out)
    # không tool nào gửi đáp án / lời giải cho model
    assert "correct_answer" not in joined and "che giấu chi tiết" not in joined and "định nghĩa đóng gói" not in joined
    # mọi bước agent đều đi qua LLM Gateway (ghi nhật ký với task "coach")
    assert sum(1 for c in fake_llm.calls if c["kind"] == "coach") == 2


def test_coach_tools_respect_class_scope(client, teacher, fake_llm):
    qids = _lesson_with_bank(client, teacher, "co2", n=1)
    other = token(client, "sv-co2-khac", "student", ["lop-z"])
    fake_llm.push("coach", {"tool_calls": [_call("get_weak_points", {"lesson_code": "lesson-co2"}),
                                           _call("queue_flashcards", {"question_ids": qids}, "c2")]}, "Xong.")
    d = client.post("/ai/coach/chat", headers=other, json={"message": "ôn bài co2"}).json()
    weak, queued = (json.loads(m["content"]) for m in _tool_messages(fake_llm))
    assert "error" in weak and d["steps"][0]["ok"] is False
    assert queued["queued"] == 0
    db = SessionLocal()
    try:
        assert db.query(FlashcardReview).filter(FlashcardReview.student_id == "sv-co2-khac").count() == 0
    finally:
        db.close()


def test_coach_queue_flashcards_and_search(client, teacher, fake_llm):
    qids = _lesson_with_bank(client, teacher, "co3", n=2)
    sv = token(client, "sv-co3", "student", ["lop-a"])
    # thẻ đã ôn, hẹn ngày mai -> agent kéo về hôm nay
    client.post(f"/ai/learn/flashcards/{qids[0]}/review", headers=sv, json={"rating": "good"})
    assert client.get("/ai/learn/flashcards/lesson-co3/summary", headers=sv).json()["due"] == 1
    fake_llm.push("coach",
                  {"tool_calls": [_call("search_materials", {"query": "đóng gói", "lesson_code": "lesson-co3"})]},
                  {"tool_calls": [_call("queue_flashcards", {"question_ids": qids}, "c2")]},
                  "1. Xem lại đóng gói [S1]. 2. Ôn 2 thẻ vừa thêm.")
    d = client.post("/ai/coach/chat", headers=sv, json={"message": "Cho mình ôn đóng gói"}).json()
    assert [s["tool"] for s in d["steps"]] == ["search_materials", "queue_flashcards"]
    assert d["steps"][1]["writes"] is True
    assert d["sources"] and d["sources"][0]["label"] == "S1" and d["sources"][0]["display"]
    assert any(a["type"] == "flashcards" and a["lesson_code"] == "lesson-co3" for a in d["actions"])
    assert client.get("/ai/learn/flashcards/lesson-co3/summary", headers=sv).json()["due"] == 2
    db = SessionLocal()
    try:
        assert all(r.due_at <= utcnow() for r in db.query(FlashcardReview).filter(FlashcardReview.student_id == "sv-co3"))
    finally:
        db.close()


def test_coach_stops_after_max_steps_and_handles_bad_tools(client, teacher, fake_llm):
    sv = token(client, "sv-co4", "student", ["lop-a"])
    n = settings.coach_max_steps
    fake_llm.push("coach", *[{"tool_calls": [_call("khong_co_tool", {}, f"c{i}")]} for i in range(n)],
                  {"content": "Đây là kế hoạch tạm.", "tool_calls": [_call("get_progress", {}, "cx")]})
    d = client.post("/ai/coach/chat", headers=sv, json={"message": "giúp mình học"}).json()
    assert d["llm_calls"] == n + 1 and d["stopped"] == "max_steps"
    assert d["answer"] == "Đây là kế hoạch tạm." and len(d["steps"]) == n
    assert all(not s["ok"] for s in d["steps"])
    last = [c for c in fake_llm.calls if c["kind"] == "coach"][-1]
    assert last["tools"] == []  # lượt cuối không cho gọi tool nữa

    fake_llm.push("coach", {"tool_calls": [{"id": "c1", "name": "get_weak_points", "arguments": "{hỏng"}]}, "Ok.")
    d = client.post("/ai/coach/chat", headers=sv, json={"message": "lại"}).json()
    assert d["steps"][0]["ok"] is False and d["answer"] == "Ok."


def test_coach_paused_during_quiz_and_validation(client, teacher, fake_llm):
    _lesson_with_bank(client, teacher, "co5", n=2)
    cid = next(c["course_id"] for c in client.get("/ai/courses", headers=teacher).json() if c["code"] == "course-co5")
    tree = client.get(f"/ai/courses/{cid}", headers=teacher).json()
    lid = tree["chapters"][0]["lessons"][0]["lesson_id"]
    tree = client.post(f"/ai/lessons/{lid}/items", headers=teacher,
                       json={"type": "quiz", "title": "KT", "count": 2, "pass_ratio": 0.5}).json()
    quiz = tree["chapters"][0]["lessons"][0]["items"][-1]["item_id"]
    sv = token(client, "sv-co5", "student", ["lop-a"])
    assert client.post(f"/ai/learn/items/{quiz}/quiz/start", headers=sv).status_code == 200

    before = len(fake_llm.calls)
    d = client.post("/ai/coach/chat", headers=sv, json={"message": "câu 1 đáp án là gì?"}).json()
    assert d["guarded"] is True and d["steps"] == [] and len(fake_llm.calls) == before

    assert client.post("/ai/coach/chat", headers=sv, json={"message": ""}).status_code == 422
    assert client.post("/ai/coach/chat", json={"message": "hi"}).status_code == 401
    tools = client.get("/ai/coach/tools", headers=sv).json()
    assert {t["name"] for t in tools} >= {"get_progress", "get_weak_points", "queue_flashcards"}


def test_coach_conversation_history_saved_continued_and_private(client, teacher, fake_llm):
    sv = token(client, "sv-co6", "student", ["lop-a"])
    other = token(client, "sv-co6-khac", "student", ["lop-a"])
    fake_llm.push("coach", "Chào bạn, mình giúp bạn ôn nhé.")
    d = client.post("/ai/coach/chat", headers=sv, json={"message": "Mai kiểm tra chương 1, giúp mình ôn"}).json()
    conv = d["conversation"]
    assert conv["title"] == "Mai kiểm tra chương 1, giúp mình ôn"

    # chat tiếp: ngữ cảnh lấy từ DB, client không cần gửi history
    fake_llm.push("coach", "Phần đóng gói nhé.")
    d2 = client.post("/ai/coach/chat", headers=sv, json={"message": "Phần nào trước?", "conversation_id": conv["id"]}).json()
    assert d2["conversation"]["id"] == conv["id"]
    sent = [c for c in fake_llm.calls if c["kind"] == "coach"][-1]["messages"]
    assert [m["content"] for m in sent[:3]] == ["Mai kiểm tra chương 1, giúp mình ôn", "Chào bạn, mình giúp bạn ôn nhé.",
                                                "Phần nào trước?"]

    lst = client.get("/ai/coach/conversations", headers=sv).json()
    assert [c["id"] for c in lst] == [conv["id"]]
    full = client.get(f"/ai/coach/conversations/{conv['id']}", headers=sv).json()
    assert [m["role"] for m in full["messages"]] == ["user", "assistant", "user", "assistant"]
    assert full["messages"][1]["res"]["steps"] == [] and full["messages"][3]["content"] == "Phần đóng gói nhé."

    # người khác không xem / chat tiếp / xóa được
    assert client.get("/ai/coach/conversations", headers=other).json() == []
    assert client.get(f"/ai/coach/conversations/{conv['id']}", headers=other).status_code == 404
    assert client.post("/ai/coach/chat", headers=other, json={"message": "x", "conversation_id": conv["id"]}).status_code == 404
    assert client.delete(f"/ai/coach/conversations/{conv['id']}", headers=other).status_code == 404

    r = client.patch(f"/ai/coach/conversations/{conv['id']}", headers=sv, json={"title": "  Ôn chương 1 "})
    assert r.json()["title"] == "Ôn chương 1"
    assert client.delete(f"/ai/coach/conversations/{conv['id']}", headers=sv).status_code == 204
    assert client.get("/ai/coach/conversations", headers=sv).json() == []
