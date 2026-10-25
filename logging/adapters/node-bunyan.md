# Adopting the convention in a bunyan project

Reuse from `logging/node/src/logging.ts`: copy it into the logging folder as `core.ts`. Then make these edits only:
- delete `import { Writable } from "node:stream"`, `import pino from "pino"`, `prettyStream`, `LoggerOptions` and `createLogger`;
- (`toError` and `REPEAT_WINDOW_MS` are already exported by the reference file.)

Everything else stays as it is: `uuidv7`, `withCorrelationId`, `currentCorrelationId`, the `TaggedLogger` interface, `sanitize`, `formatPretty`, `correlationMiddleware`, `fetchWithCorrelation` and `withCorrelationHeader`. Don't install pino. bunyan stays the only logging library.

## 1. When this applies
- `package.json` has `bunyan` (1.x). You may also see `@types/bunyan`, `bunyan-format`, `bunyan-pretty`, `restify` (restify uses bunyan with `req.log` / `req_id`) or `express-bunyan-logger`.
- Code: `bunyan.createLogger({ name, streams, serializers })`, `log.child({ component })`, `bunyan.stdSerializers`, and dev scripts that pipe through `| bunyan` or `| bunyan-format`.
- bunyan's core record fields (`v`, `level` as a number, `name`, `hostname`, `pid`, `time`, `msg`) don't match the convention. A **raw stream** remaps them. Don't use bunyan's default JSON stream or the `bunyan` CLI.

## 2. correlationId
- bunyan calls `stream.write(rec)` of a raw stream **synchronously** inside `log.info(...)`. The stream can therefore read the sample's AsyncLocalStorage (`currentCorrelationId()`), and legacy calls get the id with no change.
- An explicit `rec.correlationId` (from `log.child({ correlationId })`) wins. So does restify's `req_id`, so old `req.log` code stays correct.
- Wire `correlationMiddleware(getLogger("app"))` as the **first** middleware (restify: `server.pre(...)` (verify)). It sets `X-Correlation-Id` on the response and logs the request line. Drop `express-bunyan-logger` / restify's `auditLogger` to avoid a second access line.
- Outgoing calls: `fetchWithCorrelation(url, init)`, or for axios `axios.interceptors.request.use(withCorrelationHeader)`.
- Jobs and consumers: `withCorrelationId(msg.headers["x-correlation-id"], () => handle(msg))`.

## 3. JSON output (`src/logging/bunyan.ts`)
```ts
import bunyan from "bunyan";
import { currentCorrelationId, formatPretty, REPEAT_WINDOW_MS, sanitize, toError, type TaggedLogger } from "./core";

const LEVELS: Record<number, string> = { 10: "debug", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "error" };
const CORE = new Set(["v", "level", "name", "hostname", "pid", "time", "msg", "src", "err",
  "service", "logger", "component", "correlationId", "req_id", "tags", "context", "durationMs", "error"]);

/** bunyan record -> convention entry. */
export function toEntry(rec: Record<string, any>, service: string): Record<string, unknown> {
  const extra = Object.fromEntries(Object.entries(rec).filter(([k]) => !CORE.has(k)));   // legacy fields
  const context = { ...extra, ...(rec.context ?? {}) };
  const entry: Record<string, unknown> = {
    timestamp: (rec.time instanceof Date ? rec.time : new Date(rec.time)).toISOString(),
    level: LEVELS[rec.level] ?? "info",
    service,
    logger: rec.logger ?? rec.component ?? rec.name,
    correlationId: rec.correlationId ?? rec.req_id ?? currentCorrelationId() ?? "none",
    tags: Array.isArray(rec.tags) && rec.tags.length ? rec.tags : ["legacy"],            // section 6
    message: rec.msg,
  };
  if (Object.keys(context).length) entry.context = sanitize(context);                   // redaction + size limits
  if (typeof rec.durationMs === "number") entry.durationMs = rec.durationMs;
  const err = rec.error ?? rec.err;            // raw Error, or the bunyan.stdSerializers.err shape
  if (err) entry.error = err instanceof Error ? toError(err) : { type: err.type ?? err.name ?? "Error", message: err.message, stack: err.stack };
  return entry;
}

/** Raw stream: receives the record object (time is a Date), synchronously, in the caller's ALS context. */
export function conventionStream(service: string, pretty: boolean, out: NodeJS.WritableStream = process.stdout) {
  return {
    type: "raw" as const,
    stream: { write: (rec: object) => { const e = toEntry(rec as Record<string, any>, service); out.write((pretty ? formatPretty(e) : JSON.stringify(e)) + "\n"); } },
  };
}

const service = "orders";
const pretty = process.env.NODE_ENV === "development" || process.env.LOG_PRETTY === "1";

export const baseLogger = bunyan.createLogger({   // replaces the project's existing createLogger(...)
  name: service,                                  // used as `logger` when no child sets logger/component
  level: (process.env.LOG_LEVEL ?? "info") as bunyan.LogLevel,
  serializers: bunyan.stdSerializers,             // keep the project's own serializers here
  streams: [conventionStream(service, pretty)],   // file targets: pass a file WriteStream as `out`
});
```
- Replace every existing entry in `streams` with `conventionStream(...)`. For a rotating file, pass that file's write stream as `out`. Any `{ stream: process.stdout }` or `{ path }` entry left behind would still write bunyan's native shape.
- Keep the existing exported instance name (`export const log = baseLogger`), so old imports keep working.

