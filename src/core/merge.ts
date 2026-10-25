import { hashContent } from "./hash.js";
import { mergeLineageText } from "./lineage.js";
import { parseMapFile, serializeMapFile } from "./mapfile.js";
import { normalizeBranch } from "./paths.js";
import type { Snapshot } from "./storage/types.js";

export interface MergeInput {
  base: Snapshot;
  /** Target side (`into`): rel -> content */
  ours: Map<string, string>;
  /** Incoming side (`from`): rel -> content */
  theirs: Map<string, string>;
  fromBranch: string;
  /** Hash of the source file on the target after the merge, or null when unknown/deleted. */
  sourceHashAfterMerge: (sourcePath: string) => string | null;
}

export interface MergeResult {
  /** Changes to apply on top of `ours` (null = delete). */
  changes: Map<string, string | null>;
  takenFromTheirs: string[];
  resolvedConflicts: string[];
  markedStale: string[];
}

/**
 * Maps are derived from code, so conflicts resolve without a human:
 * 1. only one side changed (vs base)       -> take that side
 * 2. both changed                          -> keep the side whose sourceHash matches the merged source
 * 3. neither matches                       -> keep the newer one and flag it `stale`
 * Lineage files are unioned; other files (plans) keep ours and save theirs alongside.
 */
export function resolveMerge(input: MergeInput): MergeResult {
  const result: MergeResult = { changes: new Map(), takenFromTheirs: [], resolvedConflicts: [], markedStale: [] };
  const paths = new Set([...input.base.keys(), ...input.ours.keys(), ...input.theirs.keys()]);

  for (const rel of [...paths].sort()) {
    const o = input.ours.get(rel) ?? null;
    const t = input.theirs.get(rel) ?? null;
    const b = input.base.get(rel) ?? null;
    const ho = o === null ? null : hashContent(o);
    const ht = t === null ? null : hashContent(t);
    if (ho === ht) continue;
    if (ho === b) {
      result.changes.set(rel, t);
      result.takenFromTheirs.push(rel);
      continue;
    }
    if (ht === b) continue;

    // Both sides changed.
    if (o === null || t === null) {
      // One side deleted, the other edited: keep the edit.
      if (o === null) {
        result.changes.set(rel, t);
        result.takenFromTheirs.push(rel);
      }
      result.resolvedConflicts.push(rel);
      continue;
    }
    result.resolvedConflicts.push(rel);
    if (rel.startsWith("lineage/") && rel.endsWith(".json")) {
      result.changes.set(rel, mergeLineageText(o, t));
    } else if (rel.startsWith("modules/") && rel.endsWith(".md")) {
      const resolved = resolveMapConflict(o, t, input.sourceHashAfterMerge);
      if (resolved.content !== o) result.changes.set(rel, resolved.content);
      if (resolved.fromTheirs) result.takenFromTheirs.push(rel);
      if (resolved.stale) result.markedStale.push(rel);
    } else {
      const dot = rel.lastIndexOf(".");
      const alt = `${dot > 0 ? rel.slice(0, dot) : rel}.from-${normalizeBranch(input.fromBranch)}${dot > 0 ? rel.slice(dot) : ""}`;
      result.changes.set(alt, t);
    }
  }
  return result;
}

function resolveMapConflict(
  ours: string,
  theirs: string,
  sourceHashAfterMerge: (p: string) => string | null,
): { content: string; fromTheirs: boolean; stale: boolean } {
  const po = parseMapFile(ours);
  const pt = parseMapFile(theirs);
  if (!po || !pt) return { content: pt && !po ? theirs : ours, fromTheirs: !!pt && !po, stale: false };
  const current = sourceHashAfterMerge(po.meta.path);
  if (current && po.meta.sourceHash === current && !po.meta.stale) return { content: ours, fromTheirs: false, stale: false };
  if (current && pt.meta.sourceHash === current && !pt.meta.stale) return { content: theirs, fromTheirs: true, stale: false };
  const newerIsTheirs = pt.meta.updatedAt > po.meta.updatedAt;
  const winner = newerIsTheirs ? pt : po;
  return { content: serializeMapFile({ ...winner, meta: { ...winner.meta, stale: true } }), fromTheirs: newerIsTheirs, stale: true };
}
