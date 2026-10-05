"""Định dạng lỗi thống nhất + middleware request_id."""
import logging
import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.context import get_request_id, new_request_id, set_request_id

log = logging.getLogger("app.http")


class AppError(HTTPException):
    """Lỗi nghiệp vụ có mã lỗi máy đọc được."""

    def __init__(self, status_code: int, code: str, message: str, details: dict | None = None):
        super().__init__(status_code=status_code, detail=message)
        self.code = code
        self.details = details or {}


_DEFAULT_CODES = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    422: "VALIDATION_ERROR",
    500: "INTERNAL_ERROR",
    502: "UPSTREAM_ERROR",
}


def _error_body(status: int, code: str, message: str, details: dict | None = None) -> dict:
    return {
        "request_id": get_request_id(),
        "error": {"code": code, "message": message, "details": details or {}},
        # giữ trường `detail` để tương thích client kiểu FastAPI
        "detail": message,
    }


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        rid = request.headers.get("X-Request-ID") or new_request_id()
        set_request_id(rid)
        t0 = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Request-ID"] = rid
        if request.url.path.startswith("/ai"):
            log.info(
                "request",
                extra={"extra_fields": {
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
                }},
            )
        return response


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError):
        return JSONResponse(_error_body(exc.status_code, exc.code, str(exc.detail), exc.details), status_code=exc.status_code)

    @app.exception_handler(HTTPException)
    async def _http_error(_: Request, exc: HTTPException):
        code = _DEFAULT_CODES.get(exc.status_code, "ERROR")
        return JSONResponse(_error_body(exc.status_code, code, str(exc.detail)), status_code=exc.status_code,
                            headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError):
        errors = [
            {"loc": list(e.get("loc", [])), "msg": e.get("msg"), "type": e.get("type")}
            for e in exc.errors()
        ]
        return JSONResponse(
            _error_body(422, "VALIDATION_ERROR", "Dữ liệu gửi lên không hợp lệ.", {"errors": errors}),
            status_code=422,
        )

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception):
        log.exception("unhandled_error")
        return JSONResponse(_error_body(500, "INTERNAL_ERROR", "Lỗi hệ thống. Xem log với request_id để biết chi tiết."),
                            status_code=500)
