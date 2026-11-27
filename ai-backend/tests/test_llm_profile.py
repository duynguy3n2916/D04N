"""Mức suy luận / độ dài trả lời theo loại tác vụ (LLM_REASONING_* / LLM_VERBOSITY_* trong .env)."""
from types import SimpleNamespace as N

from app.config import settings
from app.services.ai import llm


def test_task_profile_chat_vs_background(monkeypatch):
    monkeypatch.setattr(settings, "llm_reasoning_chat", "none")
    monkeypatch.setattr(settings, "llm_verbosity_chat", "low")
    monkeypatch.setattr(settings, "llm_reasoning_background", "medium")
    monkeypatch.setattr(settings, "llm_verbosity_background", "")
    assert llm.task_profile("tutor") == {"reasoning_effort": "none", "verbosity": "low"}
    assert llm.task_profile("coach") == {"reasoning_effort": "none", "verbosity": "low"}
    assert llm.task_profile("teacher_quiz") == {"reasoning_effort": "medium"}  # trống = không gửi


def test_chat_model_gets_profile_and_extra_tokens(monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "x")
    monkeypatch.setattr(settings, "llm_reasoning_extra_tokens", 1000)
    monkeypatch.setattr(llm, "_unsupported", {})
    m = llm.chat_model(max_tokens=500, profile={"reasoning_effort": "medium", "verbosity": "medium"})
    assert (m.reasoning_effort, m.verbosity, m.max_tokens) == ("medium", "medium", 1500)
    m = llm.chat_model(max_tokens=500, profile={"reasoning_effort": "none", "verbosity": "low"})
    assert (m.reasoning_effort, m.verbosity, m.max_tokens) == ("none", "low", 500)


def test_rejected_params_are_dropped_and_remembered(monkeypatch):
    """Model cũ (vd. gpt-4o-mini) không nhận reasoning_effort / verbosity: bỏ đi, gọi lại, lần sau không gửi nữa."""
    calls = []

    class Completions:
        def create(self, **kw):
            calls.append(dict(kw))
            for k in ("reasoning_effort", "verbosity"):
                if k in kw:
                    raise Exception(f"Unrecognized request argument supplied: {k}")
            return N(choices=[N(message=N(content="ok", tool_calls=[]))],
                     usage=N(prompt_tokens=1, completion_tokens=1), model="m")

    monkeypatch.setattr(settings, "openai_api_key", "x")
    monkeypatch.setattr(llm, "_unsupported", {})
    monkeypatch.setattr(llm, "_need_reasoning_none", set())
    monkeypatch.setattr(llm, "_no_temperature", set())
    monkeypatch.setattr(llm, "_openai_client", lambda: N(chat=N(completions=Completions())))
    profile = {"reasoning_effort": "none", "verbosity": "low"}
    msg, *_ = llm._tools_provider("s", [{"role": "user", "content": "hi"}], [], 100, 0.2, profile)
    assert msg["content"] == "ok" and "reasoning_effort" not in calls[-1] and "verbosity" not in calls[-1]
    n = len(calls)
    llm._tools_provider("s", [{"role": "user", "content": "hi"}], [], 100, 0.2, profile)
    assert len(calls) == n + 1  # đã nhớ: một request, không thử lại


def test_gateway_passes_task_profile(client, teacher, fake_llm):
    from tests.conftest import token
    from tests.test_flashcards import _lesson_with_bank
    _lesson_with_bank(client, teacher, "prof", n=1)
    sv = token(client, "sv-prof", "student", ["lop-a"])
    assert client.post("/ai/coach/chat", headers=sv, json={"message": "ôn gì?", "course_id": next(
        c["course_id"] for c in client.get("/ai/learn/courses", headers=sv).json() if c["code"] == "course-prof")}).status_code == 200
    assert fake_llm.calls[-1]["profile"] == llm.task_profile("coach")
