// Reader for logs written to the codekit logging convention (any stack: they share the
// field names). Filters, request timelines and a noise report to spot over-logging.

export interface ParsedLog {
  timestamp: string;
  level: string;
  service?: string;
  logger?: string;
  correlationId?: string;
  tags: string[];
  message: string;
  context?: Record<string, unknown>;
  durationMs?: number;
  error?: { type?: string; message?: string; stack?: string };
  bytes: number;
}

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];
const NUMERIC_LEVEL: Record<number, string> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };

export function parseLogLine(raw: string): ParsedLog | null {
  const text = raw.trim();
  if (!text.startsWith("{")) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const levelRaw = o.level ?? o.severity ?? o["@l"];
  const level = typeof levelRaw === "number" ? NUMERIC_LEVEL[levelRaw] ?? "info" : String(levelRaw ?? "info").toLowerCase().replace("warning", "warn").replace("information", "info");
  return {
    timestamp: String(o.timestamp ?? o.time ?? o["@t"] ?? ""),
    level,
    ...(o.service ? { service: String(o.service) } : {}),
    ...(o.logger ? { logger: String(o.logger) } : {}),
    ...(o.correlationId ? { correlationId: String(o.correlationId) } : {}),
    tags: Array.isArray(o.tags) ? o.tags.map(String) : typeof o.tags === "string" ? o.tags.split(",") : [],
    message: String(o.message ?? o.msg ?? ""),
    ...(o.context && typeof o.context === "object" ? { context: o.context as Record<string, unknown> } : {}),
    ...(typeof o.durationMs === "number" ? { durationMs: o.durationMs } : {}),
    ...(o.error && typeof o.error === "object" ? { error: o.error as ParsedLog["error"] } : {}),
    bytes: Buffer.byteLength(text),
  };
}

export interface LogFilter {
  cid?: string;
  tags?: string[];
  level?: string;
  logger?: string;
  grep?: string;
  /** ISO timestamp or relative: `15m`, `2h`, `1d` */
  since?: string;
  service?: string;
}

