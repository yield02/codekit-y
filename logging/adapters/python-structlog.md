# Adopting the convention in a structlog project

Reuse from `logging/python/codekit_logging.py`: copy it as the project's logging module (for example `app/logging.py`). Then:
- **delete** `_entry`, `JsonFormatter`, `PrettyFormatter`, `TaggedLogger`, `configure_logging` and `get_logger`;
- **keep** `uuid7`, `current_correlation_id`, `correlation_scope`, `correlation_headers`, `httpx_event_hook`, `sanitize`, `_error_stack`, `REPEAT_WINDOW_S`, `format_pretty`, `_log_request`, `CorrelationIdMiddleware` and `DjangoCorrelationIdMiddleware`;
- add `import structlog`, and paste the code from sections 3 and 5 where the deleted code was, **above** `# ---- HTTP middleware`. Then `_http_log = get_logger("http")` uses the structlog wrapper.

## 1. When this applies
- Dependencies: `structlog`, maybe with `django-structlog` or `asgi-correlation-id`. Code: `structlog.configure(processors=[...])`, `structlog.get_logger()`, `bind_contextvars(...)`, `JSONRenderer()`/`ConsoleRenderer()`, `TimeStamper(...)`.
- Two setups exist. The **native** one uses `PrintLoggerFactory`/`WriteLoggerFactory` and has the renderer at the end of `processors`. The **stdlib** one uses `structlog.stdlib.LoggerFactory()` plus `ProcessorFormatter` on a `logging` handler. Replace the project's `configure` call with the matching function below. In the stdlib setup, `logging` is structlog's backend, not a second library.

## 2. correlationId: `bind_contextvars` + `merge_contextvars`
Change one line in the copied `correlation_scope`, so structlog's own context carries the id as well:
```python
    token = _correlation_id.set(cid)
    try:
        with structlog.contextvars.bound_contextvars(correlationId=cid):   # added
            yield cid
    finally:
        _correlation_id.reset(token)
```
- `merge_contextvars` comes first in the processor chain, so every entry inside a scope has `correlationId`, legacy calls included. Outside a scope it is `"none"`.
- Wire `CorrelationIdMiddleware` (ASGI, first in the stack) or `DjangoCorrelationIdMiddleware` (first in `MIDDLEWARE`). Remove the old request-id middleware: `asgi-correlation-id`, `django-structlog`'s request middleware, or a hand-written `bind_contextvars(request_id=...)`. Until it is removed, a bound `request_id` is mapped to `correlationId`.
- Outgoing calls: `requests.post(url, headers=correlation_headers())`, or `httpx.Client(event_hooks={"request": [httpx_event_hook]})`.
- Jobs and consumers: `with correlation_scope(msg.headers.get("X-Correlation-Id")): handle(msg)`.

