import { readFileSync } from "node:fs";
import { resolveWorkspace, type Workspace } from "../core/workspace.js";

export function requireWorkspace(cwd: string, tool = "cli"): Workspace {
  const res = resolveWorkspace(cwd, tool);
  if (res.ok) return res.workspace;
  const hint =
    res.reason === "not-registered"
      ? `Remote ${res.detail} is not registered. Run: codekit init --project <name> --backend git|folder ...`
      : res.reason === "no-remote"
        ? `Repo ${res.detail} has no 'origin' remote.`
        : `${res.detail} is not inside a git repository.`;
  throw new Error(hint);
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
