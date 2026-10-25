import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { artifactKind, denyAdvice, hookBypass, mcpWriteTargets, shellWriteTargets, type ArtifactRules } from "./artifacts.js";
import { checkMcpTool, checkShellCommand, commandTargetDirs, type GuardVerdict } from "./guard.js";
import { createLogger, withCorrelation } from "./logger.js";
import { registeredSourcesUnder } from "./parent.js";
import { parseStoreConfig, type ProjectEntry } from "./config.js";
import { createStorage, findRegisteredSource, resolveWorkspace } from "./workspace.js";

// Guards for AI agents in registered source repos:
// - push guard: nothing may be pushed or written to the remote;
// - artifact guard: no AI files (rules, plans, tool config, memories) may be created or changed;
// - hook bypass: the commit/push hooks may not be skipped or replaced.
// Fail closed: once a call is known to target a registered repo, an error while checking it denies it.

const log = createLogger("codemap-guard");
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const PUSH_POLICY =
  "codekit policy: AI agents may read, edit and commit locally in this source repository, but must never push " +
  "or write to the remote (git push, PRs, merges, GitHub API writes). Leave the commits for the developer to review and push.";
const ARTIFACT_POLICY =
  "codekit policy: the source repository must not contain AI files (rules, plans, tool configuration, memories); " +
  "they live in the knowledge store and in user-level configuration.";

export interface GuardInput {
  cwd: string;
  toolName: string;
  command?: string;
  toolInput?: Record<string, unknown>;
}

export type GuardResult = GuardVerdict & { repo?: string; policy?: "push" | "artifact" };

/** Shared decision for Claude Code (PreToolUse) and Cursor (beforeShellExecution / beforeMCPExecution). */
export function evaluateGuard(input: GuardInput): GuardResult {
  return withCorrelation(undefined, () => {
    if (FILE_TOOLS.has(input.toolName)) {
      const path = input.toolInput?.file_path ?? input.toolInput?.notebook_path;
      return typeof path === "string" ? checkArtifactPaths([path], [input.cwd], input.toolName) : { blocked: false };
    }

    if (SHELL_TOOLS.has(input.toolName) || input.toolName === "shell") {
      const command = input.command ?? "";
      if (!command.trim()) return { blocked: false };
      const cdDirs = commandTargetDirs(command).map((d) => (isAbsolute(d) ? d : resolve(input.cwd, d)));
      const dirs = [input.cwd, ...cdDirs];
      let target = dirs.map((d) => safeFind(d)).find((r) => r !== null) ?? null;
      // Parent folder holding registered repos (Transfer/{Core,Admin,…}): the shell may be inside any
      // of them, so every push-like command is denied, with the aliases of all of them.
      const children = target ? [] : safeChildren(input.cwd);
      if (!target && children.length) target = children[0]!;
      if (target) {
        try {
          const aliases = Object.assign({}, ...[target, ...children].map((t) => t.source.gitAliases()));
          const verdict = checkShellCommand(command, { gitAliases: aliases, readScript: (p) => readScript(input.cwd, p) });
          if (verdict.blocked) {
            log.warn(["guard", "deny"], "Blocked shell command", { rule: verdict.rule, repo: target.source.root, command });
            return { ...verdict, repo: target.source.root, policy: "push" };
          }
          const bypass = hookBypass(command);
          if (bypass) {
            log.warn(["guard", "deny"], "Blocked hook bypass", { repo: target.source.root, command });
            return { blocked: true, rule: "hook-bypass", reason: bypass, repo: target.source.root, policy: "artifact" };
          }
        } catch (err) {
          log.error(["guard", "deny"], "Guard check failed; denying", err, { repo: target.source.root });
          return { blocked: true, rule: "guard-error", reason: "The push guard could not verify this command.", repo: target.source.root, policy: "push" };
        }
      }
      // File writes are checked by where the file lands, even when the shell runs outside the repo.
      return checkArtifactPaths(shellWriteTargets(command), [...dirs, ...children.map((c) => c.source.root)], "shell");
    }

    if (input.toolName.startsWith("mcp__")) {
      const children = safeChildren(input.cwd);
      const target = safeFind(input.cwd) ?? children[0] ?? null;
      if (target) {
        let allow: string[] = [];
        try {
          const res = resolveWorkspace(target.source.root, "guard");
          if (res.ok) allow = res.workspace.config.guard.allowMcpTools;
        } catch {
          // store unreachable: no allow-list, stay strict
        }
        const verdict = checkMcpTool(input.toolName, allow);
        if (verdict.blocked) {
          log.warn(["guard", "deny"], "Blocked MCP tool", { rule: verdict.rule, tool: input.toolName, repo: target.source.root });
          return { ...verdict, repo: target.source.root, policy: "push" };
        }
      }
      return checkArtifactPaths(mcpWriteTargets(input.toolName, input.toolInput), [input.cwd, ...children.map((c) => c.source.root)], input.toolName);
    }
    return { blocked: false };
  });
}

/**
 * Deny when any path resolves to an AI artifact inside a registered repo. Relative paths are tried
 * against every base (cwd, `cd` targets, sub-repos of a parent folder): strict on ambiguity.
 */
