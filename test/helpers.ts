import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BackendKind } from "../src/core/config.js";
import { createProjectStore, initRepo } from "../src/core/setup.js";
import { resolveWorkspace, type Workspace } from "../src/core/workspace.js";

export const IDENTITY = {
  GIT_AUTHOR_NAME: "Test Dev",
  GIT_AUTHOR_EMAIL: "dev@example.com",
  GIT_COMMITTER_NAME: "Test Dev",
  GIT_COMMITTER_EMAIL: "dev@example.com",
};

export function tempDir(prefix = "codekit-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENTITY } }).trim();
}

export function writeSource(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

export interface Fixture {
  root: string;
  home: string;
  /** Developer clone of the source repo */
  source: string;
  /** Bare "GitHub" remote of the source repo */
  sourceRemote: string;
  /** Bare remote of the knowledge store (git backend) or shared folder (folder backend) */
  storeLocation: string;
  backend: BackendKind;
  ws(): Workspace;
  cleanup(): void;
}

/** Source repo with an origin remote, a registered project and a fresh knowledge store. */
export function createFixture(backend: BackendKind): Fixture {
  const root = tempDir();
  const home = join(root, "home");
  process.env.CODEKIT_HOME = home;
  Object.assign(process.env, IDENTITY);

  const sourceRemote = join(root, "source-remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", sourceRemote]);
  const source = join(root, "source");
  execFileSync("git", ["clone", "-q", sourceRemote, source]);
  sh(source, "config", "core.autocrlf", "false");
  sh(source, "checkout", "-q", "-b", "main");
  writeSource(source, "src/auth/login.ts", "export function login() { return true; }\n");
  writeSource(source, "src/auth/token.ts", "export const TOKEN_TTL = 60;\n");
  writeSource(source, "src/db/user.repo.ts", "export function findUser() {}\n");
  sh(source, "add", "-A");
  sh(source, "commit", "-q", "-m", "init");
  sh(source, "push", "-q", "-u", "origin", "main");

  let storeLocation: string;
  if (backend === "git") {
    storeLocation = join(root, "store-remote.git");
    execFileSync("git", ["init", "-q", "--bare", storeLocation]);
  } else {
    storeLocation = join(root, "nas", "shop");
  }
  createProjectStore({
    project: "shop",
    backend,
    ...(backend === "git" ? { url: storeLocation } : { path: storeLocation }),
    actor: "Test Dev (test)",
  });
  initRepo({ cwd: source, project: "shop", backend, ...(backend === "git" ? { url: storeLocation } : { path: storeLocation }) });

  return {
    root,
    home,
    source,
    sourceRemote,
    storeLocation,
    backend,
    ws() {
      const res = resolveWorkspace(source, "test");
      if (!res.ok) throw new Error(`workspace not resolved: ${res.reason}`);
      return res.workspace;
    },
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows may hold handles briefly; temp dirs are fine to leave.
      }
    },
  };
}

/**
 * Yield to the event loop. Fixtures run hundreds of synchronous git commands; on slow CI
 * runners a long blocking stretch makes vitest's worker RPC time out (60 s).
 */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export const MAP_BODY = "## Purpose\nLogin.\n## Public API\n- login()\n## Main flow\n1. check\n## Caveats\nnone";
