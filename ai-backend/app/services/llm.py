"""LLM Gateway: điểm duy nhất gọi model.

- Chọn provider (Claude / OpenAI) theo cấu hình, timeout + retry của SDK.
- Gắn prompt_id/version, ghi nhật ký ai_llm_calls (token, latency, chi phí, correlation_id).
- complete_json: parse + validate bằng Pydantic, tự sửa 1 lần nếu model trả JSON sai schema.
"""
import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from app.config import settings
from app.core.context import get_request_id
from app.core.errors import AppError
from app.core.llm_schemas import schema_hint
from app.core.prompts import Prompt

log = logging.getLogger("app.llm")
T = TypeVar("T", bound=BaseModel)

_clients: dict = {}
_client_lock = threading.Lock()


class LLMError(AppError):
    def __init__(self, message: str):
        super().__init__(502, "LLM_ERROR", message)


@dataclass
class LLMResult:
    text: str
    model: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    latency_ms: float = 0.0
    call_ids: list[str] = field(default_factory=list)
    prompt_id: str = ""
    prompt_version: str = ""


# ----------------------------------------------------------------------------
# Provider adapters
# ----------------------------------------------------------------------------

def _anthropic_client():
    with _client_lock:
        if "anthropic" not in _clients:
            import anthropic
            kwargs = {"api_key": settings.claude_api_key, "timeout": settings.llm_timeout_seconds, "max_retries": 2}
            if settings.claude_base_url:
                kwargs["base_url"] = settings.claude_base_url
            _clients["anthropic"] = anthropic.Anthropic(**kwargs)
        return _clients["anthropic"]


def _openai_client():
    with _client_lock:
        if "openai" not in _clients:
            from openai import OpenAI
            _clients["openai"] = OpenAI(api_key=settings.openai_api_key, timeout=settings.llm_timeout_seconds, max_retries=2)
        return _clients["openai"]


def _call_provider(system: str, messages: list[dict], max_tokens: int, json_mode: bool,
                   temperature: float) -> tuple[str, int | None, int | None, str]:
    """Gọi model. Trả về (text, input_tokens, output_tokens, model). Test có thể thay hàm này."""
    provider = settings.llm_provider.lower()
    if provider == "claude":
        if not settings.claude_api_key:
            raise LLMError("Chưa cấu hình CLAUDE_API_KEY.")
        resp = _anthropic_client().messages.create(
            model=settings.claude_llm_model,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
            temperature=temperature,
        )
        text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")
        usage = getattr(resp, "usage", None)
        return (text, getattr(usage, "input_tokens", None), getattr(usage, "output_tokens", None),
                getattr(resp, "model", settings.claude_llm_model))
    if provider == "openai":
        if not settings.openai_api_key:
            raise LLMError("Chưa cấu hình OPENAI_API_KEY.")
        kwargs = {"model": settings.openai_llm_model,
                  "messages": [{"role": "system", "content": system}] + messages,
                  # max_completion_tokens dùng được cho cả gpt-4o / gpt-4.1 lẫn các model suy luận (o*, gpt-5)
                  "max_completion_tokens": max_tokens, "temperature": temperature}
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            resp = _openai_client().chat.completions.create(**kwargs)
        except Exception as e:  # một số model chỉ nhận temperature mặc định -> gọi lại không kèm temperature
            if "temperature" not in str(e):
                raise
            kwargs.pop("temperature")
            resp = _openai_client().chat.completions.create(**kwargs)
        usage = getattr(resp, "usage", None)
        return (resp.choices[0].message.content or "", getattr(usage, "prompt_tokens", None),
                getattr(usage, "completion_tokens", None), getattr(resp, "model", settings.openai_llm_model))
    raise LLMError(f"LLM_PROVIDER không hỗ trợ: {settings.llm_provider}")


# ----------------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------------

def _estimate_cost(in_tok: int | None, out_tok: int | None) -> float | None:
    if not (settings.llm_price_input_per_mtok or settings.llm_price_output_per_mtok):
        return None
    return round(((in_tok or 0) * settings.llm_price_input_per_mtok
                  + (out_tok or 0) * settings.llm_price_output_per_mtok) / 1_000_000, 6)


def _log_call(**fields) -> str | None:
    from app.database import SessionLocal
    from app.models.observability import AILLMCall
    db = SessionLocal()
    try:
        row = AILLMCall(**fields)
        db.add(row)
        db.commit()
        return str(row.id)
    except Exception:  # nhật ký không được làm hỏng nghiệp vụ
        db.rollback()
        log.exception("llm_log_failed")
        return None
    finally:
        db.close()


