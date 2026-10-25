# Adopting the convention in a loguru project

Reuse from `logging/python/codekit_logging.py`: copy it as the project's logging module (for example `app/logging.py`). Then:
- **delete** `_entry`, `JsonFormatter`, `PrettyFormatter`, `TaggedLogger`, `configure_logging`, `get_logger` and `import logging`;
- **keep** `uuid7`, `current_correlation_id`, `correlation_scope`, `correlation_headers`, `httpx_event_hook`, `sanitize`, `_error_stack`, `REPEAT_WINDOW_S`, `format_pretty`, `_log_request`, `CorrelationIdMiddleware` and `DjangoCorrelationIdMiddleware`;
- paste the code from sections 3 and 5 where the deleted code was, **above** `# ---- HTTP middleware`. Then `_http_log = get_logger("http")` uses the loguru wrapper.

loguru stays the only logging library. stdlib `logging` is only bridged into it (see section 6).

## 1. When this applies
- Dependencies (`pyproject.toml`, `requirements*.txt`, `poetry.lock`): `loguru`.
- Code: `from loguru import logger`, `logger.add(...)`, `logger.remove()`, `logger.bind(...)`, `logger.contextualize(...)`, `logger.opt(...)`, `@logger.catch`, often an `InterceptHandler` for stdlib logging.
- `logger.add(sys.stderr, serialize=True)` is **not** enough. It writes `{"text": ..., "record": {...}}` with loguru's own keys. Use the custom sink below.

## 2. correlationId
- `_patch` is installed with `logger.configure(patcher=...)`. It runs in the caller's thread or task, before an `enqueue=True` handler hands the record off. It copies `current_correlation_id()` (the sample's ContextVar) into `record["extra"]`. Verified with `enqueue=True`.
- Existing `with logger.contextualize(correlationId=...)` or `logger.bind(correlationId=...)` wins, because `setdefault` is used.
- If the project already has a `request_id` middleware, replace it with `CorrelationIdMiddleware` (ASGI, first in the stack) or `DjangoCorrelationIdMiddleware` (first in `MIDDLEWARE`). Don't run both.
- Outgoing calls: `requests.post(url, headers=correlation_headers())`, or `httpx.Client(event_hooks={"request": [httpx_event_hook]})`.
- Jobs and consumers: `with correlation_scope(msg.headers.get("X-Correlation-Id")): handle(msg)`.

## 3. JSON output (custom sink)
```python
from loguru import logger as _loguru

_LEVELS = {"TRACE": "debug", "DEBUG": "debug", "INFO": "info", "SUCCESS": "info", "WARNING": "warn", "ERROR": "error", "CRITICAL": "error"}
_OWN = {"logger", "correlationId", "tags", "context", "durationMs"}

def _patch(record: dict[str, Any]) -> None:
    record["extra"].setdefault("correlationId", current_correlation_id() or "none")

def _entry(record: Mapping[str, Any], service: str) -> dict[str, Any]:
    extra = record["extra"]
    entry: dict[str, Any] = {
        "timestamp": record["time"].astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "level": _LEVELS.get(record["level"].name, "info"),
        "service": service,
        "logger": extra.get("logger") or record["name"],           # record["name"] = calling module
        "correlationId": extra.get("correlationId") or "none",
        "tags": list(extra.get("tags") or ["legacy"]),               # section 6
        "message": record["message"],
    }
    context = {**{k: v for k, v in extra.items() if k not in _OWN}, **(extra.get("context") or {})}
    if context:
        entry["context"] = sanitize(context)                         # redaction + size limits
    if extra.get("durationMs") is not None:
        entry["durationMs"] = extra["durationMs"]
    exc = record["exception"]
    if exc is not None and exc.value is not None:
        entry["error"] = {"type": exc.type.__name__, "message": str(exc.value), "stack": _error_stack(exc.value)}
    return entry

def configure_logging(service: str, level: str | None = None, pretty: bool | None = None, stream: Any = None) -> None:
    """Call once at startup. Replaces every loguru handler, including the default stderr one."""
    use_pretty = pretty if pretty is not None else os.environ.get("LOG_PRETTY") == "1"
    out = stream or sys.stdout

    def sink(message: Any) -> None:
        e = _entry(message.record, service)
        out.write((format_pretty(e) if use_pretty else json.dumps(e, default=str, ensure_ascii=False)) + "\n")

    _loguru.configure(
        handlers=[{"sink": sink, "level": level or os.environ.get("LOG_LEVEL", "INFO"), "format": "{message}"}],
        patcher=_patch,
    )
```
- Delete the project's other `logger.add(...)` calls. For a file target, add a second handler with the same `sink` writing to an open file. You can add `"enqueue": True` to the handler dict.
- Call `configure_logging(service="orders")` once at startup, before the app is built.

## 4. Dev pretty output
`LOG_PRETTY=1` makes the same sink call the sample's `format_pretty`. Don't use loguru's colour `format=` string, because the line has to stay exactly in this shape. Verified output:
```
04:53:52.812 INFO  [cid=none] [auth,login] Login success userId=42 (12ms)
04:53:52.812 ERROR [cid=none] [db] Query failed table=users error=ZeroDivisionError: division by zero
04:53:52.816 INFO  [cid=7f3a91c2] [http] Request finished method=POST path=/orders status=201 (0ms)
```

