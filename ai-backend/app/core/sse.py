"""Trả kết quả dạng Server-Sent Events (Tutor, Trợ lý học tập)."""
import json
import logging
from collections.abc import Callable, Iterator

from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.core.context import get_request_id, set_request_id
from app.core.errors import AppError
from app.database import SessionLocal

log = logging.getLogger("app.sse")


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


def sse_response(run: Callable[[Session], Iterator[dict]], *, name: str) -> StreamingResponse:
    """Chạy run(session) và phát mỗi {"event", "data"} thành một sự kiện SSE; lỗi giữa chừng thành sự kiện `error`.

    Session của request đã đóng khi response bắt đầu stream nên run nhận một session riêng."""
    request_id = get_request_id()

    def events():
        set_request_id(request_id)  # generator chạy ngoài context của request
        session = SessionLocal()
        try:
            for ev in run(session):
                yield sse(ev["event"], ev["data"])
        except AppError as e:
            session.rollback()
            yield sse("error", {"code": e.code, "message": str(e.detail)})
        except Exception:
            session.rollback()
            log.exception(f"{name}_stream_failed")
            yield sse("error", {"code": "INTERNAL_ERROR", "message": "Lỗi khi tạo câu trả lời."})
        finally:
            session.close()

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
