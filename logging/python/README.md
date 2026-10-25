# Logging sample — Python

This sample implements the codekit logging convention (`conventions/logging.md` in the knowledge store) with the **standard library only** (`logging` + `contextvars`). It adds no new dependency to the project. AI agents copy it into a project and **rename the module, functions and classes to match that project's naming convention**.

## Files
| File | Purpose |
|---|---|
| `codekit_logging.py` | UUIDv7, ContextVar correlation scope, JSON and pretty formatters, the `TaggedLogger` wrapper, ASGI and Django middleware, helpers for `requests`/`httpx` |
| `test_codekit_logging.py` | `unittest` checks for fields, mandatory tags, errors, pretty format, UUIDv7 and the ASGI middleware |
| `ruff.snippet.toml` | Bans `print` and direct `logging.getLogger` outside the logging module |

## Setup
```python
# app startup
from app.logging import configure_logging, get_logger, CorrelationIdMiddleware, correlation_headers
configure_logging(service="orders")          # LOG_PRETTY=1 for readable dev output

app = FastAPI()
app.add_middleware(CorrelationIdMiddleware)   # Django: DjangoCorrelationIdMiddleware first in MIDDLEWARE

log = get_logger(__name__)

@app.post("/orders")
async def create_order(order: Order):
    log.info(["order"], "Order received", {"items": len(order.items)})
    requests.post(PAYMENTS_URL, json=..., headers=correlation_headers())   # forwards X-Correlation-Id
```
- Production: one JSON object per line.
- Development (`LOG_PRETTY=1`): lines look like this:
  ```
  09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success user_id=42 (12ms)
  ```
- Context keys follow the project's style (snake_case here). `duration_ms` (or `durationMs`) is lifted into the top-level `durationMs` field.
- Jobs and queue consumers wrap each unit of work in `with correlation_scope(message.headers.get("X-Correlation-Id")):`.
- When OpenTelemetry is installed and a span is active, its trace id becomes the correlationId.

## Tests
```bash
python -m unittest test_codekit_logging.py
```
