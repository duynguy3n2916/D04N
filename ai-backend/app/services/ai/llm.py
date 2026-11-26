"""LLM Gateway: điểm duy nhất gọi model.

- Gọi model qua LangChain `ChatOpenAI` (timeout + retry), stream có usage token.
- Gắn prompt_id/version, ghi nhật ký ai_llm_calls (token, latency, chi phí, correlation_id).
- complete_json: parse + validate bằng Pydantic, tự sửa 1 lần nếu model trả JSON sai schema.
"""
import json
import logging
import re
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from app.config import settings
from app.core.context import get_request_id
from app.core.errors import AppError
from app.services.ai.prompts import Prompt
from app.services.ai.schemas import schema_hint

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

def _openai_client():
    """Client OpenAI SDK gốc (giữ lại cho mã chưa chuyển sang LangChain)."""
    with _client_lock:
        if "openai" not in _clients:
            from openai import OpenAI
            _clients["openai"] = OpenAI(api_key=settings.openai_api_key, timeout=settings.llm_timeout_seconds, max_retries=2)
        return _clients["openai"]


# Tham số model không nhận, học được từ lỗi lần trước (theo tên model) -> các lần sau không gửi nữa,
# tránh mỗi lượt gọi đều mất một request lỗi rồi mới gọi lại.
_no_temperature: set[str] = set()
_need_reasoning_none: set[str] = set()
_unsupported: dict[str, set[str]] = {}  # model -> {"reasoning_effort", "verbosity"} model không nhận

# Tác vụ người dùng đang chờ trên màn hình (chat, gợi ý, chấm câu trả lời ngắn): ưu tiên nhanh.
# Mọi tác vụ khác (sinh câu hỏi, flashcard, đánh giá, tóm tắt...) chạy nền: cho model suy nghĩ kỹ hơn.
CHAT_TASKS = frozenset({"tutor", "tutor_explain", "coach", "agent_question", "grade", "forum_draft"})


def task_profile(task: str) -> dict:
    """reasoning_effort / verbosity theo loại tác vụ, đọc từ .env (LLM_REASONING_CHAT, LLM_VERBOSITY_BACKGROUND...).
    Giá trị rỗng = không gửi tham số (dùng mặc định của model)."""
    chat = task in CHAT_TASKS
    out = {"reasoning_effort": settings.llm_reasoning_chat if chat else settings.llm_reasoning_background,
           "verbosity": settings.llm_verbosity_chat if chat else settings.llm_verbosity_background}
    return {k: v.strip().lower() for k, v in out.items() if v and v.strip()}


def _apply_profile(kwargs: dict, profile: dict | None, max_tokens_key: str) -> dict:
    """Gắn reasoning_effort / verbosity (bỏ tham số model đã báo không nhận). Có suy luận thì cộng thêm token:
    với model suy luận, max_tokens tính cả token suy nghĩ, thiếu thì câu trả lời bị cắt cụt hoặc rỗng."""
    skip = _unsupported.get(settings.openai_llm_model, set())
    for k, v in (profile or {}).items():
        if k not in skip:
            kwargs[k] = v
    if kwargs.get("reasoning_effort") not in (None, "none"):
        kwargs[max_tokens_key] = kwargs[max_tokens_key] + settings.llm_reasoning_extra_tokens
    return kwargs


def _rejected_param(err: str, kwargs: dict) -> str | None:
    """Tham số nào trong kwargs bị model từ chối (đọc từ thông báo lỗi), để bỏ đi rồi gọi lại."""
    for k in ("temperature", "verbosity", "reasoning_effort"):
        if k in err and kwargs.get(k) is not None:
            return k
    return None


def _forget(param: str) -> None:
    model = settings.openai_llm_model
    if param == "temperature":
        _no_temperature.add(model)
    else:
        _unsupported.setdefault(model, set()).add(param)


