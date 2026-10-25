import { describe, expect, it } from "vitest";
import { addLogTag, addNamingRule, editNamingRule, parseLogTags, parseNamingRules } from "../src/core/conventions.js";
import { normalizeRemote } from "../src/core/git.js";
import { isIncluded, matchesGlob } from "../src/core/glob.js";
import { hashContent } from "../src/core/hash.js";
import { formatPretty, Logger, newCorrelationId } from "../src/core/logger.js";
import { lintMapBody, parseMapFile, serializeMapFile } from "../src/core/mapfile.js";
import { resolveMerge } from "../src/core/merge.js";
import { mapPathFor, normalizeBranch, slugify, sourcePathFromMap } from "../src/core/paths.js";
import { touchFromToolUse } from "../src/core/session.js";

describe("hash", () => {
  it("ignores CRLF vs LF", () => {
    expect(hashContent("a\r\nb\r\n")).toBe(hashContent("a\nb\n"));
    expect(hashContent("a")).toHaveLength(12);
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });
});

describe("paths", () => {
  it("normalizes branch names for refs and folders", () => {
    expect(normalizeBranch("feature/login-otp")).toBe("feature__login-otp");
    expect(normalizeBranch("fix/JIRA-1 space")).toBe("fix__JIRA-1-space");
  });
  it("maps source paths to map paths and back", () => {
    expect(mapPathFor("src\\auth\\login.ts")).toBe("modules/src/auth/login.ts.md");
    expect(sourcePathFromMap("modules/src/auth/login.ts.md")).toBe("src/auth/login.ts");
    expect(sourcePathFromMap("modules/src/_dir.md")).toBeNull();
    expect(sourcePathFromMap("plans/x.md")).toBeNull();
  });
  it("slugifies plan names, including Vietnamese", () => {
    expect(slugify("Đăng nhập OTP")).toBe("dang-nhap-otp");
    expect(slugify("Login with OTP!")).toBe("login-with-otp");
  });
});

describe("remote normalization", () => {
  it("treats ssh and https remotes as the same project", () => {
    expect(normalizeRemote("git@github.com:Acme/Shop.git")).toBe("github.com/acme/shop");
    expect(normalizeRemote("https://user@github.com/acme/shop")).toBe("github.com/acme/shop");
    expect(normalizeRemote("https://github.com/acme/shop.git/")).toBe("github.com/acme/shop");
  });
});

describe("glob", () => {
  it("matches gitignore-like patterns", () => {
    expect(matchesGlob("a/node_modules/x/y.js", "**/node_modules/**")).toBe(true);
    expect(matchesGlob("node_modules/y.js", "**/node_modules/**")).toBe(true);
    expect(matchesGlob("src/app.min.js", "*.min.js")).toBe(true);
    expect(matchesGlob("src/app.js", "*.min.js")).toBe(false);
    expect(matchesGlob("src/a/b.test.ts", "**/*.test.*")).toBe(true);
    expect(isIncluded("src/a.ts", ["src/**"], ["**/*.test.*"])).toBe(true);
    expect(isIncluded("lib/a.ts", ["src/**"], [])).toBe(false);
  });
});

describe("map file", () => {
  const file = {
    meta: {
      path: "src/a.ts",
      sourceHash: "abc123abc123",
      updatedAt: "2026-10-25T09:00:00Z",
      updatedBy: "dev (claude-code)",
      branch: "feature/x",
      dependsOn: ["src/b.ts"],
      tags: ["auth"],
      stale: false,
    },
    body: "## Purpose\nx",
  };
  it("round-trips frontmatter and body", () => {
    const parsed = parseMapFile(serializeMapFile(file));
    expect(parsed).toEqual(file);
  });
  it("parses CRLF files", () => {
    expect(parseMapFile(serializeMapFile(file).replace(/\n/g, "\r\n"))?.meta.path).toBe("src/a.ts");
  });
  it("lints missing sections and length", () => {
    const w = lintMapBody("## Purpose\n" + "x\n".repeat(70), 60);
    expect(w.some((x) => x.includes("lines"))).toBe(true);
    expect(w.some((x) => x.includes("Public API"))).toBe(true);
  });
});

