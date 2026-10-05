"""Auth, học liệu, RAG, Tutor, Teacher AI, LLM gateway."""
import io

from sqlalchemy import func

from app.database import SessionLocal
from app.models.observability import AILLMCall
from tests.conftest import LESSON_TEXT, token


def upload(client, headers, name, content, **form):
    return client.post("/ai/documents/index", headers=headers,
                       files={"file": (name, io.BytesIO(content.encode()), "text/plain")}, data=form)


def test_health_and_auth(client):
    assert client.get("/health").json()["database"] is True
    r = client.get("/ai/documents")
    assert r.status_code == 401 and r.json()["error"]["code"] == "UNAUTHORIZED"
    assert "request_id" in r.json() and r.headers.get("X-Request-ID")
    student = token(client, "sv-auth", "student", ["lop-a"])
    r = client.post("/ai/teacher/generate-quiz", headers=student, json={"count": 1})
    assert r.status_code == 403
    assert client.get("/ai/auth/me", headers=student).json()["role"] == "student"
    bad = {"Authorization": "Bearer abc.def.ghi"}
    assert client.get("/ai/auth/me", headers=bad).status_code == 401


def test_upload_index_duplicate_scope_delete(client, teacher):
    r = upload(client, teacher, "bai-dong-goi.md", LESSON_TEXT, lesson_id="lesson-core", class_id="lop-a")
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["job_status"] == "succeeded"
    doc_id = body["document_id"]
    job = client.get(f"/ai/jobs/{body['job_id']}", headers=teacher).json()
    assert job["status"] == "succeeded" and job["result"]["chunks"] >= 1
    d = client.get(f"/ai/documents/{doc_id}", headers=teacher).json()
    assert d["status"] == "ready" and d["chunks"] >= 1

    dup = upload(client, teacher, "copy.md", LESSON_TEXT, lesson_id="lesson-core", class_id="lop-a")
    assert dup.status_code == 200 and dup.json()["duplicate"] is True

    # tài liệu lớp A: học sinh lớp B không thấy, không truy xuất được
    sv_b = token(client, "sv-b", "student", ["lop-b"])
    ids = [x["document_id"] for x in client.get("/ai/documents", headers=sv_b).json()]
    assert doc_id not in ids
    assert client.get(f"/ai/documents/{doc_id}", headers=sv_b).status_code == 404
    # giáo viên không thuộc lớp không upload được vào lớp đó
    other = token(client, "gv-2", "teacher", ["lop-z"])
    assert upload(client, other, "x.md", "Nội dung bất kỳ đủ dài cho test.", class_id="lop-a").status_code == 403

    # file không hỗ trợ
    r = client.post("/ai/documents/index", headers=teacher, files={"file": ("a.exe", io.BytesIO(b"MZ"), "x")})
    assert r.status_code == 400 and r.json()["error"]["code"] == "UNSUPPORTED_FILE"

    # xóa mềm
    tmp = upload(client, teacher, "tam.md", "# Tạm\n\nTài liệu tạm thời để xóa trong test.", lesson_id="tmp")
    tid = tmp.json()["document_id"]
    assert client.delete(f"/ai/documents/{tid}", headers=teacher).json()["status"] == "deleted"
    assert tid not in [x["document_id"] for x in client.get("/ai/documents", headers=teacher).json()]


def test_lesson_text_index_and_versioning(client, teacher):
    r = client.post("/ai/lessons/lesson-ver/index", headers=teacher,
                    json={"title": "Bài phiên bản", "content": "# A\n\nNội dung phiên bản một của bài học."})
    assert r.status_code == 202
    v1 = r.json()["document_id"]
    r = client.post("/ai/lessons/lesson-ver/index", headers=teacher,
                    json={"title": "Bài phiên bản", "content": "# A\n\nNội dung phiên bản hai đã được sửa."})
    v2 = r.json()
    assert v2["version"] == 2
    active = [x["document_id"] for x in client.get("/ai/documents?lesson_id=lesson-ver", headers=teacher).json()]
    assert active == [v2["document_id"]] and v1 not in active


