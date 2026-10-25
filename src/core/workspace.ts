import { findProjectByRemote, loadUserConfig, parseStoreConfig, type ProjectEntry, type StoreConfig } from "./config.js";
import { projectCacheDir, projectStoreDir } from "./paths.js";
import { SourceRepo } from "./source.js";
import { FolderStorage } from "./storage/folder.js";
import { GitStorage } from "./storage/git.js";
import type { StorageAdapter } from "./storage/types.js";

/** Everything needed to serve one source repo: its store, settings and current branch. */
export interface Workspace {
  source: SourceRepo;
  project: ProjectEntry;
  store: StorageAdapter;
  config: StoreConfig;
  branch: string;
  actor: string;
  cacheDir: string;
}

export function createStorage(project: ProjectEntry, actor: string): StorageAdapter {
  if (project.store.backend === "git") return new GitStorage(projectStoreDir(project.name), project.store.url);
  if (!project.store.path) throw new Error(`Project ${project.name}: folder backend needs store.path`);
  return new FolderStorage(project.store.path, actor);
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
  const project = findProjectByRemote(loadUserConfig(), remote);
  if (!project) return { ok: false, reason: "not-registered", detail: remote };

  const user = source.userName();
  const actor = `${user} (${tool})`;
  const store = createStorage(project, actor);
  const config = parseStoreConfig(store.readConfig("codekit.yaml"), project.name);
  const branch = source.currentBranch() ?? config.defaultBranch;
  return {
    ok: true,
    workspace: { source, project, store, config, branch, actor, cacheDir: projectCacheDir(project.name) },
  };
}