def chat_model(*, max_tokens: int = 1500, temperature: float | None = 0.2, json_mode: bool = False,
               streaming: bool = False, profile: dict | None = None):
    """LangChain chat model theo cấu hình. temperature=None: dùng mặc định của model (model suy luận o*, gpt-5)."""
    if not settings.openai_api_key:
        raise LLMError("Chưa cấu hình OPENAI_API_KEY.")
    from langchain_openai import ChatOpenAI
    if settings.openai_llm_model in _no_temperature:
        temperature = None
    kwargs = dict(model=settings.openai_llm_model, api_key=settings.openai_api_key,
                  timeout=settings.llm_timeout_seconds, max_retries=2,
                  # ChatOpenAI gửi max_tokens dưới tên max_completion_tokens (dùng được cho cả model suy luận)
                  max_tokens=max_tokens, temperature=temperature)
    if json_mode:
        kwargs["model_kwargs"] = {"response_format": {"type": "json_object"}}
    if streaming:
        kwargs["stream_usage"] = True
    return ChatOpenAI(**_apply_profile(kwargs, profile, "max_tokens"))


def to_lc_messages(system: str, messages: list[dict]) -> list:
    """Tin nhắn dạng {"role", "content"} -> SystemMessage / HumanMessage / AIMessage của LangChain."""
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
    out = [SystemMessage(content=system)]
    for m in messages:
        out.append(AIMessage(content=m["content"]) if m.get("role") == "assistant" else HumanMessage(content=m["content"]))
    return out


def _with_param_fallback(run, **model_kw):
    """Model báo không nhận tham số nào (temperature, verbosity, reasoning_effort) thì nhớ lại, bỏ đi và gọi lại."""
    for _ in range(3):
        model = chat_model(**model_kw)
        try:
            return run(model)
        except Exception as e:
            param = _rejected_param(str(e), {k: getattr(model, k, None)
                                             for k in ("temperature", "verbosity", "reasoning_effort")})
            if param is None:
                raise
            _forget(param)
            if param == "temperature":
                model_kw = {**model_kw, "temperature": None}
    return run(chat_model(**model_kw))


def _usage(msg) -> tuple[int | None, int | None]:
    u = getattr(msg, "usage_metadata", None) or {}
    return u.get("input_tokens"), u.get("output_tokens")


def _call_provider(system: str, messages: list[dict], max_tokens: int, json_mode: bool,
                   temperature: float, profile: dict | None = None) -> tuple[str, int | None, int | None, str]:
    """Gọi model qua LangChain. Trả về (text, input_tokens, output_tokens, model). Test có thể thay hàm này."""
    lc_messages = to_lc_messages(system, messages)
    resp = _with_param_fallback(lambda m: m.invoke(lc_messages), max_tokens=max_tokens,
                                      temperature=temperature, json_mode=json_mode, profile=profile)
    in_tok, out_tok = _usage(resp)
    model = (resp.response_metadata or {}).get("model_name") or settings.openai_llm_model
    return resp.text or "", in_tok, out_tok, model


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
        text, in_tok, out_tok, model = _call_provider(system, messages, max_tokens, json_mode, temperature,
                                                      profile=task_profile(task))
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


def _stream_provider(system: str, messages: list[dict], max_tokens: int, temperature: float,
                     profile: dict | None = None) -> Iterator["str | tuple[int | None, int | None, str]"]:
    """Gọi model dạng stream qua LangChain: phát từng đoạn chữ, cuối cùng phát (input_tokens, output_tokens, model).
    Test có thể thay hàm này."""
    lc_messages = to_lc_messages(system, messages)

    def start(model):
        it = model.stream(lc_messages)
        first = next(it, None)  # lỗi tham số (vd. temperature) chỉ lộ ra khi lấy phần tử đầu
        return first, it

    first, it = _with_param_fallback(start, max_tokens=max_tokens, temperature=temperature, streaming=True,
                                     profile=profile)
    in_tok = out_tok = None
    model = settings.openai_llm_model
    for chunk in _chain_first(first, it):
        name = (chunk.response_metadata or {}).get("model_name")
        model = name or model
        if getattr(chunk, "usage_metadata", None):
            in_tok, out_tok = _usage(chunk)
        text = chunk.text
        if text:
            yield text
    yield (in_tok, out_tok, model)