## 5. Tagged wrapper
```python
class TaggedLogger:
    """log.info(["auth"], "Login success", {"user_id": 42, "duration_ms": 12})"""

    _repeats: dict[str, list[float]] = {}

    def __init__(self, name: str) -> None:
        self._name = name
        self._log = _loguru.bind(logger=name)                        # safe at import time, before configure

    def _emit(self, level: str, tags: Sequence[str], message: str, context: Mapping[str, Any] | None, exc: BaseException | None = None) -> None:
        if not tags or isinstance(tags, str):
            raise ValueError("log entries need a non-empty list of tags")
        ctx = dict(context or {})
        duration = ctx.pop("duration_ms", ctx.pop("durationMs", None))
        if level == "ERROR" and self._suppressed(message, ctx):
            return
        # no positional args -> loguru never str.format()s the message, so "{x}" stays literal
        self._log.bind(tags=list(tags), context=ctx or None, durationMs=duration).opt(exception=exc, depth=2).log(level, message)

    def _suppressed(self, message: str, ctx: dict[str, Any]) -> bool:
        key, now = f"{self._name}|{message}", time.monotonic()      # same rule as the sample's TaggedLogger
        seen = TaggedLogger._repeats.get(key)
        if seen and now - seen[0] < REPEAT_WINDOW_S:
            seen[1] += 1
            return True
        if seen and seen[1]:
            ctx["repeated"] = int(seen[1])
        TaggedLogger._repeats[key] = [now, 0]
        return False

    def debug(self, tags: Sequence[str], message: str, context: Mapping[str, Any] | None = None) -> None: self._emit("DEBUG", tags, message, context)
    def info(self, tags: Sequence[str], message: str, context: Mapping[str, Any] | None = None) -> None: self._emit("INFO", tags, message, context)
    def warn(self, tags: Sequence[str], message: str, context: Mapping[str, Any] | None = None) -> None: self._emit("WARNING", tags, message, context)
    def error(self, tags: Sequence[str], message: str, exc: BaseException | None = None, context: Mapping[str, Any] | None = None) -> None: self._emit("ERROR", tags, message, context, exc)

def get_logger(name: str) -> TaggedLogger:
    return TaggedLogger(name)
```
Usage: `log = get_logger(__name__)`, then `log.error(["payment"], "Charge failed", exc, {"order_id": oid})`.

## 6. Legacy calls become tag `legacy`
The sink handles this, so no call site changes. Verified mappings:

| Existing call | Entry |
|---|---|
| `logger.info("plain")` | `tags:["legacy"]`, `logger:"<module __name__>"` |
| `logger.info("User {} logged in", 42)` | `message:"User 42 logged in"` |
| `logger.bind(user_id=7, password="x").warning("m")` | `context:{user_id:7, password:"[redacted]"}` |
| `logger.info("hi {who}", who="bob")` | `message:"hi bob"`, `context:{who:"bob"}` |
| `logger.exception("failed")` in `except` | `level:"error"`, `error:{type,message,stack}` |
| `logger.success(...)` / `logger.critical(...)` | `info` / `error` |

Third-party libraries that use stdlib `logging` are bridged with the usual loguru intercept. Put it in the logging module and call it from `configure_logging`:
```python
import logging

class _InterceptHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        exc = record.exc_info[1] if record.exc_info else None
        _loguru.bind(logger=record.name).opt(exception=exc).log(record.levelname if record.levelname in _LEVELS else record.levelno, record.getMessage())

logging.basicConfig(handlers=[_InterceptHandler()], level=0, force=True)
```

## 7. Ban raw logging (ruff)
```toml
[tool.ruff.lint]
extend-select = ["T20", "TID251"]

[tool.ruff.lint.flake8-tidy-imports.banned-api]
"loguru.logger".msg = "Use get_logger(__name__) from app.logging: entries need tags and correlationId."
"logging.getLogger".msg = "Use get_logger(__name__) from app.logging."
"logging.basicConfig".msg = "configure_logging() owns the setup."

[tool.ruff.lint.per-file-ignores]
"app/logging.py" = ["TID251"]
```
Existing violations: run `ruff check --select TID251,T20 --add-noqa .` once (tested with ruff 0.17). It appends `# noqa: TID251` to the current offenders, so old code passes and any new `from loguru import logger` fails. When the AI converts a file, it removes that file's `noqa` comments.

## 8. Checklist
- [ ] `logging_set_project` is recorded: library `loguru`, entry point `app/logging.py`.
- [ ] `loguru` is the only logging dependency. No `structlog`, no `python-json-logger`.
- [ ] `configure_logging()` runs once at startup, and no other `logger.add()` remains.
- [ ] Production: each line parses as JSON with exactly `timestamp, level, service, logger, correlationId, tags, message` (+ `context`, `durationMs`, `error`). Levels are only `debug|info|warn|error`. `timestamp` ends in `.mmmZ`.
- [ ] `curl -H "X-Correlation-Id: test-12345678" …` puts that id on every line of the request, legacy lines included, and on the response header. Without the header a UUIDv7 is generated and sent by `correlation_headers()`.
- [ ] `LOG_PRETTY=1` prints the pretty line shown above.
- [ ] An untouched `logger.info("x")` prints `tags:["legacy"]`.
- [ ] `context.password` is `[redacted]`. The same error twice within 60 s prints once. `debug` is silent at `LOG_LEVEL=INFO`.
- [ ] `ruff check` fails on a new `from loguru import logger` outside the logging module.
