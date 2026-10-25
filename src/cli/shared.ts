import { readFileSync } from "node:fs";
import { folderOf, resolveRoots } from "../core/parent.js";
import { resolveWorkspace, type Workspace } from "../core/workspace.js";

export function requireWorkspace(cwd: string, tool = "cli"): Workspace {
  const res = resolveWorkspace(cwd, tool);
  if (res.ok) return res.workspace;
  const parent = resolveRoots([cwd], tool);
  if (parent.kind === "parent") {
    throw new Error(`${cwd} holds several repos (${parent.parent.workspaces.map((w) => `${folderOf(parent.parent, w)}/`).join(", ")}); run this command with -C <one of them>.`);
  }
  const hint =
    res.reason === "not-registered"
      ? `Remote ${res.detail} is not registered. Run: codekit init --project <name> --backend git|folder ...`
      : res.reason === "no-remote"
        ? `Repo ${res.detail} has no 'origin' remote.`
        : `${res.detail} is not inside a git repository.`;
  throw new Error(hint);
}

/** The repo at `cwd`, or every registered repo of a parent folder. */
export function requireWorkspaces(cwd: string, tool = "cli"): Workspace[] {
  const res = resolveRoots([cwd], tool);
  if (res.kind === "repo") return [res.ws];
  if (res.kind === "parent") return res.parent.workspaces;
  return [requireWorkspace(cwd, tool)];
}

export function readStdinJson(): Record<string, unknown> {
  try {
    const text = readFileSync(0, "utf8");
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function print(value: unknown, json: boolean): void {
  process.stdout.write(json || typeof value !== "string" ? JSON.stringify(value, null, 2) + "\n" : value + "\n");
}

export function fail(err: unknown): never {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