describe("logger", () => {
  it("generates time-ordered UUIDv7 correlation ids", () => {
    const a = newCorrelationId(1_700_000_000_000);
    const b = newCorrelationId(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
  it("requires tags", () => {
    expect(() => new Logger("t").info([], "no tags")).toThrow(/tag/);
  });
  it("pretty-prints with correlationId and tags", () => {
    const line = formatPretty({
      timestamp: "2026-10-25T09:12:03.120Z",
      level: "info",
      service: "s",
      correlationId: "0190-aaaa-7f3a91c2",
      tags: ["auth", "login"],
      message: "Login success",
      context: { userId: 42 },
    });
    expect(line).toBe("09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42");
  });
});

describe("conventions", () => {
  const md = "# Naming\n\n## General\n\n| ID | Scope | Rule | Correct | Incorrect | enforcedBy |\n|---|---|---|---|---|---|\n| NC-001 | Files | kebab-case | `a-b.ts` | `aB.ts` | AI review |\n\n## Python\n\nNo rules yet.\n";
  it("adds rules with the next ID into the right section", () => {
    const { md: next, rule } = addNamingRule(md, { section: "Python", scope: "Modules", rule: "snake_case", correct: "a_b.py", incorrect: "aB.py", enforcedBy: "ruff N" });
    expect(rule.id).toBe("NC-002");
    const rules = parseNamingRules(next);
    expect(rules.map((r) => [r.id, r.section])).toEqual([["NC-001", "General"], ["NC-002", "Python"]]);
  });
  it("creates a missing section and rejects duplicates", () => {
    const { md: next } = addNamingRule(md, { section: ".NET", scope: "Fields", rule: "_camelCase", correct: "_x", incorrect: "x", enforcedBy: "" });
    expect(next).toContain("## .NET");
    expect(() => addNamingRule(next, { section: ".NET", scope: "fields", rule: "_camelCase ", correct: "", incorrect: "", enforcedBy: "" })).toThrow(/already exists/);
  });
  it("edits a rule in place and escapes pipes", () => {
    const { md: next } = editNamingRule(md, "NC-001", { rule: "kebab | lower" });
    expect(parseNamingRules(next)[0]!.rule).toBe("kebab | lower");
  });
  it("manages the log tag registry", () => {
    const log = "# Logging\n\n## Tag registry\n\n| Tag | Description |\n|---|---|\n| `auth` | Auth |\n\n## Other\n";
    const next = addLogTag(log, "payment", "Payments");
    expect(parseLogTags(next).map((t) => t.tag)).toEqual(["auth", "payment"]);
    expect(() => addLogTag(next, "payment", "dup")).toThrow(/already/);
    expect(() => addLogTag(next, "Bad_Tag", "x")).toThrow(/kebab/);
  });
});

describe("merge resolver", () => {
  const map = (hash: string, updatedAt: string, body = "## Purpose\nx") =>
    serializeMapFile({ meta: { path: "src/a.ts", sourceHash: hash, updatedAt, updatedBy: "d", branch: "b", dependsOn: [], tags: [], stale: false }, body });
  const base = map("h0", "2026-01-01T00:00:00Z");
  const snap = (entries: [string, string][]) => new Map(entries.map(([k, v]) => [k, hashContent(v)]));

  it("rule 1: takes the only side that changed", () => {
    const theirs = map("h1", "2026-01-02T00:00:00Z");
    const r = resolveMerge({ base: snap([["modules/src/a.ts.md", base]]), ours: new Map([["modules/src/a.ts.md", base]]), theirs: new Map([["modules/src/a.ts.md", theirs]]), fromBranch: "f", sourceHashAfterMerge: () => null });
    expect(r.changes.get("modules/src/a.ts.md")).toBe(theirs);
    const r2 = resolveMerge({ base: snap([["modules/src/a.ts.md", base]]), ours: new Map([["modules/src/a.ts.md", theirs]]), theirs: new Map([["modules/src/a.ts.md", base]]), fromBranch: "f", sourceHashAfterMerge: () => null });
    expect(r2.changes.size).toBe(0);
  });

  it("rule 2: both changed, keeps the side matching the merged source", () => {
    const ours = map("hO", "2026-01-03T00:00:00Z");
    const theirs = map("hT", "2026-01-02T00:00:00Z");
    const input = { base: snap([["modules/src/a.ts.md", base]]), ours: new Map([["modules/src/a.ts.md", ours]]), theirs: new Map([["modules/src/a.ts.md", theirs]]), fromBranch: "f" };
    expect(resolveMerge({ ...input, sourceHashAfterMerge: () => "hT" }).changes.get("modules/src/a.ts.md")).toBe(theirs);
    expect(resolveMerge({ ...input, sourceHashAfterMerge: () => "hO" }).changes.size).toBe(0);
  });

  it("rule 3: neither matches, keeps the newer and flags stale", () => {
    const ours = map("hO", "2026-01-03T00:00:00Z", "## Purpose\nours");
    const theirs = map("hT", "2026-01-02T00:00:00Z", "## Purpose\ntheirs");
    const r = resolveMerge({ base: snap([["modules/src/a.ts.md", base]]), ours: new Map([["modules/src/a.ts.md", ours]]), theirs: new Map([["modules/src/a.ts.md", theirs]]), fromBranch: "f", sourceHashAfterMerge: () => "other" });
    const out = parseMapFile(r.changes.get("modules/src/a.ts.md")!)!;
    expect(out.meta.stale).toBe(true);
    expect(out.body).toContain("ours");
    expect(r.markedStale).toEqual(["modules/src/a.ts.md"]);
  });

  it("adds new files from theirs and keeps both plan versions on conflict", () => {
    const r = resolveMerge({
      base: snap([["plans/p.md", "base"]]),
      ours: new Map([["plans/p.md", "ours"]]),
      theirs: new Map([["plans/p.md", "theirs"], ["modules/new.ts.md", "new"]]),
      fromBranch: "feature/x",
      sourceHashAfterMerge: () => null,
    });
    expect(r.changes.get("modules/new.ts.md")).toBe("new");
    expect(r.changes.get("plans/p.from-feature__x.md")).toBe("theirs");
    expect(r.changes.has("plans/p.md")).toBe(false);
  });
});

describe("tool-use tracking", () => {
  it("classifies reads and edits, including Serena tools", () => {
    expect(touchFromToolUse("Read", { file_path: "/r/a.ts" })).toEqual({ path: "/r/a.ts", kind: "read" });
    expect(touchFromToolUse("Edit", { file_path: "/r/a.ts" })?.kind).toBe("edit");
    expect(touchFromToolUse("mcp__serena__replace_symbol_body", { relative_path: "src/a.ts" })).toEqual({ path: "src/a.ts", kind: "edit" });
    expect(touchFromToolUse("mcp__serena__get_symbols_overview", { relative_path: "src/a.ts" })?.kind).toBe("read");
    expect(touchFromToolUse("mcp__serena__safe_delete_symbol", { relative_path: "src/a.ts" })?.kind).toBe("edit");
    expect(touchFromToolUse("mcp__serena__replace_content", { relative_path: "src/a.ts" })?.kind).toBe("edit");
    expect(touchFromToolUse("Bash", { command: "ls" })).toBeNull();
  });
});
