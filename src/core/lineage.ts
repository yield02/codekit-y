import { lineagePathFor } from "./paths.js";
import type { StorageAdapter } from "./storage/types.js";

export interface LineageEvent {
  event: "create" | "sync" | "merge" | "archive" | "set-parent";
  at: string;
  by?: string;
  from?: string;
  into?: string;
  commit?: string;
  pr?: number;
}

export interface Lineage {
  branch: string;
  parent: string | null;
  baseCommit: string | null;
  createdBy: string;
  createdAt: string;
  status: "active" | "archived";
  /** Parent tip last synced into this branch. */
  lastSyncCommit?: string;
  /** Branch tip last merged into the parent. */
  lastMergedCommit?: string;
  events: LineageEvent[];
}

export function readLineage(store: StorageAdapter, branch: string, from: string = branch): Lineage | null {
  const text = store.read(from, lineagePathFor(branch));
  if (!text) return null;
  try {
    return JSON.parse(text) as Lineage;
  } catch {
    return null;
  }
}

export function writeLineage(store: StorageAdapter, lineage: Lineage, message: string): void {
  store.write(lineage.branch, lineagePathFor(lineage.branch), JSON.stringify(lineage, null, 2) + "\n", message);
}

/** Union of two versions of the same lineage file (both sides appended events). */
export function mergeLineageText(ours: string, theirs: string): string {
  try {
    const o = JSON.parse(ours) as Lineage;
    const t = JSON.parse(theirs) as Lineage;
    const seen = new Set<string>();
    const events = [...o.events, ...t.events]
      .filter((e) => {
        const key = JSON.stringify(e);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.at.localeCompare(b.at));
    const merged: Lineage = {
      ...t,
      ...o,
      lastSyncCommit: latest(o, t, "sync") ?? o.lastSyncCommit ?? t.lastSyncCommit,
      lastMergedCommit: latest(o, t, "merge") ?? o.lastMergedCommit ?? t.lastMergedCommit,
      events,
    };
    return JSON.stringify(merged, null, 2) + "\n";
  } catch {
    return ours;
  }
}

function latest(o: Lineage, t: Lineage, kind: "sync" | "merge"): string | undefined {
  const all = [...o.events, ...t.events].filter((e) => e.event === kind && e.commit).sort((a, b) => a.at.localeCompare(b.at));
  return all.at(-1)?.commit;
}

/** Human-readable history: ancestry chain, own events, and children. */
export function formatLineageTree(store: StorageAdapter, branch: string): string {
  const lines: string[] = [];
  const chain: Lineage[] = [];
  let cursor: string | null = branch;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const l = readLineage(store, cursor);
    if (!l) break;
    chain.unshift(l);
    cursor = l.parent;
  }
  if (chain.length === 0) return `No lineage recorded for ${branch}.`;
  chain.forEach((l, i) => {
    const indent = "  ".repeat(i);
    lines.push(`${indent}${i === 0 ? "" : "└─ "}${l.branch}  (from ${l.parent ?? "—"} @ ${short(l.baseCommit)}, by ${l.createdBy}, ${l.createdAt.slice(0, 10)})`);
  });
  const self = chain.at(-1)!;
  const indent = "  ".repeat(chain.length);
  for (const e of self.events) {
    const what =
      e.event === "sync" ? `synced from ${e.from} @ ${short(e.commit)}` :
      e.event === "merge" ? `merged into ${e.into} @ ${short(e.commit)}${e.pr ? ` (PR #${e.pr})` : ""}` :
      e.event === "set-parent" ? `parent set to ${e.from}` :
      e.event;
    lines.push(`${indent}• ${e.at.slice(0, 16).replace("T", " ")}  ${what}${e.by ? ` — ${e.by}` : ""}`);
  }
  const children = store
    .listBranches()
    .map((b) => readLineage(store, b))
    .filter((l): l is Lineage => !!l && l.parent === branch);
  if (children.length) {
    lines.push(`${indent}children:`);
    for (const c of children) lines.push(`${indent}  - ${c.branch}${c.lastMergedCommit ? " (merged back)" : ""}`);
  }
  return lines.join("\n");
}

function short(commit: string | null | undefined): string {
  return commit ? commit.slice(0, 8) : "—";
}
