import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { git, gitRaw, GitError } from "./git.js";
import { canonicalPath, toPosix } from "./paths.js";

/**
 * Git subcommands the kit may run against a source repository. Source repos are
 * read-only for the kit: anything outside this list (commit, push, fetch, config
 * writes…) throws before git is even started.
 */
const READ_ONLY: Record<string, (args: string[]) => boolean> = {
  "rev-parse": () => true,
  // one operand reads a symbolic ref; two operands would set it
  "symbolic-ref": (a) => a.filter((x) => !x.startsWith("-")).length === 1,
  "merge-base": () => true,
  "rev-list": () => true,
  "ls-files": () => true,
  "ls-tree": () => true,
  "show": () => true,
  "cat-file": () => true,
  "for-each-ref": () => true,
  "log": () => true,
  "reflog": (a) => a[0] === "show",
  "remote": (a) => a[0] === "get-url" || a[0] === "-v",
  "config": (a) => a.length === 1 || a[0] === "--get" || a[0] === "--get-regexp" || a[0] === "--get-all",
};

export class ReadOnlyViolation extends Error {
  constructor(args: string[]) {
    super(`codekit refused to run \`git ${args.join(" ")}\` on a source repo: source repos are read-only for the kit.`);
    this.name = "ReadOnlyViolation";
  }
}

export function assertReadOnly(args: string[]): void {
  const [sub = "", ...rest] = args;
  const allowed = READ_ONLY[sub];
  if (!allowed || !allowed(rest)) throw new ReadOnlyViolation(args);
}

/** Read-only view of the developer's source repository. The kit never writes into it through git. */
export class SourceRepo {
  private constructor(readonly root: string) {}

  static open(cwd: string): SourceRepo | null {
    const root = readGit(["rev-parse", "--show-toplevel"], cwd);
    return root ? new SourceRepo(canonicalPath(root)) : null;
  }

  private git(args: string[]): string | null {
    return readGit(args, this.root);
  }

  remoteUrl(): string | null {
    return this.git(["remote", "get-url", "origin"]);
  }

  currentBranch(): string | null {
    return this.git(["symbolic-ref", "--short", "-q", "HEAD"]) || null;
  }

  head(): string | null {
    return this.git(["rev-parse", "HEAD"]);
  }

  /** Commit of a branch, preferring the local ref, then `origin/<branch>`. */
  resolveBranch(branch: string): string | null {
    return (
      this.git(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`]) ??
      this.git(["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}^{commit}`])
    );
  }

  branchExists(branch: string): boolean {
    return this.resolveBranch(branch) !== null;
  }

  isAncestor(commit: string, of: string): boolean {
    return this.git(["merge-base", "--is-ancestor", commit, of]) !== null;
  }

  mergeBase(a: string, b: string): string | null {
    return this.git(["merge-base", a, b]);
  }

  countCommits(range: string): number {
    const n = this.git(["rev-list", "--count", range]);
    return n ? Number(n) : Number.POSITIVE_INFINITY;
  }

  userName(): string {
    return this.git(["config", "user.name"]) || process.env.GIT_AUTHOR_NAME || process.env.USERNAME || process.env.USER || "unknown";
  }

  /** `alias.<name>` -> value, so the push guard can see through aliases. */
  gitAliases(): Record<string, string> {
    const out = this.git(["config", "--get-regexp", "^alias\\."]) ?? "";
    const aliases: Record<string, string> = {};
    for (const line of out.split("\n").filter(Boolean)) {
      const m = /^alias\.(\S+)\s+(.*)$/.exec(line);
      if (m) aliases[m[1]!.toLowerCase()] = m[2]!;
    }
    return aliases;
  }

  hooksPath(): string | null {
    return this.git(["config", "--get", "core.hooksPath"]) || null;
  }

  /** Tracked + untracked-but-not-ignored files, repo-relative posix paths. */
  listFiles(): string[] {
    const out = this.git(["ls-files", "--cached", "--others", "--exclude-standard"]);
    return out ? [...new Set(out.split("\n").filter(Boolean).map(toPosix))] : [];
  }

  /** Files of a committed tree. */
  listFilesAt(ref: string): string[] {
    const out = this.git(["ls-tree", "-r", "--name-only", ref]);
    return out ? out.split("\n").filter(Boolean).map(toPosix) : [];
  }

  /** Content of a file at a ref (used to judge map conflicts after a merge). */
  showFile(ref: string, path: string): string | null {
    assertReadOnly(["show"]);
    try {
      return gitRaw(["show", `${ref}:${path}`], this.root);
    } catch {
      return null;
    }
  }

  /** Contents of many files at a ref in one `git cat-file --batch` process. */
  catFiles(ref: string, paths: string[]): Map<string, string> {
    assertReadOnly(["cat-file"]);
    const result = new Map<string, string>();
    if (paths.length === 0) return result;
    const res = spawnSync("git", ["cat-file", "--batch"], {
      cwd: this.root,
      input: paths.map((p) => `${ref}:${p}`).join("\n") + "\n",
      maxBuffer: 1024 * 1024 * 1024,
    });
    if (res.status !== 0 || !res.stdout) return result;
    const buf = res.stdout as Buffer;
    let pos = 0;
    for (const path of paths) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl === -1) break;
      const header = buf.subarray(pos, nl).toString("utf8");
      pos = nl + 1;
      const m = /^\S+ (\w+) (\d+)$/.exec(header);
      if (!m) continue; // "<spec> missing"
      const size = Number(m[2]);
      if (m[1] === "blob") result.set(path, buf.subarray(pos, pos + size).toString("utf8"));
      pos += size + 1;
    }
    return result;
  }

  /** Repo-relative posix path, or null when the path lies outside the repo. */
  relativePath(path: string): string | null {
    const abs = isAbsolute(path) ? path : resolve(this.root, path);
    const inside = (r: string) => !!r && !r.startsWith("..") && !isAbsolute(r);
    let rel = relative(this.root, abs);
    // Same file through a symlink or a Windows short name: compare canonical paths.
    if (!inside(rel)) rel = relative(this.root, canonicalPath(abs));
    return inside(rel) ? toPosix(rel) : null;
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
    const reflog = this.git(["reflog", "show", "--format=%gs", "HEAD"]) ?? "";
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
    const dir = this.git(["rev-parse", "--git-common-dir"]);
    if (!dir) throw new Error(`Cannot locate .git for ${this.root}`);
    return resolve(this.root, dir);
  }
}

function readGit(args: string[], cwd: string): string | null {
  assertReadOnly(args);
  try {
    return git(args, cwd);
  } catch (err) {
    if (err instanceof GitError) return null;
    throw err;
  }
}
