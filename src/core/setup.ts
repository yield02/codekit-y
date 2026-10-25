import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { addRepoToStoreConfig, loadUserConfig, parseStoreConfig, repoNameFromRemote, repoNameInStore, saveUserConfig, upsertRepo, type BackendKind, type ProjectEntry, type RepoEntry } from "./config.js";
import { normalizeRemote } from "./git.js";
import { repoFoldersUnder } from "./parent.js";
import { artifactPatterns, type ArtifactRules } from "./artifacts.js";
import { AGENT_ENV_MARKERS } from "./guard.js";
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

/**
 * Scaffold a project's knowledge store: the shared config area from templates.
 * Map branches are created per repo on first use (`ensureBranch`).
 */
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
  return store;
}

export interface InitOptions {
  cwd: string;
  project: string;
  backend: BackendKind;
  url?: string;
  path?: string;
  /** Key of this repo inside the project (default: derived from the remote, e.g. `abc-core`). */
  repoName?: string;
  /** Name to use when the store does not know this repo yet and no repoName is given (e.g. its folder name). */
  defaultName?: string;
}

/**
 * Register a source repo with its project's store (per developer, once per repo).
 * Every repo of a project (core, product, …) is registered with the same --project and
 * the same store: their maps are kept side by side in that one store.
 */
export function initRepo(opts: InitOptions): { entry: ProjectEntry; repo: RepoEntry; source: SourceRepo; guard: GuardInstallResult; artifactGuard: GuardInstallResult } {
  const source = SourceRepo.open(opts.cwd);
  if (!source) throw new Error(`Not a git repository: ${opts.cwd}`);
  const remote = source.remoteUrl();
  if (!remote) throw new Error("The source repo has no 'origin' remote; codekit identifies projects by remote.");

  const config = loadUserConfig();
  const existing = config.projects.find((p) => p.name === opts.project);
  const store = { backend: opts.backend, ...(opts.url ? { url: opts.url } : {}), ...(opts.path ? { path: opts.path } : {}) };
  if (existing && (existing.store.backend !== store.backend || (existing.store.url ?? existing.store.path) !== (store.url ?? store.path))) {
    throw new Error(`Project ${opts.project} already uses store ${existing.store.url ?? existing.store.path} (${existing.store.backend}); all repos of a project share one store.`);
  }
  const storage: StorageAdapter = store.backend === "git" ? new GitStorage(projectStoreDir(opts.project), store.url) : new FolderStorage(store.path!, "codekit");
  storage.refresh();

  // The store decides repo names, so every developer's maps land in the same place.
  const storeYaml = storage.readConfig("codekit.yaml") ?? "";
  const known = repoNameInStore(parseStoreConfig(storeYaml, opts.project), remote);
  if (known && opts.repoName && opts.repoName !== known) {
    throw new Error(`The team's store already names this repo "${known}"; drop --repo-name or use "${known}".`);
  }
  const name = known ?? opts.repoName ?? opts.defaultName ?? repoNameFromRemote(remote);
  const taken = parseStoreConfig(storeYaml, opts.project).repos[name]?.remote;
  if (!known && taken && normalizeRemote(taken) !== normalizeRemote(remote)) {
    throw new Error(`Repo name "${name}" is already used in the store by ${taken}; pass a different --repo-name.`);
  }
  const repo: RepoEntry = { name, remote: normalizeRemote(remote), localPath: source.root };
  const next = upsertRepo(config, opts.project, store, repo);
  saveUserConfig(next);
  const entry = next.projects.find((p) => p.name === opts.project)!;
  if (!known) storage.writeConfig("codekit.yaml", addRepoToStoreConfig(storeYaml, name, remote), `config: add repo ${name}`);

  addLocalExcludes(source);
  const guard = installPrePushGuard(source);
  const g = parseStoreConfig(storeYaml, opts.project).guard;
  const artifactGuard = installPreCommitGuard(source, { extra: g.artifactPaths, allow: g.allowPaths });
  return { entry, repo, source, guard, artifactGuard };
}

