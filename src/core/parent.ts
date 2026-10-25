import { existsSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { loadUserConfig } from "./config.js";
import { canonicalPath } from "./paths.js";
import { SourceRepo } from "./source.js";
import { findRegisteredSource, resolveWorkspace, type Workspace } from "./workspace.js";

// "Parent folder" mode: the AI tool is opened on a folder that is not a git repo but
// contains several registered repos (Transfer/{Transactions,Core,Abs,Admin}), or on a
// multi-root workspace whose roots are those repos. Every path is routed to its repo.

export interface ParentContext {
  /** Folder the tool was opened on (or the first root). */
  root: string;
  /** One workspace per registered repo found under the root(s), sorted by repo name. */
  workspaces: Workspace[];
}

/** The workspace for one dir, or the parent context when `dirs` hold several registered repos. */
export type Resolution = { kind: "repo"; ws: Workspace } | { kind: "parent"; parent: ParentContext } | { kind: "none"; reason: string };

const MAX_SCAN_DEPTH = 2;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", "bin", "obj", ".venv", "vendor"]);

/** Resolve one or more roots (cwd, or MCP client roots) to a repo or a parent context. */
export function resolveRoots(dirs: string[], tool = "codekit"): Resolution {
  const roots = dirs.filter(Boolean).map((d) => canonicalPath(d));
  if (roots.length === 0) return { kind: "none", reason: "no directory" };
  let firstReason = "";
  if (roots.length === 1) {
    const single = resolveWorkspace(roots[0]!, tool);
    if (single.ok) return { kind: "repo", ws: single.workspace };
    // Not a repo, or an unregistered umbrella repo (e.g. with submodules): look for registered repos inside.
    firstReason = `${single.reason}: ${single.detail}`;
  }
  const byRoot = new Map<string, Workspace>();
  for (const root of roots) {
    const direct = resolveWorkspace(root, tool);
    if (direct.ok) byRoot.set(direct.workspace.source.root, direct.workspace);
    else for (const ws of findRegisteredUnder(root, tool)) byRoot.set(ws.source.root, ws);
  }
  const workspaces = [...byRoot.values()].sort((a, b) => a.repo.name.localeCompare(b.repo.name));
  if (workspaces.length === 0) return { kind: "none", reason: firstReason || `no codekit repo in ${roots.join(", ")}` };
  if (workspaces.length === 1 && roots.length === 1 && workspaces[0]!.source.root === roots[0]) return { kind: "repo", ws: workspaces[0]! };
  return { kind: "parent", parent: { root: roots[0]!, workspaces } };
}

/**
 * Folders below `root` that may hold registered repos. `codekit init` records each clone's
 * path, so the user config is enough; a shallow scan only runs for repos registered by
 * older versions (no `localPath`). Keeps hooks fast in big unrelated folders.
 */
function candidateDirs(root: string): string[] {
  const repos = loadUserConfig().projects.flatMap((p) => p.repos);
  const known = repos.map((r) => r.localPath).filter((d): d is string => !!d && isInside(root, d) && existsSync(d));
  const scan = repos.some((r) => !r.localPath) ? gitDirsUnder(root, MAX_SCAN_DEPTH) : [];
  return [...new Set([...known, ...scan].map((d) => resolve(d)))];
}

/** Registered repos below `root`. */
export function findRegisteredUnder(root: string, tool = "codekit"): Workspace[] {
  const found = new Map<string, Workspace>();
  for (const dir of candidateDirs(root)) {
    const res = resolveWorkspace(dir, tool);
    if (res.ok && isInside(root, res.workspace.source.root)) found.set(res.workspace.source.root, res.workspace);
  }
  return [...found.values()];
}

/** Child folders that are git repos (a `.git` dir or file), up to `depth` levels. */
export function gitDirsUnder(root: string, depth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, level: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const child = join(dir, e.name);
      if (existsSync(join(child, ".git"))) out.push(child);
      else if (level < depth) walk(child, level + 1);
    }
  };
  walk(root, 1);
  return out.sort();
}

/** The repo a path belongs to: `Core/src/x.ts` (relative to the parent), an absolute path, or `core:src/x.ts`. */
export function workspaceForPath(parent: ParentContext, input: string): { ws: Workspace; path: string } | null {
  const qualified = /^([A-Za-z0-9._-]{2,}):(?![\\/]{2})(.+)$/.exec(input.trim());
  if (qualified) {
    const ws = parent.workspaces.find((w) => w.repo.name === qualified[1]);
    if (ws) return { ws, path: qualified[2]!.replace(/\\/g, "/") };
  }
  const abs = isAbsolute(input) ? resolve(input) : resolve(parent.root, input);
  const owner = parent.workspaces
    .filter((w) => isInside(w.source.root, abs))
    .sort((a, b) => b.source.root.length - a.source.root.length)[0];
  if (!owner) return null;
  const rel = owner.source.relativePath(abs);
  return rel ? { ws: owner, path: rel } : null;
}

export function workspaceByRepo(parent: ParentContext, repo: string): Workspace | undefined {
  return parent.workspaces.find((w) => w.repo.name === repo);
}

/** `Core` folder of repo `core`, relative to the parent root (for messages). */
export function folderOf(parent: ParentContext, ws: Workspace): string {
  return relative(parent.root, ws.source.root).replace(/\\/g, "/") || basename(ws.source.root);
}

export function isInside(root: string, path: string): boolean {
  const ok = (r: string) => r === "" || (!r.startsWith("..") && !isAbsolute(r));
  return ok(relative(resolve(root), resolve(path))) || ok(relative(canonicalPath(root), canonicalPath(path)));
}

/** Light version for the push guard (no store access): registered repos below `root`. */
export function registeredSourcesUnder(root: string): NonNullable<ReturnType<typeof findRegisteredSource>>[] {
  const out = new Map<string, NonNullable<ReturnType<typeof findRegisteredSource>>>();
  for (const dir of candidateDirs(root)) {
    const found = findRegisteredSource(dir);
    if (found && isInside(root, found.source.root)) out.set(found.source.root, found);
  }
  return [...out.values()];
}

/** Folders under `root` that are git repos with an origin remote (for `codekit init --all`). */
export function repoFoldersUnder(root: string): string[] {
  return gitDirsUnder(root, MAX_SCAN_DEPTH).filter((d) => SourceRepo.open(d)?.remoteUrl());
}