function checkArtifactPaths(paths: string[], bases: string[], via: string): GuardResult {
  for (const raw of paths) {
    const candidates = isAbsolute(raw) ? [resolve(raw)] : [...new Set(bases.map((b) => resolve(b, raw)))];
    for (const abs of candidates) {
      const owner = ownerOf(abs);
      if (!owner) continue;
      try {
        const rel = owner.source.relativePath(abs) ?? (isRepoRoot(owner.source.root, abs) ? "" : null);
        if (rel === null) continue;
        const kind = artifactKind(rel, rulesFor(owner.project));
        if (!kind) continue;
        const reason = `${rel} in repo "${owner.repo.name}" is an AI ${kind === "guard" ? "guard" : kind} file. ${denyAdvice(kind)}`;
        log.warn(["guard", "deny", "artifact"], "Blocked AI artifact write", { via, repo: owner.repo.name, path: rel, kind });
        return { blocked: true, rule: `artifact-${kind}`, reason, repo: owner.source.root, policy: "artifact" };
      } catch (err) {
        log.error(["guard", "deny", "artifact"], "Artifact check failed; denying", err, { via, path: abs });
        return { blocked: true, rule: "guard-error", reason: `The artifact guard could not verify ${raw}.`, repo: owner.source.root, policy: "artifact" };
      }
    }
  }
  return { blocked: false };
}

/** Registered repo that contains `abs` (which may not exist yet). Paths inside `.git/` belong to its work tree. */
function ownerOf(abs: string) {
  const gitIdx = abs.toLowerCase().lastIndexOf(`${sep}.git${sep}`);
  let dir = gitIdx !== -1 ? abs.slice(0, gitIdx) : dirname(abs);
  if (gitIdx === -1 && abs.toLowerCase().endsWith(`${sep}.git`)) dir = abs.slice(0, -5);
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  const found = safeFind(dir);
  if (!found) return null;
  // `relativePath` treats `.git/...` like any repo-relative path, which is what the patterns expect.
  return found;
}

function isRepoRoot(root: string, abs: string): boolean {
  return resolve(root) === resolve(abs);
}

const rulesCache = new Map<string, ArtifactRules>();

/** Team exceptions/extra patterns from the store's codekit.yaml (read directly: hooks run on every write). */
function rulesFor(project: ProjectEntry): ArtifactRules {
  const key = `${project.name}|${project.store.url ?? project.store.path ?? ""}`;
  const cached = rulesCache.get(key);
  if (cached) return cached;
  let rules: ArtifactRules = { extra: [], allow: [] };
  try {
    const guard = parseStoreConfig(createStorage(project, "guard").readConfig("codekit.yaml"), project.name).guard;
    rules = { extra: guard.artifactPaths, allow: guard.allowPaths };
  } catch {
    // store unreachable: defaults only (no exceptions), stay strict
  }
  rulesCache.set(key, rules);
  return rules;
}

/** Hooks are short-lived processes; long-lived callers (MCP server, tests) can drop the cache. */
export function clearGuardCache(): void {
  rulesCache.clear();
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

function denyMessage(v: GuardResult): string {
  if (v.policy === "artifact") return `codekit: ${v.reason ?? "This would add an AI file to the source repo."} ${ARTIFACT_POLICY}`;
  return `${v.reason ?? "This would write to the remote."} ${PUSH_POLICY}`;
}

/** Claude Code PreToolUse output. */
export function handlePreToolUse(payload: { cwd?: string; tool_name?: string; tool_input?: Record<string, unknown> }): Record<string, unknown> | null {
  const toolName = payload.tool_name ?? "";
  const command = typeof payload.tool_input?.command === "string" ? payload.tool_input.command : undefined;
  const verdict = evaluateGuard({ cwd: payload.cwd || process.cwd(), toolName, command, toolInput: payload.tool_input });
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
export function handleCursorMcp(payload: { tool_name?: string; tool_input?: Record<string, unknown> | string; url?: string; command?: string; cwd?: string; workspace_roots?: string[] }): Record<string, unknown> {
  const cwd = payload.cwd || payload.workspace_roots?.[0] || process.cwd();
  const raw = payload.tool_name ?? "";
  const server = /github|gitlab|bitbucket|azure|serena|filesystem/i.exec(`${payload.url ?? ""} ${payload.command ?? ""}`)?.[0]?.toLowerCase() ?? "unknown";
  const toolName = raw.startsWith("mcp__") ? raw : `mcp__${server}__${raw}`;
  let toolInput: Record<string, unknown> | undefined;
  if (typeof payload.tool_input === "string") {
    try {
      toolInput = JSON.parse(payload.tool_input) as Record<string, unknown>;
    } catch {
      toolInput = undefined;
    }
  } else toolInput = payload.tool_input;
  const verdict = evaluateGuard({ cwd, toolName, toolInput });
  if (!verdict.blocked) return { permission: "allow" };
  const message = denyMessage(verdict);
  return { permission: "deny", userMessage: message, agentMessage: message };
}
