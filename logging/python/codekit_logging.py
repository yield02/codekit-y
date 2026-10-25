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


# ------------------------------------------------------------------ noise and safety limits

_SECRET_KEY = re.compile(r"pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|card", re.I)
MAX_STRING, MAX_ITEMS, MAX_DEPTH, MAX_KEYS = 500, 20, 3, 20
REPEAT_WINDOW_S = 60.0


def sanitize(value: Any, depth: int = 0, key: str = "") -> Any:
    """Redact secrets and bound sizes so a log line never carries payloads or credentials."""
    if key and _SECRET_KEY.search(key):
        return "[redacted]"
    if isinstance(value, str):
        return value if len(value) <= MAX_STRING else f"{value[:MAX_STRING]}…(+{len(value) - MAX_STRING})"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    if depth >= MAX_DEPTH:
        return f"[list({len(value)})]" if isinstance(value, (list, tuple, set)) else "[object]"
    if isinstance(value, (list, tuple, set)):
        items = [sanitize(v, depth + 1) for v in list(value)[:MAX_ITEMS]]
        return items + [f"…(+{len(value) - MAX_ITEMS})"] if len(value) > MAX_ITEMS else items
    if isinstance(value, Mapping):
        entries = list(value.items())
        out = {str(k): sanitize(v, depth + 1, str(k)) for k, v in entries[:MAX_KEYS]}
        if len(entries) > MAX_KEYS:
            out["…"] = f"+{len(entries) - MAX_KEYS} keys"
        return out
    return sanitize(str(value), depth, key)


def _error_stack(exc: BaseException) -> str:
    # format_exception already follows __cause__ / __context__ chains
    return "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))


# ------------------------------------------------------------------ formatting

def _entry(record: logging.LogRecord, service: str) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "level": record.levelname.lower().replace("warning", "warn"),
        "service": service,
        "logger": record.name,
        "correlationId": getattr(record, "correlation_id", None) or current_correlation_id() or "none",
        "tags": list(getattr(record, "tags", None) or ["legacy"]),  # records from plain logging calls
        "message": record.getMessage(),
    }
    context = getattr(record, "context", None)
    if context:
        entry["context"] = sanitize(context)
    duration = getattr(record, "duration_ms", None)
    if duration is not None:
        entry["durationMs"] = duration
    if record.exc_info and record.exc_info[1] is not None:
        exc = record.exc_info[1]
        entry["error"] = {"type": type(exc).__name__, "message": str(exc), "stack": _error_stack(exc)}
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

    _repeats: dict[str, list[float]] = {}  # key -> [window start, suppressed count]

    def __init__(self, logger: logging.Logger) -> None:
        self._logger = logger

    def _log(self, level: int, tags: Sequence[str], message: str, context: Mapping[str, Any] | None, exc: BaseException | None = None) -> None:
        if not tags or isinstance(tags, str):
            raise ValueError("log entries need a non-empty list of tags")
        if not self._logger.isEnabledFor(level):
            return
        ctx = dict(context or {})
        duration = ctx.pop("duration_ms", ctx.pop("durationMs", None))
        if level >= logging.ERROR:
            # The same error from the same logger is written once per window; the next write carries the count.
            key, now = f"{self._logger.name}|{message}", time.monotonic()
            seen = TaggedLogger._repeats.get(key)
            if seen and now - seen[0] < REPEAT_WINDOW_S:
                seen[1] += 1
                return
            if seen and seen[1]:
                ctx["repeated"] = int(seen[1])
            TaggedLogger._repeats[key] = [now, 0]
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
SLOW_REQUEST_MS = int(os.environ.get("LOG_SLOW_REQUEST_MS", "1000"))


def _log_request(method: Any, path: Any, status: int, started: float) -> None:
    """One info line per request (warn when slow). Disable the framework's access log to avoid duplicates."""
    duration = round((time.perf_counter() - started) * 1000)
    ctx = {"method": method, "path": path, "status": status, "duration_ms": duration}
    if duration > SLOW_REQUEST_MS:
        _http_log.warn(["http"], "Slow request", {**ctx, "slow_ms": SLOW_REQUEST_MS})
    else:
        _http_log.info(["http"], "Request finished", ctx)


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
            _http_log.debug(["http"], "Request started", {"method": method, "path": path})

            async def send_wrapper(message: dict[str, Any]) -> None:
                if message["type"] == "http.response.start":
                    status["code"] = message["status"]
                    message.setdefault("headers", [])
                    message["headers"] = [*message["headers"], (b"x-correlation-id", cid.encode("latin-1"))]
                await send(message)

            try:
                await self.app(scope, receive, send_wrapper)
            finally:
                _log_request(method, path, status["code"], started)


class DjangoCorrelationIdMiddleware:
    """settings.MIDDLEWARE = ["path.to.DjangoCorrelationIdMiddleware", ...] (first entry)."""

    def __init__(self, get_response: Callable[[Any], Any]) -> None:
        self.get_response = get_response

    def __call__(self, request: Any) -> Any:
        with correlation_scope(request.headers.get(CORRELATION_HEADER)) as cid:
            started = time.perf_counter()
            response = self.get_response(request)
            response[CORRELATION_HEADER] = cid
            _log_request(request.method, request.path, response.status_code, started)
            return response
