import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactKind, hookBypass, mcpWriteTargets, shellWriteTargets } from "../src/core/artifacts.js";
import { clearGuardCache, evaluateGuard, handleCursorShell, handlePreToolUse } from "../src/core/guard-hooks.js";
import { projectReport } from "../src/core/report.js";
import { globToEre, initRepo, installPreCommitGuard, preCommitScript } from "../src/core/setup.js";
import { SourceRepo } from "../src/core/source.js";
import { sync } from "../src/core/sync.js";
import { createFixture, IDENTITY, sh, tempDir, writeSource, type Fixture } from "./helpers.js";

const NONE = { extra: [], allow: [] };

describe("artifact paths", () => {
  it.each([
    ["CLAUDE.md", "rules"], ["claude.md", "rules"], ["AGENTS.md", "rules"], ["packages/api/AGENTS.md", "rules"],
    ["CLAUDE.local.md", "rules"], [".cursorrules", "rules"], [".github/copilot-instructions.md", "rules"],
    [".github/instructions/java.instructions.md", "rules"], [".github/prompts/x.prompt.md", "rules"],
    ["docs/plans/2026-10-25-login.md", "plan"], ["docs/plans", "plan"], ["docs/superpowers/specs/x.md", "plan"],
    ["services/api/docs/plans/x.md", "plan"], [".specify/memory/constitution.md", "plan"],
    [".claude/settings.json", "tool-config"], [".cursor/rules/a.mdc", "tool-config"], [".cursor", "tool-config"],
    [".mcp.json", "tool-config"], [".vscode/mcp.json", "tool-config"], [".aider.conf.yml", "tool-config"],
    [".serena/memories/x.md", "memory"], [".codemap/x.md", "memory"], [".git/hooks/pre-commit", "guard"],
  ])("%s is an AI %s file", (path, kind) => {
    expect(artifactKind(path, NONE)).toBe(kind);
  });

  it.each([
    "README.md", "docs/plans.md", "docs/planning/q4.md", "docs/architecture.md", "src/claude/client.ts", "src/agents/agent.ts",
    ".github/workflows/ci.yml", ".github/CODEOWNERS", ".vscode/settings.json", ".vscode/launch.json", "src/index.ts", "",
  ])("%s is ordinary source", (path) => {
    expect(artifactKind(path, NONE)).toBeNull();
  });

  it("honours team exceptions and extra patterns", () => {
    expect(artifactKind("docs/plans/roadmap.md", { extra: [], allow: ["docs/plans/**"] })).toBeNull();
    expect(artifactKind("CLAUDE.md", { extra: [], allow: ["docs/plans/**"] })).toBe("rules");
    expect(artifactKind("notes/ai/today.md", { extra: ["notes/ai/**"], allow: [] })).toBe("rules");
  });

  it("the pre-commit regex matches exactly what the guard matches", () => {
    const rules = { extra: ["notes/ai/**"], allow: ["docs/plans/keep/**"] };
    const script = preCommitScript(rules);
    const block = new RegExp(/grep -Ei '([^']+)'/.exec(script)![1]!, "i");
    const allow = new RegExp(/grep -Eiv '([^']+)'/.exec(script)![1]!, "i");
    for (const p of ["CLAUDE.md", "a/b/AGENTS.md", "docs/plans/x.md", "docs/plans/keep/x.md", ".cursor/r.mdc", ".aider.conf.yml", "notes/ai/x.md", "src/x.ts", "docs/plans.md", "README.md"]) {
      const viaHook = block.test(p) && !allow.test(p);
      expect(viaHook, p).toBe(artifactKind(p, rules) !== null);
    }
    expect(globToEre("**/docs/plans/**")).toBe("^(.*/)?docs/plans/.*$");
    expect(() => preCommitScript({ extra: ["it's"], allow: [] })).toThrow(/Invalid guard pattern/);
  });
});