def test_chat_grounded_refusal_and_history(client, teacher, fake_llm):
    student = token(client, "sv-chat", "student", ["lop-a"])
    r = client.post("/ai/chat", headers=student, json={"question": "Đóng gói là gì?", "lesson_id": "lesson-core"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["hint_mode"] is False and body["sources"] and body["sources"][0]["label"] == "S1"
    assert "<tai_lieu>" in fake_llm.calls[-1]["user"]
    conv = body["conversation_id"]

    r = client.post("/ai/chat", headers=student, json={"question": "Còn kế thừa thì sao?", "conversation_id": conv})
    assert len(fake_llm.calls[-1]["messages"]) == 3  # lịch sử 1 lượt + câu mới

    # không có học liệu phù hợp -> từ chối, không gọi LLM
    n = len(fake_llm.calls)
    r = client.post("/ai/chat", headers=student, json={"question": "zzzz qqqq xxxx", "conversation_id": conv})
    assert r.json()["refused"] is True and len(fake_llm.calls) == n

    # người khác không đọc được hội thoại
    other = token(client, "sv-other", "student", ["lop-a"])
    assert client.get(f"/ai/conversations/{conv}", headers=other).status_code == 403
    assert len(client.get(f"/ai/conversations/{conv}", headers=student).json()["messages"]) == 6


def test_teacher_quiz_bank_edit_approve_stats(client, teacher, fake_llm):
    r = client.post("/ai/teacher/generate-quiz", headers=teacher,
                    json={"lesson_id": "lesson-core", "count": 3, "question_types": ["multiple_choice"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["generated"] == 3 and all(q["status"] == "draft" for q in body["questions"])
    assert body["questions"][0]["correct_index"] == 1
    item = body["questions"][0]["item_id"]

    r = client.patch(f"/ai/question-bank/{item}", headers=teacher,
                     json={"question": "Câu hỏi đã sửa về đóng gói?", "status": "approved"})
    assert r.json()["edited"] is True and r.json()["status"] == "approved"
    r = client.patch(f"/ai/question-bank/{body['questions'][1]['item_id']}", headers=teacher, json={"status": "rejected"})
    assert r.json()["status"] == "rejected"
    # sửa sai schema -> 422
    r = client.patch(f"/ai/question-bank/{body['questions'][2]['item_id']}", headers=teacher,
                     json={"options": ["A. x", "B. y", "C. z"]})
    assert r.status_code == 422
    stats = client.get("/ai/teacher/stats", headers=teacher).json()
    assert stats["approved"] >= 1 and stats["rejected"] >= 1 and stats["acceptance_rate"] is not None


def test_teacher_quiz_fills_missing_questions(client, teacher, fake_llm):
    fake_llm.push("teacher", {"questions": [fake_llm.mcq("Chỉ một câu?")]})
    r = client.post("/ai/teacher/generate-quiz", headers=teacher, json={"lesson_id": "lesson-core", "count": 3})
    assert r.json()["generated"] == 3


def test_llm_gateway_retries_invalid_json_and_logs(client, teacher, fake_llm):
    fake_llm.push("teacher", "không phải json", {"questions": [fake_llm.mcq("Câu sau khi sửa?")]})
    r = client.post("/ai/questions/generate", headers=teacher, json={"lesson_id": "lesson-core"})
    assert r.status_code == 200, r.text
    rid = r.headers["X-Request-ID"]
    db = SessionLocal()
    try:
        statuses = [s for (s,) in db.query(AILLMCall.status).filter(AILLMCall.correlation_id == rid).all()]
        assert sorted(statuses) == ["invalid_output", "ok"]
        assert db.query(func.sum(AILLMCall.input_tokens)).filter(AILLMCall.correlation_id == rid).scalar() == 200
    finally:
        db.close()
    # LLM lỗi hẳn -> 502 với mã lỗi rõ ràng
    fake_llm.push("teacher", RuntimeError("boom"))
    r = client.post("/ai/questions/generate", headers=teacher, json={"lesson_id": "lesson-core"})
    assert r.status_code == 502 and r.json()["error"]["code"] == "LLM_ERROR"


def test_admin_llm_stats(client, admin, teacher):
    assert client.get("/ai/admin/llm-stats", headers=teacher).status_code == 403
    tasks = {t["task"] for t in client.get("/ai/admin/llm-stats", headers=admin).json()["tasks"]}
    assert "teacher_quiz" in tasks
