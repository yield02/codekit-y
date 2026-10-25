import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Kit install root (contains templates/ and plugins/), from both src/core and dist/core. */
export function packageRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

/**
 * Canonical absolute path: symlinks resolved (macOS `/var` -> `/private/var`, a symlinked
 * `/home` on Linux) and Windows 8.3 short names expanded (`RUNNER~1`). Git reports canonical
 * paths, so every comparison against a repo root goes through this. Works for paths that do
 * not exist yet by resolving the nearest existing ancestor.
 */
export function canonicalPath(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    rest.unshift(basename(cur));
    cur = up;
  }
  try {
    return join(realpathSync.native(cur), ...rest);
  } catch {
    return resolve(p);
  }
}

/** Root of all per-user kit state. Overridable for tests and portable installs. */
export function codekitHome(): string {
  return process.env.CODEKIT_HOME || join(homedir(), ".codekit");
}

export function userConfigPath(): string {
  return join(codekitHome(), "config.yaml");
}

export function projectCacheDir(project: string): string {
  return join(codekitHome(), "cache", project);
}

export function projectStoreDir(project: string): string {
  return join(codekitHome(), "stores", project);
}

/**
 * Branch names become directory names and git refs (`map/<name>`), so slashes
 * are flattened: `feature/login-otp` -> `feature__login-otp`. This avoids the
 * `map/feature` vs `map/feature/x` ref conflict.
 */
export function normalizeBranch(branch: string): string {
  return branch.replace(/\//g, "__").replace(/[^A-Za-z0-9._\-]/g, "-");
}

/** Source paths are stored repo-relative with forward slashes. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** `src/auth/login.ts` -> `modules/src/auth/login.ts.md` */
export function mapPathFor(sourcePath: string): string {
  return posix.join("modules", toPosix(sourcePath) + ".md");
}

export function sourcePathFromMap(mapPath: string): string | null {
  const p = toPosix(mapPath);
  if (!p.startsWith("modules/") || !p.endsWith(".md")) return null;
  const rel = p.slice("modules/".length, -".md".length);
  if (rel.endsWith("/_dir") || rel === "_dir") return null;
  return rel;
}

export function lineagePathFor(branch: string): string {
  return `lineage/${normalizeBranch(branch)}.json`;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/đ/g, "d")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "plan"
  );
}
