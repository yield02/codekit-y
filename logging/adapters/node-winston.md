# Adopting the convention in a winston project

Reuse from `logging/node/src/logging.ts`: copy it into the logging folder as `core.ts`. Then make these edits only:
- delete `import { Writable } from "node:stream"`, `import pino from "pino"`, `prettyStream`, `LoggerOptions` and `createLogger`;
- (`toError` and `REPEAT_WINDOW_MS` are already exported by the reference file.)

Everything else stays as it is: `uuidv7`, `withCorrelationId`, `currentCorrelationId`, the `TaggedLogger` interface, `sanitize`, `formatPretty`, `correlationMiddleware`, `fetchWithCorrelation` and `withCorrelationHeader`. Don't install pino. winston stays the only logging library.

## 1. When this applies
- `package.json` has `winston` 3.x. You may also see `winston-daily-rotate-file`, `express-winston`, `nest-winston` or `winston-transport`.
- Code: `winston.createLogger(`, `format.combine(`, `new transports.Console/File(`, and a shared `logger.ts`/`logger.js` that exports the instance.
- winston 2.x (`new winston.Logger(...)`, no `format`) is out of scope. Upgrade to 3.x first, or follow `in-house.md`.
- `nest-winston` (verify): pass the same `level`/`defaultMeta`/`format`/`transports` to `WinstonModule.forRoot(...)`. `express-winston`: drop its request logger. `correlationMiddleware` already writes one line per request.

## 2. correlationId
- `defaultMeta` getters run inside `logger.info()`/`logger.log()`, in the caller's AsyncLocalStorage context. That way legacy calls also get the id, without any change at the call site. The format falls back to `currentCorrelationId()` as well.
- Wire `correlationMiddleware(getLogger("app"))` as the **first** middleware. It sets `X-Correlation-Id` on the response and logs the request line through the wrapper below.
- Outgoing calls: `fetchWithCorrelation(url, init)`, or for axios `axios.interceptors.request.use(withCorrelationHeader)`.
- Jobs and consumers: `withCorrelationId(msg.headers["x-correlation-id"], () => handle(msg))`.
- Existing `logger.child({ requestId })` code keeps working. When the project already has a request-id middleware, replace it with `correlationMiddleware` rather than running both.

## 3. JSON output (`src/logging/winston.ts`)
```ts
import winston from "winston";
import { currentCorrelationId, formatPretty, REPEAT_WINDOW_MS, sanitize, toError, type TaggedLogger } from "./core";

const LEVEL = Symbol.for("level"), MESSAGE = Symbol.for("message"), SPLAT = Symbol.for("splat");
const LEVELS: Record<string, string> = { error: "error", warn: "warn", info: "info", http: "info", verbose: "debug", debug: "debug", silly: "debug" };
const OWN = new Set(["timestamp", "level", "service", "logger", "module", "component", "label", "correlationId",
  "tags", "message", "context", "durationMs", "error", "stack", "cause"]);

/** Any winston `info` (wrapper or legacy call) -> one convention entry. */
export const conventionFormat = winston.format((info, opts: { pretty?: boolean }) => {
  const i = info as Record<string | symbol, any>;
  const err = info instanceof Error ? info : (i[SPLAT] as unknown[] | undefined)?.find((a) => a instanceof Error);
  const extra = Object.fromEntries(Object.entries(i).filter(([k]) => !OWN.has(k)));   // legacy meta
  const context = { ...extra, ...(i.context ?? {}) };
  const entry: Record<string, unknown> = {
    timestamp: i.timestamp ?? new Date().toISOString(),
    level: LEVELS[i[LEVEL] ?? i.level] ?? "info",
    service: i.service,
    logger: i.logger ?? i.module ?? i.component ?? i.label ?? "root",
    correlationId: i.correlationId ?? currentCorrelationId() ?? "none",
    tags: Array.isArray(i.tags) && i.tags.length ? i.tags : ["legacy"],                 // section 6
    message: typeof i.message === "string" ? i.message : JSON.stringify(i.message),
  };
  if (Object.keys(context).length) entry.context = sanitize(context);                 // redaction + size limits
  if (typeof i.durationMs === "number") entry.durationMs = i.durationMs;
  if (i.error) entry.error = i.error;
  else if (err) entry.error = toError(err);
  else if (i.stack) entry.error = { type: "Error", message: String(i.message), stack: i.stack };
  i[MESSAGE] = opts.pretty ? formatPretty(entry) : JSON.stringify(entry);
  return info;
});

const pretty = process.env.NODE_ENV === "development" || process.env.LOG_PRETTY === "1";

export const baseLogger = winston.createLogger({         // replaces the project's existing createLogger(...)
  level: process.env.LOG_LEVEL ?? "info",
  defaultMeta: {
    service: "orders",
    get timestamp() { return new Date().toISOString(); },
    get correlationId() { return currentCorrelationId() ?? "none"; },
  },
  format: winston.format.combine(winston.format.splat(), conventionFormat({ pretty })),
  transports: [new winston.transports.Console()],
});
```
- Keep the existing transports (File, DailyRotateFile, etc.) but **delete their `format:` option**. A transport format runs after the logger format and would overwrite `info[MESSAGE]`.
- Remove `format.timestamp()`, `format.json()`, `format.simple()`, `format.colorize()`, `format.printf()` and `format.errors()` from the old chain. The convention format does their work.
- Keep the existing `module.exports = logger` / `export default logger` and point it at `baseLogger`, so old imports keep working.