## 3. JSON output: one processor, then `JSONRenderer`
```python
_LEVELS = {"debug": "debug", "info": "info", "warn": "warn", "warning": "warn", "error": "error", "exception": "error", "critical": "error", "fatal": "error"}

def _exc(value: Any) -> BaseException | None:                # exc_info may be True, a tuple or an exception
    value = sys.exc_info()[1] if value is True else value[1] if isinstance(value, tuple) else value
    return value if isinstance(value, BaseException) else None

def to_convention(service: str) -> Callable[..., dict[str, Any]]:
    """Last processor before the renderer: event dict -> exact convention keys."""
    def processor(_logger: Any, method_name: str, ed: dict[str, Any]) -> dict[str, Any]:
        ed.pop("timestamp", None)                           # an old TimeStamper is ignored: ms + Z is mandated
        exc = _exc(ed.pop("exc_info", None))
        module = ed.pop("module", None)                     # CallsiteParameterAdder: legacy `logger` fallback
        entry: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": _LEVELS.get(str(ed.pop("level", method_name)).lower(), "info"),
            "service": service,
            "logger": ed.pop("logger", None) or module or "root",
            "correlationId": ed.pop("correlationId", None) or ed.pop("request_id", None) or "none",
            "tags": list(ed.pop("tags", None) or ["legacy"]),             # section 6
            "message": str(ed.pop("event", "")),
        }
        duration = ed.pop("durationMs", None)
        own = ed.pop("context", None) or {}
        context = {**ed, **own}                             # legacy kwargs (log.info("x", user_id=1)) -> context
        if context: entry["context"] = sanitize(context)    # redaction + size limits
        if duration is not None: entry["durationMs"] = duration
        if exc is not None: entry["error"] = {"type": type(exc).__name__, "message": str(exc), "stack": _error_stack(exc)}
        return entry
    return processor

def _renderer(pretty: bool | None) -> Callable[..., Any]:
    if pretty if pretty is not None else os.environ.get("LOG_PRETTY") == "1":
        return lambda _logger, _name, entry: format_pretty(entry)
    return structlog.processors.JSONRenderer(default=str, ensure_ascii=False)

def configure_logging(service: str, level: str | None = None, pretty: bool | None = None) -> None:
    """Native setup (PrintLoggerFactory)."""
    module = structlog.processors.CallsiteParameterAdder({structlog.processors.CallsiteParameter.MODULE})
    structlog.configure(
        processors=[structlog.contextvars.merge_contextvars, structlog.processors.add_log_level, module, to_convention(service), _renderer(pretty)],
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(level or os.environ.get("LOG_LEVEL", "INFO"))),
        logger_factory=structlog.PrintLoggerFactory(sys.stdout), cache_logger_on_first_use=True)

def configure_stdlib_logging(service: str, level: str | None = None, pretty: bool | None = None) -> None:
    """Stdlib setup: plain logging.getLogger(...) records (third-party libraries) get the same entry."""
    shared = [structlog.contextvars.merge_contextvars, structlog.stdlib.add_logger_name, structlog.stdlib.add_log_level]
    structlog.configure(processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
                        logger_factory=structlog.stdlib.LoggerFactory(), wrapper_class=structlog.stdlib.BoundLogger,
                        cache_logger_on_first_use=True)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared,
        processors=[structlog.stdlib.ProcessorFormatter.remove_processors_meta, to_convention(service), _renderer(pretty)]))
    logging.getLogger().handlers = [handler]
    logging.getLogger().setLevel(level or os.environ.get("LOG_LEVEL", "INFO"))
```
- Delete the old `TimeStamper`, `EventRenamer`, `format_exc_info`/`dict_tracebacks` and `ConsoleRenderer` entries. `to_convention` does their work. A project processor that only **adds** keys can stay before `to_convention`, and its keys end up in `context`. `JSONRenderer` keeps the convention's key order.

## 4. Dev pretty output
`LOG_PRETTY=1` makes `_renderer` return a function that calls the sample's `format_pretty`. Don't use `ConsoleRenderer`. Verified output:
```
04:54:21.733 INFO  [cid=none] [auth,login] Login success userId=42 (12ms)
04:54:21.733 ERROR [cid=none] [db] Query failed table=users error=ZeroDivisionError: division by zero
04:54:21.735 INFO  [cid=7f3a91c2] [http] Request finished method=POST path=/orders status=201 (0ms)
```