describe("shell write detection", () => {
  it.each([
    ["echo hi > CLAUDE.md", ["CLAUDE.md"]],
    ["echo hi >> AGENTS.md", ["AGENTS.md"]],
    ['printf "x" >"docs/plans/a b.md"', ["docs/plans/a b.md"]],
    ["cat <<'EOF' > docs/plans/x.md\n# plan\nEOF", ["docs/plans/x.md"]],
    ["echo x | tee -a .cursorrules", [".cursorrules"]],
    ["mkdir -p docs/superpowers/plans", ["docs/superpowers/plans"]],
    ["touch .github/copilot-instructions.md", [".github/copilot-instructions.md"]],
    ["cp /tmp/r.mdc .cursor/rules/r.mdc", [".cursor/rules/r.mdc"]],
    ["mv draft.md docs/plans/draft.md", ["docs/plans/draft.md"]],
    ["sed -i 's/a/b/' CLAUDE.md", ["CLAUDE.md"]],
    ["git add docs/plans/x.md src/a.ts", ["docs/plans/x.md", "src/a.ts"]],
    ["Set-Content -Path AGENTS.md -Value 'x'", ["AGENTS.md"]],
    ["'x' | Out-File -FilePath CLAUDE.md", ["CLAUDE.md"]],
    ["New-Item -ItemType File .cursorrules", [".cursorrules"]],
    ["Copy-Item r.mdc -Destination .cursor/rules/r.mdc", [".cursor/rules/r.mdc"]],
  ])("%s writes %j", (cmd, expected) => {
    for (const t of expected) expect(shellWriteTargets(cmd)).toContain(t);
  });

  it.each(["cat CLAUDE.md", "grep -n rule AGENTS.md", "cp docs/plans/x.md /tmp/x.md", "npm test 2>&1", "ls .cursor", "git status", "git diff CLAUDE.md"])(
    "%s writes no AI file",
    (cmd) => {
      expect(shellWriteTargets(cmd).filter((t) => artifactKind(t, NONE))).toEqual([]);
    },
  );

  it("detects attempts to bypass the hooks", () => {
    for (const c of ["git commit --no-verify -m x", "git commit -nm x", "git -c core.hooksPath=/dev/null commit -m x", "git config core.hooksPath .nohooks", "git merge --no-verify feature"]) {
      expect(hookBypass(c), c).not.toBeNull();
    }
    for (const c of ["git commit -m 'no verify needed'", "git commit -am wip", "git config --get core.hooksPath", "git config user.name x"]) {
      expect(hookBypass(c), c).toBeNull();
    }
  });

  it("finds MCP tool write targets", () => {
    expect(mcpWriteTargets("mcp__serena__write_memory", { memory_file_name: "notes.md" })).toEqual([".serena/memories/notes.md"]);
    expect(mcpWriteTargets("mcp__filesystem__write_file", { path: "CLAUDE.md" })).toEqual(["CLAUDE.md"]);
    expect(mcpWriteTargets("mcp__serena__create_text_file", { relative_path: "docs/plans/x.md" })).toEqual(["docs/plans/x.md"]);
    expect(mcpWriteTargets("mcp__serena__find_symbol", { relative_path: "CLAUDE.md" })).toEqual([]);
    expect(mcpWriteTargets("mcp__plugin_codekit_codemap__plan_save", { path: "docs/plans/x.md" })).toEqual([]);
  });
});

describe("artifact guard in a registered repo", () => {
  let fx: Fixture;
  beforeEach(() => {
    clearGuardCache();
    fx = createFixture("folder");
  });
  afterEach(() => fx?.cleanup());

  const write = (cwd: string, file_path: string, tool = "Write") => handlePreToolUse({ cwd, tool_name: tool, tool_input: { file_path, content: "x" } }) as
    | { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }
    | null;
  const bash = (cwd: string, command: string) => handlePreToolUse({ cwd, tool_name: "Bash", tool_input: { command } });

  it("denies Write/Edit of AI files and explains where they belong", () => {
    const plan = write(fx.source, join(fx.source, "docs", "plans", "2026-10-25-otp.md"))!;
    expect(plan.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(plan.hookSpecificOutput.permissionDecisionReason).toContain("plan_save");
    expect(plan.hookSpecificOutput.permissionDecisionReason).toContain("Superpowers");
    expect(write(fx.source, "CLAUDE.md")!.hookSpecificOutput.permissionDecisionReason).toContain("rules live in the knowledge store");
    expect(write(fx.source, join(fx.source, "docs", "superpowers", "specs", "x.md"))).not.toBeNull();
    expect(write(fx.source, join(fx.source, "packages", "api", "AGENTS.md"), "Edit")).not.toBeNull();
    expect(write(fx.source, join(fx.source, ".git", "hooks", "pre-commit"))!.hookSpecificOutput.permissionDecisionReason).toContain("guard");
    expect(write(fx.source, join(fx.source, "src", "auth", "login.ts"))).toBeNull();
    expect(write(fx.source, join(fx.source, "docs", "architecture.md"))).toBeNull();
    // Absolute path into the repo while the session runs elsewhere
    expect(write(tempDir("elsewhere-"), join(fx.source, ".cursorrules"))).not.toBeNull();
  });

  it("denies shell writes of AI files and hook bypasses, allows normal work", () => {
    for (const c of [
      "echo '# rules' > CLAUDE.md",
      "mkdir -p docs/plans && cat > docs/plans/x.md <<'EOF'\n# plan\nEOF",
      "git add docs/plans/x.md",
      "cp /tmp/r.mdc .cursor/rules/r.mdc",
      "git commit --no-verify -m wip",
      "git config core.hooksPath /tmp/none",
      `echo x > "${join(fx.source, "AGENTS.md")}"`,
    ]) expect(bash(fx.source, c), c).not.toBeNull();
    for (const c of ["cat CLAUDE.md", "echo x > src/new.ts", "git add src/new.ts && git commit -m feat", "git config --get core.hooksPath", "npm test"]) {
      expect(bash(fx.source, c), c).toBeNull();
    }
    expect(handlePreToolUse({ cwd: fx.source, tool_name: "PowerShell", tool_input: { command: "Set-Content -Path AGENTS.md -Value x" } })).not.toBeNull();
    expect(handleCursorShell({ command: "echo x > .cursorrules", cwd: fx.source })).toMatchObject({ permission: "deny" });
  });

  it("denies MCP writes of AI files (Serena memories, filesystem servers)", () => {
    expect(evaluateGuard({ cwd: fx.source, toolName: "mcp__serena__write_memory", toolInput: { memory_file_name: "x.md", content: "y" } }).blocked).toBe(true);
    expect(evaluateGuard({ cwd: fx.source, toolName: "mcp__filesystem__write_file", toolInput: { path: join(fx.source, "CLAUDE.md") } }).blocked).toBe(true);
    expect(evaluateGuard({ cwd: fx.source, toolName: "mcp__serena__replace_symbol_body", toolInput: { relative_path: "src/auth/login.ts" } }).blocked).toBe(false);
    expect(evaluateGuard({ cwd: fx.source, toolName: "mcp__plugin_codekit_codemap__plan_save", toolInput: { name: "x" } }).blocked).toBe(false);
  });

  it("respects team exceptions from codekit.yaml", () => {
    const ws = fx.ws();
    const yaml = ws.store.readConfig("codekit.yaml")!;
    ws.store.writeConfig("codekit.yaml", yaml.replace("allowPaths: []", 'allowPaths: ["docs/plans/**"]'), "allow product plans");
    clearGuardCache();
    expect(write(fx.source, join(fx.source, "docs", "plans", "roadmap.md"))).toBeNull();
    expect(write(fx.source, "CLAUDE.md")).not.toBeNull();
  });

  it("leaves unregistered repos alone", () => {
    sh(fx.source, "remote", "set-url", "origin", "https://github.com/someone/else.git");
    expect(write(fx.source, "CLAUDE.md")).toBeNull();
    expect(bash(fx.source, "echo x > CLAUDE.md")).toBeNull();
  });

  it("report lists AI files that reached the source repo anyway", () => {
    writeSource(fx.source, "CLAUDE.md", "# rules\n");
    writeSource(fx.source, "docs/plans/x.md", "# plan\n");
    sh(fx.source, "add", "-A");
    sh(fx.source, "commit", "-qm", "human commit with AI files", "--no-verify");
    sync(fx.ws());
    const report = projectReport(fx.ws());
    expect(report.branches[0]!.artifacts.map((a) => a.path).sort()).toEqual(["CLAUDE.md", "docs/plans/x.md"]);
  });
});

/** git with a controlled environment (the test runner itself may run inside an agent). */
function gitAs(cwd: string, agent: boolean, ...args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "AI_AGENT", "CURSOR_AGENT", "CODEKIT_AGENT"].includes(k)) env[k] = v;
  if (agent) env.CLAUDECODE = "1";
  return spawnSync("git", args, { cwd, encoding: "utf8", env: { ...env, ...IDENTITY } });
}