## 4. Dev pretty output
Pretty output comes from the same stream with `pretty = true`, which `NODE_ENV=development` or `LOG_PRETTY=1` turns on. It calls the sample's `formatPretty`. Remove `| bunyan -o short` and `bunyan-format` from the npm scripts. Verified output:
```
04:52:41.061 INFO  [cid=none] [auth,login] Login success userId=42 (12ms)
04:52:41.062 ERROR [cid=none] [db] Query failed table=users error=TypeError: bad column
04:52:41.079 INFO  [cid=7f3a91c2] [http] Request finished method=GET path=/a status=200 (5ms)
```

## 5. Tagged wrapper
```ts
type Context = Record<string, unknown>;
type Level = "debug" | "info" | "warn" | "error";
const repeats = new Map<string, { since: number; suppressed: number }>();

/** Same rule as createLogger() in the sample: one identical error per logger per window. */
function suppressRepeat(key: string, ctx: Context): boolean {
  const now = Date.now(), seen = repeats.get(key);
  if (seen && now - seen.since < REPEAT_WINDOW_MS) { seen.suppressed++; return true; }
  if (seen?.suppressed) ctx.repeated = seen.suppressed;
  repeats.set(key, { since: now, suppressed: 0 });
  return false;
}

export function getLogger(name: string): TaggedLogger {
  const b = baseLogger.child({ logger: name });
  const write = (level: Level, tags: string[], message: string, context: Context = {}, error?: unknown) => {
    if (!Array.isArray(tags) || tags.length === 0) throw new Error("log entries need at least one tag");
    if (!b[level]()) return;                        // bunyan: log.info() without args = "is info enabled?"
    const { durationMs, ...rest } = context;
    if (level === "error" && suppressRepeat(`${name}|${message}`, rest)) return;
    b[level]({
      tags,
      ...(Object.keys(rest).length ? { context: rest } : {}),
      ...(typeof durationMs === "number" ? { durationMs } : {}),
      ...(error !== undefined ? { error: toError(error) } : {}),
    }, "%s", message);                              // "%s": `message` is never printf-interpolated
  };
  return {
    debug: (tags, message, context) => write("debug", tags, message, context),
    info: (tags, message, context) => write("info", tags, message, context),
    warn: (tags, message, context) => write("warn", tags, message, context),
    error: (tags, message, error, context) => write("error", tags, message, context, error),
    child: (other) => getLogger(other),
  };
}
```
Usage: `const log = getLogger("OrderService"); log.info(["order"], "Order created", { orderId, durationMs: 12 });`.

## 6. Legacy calls become tag `legacy`
The raw stream handles this, so no call site changes. Verified mappings:

| Existing call | Entry |
|---|---|
| `log.info("plain")` | `tags:["legacy"]`, `logger:"<createLogger name>"` |
| `log.warn({ userId: 7 }, "msg")` | `context:{userId:7}` |
| `log.error(err, "failed")` / `log.error(err)` | `error:{type,message,stack}`. Without a message, `message` is `err.message` |
| `log.info("user %s did %d", "bob", 3)` | `"user bob did 3"` |
| `log.child({ component: "billing" }).info(...)` | `logger:"billing"` |
| `log.info({ req_id: "…" }, ...)` (restify) | `correlationId` is that `req_id` |
| `log.info({ token: "abc" }, "x")` | `context:{token:"[redacted]"}` |

`hostname` and `pid` are dropped because they are not convention fields. The log shipper or container metadata identifies the host.

## 7. Ban raw logging (ESLint flat config)
```js
// eslint.config.js
const msg = "Use getLogger(name) from src/logging: entries need tags and correlationId.";
export default [
  {
    files: ["src/**/*.{js,ts}"],
    rules: {
      "no-console": "error",
      "no-restricted-imports": ["error", {
        paths: [{ name: "bunyan", message: msg }],
        patterns: [{ regex: "(^|/)logger(\\.[jt]s)?$", importNames: ["default", "log", "logger"], message: msg }], // old instance
      }],
    },
  },
  { files: ["src/logging/**"], rules: { "no-restricted-imports": "off" } },
];
```
Existing violations: run `npx eslint . --suppress-all` once (ESLint 9.24+ (verify) — tested on 9.39). It writes `eslint-suppressions.json`, so old files pass and new violations fail. After you convert files, run `--prune-suppressions`. `req.log` (restify) is not an import, so it isn't banned. Convert it to `getLogger(...)` whenever the AI touches that handler.

## 8. Checklist
- [ ] `logging_set_project` is recorded: library `bunyan`, entry point `src/logging/bunyan.ts`.
- [ ] `bunyan` is the only logger dependency. `bunyan-format`/`bunyan-pretty` are removed from scripts.
- [ ] Production: each line parses as JSON with exactly `timestamp, level, service, logger, correlationId, tags, message` (+ `context`, `durationMs`, `error`). There is no numeric `level` and no `msg`, `time`, `v`, `hostname` or `pid`.
- [ ] Every entry in `streams` is a `conventionStream`.
- [ ] `curl -H "X-Correlation-Id: test-12345678" …` puts that id on every line of the request, legacy lines included, and on the response header. Without the header a UUIDv7 is generated and forwarded.
- [ ] `LOG_PRETTY=1` prints the pretty line shown above.
- [ ] An untouched `log.info("x")` prints `tags:["legacy"]`.
- [ ] `context.password` is `[redacted]`. The same error twice within 60 s prints once. `debug` is silent at `LOG_LEVEL=info`.
- [ ] The ESLint rule fails on a new `import bunyan from "bunyan"` outside `src/logging/`.