## 5. Tagged wrapper
```python
class TaggedLogger:
    """log.info(["auth"], "Login success", {"user_id": 42, "duration_ms": 12})"""

    _repeats: dict[str, list[float]] = {}

    def __init__(self, name: str) -> None:
        self._name = name
        self._log = structlog.get_logger(name)  # lazy proxy: safe at import time. Don't .bind() here, it freezes the config

    def _emit(self, method: str, tags: Sequence[str], message: str, context: Mapping[str, Any] | None, exc: BaseException | None = None) -> None:
        if not tags or isinstance(tags, str):
            raise ValueError("log entries need a non-empty list of tags")
        ctx = dict(context or {})
        duration = ctx.pop("duration_ms", ctx.pop("durationMs", None))
        if method == "error" and self._suppressed(message, ctx):
            return
        kw: dict[str, Any] = {"logger": self._name, "tags": list(tags), "context": ctx or None, "durationMs": duration, "exc_info": exc}
        getattr(self._log, method)(message, **{k: v for k, v in kw.items() if v is not None})

    def _suppressed(self, message: str, ctx: dict[str, Any]) -> bool:
        key, now = f"{self._name}|{message}", time.monotonic()      # same rule as the sample's TaggedLogger
        seen = TaggedLogger._repeats.get(key)
        if seen and now - seen[0] < REPEAT_WINDOW_S:
            seen[1] += 1
            return True
        if seen and seen[1]: ctx["repeated"] = int(seen[1])
        TaggedLogger._repeats[key] = [now, 0]
        return False

    def debug(self, tags: Sequence[str], message: str, context: Mapping[str, Any] | None = None) -> None: self._emit("debug", tags, message, context)
    def info(self, tags: Sequence[str], message: str, context: Mapping[str, Any] | None = None) -> None: self._emit("info", tags, message, context)
    def warn(self, tags: Sequence[str], message: str, context: Mapping[str, Any] | None = None) -> None: self._emit("warning", tags, message, context)
    def error(self, tags: Sequence[str], message: str, exc: BaseException | None = None, context: Mapping[str, Any] | None = None) -> None: self._emit("error", tags, message, context, exc)

def get_logger(name: str) -> TaggedLogger:
    return TaggedLogger(name)
```
Pass the name as an event key. `structlog.get_logger(logger=name)` raises a `TypeError`, because `logger` collides with a parameter of `wrap_logger`.

## 6. Legacy calls become tag `legacy`
`to_convention` handles this, so no call site changes. Verified mappings:

| Existing call | Entry |
|---|---|
| `structlog.get_logger().info("plain")` | `tags:["legacy"]`. `logger` is the calling module (native) or the stdlib logger name |
| `log.warning("m", user_id=7, api_key="k")` | `context:{user_id:7, api_key:"[redacted]"}` |
| `log.bind(order_id=5).info("m")` | `context:{order_id:5}` |
| `log.exception("failed")` / `log.error("x", exc_info=e)` | `level:"error"`, `error:{type,message,stack}` |
| `bind_contextvars(request_id="…")` (old middleware) | `correlationId` is that id |
| `logging.getLogger("lib").warning("x %s", 1)` (stdlib variant) | `logger:"lib"`, `tags:["legacy"]` |

## 7. Ban raw logging (ruff)
```toml
[tool.ruff.lint]
extend-select = ["T20", "TID251"]

[tool.ruff.lint.flake8-tidy-imports.banned-api]
"structlog.get_logger".msg = "Use get_logger(__name__) from app.logging: entries need tags and correlationId."
"structlog.getLogger".msg = "Use get_logger(__name__) from app.logging."
"structlog.stdlib.get_logger".msg = "Use get_logger(__name__) from app.logging."
"logging.getLogger".msg = "Use get_logger(__name__) from app.logging."

[tool.ruff.lint.per-file-ignores]
"app/logging.py" = ["TID251"]
```
Existing violations: run `ruff check --select TID251,T20 --add-noqa .` once (tested with ruff 0.17). Old call sites get `# noqa: TID251` and new ones fail. When the AI converts a file, it removes that file's `noqa` comments.

## 8. Checklist
- [ ] `logging_set_project` is recorded: library `structlog` (native or stdlib), entry point `app/logging.py`.
- [ ] Exactly one `structlog.configure(...)` remains: `configure_logging` or `configure_stdlib_logging`.
- [ ] Production: each line parses as JSON with exactly `timestamp, level, service, logger, correlationId, tags, message` (+ `context`, `durationMs`, `error`). Levels are only `debug|info|warn|error`. `timestamp` ends in `.mmmZ`.
- [ ] `curl -H "X-Correlation-Id: test-12345678" …` puts that id on every line of the request, legacy lines included, and on the response header. Without the header a UUIDv7 is generated and sent by `correlation_headers()`.
- [ ] `LOG_PRETTY=1` prints the pretty line shown above.
- [ ] An untouched `structlog.get_logger().info("x")` prints `tags:["legacy"]`.
- [ ] `context.password` is `[redacted]`. The same error twice within 60 s prints once. `debug` is silent at `LOG_LEVEL=INFO`.
- [ ] `ruff check` fails on a new `structlog.get_logger()` outside the logging module.
