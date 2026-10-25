"""codekit logging sample for Python (standard library only).

Copy into the project and rename to match its naming convention.

- Every entry: timestamp, level, service, correlationId, tags[], message (+ context, durationMs, error)
- correlationId: X-Correlation-Id header > OpenTelemetry traceId > new UUIDv7, kept in a ContextVar
- Production: one JSON object per line. Development (LOG_PRETTY=1): pretty lines
    09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success user_id=42 (12ms)
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import sys
import time
import traceback
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Callable, Iterator, Mapping, Sequence

CORRELATION_HEADER = "X-Correlation-Id"
_VALID_ID = re.compile(r"^[\w.:-]{8,128}$")
_correlation_id: ContextVar[str | None] = ContextVar("correlation_id", default=None)


# ------------------------------------------------------------------ correlation id

def uuid7(now_ms: int | None = None) -> str:
    """UUIDv7: 48-bit unix ms timestamp, version 7, variant 10, random rest (time-sortable)."""
    ms = int(time.time() * 1000) if now_ms is None else now_ms
    b = bytearray(ms.to_bytes(6, "big") + secrets.token_bytes(10))
    b[6] = (b[6] & 0x0F) | 0x70
    b[8] = (b[8] & 0x3F) | 0x80
    h = b.hex()
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def _otel_trace_id() -> str | None:
    try:
        from opentelemetry import trace  # type: ignore[import-not-found]
    except ImportError:
        return None
    ctx = trace.get_current_span().get_span_context()
    return format(ctx.trace_id, "032x") if ctx and ctx.is_valid else None


def current_correlation_id() -> str | None:
    return _correlation_id.get()


@contextmanager
def correlation_scope(incoming: str | None = None) -> Iterator[str]:
    """Run a block with a correlation id (incoming value, OTel trace id, or a new UUIDv7)."""
    cid = incoming if incoming and _VALID_ID.match(incoming) else (_otel_trace_id() or uuid7())
    token = _correlation_id.set(cid)
    try:
        yield cid
    finally:
        _correlation_id.reset(token)


def correlation_headers() -> dict[str, str]:
    """Headers for outgoing calls: requests.get(url, headers=correlation_headers())."""
    cid = current_correlation_id()
    return {CORRELATION_HEADER: cid} if cid else {}


def httpx_event_hook(request: Any) -> None:
    """httpx.Client(event_hooks={"request": [httpx_event_hook]})"""
    for key, value in correlation_headers().items():
        request.headers.setdefault(key, value)


# ------------------------------------------------------------------ formatting

def _entry(record: logging.LogRecord, service: str) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "level": record.levelname.lower().replace("warning", "warn"),
        "service": service,
        "correlationId": getattr(record, "correlation_id", None) or current_correlation_id() or "none",
        "tags": list(getattr(record, "tags", None) or ["untagged"]),
        "message": record.getMessage(),
    }
    context = getattr(record, "context", None)
    if context:
        entry["context"] = context
    duration = getattr(record, "duration_ms", None)
    if duration is not None:
        entry["durationMs"] = duration
    if record.exc_info and record.exc_info[1] is not None:
        exc = record.exc_info[1]
        entry["error"] = {"type": type(exc).__name__, "message": str(exc), "stack": "".join(traceback.format_exception(*record.exc_info))}
    return entry


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        return json.dumps(_entry(record, self.service), default=str, ensure_ascii=False)


class PrettyFormatter(logging.Formatter):
    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        return format_pretty(_entry(record, self.service))


def format_pretty(e: Mapping[str, Any]) -> str:
    ctx = "".join(f" {k}={v if isinstance(v, str) else json.dumps(v, default=str)}" for k, v in (e.get("context") or {}).items())
    duration = f" ({e['durationMs']}ms)" if e.get("durationMs") is not None else ""
    err = f" error={e['error']['type']}: {e['error']['message']}" if e.get("error") else ""
    level = str(e["level"]).upper()
    return f"{str(e['timestamp'])[11:23]} {level:<5} [cid={str(e['correlationId'])[-8:]}] [{','.join(e['tags'])}] {e['message']}{ctx}{duration}{err}"


# ------------------------------------------------------------------ logger

class TaggedLogger:
    """Wrapper with mandatory tags: log.info(["auth"], "Login success", {"user_id": 42, "duration_ms": 12})."""

    def __init__(self, logger: logging.Logger) -> None:
        self._logger = logger

    def _log(self, level: int, tags: Sequence[str], message: str, context: Mapping[str, Any] | None, exc: BaseException | None = None) -> None:
        if not tags or isinstance(tags, str):
            raise ValueError("log entries need a non-empty list of tags")
        ctx = dict(context or {})
        duration = ctx.pop("duration_ms", ctx.pop("durationMs", None))
        extra = {"tags": list(tags), "context": ctx or None, "duration_ms": duration, "correlation_id": current_correlation_id()}
        exc_info = (type(exc), exc, exc.__traceback__) if exc is not None else None
        self._logger.log(level, message, extra=extra, exc_info=exc_info, stacklevel=3)

    def debug(self, tags: Sequence[str], message: str, context: Mapping[str, Any] | None = None) -> None:
        self._log(logging.DEBUG, tags, message, context)

    def info(self, tags: Sequence[str], message: str, context: Mapping[str, Any] | None = None) -> None:
        self._log(logging.INFO, tags, message, context)

    def warn(self, tags: Sequence[str], message: str, context: Mapping[str, Any] | None = None) -> None:
        self._log(logging.WARNING, tags, message, context)

    def error(self, tags: Sequence[str], message: str, exc: BaseException | None = None, context: Mapping[str, Any] | None = None) -> None:
        self._log(logging.ERROR, tags, message, context, exc)


def configure_logging(service: str, level: str | None = None, pretty: bool | None = None, stream: Any = None) -> None:
    """Call once at startup. Replaces root handlers so third-party logs get the same format."""
    use_pretty = pretty if pretty is not None else os.environ.get("LOG_PRETTY") == "1"
    handler = logging.StreamHandler(stream or sys.stdout)
    handler.setFormatter(PrettyFormatter(service) if use_pretty else JsonFormatter(service))
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level or os.environ.get("LOG_LEVEL", "INFO"))


def get_logger(name: str) -> TaggedLogger:
    return TaggedLogger(logging.getLogger(name))


# ------------------------------------------------------------------ HTTP middleware

_http_log = get_logger("http")


class CorrelationIdMiddleware:
    """Pure ASGI middleware (FastAPI, Starlette, Quart...): app.add_middleware(CorrelationIdMiddleware)."""

    def __init__(self, app: Callable[..., Any]) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Callable[..., Any], send: Callable[..., Any]) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        incoming = next((v.decode("latin-1") for k, v in scope.get("headers", []) if k.decode("latin-1").lower() == "x-correlation-id"), None)
        with correlation_scope(incoming) as cid:
            started = time.perf_counter()
            status = {"code": 500}
            method, path = scope.get("method"), scope.get("path")
            _http_log.info(["http"], "Request started", {"method": method, "path": path})

            async def send_wrapper(message: dict[str, Any]) -> None:
                if message["type"] == "http.response.start":
                    status["code"] = message["status"]
                    message.setdefault("headers", [])
                    message["headers"] = [*message["headers"], (b"x-correlation-id", cid.encode("latin-1"))]
                await send(message)

            try:
                await self.app(scope, receive, send_wrapper)
            finally:
                _http_log.info(["http"], "Request finished", {"method": method, "path": path, "status": status["code"], "duration_ms": round((time.perf_counter() - started) * 1000)})


class DjangoCorrelationIdMiddleware:
    """settings.MIDDLEWARE = ["path.to.DjangoCorrelationIdMiddleware", ...] (first entry)."""

    def __init__(self, get_response: Callable[[Any], Any]) -> None:
        self.get_response = get_response

    def __call__(self, request: Any) -> Any:
        with correlation_scope(request.headers.get(CORRELATION_HEADER)) as cid:
            started = time.perf_counter()
            response = self.get_response(request)
            response[CORRELATION_HEADER] = cid
            _http_log.info(["http"], "Request finished", {"method": request.method, "path": request.path, "status": response.status_code, "duration_ms": round((time.perf_counter() - started) * 1000)})
            return response
