import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lookup, writeMap } from "../src/core/codemap.js";
import { clearGuardCache, handlePreToolUse } from "../src/core/guard-hooks.js";
import { canonicalPath } from "../src/core/paths.js";
import { SourceRepo } from "../src/core/source.js";
import { sync } from "../src/core/sync.js";
import { resolveWorkspace } from "../src/core/workspace.js";
import { createFixture, MAP_BODY, tempDir, type Fixture } from "./helpers.js";

// macOS reaches temp dirs through /var -> /private/var, Linux homes are sometimes symlinked,
// Windows may hand out 8.3 short names. Git reports canonical paths; the kit must too.

describe("paths reached through a symlink / junction", () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it("resolves the repo, relative paths, maps and guards through the link", () => {
    clearGuardCache();
    fx = createFixture("folder");
    const link = join(tempDir("codekit-link-"), "linked-src");
    symlinkSync(fx.source, link, process.platform === "win32" ? "junction" : "dir");

    const repo = SourceRepo.open(link)!;
    expect(repo.root).toBe(canonicalPath(fx.source));
    expect(repo.relativePath(join(link, "src", "auth", "login.ts"))).toBe("src/auth/login.ts");
    expect(repo.relativePath(join(link, "src", "not-yet", "new.ts"))).toBe("src/not-yet/new.ts");

    const res = resolveWorkspace(link, "test");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    sync(res.workspace);
    writeMap(res.workspace, { path: join(link, "src", "auth", "login.ts"), body: MAP_BODY });
    expect(lookup(res.workspace, [join(link, "src", "auth", "login.ts")])[0]!.status).toBe("ok");

    expect(handlePreToolUse({ cwd: link, tool_name: "Write", tool_input: { file_path: join(link, "CLAUDE.md") } })).not.toBeNull();
    expect(handlePreToolUse({ cwd: link, tool_name: "Bash", tool_input: { command: "git push" } })).not.toBeNull();
    expect(handlePreToolUse({ cwd: link, tool_name: "Write", tool_input: { file_path: join(link, "src", "b.ts") } })).toBeNull();
  });

  it("canonicalPath keeps paths that do not exist yet", () => {
    const base = tempDir();
    expect(canonicalPath(join(base, "a", "b.txt"))).toBe(join(canonicalPath(base), "a", "b.txt"));
  });
});
