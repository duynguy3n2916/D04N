"""Hybrid search (vector + từ khóa, RRF), rerank cross-encoder, viết lại câu hỏi nối tiếp, streaming Tutor."""
import json
from types import SimpleNamespace

from app.config import settings
from app.services import hybrid, learning
from app.services.retrieval import RetrievalScope, retrieve
from tests.conftest import token
from tests.test_api_core import upload

DOC = (
    "# Mẫu thiết kế Singleton\n\nSingleton đảm bảo một lớp chỉ có duy nhất một thể hiện và cung cấp điểm truy cập toàn cục "
    "tới thể hiện đó. Hàm khởi tạo được khai báo private.\n\n"
    "# Mẫu thiết kế Observer\n\nObserver định nghĩa quan hệ một-nhiều: khi đối tượng chủ thay đổi trạng thái, "
    "mọi đối tượng quan sát được thông báo và cập nhật tự động.\n"
)


def _parse_sse(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        out.append((lines["event"], json.loads(lines["data"])))
    return out


def test_hybrid_helpers():
    terms = hybrid.query_terms("Mẫu Singleton là gì vậy?")
    assert "là" not in terms and "gì" not in terms and "singleton" in terms
    assert hybrid.tsquery_text(["a1", "b'; drop", "singleton"]) == "a1 | singleton"
    assert hybrid.lexical_accept(["singleton", "thể", "hiện"], "Singleton có một thể hiện duy nhất")
    assert not hybrid.lexical_accept(["singleton", "observer", "factory", "builder"], "Observer thông báo")
    fused = hybrid.rrf([["a", "b"], ["b", "c"]])
    assert max(fused, key=fused.get) == "b"


def test_hybrid_search_finds_keyword_match(client, teacher, monkeypatch):
    upload(client, teacher, "mau-thiet-ke.md", DOC, lesson_id="lesson-hybrid", class_id="lop-a")
    from app.database import SessionLocal
    db = SessionLocal()
    try:
        scope = RetrievalScope(allowed_class_ids=None, lesson_id="lesson-hybrid")
        # ngưỡng cosine rất cao: chỉ tìm vector thì không còn gì, hybrid vẫn tìm ra nhờ khớp từ khóa
        dense_only = retrieve(db, "mẫu singleton thể hiện duy nhất", scope, top_k=3, min_score=0.99, hybrid=False)
        both = retrieve(db, "mẫu singleton thể hiện duy nhất", scope, top_k=3, min_score=0.99, hybrid=True)
        assert dense_only == []
        assert both and both[0]["lexical_match"] and "Singleton" in both[0]["content"]
        # câu không liên quan: từ khóa không đủ phủ -> vẫn rỗng (giữ được cơ chế từ chối)
        assert retrieve(db, "công thức nấu phở bò", scope, top_k=3, min_score=0.99, hybrid=True) == []

        # rerank: cross-encoder (giả lập) đảo thứ tự theo điểm của nó
        class Stub:
            def predict(self, pairs):
                return [10.0 if "Observer" in c else 0.0 for _, c in pairs]
        monkeypatch.setattr(settings, "rag_rerank", "cross_encoder")
        monkeypatch.setattr(hybrid, "_reranker", Stub())
        ranked = retrieve(db, "mẫu thiết kế", scope, top_k=2, min_score=0.0)
        assert "Observer" in ranked[0]["content"] and ranked[0]["rerank_score"] == 10.0
    finally:
        db.close()


def test_chat_stream_events_and_persistence(client, teacher, fake_llm):
    upload(client, teacher, "stream.md", DOC, lesson_id="lesson-stream", class_id="lop-a")
    sv = token(client, "sv-stream", "student", ["lop-a"])
    r = client.post("/ai/chat/stream", headers=sv, json={"question": "Singleton là gì?", "lesson_id": "lesson-stream"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    events = _parse_sse(r.text)
    kinds = [e for e, _ in events]
    assert kinds[0] == "meta" and kinds[-1] == "done" and kinds.count("delta") >= 2
    streamed = "".join(d["text"] for e, d in events if e == "delta")
    done = events[-1][1]
    assert streamed.strip() == done["answer"] and done["sources"]
    msgs = client.get(f"/ai/conversations/{done['conversation_id']}", headers=sv).json()["messages"]
    assert msgs[-1]["content"] == done["answer"] and msgs[-1]["meta"]["llm_call_ids"]

    # không có học liệu -> từ chối, không gọi LLM, không có delta
    n = len(fake_llm.calls)
    events = _parse_sse(client.post("/ai/chat/stream", headers=sv,
                                    json={"question": "zzzz qqqq", "lesson_id": "lesson-stream"}).text)
    assert [e for e, _ in events] == ["meta", "done"] and events[-1][1]["refused"] and len(fake_llm.calls) == n


def test_chat_stream_hint_mode_buffers_and_redacts(client, teacher, fake_llm, monkeypatch):
    upload(client, teacher, "stream-hint.md", DOC, lesson_id="lesson-stream-hint", class_id="lop-a")
    q = SimpleNamespace(type="multiple_choice", question="Singleton đảm bảo điều gì?",
                        options=["A. Nhiều thể hiện", "B. Chỉ có duy nhất một thể hiện của lớp", "C. x", "D. y"],
                        correct_index=1, answer="B", explanation="")
    monkeypatch.setattr(learning, "active_quiz_questions", lambda db, user: [q])
    sv = token(client, "sv-stream-hint", "student", ["lop-a"])
    fake_llm.push("hint", "Đáp án là B. Chỉ có duy nhất một thể hiện của lớp")
    events = _parse_sse(client.post("/ai/chat/stream", headers=sv,
                                    json={"question": "Singleton là gì?", "lesson_id": "lesson-stream-hint"}).text)
    # hint mode: không phát từng phần (chưa kiểm tra được lộ đáp án), chỉ gửi bản đã qua guardrail
    assert "delta" not in [e for e, _ in events]
    done = events[-1][1]
    assert done["hint_mode"] and done["redacted"] and "Chỉ có duy nhất" not in done["answer"]


def test_chat_stream_quota_error_is_json(client, teacher, fake_llm, monkeypatch):
    monkeypatch.setattr(settings, "tutor_daily_limit_per_lesson", 1)
    sv = token(client, "sv-stream-quota", "student", ["lop-a"])
    body = {"question": "Singleton là gì?", "lesson_id": "lesson-stream"}
    assert client.post("/ai/chat/stream", headers=sv, json=body).status_code == 200
    r = client.post("/ai/chat/stream", headers=sv, json=body)
    assert r.status_code == 429 and r.json()["error"]["code"] == "TUTOR_QUOTA_EXCEEDED"