describe("pre-commit artifact guard (real git)", () => {
  let fx: Fixture;
  beforeEach(() => {
    clearGuardCache();
    fx = createFixture("folder");
  });
  afterEach(() => fx?.cleanup());

  it("rejects agent commits that add AI files; developers and normal files are unaffected", () => {
    writeSource(fx.source, "CLAUDE.md", "# rules\n");
    writeSource(fx.source, "docs/plans/p.md", "# plan\n");
    gitAs(fx.source, true, "add", "-A");
    const agent = gitAs(fx.source, true, "commit", "-qm", "agent adds AI files");
    expect(agent.status).not.toBe(0);
    expect(agent.stderr).toContain("commit blocked");
    expect(agent.stderr).toContain("CLAUDE.md");
    expect(agent.stderr).toContain("docs/plans/p.md");

    gitAs(fx.source, true, "restore", "--staged", "CLAUDE.md", "docs/plans/p.md");
    writeSource(fx.source, "src/feature.ts", "export const f = 1;\n");
    gitAs(fx.source, true, "add", "src/feature.ts");
    expect(gitAs(fx.source, true, "commit", "-qm", "agent feature").status).toBe(0);

    gitAs(fx.source, false, "add", "-A");
    expect(gitAs(fx.source, false, "commit", "-qm", "developer decides").status).toBe(0);

    // Removing AI files is always fine.
    gitAs(fx.source, true, "rm", "-q", "CLAUDE.md");
    expect(gitAs(fx.source, true, "commit", "-qm", "agent removes rules file").status).toBe(0);
  });

  it("applies team exceptions and chains an existing pre-commit hook", () => {
    const hooks = join(fx.source, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho team-hook-ran >&2\nexit 0\n");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    const res = installPreCommitGuard(SourceRepo.open(fx.source)!, { extra: [], allow: ["docs/plans/**"] });
    expect(res.chained).toBe(true);
    writeSource(fx.source, "docs/plans/roadmap.md", "# product roadmap\n");
    gitAs(fx.source, true, "add", "-A");
    const ok = gitAs(fx.source, true, "commit", "-qm", "product docs");
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stderr).toContain("team-hook-ran");
  });

  it("codekit init installs both guards", () => {
    const res = initRepo({ cwd: fx.source, project: "shop", backend: "folder", path: fx.storeLocation });
    expect(res.guard.installed).toBe(true);
    expect(res.artifactGuard.installed).toBe(true);
  });
});