def _chain_first(first, it):
    if first is not None:
        yield first
    yield from it


def stream_text(task: str, prompt: Prompt, user_content: str, *, history: list[dict] | None = None,
                max_tokens: int = 1500, temperature: float = 0.2, chunk_ids: list[str] | None = None,
                user_id: str | None = None) -> Iterator["str | LLMResult"]:
    """Như complete_text nhưng phát từng đoạn chữ; phần tử cuối là LLMResult (đã ghi ai_llm_calls)."""
    messages = _normalize_history(history or []) + [{"role": "user", "content": user_content}]
    base = dict(task=task, prompt_id=prompt.id, prompt_version=prompt.version, provider=settings.llm_provider,
                correlation_id=get_request_id(), chunk_ids=chunk_ids or None, user_id=user_id, attempt=1)
    t0 = time.perf_counter()
    parts: list[str] = []
    usage: tuple = (None, None, settings.current_llm_model())
    try:
        for piece in _stream_provider(prompt.system, messages, max_tokens, temperature, profile=task_profile(task)):
            if isinstance(piece, tuple):
                usage = piece
                continue
            parts.append(piece)
            yield piece
    except LLMError as e:
        _log_call(**base, model=settings.current_llm_model(), status="error", error=str(e.detail),
                  latency_ms=(time.perf_counter() - t0) * 1000)
        raise
    except Exception as e:
        _log_call(**base, model=settings.current_llm_model(), status="error", error=f"{type(e).__name__}: {e}"[:2000],
                  latency_ms=(time.perf_counter() - t0) * 1000)
        raise LLMError(f"Gọi LLM thất bại ({settings.llm_provider}): {type(e).__name__}: {str(e)[:300]}")
    latency = (time.perf_counter() - t0) * 1000
    in_tok, out_tok, model = usage
    call_id = _log_call(**base, model=model, status="ok", input_tokens=in_tok, output_tokens=out_tok,
                        latency_ms=latency, cost_usd=_estimate_cost(in_tok, out_tok))
    yield LLMResult(text="".join(parts), model=model, input_tokens=in_tok, output_tokens=out_tok, latency_ms=latency,
                    call_ids=[call_id] if call_id else [], prompt_id=prompt.id, prompt_version=prompt.version)


def _tools_kwargs(system: str, messages: list[dict], tools: list[dict], max_tokens: int, temperature: float,
                  profile: dict | None = None) -> dict:
    if not settings.openai_api_key:
        raise LLMError("Chưa cấu hình OPENAI_API_KEY.")
    kwargs = {"model": settings.openai_llm_model,
              "messages": [{"role": "system", "content": system}] + messages,
              "max_completion_tokens": max_tokens, "temperature": temperature}
    if tools:
        kwargs["tools"] = [{"type": "function", "function": t} for t in tools]
    model_name = settings.openai_llm_model
    _apply_profile(kwargs, profile, "max_completion_tokens")
    if model_name in _need_reasoning_none and "reasoning_effort" not in _unsupported.get(model_name, set()):
        kwargs["reasoning_effort"] = "none"
    if model_name in _no_temperature:
        kwargs.pop("temperature")
    return kwargs


