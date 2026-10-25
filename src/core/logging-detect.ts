import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { isTrackable } from "./codemap.js";
import type { Workspace } from "./workspace.js";

// Read-only scan of a source repo's existing logging, so the AI extends what is
// there instead of adding a second logger.

export type Stack = "node" | "java" | "dotnet" | "python";

export interface DetectedLibrary {
  stack: Stack;
  library: string;
  evidence: string;
  /** Adapter guide in logging/adapters (or the reference sample when the library is the sample's). */
  guide: string;
}

export interface InHouseCandidate {
  path: string;
  definition: string;
  usages: number;
}

export interface LoggingDetection {
  stacks: Stack[];
  libraries: DetectedLibrary[];
  inHouse: InHouseCandidate[];
  rawCalls: { pattern: string; count: number; topFiles: string[] }[];
  correlationAlready: string[];
  strategy: "in-house" | "library" | "reference-sample";
  advice: string;
}

const LIBS: { stack: Stack; library: string; match: RegExp; guide: string }[] = [
  { stack: "node", library: "pino", match: /"pino"\s*:/, guide: "logging/node (reference sample)" },
  { stack: "node", library: "winston", match: /"winston"\s*:/, guide: "logging/adapters/node-winston.md" },
  { stack: "node", library: "bunyan", match: /"bunyan"\s*:/, guide: "logging/adapters/node-bunyan.md" },
  { stack: "node", library: "log4js", match: /"log4js"\s*:/, guide: "logging/adapters/in-house.md (treat as library: configure layout + wrapper)" },
  { stack: "node", library: "nestjs-logger", match: /"@nestjs\/core"\s*:/, guide: "logging/adapters/in-house.md (wrap Nest LoggerService)" },
  { stack: "java", library: "log4j2", match: /log4j-core|spring-boot-starter-log4j2|org\.apache\.logging\.log4j/, guide: "logging/adapters/java-log4j2.md" },
  { stack: "java", library: "logback", match: /logback-classic|spring-boot-starter(-web|-webflux)?(?=["'<\s:])/, guide: "logging/java (reference sample)" },
  { stack: "dotnet", library: "serilog", match: /Include="Serilog/, guide: "logging/dotnet (reference sample)" },
  { stack: "dotnet", library: "nlog", match: /Include="NLog/, guide: "logging/adapters/dotnet-nlog.md" },
  { stack: "dotnet", library: "log4net", match: /Include="log4net"/i, guide: "logging/adapters/in-house.md (treat as library: configure layout + wrapper)" },
  { stack: "dotnet", library: "microsoft-logging", match: /Microsoft\.NET\.Sdk\.Web|Include="Microsoft\.Extensions\.Logging/, guide: "logging/adapters/dotnet-microsoft-logging.md" },
  { stack: "python", library: "loguru", match: /\bloguru\b/, guide: "logging/adapters/python-loguru.md" },
  { stack: "python", library: "structlog", match: /\bstructlog\b/, guide: "logging/adapters/python-structlog.md" },
];

const MANIFEST: Record<Stack, RegExp> = {
  node: /(^|\/)package\.json$/,
  java: /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/,
  dotnet: /\.(csproj|fsproj|vbproj)$|(^|\/)Directory\.Packages\.props$/,
  python: /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|setup\.cfg|Pipfile)$/,
};

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|java|kt|cs|py)$/;
const IN_HOUSE_NAME = /(^|[._-])(log|logger|logging|loghelper|logutil|logutils|applogger|logservice|logmanager)$/i;
const IN_HOUSE_DEF = /(class|interface|object|def|function|const|export\s+(default\s+)?(function|class|const))\s+\w*(Log|Logger|Logging)\w*/;
const RAW: { pattern: string; re: RegExp; ext: RegExp }[] = [
  { pattern: "console.log/info/warn/error", re: /\bconsole\.(log|info|warn|error|debug)\s*\(/g, ext: /\.(ts|tsx|js|jsx|mjs|cjs)$/ },
  { pattern: "System.out/err.println, printStackTrace", re: /\bSystem\.(out|err)\.print|\.printStackTrace\s*\(/g, ext: /\.(java|kt)$/ },
  { pattern: "Console.WriteLine", re: /\bConsole\.(Write|WriteLine)\s*\(/g, ext: /\.cs$/ },
  { pattern: "print()", re: /^\s*print\s*\(/gm, ext: /\.py$/ },
];
const MAX_FILES = 5000;
const MAX_BYTES = 512 * 1024;

export function detectLogging(ws: Workspace): LoggingDetection {
  const files = ws.source.listFiles();
  const read = (rel: string): string | null => {
    const abs = ws.source.absolutePath(rel);
    try {
      if (!existsSync(abs) || statSync(abs).size > MAX_BYTES) return null;
      return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  };

  const stacks = new Set<Stack>();
  const libraries: DetectedLibrary[] = [];
  for (const [stack, re] of Object.entries(MANIFEST) as [Stack, RegExp][]) {
    for (const manifest of files.filter((f) => re.test(f) && !/node_modules\//.test(f))) {
      stacks.add(stack);
      const text = read(manifest) ?? "";
      for (const lib of LIBS.filter((l) => l.stack === stack && l.match.test(text))) {
        if (!libraries.some((l) => l.library === lib.library)) libraries.push({ stack, library: lib.library, evidence: manifest, guide: lib.guide });
      }
    }
  }
  // Prefer an explicit library over the framework default (log4j2 starter replaces logback, NLog/Serilog over MEL).
  const has = (n: string) => libraries.some((l) => l.library === n);
  const filtered = libraries.filter((l) =>
    !(l.library === "logback" && has("log4j2")) &&
    !(l.library === "microsoft-logging" && (has("serilog") || has("nlog") || has("log4net"))));

  const sources = files.filter((f) => SOURCE_EXT.test(f) && isTrackable(ws, f)).slice(0, MAX_FILES);
  const contents = new Map<string, string>();
  for (const f of sources) {
    const t = read(f);
    if (t !== null) contents.set(f, t);
  }

  const inHouse: InHouseCandidate[] = [];
  for (const [path, text] of contents) {
    const stem = basename(path).replace(/\.[^.]+$/, "");
    if (!IN_HOUSE_NAME.test(stem) && !/(^|\/)log(ger|ging)?\//i.test(path)) continue;
    const def = IN_HOUSE_DEF.exec(text);
    if (!def) continue;
    const name = def[0].split(/\s+/).pop()!;
    let usages = 0;
    const ref = new RegExp(`\\b${name.replace(/[^\w]/g, "")}\\b`, "g");
    for (const [other, body] of contents) if (other !== path) usages += (body.match(ref) ?? []).length;
    inHouse.push({ path, definition: def[0].trim(), usages });
  }
  inHouse.sort((a, b) => b.usages - a.usages);

  const rawCalls = RAW.map(({ pattern, re, ext }) => {
    const perFile: [string, number][] = [];
    for (const [path, text] of contents) {
      if (!ext.test(path)) continue;
      const n = (text.match(re) ?? []).length;
      if (n) perFile.push([path, n]);
    }
    perFile.sort((a, b) => b[1] - a[1]);
    return { pattern, count: perFile.reduce((s, [, n]) => s + n, 0), topFiles: perFile.slice(0, 5).map(([p, n]) => `${p} (${n})`) };
  }).filter((r) => r.count > 0);

  const correlationAlready = [...contents].filter(([, t]) => /x-correlation-id|correlationId|correlation_id/i.test(t)).map(([p]) => p).slice(0, 10);

  const mainInHouse = inHouse.find((c) => c.usages >= 3);
  const strategy: LoggingDetection["strategy"] = mainInHouse ? "in-house" : filtered.length ? "library" : "reference-sample";
  const advice =
    strategy === "in-house"
      ? `Extend the project's own logger ${mainInHouse!.path} (${mainInHouse!.usages} usages): add the tags parameter (old calls default to tag "legacy"), correlationId from request context, and the convention's output fields. Do not add another logger. Guide: logging/adapters/in-house.md` +
        (filtered.length ? `; it sits on ${filtered.map((l) => l.library).join(", ")} — configure that library per ${filtered.map((l) => l.guide).join(", ")}.` : ".")
      : strategy === "library"
        ? `Keep ${filtered.map((l) => l.library).join(", ")}; configure its output and context, and add a thin tagged wrapper. Guide: ${filtered.map((l) => l.guide).join(", ")}.`
        : `No logging library or in-house logger found: adapt the reference sample (logging_sample) for ${[...stacks].join(", ") || "the project's stack"}.`;

  return { stacks: [...stacks], libraries: filtered, inHouse: inHouse.slice(0, 5), rawCalls, correlationAlready, strategy, advice };
}

export function formatDetection(d: LoggingDetection): string {
  const lines = [
    `Strategy: ${d.strategy}`,
    d.advice,
    "",
    `Stacks: ${d.stacks.join(", ") || "unknown"}`,
    `Libraries: ${d.libraries.map((l) => `${l.library} (${l.evidence})`).join(", ") || "none"}`,
    `In-house logger candidates: ${d.inHouse.map((c) => `${c.path} — ${c.definition} — ${c.usages} usages`).join("; ") || "none"}`,
    `Raw logging calls: ${d.rawCalls.map((r) => `${r.pattern}: ${r.count} [${r.topFiles.join(", ")}]`).join("; ") || "none"}`,
    `Already mentions correlationId: ${d.correlationAlready.join(", ") || "no"}`,
  ];
  return lines.join("\n");
}
