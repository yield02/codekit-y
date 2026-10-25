import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { codekitHome } from "./paths.js";

// Logs follow the kit's own logging convention: one JSON line per entry with a
// mandatory correlationId and tags. Never write to stdout: MCP (stdio) and hook
// output channels own it.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  correlationId: string;
  tags: string[];
  message: string;
  context?: Record<string, unknown>;
  error?: { type: string; message: string; stack?: string };
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const correlationStore = new AsyncLocalStorage<string>();

/** UUIDv7: 48-bit unix ms timestamp + random bits, so ids sort by time. */
export function newCorrelationId(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function withCorrelation<T>(correlationId: string | undefined, fn: () => T): T {
  return correlationStore.run(correlationId ?? newCorrelationId(), fn);
}

export function currentCorrelationId(): string {
  return correlationStore.getStore() ?? "no-correlation";
}

export function formatPretty(entry: LogEntry): string {
  const time = entry.timestamp.slice(11, 23);
  const cid = entry.correlationId.slice(-8);
  const ctx = entry.context
    ? " " + Object.entries(entry.context).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")
    : "";
  const err = entry.error ? ` error=${entry.error.type}: ${entry.error.message}` : "";
  return `${time} ${entry.level.toUpperCase().padEnd(5)} [cid=${cid}] [${entry.tags.join(",")}] ${entry.message}${ctx}${err}`;
}

export class Logger {
  constructor(
    private readonly service: string,
    private readonly minLevel: LogLevel = (process.env.CODEKIT_LOG_LEVEL as LogLevel) || "info",
  ) {}

  debug(tags: string[], message: string, context?: Record<string, unknown>): void {
    this.write("debug", tags, message, context);
  }
  info(tags: string[], message: string, context?: Record<string, unknown>): void {
    this.write("info", tags, message, context);
  }
  warn(tags: string[], message: string, context?: Record<string, unknown>): void {
    this.write("warn", tags, message, context);
  }
  error(tags: string[], message: string, err?: unknown, context?: Record<string, unknown>): void {
    this.write("error", tags, message, context, err);
  }

  private write(level: LogLevel, tags: string[], message: string, context?: Record<string, unknown>, err?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    if (tags.length === 0) throw new Error("Log entries must have at least one tag");
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      correlationId: currentCorrelationId(),
      tags,
      message,
      ...(context ? { context } : {}),
      ...(err !== undefined ? { error: toErrorInfo(err) } : {}),
    };
    try {
      const dir = join(codekitHome(), "logs");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `codekit-${entry.timestamp.slice(0, 10)}.log`), JSON.stringify(entry) + "\n");
    } catch {
      // Logging must never break the caller.
    }
    if (process.env.CODEKIT_LOG_PRETTY === "1") process.stderr.write(formatPretty(entry) + "\n");
  }
}

function toErrorInfo(err: unknown): LogEntry["error"] {
  if (err instanceof Error) return { type: err.name, message: err.message, stack: err.stack };
  return { type: typeof err, message: String(err) };
}

export function createLogger(service: string): Logger {
  return new Logger(service);
}
