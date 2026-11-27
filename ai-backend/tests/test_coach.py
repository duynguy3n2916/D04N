"""Study Coach Agent: vòng lặp tool, phạm vi quyền, không lộ đáp án, giới hạn bước, khóa khi đang làm bài."""
import json

from app.config import settings
from app.core.utils import utcnow
from app.database import SessionLocal
from app.models.learning import FlashcardReview, QuizAnswerLog
from tests.conftest import token

from tests.test_flashcards import _complete_first_item, _lesson_with_bank


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


def _cid(client, headers, code=None):
    """course_id của khóa học sinh chọn trong ô chat (Trợ lý luôn gắn với một khóa)."""
    courses = client.get("/ai/learn/courses", headers=headers).json()
    return next(c["course_id"] for c in courses if code is None or c["code"] == code)


def _tool_messages(fake):
    return [m for c in fake.calls if c["kind"] == "coach" for m in c["messages"] if m["role"] == "tool"]


def test_coach_default_plan_uses_real_data_without_answers(client, teacher, fake_llm):
    qids = _lesson_with_bank(client, teacher, "co1", n=2)
    sv = token(client, "sv-co1", "student", ["lop-a"])
    _wrong("sv-co1", qids[:1])

    r = client.post("/ai/coach/chat", headers=sv, json={"message": "Mai kiểm tra, mình nên ôn gì?",
                                                        "course_id": _cid(client, sv, "course-co1")})
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
    sv_a = token(client, "sv-co2-a", "student", ["lop-a"])
    course_co2 = _cid(client, sv_a, "course-co2")
    # khóa của lớp khác: không chọn được
    r = client.post("/ai/coach/chat", headers=other, json={"message": "ôn bài co2", "course_id": course_co2})
    assert r.status_code == 404
    # không chọn khóa và cũng không có khóa nào: phải chọn khóa trước
    r = client.post("/ai/coach/chat", headers=other, json={"message": "ôn bài co2"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "COURSE_REQUIRED"
    # học sinh lớp khác nhưng tool tự gọi tới câu hỏi của khóa co2 (khi đang ôn khóa khác): không được
    fake_llm.push("coach", {"tool_calls": [_call("get_weak_points", {"lesson_code": "lesson-co2"}),
                                           _call("queue_flashcards", {"question_ids": qids}, "c2")]}, "Xong.")
    _lesson_with_bank(client, teacher, "co2b", n=1)
    sv_b = token(client, "sv-co2-khac", "student", ["lop-a"])
    d = client.post("/ai/coach/chat", headers=sv_b, json={"message": "ôn bài co2", "course_id": _cid(client, sv_b, "course-co2b")}).json()
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
    _complete_first_item(client, teacher, sv, "course-co3")
    # thẻ đã ôn, hẹn ngày mai -> agent kéo về hôm nay
    client.post(f"/ai/learn/flashcards/{qids[0]}/review", headers=sv, json={"rating": "good"})
    assert client.get("/ai/learn/flashcards/lesson-co3/summary", headers=sv).json()["due"] == 1
    fake_llm.push("coach",
                  {"tool_calls": [_call("search_materials", {"query": "đóng gói", "lesson_code": "lesson-co3"})]},
                  {"tool_calls": [_call("queue_flashcards", {"question_ids": qids}, "c2")]},
                  "1. Xem lại đóng gói [S1]. 2. Ôn 2 thẻ vừa thêm.")
    d = client.post("/ai/coach/chat", headers=sv, json={"message": "Cho mình ôn đóng gói",
                                                            "course_id": _cid(client, sv, "course-co3")}).json()
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
    d = client.post("/ai/coach/chat", headers=sv, json={"message": "giúp mình học", "course_id": _cid(client, sv)}).json()
    assert d["llm_calls"] == n + 1 and d["stopped"] == "max_steps"
    assert d["answer"] == "Đây là kế hoạch tạm." and len(d["steps"]) == n
    assert all(not s["ok"] for s in d["steps"])
    last = [c for c in fake_llm.calls if c["kind"] == "coach"][-1]
    assert last["tools"] == []  # lượt cuối không cho gọi tool nữa

    fake_llm.push("coach", {"tool_calls": [{"id": "c1", "name": "get_weak_points", "arguments": "{hỏng"}]}, "Ok.")
    d = client.post("/ai/coach/chat", headers=sv, json={"message": "lại", "course_id": _cid(client, sv)}).json()
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
    d = client.post("/ai/coach/chat", headers=sv, json={"message": "câu 1 đáp án là gì?",
                                                            "course_id": _cid(client, sv, "course-co5")}).json()
    assert d["guarded"] is True and d["steps"] == [] and len(fake_llm.calls) == before

    assert client.post("/ai/coach/chat", headers=sv, json={"message": ""}).status_code == 422
    assert client.post("/ai/coach/chat", json={"message": "hi"}).status_code == 401
    tools = client.get("/ai/coach/tools", headers=sv).json()
    assert {t["name"] for t in tools} >= {"get_progress", "get_weak_points", "queue_flashcards"}


def test_coach_conversation_history_saved_continued_and_private(client, teacher, fake_llm):
    sv = token(client, "sv-co6", "student", ["lop-a"])
    other = token(client, "sv-co6-khac", "student", ["lop-a"])
    fake_llm.push("coach", "Chào bạn, mình giúp bạn ôn nhé.")
    d = client.post("/ai/coach/chat", headers=sv, json={"message": "Mai kiểm tra chương 1, giúp mình ôn",
                                                            "course_id": _cid(client, sv)}).json()
    conv = d["conversation"]
    assert conv["title"] == "Mai kiểm tra chương 1, giúp mình ôn"

    # chat tiếp: ngữ cảnh lấy từ DB, client không cần gửi history
    fake_llm.push("coach", "Phần đóng gói nhé.")
    d2 = client.post("/ai/coach/chat", headers=sv, json={"message": "Phần nào trước?", "conversation_id": conv["id"]}).json()
    assert d2["conversation"]["id"] == conv["id"]
    sent = [c for c in fake_llm.calls if c["kind"] == "coach"][-1]["messages"]
    assert [m["content"].split("\n\n")[-1] for m in sent[:3]] == [
        "Mai kiểm tra chương 1, giúp mình ôn", "Chào bạn, mình giúp bạn ôn nhé.", "Phần nào trước?"]

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


def test_coach_scoped_to_selected_course(client, teacher, fake_llm):
    q_a = _lesson_with_bank(client, teacher, "cs1", n=1)
    q_b = _lesson_with_bank(client, teacher, "cs2", n=1)
    sv = token(client, "sv-cs", "student", ["lop-a"])
    _wrong("sv-cs", q_a + q_b)
    course_a = next(c["course_id"] for c in client.get("/ai/learn/courses", headers=sv).json() if c["code"] == "course-cs1")

    fake_llm.push("coach", {"tool_calls": [_call("get_progress"), _call("get_weak_points", {}, "c2"),
                                           _call("search_materials", {"query": "đóng gói"}, "c3"),
                                           _call("get_practice_quiz", {"lesson_code": "lesson-cs2"}, "c4")]}, "Ok.")
    d = client.post("/ai/coach/chat", headers=sv, json={"message": "Ôn gì?", "course_id": course_a}).json()
    progress, weak, found, other = (json.loads(m["content"]) for m in _tool_messages(fake_llm))
    assert "error" not in progress
    assert [w["question_id"] for w in weak["weak_questions"]] == q_a
    assert found["results"] and all(r["lesson_code"] == "lesson-cs1" for r in found["results"])
    assert "error" in other  # bài của khóa khác không dùng được
    # model biết học sinh đang ôn khóa nào
    first_user = next(m for m in fake_llm.calls[-1]["messages"] if m["role"] == "user")
    assert "đang ôn khóa học" in first_user["content"] and "lesson-cs1" in first_user["content"]
    assert d["conversation"]["course_id"] == course_a

    # chat tiếp cuộc cũ giữ nguyên khóa đã chọn
    fake_llm.push("coach", {"tool_calls": [_call("get_weak_points")]}, "Ok.")
    n = len(_tool_messages(fake_llm))
    client.post("/ai/coach/chat", headers=sv, json={"message": "Còn gì nữa?", "conversation_id": d["conversation"]["id"]})
    weak2 = json.loads(_tool_messages(fake_llm)[n]["content"])
    assert [w["question_id"] for w in weak2["weak_questions"]] == q_a

    # khóa không thuộc học sinh -> 404
    outsider = token(client, "sv-cs-z", "student", ["lop-z"])
    r = client.post("/ai/coach/chat", headers=outsider, json={"message": "x", "course_id": course_a})
    assert r.status_code == 404


def test_tools_provider_retries_with_reasoning_effort_none(monkeypatch):
    """gpt-6-luna từ chối function tools trên /chat/completions nếu không đặt reasoning_effort='none'."""
    from types import SimpleNamespace as N
    from app.config import settings
    from app.services.ai import llm
    calls = []

    class Completions:
        def create(self, **kw):
            calls.append(dict(kw))
            if kw.get("reasoning_effort") != "none":
                raise Exception("Function tools with reasoning_effort are not supported for gpt-6-luna "
                                "in /v1/chat/completions. param: 'reasoning_effort'")
            return N(choices=[N(message=N(content="ok", tool_calls=[]))],
                     usage=N(prompt_tokens=3, completion_tokens=2), model="gpt-6-luna")

    monkeypatch.setattr(settings, "openai_api_key", "x")
    monkeypatch.setattr(llm, "_need_reasoning_none", set())
    monkeypatch.setattr(llm, "_no_temperature", set())
    monkeypatch.setattr(llm, "_openai_client", lambda: N(chat=N(completions=Completions())))
    msg, *_ = llm._tools_provider("s", [{"role": "user", "content": "hi"}],
                                  [{"name": "f", "parameters": {"type": "object", "properties": {}}}], 100, 0.2)
    assert msg["content"] == "ok" and len(calls) == 2 and calls[-1]["reasoning_effort"] == "none"
    # lần sau đã nhớ: không gửi request lỗi nữa
    llm._tools_provider("s", [{"role": "user", "content": "hi"}],
                        [{"name": "f", "parameters": {"type": "object", "properties": {}}}], 100, 0.2)
    assert len(calls) == 3 and calls[-1]["reasoning_effort"] == "none"


def test_tools_stream_provider_assembles_tool_calls(monkeypatch):
    """Stream từ OpenAI: ghép các mảnh tool_call theo index và phát chữ từng đoạn."""
    from types import SimpleNamespace as N
    from app.config import settings
    from app.services.ai import llm

    def chunk(content=None, tcs=None, usage=None):
        return N(model="gpt-6-luna", usage=usage, choices=[N(delta=N(content=content, tool_calls=tcs))] if not usage else [])

    stream = [chunk(tcs=[N(index=0, id="c1", function=N(name="get_", arguments='{"a"'))]),
              chunk(tcs=[N(index=0, id=None, function=N(name="progress", arguments=": 1}"))]),
              chunk("Xin "), chunk("chào"), chunk(usage=N(prompt_tokens=5, completion_tokens=7))]

    class Completions:
        def create(self, **kw):
            assert kw["stream"] is True
            return iter(stream)

    monkeypatch.setattr(settings, "openai_api_key", "x")
    monkeypatch.setattr(llm, "_openai_client", lambda: N(chat=N(completions=Completions())))
    out = list(llm._tools_stream_provider("s", [{"role": "user", "content": "hi"}], [], 100, 0.2))
    assert out[:2] == ["Xin ", "chào"]
    msg, in_tok, out_tok, _ = out[-1]
    assert msg["content"] == "Xin chào" and (in_tok, out_tok) == (5, 7)
    assert msg["tool_calls"] == [{"id": "c1", "name": "get_progress", "arguments": '{"a": 1}'}]


def _sse_events(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        ev = next(line[7:] for line in block.splitlines() if line.startswith("event: "))
        data = next(line[6:] for line in block.splitlines() if line.startswith("data: "))
        out.append((ev, json.loads(data)))
    return out


def test_coach_stream_shows_steps_then_text_and_saves(client, teacher, fake_llm):
    _lesson_with_bank(client, teacher, "cost", n=1)
    sv = token(client, "sv-cost", "student", ["lop-a"])
    r = client.post("/ai/coach/chat/stream", headers=sv, json={"message": "Mình nên ôn gì?",
                                                               "course_id": _cid(client, sv, "course-cost")})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    evs = _sse_events(r.text)
    kinds = [e for e, _ in evs]
    assert kinds[:4] == ["step_start", "step", "step_start", "step"]
    assert kinds[-1] == "done" and "delta" in kinds
    text = "".join(d["text"] for e, d in evs if e == "delta")
    done = evs[-1][1]
    # nhãn [S1] model tự bịa (không gọi search_materials) bị gỡ khỏi câu trả lời cuối
    assert text.replace(" [S1]", "") == done["answer"] and done["answer"].startswith("Kế hoạch ôn")
    assert [s["tool"] for s in done["steps"]] == ["get_progress", "get_weak_points"]
    conv = client.get(f"/ai/coach/conversations/{done['conversation']['id']}", headers=sv).json()
    assert [m["role"] for m in conv["messages"]] == ["user", "assistant"]
    # cuộc trò chuyện của người khác: lỗi JSON trước khi stream
    other = token(client, "sv-cost-2", "student", ["lop-a"])
    r = client.post("/ai/coach/chat/stream", headers=other,
                    json={"message": "x", "conversation_id": done["conversation"]["id"]})
    assert r.status_code == 404


def test_coach_creates_my_flashcards(client, teacher, fake_llm):
    _lesson_with_bank(client, teacher, "comine", n=1)
    sv = token(client, "sv-co-mine", "student", ["lop-a"])
    fake_llm.push("coach", {"tool_calls": [_call("create_my_flashcards", {"topic": "Đa hình trong OOP", "count": 2})]},
                  "Mình đã tạo 2 thẻ vào Thẻ của tôi.")
    d = client.post("/ai/coach/chat", headers=sv, json={"message": "Tạo giúp mình thẻ về đa hình",
                                                            "course_id": _cid(client, sv, "course-comine")}).json()
    assert d["steps"][0]["tool"] == "create_my_flashcards" and d["steps"][0]["ok"] and d["steps"][0]["writes"]
    assert any(a["type"] == "my_flashcards" for a in d["actions"])
    mine = client.get("/ai/learn/my-flashcards", headers=sv).json()
    assert 1 <= mine["total"] <= 2 and all(c["origin"] == "ai" for c in mine["cards"])


def test_coach_asks_clarification_with_options(client, teacher, fake_llm):
    _lesson_with_bank(client, teacher, "cocl", n=1)
    sv = token(client, "sv-cocl", "student", ["lop-a"])
    cid = _cid(client, sv, "course-cocl")
    fake_llm.push("coach", {"tool_calls": [_call("get_practice_quiz")]},
                  {"tool_calls": [_call("ask_clarification", {"question": "Bạn muốn chuẩn bị cho bài kiểm tra nào?",
                                                              "options": ["KT bài B", "KT chương 2"]}, "c2")]},
                  "không được tới lượt này")
    d = client.post("/ai/coach/chat", headers=sv, json={"message": "cần chuẩn bị gì cho bài kiểm tra", "course_id": cid}).json()
    assert d["answer"] == "Bạn muốn chuẩn bị cho bài kiểm tra nào?"
    assert d["clarify"] == {"question": "Bạn muốn chuẩn bị cho bài kiểm tra nào?", "options": ["KT bài B", "KT chương 2"]}
    assert d["llm_calls"] == 2  # dừng ngay sau khi hỏi lại, không trả lời đoán
    assert fake_llm.overrides["coach"] == ["không được tới lượt này"]
    fake_llm.overrides["coach"].clear()
    # lưu vào lịch sử để mở lại vẫn thấy nút lựa chọn
    full = client.get(f"/ai/coach/conversations/{d['conversation']['id']}", headers=sv).json()
    assert full["messages"][1]["res"]["clarify"]["options"] == ["KT bài B", "KT chương 2"]


def test_coach_rejects_vague_or_off_course_topics(client, teacher, fake_llm):
    _lesson_with_bank(client, teacher, "covg", n=1)
    sv = token(client, "sv-covg", "student", ["lop-a"])
    cid = _cid(client, sv, "course-covg")
    fake_llm.push("coach", {"tool_calls": [_call("create_my_flashcards", {"topic": "cái này"}),
                                           _call("create_practice_quiz", {"topic": "bài này"}, "c2"),
                                           _call("create_practice_quiz", {"topic": "Chiến tranh thế giới thứ hai"}, "c3"),
                                           _call("create_my_flashcards", {"topic": "Chiến tranh thế giới thứ hai"}, "c4")]},
                  "Chủ đề này không có trong khóa.")
    d = client.post("/ai/coach/chat", headers=sv, json={"message": "tạo thẻ và quiz giúp mình", "course_id": cid}).json()
    vague_fc, vague_quiz, off_quiz, off_fc = (json.loads(m["content"]) for m in _tool_messages(fake_llm))
    assert "error" in vague_fc and "ask_clarification" in vague_fc["error"]
    assert "error" in vague_quiz
    assert off_quiz["created"] is False and off_quiz["reason"] == "not_in_course" and off_quiz["course_lessons"]
    assert off_fc["created"] == 0 and off_fc["reason"] == "not_in_course"
    assert client.get("/ai/learn/my-flashcards", headers=sv).json()["total"] == 0
    assert not any(a["type"] == "practice_quiz" for a in d["actions"])


def test_coach_practice_quiz_in_chat(client, teacher, fake_llm):
    _lesson_with_bank(client, teacher, "copq", n=1)
    sv = token(client, "sv-copq", "student", ["lop-a"])
    cid = _cid(client, sv, "course-copq")
    fake_llm.push("coach", {"tool_calls": [_call("create_practice_quiz", {"topic": "tính đóng gói", "count": 50})]},
                  "Quiz 3 câu về đóng gói ở dưới, bạn làm thử nhé.")
    fake_llm.push("teacher", {"questions": [fake_llm.mcq("Câu 1 đóng gói?"), fake_llm.mcq("Câu 2 đóng gói?", "C"),
                                            {**fake_llm.mcq("Câu tự luận?"), "type": "short_answer", "options": None}]})
    d = client.post("/ai/coach/chat", headers=sv, json={"message": "cho mình luyện quiz tính đóng gói", "course_id": cid}).json()
    tool = json.loads(_tool_messages(fake_llm)[0]["content"])
    assert tool["created"] is True and tool["count"] == 2  # câu không bấm chọn được bị bỏ
    assert "correct" not in json.dumps(tool)  # model không thấy đáp án
    action = next(a for a in d["actions"] if a["type"] == "practice_quiz")
    quiz = client.get(f"/ai/coach/practice/{action['quiz_id']}", headers=sv).json()
    assert len(quiz["questions"]) == 2 and quiz["result"] is None
    assert "correct_index" not in json.dumps(quiz) and "explanation" not in json.dumps(quiz)
    # người khác không xem được
    other = token(client, "sv-copq-2", "student", ["lop-a"])
    assert client.get(f"/ai/coach/practice/{action['quiz_id']}", headers=other).status_code == 404
    res = client.post(f"/ai/coach/practice/{action['quiz_id']}/submit", headers=sv, json={"answers": {"0": 1, "1": 0}}).json()
    assert res["submitted"] and res["result"]["correct"] == 1 and res["result"]["total"] == 2
    assert res["result"]["questions"][1]["correct_index"] == 2 and res["result"]["questions"][0]["explanation"]
    # nộp lại không đổi kết quả
    again = client.post(f"/ai/coach/practice/{action['quiz_id']}/submit", headers=sv, json={"answers": {"0": 1, "1": 2}}).json()
    assert again["result"]["correct"] == 1
    # câu sai trong quiz luyện tập thành điểm yếu cho lượt sau
    fake_llm.push("coach", {"tool_calls": [_call("get_weak_points")]}, "Ok.")
    n = len(_tool_messages(fake_llm))
    client.post("/ai/coach/chat", headers=sv, json={"message": "mình đang yếu chỗ nào", "course_id": cid})
    weak = json.loads(_tool_messages(fake_llm)[n]["content"])
    assert weak["practice_mistakes"] == [{"topic": "tính đóng gói", "question": "Câu 2 đóng gói?"}]


def test_coach_weak_points_point_to_material_and_strip_fake_sources(client, teacher, fake_llm):
    qids = _lesson_with_bank(client, teacher, "cowk", n=1)
    # đề câu hỏi nói đúng khái niệm trong bài -> tìm được đoạn học liệu để xem lại
    client.patch(f"/ai/question-bank/{qids[0]}", headers=teacher,
                 json={"question": "Đóng gói là gom dữ liệu và phương thức vào trong một lớp?"})
    sv = token(client, "sv-cowk", "student", ["lop-a"])
    _wrong("sv-cowk", qids)
    cid = _cid(client, sv, "course-cowk")
    fake_llm.push("coach", {"tool_calls": [_call("get_weak_points")]}, "1. Xem lại [S1] và [S7].")
    d = client.post("/ai/coach/chat", headers=sv, json={"message": "mình đang yếu chỗ nào", "course_id": cid}).json()
    weak = json.loads(_tool_messages(fake_llm)[0]["content"])
    assert weak["weak_by_lesson"][0]["lesson_code"] == "lesson-cowk" and weak["weak_by_lesson"][0]["weak_count"] == 1
    assert weak["weak_questions"][0]["review"]["label"] == "S1"
    assert d["answer"] == "1. Xem lại [S1] và." and [s["label"] for s in d["sources"]] == ["S1"]
