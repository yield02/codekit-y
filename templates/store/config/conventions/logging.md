# Logging convention — {{project}}

Goal: a developer can follow one request end to end by filtering on `correlationId`, find a subsystem's logs by filtering on `tags`, and understand a failure from **one error line** — without wading through noise.

## Required fields

| Field | Type | Notes |
|---|---|---|
| `timestamp` | ISO-8601 UTC | e.g. `2026-10-25T09:12:03.120Z` |
| `level` | `debug` \| `info` \| `warn` \| `error` | see "Levels" |
| `service` | string | service/app name |
| `logger` | string | module/class/category that wrote the entry (where to look in the code) |
| `correlationId` | string | see below — **mandatory**, `none` outside a request |
| `tags` | string[] | at least one, from the registry below — **mandatory** |
| `message` | string | short, stable text (no interpolated data — data goes in `context`) |

Optional: `context` (object with structured data), `durationMs` (number), `error` (`type`, `message`, `stack` including causes).

## correlationId
1. At every entry point (HTTP request, queue consumer, cron/job): read `X-Correlation-Id`;
   if OpenTelemetry is active use the `traceId`; otherwise generate a UUIDv7.
2. Keep it in request-scoped context (Node: AsyncLocalStorage · Java: MDC/ThreadContext · .NET: LogContext/scopes · Python: contextvars).
3. Return it in the `X-Correlation-Id` response header, and show it in error responses so users can report it.
4. Propagate it on every outgoing HTTP call and message (header / message attribute).

## API
Use the project's logger wrapper — never `console.log`, `System.out`, `print` or a raw logger:

```
log.info(tags, message, context?)      // tags is required
log.error(tags, message, error, context?)
```

## Levels
| Level | Use for | Production |
|---|---|---|
| `error` | A request/job failed and someone may need to act. Always with `error` and the ids needed to reproduce. | on |
| `warn` | Degraded but handled: retry happened, fallback used, slow call (over the threshold), unexpected input rejected. | on |
| `info` | One line per business event or boundary: request finished, job finished, order placed, external call result summary. | on |
| `debug` | Decisions and intermediate values useful while investigating. | **off** (enable per service/logger when debugging) |

## What to log (so debugging is fast)
- **One line per request at the boundary** (`http`): method, route, status, `durationMs`. Request *started* is `debug` only.
- **External calls** (`external-api`, `db` for slow queries): target, operation, status, `durationMs`. Log the *result once*, not before and after.
- **Errors once, where they are handled** — not at every layer. Include: what was attempted, the business ids (`orderId`, `userId`…), the `error` object with cause chain. A developer should not need a second log line to understand the failure.
- **Retries / fallbacks** as `warn` with `attempt` and `maxAttempts`.
- **State changes** of business entities as `info` (`order placed`, `payment captured`) with the entity id.
- **Slow operations**: `warn` when `durationMs` exceeds the threshold (default 1000 ms for HTTP, 500 ms for DB), otherwise keep them at `info`/`debug`.
- Use the **same `message` text** for the same event everywhere so it can be searched and counted; put variable data in `context`.

## What NOT to log (avoid over-logging)
- No logs inside loops or per item of a batch — log one summary (`processed 1 240 items, 3 failed`, with the failed ids).
- No "entering/leaving function" or "step 1 / step 2" lines at `info`; at most `debug`, and only around non-obvious decisions.
- No log-and-rethrow: either handle and log, or rethrow without logging. One failure = one `error` line.
- No full request/response bodies, file contents or large objects. `context` stays small (≈ 10 keys, short values); log ids and counts instead of payloads.
- No secrets, tokens, passwords, full card numbers or full personal data — ever, at any level.
- No duplicate lines from both a framework and our code for the same event (e.g. disable the framework's own request log when our middleware logs the request).
- Repeated identical errors (e.g. a dependency is down) are logged once per interval with a `count`, not once per call.
- Do not raise the production level to `debug` globally; enable `debug` for one logger or one service, for a limited time.

Rule of thumb: a healthy request produces **1–3 lines** at `info`; a failing one adds **one** `error` line that explains it.

## Output
- Production: one JSON object per line.
- Development (pretty):
  `09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)`
- Inspect any service's JSON logs with `codekit logs` (filter by `--cid`, `--tag`, `--level`; `--trace <cid>` for a request timeline; `--stats` to find the noisiest messages).

## Adopting this in an existing project
Never add a second logging library or a parallel logger. Extend what the project already has:

| The project has… | Do this |
|---|---|
| A logging library (log4j2, Logback, NLog, Microsoft.Extensions.Logging, Serilog, winston, pino, bunyan, loguru, structlog, stdlib logging…) | Keep it. Configure its formatter/encoder for the fields above, put `correlationId` in its context mechanism, add a thin tagged wrapper over it. See `logging_sample` with the stack and library. |
| Its own logger code (e.g. `LogHelper`, `utils/logger`, `AppLogger`) | Keep it as the single entry point. Add the `tags` parameter (old signatures keep working and default to tag `legacy`), read `correlationId` from request context inside it, and change its output to the fields above. |
| Nothing | Adapt the reference implementation from `logging_sample` into the project's naming convention. |

Existing calls without tags are migrated gradually: they log with tag `legacy` until someone touches that code.

## Project logger
Filled in when the convention is adopted (`logging_set_project`). AI agents use this entry point and nothing else.

| Key | Value |
|---|---|
| library | (not set) |
| entryPoint | (not set) |
| notes | (not set) |

## Tag registry
Use only these tags. Add new ones with `logging_add_tag` (kebab-case).

| Tag | Description |
|---|---|
| `http` | Incoming request/response |
| `auth` | Authentication and authorization |
| `db` | Database access |
| `cache` | Cache reads/writes |
| `external-api` | Calls to third-party services |
| `queue` | Message publishing/consuming |
| `job` | Scheduled/background jobs |
| `payment` | Payment flows |
| `validation` | Input validation failures |
| `config` | Configuration loading |
| `framework` | Entries emitted by frameworks/libraries (not by project code) |
| `legacy` | Existing log calls not yet migrated to tags |