def _create_with_fixes(kwargs: dict, start):
    """Gọi start(kwargs); model đời mới (vd. gpt-6-luna) mặc định có suy luận và từ chối function tools trên
    /chat/completions trừ khi reasoning_effort="none"; model khác lại không nhận temperature / verbosity. Gặp lỗi nào thì
    chỉnh, nhớ lại cho các lần sau (theo tên model) và gọi lại."""
    model_name = settings.openai_llm_model
    for _ in range(4):
        try:
            return start(kwargs)
        except Exception as e:
            err = str(e)
            if "reasoning_effort" in err and kwargs.get("reasoning_effort") != "none":
                kwargs["reasoning_effort"] = "none"  # function tools trên /chat/completions cần reasoning none
                _need_reasoning_none.add(model_name)
                continue
            param = _rejected_param(err, kwargs)
            if param is None:
                raise
            kwargs.pop(param)
            _forget(param)
    return start(kwargs)


def _tools_provider(system: str, messages: list[dict], tools: list[dict], max_tokens: int,
                    temperature: float, profile: dict | None = None) -> tuple[dict, int | None, int | None, str]:
    """Gọi OpenAI có function calling. Trả về (message, input_tokens, output_tokens, model), trong đó
    message = {"content": str | None, "tool_calls": [{"id", "name", "arguments"(str JSON)}]}. Test có thể thay hàm này."""
    kwargs = _tools_kwargs(system, messages, tools, max_tokens, temperature, profile)
    resp = _create_with_fixes(kwargs, lambda kw: _openai_client().chat.completions.create(**kw))
    msg = resp.choices[0].message
    calls = [{"id": c.id, "name": c.function.name, "arguments": c.function.arguments or "{}"}
             for c in (getattr(msg, "tool_calls", None) or [])]
    usage = getattr(resp, "usage", None)
    return ({"content": msg.content, "tool_calls": calls}, getattr(usage, "prompt_tokens", None),
            getattr(usage, "completion_tokens", None), getattr(resp, "model", settings.openai_llm_model))


def _tools_stream_provider(system: str, messages: list[dict], tools: list[dict], max_tokens: int,
                           temperature: float, profile: dict | None = None
                           ) -> Iterator["str | tuple[dict, int | None, int | None, str]"]:
    """Như _tools_provider nhưng stream: phát từng đoạn chữ của câu trả lời, phần tử cuối là
    (message, input_tokens, output_tokens, model). Test có thể thay hàm này."""
    kwargs = _tools_kwargs(system, messages, tools, max_tokens, temperature, profile)
    kwargs.update(stream=True, stream_options={"include_usage": True})

    def start(kw):
        it = iter(_openai_client().chat.completions.create(**kw))
        return next(it, None), it  # lỗi tham số chỉ lộ ra khi lấy phần tử đầu

    first, it = _create_with_fixes(kwargs, start)
    content: list[str] = []
    calls: dict[int, dict] = {}
    in_tok = out_tok = None
    model = settings.openai_llm_model
    for chunk in _chain_first(first, it):
        model = getattr(chunk, "model", None) or model
        usage = getattr(chunk, "usage", None)
        if usage:
            in_tok, out_tok = getattr(usage, "prompt_tokens", None), getattr(usage, "completion_tokens", None)
        for choice in (getattr(chunk, "choices", None) or []):
            delta = choice.delta
            if getattr(delta, "content", None):
                content.append(delta.content)
                yield delta.content
            for tc in (getattr(delta, "tool_calls", None) or []):
                c = calls.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
                if tc.id:
                    c["id"] = tc.id
                fn = getattr(tc, "function", None)
                if fn is not None:
                    c["name"] += fn.name or ""
                    c["arguments"] += fn.arguments or ""
    tool_calls = [{**c, "arguments": c["arguments"] or "{}"} for _, c in sorted(calls.items())]
    yield ({"content": "".join(content) or None, "tool_calls": tool_calls}, in_tok, out_tok, model)


