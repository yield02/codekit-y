import { afterEach, describe, expect, it } from "vitest";
import { parseProjectLogger, setProjectLogger } from "../src/core/conventions.js";
import { detectLogging } from "../src/core/logging-detect.js";
import { formatLog, matches, noiseReport, parseLogLine, sinceToIso, type ParsedLog } from "../src/core/logview.js";
import { readSample } from "../src/mcp/server.js";
import { createFixture, sh, writeSource, type Fixture } from "./helpers.js";

describe("project logger table", () => {
  const md = "# Logging\n\n## Project logger\n\n| Key | Value |\n|---|---|\n| library | (not set) |\n| entryPoint | (not set) |\n| notes | (not set) |\n\n## Tag registry\n\n| Tag | Description |\n|---|---|\n| `http` | x |\n";
  it("is unset by default and can be filled and updated", () => {
    expect(parseProjectLogger(md)).toBeNull();
    const a = setProjectLogger(md, { library: "in-house over winston", entryPoint: "src/common/logger.ts" });
    expect(parseProjectLogger(a)).toEqual({ library: "in-house over winston", entryPoint: "src/common/logger.ts", notes: "" });
    const b = setProjectLogger(a, { notes: "use logger.child(name)" });
    expect(parseProjectLogger(b)!.notes).toBe("use logger.child(name)");
    expect(b).toContain("## Tag registry");
    expect(b.match(/\| library \|/g)).toHaveLength(1);
  });
  it("adds the section when missing", () => {
    const next = setProjectLogger("# Logging\n\n## Tag registry\n", { library: "nlog" });
    expect(next.indexOf("## Project logger")).toBeLessThan(next.indexOf("## Tag registry"));
  });
});

describe("logging detection (read-only)", () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it("finds the in-house logger over a library, raw calls and existing correlation code", () => {
    fx = createFixture("folder");
    writeSource(fx.source, "package.json", JSON.stringify({ dependencies: { winston: "^3.11.0", express: "^4" } }));
    writeSource(fx.source, "src/common/logger.ts", "import winston from 'winston';\nexport class AppLogger { info(m: string) {} }\n");
    for (const n of ["a", "b", "c", "d"]) writeSource(fx.source, `src/${n}.ts`, `import { AppLogger } from './common/logger';\nconst log = new AppLogger();\nconsole.log('debug ${n}');\n`);
    writeSource(fx.source, "src/http.ts", "export const H = 'x-correlation-id';\n");
    sh(fx.source, "add", "-A");
    const before = sh(fx.source, "status", "--porcelain");
    const d = detectLogging(fx.ws());
    expect(d.stacks).toEqual(["node"]);
    expect(d.libraries.map((l) => l.library)).toEqual(["winston"]);
    expect(d.inHouse[0]).toMatchObject({ path: "src/common/logger.ts", usages: 8 });
    expect(d.strategy).toBe("in-house");
    expect(d.advice).toContain("src/common/logger.ts");
    expect(d.advice).toContain("node-winston.md");
    expect(d.rawCalls[0]).toMatchObject({ pattern: "console.log/info/warn/error", count: 4 });
    expect(d.correlationAlready).toContain("src/http.ts");
    expect(sh(fx.source, "status", "--porcelain")).toBe(before); // nothing written
  });

  it("prefers the explicit library over framework defaults", () => {
    fx = createFixture("folder");
    writeSource(fx.source, "pom.xml", "<dependency><artifactId>spring-boot-starter-web</artifactId></dependency><dependency><artifactId>spring-boot-starter-log4j2</artifactId></dependency>");
    writeSource(fx.source, "Api/Api.csproj", '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="NLog.Web.AspNetCore" Version="5.3.0" /></ItemGroup></Project>');
    const d = detectLogging(fx.ws());
    expect(d.libraries.map((l) => l.library).sort()).toEqual(["log4j2", "nlog"]);
    expect(d.strategy).toBe("library");
  });

  it("falls back to the reference sample", () => {
    fx = createFixture("folder");
    writeSource(fx.source, "requirements.txt", "fastapi==0.115\n");
    const d = detectLogging(fx.ws());
    expect(d.strategy).toBe("reference-sample");
    expect(d.stacks).toEqual(["python"]);
  });
});

