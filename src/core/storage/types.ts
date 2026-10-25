import type { BackendKind } from "../config.js";

/** rel path -> content hash (see hashContent) */
export type Snapshot = Map<string, string>;

/**
 * Backend-neutral access to a project's knowledge store.
 *
 * Two areas:
 * - config area (shared, not branched): codekit.yaml, rules/, conventions/
 * - branch areas (one per source branch): modules/, lineage/, plans/
 *
 * Branch arguments are always *source* branch names (`feature/login-otp`);
 * adapters normalize them for refs/directories.
 */
export interface StorageAdapter {
  readonly kind: BackendKind;

  /** Bring the local view up to date (git: fetch; folder: no-op). */
  refresh(): void;

  readConfig(rel: string): string | null;
  writeConfig(rel: string, content: string, message: string): void;

  listBranches(): string[];
  hasBranch(branch: string): boolean;
  /** Create a branch area, copying the parent's content (or empty when parent is null). */
  createBranch(branch: string, parent: string | null): void;
  archiveBranch(branch: string): void;

  read(branch: string, rel: string): string | null;
  write(branch: string, rel: string, content: string, message: string): void;
  /** Files under `prefix` (e.g. `modules/`), store-relative posix paths. */
  list(branch: string, prefix?: string): string[];

  /** Hashes of every file at the common base of `from` and `into`. */
  baseSnapshot(from: string, into: string): Snapshot;
  /** Record a merge of `from` into `into` whose resolved content is `changes` (null = delete). */
  commitMerge(from: string, into: string, changes: Map<string, string | null>, message: string): void;

  /** Absolute local directory of a branch area, when the backend has one (for viewers/debugging). */
  localPath(branch: string): string | null;
}
