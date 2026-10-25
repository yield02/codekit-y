import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, GitError, showFile, tryGit } from "../git.js";
import { hashContent } from "../hash.js";
import { normalizeBranch } from "../paths.js";
import type { Snapshot, StorageAdapter } from "./types.js";

const CONFIG_BRANCH = "_config";

/**
 * Separate git repo backend (`<project>-codemap`), ONE per project, shared by all of its repos:
 *   branch `_config`                   shared config area, checked out in `<dir>/repo`
 *   branch `maps/<repo>/<normalized>`  one per source repo + branch, each in its own worktree `<dir>/wt/<repo>/<normalized>`
 *
 * Every write is committed and pushed immediately so teammates (and tools without
 * a Stop hook, like Cursor/Copilot) never hold unpushed maps.
 */
export class GitStorage implements StorageAdapter {
  readonly kind = "git" as const;
  private readonly repoDir: string;
  private readonly wtDir: string;

  constructor(
    private readonly dir: string,
    private readonly url: string | undefined,
    /** Source repo whose branches this instance serves; omit for config-only use. */
    readonly repo?: string,
  ) {
    this.repoDir = join(dir, "repo");
    this.wtDir = join(dir, "wt", repo ?? "_");
  }

  forRepo(repo: string): GitStorage {
    return new GitStorage(this.dir, this.url, repo);
  }

