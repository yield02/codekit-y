import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { checkMcpTool, checkShellCommand, commandTargetDirs, type GuardVerdict } from "./guard.js";
import { createLogger, withCorrelation } from "./logger.js";
import { registeredSourcesUnder } from "./parent.js";
import { findRegisteredSource, resolveWorkspace } from "./workspace.js";

// Push guard for AI agents in registered source repos. Fail closed: once a command
// is known to target a registered repo, any error while checking it denies the call.

const log = createLogger("codemap-guard");
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

const POLICY =
  "codekit policy: AI agents may read, edit and commit locally in this source repository, but must never push " +
  "or write to the remote (git push, PRs, merges, GitHub API writes). Leave the commits for the developer to review and push.";

export interface GuardInput {
  cwd: string;
  toolName: string;
  command?: string;
}

/** Shared decision for Claude Code (PreToolUse) and Cursor (beforeShellExecution / beforeMCPExecution). */
export function evaluateGuard(input: GuardInput): GuardVerdict & { repo?: string } {
  return withCorrelation(undefined, () => {
    if (SHELL_TOOLS.has(input.toolName) || input.toolName === "shell") {
      const command = input.command ?? "";
      if (!command.trim()) return { blocked: false };
      const dirs = [input.cwd, ...commandTargetDirs(command).map((d) => (isAbsolute(d) ? d : resolve(input.cwd, d)))];
      let target = dirs.map((d) => safeFind(d)).find((r) => r !== null) ?? null;
      // Parent folder holding registered repos (Transfer/{Core,Admin,…}): the shell may be inside any
      // of them, so every push-like command is denied, with the aliases of all of them.
      const children = target ? [] : safeChildren(input.cwd);
      if (!target && children.length) target = children[0]!;
      if (!target) return { blocked: false };
      try {
        const aliases = Object.assign({}, ...[target, ...children].map((t) => t.source.gitAliases()));
        const verdict = checkShellCommand(command, { gitAliases: aliases, readScript: (p) => readScript(input.cwd, p) });
        if (verdict.blocked) log.warn(["guard", "deny"], "Blocked shell command", { rule: verdict.rule, repo: target.source.root, command });
        return { ...verdict, repo: target.source.root };
      } catch (err) {
        log.error(["guard", "deny"], "Guard check failed; denying", err, { repo: target.source.root });
        return { blocked: true, rule: "guard-error", reason: "The push guard could not verify this command.", repo: target.source.root };
      }
    }

    if (input.toolName.startsWith("mcp__")) {
      const target = safeFind(input.cwd) ?? safeChildren(input.cwd)[0] ?? null;
      if (!target) return { blocked: false };
      let allow: string[] = [];
      try {
        const res = resolveWorkspace(target.source.root, "guard");
        if (res.ok) allow = res.workspace.config.guard.allowMcpTools;
      } catch {
        // store unreachable: no allow-list, stay strict
      }
      const verdict = checkMcpTool(input.toolName, allow);
      if (verdict.blocked) log.warn(["guard", "deny"], "Blocked MCP tool", { rule: verdict.rule, tool: input.toolName, repo: target.source.root });
      return { ...verdict, repo: target.source.root };
    }
    return { blocked: false };
  });
}

function readScript(cwd: string, path: string): string | null {
  try {
    const abs = isAbsolute(path) ? path : resolve(cwd, path);
    if (!existsSync(abs) || statSync(abs).size > 1024 * 1024) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function safeChildren(dir: string) {
  try {
    return registeredSourcesUnder(dir);
  } catch {
    return [];
  }
}

function safeFind(dir: string) {
  try {
    return findRegisteredSource(dir);
  } catch {
    return null;
  }
}

function denyMessage(v: GuardVerdict): string {
  return `${v.reason ?? "This would write to the remote."} ${POLICY}`;
}

/** Claude Code PreToolUse output. */
export function handlePreToolUse(payload: { cwd?: string; tool_name?: string; tool_input?: Record<string, unknown> }): Record<string, unknown> | null {
  const toolName = payload.tool_name ?? "";
  const command = typeof payload.tool_input?.command === "string" ? payload.tool_input.command : undefined;
  const verdict = evaluateGuard({ cwd: payload.cwd || process.cwd(), toolName, command });
  if (!verdict.blocked) return null;
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denyMessage(verdict) },
  };
}

/** Cursor beforeShellExecution output (`permission: allow | deny`). */
export function handleCursorShell(payload: { command?: string; cwd?: string; workspace_roots?: string[] }): Record<string, unknown> {
  const cwd = payload.cwd || payload.workspace_roots?.[0] || process.cwd();
  const verdict = evaluateGuard({ cwd, toolName: "shell", command: payload.command });
  if (!verdict.blocked) return { permission: "allow" };
  const message = denyMessage(verdict);
  return { permission: "deny", userMessage: message, agentMessage: message };
}

/** Cursor beforeMCPExecution output. Cursor passes the bare tool name, so the server hint comes from url/command. */
export function handleCursorMcp(payload: { tool_name?: string; url?: string; command?: string; cwd?: string; workspace_roots?: string[] }): Record<string, unknown> {
  const cwd = payload.cwd || payload.workspace_roots?.[0] || process.cwd();
  const raw = payload.tool_name ?? "";
  const server = /github|gitlab|bitbucket|azure/i.exec(`${payload.url ?? ""} ${payload.command ?? ""}`)?.[0]?.toLowerCase() ?? "unknown";
  const toolName = raw.startsWith("mcp__") ? raw : `mcp__${server}__${raw}`;
  const verdict = evaluateGuard({ cwd, toolName });
  if (!verdict.blocked) return { permission: "allow" };
  const message = denyMessage(verdict);
  return { permission: "deny", userMessage: message, agentMessage: message };
}
