import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isIncluded } from "./glob.js";
import { hashFile } from "./hash.js";
import { lintMapBody, parseMapFile, serializeMapFile, type MapFile } from "./mapfile.js";
import { mapPathFor, normalizeBranch, slugify, sourcePathFromMap, toPosix } from "./paths.js";
import type { Workspace } from "./workspace.js";

export type EntryStatus = "ok" | "missing" | "stale" | "excluded" | "not-found";

export interface LookupEntry {
  path: string;
  status: EntryStatus;
  /** Why it is stale: the source changed since the map was written, or a merge flagged it. */
  reason?: string;
  map?: MapFile;
}

export interface IndexEntry {
  path: string;
  tags: string[];
  dependsOn: string[];
  updatedAt: string;
  updatedBy: string;
  stale: boolean;
}

export interface MapIndex {
  project: string;
  branch: string;
  generatedAt: string;
  entries: IndexEntry[];
  coverage: { mapped: number; total: number; percent: number };
}

export function isTrackable(ws: Workspace, path: string): boolean {
  return isIncluded(toPosix(path), ws.config.include, ws.config.exclude);
}

export function lookup(ws: Workspace, paths: string[]): LookupEntry[] {
  return paths.map((input) => {
    const path = ws.source.relativePath(input) ?? toPosix(input);
    if (!isTrackable(ws, path)) return { path, status: "excluded" };
    const currentHash = hashFile(ws.source.absolutePath(path));
    const text = ws.store.read(ws.branch, mapPathFor(path));
    const map = text ? parseMapFile(text) ?? undefined : undefined;
    if (currentHash === null) return map ? { path, status: "not-found", map } : { path, status: "not-found" };
    if (!map) return { path, status: "missing" };
    if (map.meta.stale) return { path, status: "stale", reason: "flagged stale by a merge", map };
    if (map.meta.sourceHash !== currentHash) return { path, status: "stale", reason: "source changed since the map was written", map };
    return { path, status: "ok", map };
  });
}

export interface WriteMapInput {
  path: string;
  body: string;
  dependsOn?: string[];
  tags?: string[];
}

export function writeMap(ws: Workspace, input: WriteMapInput): { mapPath: string; sourceHash: string; warnings: string[] } {
  const path = ws.source.relativePath(input.path) ?? toPosix(input.path);
  if (!isTrackable(ws, path)) throw new Error(`${path} is excluded by codekit.yaml; it does not need a map.`);
  const sourceHash = hashFile(ws.source.absolutePath(path));
  if (sourceHash === null) throw new Error(`Source file not found: ${path}`);
  const file: MapFile = {
    meta: {
      path,
      sourceHash,
      updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      updatedBy: ws.actor,
      branch: ws.branch,
      dependsOn: (input.dependsOn ?? []).map((d) => ws.source.relativePath(d) ?? toPosix(d)),
      tags: input.tags ?? [],
      stale: false,
    },
    body: input.body,
  };
  const mapPath = mapPathFor(path);
  ws.store.write(ws.branch, mapPath, serializeMapFile(file), `map: ${path}`);
  return { mapPath, sourceHash, warnings: lintMapBody(file.body, ws.config.mapMaxLines) };
}

export function readAllMaps(ws: Workspace): MapFile[] {
  return ws.store
    .list(ws.branch, "modules/")
    .filter((p) => sourcePathFromMap(p) !== null)
    .map((p) => ws.store.read(ws.branch, p))
    .map((t) => (t ? parseMapFile(t) : null))
    .filter((m): m is MapFile => m !== null);
}

/** Rebuild the local index (never stored in the knowledge store). */
export function buildIndex(ws: Workspace): MapIndex {
  const maps = readAllMaps(ws);
  const trackable = ws.source.listFiles().filter((f) => isTrackable(ws, f));
  const trackableSet = new Set(trackable);
  const mapped = maps.filter((m) => trackableSet.has(m.meta.path)).length;
  const index: MapIndex = {
    project: ws.project.name,
    branch: ws.branch,
    generatedAt: new Date().toISOString(),
    entries: maps.map((m) => ({
      path: m.meta.path,
      tags: m.meta.tags,
      dependsOn: m.meta.dependsOn,
      updatedAt: m.meta.updatedAt,
      updatedBy: m.meta.updatedBy,
      stale: m.meta.stale,
    })),
    coverage: { mapped, total: trackable.length, percent: trackable.length ? Math.round((mapped / trackable.length) * 100) : 0 },
  };
  const dir = join(ws.cacheDir, normalizeBranch(ws.branch));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.json"), JSON.stringify(index, null, 2));
  return index;
}

export function search(ws: Workspace, query: string, limit = 20): IndexEntry[] {
  const q = query.toLowerCase().trim();
  const maps = readAllMaps(ws);
  const scored = maps
    .map((m) => {
      let score = 0;
      if (m.meta.tags.some((t) => t.toLowerCase() === q)) score += 5;
      if (m.meta.path.toLowerCase().includes(q)) score += 3;
      if (m.meta.dependsOn.some((d) => d.toLowerCase().includes(q))) score += 2;
      if (m.body.toLowerCase().includes(q)) score += 1;
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map(({ m }) => ({
    path: m.meta.path,
    tags: m.meta.tags,
    dependsOn: m.meta.dependsOn,
    updatedAt: m.meta.updatedAt,
    updatedBy: m.meta.updatedBy,
    stale: m.meta.stale,
  }));
}

export function savePlan(ws: Workspace, name: string, content: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const base = /^\d{4}-\d{2}-\d{2}-/.test(name) ? slugify(name.slice(11)) : slugify(name);
  const rel = `plans/${date}-${base}.md`;
  ws.store.write(ws.branch, rel, content.replace(/\r\n/g, "\n"), `plan: ${date}-${base}`);
  return rel;
}

export function listPlans(ws: Workspace): string[] {
  return ws.store.list(ws.branch, "plans/").sort();
}

export function readPlan(ws: Workspace, rel: string): string | null {
  const path = rel.startsWith("plans/") ? rel : `plans/${rel}`;
  return ws.store.read(ws.branch, path);
}

export function fileExists(ws: Workspace, path: string): boolean {
  return existsSync(ws.source.absolutePath(path));
}
