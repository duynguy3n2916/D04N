"""Ngữ cảnh theo request: request_id dùng làm correlation_id xuyên suốt log, LLM call, job và transition."""
import json
import logging
import uuid
from contextvars import ContextVar

_request_id: ContextVar[str] = ContextVar("request_id", default="")


def new_request_id() -> str:
    return "req_" + uuid.uuid4().hex[:16]


def set_request_id(value: str) -> None:
    _request_id.set(value)


def get_request_id() -> str:
    rid = _request_id.get()
    if not rid:
        rid = new_request_id()
        _request_id.set(rid)
    return rid


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": _request_id.get() or None,
        }
        extra = getattr(record, "extra_fields", None)
        if extra:
            payload.update(extra)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def setup_logging(level: int = logging.INFO) -> None:
    root = logging.getLogger()
    if any(isinstance(h.formatter, JsonFormatter) for h in root.handlers):
        return
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root.handlers = [handler]
    root.setLevel(level)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
