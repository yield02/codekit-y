import { isTrackable, lookup } from "./codemap.js";
import { buildContextText, workflowReminder } from "./context.js";
import { createLogger, withCorrelation } from "./logger.js";
import { clearTouches, readTouches, recordTouch, touchFromToolUse } from "./session.js";
import { detectPrMerges } from "./github.js";
import { sync } from "./sync.js";
import { resolveWorkspace, type Workspace } from "./workspace.js";

// Claude Code hook handlers. Each returns the JSON to print on stdout, or null
// for "no output". Hooks never fail the user's session: errors are logged and swallowed.

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

function run(event: string, payload: HookPayload, fn: (ws: Workspace) => HookOutput): HookOutput {
  return withCorrelation(undefined, () => {
    try {
      const res = resolveWorkspace(payload.cwd || process.cwd(), "claude-code");
      if (!res.ok) return null;
      return fn(res.workspace);
    } catch (err) {
      log.error(["hook", event], "Hook failed", err, { cwd: payload.cwd, session: payload.session_id });
      return null;
    }
  });
}

export async function handleSessionStart(payload: HookPayload): Promise<HookOutput> {
  return withCorrelation(undefined, async () => {
    try {
      const res = resolveWorkspace(payload.cwd || process.cwd(), "claude-code");
      if (!res.ok) return null;
      const ws = res.workspace;
      const report = sync(ws);
      const prs = await detectPrMerges(ws).catch((err) => {
        log.warn(["hook", "session-start", "github"], "PR merge detection failed", { error: String(err) });
        return null;
      });
      for (const m of prs?.merged ?? []) report.merged.push({ branch: m.branch, into: m.into, commit: `PR #${m.pr}`, result: m.result });
      log.info(["hook", "session-start"], "Session started", { branch: ws.branch, session: payload.session_id });
      return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: buildContextText(ws, report) } };
    } catch (err) {
      log.error(["hook", "session-start"], "Hook failed", err, { cwd: payload.cwd, session: payload.session_id });
      return null;
    }
  });
}

export function handleUserPromptSubmit(payload: HookPayload): HookOutput {
  return run("prompt", payload, (ws) => ({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: workflowReminder(ws) },
  }));
}

export function handlePostToolUse(payload: HookPayload): HookOutput {
  return run("track", payload, (ws) => {
    const touch = touchFromToolUse(payload.tool_name ?? "", payload.tool_input);
    if (!touch || !payload.session_id) return null;
    const rel = ws.source.relativePath(touch.path);
    if (!rel || !isTrackable(ws, rel)) return null;
    recordTouch(ws, payload.session_id, { path: rel, kind: touch.kind });
    return null;
  });
}

export function handleStop(payload: HookPayload): HookOutput {
  // Second Stop in a row: Claude already got one reminder; let it finish.
  if (payload.stop_hook_active) return null;
  return run("stop", payload, (ws) => {
    if (!payload.session_id) return null;
    const touches = readTouches(ws, payload.session_id).filter((t) => t.kind === "edit" || ws.config.trackReads);
    if (touches.length === 0) return null;
    const pending = lookup(ws, touches.map((t) => t.path)).filter((e) => e.status === "missing" || e.status === "stale");
    if (pending.length === 0) {
      clearTouches(ws, payload.session_id);
      return null;
    }
    const listed = pending.slice(0, MAX_LISTED).map((e) => `- ${e.path} (${e.status}${e.reason ? `: ${e.reason}` : ""})`);
    const more = pending.length > MAX_LISTED ? `\n…and ${pending.length - MAX_LISTED} more` : "";
    const reason =
      `codekit: these files were read or edited this session but their map is missing or stale:\n${listed.join("\n")}${more}\n` +
      `Use the codemap skill: for each file call codemap_write (sections: Purpose, Public API, Main flow, Caveats). ` +
      `Use Serena symbol tools to stay brief.`;
    log.info(["hook", "stop"], "Maps pending at stop", { branch: ws.branch, pending: pending.length, enforce: ws.config.enforce });
    if (ws.config.enforce === "fail") return { decision: "block", reason };
    return { systemMessage: reason };
  });
}
