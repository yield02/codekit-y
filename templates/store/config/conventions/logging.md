# Logging convention — {{project}}

Goal: any developer can follow one request end to end by filtering on `correlationId`,
and find a subsystem's logs by filtering on `tags`.

## Required fields

| Field | Type | Notes |
|---|---|---|
| `timestamp` | ISO-8601 UTC | e.g. `2026-10-25T09:12:03.120Z` |
| `level` | `debug` \| `info` \| `warn` \| `error` | |
| `service` | string | service/app name |
| `correlationId` | string | see below — **mandatory** |
| `tags` | string[] | at least one, from the registry below — **mandatory** |
| `message` | string | short, human readable, no string-concatenated data |

Optional: `context` (object with structured data), `durationMs`, `error` (`type`, `message`, `stack`).

## correlationId
1. At every entry point (HTTP request, queue consumer, cron/job): read `X-Correlation-Id`;
   if OpenTelemetry is active use the `traceId`; otherwise generate a UUIDv7.
2. Keep it in request-scoped context (Node: AsyncLocalStorage · Java: MDC · .NET: LogContext · Python: contextvars).
3. Return it in the `X-Correlation-Id` response header.
4. Propagate it on every outgoing HTTP call and message (header / message attribute).

## API
Use the project's logger wrapper — never `console.log`, `System.out`, `print` or a raw logger:

```
log.info(tags, message, context?)      // tags is required
log.error(tags, message, error, context?)
```

Log at boundaries: request in/out (with `durationMs`), external calls, retries, and errors. Never log secrets, tokens or full personal data.

## Output
- Production: one JSON object per line.
- Development (pretty):
  `09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)`

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
