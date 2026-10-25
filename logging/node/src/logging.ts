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

  const write = (level: "debug" | "info" | "warn" | "error", tags: string[], message: string, context?: Context, error?: unknown) => {
    if (!Array.isArray(tags) || tags.length === 0) throw new Error("log entries need at least one tag");
    const { durationMs, ...rest } = context ?? {};
    base[level]({
      tags,
      ...(Object.keys(rest).length ? { context: rest } : {}),
      ...(typeof durationMs === "number" ? { durationMs } : {}),
      ...(error !== undefined ? { error: toError(error) } : {}),
    }, message);
  };

  return {
    debug: (tags, message, context) => write("debug", tags, message, context),
    info: (tags, message, context) => write("info", tags, message, context),
    warn: (tags, message, context) => write("warn", tags, message, context),
    error: (tags, message, error, context) => write("error", tags, message, context, error),
  };
}

function toError(err: unknown): { type: string; message: string; stack?: string } {
  return err instanceof Error ? { type: err.name, message: err.message, stack: err.stack } : { type: typeof err, message: String(err) };
}

// ---------------------------------------------------------------- HTTP in / out

interface Req { method?: string; url?: string; originalUrl?: string; headers: Record<string, string | string[] | undefined> }
interface Res { statusCode: number; setHeader(name: string, value: string): unknown; on(event: "finish", cb: () => void): unknown }

/** Express/Connect-style middleware (also works with plain node:http handlers). */
export function correlationMiddleware(log: TaggedLogger) {
  return (req: Req, res: Res, next: () => void): void => {
    const header = req.headers[CORRELATION_HEADER];
    withCorrelationId(Array.isArray(header) ? header[0] : header, () => {
      const started = performance.now();
      res.setHeader("X-Correlation-Id", currentCorrelationId()!);
      const path = req.originalUrl ?? req.url ?? "";
      log.info(["http"], "Request started", { method: req.method, path });
      res.on("finish", () => {
        log.info(["http"], "Request finished", { method: req.method, path, status: res.statusCode, durationMs: Math.round(performance.now() - started) });
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
