import { hashContent } from "./hash.js";
import { readLineage, writeLineage, type Lineage } from "./lineage.js";
import { createLogger } from "./logger.js";
import { resolveMerge, type MergeResult } from "./merge.js";
import type { Workspace } from "./workspace.js";

const log = createLogger("codemap");

export interface SyncReport {
  branch: string;
  created?: { branch: string; parent: string | null };
  synced: { from: string; commit: string; result: MergeSummary }[];
  merged: { branch: string; into: string; commit: string; result: MergeSummary }[];
  archived: string[];
}

export interface MergeSummary {
  changed: number;
  resolvedConflicts: string[];
  markedStale: string[];
}

/**
 * Create the map branch for the current source branch if needed. Parent comes from
 * the HEAD reflog (`checkout: moving from X to Y`), falling back to the nearest merge-base.
 */
export function ensureBranch(ws: Workspace): SyncReport["created"] | undefined {
  if (ws.store.hasBranch(ws.branch)) return undefined;
  const existing = ws.store.listBranches();
  const parent = existing.length ? ws.source.detectParent(ws.branch, existing) : null;
  ws.store.createBranch(ws.branch, parent);
  const head = ws.source.head();
  const parentRef = parent ? ws.source.resolveBranch(parent) : null;
  const lineage: Lineage = {
    branch: ws.branch,
    parent,
    baseCommit: head && parentRef ? ws.source.mergeBase(head, parentRef) : head,
    createdBy: ws.actor,
    createdAt: new Date().toISOString(),
    status: "active",
    events: [{ event: "create", at: new Date().toISOString(), by: ws.actor, ...(parent ? { from: parent } : {}) }],
  };
  writeLineage(ws.store, lineage, `lineage: create ${ws.branch} from ${parent ?? "(root)"}`);
  log.info(["codemap", "sync", "branch"], "Created map branch", { branch: ws.branch, parent });
  return { branch: ws.branch, parent };
}

/** Merge the map of `from` into `into`, resolving conflicts against the source at `sourceRef`. */
export function mergeMaps(ws: Workspace, from: string, into: string, sourceRef: string | null, message: string): MergeSummary {
  const base = ws.store.baseSnapshot(from, into);
  const read = (branch: string) => {
    const m = new Map<string, string>();
    for (const rel of ws.store.list(branch)) {
      const c = ws.store.read(branch, rel);
      if (c !== null) m.set(rel, c);
    }
    return m;
  };
  const result: MergeResult = resolveMerge({
    base,
    ours: read(into),
    theirs: read(from),
    fromBranch: from,
    sourceHashAfterMerge: (path) => {
      const content = sourceRef ? ws.source.showFile(sourceRef, path) : null;
      return content === null ? null : hashContent(content);
    },
  });
  ws.store.commitMerge(from, into, result.changes, message);
  log.info(["codemap", "merge"], "Merged maps", {
    from,
    into,
    changed: result.changes.size,
    conflicts: result.resolvedConflicts.length,
    stale: result.markedStale.length,
  });
  return { changed: result.changes.size, resolvedConflicts: result.resolvedConflicts, markedStale: result.markedStale };
}

/**
 * Lazy branch/merge detection. Runs on SessionStart and on MCP calls:
 * - new source branch            -> create its map branch from the parent's map
 * - branch merged into its parent -> merge maps into the parent's map
 * - parent merged into branch     -> sync the parent's map into the branch's map
 * - merged branch deleted         -> archive its map
 */