describe("logging_sample with an existing library", () => {
  it("puts the adoption guide first, then the reference sample", () => {
    const text = readSample("node", "in-house");
    expect(text.indexOf("logging/adapters/in-house.md")).toBe(4);
    expect(text).toContain("=== logging/node/src/logging.ts");
    expect(readSample("python", "unknownlib")).toContain("No dedicated guide");
  });
});

describe("codekit logs", () => {
  const line = (o: Record<string, unknown>) => JSON.stringify({ timestamp: "2026-10-25T09:12:03.120Z", level: "info", service: "orders", logger: "OrderService", correlationId: "0190aaaa-bbbb-7ccc-8ddd-7f3a91c2", tags: ["order"], message: "Order placed", ...o });

  it("parses convention lines from any stack (and pino/Serilog level variants)", () => {
    expect(parseLogLine("not json")).toBeNull();
    const l = parseLogLine(line({ context: { orderId: "o-1" }, durationMs: 12 }))!;
    expect(l).toMatchObject({ level: "info", logger: "OrderService", tags: ["order"], durationMs: 12 });
    expect(parseLogLine(line({ level: 50 }))!.level).toBe("error");
    expect(parseLogLine(line({ level: "Warning" }))!.level).toBe("warn");
  });

  it("filters by short correlationId, tag, level, logger, text and time", () => {
    const l = parseLogLine(line({ context: { orderId: "o-77" } }))!;
    expect(matches(l, { cid: "7f3a91c2" })).toBe(true);
    expect(matches(l, { cid: "zzzzzz" })).toBe(false);
    expect(matches(l, { tags: ["payment", "order"] })).toBe(true);
    expect(matches(l, { level: "warn" })).toBe(false);
    expect(matches(l, { logger: "orderserv" })).toBe(true);
    expect(matches(l, { grep: "o-77" })).toBe(true);
    expect(matches(l, {}, "2026-10-25T10:00:00.000Z")).toBe(false);
    expect(sinceToIso("15m", Date.parse("2026-10-25T10:00:00Z"))).toBe("2026-10-25T09:45:00.000Z");
  });

  it("formats like the dev line, with relative time in trace mode", () => {
    const l = parseLogLine(line({ context: { userId: 42 }, durationMs: 12, tags: ["auth", "login"], message: "Login success" }))!;
    expect(formatLog(l)).toBe("09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)");
    expect(formatLog(l, { relativeTo: "2026-10-25T09:12:03.100Z" }).startsWith("   +20ms INFO")).toBe(true);
  });

  it("noise report flags loops, debug floods and chatty requests", () => {
    const logs: ParsedLog[] = [];
    for (let i = 0; i < 200; i++) logs.push(parseLogLine(line({ message: "Processing item", logger: "BatchJob", correlationId: `cid-${i % 10}-aaaaaaaa` }))!);
    for (let i = 0; i < 100; i++) logs.push(parseLogLine(line({ level: "debug", message: "value", correlationId: `cid-${i % 10}-aaaaaaaa` }))!);
    for (let i = 0; i < 25; i++) logs.push(parseLogLine(line({ level: "error", message: "Rates API down", logger: "RatesClient", correlationId: "none" }))!);
    const r = noiseReport(logs);
    expect(r.topMessages[0]).toMatchObject({ key: "BatchJob | Processing item", count: 200 });
    expect(r.requests).toBe(10);
    const hints = r.hints.join("\n");
    expect(hints).toContain("likely logged in a loop");
    expect(hints).toContain("debug should be off");
    expect(hints).toContain("lines per request");
    expect(hints).toContain('error "RatesClient | Rates API down" repeated 25×');
  });
});