## 4. Dev pretty output
Pretty output comes from the same format with `{ pretty: true }`, which `NODE_ENV=development` or `LOG_PRETTY=1` turns on. It calls the sample's `formatPretty`, so nothing else is needed. Verified output:
```
04:52:26.780 INFO  [cid=none] [auth,login] Login success userId=42 (12ms)
04:52:26.781 ERROR [cid=none] [db] Query failed table=users error=TypeError: bad column
04:52:26.798 INFO  [cid=7f3a91c2] [http] Request finished method=GET path=/a status=200 (7ms)
```
Don't add `colorize()`. The line has to stay exactly in this shape.

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
  const w = baseLogger.child({ logger: name });
  const write = (level: Level, tags: string[], message: string, context: Context = {}, error?: unknown) => {
    if (!Array.isArray(tags) || tags.length === 0) throw new Error("log entries need at least one tag");
    if (!baseLogger.isLevelEnabled(level)) return;
    const { durationMs, ...rest } = context;
    if (level === "error" && suppressRepeat(`${name}|${message}`, rest)) return;
    w.log({                                         // object form: `message` is never %-interpolated
      level, message, tags,
      ...(Object.keys(rest).length ? { context: rest } : {}),
      ...(typeof durationMs === "number" ? { durationMs } : {}),
      ...(error !== undefined ? { error: toError(error) } : {}),
    });
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
The format handles this, so no call site changes. Verified mappings:

| Existing call | Entry |
|---|---|
| `logger.info("plain")` | `tags:["legacy"]`, `logger:"root"` |
| `logger.warn("msg", { userId: 7 })` | `context:{userId:7}` |
| `logger.error("failed", err)` | `message:"failed <err.message>"` (winston appends it), `error:{type,message,stack}` |
| `logger.error(err)` | `message: err.message`, `error` filled |
| `logger.info("user %s did %d", "bob", 3)` | `"user bob did 3"` (needs `format.splat()`, which is kept) |
| `logger.child({ module: "billing" }).info(...)` | `logger:"billing"` (`module`/`component`/`label` are used as `logger`) |
| `logger.info("x", { token: "abc" })` | `context:{token:"[redacted]"}` |

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
        paths: [{ name: "winston", message: msg }],
        patterns: [{ regex: "(^|/)logger(\\.[jt]s)?$", importNames: ["default", "logger"], message: msg }], // old instance module
      }],
    },
  },
  { files: ["src/logging/**"], rules: { "no-restricted-imports": "off" } },
];
```
Existing violations: run `npx eslint . --suppress-all` once (ESLint 9.24+ (verify) — tested on 9.39). It writes `eslint-suppressions.json`, so old files pass and any **new** violation fails, including one more in an already-suppressed file. When you convert a file, run `npx eslint . --prune-suppressions`.

## 8. Checklist
- [ ] `logging_set_project` is recorded: library `winston`, entry point `src/logging/winston.ts`.
- [ ] `winston` is the only logger dependency. No pino, no second instance.
- [ ] Production: each line parses as JSON with exactly `timestamp, level, service, logger, correlationId, tags, message` (+ `context`, `durationMs`, `error`). Levels are only `debug|info|warn|error`.
- [ ] No transport has its own `format`. A File transport writes the same JSON as the Console.
- [ ] `curl -H "X-Correlation-Id: test-12345678" …` puts that id on every line of the request, legacy lines included, and on the response header. Without the header a UUIDv7 is generated and forwarded by `fetchWithCorrelation`/axios.
- [ ] `LOG_PRETTY=1` prints the pretty line shown above.
- [ ] An untouched `logger.info("x")` prints `tags:["legacy"]`.
- [ ] `context.password` is `[redacted]`. The same error twice within 60 s prints once.
- [ ] The ESLint rule fails on a new `import winston from "winston"` outside `src/logging/`.
