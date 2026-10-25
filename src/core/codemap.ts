import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isIncluded } from "./glob.js";
import { hashFile } from "./hash.js";
import { lintMapBody, parseMapFile, serializeMapFile, type MapFile } from "./mapfile.js";
import { mapPathFor, normalizeBranch, slugify, sourcePathFromMap, toPosix } from "./paths.js";
import type { StorageAdapter } from "./storage/types.js";
import { openRepo, projectRepos, type Workspace } from "./workspace.js";

/** `remote`: a map of another repo that is not cloned here, so freshness cannot be checked. */
export type EntryStatus = "ok" | "missing" | "stale" | "excluded" | "not-found" | "remote";

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

/** `core:src/api/user.ts` -> { repo: "core", path: "src/api/user.ts" }. Windows drive letters are not repos. */
export function parseRepoRef(input: string): { repo: string; path: string } | null {
  const m = /^([A-Za-z0-9._-]{2,}):(?![\\/]{2})(.+)$/.exec(input.trim());
  return m ? { repo: m[1]!, path: toPosix(m[2]!) } : null;
}

export function lookup(ws: Workspace, paths: string[]): LookupEntry[] {
  return paths.map((input) => {
    const ref = parseRepoRef(input);
    if (ref && ref.repo !== ws.repo.name) return lookupOtherRepo(ws, ref.repo, ref.path);
    const path = ref ? ref.path : ws.source.relativePath(input) ?? toPosix(input);
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

/** Map of a file in another repo of the project (cross-service lookup). */
function lookupOtherRepo(ws: Workspace, repo: string, path: string): LookupEntry {
  const label = `${repo}:${path}`;
  const view = openRepo(ws, repo);
  if (!view) return { path: label, status: "not-found", reason: `no repo "${repo}" in project ${ws.project.name} (known: ${projectRepos(ws).join(", ")})` };
  const text = view.store.read(view.branch, mapPathFor(path));
  const map = text ? parseMapFile(text) ?? undefined : undefined;
  if (!view.source) {
    return map
      ? { path: label, status: "remote", reason: `map of ${repo}@${view.branch}; ${repo} is not cloned here, freshness unknown`, map }
      : { path: label, status: "missing", reason: `no map yet in ${repo}@${view.branch}` };
  }
  const currentHash = hashFile(view.source.absolutePath(path));
  if (currentHash === null) return map ? { path: label, status: "not-found", map } : { path: label, status: "not-found" };
  if (!map) return { path: label, status: "missing", reason: `no map yet in ${repo}@${view.branch}` };
  if (map.meta.stale || map.meta.sourceHash !== currentHash) return { path: label, status: "stale", reason: `${repo}'s source changed since the map was written`, map };
  return { path: label, status: "ok", map };
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
      // `other-repo:path` references to other services are kept as written
      dependsOn: (input.dependsOn ?? []).map((d) => (parseRepoRef(d) ? toPosix(d) : ws.source.relativePath(d) ?? toPosix(d))),
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
  return readMapsOf(ws.store, ws.branch);
}

export function readMapsOf(store: StorageAdapter, branch: string): MapFile[] {
  if (!store.hasBranch(branch)) return [];
  return store
    .list(branch, "modules/")
    .filter((p) => sourcePathFromMap(p) !== null)
    .map((p) => store.read(branch, p))
    .map((t) => (t ? parseMapFile(t) : null))
    .filter((m): m is MapFile => m !== null);
}

// ---------------------------------------------------------------- service summaries

/** One summary per repo/service, at the root of its map branch. */
export const SERVICE_FILE = "service.md";

export const SERVICE_SECTIONS = ["## Purpose", "## Exposes", "## Consumes", "## Data owned", "## Notes"] as const;

export function writeService(ws: Workspace, body: string): { warnings: string[] } {
  const content = `<!-- service: ${ws.repo.name} · updated ${new Date().toISOString().slice(0, 16)}Z by ${ws.actor} -->\n${body.replace(/\r\n/g, "\n").trim()}\n`;
  ws.store.write(ws.branch, SERVICE_FILE, content, `service: ${ws.repo.name}`);
  const warnings = SERVICE_SECTIONS.filter((sct) => !body.includes(sct)).map((sct) => `Missing section "${sct}".`);
  return { warnings };
}

export interface ServiceSummary {
  repo: string;
  branch: string;
  current: boolean;
  body: string | null;
  description?: string;
}

/** Summaries of every service of the project (same branch name when it exists there, else its default branch). */
export function readServices(ws: Workspace): ServiceSummary[] {
  return projectRepos(ws).map((repo) => {
    const view = repo === ws.repo.name ? { store: ws.store, branch: ws.branch, config: ws.config } : openRepo(ws, repo);
    const body = view && view.store.hasBranch(view.branch) ? view.store.read(view.branch, SERVICE_FILE) : null;
    const description = view?.config.repos[repo]?.description;
    return {
      repo,
      branch: view?.branch ?? "-",
      current: repo === ws.repo.name,
      body: body?.replace(/^<!--.*?-->\n/, "") ?? null,
      ...(description ? { description } : {}),
    };
  });
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

/**
 * Search maps by tag/path/dependency/text. `project` scope searches every repo of the
 * project (paths are returned as `repo:path`).
 */
export function search(ws: Workspace, query: string, limit = 20, scope: "repo" | "project" = "repo"): IndexEntry[] {
  const q = query.toLowerCase().trim();
  const maps: MapFile[] = scope === "repo"
    ? readAllMaps(ws)
    : projectRepos(ws).flatMap((repo) => {
        const view = repo === ws.repo.name ? { store: ws.store, branch: ws.branch } : openRepo(ws, repo);
        if (!view) return [];
        return readMapsOf(view.store, view.branch).map((m) => ({ ...m, meta: { ...m.meta, path: `${repo}:${m.meta.path}` } }));
      });
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
