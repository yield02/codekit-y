import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { hashContent } from "../hash.js";
import { normalizeBranch, toPosix } from "../paths.js";
import type { Snapshot, StorageAdapter } from "./types.js";

const MANIFEST = ".base-manifest.json";
const LOCK_TTL_MS = 60_000;

interface BaseManifest {
  parent: string | null;
  at: string;
  files: Record<string, string>;
}

/**
 * Shared-folder backend (NAS / network drive), ONE per project, shared by all of its repos:
 *   config/                        shared config area
 *   repos/<repo>/branches/<b>/     one directory per source repo + branch
 *   repos/<repo>/archive/          archived branches
 *   history/YYYY-MM.jsonl          append-only write log
 *   locks/                         TTL locks for merges
 */
export class FolderStorage implements StorageAdapter {
  readonly kind = "folder" as const;

  constructor(
    readonly root: string,
    private readonly actor: string,
    /** Source repo whose branches this instance serves; omit for config-only use. */
    readonly repo?: string,
  ) {}

  forRepo(repo: string): FolderStorage {
    return new FolderStorage(this.root, this.actor, repo);
  }

  listRepos(): string[] {
    const dir = join(this.root, "repos");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  }

  private repoDir(): string {
    if (!this.repo) throw new Error("FolderStorage: branch operations need a repo (use forRepo)");
    return join(this.root, "repos", this.repo);
  }

  refresh(): void {
    if (!existsSync(this.root)) throw new Error(`Knowledge store folder not found: ${this.root}`);
  }

  readConfig(rel: string): string | null {
    return readText(join(this.root, "config", rel));
  }

  writeConfig(rel: string, content: string, message: string): void {
    atomicWrite(join(this.root, "config", rel), content);
    this.log({ area: "config", path: rel, action: "write", message });
  }

  listBranches(): string[] {
    const dir = join(this.repoDir(), "branches");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => this.branchNameOf(d.name));
  }

  hasBranch(branch: string): boolean {
    return existsSync(this.branchDir(branch));
  }

  createBranch(branch: string, parent: string | null): void {
    const dir = this.branchDir(branch);
    if (existsSync(dir)) throw new Error(`Branch already exists in store: ${branch}`);
    if (parent) {
      cpSync(this.branchDir(parent), dir, { recursive: true, filter: (src) => !src.endsWith(MANIFEST) });
    } else {
      mkdirSync(join(dir, "modules"), { recursive: true });
    }
    this.writeManifest(branch, parent);
    this.log({ branch, action: "create-branch", parent });
  }

  archiveBranch(branch: string): void {
    const dir = this.branchDir(branch);
    if (!existsSync(dir)) return;
    const target = join(this.repoDir(), "archive", `${normalizeBranch(branch)}-${Date.now()}`);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(dir, target);
    this.log({ branch, action: "archive", target });
  }

  read(branch: string, rel: string): string | null {
    return readText(join(this.branchDir(branch), rel));
  }

  write(branch: string, rel: string, content: string, message: string): void {
    atomicWrite(join(this.branchDir(branch), rel), content);
    this.log({ branch, path: rel, action: "write", hash: hashContent(content), message });
  }

  list(branch: string, prefix = ""): string[] {
    const base = this.branchDir(branch);
    const out: string[] = [];
    walk(base, "", out);
    return out.filter((p) => p !== MANIFEST && p.startsWith(prefix) && !p.endsWith(".gitkeep"));
  }

  baseSnapshot(from: string, into: string): Snapshot {
    // A child's manifest records the parent's state at fork / last sync, which is
    // the common base whichever direction the merge goes.
    const fromManifest = this.readManifest(from);
    const intoManifest = this.readManifest(into);
    const manifest =
      fromManifest?.parent === into ? fromManifest : intoManifest?.parent === from ? intoManifest : null;
    return new Map(Object.entries(manifest?.files ?? {}));
  }

  commitMerge(from: string, into: string, changes: Map<string, string | null>, message: string): void {
    this.withLock(into, () => {
      for (const [rel, content] of changes) {
        const abs = join(this.branchDir(into), rel);
        if (content === null) {
          if (existsSync(abs)) unlinkSync(abs);
        } else {
          atomicWrite(abs, content);
        }
      }
      // After syncing the parent into a child, the parent's current state becomes the new base.
      const intoManifest = this.readManifest(into);
      if (intoManifest?.parent === from) this.writeManifest(into, from, this.snapshotOf(from));
      this.log({ branch: into, action: "merge", from, files: changes.size, message });
    });
  }

  localPath(branch: string): string | null {
    return this.branchDir(branch);
  }

  private branchDir(branch: string): string {
    return join(this.repoDir(), "branches", normalizeBranch(branch));
  }

  private branchNameOf(dirName: string): string {
    const lineage = readText(join(this.repoDir(), "branches", dirName, "lineage", `${dirName}.json`));
    if (lineage) {
      try {
        const parsed = JSON.parse(lineage) as { branch?: string };
        if (parsed.branch) return parsed.branch;
      } catch {
        // fall through
      }
    }
    return dirName.replace(/__/g, "/");
  }

  private snapshotOf(branch: string): Record<string, string> {
    const files: Record<string, string> = {};
    for (const rel of this.list(branch)) {
      const content = this.read(branch, rel);
      if (content !== null) files[rel] = hashContent(content);
    }
    return files;
  }

  private writeManifest(branch: string, parent: string | null, files?: Record<string, string>): void {
    const manifest: BaseManifest = { parent, at: new Date().toISOString(), files: files ?? this.snapshotOf(branch) };
    atomicWrite(join(this.branchDir(branch), MANIFEST), JSON.stringify(manifest, null, 2));
  }

  private readManifest(branch: string): BaseManifest | null {
    const text = readText(join(this.branchDir(branch), MANIFEST));
    if (!text) return null;
    try {
      return JSON.parse(text) as BaseManifest;
    } catch {
      return null;
    }
  }

  private withLock<T>(branch: string, fn: () => T): T {
    const lockDir = join(this.root, "locks");
    mkdirSync(lockDir, { recursive: true });
    const lock = join(lockDir, `${this.repo ?? "_"}__${normalizeBranch(branch)}.lock`);
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > LOCK_TTL_MS) rmSync(lock, { force: true });
    try {
      writeFileSync(lock, JSON.stringify({ by: this.actor, at: new Date().toISOString() }), { flag: "wx" });
    } catch {
      throw new Error(`Branch ${branch} is locked by another merge; retry in a minute.`);
    }
    try {
      return fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }

  private log(entry: Record<string, unknown>): void {
    const at = new Date().toISOString();
    const dir = join(this.root, "history");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${at.slice(0, 7)}.jsonl`), JSON.stringify({ at, by: this.actor, ...(this.repo ? { repo: this.repo } : {}), ...entry }) + "\n");
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function walk(base: string, rel: string, out: string[]): void {
  const dir = join(base, rel);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(base, childRel, out);
    else if (!entry.name.endsWith(".tmp")) out.push(toPosix(childRel));
  }
}
