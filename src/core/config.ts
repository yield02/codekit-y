import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
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

export interface ProjectEntry {
  name: string;
  /** Normalized source remotes that belong to this project. */
  remotes: string[];
  store: StoreLocation;
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
  /** Push guard. It cannot be disabled; only individual MCP tools can be allow-listed. */
  guard: { allowMcpTools: string[] };
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
  guard: { allowMcpTools: [] },
};

export function loadUserConfig(): UserConfig {
  const path = userConfigPath();
  if (!existsSync(path)) return { projects: [] };
  const raw = parse(readFileSync(path, "utf8")) as Partial<UserConfig> | null;
  return { projects: Array.isArray(raw?.projects) ? raw!.projects : [] };
}

export function saveUserConfig(config: UserConfig): void {
  const path = userConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(config));
}

export function findProjectByRemote(config: UserConfig, remoteUrl: string): ProjectEntry | undefined {
  const remote = normalizeRemote(remoteUrl);
  return config.projects.find((p) => p.remotes.some((r) => normalizeRemote(r) === remote));
}

export function upsertProject(config: UserConfig, entry: ProjectEntry): UserConfig {
  const others = config.projects.filter((p) => p.name !== entry.name);
  return { projects: [...others, { ...entry, remotes: [...new Set(entry.remotes.map(normalizeRemote))] }] };
}

export function parseStoreConfig(content: string | null, project: string): StoreConfig {
  const raw = (content ? parse(content) : {}) as Partial<StoreConfig> | null;
  return {
    ...DEFAULT_STORE_CONFIG,
    ...(raw ?? {}),
    github: { ...DEFAULT_STORE_CONFIG.github, ...(raw?.github ?? {}) },
    guard: { allowMcpTools: Array.isArray(raw?.guard?.allowMcpTools) ? raw!.guard!.allowMcpTools : [] },
    project: raw?.project ?? project,
  };
}
