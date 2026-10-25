// codekit logging sample for Node.js / TypeScript (pino).
// Copy into the project and rename to match its naming convention.
//
// - Every entry: timestamp, level, service, correlationId, tags[], message (+ context, durationMs, error)
// - correlationId: X-Correlation-Id header > OpenTelemetry traceId > new UUIDv7, kept in AsyncLocalStorage
// - Production: one JSON object per line. Development (NODE_ENV=development or LOG_PRETTY=1): pretty lines
//     09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import pino from "pino";

export const CORRELATION_HEADER = "x-correlation-id";

// ---------------------------------------------------------------- correlation id

const store = new AsyncLocalStorage<{ correlationId: string }>();

/** UUIDv7: 48-bit unix ms timestamp, version 7, variant 10, random rest. Sortable by time. */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** OpenTelemetry trace id when @opentelemetry/api is installed and a span is active. */
let otelTraceId: () => string | undefined = () => undefined;
try {
  const { createRequire } = await import("node:module");
  const api = createRequire(import.meta.url)("@opentelemetry/api");
  otelTraceId = () => {
    const ctx = api.trace.getActiveSpan()?.spanContext();
    return ctx && api.isSpanContextValid(ctx) ? ctx.traceId : undefined;
  };
} catch {
  // OpenTelemetry not installed
}

export function currentCorrelationId(): string | undefined {
  return store.getStore()?.correlationId;
}

/** Run `fn` with a correlation id (incoming value, OTel trace id, or a new UUIDv7). */
export function withCorrelationId<T>(incoming: string | undefined | null, fn: () => T): T {
  const id = (incoming && /^[\w.:-]{8,128}$/.test(incoming) ? incoming : undefined) ?? otelTraceId() ?? uuidv7();
  return store.run({ correlationId: id }, fn);
}

// ---------------------------------------------------------------- logger

type Context = Record<string, unknown>;

export interface TaggedLogger {
  debug(tags: string[], message: string, context?: Context): void;
  info(tags: string[], message: string, context?: Context): void;
  warn(tags: string[], message: string, context?: Context): void;
  error(tags: string[], message: string, error?: unknown, context?: Context): void;
  /** Same logger for another module/class: fills the `logger` field. */
  child(logger: string): TaggedLogger;
}

// ---------------------------------------------------------------- noise and safety limits

const SECRET_KEY = /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|card/i;
const MAX_STRING = 500;
const MAX_ARRAY = 20;
const MAX_DEPTH = 3;
const MAX_KEYS = 20;
export const REPEAT_WINDOW_MS = 60_000;

/** Redact secrets and bound sizes so a log line never carries payloads or credentials. */
export function sanitize(value: unknown, depth = 0, key = ""): unknown {
  if (key && SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING})` : value;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[array(${value.length})]` : "[object]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, depth + 1));
    return value.length > MAX_ARRAY ? [...items, `…(+${value.length - MAX_ARRAY})`] : items;
  }
  const entries = Object.entries(value as Context);
  const out: Context = {};
  for (const [k, v] of entries.slice(0, MAX_KEYS)) out[k] = sanitize(v, depth + 1, k);
  if (entries.length > MAX_KEYS) out["…"] = `+${entries.length - MAX_KEYS} keys`;
  return out;
}