export function sync(ws: Workspace): SyncReport {
  ws.store.refresh();
  const report: SyncReport = { branch: ws.branch, synced: [], merged: [], archived: [] };
  report.created = ensureBranch(ws);

  for (const b of ws.store.listBranches()) {
    const lineage = readLineage(ws.store, b);
    if (!lineage || lineage.status !== "active" || !lineage.parent) continue;
    const tip = ws.source.resolveBranch(b);
    const parentTip = ws.source.resolveBranch(lineage.parent);

    if (tip && parentTip && ws.store.hasBranch(lineage.parent)
      && tip !== lineage.baseCommit && tip !== lineage.lastMergedCommit
      && ws.source.isAncestor(tip, parentTip)) {
      const updated: Lineage = {
        ...lineage,
        lastMergedCommit: tip,
        events: [...lineage.events, { event: "merge", into: lineage.parent, commit: tip, at: new Date().toISOString(), by: ws.actor }],
      };
      // Record first so the lineage file travels into the parent with the merge.
      writeLineage(ws.store, updated, `lineage: ${b} merged into ${lineage.parent}`);
      const result = mergeMaps(ws, b, lineage.parent, parentTip, `merge: map ${b} into ${lineage.parent}`);
      report.merged.push({ branch: b, into: lineage.parent, commit: tip, result });
      continue;
    }

    if (!tip && lineage.lastMergedCommit && b !== ws.branch && b !== ws.config.defaultBranch) {
      writeLineage(ws.store, { ...lineage, status: "archived", events: [...lineage.events, { event: "archive", at: new Date().toISOString(), by: ws.actor }] }, `lineage: archive ${b}`);
      ws.store.archiveBranch(b);
      report.archived.push(b);
    }
  }

  const own = readLineage(ws.store, ws.branch);
  const head = ws.source.head();
  if (own?.parent && head && ws.store.hasBranch(own.parent)) {
    const parentTip = ws.source.resolveBranch(own.parent);
    if (parentTip && parentTip !== own.baseCommit && parentTip !== own.lastSyncCommit
      && parentTip !== own.lastMergedCommit && ws.source.isAncestor(parentTip, head)) {
      const result = mergeMaps(ws, own.parent, ws.branch, head, `sync: map ${own.parent} into ${ws.branch}`);
      const latest = readLineage(ws.store, ws.branch) ?? own;
      writeLineage(ws.store, {
        ...latest,
        lastSyncCommit: parentTip,
        events: [...latest.events, { event: "sync", from: own.parent, commit: parentTip, at: new Date().toISOString(), by: ws.actor }],
      }, `lineage: ${ws.branch} synced from ${own.parent}`);
      report.synced.push({ from: own.parent, commit: parentTip, result });
    }
  }
  return report;
}

/** Manual merge (squash merges, cross-branch merges the lazy detection cannot see). */
export function manualMerge(ws: Workspace, from: string, into: string, pr?: number): MergeSummary {
  if (!ws.store.hasBranch(from)) throw new Error(`No map for branch ${from}`);
  if (!ws.store.hasBranch(into)) throw new Error(`No map for branch ${into}`);
  const lineage = readLineage(ws.store, from);
  const tip = ws.source.resolveBranch(from) ?? undefined;
  if (lineage) {
    writeLineage(ws.store, {
      ...lineage,
      ...(tip ? { lastMergedCommit: tip } : {}),
      events: [...lineage.events, { event: "merge", into, at: new Date().toISOString(), by: ws.actor, ...(tip ? { commit: tip } : {}), ...(pr ? { pr } : {}) }],
    }, `lineage: ${from} merged into ${into}`);
  }
  return mergeMaps(ws, from, into, ws.source.resolveBranch(into), `merge: map ${from} into ${into}${pr ? ` (PR #${pr})` : ""}`);
}

export function setParent(ws: Workspace, branch: string, parent: string): void {
  const lineage = readLineage(ws.store, branch);
  if (!lineage) throw new Error(`No lineage for ${branch}`);
  const tip = ws.source.resolveBranch(branch);
  const parentTip = ws.source.resolveBranch(parent);
  writeLineage(ws.store, {
    ...lineage,
    parent,
    baseCommit: tip && parentTip ? ws.source.mergeBase(tip, parentTip) : lineage.baseCommit,
    events: [...lineage.events, { event: "set-parent", from: parent, at: new Date().toISOString(), by: ws.actor }],
  }, `lineage: set parent of ${branch} to ${parent}`);
}
