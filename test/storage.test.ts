import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashContent } from "../src/core/hash.js";
import { FolderStorage } from "../src/core/storage/folder.js";
import { GitStorage } from "../src/core/storage/git.js";
import type { StorageAdapter } from "../src/core/storage/types.js";
import { IDENTITY, tempDir } from "./helpers.js";

// The same contract runs against both backends.

interface Env {
  store: StorageAdapter;
  /** A second developer's view of the same store. */
  other: () => StorageAdapter;
}

const backends: Record<string, (root: string) => Env> = {
  git: (root) => {
    const remote = join(root, "store.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    const store = new GitStorage(join(root, "dev-a"), remote, "core");
    store.initConfig(new Map([["codekit.yaml", "project: shop\n"]]));
    return { store, other: () => new GitStorage(join(root, "dev-b"), remote, "core") };
  },
  folder: (root) => {
    const path = join(root, "nas");
    const store = new FolderStorage(path, "dev-a", "core");
    store.writeConfig("codekit.yaml", "project: shop\n", "init");
    return { store, other: () => new FolderStorage(path, "dev-b", "core") };
  },
};

for (const [kind, make] of Object.entries(backends)) {
  describe(`${kind} storage`, () => {
    let root: string;
    let env: Env;

    beforeEach(() => {
      Object.assign(process.env, IDENTITY);
      root = tempDir(`codekit-${kind}-`);
      env = make(root);
    });
    afterEach(() => {
      // temp dirs are left for the OS to clean (Windows keeps handles on git files briefly)
    });

    it("reads and writes the shared config area", () => {
      expect(env.store.readConfig("codekit.yaml")).toBe("project: shop\n");
      env.store.writeConfig("conventions/naming.md", "# Naming\n", "add naming");
      const other = env.other();
      other.refresh();
      expect(other.readConfig("conventions/naming.md")).toBe("# Naming\n");
    });

    it("creates a root branch and shares writes with teammates", () => {
      env.store.createBranch("main", null);
      env.store.write("main", "modules/src/a.ts.md", "A", "map a");
      expect(env.store.read("main", "modules/src/a.ts.md")).toBe("A");
      expect(env.store.list("main", "modules/")).toEqual(["modules/src/a.ts.md"]);

      const other = env.other();
      other.refresh();
      expect(other.hasBranch("main")).toBe(true);
      expect(other.read("main", "modules/src/a.ts.md")).toBe("A");
    });

    it("copies the parent's map when a branch is created", () => {
      env.store.createBranch("main", null);
      env.store.write("main", "modules/src/a.ts.md", "A", "map a");
      env.store.createBranch("feature/x", "main");
      expect(env.store.read("feature/x", "modules/src/a.ts.md")).toBe("A");
      expect(env.store.listBranches().sort()).toEqual(["feature/x", "main"]);

      env.store.write("feature/x", "modules/src/b.ts.md", "B", "map b");
      expect(env.store.read("main", "modules/src/b.ts.md")).toBeNull();
    });

    it("exposes the common base and applies merges", () => {
      env.store.createBranch("main", null);
      env.store.write("main", "modules/src/a.ts.md", "A", "map a");
      env.store.createBranch("feature/x", "main");
      env.store.write("feature/x", "modules/src/a.ts.md", "A2", "map a2");

      const base = env.store.baseSnapshot("feature/x", "main");
      expect(base.get("modules/src/a.ts.md")).toBe(hashContent("A"));

      env.store.commitMerge("feature/x", "main", new Map([["modules/src/a.ts.md", "A2"]]), "merge");
      expect(env.store.read("main", "modules/src/a.ts.md")).toBe("A2");
    });

    it("archives a branch", () => {
      env.store.createBranch("main", null);
      env.store.createBranch("feature/old", "main");
      env.store.archiveBranch("feature/old");
      expect(env.store.hasBranch("feature/old")).toBe(false);
      expect(env.store.hasBranch("main")).toBe(true);
    });
  });
}
