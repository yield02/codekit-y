import { join } from "node:path";
import { findProjectByRemote, loadUserConfig, parseStoreConfig, type ProjectEntry, type RepoEntry, type StoreConfig } from "./config.js";
import { projectCacheDir, projectStoreDir } from "./paths.js";
import { SourceRepo } from "./source.js";
import { FolderStorage } from "./storage/folder.js";
import { GitStorage } from "./storage/git.js";
import type { StorageAdapter } from "./storage/types.js";

/** Everything needed to serve one source repo: its project's store, settings and current branch. */
export interface Workspace {
  source: SourceRepo;
  project: ProjectEntry;
  /** This repo within the project (`core`, `product`…). */
  repo: RepoEntry;
  /** The project's store, scoped to this repo's branches (config area is shared). */
  store: StorageAdapter;
  /** Project settings with this repo's overrides applied. */
  config: StoreConfig;
  branch: string;
  actor: string;
  cacheDir: string;
}

/** The project's single store; scoped to `repo` when given. */
export function createStorage(project: ProjectEntry, actor: string, repo?: string): StorageAdapter {
  if (project.store.backend === "git") return new GitStorage(projectStoreDir(project.name), project.store.url, repo);
  if (!project.store.path) throw new Error(`Project ${project.name}: folder backend needs store.path`);
  return new FolderStorage(project.store.path, actor, repo);
}

/** Light check (no store access): is `dir` inside a source repo registered with codekit? */
export function findRegisteredSource(dir: string): { source: SourceRepo; project: ProjectEntry; repo: RepoEntry } | null {
  const source = SourceRepo.open(dir);
  const remote = source?.remoteUrl();
  if (!source || !remote) return null;
  const found = findProjectByRemote(loadUserConfig(), remote);
  return found ? { source, ...found } : null;
}

export type WorkspaceResolution =
  | { ok: true; workspace: Workspace }
  | { ok: false; reason: "not-a-git-repo" | "no-remote" | "not-registered"; detail: string };

/**
 * Resolve the workspace for a directory. Repos that are not registered in
 * ~/.codekit/config.yaml resolve to `not-registered`, and every hook/tool is a no-op for them.
 */
export function resolveWorkspace(cwd: string, tool = "codekit"): WorkspaceResolution {
  const source = SourceRepo.open(cwd);
  if (!source) return { ok: false, reason: "not-a-git-repo", detail: cwd };
  const remote = source.remoteUrl();
  if (!remote) return { ok: false, reason: "no-remote", detail: source.root };
  const found = findProjectByRemote(loadUserConfig(), remote);
  if (!found) return { ok: false, reason: "not-registered", detail: remote };
  const { project, repo } = found;

  const actor = `${source.userName()} (${tool})`;
  const store = createStorage(project, actor, repo.name);
  const config = parseStoreConfig(store.readConfig("codekit.yaml"), project.name, repo.name);
  const branch = source.currentBranch() ?? config.defaultBranch;
  return {
    ok: true,
    workspace: { source, project, repo, store, config, branch, actor, cacheDir: join(projectCacheDir(project.name), repo.name) },
  };
}

/** Another repo of the same project, for cross-service lookups. */
export interface RepoView {
  name: string;
  store: StorageAdapter;
  config: StoreConfig;
  /** That repo's clone on this machine, when registered. */
  source: SourceRepo | null;
  /** Branch whose map is read: same name as ours when it exists there, else its default branch. */
  branch: string;
}

export function openRepo(ws: Workspace, name: string): RepoView | null {
  const known = new Set([...ws.store.listRepos(), ...ws.project.repos.map((r) => r.name)]);
  if (!known.has(name)) return null;
  const store = ws.store.forRepo(name);
  const config = parseStoreConfig(ws.store.readConfig("codekit.yaml"), ws.project.name, name);
  const entry = ws.project.repos.find((r) => r.name === name);
  const source = entry?.localPath ? SourceRepo.open(entry.localPath) : null;
  const branch = store.hasBranch(ws.branch) ? ws.branch : config.defaultBranch;
  return { name, store, config, source, branch };
}

/** All repos of the project: registered locally and/or present in the store. */
export function projectRepos(ws: Workspace): string[] {
  return [...new Set([...ws.project.repos.map((r) => r.name), ...ws.store.listRepos()])].sort();
}
