import { dirname, isAbsolute, resolve } from "node:path";
import { isTrackable, lookup, type LookupEntry } from "./codemap.js";
import { buildContextText, buildParentContextText, workflowReminder } from "./context.js";
import { createLogger, withCorrelation } from "./logger.js";
import { resolveRoots } from "./parent.js";
import { clearTouches, readTouches, recordTouch, touchFromToolUse } from "./session.js";
import { detectPrMerges } from "./github.js";
import { sync, type SyncReport } from "./sync.js";
import { resolveWorkspace, type Workspace } from "./workspace.js";

// Claude Code hook handlers. Each returns the JSON to print on stdout, or null
// for "no output". Hooks never fail the user's session: errors are logged and swallowed.
// They work both inside one repo and on a parent folder holding several registered repos.

const log = createLogger("codemap-hook");
const MAX_LISTED = 20;

export interface HookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
  prompt?: string;
}

type HookOutput = Record<string, unknown> | null;

async function guarded<T>(event: string, payload: HookPayload, fn: () => T | Promise<T>): Promise<T | null> {
  return withCorrelation(undefined, async () => {
    try {
      return await fn();
    } catch (err) {
      log.error(["hook", event], "Hook failed", err, { cwd: payload.cwd, session: payload.session_id });
      return null;
    }
  });
}

async function syncWithPrs(ws: Workspace): Promise<SyncReport> {
  const report = sync(ws);
  const prs = await detectPrMerges(ws).catch((err) => {
    log.warn(["hook", "session-start", "github"], "PR merge detection failed", { error: String(err), repo: ws.repo.name });
    return null;
  });
  for (const m of prs?.merged ?? []) report.merged.push({ branch: m.branch, into: m.into, commit: `PR #${m.pr}`, result: m.result });
  return report;
}

export async function handleSessionStart(payload: HookPayload): Promise<HookOutput> {
  return guarded("session-start", payload, async () => {
    const res = resolveRoots([payload.cwd || process.cwd()], "claude-code");
    if (res.kind === "none") return null;
    let text: string;
    if (res.kind === "repo") {
      text = buildContextText(res.ws, await syncWithPrs(res.ws));
    } else {
      const reports = new Map<string, SyncReport>();
      for (const ws of res.parent.workspaces) reports.set(ws.repo.name, await syncWithPrs(ws));
      text = buildParentContextText(res.parent, reports);
    }
    log.info(["hook", "session-start"], "Session started", { mode: res.kind, session: payload.session_id });
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } };
  });
}

export async function handleUserPromptSubmit(payload: HookPayload): Promise<HookOutput> {
  return guarded("prompt", payload, () => {
    const res = resolveRoots([payload.cwd || process.cwd()], "claude-code");
    if (res.kind === "none") return null;
    const text = res.kind === "repo" ? workflowReminder(res.ws) : workflowReminder(res.parent.workspaces[0]!, res.parent);
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } };
  });
}

/** Record the touched file in the session of the repo that owns it (found from the file itself). */
export async function handlePostToolUse(payload: HookPayload): Promise<HookOutput> {
  return guarded("track", payload, () => {
    const touch = touchFromToolUse(payload.tool_name ?? "", payload.tool_input);
    if (!touch || !payload.session_id) return null;
    const cwd = payload.cwd || process.cwd();
    const abs = isAbsolute(touch.path) ? touch.path : resolve(cwd, touch.path);
    // The owning repo is resolved from the file's own folder, so it works from a parent folder too.
    const res = resolveWorkspace(dirname(abs), "claude-code");
    if (!res.ok) return null;
    const ws = res.workspace;
    const rel = ws.source.relativePath(abs);
    if (!rel || !isTrackable(ws, rel)) return null;
    recordTouch(ws, payload.session_id, { path: rel, kind: touch.kind });
    return null;
  });
}

export async function handleStop(payload: HookPayload): Promise<HookOutput> {
  // Second Stop in a row: Claude already got one reminder; let it finish.
  if (payload.stop_hook_active) return null;
  return guarded("stop", payload, () => {
    if (!payload.session_id) return null;
    const res = resolveRoots([payload.cwd || process.cwd()], "claude-code");
    if (res.kind === "none") return null;
    const workspaces = res.kind === "repo" ? [res.ws] : res.parent.workspaces;
    const label = (ws: Workspace, e: LookupEntry) => (res.kind === "parent" ? `${ws.repo.name}:${e.path}` : e.path);

    const pending: { ws: Workspace; entry: LookupEntry }[] = [];
    for (const ws of workspaces) {
      const touches = readTouches(ws, payload.session_id).filter((t) => t.kind === "edit" || ws.config.trackReads);
      if (touches.length === 0) continue;
      const missing = lookup(ws, touches.map((t) => t.path)).filter((e) => e.status === "missing" || e.status === "stale");
      if (missing.length === 0) clearTouches(ws, payload.session_id);
      for (const entry of missing) pending.push({ ws, entry });
    }
    if (pending.length === 0) return null;

    const listed = pending.slice(0, MAX_LISTED).map(({ ws, entry }) => `- ${label(ws, entry)} (${entry.status}${entry.reason ? `: ${entry.reason}` : ""})`);
    const more = pending.length > MAX_LISTED ? `\n…and ${pending.length - MAX_LISTED} more` : "";
    const how = res.kind === "parent"
      ? `call codemap_write with path "<repo>:<path>" as listed (each repo has its own map)`
      : `call codemap_write`;
    const reason =
      `codekit: these files were read or edited this session but their map is missing or stale:\n${listed.join("\n")}${more}\n` +
      `Use the codemap skill: for each file ${how} (sections: Purpose, Public API, Main flow, Caveats). ` +
      `Use Serena symbol tools to stay brief.`;
    const enforce = pending.some(({ ws }) => ws.config.enforce === "fail");
    log.info(["hook", "stop"], "Maps pending at stop", { mode: res.kind, pending: pending.length, enforce });
    return enforce ? { decision: "block", reason } : { systemMessage: reason };
  });
}

