import { isAbsolute, relative, resolve } from "node:path";
import { git, showFile, tryGit } from "./git.js";
import { toPosix } from "./paths.js";

/** Read-only view of the developer's source repository. The kit never writes into it. */
export class SourceRepo {
  private constructor(readonly root: string) {}

  static open(cwd: string): SourceRepo | null {
    const root = tryGit(["rev-parse", "--show-toplevel"], cwd);
    return root ? new SourceRepo(resolve(root)) : null;
  }

  remoteUrl(): string | null {
    return tryGit(["remote", "get-url", "origin"], this.root);
  }

  currentBranch(): string | null {
    const b = tryGit(["symbolic-ref", "--short", "-q", "HEAD"], this.root);
    return b || null;
  }

  head(): string | null {
    return tryGit(["rev-parse", "HEAD"], this.root);
  }

  /** Commit of a branch, preferring the local ref, then `origin/<branch>`. */
  resolveBranch(branch: string): string | null {
    return (
      tryGit(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], this.root) ??
      tryGit(["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}^{commit}`], this.root)
    );
  }

  branchExists(branch: string): boolean {
    return this.resolveBranch(branch) !== null;
  }

  isAncestor(commit: string, of: string): boolean {
    return tryGit(["merge-base", "--is-ancestor", commit, of], this.root) !== null;
  }

  mergeBase(a: string, b: string): string | null {
    return tryGit(["merge-base", a, b], this.root);
  }

  countCommits(range: string): number {
    const n = tryGit(["rev-list", "--count", range], this.root);
    return n ? Number(n) : Number.POSITIVE_INFINITY;
  }

  userName(): string {
    return tryGit(["config", "user.name"], this.root) || process.env.GIT_AUTHOR_NAME || process.env.USERNAME || process.env.USER || "unknown";
  }

  /** Tracked + untracked-but-not-ignored files, repo-relative posix paths. */
  listFiles(): string[] {
    const out = tryGit(["ls-files", "--cached", "--others", "--exclude-standard"], this.root);
    return out ? [...new Set(out.split("\n").filter(Boolean).map(toPosix))] : [];
  }

  /** Content of a file at a ref (used to judge map conflicts after a merge). */
  showFile(ref: string, path: string): string | null {
    return showFile(this.root, `${ref}:${path}`);
  }

  /** Repo-relative posix path, or null when the path lies outside the repo. */
  relativePath(path: string): string | null {
    const abs = isAbsolute(path) ? path : resolve(this.root, path);
    const rel = relative(this.root, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return toPosix(rel);
  }

  absolutePath(rel: string): string {
    return resolve(this.root, rel);
  }

  /**
   * Parent of a newly created branch, from the HEAD reflog entry
   * `checkout: moving from <parent> to <branch>` (the oldest one wins).
   * Falls back to the candidate whose merge-base is closest to the branch tip.
   */
  detectParent(branch: string, candidates: string[]): string | null {
    const others = candidates.filter((c) => c !== branch);
    const reflog = tryGit(["reflog", "show", "--format=%gs", "HEAD"], this.root) ?? "";
    let fromReflog: string | null = null;
    for (const line of reflog.split("\n")) {
      const m = /^checkout: moving from (.+) to (.+)$/.exec(line.trim());
      if (m && m[2] === branch && m[1] !== branch) fromReflog = m[1]!;
    }
    if (fromReflog && others.includes(fromReflog)) return fromReflog;

    const tip = this.resolveBranch(branch);
    if (!tip) return others[0] ?? null;
    let best: { name: string; distance: number } | null = null;
    for (const c of others) {
      const ref = this.resolveBranch(c);
      if (!ref) continue;
      const base = this.mergeBase(tip, ref);
      if (!base) continue;
      const distance = this.countCommits(`${base}..${tip}`);
      if (!best || distance < best.distance) best = { name: c, distance };
    }
    return best?.name ?? fromReflog ?? others[0] ?? null;
  }

  gitDir(): string {
    return resolve(this.root, git(["rev-parse", "--git-common-dir"], this.root));
  }
}
