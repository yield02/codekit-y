import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadUserConfig, saveUserConfig, upsertProject, type BackendKind, type ProjectEntry } from "./config.js";
import { normalizeRemote } from "./git.js";
import { AGENT_ENV_MARKERS } from "./guard.js";
import { writeLineage } from "./lineage.js";
import { packageRoot, projectStoreDir, toPosix } from "./paths.js";
import { SourceRepo } from "./source.js";
import { FolderStorage } from "./storage/folder.js";
import { GitStorage } from "./storage/git.js";
import type { StorageAdapter } from "./storage/types.js";

/** Local-only ignore entries for tool caches; written to .git/info/exclude, never .gitignore. */
export const LOCAL_EXCLUDES = [".serena/", ".ua/", ".understand-anything/"];

export function templateFiles(project: string, defaultBranch: string): Map<string, string> {
  const root = join(packageRoot(), "templates", "store", "config");
  const files = new Map<string, string>();
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else {
        const content = readFileSync(join(root, childRel), "utf8")
          .replace(/\{\{project\}\}/g, project)
          .replace(/\{\{defaultBranch\}\}/g, defaultBranch);
        files.set(toPosix(childRel), content);
      }
    }
  };
  walk("");
  return files;
}

export interface CreateStoreOptions {
  project: string;
  backend: BackendKind;
  url?: string;
  path?: string;
  defaultBranch?: string;
  actor: string;
}

/** Scaffold a new knowledge store: config area from templates + a root map for the default branch. */
export function createProjectStore(opts: CreateStoreOptions): StorageAdapter {
  const defaultBranch = opts.defaultBranch ?? "main";
  const files = templateFiles(opts.project, defaultBranch);
  let store: StorageAdapter;
  if (opts.backend === "git") {
    const git = new GitStorage(projectStoreDir(opts.project), opts.url);
    git.initConfig(files);
    store = git;
  } else {
    if (!opts.path) throw new Error("Folder backend needs --path");
    if (existsSync(join(opts.path, "config", "codekit.yaml"))) throw new Error(`A knowledge store already exists at ${opts.path}`);
    mkdirSync(opts.path, { recursive: true });
    store = new FolderStorage(opts.path, opts.actor);
    for (const [rel, content] of files) {
      if (rel.startsWith(".github/")) continue; // CI workflows only make sense in a git store
      store.writeConfig(rel, content, "initialize knowledge store config");
    }
  }
  store.createBranch(defaultBranch, null);
  const now = new Date().toISOString();
  writeLineage(store, {
    branch: defaultBranch,
    parent: null,
    baseCommit: null,
    createdBy: opts.actor,
    createdAt: now,
    status: "active",
    events: [{ event: "create", at: now, by: opts.actor }],
  }, `lineage: create ${defaultBranch}`);
  return store;
}

export interface InitOptions {
  cwd: string;
  project: string;
  backend: BackendKind;
  url?: string;
  path?: string;
}

/** Register the current source repo with a project's store (per developer, once per project). */
export function initRepo(opts: InitOptions): { entry: ProjectEntry; source: SourceRepo; guard: GuardInstallResult } {
  const source = SourceRepo.open(opts.cwd);
  if (!source) throw new Error(`Not a git repository: ${opts.cwd}`);
  const remote = source.remoteUrl();
  if (!remote) throw new Error("The source repo has no 'origin' remote; codekit identifies projects by remote.");

  const config = loadUserConfig();
  const existing = config.projects.find((p) => p.name === opts.project);
  const entry: ProjectEntry = {
    name: opts.project,
    remotes: [...new Set([...(existing?.remotes ?? []), normalizeRemote(remote)])],
    store: { backend: opts.backend, ...(opts.url ? { url: opts.url } : {}), ...(opts.path ? { path: opts.path } : {}) },
  };
  saveUserConfig(upsertProject(config, entry));

  if (entry.store.backend === "git") new GitStorage(projectStoreDir(entry.name), entry.store.url).refresh();
  else new FolderStorage(entry.store.path!, "codekit").refresh();

  addLocalExcludes(source);
  const guard = installPrePushGuard(source);
  return { entry, source, guard };
}

export const PRE_PUSH_MARKER = "codekit-push-guard";

/** POSIX sh (git runs hooks through sh on Windows too). LF line endings matter. */
export function prePushScript(): string {
  return [
    "#!/bin/sh",
    `# ${PRE_PUSH_MARKER}: installed by \`codekit init\`.`,
    "# AI agents may commit locally in this repository but must never push it.",
    "# Pushes from a normal developer terminal are unaffected.",
    `for v in ${AGENT_ENV_MARKERS.join(" ")}; do`,
    '  eval "val=\\${$v}"',
    '  if [ -n "$val" ]; then',
    '    echo "codekit: push blocked - this process runs inside an AI agent ($v is set)." >&2',
    '    echo "codekit: AI agents have read + local-commit access only. Review the commits and push from your own terminal." >&2',
    "    exit 1",
    "  fi",
    "done",
    'chained="$(dirname "$0")/pre-push.codekit-chained"',
    'if [ -x "$chained" ]; then exec "$chained" "$@"; fi',
    "exit 0",
    "",
  ].join("\n");
}

export interface GuardInstallResult {
  installed: boolean;
  path?: string;
  chained?: boolean;
  reason?: string;
}

/**
 * Install the pre-push guard into `.git/hooks` (local, never committed). Repos that
 * use `core.hooksPath` (husky, lefthook) keep their tracked hooks untouched; the
 * PreToolUse/Cursor guards still apply there.
 */
export function installPrePushGuard(source: SourceRepo): GuardInstallResult {
  const hooksPath = source.hooksPath();
  if (hooksPath) return { installed: false, reason: `core.hooksPath is set (${hooksPath}); tracked hooks are left untouched.` };
  const dir = join(source.gitDir(), "hooks");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "pre-push");
  let chained = false;
  if (existsSync(file)) {
    const current = readFileSync(file, "utf8");
    if (!current.includes(PRE_PUSH_MARKER)) {
      renameSync(file, join(dir, "pre-push.codekit-chained"));
      chained = true;
    }
  }
  writeFileSync(file, prePushScript());
  chmodSync(file, 0o755);
  return { installed: true, path: file, chained: chained || existsSync(join(dir, "pre-push.codekit-chained")) };
}

export function prePushGuardInstalled(source: SourceRepo): boolean {
  if (source.hooksPath()) return false;
  const file = join(source.gitDir(), "hooks", "pre-push");
  return existsSync(file) && readFileSync(file, "utf8").includes(PRE_PUSH_MARKER);
}

export function addLocalExcludes(source: SourceRepo): void {
  const file = join(source.gitDir(), "info", "exclude");
  mkdirSync(join(source.gitDir(), "info"), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const missing = LOCAL_EXCLUDES.filter((e) => !current.split(/\r?\n/).includes(e));
  if (missing.length === 0) return;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  appendFileSync(file, `${prefix}# codekit (local tool caches)\n${missing.join("\n")}\n`);
}
