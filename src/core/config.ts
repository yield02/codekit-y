import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, parseDocument, stringify } from "yaml";
import { normalizeRemote } from "./git.js";
import { userConfigPath } from "./paths.js";

export type BackendKind = "git" | "folder";

export interface StoreLocation {
  backend: BackendKind;
  /** git backend: clone URL (or local path) of the `<project>-codemap` repo */
  url?: string;
  /** folder backend: shared folder, e.g. `\\NAS\codemap\shop` */
  path?: string;
}

/** One source repository of a project (a microservice, a library…). */
export interface RepoEntry {
  /** Short key used in the store and in cross-repo references (`core:src/x.ts`). */
  name: string;
  /** Normalized remote (`github.com/abc/abc-core`). */
  remote: string;
  /** This developer's clone, when known (enables live status of cross-repo maps). */
  localPath?: string;
}

/** A project (e.g. "ABC") owns ONE knowledge store shared by all of its repos. */
export interface ProjectEntry {
  name: string;
  repos: RepoEntry[];
  store: StoreLocation;
}

/** Repo key from a remote: `github.com/abc/abc-core` -> `abc-core`. */
export function repoNameFromRemote(remote: string): string {
  const last = normalizeRemote(remote).replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "repo";
  return last.replace(/[^a-z0-9._-]/gi, "-");
}

export interface UserConfig {
  projects: ProjectEntry[];
}

/** Per-project settings stored in the knowledge store's config area (`codekit.yaml`). */
export interface StoreConfig {
  project: string;
  defaultBranch: string;
  include: string[];
  exclude: string[];
  /** `warn`: report missing maps; `fail`: the Claude Stop hook blocks until maps are written. */
  enforce: "warn" | "fail";
  /** Also require maps for files the AI only read (not just edited). */
  trackReads: boolean;
  mapMaxLines: number;
  /** GitHub API (read-only GET) to detect squash/rebase PR merges the git history cannot show. */
  github: { enabled: boolean; apiUrl?: string; checkIntervalMinutes: number };
  /**
   * Push guard and AI-artifact guard. Neither can be disabled. MCP tools can be allow-listed;
   * `artifactPaths` adds team-specific AI file patterns; `allowPaths` exempts real project paths
   * (e.g. a product `docs/plans/` folder) from the artifact guard.
   */
  guard: { allowMcpTools: string[]; artifactPaths: string[]; allowPaths: string[] };
  /** Per-repo overrides for multi-repo projects (keys are repo names). */
  repos: Record<string, RepoOverride>;
}

export interface RepoOverride {
  /** Normalized remote: the store's record of which repo this name refers to (shared by the team). */
  remote?: string;
  defaultBranch?: string;
  include?: string[];
  /** Added to the project-wide exclude list. */
  exclude?: string[];
  description?: string;
}

export const DEFAULT_STORE_CONFIG: Omit<StoreConfig, "project"> = {
  defaultBranch: "main",
  include: [],
  exclude: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/target/**",
    "**/bin/**",
    "**/obj/**",
    "**/.venv/**",
    "**/__pycache__/**",
    "*.lock",
    "package-lock.json",
    "*.min.js",
    "*.map",
    "*.png",
    "*.jpg",
    "*.svg",
    "*.ico",
    ".serena/**",
    ".ua/**",
  ],
  enforce: "fail",
  trackReads: true,
  mapMaxLines: 60,
  github: { enabled: true, checkIntervalMinutes: 10 },
  guard: { allowMcpTools: [], artifactPaths: [], allowPaths: [] },
  repos: {},
};

export function loadUserConfig(): UserConfig {
  const path = userConfigPath();
  if (!existsSync(path)) return { projects: [] };
  const raw = parse(readFileSync(path, "utf8")) as { projects?: (Partial<ProjectEntry> & { remotes?: string[] })[] } | null;
  const projects = Array.isArray(raw?.projects) ? raw!.projects : [];
  return {
    projects: projects.map((p) => ({
      name: p.name ?? "unnamed",
      store: p.store ?? { backend: "git" },
      // Older configs listed bare remotes; each becomes a repo named after its remote.
      repos: Array.isArray(p.repos) ? p.repos : (p.remotes ?? []).map((r) => ({ name: repoNameFromRemote(r), remote: normalizeRemote(r) })),
    })),
  };
}

export function saveUserConfig(config: UserConfig): void {
  const path = userConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(config));
}

export function findProjectByRemote(config: UserConfig, remoteUrl: string): { project: ProjectEntry; repo: RepoEntry } | undefined {
  const remote = normalizeRemote(remoteUrl);
  for (const project of config.projects) {
    const repo = project.repos.find((r) => normalizeRemote(r.remote) === remote);
    if (repo) return { project, repo };
  }
  return undefined;
}

/** Add or update a repo of a project (creating the project if needed). Repo names are unique per project. */
export function upsertRepo(config: UserConfig, project: string, store: StoreLocation, repo: RepoEntry): UserConfig {
  const existing = config.projects.find((p) => p.name === project);
  const normalized: RepoEntry = { ...repo, remote: normalizeRemote(repo.remote) };
  const clash = existing?.repos.find((r) => r.name === normalized.name && r.remote !== normalized.remote);
  if (clash) throw new Error(`Repo name "${repo.name}" is already used by ${clash.remote} in project ${project}; pass a different --repo-name.`);
  const repos = [...(existing?.repos ?? []).filter((r) => r.remote !== normalized.remote), normalized];
  const others = config.projects.filter((p) => p.name !== project);
  return { projects: [...others, { name: project, store, repos }] };
}

/** The repo name the team's store already uses for `remote`, if any. */
export function repoNameInStore(storeConfig: StoreConfig, remote: string): string | undefined {
  const target = normalizeRemote(remote);
  return Object.entries(storeConfig.repos).find(([, o]) => o.remote && normalizeRemote(o.remote) === target)?.[0];
}

/** Record `name -> remote` in codekit.yaml, keeping comments and layout. */
export function addRepoToStoreConfig(content: string, name: string, remote: string): string {
  const doc = parseDocument(content || "{}");
  doc.setIn(["repos", name, "remote"], normalizeRemote(remote));
  return doc.toString();
}

/** Project-wide settings, with the repo's overrides applied when `repo` is given. */
export function parseStoreConfig(content: string | null, project: string, repo?: string): StoreConfig {
  const raw = (content ? parse(content) : {}) as Partial<StoreConfig> | null;
  const base: StoreConfig = {
    ...DEFAULT_STORE_CONFIG,
    ...(raw ?? {}),
    github: { ...DEFAULT_STORE_CONFIG.github, ...(raw?.github ?? {}) },
    guard: {
      allowMcpTools: stringList(raw?.guard?.allowMcpTools),
      artifactPaths: stringList(raw?.guard?.artifactPaths),
      allowPaths: stringList(raw?.guard?.allowPaths),
    },
    repos: raw?.repos && typeof raw.repos === "object" ? raw.repos : {},
    project: raw?.project ?? project,
  };
  const o = repo ? base.repos[repo] : undefined;
  if (!o) return base;
  return {
    ...base,
    ...(o.defaultBranch ? { defaultBranch: o.defaultBranch } : {}),
    ...(o.include ? { include: o.include } : {}),
    exclude: [...base.exclude, ...(o.exclude ?? [])],
  };
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}