export function sinceToIso(since: string, now = Date.now()): string {
  const rel = /^(\d+)\s*([smhd])$/.exec(since.trim());
  if (!rel) return new Date(since).toISOString();
  const ms = Number(rel[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "s" | "m" | "h" | "d"];
  return new Date(now - ms).toISOString();
}

export function matches(log: ParsedLog, f: LogFilter, sinceIso?: string): boolean {
  if (f.cid) {
    const cid = log.correlationId ?? "";
    if (!(cid === f.cid || (f.cid.length >= 6 && cid.endsWith(f.cid)))) return false;
  }
  if (f.tags?.length && !f.tags.some((t) => log.tags.includes(t))) return false;
  if (f.level && LEVELS.indexOf(log.level) < LEVELS.indexOf(f.level.toLowerCase())) return false;
  if (f.logger && !(log.logger ?? "").toLowerCase().includes(f.logger.toLowerCase())) return false;
  if (f.service && log.service !== f.service) return false;
  if (sinceIso && log.timestamp && log.timestamp < sinceIso) return false;
  if (f.grep) {
    const q = f.grep.toLowerCase();
    const hay = `${log.message} ${log.context ? JSON.stringify(log.context) : ""} ${log.error?.message ?? ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

const COLORS: Record<string, string> = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m", fatal: "\x1b[35m" };
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export interface FormatOptions {
  color?: boolean;
  showLogger?: boolean;
  showStack?: boolean;
  /** `+12ms` relative to this timestamp (trace mode). */
  relativeTo?: string;
}

/** Same layout as the convention's dev line, plus optional logger/stack. */
export function formatLog(log: ParsedLog, o: FormatOptions = {}): string {
  const time = o.relativeTo ? `+${Math.max(0, Date.parse(log.timestamp) - Date.parse(o.relativeTo))}ms`.padStart(8) : log.timestamp.slice(11, 23);
  const lvl = log.level.toUpperCase().padEnd(5);
  const level = o.color ? `${COLORS[log.level] ?? ""}${lvl}${RESET}` : lvl;
  const cid = `[cid=${(log.correlationId ?? "none").slice(-8)}]`;
  const who = o.showLogger && (log.logger || log.service) ? ` ${o.color ? DIM : ""}${[log.service, log.logger].filter(Boolean).join("/")}${o.color ? RESET : ""}` : "";
  const ctx = log.context ? Object.entries(log.context).map(([k, v]) => ` ${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join("") : "";
  const dur = log.durationMs !== undefined ? ` (${log.durationMs}ms)` : "";
  const err = log.error ? ` error=${log.error.type}: ${log.error.message}` : "";
  const stack = o.showStack && log.error?.stack ? `\n${log.error.stack.split("\n").map((l) => `      ${l}`).join("\n")}` : "";
  return `${time} ${level} ${cid}${who} [${log.tags.join(",")}] ${log.message}${ctx}${dur}${err}${stack}`;
}

export interface NoiseReport {
  lines: number;
  bytes: number;
  byLevel: Record<string, number>;
  topMessages: { key: string; count: number; share: number; bytes: number }[];
  topLoggers: { logger: string; count: number; share: number }[];
  untagged: number;
  legacy: number;
  withoutCorrelation: number;
  requests: number;
  linesPerRequest: number | null;
  hints: string[];
}

/** Where the volume comes from, and what looks like over-logging. */
export function noiseReport(logs: ParsedLog[], top = 10): NoiseReport {
  const byLevel: Record<string, number> = {};
  const msg = new Map<string, { count: number; bytes: number }>();
  const lg = new Map<string, number>();
  const cids = new Set<string>();
  const errors = new Map<string, number>();
  let bytes = 0, untagged = 0, legacy = 0, without = 0;
  for (const l of logs) {
    bytes += l.bytes;
    byLevel[l.level] = (byLevel[l.level] ?? 0) + 1;
    const key = `${l.logger ?? l.service ?? "?"} | ${l.message}`;
    const m = msg.get(key) ?? { count: 0, bytes: 0 };
    m.count++;
    m.bytes += l.bytes;
    msg.set(key, m);
    if (l.level === "error" || l.level === "fatal") errors.set(key, (errors.get(key) ?? 0) + 1);
    lg.set(l.logger ?? "?", (lg.get(l.logger ?? "?") ?? 0) + 1);
    if (!l.tags.length) untagged++;
    if (l.tags.includes("legacy")) legacy++;
    if (!l.correlationId || l.correlationId === "none") without++;
    else cids.add(l.correlationId);
  }
  const n = logs.length || 1;
  const topMessages = [...msg].sort((a, b) => b[1].count - a[1].count).slice(0, top).map(([key, v]) => ({ key, count: v.count, share: Math.round((v.count / n) * 100), bytes: v.bytes }));
  const topLoggers = [...lg].sort((a, b) => b[1] - a[1]).slice(0, top).map(([logger, count]) => ({ logger, count, share: Math.round((count / n) * 100) }));
  const linesPerRequest = cids.size ? Math.round(((logs.length - without) / cids.size) * 10) / 10 : null;

  const hints: string[] = [];
  const first = topMessages[0];
  if (first && first.share >= 30 && logs.length >= 50) hints.push(`"${first.key}" is ${first.share}% of all lines: likely logged in a loop or per item — log one summary instead.`);
  if ((byLevel.debug ?? 0) / n > 0.3) hints.push(`${Math.round(((byLevel.debug ?? 0) / n) * 100)}% debug lines: debug should be off in production (enable per logger while investigating).`);
  if (linesPerRequest !== null && linesPerRequest > 6) hints.push(`${linesPerRequest} lines per request on average: target is 1–3 info lines for a healthy request.`);
  const bigLines = topMessages.filter((m) => m.count && m.bytes / m.count > 2000);
  for (const b of bigLines) hints.push(`"${b.key}" averages ${Math.round(b.bytes / b.count)} bytes per line: log ids/counts, not payloads.`);
  if (untagged) hints.push(`${untagged} lines without tags: they cannot be filtered by subsystem.`);
  if (without / n > 0.5 && cids.size) hints.push(`${Math.round((without / n) * 100)}% of lines have no correlationId: check that jobs/consumers open a correlation scope.`);
  for (const [k, count] of errors) if (count >= 20) hints.push(`error "${k}" repeated ${count}×: collapse repeats or fix the root cause.`);

  return { lines: logs.length, bytes, byLevel, topMessages, topLoggers, untagged, legacy, withoutCorrelation: without, requests: cids.size, linesPerRequest, hints };
}

export function formatNoiseReport(r: NoiseReport): string {
  const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;
  const lines = [
    `${r.lines} lines, ${kb(r.bytes)} · ${Object.entries(r.byLevel).map(([l, c]) => `${l} ${c}`).join(" · ")}`,
    `${r.requests} requests (correlationIds)${r.linesPerRequest !== null ? `, ${r.linesPerRequest} lines/request` : ""} · ${r.withoutCorrelation} without correlationId · ${r.legacy} legacy · ${r.untagged} untagged`,
    "",
    "Top messages (logger | message):",
    ...r.topMessages.map((m) => `  ${String(m.count).padStart(7)}  ${String(m.share).padStart(3)}%  ${kb(m.bytes).padStart(9)}  ${m.key}`),
    "",
    "Top loggers:",
    ...r.topLoggers.map((l) => `  ${String(l.count).padStart(7)}  ${String(l.share).padStart(3)}%  ${l.logger}`),
  ];
  if (r.hints.length) lines.push("", "Possible over-logging:", ...r.hints.map((h) => `  - ${h}`));
  else lines.push("", "No obvious over-logging.");
  return lines.join("\n");
}
