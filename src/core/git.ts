import { spawnSync } from "node:child_process";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly status: number | null,
  ) {
    super(`git ${args.join(" ")} failed (${status}): ${stderr.trim()}`);
    this.name = "GitError";
  }
}

let identityEnv: Record<string, string> | undefined;

/**
 * Commits in the store are authored by the developer's own git identity. When
 * none is configured, fall back to a neutral one so the kit still works.
 */
function fallbackIdentity(): Record<string, string> {
  if (identityEnv) return identityEnv;
  identityEnv = {};
  const name = spawnSync("git", ["config", "user.name"], { encoding: "utf8" }).stdout.trim();
  const email = spawnSync("git", ["config", "user.email"], { encoding: "utf8" }).stdout.trim();
  if (!name && !process.env.GIT_AUTHOR_NAME) {
    identityEnv.GIT_AUTHOR_NAME = identityEnv.GIT_COMMITTER_NAME = "codekit";
  }
  if (!email && !process.env.GIT_AUTHOR_EMAIL) {
    identityEnv.GIT_AUTHOR_EMAIL = identityEnv.GIT_COMMITTER_EMAIL = "codekit@localhost";
  }
  return identityEnv;
}

export function git(args: string[], cwd: string, input?: string): string {
  return gitRaw(args, cwd, input).replace(/\r?\n$/, "");
}

/** Untrimmed stdout, for file contents (`git show`) where the final newline matters for hashing. */
export function gitRaw(args: string[], cwd: string, input?: string): string {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...fallbackIdentity(), GIT_TERMINAL_PROMPT: "0" },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new GitError(args, res.stderr ?? "", res.status);
  return res.stdout ?? "";
}

export function showFile(cwd: string, spec: string): string | null {
  try {
    return gitRaw(["show", spec], cwd);
  } catch {
    return null;
  }
}

export function tryGit(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** `git@github.com:Acme/Shop.git`, `https://user@github.com/acme/shop` -> `github.com/acme/shop` */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  u = u.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
  u = u.replace(/\/+$/, "").replace(/\.git$/i, "");
  return u.toLowerCase();
}