  listRepos(): string[] {
    this.ensureCloned();
    const refs = tryGit(["for-each-ref", "--format=%(refname)", "refs/heads/maps/", "refs/remotes/origin/maps/"], this.repoDir) ?? "";
    return [...new Set(refs.split("\n").filter(Boolean).map((r) => r.replace(/^refs\/(heads|remotes\/origin)\/maps\//, "").split("/")[0]!))].sort();
  }

  /** Clone (or init when there is no remote) and check out the config branch. */
  ensureCloned(): void {
    if (existsSync(join(this.repoDir, ".git"))) return;
    mkdirSync(dirname(this.repoDir), { recursive: true });
    if (this.url) git(["clone", "-q", this.url, this.repoDir], dirname(this.repoDir));
    else git(["init", "-q", this.repoDir], dirname(this.repoDir));
    git(["config", "core.autocrlf", "false"], this.repoDir);
    if (tryGit(["rev-parse", "--verify", "-q", `refs/remotes/origin/${CONFIG_BRANCH}`], this.repoDir)) {
      git(["checkout", "-q", "-B", CONFIG_BRANCH, `origin/${CONFIG_BRANCH}`], this.repoDir);
    }
  }

  /** Create the `_config` branch from template files (used by `codekit project create`). */
  initConfig(files: Map<string, string>): void {
    this.ensureCloned();
    if (this.hasLocalRef(CONFIG_BRANCH)) throw new Error("Store already has a _config branch");
    git(["checkout", "-q", "--orphan", CONFIG_BRANCH], this.repoDir);
    tryGit(["rm", "-rq", "--cached", "."], this.repoDir);
    for (const [rel, content] of files) writeFile(join(this.repoDir, rel), content);
    git(["add", "-A"], this.repoDir);
    git(["commit", "-q", "-m", "chore: initialize knowledge store config"], this.repoDir);
    this.push(this.repoDir, CONFIG_BRANCH);
  }

  refresh(): void {
    this.ensureCloned();
    if (!this.url) return;
    tryGit(["fetch", "-q", "--prune", "origin"], this.repoDir);
    if (this.hasLocalRef(CONFIG_BRANCH)) tryGit(["pull", "-q", "--rebase", "origin", CONFIG_BRANCH], this.repoDir);
  }

  readConfig(rel: string): string | null {
    this.ensureCloned();
    return readText(join(this.repoDir, rel));
  }

  writeConfig(rel: string, content: string, message: string): void {
    this.ensureCloned();
    writeFile(join(this.repoDir, rel), content);
    this.commitAndPush(this.repoDir, CONFIG_BRANCH, [rel], message);
  }

  listBranches(): string[] {
    this.ensureCloned();
    const prefix = `maps/${this.repoKey()}/`;
    const refs = tryGit(["for-each-ref", "--format=%(refname)", `refs/heads/${prefix}`, `refs/remotes/origin/${prefix}`], this.repoDir) ?? "";
    const names = new Set<string>();
    for (const ref of refs.split("\n").filter(Boolean)) {
      names.add(ref.replace(/^refs\/(heads|remotes\/origin)\//, "").slice(prefix.length));
    }
    return [...names].map((n) => this.branchNameOf(n));
  }

  hasBranch(branch: string): boolean {
    this.ensureCloned();
    const ref = this.ref(branch);
    return this.hasLocalRef(ref) || this.hasRemoteRef(ref);
  }

  createBranch(branch: string, parent: string | null): void {
    this.ensureCloned();
    const ref = this.ref(branch);
    const wt = this.worktree(branch, false);
    if (parent) {
      this.worktree(parent); // make sure the parent ref exists locally and is current
      git(["worktree", "add", "-q", "-b", ref, wt, this.ref(parent)], this.repoDir);
    } else {
      git(["worktree", "add", "-q", "--orphan", "-b", ref, wt], this.repoDir);
      writeFile(join(wt, "modules", ".gitkeep"), "");
      git(["add", "-A"], wt);
      git(["commit", "-q", "-m", `chore: create map branch ${branch}`], wt);
    }
    git(["config", "core.autocrlf", "false"], wt);
    this.push(wt, ref);
  }

  archiveBranch(branch: string): void {
    this.ensureCloned();
    const ref = this.ref(branch);
    const wt = this.worktree(branch, false);
    const tip = tryGit(["rev-parse", "--verify", "-q", ref], this.repoDir) ?? `origin/${ref}`;
    const tag = `archive/${ref}`;
    tryGit(["tag", "-f", tag, tip], this.repoDir);
    if (existsSync(wt)) tryGit(["worktree", "remove", "--force", wt], this.repoDir);
    tryGit(["branch", "-D", ref], this.repoDir);
    if (this.url) {
      tryGit(["push", "-q", "origin", `refs/tags/${tag}`, "--force"], this.repoDir);
      tryGit(["push", "-q", "origin", "--delete", ref], this.repoDir);
    }
  }

  read(branch: string, rel: string): string | null {
    this.ensureCloned();
    const wt = join(this.wtDir, normalizeBranch(branch));
    if (existsSync(join(wt, ".git"))) return readText(join(this.worktree(branch), rel));
    // Avoid creating worktrees just to peek (sync reads every branch's lineage).
    const ref = this.ref(branch);
    const at = this.url && this.hasRemoteRef(ref) ? `origin/${ref}` : this.hasLocalRef(ref) ? ref : null;
    return at ? showFile(this.repoDir, `${at}:${rel}`) : null;
  }

  write(branch: string, rel: string, content: string, message: string): void {
    const wt = this.worktree(branch);
    writeFile(join(wt, rel), content);
    this.commitAndPush(wt, this.ref(branch), [rel], message);
  }

  list(branch: string, prefix = ""): string[] {
    if (!this.hasBranch(branch)) return [];
    const out = tryGit(["ls-files"], this.worktree(branch)) ?? "";
    return out.split("\n").filter((p) => p && p.startsWith(prefix) && !p.endsWith(".gitkeep"));
  }

  baseSnapshot(from: string, into: string): Snapshot {
    this.worktree(from);
    this.worktree(into);
    const base = tryGit(["merge-base", this.ref(from), this.ref(into)], this.repoDir);
    const snapshot: Snapshot = new Map();
    if (!base) return snapshot;
    const files = tryGit(["ls-tree", "-r", "--name-only", base], this.repoDir) ?? "";
    for (const rel of files.split("\n").filter(Boolean)) {
      const content = showFile(this.repoDir, `${base}:${rel}`);
      if (content !== null) snapshot.set(rel, hashContent(content));
    }
    return snapshot;
  }

  commitMerge(from: string, into: string, changes: Map<string, string | null>, message: string): void {
    const wt = this.worktree(into);
    const fromRef = this.ref(from);
    this.worktree(from);
    // `-s ours --no-commit` records a real merge (both parents) while we supply the resolved tree.
    const alreadyMerged = tryGit(["merge-base", "--is-ancestor", fromRef, "HEAD"], wt) !== null;
    if (!alreadyMerged) git(["merge", "-q", "--no-ff", "--no-commit", "-s", "ours", fromRef], wt);
    for (const [rel, content] of changes) {
      const abs = join(wt, rel);
      if (content === null) {
        if (existsSync(abs)) unlinkSync(abs);
      } else {
        writeFile(abs, content);
      }
    }
    git(["add", "-A"], wt);
    const hasChanges = !alreadyMerged || tryGit(["diff", "--cached", "--quiet"], wt) === null;
    if (hasChanges) git(["commit", "-q", "-m", message], wt);
    this.push(wt, this.ref(into));
  }

  localPath(branch: string): string | null {
    return this.hasBranch(branch) ? this.worktree(branch) : null;
  }

  private repoKey(): string {
    if (!this.repo) throw new Error("GitStorage: branch operations need a repo (use forRepo)");
    return this.repo;
  }

  private ref(branch: string): string {
    return `maps/${this.repoKey()}/${normalizeBranch(branch)}`;
  }

  private hasLocalRef(ref: string): boolean {
    return tryGit(["rev-parse", "--verify", "-q", `refs/heads/${ref}`], this.repoDir) !== null;
  }

  private hasRemoteRef(ref: string): boolean {
    return tryGit(["rev-parse", "--verify", "-q", `refs/remotes/origin/${ref}`], this.repoDir) !== null;
  }

  /** Worktree for a map branch, created on demand from the local or remote ref. */
  private worktree(branch: string, ensure = true): string {
    const wt = join(this.wtDir, normalizeBranch(branch));
    if (!ensure) return wt;
    const ref = this.ref(branch);
    if (existsSync(join(wt, ".git"))) {
      if (this.url && this.hasRemoteRef(ref)) {
        tryGit(["merge", "-q", "--ff-only", `origin/${ref}`], wt) ?? tryGit(["rebase", "-q", `origin/${ref}`], wt);
      }
      return wt;
    }
    if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
    tryGit(["worktree", "prune"], this.repoDir);
    mkdirSync(this.wtDir, { recursive: true });
    if (this.hasLocalRef(ref)) {
      git(["worktree", "add", "-q", wt, ref], this.repoDir);
    } else if (this.hasRemoteRef(ref)) {
      git(["worktree", "add", "-q", "--track", "-b", ref, wt, `origin/${ref}`], this.repoDir);
    } else {
      throw new Error(`Map branch not found in store: ${branch}`);
    }
    git(["config", "core.autocrlf", "false"], wt);
    return wt;
  }

  private branchNameOf(normalized: string): string {
    const ref = `maps/${this.repoKey()}/${normalized}`;
    const at = this.hasLocalRef(ref) ? ref : `origin/${ref}`;
    const lineage = showFile(this.repoDir, `${at}:lineage/${normalized}.json`);
    if (lineage) {
      try {
        const parsed = JSON.parse(lineage) as { branch?: string };
        if (parsed.branch) return parsed.branch;
      } catch {
        // fall through
      }
    }
    return normalized.replace(/__/g, "/");
  }

  private commitAndPush(cwd: string, ref: string, paths: string[], message: string): void {
    git(["add", "--", ...paths], cwd);
    if (tryGit(["diff", "--cached", "--quiet"], cwd) !== null) return; // nothing changed
    git(["commit", "-q", "-m", message], cwd);
    this.push(cwd, ref);
  }

  private push(cwd: string, ref: string): void {
    if (!this.url) return;
    try {
      git(["push", "-q", "-u", "origin", ref], cwd);
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
      // Someone pushed first: replay our commits on top and retry once.
      git(["pull", "-q", "--rebase", "origin", ref], cwd);
      git(["push", "-q", "-u", "origin", ref], cwd);
    }
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function isEmptyDir(path: string): boolean {
  return !existsSync(path) || readdirSync(path).length === 0;
}
