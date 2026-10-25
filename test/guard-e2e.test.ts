import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateGuard, handleCursorMcp, handleCursorShell, handlePreToolUse } from "../src/core/guard-hooks.js";
import { installPrePushGuard, PRE_PUSH_MARKER } from "../src/core/setup.js";
import { assertReadOnly, SourceRepo } from "../src/core/source.js";
import { createFixture, IDENTITY, sh, tempDir, writeSource, type Fixture } from "./helpers.js";

/** Run git with a controlled environment (the test runner itself may run inside an agent). */
function gitWithEnv(cwd: string, env: Record<string, string | undefined>, ...args: string[]) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "AI_AGENT", "CURSOR_AGENT", "CODEKIT_AGENT"].includes(k)) base[k] = v;
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) base[k] = v;
  return spawnSync("git", args, { cwd, encoding: "utf8", env: { ...base, ...IDENTITY } });
}

describe("push guard in a registered source repo", () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it("pre-push hook blocks pushes from agent processes but not from the developer", () => {
    fx = createFixture("folder");
    writeSource(fx.source, "src/x.ts", "export const x = 1;\n");
    sh(fx.source, "add", "-A");
    sh(fx.source, "commit", "-qm", "local commit by agent is fine");

    const agent = gitWithEnv(fx.source, { CLAUDECODE: "1" }, "push", "origin", "main");
    expect(agent.status).not.toBe(0);
    expect(agent.stderr).toContain("codekit: push blocked");

    const otherAgent = gitWithEnv(fx.source, { AI_AGENT: "cursor" }, "push", "origin", "main");
    expect(otherAgent.status).not.toBe(0);

    const human = gitWithEnv(fx.source, {}, "push", "origin", "main");
    expect(human.status, human.stderr).toBe(0);
  });

  it("chains an existing pre-push hook", () => {
    fx = createFixture("folder");
    const hooks = join(fx.source, ".git", "hooks");
    writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\necho custom-hook-ran >&2\nexit 0\n");
    chmodSync(join(hooks, "pre-push"), 0o755);
    const res = installPrePushGuard(SourceRepo.open(fx.source)!);
    expect(res.chained).toBe(true);
    expect(readFileSync(join(hooks, "pre-push"), "utf8")).toContain(PRE_PUSH_MARKER);
    const human = gitWithEnv(fx.source, {}, "push", "origin", "main");
    expect(human.status).toBe(0);
    expect(human.stderr).toContain("custom-hook-ran");
  });

  it("PreToolUse denies push commands and allows local work", () => {
    fx = createFixture("folder");
    const deny = handlePreToolUse({ cwd: fx.source, tool_name: "Bash", tool_input: { command: "git add -A && git commit -m x && git push" } }) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(deny.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(deny.hookSpecificOutput.permissionDecisionReason).toContain("never push");

    expect(handlePreToolUse({ cwd: fx.source, tool_name: "Bash", tool_input: { command: "git commit -am 'wip'" } })).toBeNull();
    expect(handlePreToolUse({ cwd: fx.source, tool_name: "PowerShell", tool_input: { command: "git push origin main" } })).not.toBeNull();
    expect(handlePreToolUse({ cwd: fx.source, tool_name: "mcp__github__create_pull_request", tool_input: {} })).not.toBeNull();
    expect(handlePreToolUse({ cwd: fx.source, tool_name: "mcp__github__get_file_contents", tool_input: {} })).toBeNull();
  });

  it("sees through repo aliases and cd into the repo from outside", () => {
    fx = createFixture("folder");
    sh(fx.source, "config", "alias.ship", "push origin HEAD");
    expect(evaluateGuard({ cwd: fx.source, toolName: "Bash", command: "git ship" }).blocked).toBe(true);
    const outside = tempDir("codekit-outside-");
    expect(evaluateGuard({ cwd: outside, toolName: "Bash", command: `cd "${fx.source}" && git push` }).blocked).toBe(true);
    expect(evaluateGuard({ cwd: outside, toolName: "Bash", command: `git -C "${fx.source}" push` }).blocked).toBe(true);
    expect(evaluateGuard({ cwd: outside, toolName: "Bash", command: "git push" }).blocked).toBe(false); // unrelated repo
  });

  it("does not interfere with unregistered repos", () => {
    fx = createFixture("folder");
    sh(fx.source, "remote", "set-url", "origin", "https://github.com/someone/else.git");
    expect(handlePreToolUse({ cwd: fx.source, tool_name: "Bash", tool_input: { command: "git push" } })).toBeNull();
  });

  it("Cursor hooks: deny/allow shape", () => {
    fx = createFixture("folder");
    expect(handleCursorShell({ command: "git push", cwd: fx.source })).toMatchObject({ permission: "deny" });
    expect(handleCursorShell({ command: "git status", workspace_roots: [fx.source] })).toEqual({ permission: "allow" });
    expect(handleCursorMcp({ tool_name: "create_pull_request", url: "https://api.githubcopilot.com/mcp/", workspace_roots: [fx.source] })).toMatchObject({ permission: "deny" });
    expect(handleCursorMcp({ tool_name: "get_file_contents", url: "https://api.githubcopilot.com/mcp/", workspace_roots: [fx.source] })).toEqual({ permission: "allow" });
  });
});

describe("kit's own access to source repos is read-only", () => {
  it.each([
    ["push"], ["commit", "-m", "x"], ["fetch"], ["pull"], ["checkout", "main"], ["reset", "--hard"],
    ["config", "user.name", "x"], ["remote", "set-url", "origin", "x"], ["symbolic-ref", "HEAD", "refs/heads/x"],
    ["reflog", "expire"], ["update-ref", "refs/heads/x", "HEAD"], ["tag", "v1"],
  ])("refuses git %s", (...args) => {
    expect(() => assertReadOnly(args)).toThrow(/read-only/);
  });
  it("allows the reads it needs", () => {
    for (const args of [["rev-parse", "HEAD"], ["config", "user.name"], ["config", "--get-regexp", "^alias\\."], ["symbolic-ref", "--short", "-q", "HEAD"], ["remote", "get-url", "origin"], ["cat-file", "--batch"]]) {
      expect(() => assertReadOnly(args)).not.toThrow();
    }
  });
});