def _invoke(task: str, prompt: Prompt, messages: list[dict], *, max_tokens: int, json_mode: bool,
            temperature: float, chunk_ids: list[str] | None, user_id: str | None, attempt: int,
            system_suffix: str = "") -> LLMResult:
    system = prompt.system + (("\n\n" + system_suffix) if system_suffix else "")
    t0 = time.perf_counter()
    base = dict(task=task, prompt_id=prompt.id, prompt_version=prompt.version, provider=settings.llm_provider,
                correlation_id=get_request_id(), chunk_ids=chunk_ids or None, user_id=user_id, attempt=attempt)
    try:
        text, in_tok, out_tok, model = _call_provider(system, messages, max_tokens, json_mode, temperature)
    except LLMError as e:
        _log_call(**base, model=settings.current_llm_model(), status="error", error=str(e.detail),
                  latency_ms=(time.perf_counter() - t0) * 1000)
        raise
    except Exception as e:
        latency = (time.perf_counter() - t0) * 1000
        _log_call(**base, model=settings.current_llm_model(), status="error", error=f"{type(e).__name__}: {e}"[:2000],
                  latency_ms=latency)
        log.warning("llm_call_failed", extra={"extra_fields": {"task": task, "error": str(e)[:300]}})
        raise LLMError(f"Gọi LLM thất bại ({settings.llm_provider}): {type(e).__name__}: {str(e)[:300]}")
    latency = (time.perf_counter() - t0) * 1000
    call_id = _log_call(**base, model=model, status="ok", input_tokens=in_tok, output_tokens=out_tok,
                        latency_ms=latency, cost_usd=_estimate_cost(in_tok, out_tok))
    return LLMResult(text=text, model=model, input_tokens=in_tok, output_tokens=out_tok, latency_ms=latency,
                     call_ids=[call_id] if call_id else [], prompt_id=prompt.id, prompt_version=prompt.version)


def complete_text(task: str, prompt: Prompt, user_content: str, *, history: list[dict] | None = None,
                  max_tokens: int = 1500, temperature: float = 0.2, chunk_ids: list[str] | None = None,
                  user_id: str | None = None) -> LLMResult:
    messages = _normalize_history(history or []) + [{"role": "user", "content": user_content}]
    return _invoke(task, prompt, messages, max_tokens=max_tokens, json_mode=False, temperature=temperature,
                   chunk_ids=chunk_ids, user_id=user_id, attempt=1)


def complete_json(task: str, prompt: Prompt, user_content: str, schema: type[T], *, max_tokens: int = 4000,
                  temperature: float = 0.3, chunk_ids: list[str] | None = None, user_id: str | None = None,
                  retries: int = 1) -> tuple[T, LLMResult]:
    hint = schema_hint(schema)
    messages = [{"role": "user", "content": user_content}]
    last_error = ""
    total = LLMResult(text="", model="")
    for attempt in range(1, retries + 2):
        res = _invoke(task, prompt, messages, max_tokens=max_tokens, json_mode=True, temperature=temperature,
                      chunk_ids=chunk_ids, user_id=user_id, attempt=attempt, system_suffix=hint)
        total.call_ids += res.call_ids
        total.latency_ms += res.latency_ms
        total.model, total.prompt_id, total.prompt_version, total.text = res.model, res.prompt_id, res.prompt_version, res.text
        try:
            data = json.loads(extract_json(res.text))
            return schema.model_validate(data), total
        except (json.JSONDecodeError, ValidationError, ValueError) as e:
            last_error = _short_error(e)
            _mark_invalid(res.call_ids, last_error)
            messages = messages + [
                {"role": "assistant", "content": res.text[:6000]},
                {"role": "user", "content": f"JSON vừa trả về không hợp lệ: {last_error}. "
                                            f"Hãy trả lại DUY NHẤT JSON đúng schema, sửa các lỗi trên."},
            ]
    raise LLMError(f"Model trả về dữ liệu không đúng định dạng sau {retries + 1} lần: {last_error}")


def _mark_invalid(call_ids: list[str], error: str) -> None:
    if not call_ids:
        return
    from app.database import SessionLocal
    from app.models.observability import AILLMCall
    db = SessionLocal()
    try:
        db.query(AILLMCall).filter(AILLMCall.id.in_(call_ids)).update(
            {"status": "invalid_output", "error": error[:2000]}, synchronize_session=False)
        db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()


def _short_error(e: Exception) -> str:
    if isinstance(e, ValidationError):
        return "; ".join(f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}" for err in e.errors()[:6])
    return str(e)[:500]


def _normalize_history(history: list[dict]) -> list[dict]:
    """Anthropic yêu cầu lượt user/assistant xen kẽ và bắt đầu bằng user."""
    out: list[dict] = []
    for m in history:
        role = m.get("role")
        if role not in ("user", "assistant") or not m.get("content"):
            continue
        if out and out[-1]["role"] == role:
            out[-1] = {"role": role, "content": out[-1]["content"] + "\n\n" + m["content"]}
        else:
            out.append({"role": role, "content": m["content"]})
    while out and out[0]["role"] != "user":
        out.pop(0)
    if out and out[-1]["role"] == "user":  # lượt cuối sẽ là câu hỏi mới
        out.pop()
    return out


def extract_json(text: str) -> str:
    """Gỡ ```json fence và chữ thừa, lấy khối JSON ngoài cùng."""
    t = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", t, re.DOTALL)
    if fence:
        t = fence.group(1).strip()
    if t.startswith("{") or t.startswith("["):
        return t
    start, end = t.find("{"), t.rfind("}")
    if start != -1 and end > start:
        return t[start: end + 1]
    return t