const LEVEL_LABEL: Record<number, string> = { 10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL" };

/** pino JSON line -> `09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] message k=v (12ms)` */
export function formatPretty(line: Record<string, unknown>): string {
  const time = String(line.timestamp ?? "").slice(11, 23);
  const level = (typeof line.level === "number" ? LEVEL_LABEL[line.level] : String(line.level).toUpperCase()) ?? "INFO";
  const cid = String(line.correlationId ?? "-").slice(-8);
  const tags = Array.isArray(line.tags) ? line.tags.join(",") : "";
  const ctx = line.context && typeof line.context === "object"
    ? Object.entries(line.context as Context).map(([k, v]) => ` ${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join("")
    : "";
  const duration = typeof line.durationMs === "number" ? ` (${line.durationMs}ms)` : "";
  const err = line.error && typeof line.error === "object" ? ` error=${(line.error as { type?: string }).type}: ${(line.error as { message?: string }).message}` : "";
  return `${time} ${level.padEnd(5)} [cid=${cid}] [${tags}] ${line.message ?? ""}${ctx}${duration}${err}`;
}

function prettyStream(out: NodeJS.WritableStream = process.stdout): Writable {
  return new Writable({
    write(chunk, _enc, done) {
      for (const raw of chunk.toString().split("\n").filter(Boolean)) {
        try {
          out.write(formatPretty(JSON.parse(raw)) + "\n");
        } catch {
          out.write(raw + "\n");
        }
      }
      done();
    },
  });
}

export interface LoggerOptions {
  service: string;
  /** Module/class name for the `logger` field (use child() for others). */
  logger?: string;
  level?: string;
  pretty?: boolean;
  /** Custom destination (tests). */
  destination?: NodeJS.WritableStream;
}

export function createLogger(opts: LoggerOptions): TaggedLogger {
  const pretty = opts.pretty ?? (process.env.NODE_ENV === "development" || process.env.LOG_PRETTY === "1");
  const destination = pretty ? prettyStream(opts.destination) : (opts.destination ?? process.stdout);
  const base = pino(
    {
      level: opts.level ?? process.env.LOG_LEVEL ?? "info",
      base: { service: opts.service },
      messageKey: "message",
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: { level: (label) => ({ level: label }) },
      mixin: () => ({ correlationId: currentCorrelationId() ?? "none" }),
    },
    destination as pino.DestinationStream,
  );

  // The same error from the same logger is written once per window; the next write carries the count.
  const repeats = new Map<string, { since: number; suppressed: number }>();

  const make = (loggerName: string): TaggedLogger => {
    const write = (level: "debug" | "info" | "warn" | "error", tags: string[], message: string, context?: Context, error?: unknown) => {
      if (!Array.isArray(tags) || tags.length === 0) throw new Error("log entries need at least one tag");
      if (!base.isLevelEnabled(level)) return;
      const { durationMs, ...rest } = context ?? {};
      if (level === "error") {
        const key = `${loggerName}|${message}`;
        const now = Date.now();
        const seen = repeats.get(key);
        if (seen && now - seen.since < REPEAT_WINDOW_MS) {
          seen.suppressed++;
          return;
        }
        if (seen?.suppressed) rest.repeated = seen.suppressed;
        repeats.set(key, { since: now, suppressed: 0 });
      }
      base[level]({
        logger: loggerName,
        tags,
        ...(Object.keys(rest).length ? { context: sanitize(rest) } : {}),
        ...(typeof durationMs === "number" ? { durationMs } : {}),
        ...(error !== undefined ? { error: toError(error) } : {}),
      }, message);
    };
    return {
      debug: (tags, message, context) => write("debug", tags, message, context),
      info: (tags, message, context) => write("info", tags, message, context),
      warn: (tags, message, context) => write("warn", tags, message, context),
      error: (tags, message, error, context) => write("error", tags, message, context, error),
      child: (name) => make(name),
    };
  };
  return make(opts.logger ?? opts.service);
}

/** type, message and the stack including the `cause` chain. */
export function toError(err: unknown): { type: string; message: string; stack?: string } {
  if (!(err instanceof Error)) return { type: typeof err, message: String(err) };
  let stack = err.stack ?? "";
  let cause = (err as { cause?: unknown }).cause;
  for (let depth = 0; cause instanceof Error && depth < 5; depth++) {
    stack += `\nCaused by: ${cause.stack ?? `${cause.name}: ${cause.message}`}`;
    cause = (cause as { cause?: unknown }).cause;
  }
  return { type: err.name, message: err.message, stack };
}

// ---------------------------------------------------------------- HTTP in / out

interface Req { method?: string; url?: string; originalUrl?: string; headers: Record<string, string | string[] | undefined> }
interface Res { statusCode: number; setHeader(name: string, value: string): unknown; on(event: "finish", cb: () => void): unknown }

/**
 * Express/Connect-style middleware (also works with plain node:http handlers).
 * One `info` line per request; `warn` when slower than `slowMs`. "Request started" is debug only.
 * Disable the framework's own access log so requests are not logged twice.
 */
export function correlationMiddleware(log: TaggedLogger, opts: { slowMs?: number } = {}) {
  const slowMs = opts.slowMs ?? 1000;
  const http = log.child("http");
  return (req: Req, res: Res, next: () => void): void => {
    const header = req.headers[CORRELATION_HEADER];
    withCorrelationId(Array.isArray(header) ? header[0] : header, () => {
      const started = performance.now();
      res.setHeader("X-Correlation-Id", currentCorrelationId()!);
      const path = (req.originalUrl ?? req.url ?? "").split("?")[0]; // no query strings: they often carry tokens
      http.debug(["http"], "Request started", { method: req.method, path });
      res.on("finish", () => {
        const durationMs = Math.round(performance.now() - started);
        const ctx = { method: req.method, path, status: res.statusCode, durationMs };
        if (durationMs > slowMs) http.warn(["http"], "Slow request", { ...ctx, slowMs });
        else http.info(["http"], "Request finished", ctx);
      });
      next();
    });
  };
}

/** fetch() that forwards the current correlation id. */
export function fetchWithCorrelation(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const id = currentCorrelationId();
  if (id && !headers.has(CORRELATION_HEADER)) headers.set("X-Correlation-Id", id);
  return fetch(input, { ...init, headers });
}

/** For axios: `axios.interceptors.request.use(withCorrelationHeader)` */
export function withCorrelationHeader<T extends { headers?: Record<string, unknown> }>(config: T): T {
  const id = currentCorrelationId();
  if (id) config.headers = { ...(config.headers ?? {}), "X-Correlation-Id": id };
  return config;
}