/** `Transactions` -> `transactions`, `Admin Portal` -> `admin-portal` */
export function repoNameFromFolder(folder: string): string {
  return basename(folder).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

/** Register every git repo under a parent folder (Transfer/{Transactions,Core,Abs,Admin}) with one project. */
export function initAll(opts: Omit<InitOptions, "cwd" | "repoName" | "defaultName"> & { parent: string }) {
  const folders = repoFoldersUnder(opts.parent);
  if (folders.length === 0) throw new Error(`No git repos with an origin remote under ${opts.parent}.`);
  return folders.map((dir) => initRepo({ ...opts, cwd: dir, defaultName: repoNameFromFolder(dir) }));
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

export const PRE_COMMIT_MARKER = "codekit-artifact-guard";

/** Glob (same semantics as matchesGlob) -> POSIX ERE for `grep -Ei` in the pre-commit hook. */
export function globToEre(glob: string): string {
  const g = glob.replace(/\\/g, "/").replace(/^\.?\//, "");
  const conv = (pattern: string) => {
    let re = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i]!;
      if (c === "*" && pattern[i + 1] === "*") {
        const slashAfter = pattern[i + 2] === "/";
        re += slashAfter ? "(.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else re += /[.+()|{}[\]^$\\]/.test(c) ? `\\${c}` : c;
    }
    return re;
  };
  if (!g.includes("/")) return `(^|/)${conv(g)}$`;
  return `^${conv(g)}$`;
}

/**
 * Rejects commits made by AI agents that add or change AI files (AGENTS.md, CLAUDE.md, .cursor/,
 * docs/plans/…). Deleting such files is allowed. The developer's own commits are unaffected.
 */
export function preCommitScript(rules: ArtifactRules): string {
  for (const g of [...rules.extra, ...rules.allow]) if (/['\n]/.test(g)) throw new Error(`Invalid guard pattern: ${g}`);
  const block = artifactPatterns(rules).map((p) => globToEre(p.glob)).join("|");
  const allow = rules.allow.map(globToEre).join("|");
  return [
    "#!/bin/sh",
    `# ${PRE_COMMIT_MARKER}: installed by \`codekit init\` (re-run it after changing guard paths in codekit.yaml).`,
    "# AI agents may commit locally but must not add AI files (rules, plans, tool config, memories) to this repo.",
    'marker=""',
    `for v in ${AGENT_ENV_MARKERS.join(" ")}; do`,
    '  eval "val=\\${$v}"',
    '  if [ -n "$val" ]; then marker="$v"; break; fi',
    "done",
    'if [ -n "$marker" ]; then',
    `  bad=$(git diff --cached --name-only --diff-filter=ACMR | grep -Ei '${block}'${allow ? ` | grep -Eiv '${allow}'` : ""})`,
    '  if [ -n "$bad" ]; then',
    '    echo "codekit: commit blocked - an AI agent ($marker is set) is committing AI files:" >&2',
    `    echo "$bad" | sed 's/^/  /' >&2`,
    '    echo "codekit: plans go to plan_save, maps to codemap_write, rules stay in the knowledge store. Unstage them: git restore --staged <file>" >&2',
    "    exit 1",
    "  fi",
    "fi",
    'chained="$(dirname "$0")/pre-commit.codekit-chained"',
    'if [ -x "$chained" ]; then exec "$chained" "$@"; fi',
    "exit 0",
    "",
  ].join("\n");
}

/** Install (or refresh) the pre-commit artifact guard, chaining an existing hook. */
export function installPreCommitGuard(source: SourceRepo, rules: ArtifactRules): GuardInstallResult {
  const hooksPath = source.hooksPath();
  if (hooksPath) return { installed: false, reason: `core.hooksPath is set (${hooksPath}); tracked hooks are left untouched.` };
  const dir = join(source.gitDir(), "hooks");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "pre-commit");
  let chained = false;
  if (existsSync(file) && !readFileSync(file, "utf8").includes(PRE_COMMIT_MARKER)) {
    renameSync(file, join(dir, "pre-commit.codekit-chained"));
    chained = true;
  }
  writeFileSync(file, preCommitScript(rules));
  chmodSync(file, 0o755);
  return { installed: true, path: file, chained: chained || existsSync(join(dir, "pre-commit.codekit-chained")) };
}

export function preCommitGuardInstalled(source: SourceRepo): boolean {
  if (source.hooksPath()) return false;
  const file = join(source.gitDir(), "hooks", "pre-commit");
  return existsSync(file) && readFileSync(file, "utf8").includes(PRE_COMMIT_MARKER);
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
