import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "./workspace.js";

// Files the AI touched during one Claude Code session, recorded by PostToolUse and
// checked by Stop. Lives in the user cache, never in the source repo.

export type TouchKind = "read" | "edit";

export interface Touch {
  path: string;
  kind: TouchKind;
}

function sessionFile(ws: Workspace, sessionId: string): string {
  return join(ws.cacheDir, "session", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
}

export function recordTouch(ws: Workspace, sessionId: string, touch: Touch): void {
  const file = sessionFile(ws, sessionId);
  mkdirSync(join(ws.cacheDir, "session"), { recursive: true });
  appendFileSync(file, `${touch.kind}\t${touch.path}\n`);
}

export function readTouches(ws: Workspace, sessionId: string): Touch[] {
  const file = sessionFile(ws, sessionId);
  if (!existsSync(file)) return [];
  const byPath = new Map<string, TouchKind>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [kind, path] = line.split("\t");
    if (!path || (kind !== "read" && kind !== "edit")) continue;
    // An edit outranks a read of the same file.
    if (byPath.get(path) !== "edit") byPath.set(path, kind);
  }
  return [...byPath].map(([path, kind]) => ({ path, kind }));
}

export function clearTouches(ws: Workspace, sessionId: string): void {
  rmSync(sessionFile(ws, sessionId), { force: true });
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SERENA_EDIT = /^mcp__.*serena.*__(replace|insert|create|delete|rename)/i;

/** Extract the touched file from a PostToolUse payload. */
export function touchFromToolUse(toolName: string, toolInput: Record<string, unknown> | undefined): { path: string; kind: TouchKind } | null {
  if (!toolInput) return null;
  const raw = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.relative_path ?? toolInput.path;
  if (typeof raw !== "string" || !raw) return null;
  const kind: TouchKind = EDIT_TOOLS.has(toolName) || SERENA_EDIT.test(toolName) ? "edit" : "read";
  return { path: raw, kind };
}