def complete_with_tools(task: str, prompt: Prompt, messages: list[dict], tools: list[dict], *,
                        max_tokens: int = 1500, temperature: float = 0.2, user_id: str | None = None,
                        attempt: int = 1) -> tuple[dict, LLMResult]:
    """Một bước của vòng lặp agent: model trả lời chữ hoặc yêu cầu gọi tool. Ghi ai_llm_calls như các lượt khác.

    `messages` theo định dạng OpenAI (user / assistant có tool_calls / tool)."""
    base = dict(task=task, prompt_id=prompt.id, prompt_version=prompt.version, provider=settings.llm_provider,
                correlation_id=get_request_id(), chunk_ids=None, user_id=user_id, attempt=attempt)
    t0 = time.perf_counter()
    try:
        msg, in_tok, out_tok, model = _tools_provider(prompt.system, messages, tools, max_tokens, temperature,
                                                      profile=task_profile(task))
    except LLMError as e:
        _log_call(**base, model=settings.current_llm_model(), status="error", error=str(e.detail),
                  latency_ms=(time.perf_counter() - t0) * 1000)
        raise
    except Exception as e:
        _log_call(**base, model=settings.current_llm_model(), status="error", error=f"{type(e).__name__}: {e}"[:2000],
                  latency_ms=(time.perf_counter() - t0) * 1000)
        raise LLMError(f"Gọi LLM thất bại ({settings.llm_provider}): {type(e).__name__}: {str(e)[:300]}")
    latency = (time.perf_counter() - t0) * 1000
    call_id = _log_call(**base, model=model, status="ok", input_tokens=in_tok, output_tokens=out_tok,
                        latency_ms=latency, cost_usd=_estimate_cost(in_tok, out_tok))
    return msg, LLMResult(text=msg.get("content") or "", model=model, input_tokens=in_tok, output_tokens=out_tok,
                          latency_ms=latency, call_ids=[call_id] if call_id else [], prompt_id=prompt.id,
                          prompt_version=prompt.version)


def stream_with_tools(task: str, prompt: Prompt, messages: list[dict], tools: list[dict], *,
                      max_tokens: int = 1500, temperature: float = 0.2, user_id: str | None = None,
                      attempt: int = 1) -> Iterator["str | tuple[dict, LLMResult]"]:
    """Như complete_with_tools nhưng phát từng đoạn chữ ngay khi model sinh ra; phần tử cuối là (message, LLMResult)."""
    base = dict(task=task, prompt_id=prompt.id, prompt_version=prompt.version, provider=settings.llm_provider,
                correlation_id=get_request_id(), chunk_ids=None, user_id=user_id, attempt=attempt)
    t0 = time.perf_counter()
    final = None
    try:
        for piece in _tools_stream_provider(prompt.system, messages, tools, max_tokens, temperature,
                                            profile=task_profile(task)):
            if isinstance(piece, tuple):
                final = piece
            else:
                yield piece
        if final is None:
            raise LLMError("Model không trả về kết quả.")
    except LLMError as e:
        _log_call(**base, model=settings.current_llm_model(), status="error", error=str(e.detail),
                  latency_ms=(time.perf_counter() - t0) * 1000)
        raise
    except Exception as e:
        _log_call(**base, model=settings.current_llm_model(), status="error", error=f"{type(e).__name__}: {e}"[:2000],
                  latency_ms=(time.perf_counter() - t0) * 1000)
        raise LLMError(f"Gọi LLM thất bại ({settings.llm_provider}): {type(e).__name__}: {str(e)[:300]}")
    msg, in_tok, out_tok, model = final
    latency = (time.perf_counter() - t0) * 1000
    call_id = _log_call(**base, model=model, status="ok", input_tokens=in_tok, output_tokens=out_tok,
                        latency_ms=latency, cost_usd=_estimate_cost(in_tok, out_tok))
    yield msg, LLMResult(text=msg.get("content") or "", model=model, input_tokens=in_tok, output_tokens=out_tok,
                         latency_ms=latency, call_ids=[call_id] if call_id else [], prompt_id=prompt.id,
                         prompt_version=prompt.version)


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
    """Gộp lượt liên tiếp cùng vai trò, bắt đầu bằng user và bỏ câu hỏi cuối (đã là câu hỏi mới)."""
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
