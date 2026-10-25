import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { lookup, readServices, search, writeMap, writeService } from "../src/core/codemap.js";
import { loadUserConfig, parseStoreConfig, type BackendKind } from "../src/core/config.js";
import { buildContextText } from "../src/core/context.js";
import { readLineage } from "../src/core/lineage.js";
import { userConfigPath } from "../src/core/paths.js";
import { createProjectStore, initRepo } from "../src/core/setup.js";
import { sync } from "../src/core/sync.js";
import { collectProjectViewData } from "../src/core/view.js";
import { resolveWorkspace, type Workspace } from "../src/core/workspace.js";
import { IDENTITY, MAP_BODY, sh, tempDir, tick, writeSource } from "./helpers.js";

interface MultiFixture {
  root: string;
  store: string;
  backend: BackendKind;
  repos: Record<string, string>;
  ws(repo: string): Workspace;
}

/** Project "ABC" with services `core` and `product`, one shared knowledge store. */
async function createMulti(backend: BackendKind): Promise<MultiFixture> {
  const root = tempDir("codekit-abc-");
  process.env.CODEKIT_HOME = join(root, "home");
  Object.assign(process.env, IDENTITY);
  const store = backend === "git" ? join(root, "abc-codemap.git") : join(root, "nas", "abc");
  if (backend === "git") execFileSync("git", ["init", "-q", "--bare", store]);
  createProjectStore({ project: "ABC", backend, ...(backend === "git" ? { url: store } : { path: store }), actor: "Test Dev (test)" });

  const repos: Record<string, string> = {};
  for (const name of ["core", "product"]) {
    await tick();
    const remote = join(root, "github", `abc-${name}.git`);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    const dir = join(root, name);
    execFileSync("git", ["clone", "-q", remote, dir]);
    sh(dir, "config", "core.autocrlf", "false");
    sh(dir, "checkout", "-q", "-b", "main");
    // Same paths in both services on purpose: their maps must not collide.
    writeSource(dir, "src/index.ts", `export const service = "${name}";\n`);
    writeSource(dir, `src/${name}.service.ts`, `export class ${name[0]!.toUpperCase()}${name.slice(1)}Service {}\n`);
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "init");
    sh(dir, "push", "-q", "-u", "origin", "main");
    initRepo({ cwd: dir, project: "ABC", backend, ...(backend === "git" ? { url: store } : { path: store }), repoName: name });
    repos[name] = dir;
  }
  return {
    root, store, backend, repos,
    ws(repo) {
      const res = resolveWorkspace(repos[repo]!, "test");
      if (!res.ok) throw new Error(res.reason);
      return res.workspace;
    },
  };
}

for (const backend of ["git", "folder"] as const) {
  describe(`microservice project ABC (${backend} backend)`, () => {
    let fx: MultiFixture;
    afterEach(() => { /* temp dirs left for the OS */ });

    it("registers every repo of the project against one store", async () => {
      fx = await createMulti(backend);
      const project = loadUserConfig().projects.find((p) => p.name === "ABC")!;
      expect(project.repos.map((r) => r.name).sort()).toEqual(["core", "product"]);
      const core = fx.ws("core");
      const product = fx.ws("product");
      expect(core.repo.name).toBe("core");
      expect(product.repo.name).toBe("product");
      expect(core.store.readConfig("codekit.yaml")).toBe(product.store.readConfig("codekit.yaml")); // shared rules/conventions
    });

    it("keeps each repo's maps and branches apart inside the shared store", async () => {
      fx = await createMulti(backend);
      const core = fx.ws("core");
      const product = fx.ws("product");
      sync(core);
      sync(product);
      writeMap(core, { path: "src/index.ts", body: MAP_BODY.replace("Login.", "Core entry.") });
      writeMap(product, { path: "src/index.ts", body: MAP_BODY.replace("Login.", "Product entry.") });
      expect(lookup(core, ["src/index.ts"])[0]!.map!.body).toContain("Core entry.");
      expect(lookup(product, ["src/index.ts"])[0]!.map!.body).toContain("Product entry.");
      expect(core.store.listRepos()).toEqual(["core", "product"]);

      sh(fx.repos.product!, "checkout", "-q", "-b", "feature/discount");
      const pf = fx.ws("product");
      expect(sync(pf).created).toEqual({ branch: "feature/discount", parent: "main" });
      expect(fx.ws("core").store.listBranches()).toEqual(["main"]); // core is untouched
      expect(readLineage(pf.store, "feature/discount")!.parent).toBe("main");
    });

    it("a repo first seen on a feature branch is rooted at its default branch", async () => {
      fx = await createMulti(backend);
      sh(fx.repos.core!, "checkout", "-q", "-b", "feature/first");
      const report = sync(fx.ws("core"));
      expect(report.created).toEqual({ branch: "feature/first", parent: "main" });
      expect(fx.ws("core").store.listBranches().sort()).toEqual(["feature/first", "main"]);
    });

    it("looks up, references and searches other services", async () => {
      fx = await createMulti(backend);
      const core = fx.ws("core");
      const product = fx.ws("product");
      sync(core);
      sync(product);
      writeMap(core, { path: "src/core.service.ts", body: MAP_BODY.replace("Login.", "Core user API."), tags: ["user"] });
      writeMap(product, { path: "src/product.service.ts", body: MAP_BODY, dependsOn: ["core:src/core.service.ts", "src/index.ts"], tags: ["catalog"] });

      const [cross] = lookup(product, ["core:src/core.service.ts"]);
      expect(cross).toMatchObject({ path: "core:src/core.service.ts", status: "ok" });
      expect(cross!.map!.body).toContain("Core user API.");
      expect(lookup(product, ["product:src/product.service.ts"])[0]!.status).toBe("ok"); // own repo, qualified
      expect(lookup(product, ["billing:src/x.ts"])[0]).toMatchObject({ status: "not-found" });
      expect(lookup(product, ["src/product.service.ts"])[0]!.map!.meta.dependsOn).toEqual(["core:src/core.service.ts", "src/index.ts"]);

      writeSource(fx.repos.core!, "src/core.service.ts", "export class CoreService { v2() {} }\n");
      expect(lookup(product, ["core:src/core.service.ts"])[0]!.status).toBe("stale");

      expect(search(product, "user", 20, "project").map((h) => h.path)).toEqual(["core:src/core.service.ts"]);
      expect(search(product, "user", 20, "repo")).toEqual([]);
    });

    it("cross-repo maps of a service not cloned here are served as `remote`", async () => {
      fx = await createMulti(backend);
      const core = fx.ws("core");
      sync(core);
      sync(fx.ws("product"));
      writeMap(core, { path: "src/core.service.ts", body: MAP_BODY });
      // This developer only works on product: drop core's local clone from the user config.
      const cfg = readFileSync(userConfigPath(), "utf8");
      const parsed = loadUserConfig();
      parsed.projects[0]!.repos = parsed.projects[0]!.repos.map((r) => (r.name === "core" ? { name: r.name, remote: r.remote } : r));
      writeFileSync(userConfigPath(), stringify(parsed));
      expect(lookup(fx.ws("product"), ["core:src/core.service.ts"])[0]!.status).toBe("remote");
      writeFileSync(userConfigPath(), cfg);
    });

    it("service summaries are shared across the project and shown in context", async () => {
      fx = await createMulti(backend);
      const core = fx.ws("core");
      const product = fx.ws("product");
      sync(core);
      sync(product);
      writeService(core, "## Purpose\nUsers and auth.\n## Exposes\n- GET /users/:id\n## Consumes\n- none\n## Data owned\n- users\n## Notes\n-");
      const services = readServices(product);
      expect(services.map((s) => [s.repo, s.current, !!s.body])).toEqual([["core", false, true], ["product", true, false]]);
      const ctx = buildContextText(product);
      expect(ctx).toContain('repo "product"');
      expect(ctx).toContain("### core — map branch main");
      expect(ctx).toContain("GET /users/:id");
      expect(ctx).toContain("This service has no summary yet");
    });

    it("project view merges every service with cross-service edges", async () => {
      fx = await createMulti(backend);
      const core = fx.ws("core");
      const product = fx.ws("product");
      sync(core);
      sync(product);
      writeMap(core, { path: "src/core.service.ts", body: MAP_BODY });
      writeMap(product, { path: "src/product.service.ts", body: MAP_BODY, dependsOn: ["core:src/core.service.ts", "src/index.ts"] });
      const data = collectProjectViewData(product);
      expect(data.maps.map((m) => m.path)).toEqual(["core:src/core.service.ts", "product:src/product.service.ts"]);
      expect(data.maps[1]!.dependsOn).toEqual(["core:src/core.service.ts", "product:src/index.ts"]);
    });
  });
}

describe("project/repo registration rules", () => {
  it("all repos of a project must use the same store, and repo names are unique", async () => {
    const fx = await createMulti("folder");
    const other = join(fx.root, "billing");
    execFileSync("git", ["init", "-q", "-b", "main", other]);
    sh(other, "remote", "add", "origin", "https://github.com/abc/billing.git");
    expect(() => initRepo({ cwd: other, project: "ABC", backend: "folder", path: join(fx.root, "elsewhere") })).toThrow(/share one store/);
    expect(() => initRepo({ cwd: other, project: "ABC", backend: "folder", path: fx.store, repoName: "core" })).toThrow(/already used/);
    const res = initRepo({ cwd: other, project: "ABC", backend: "folder", path: fx.store });
    expect(res.repo.name).toBe("billing");
    expect(res.entry.repos.map((r) => r.name).sort()).toEqual(["billing", "core", "product"]);
  });

  it("a second developer gets the repo names the team's store already uses", async () => {
    const fx = await createMulti("git");
    expect(fx.ws("core").store.readConfig("codekit.yaml")).toMatch(/repos:\s*\n\s+core:\s*\n\s+remote:/);
    // Developer B: own ~/.codekit and own clone, no --repo-name.
    process.env.CODEKIT_HOME = join(fx.root, "home-b");
    const cloneB = join(fx.root, "b-product");
    execFileSync("git", ["clone", "-q", join(fx.root, "github", "abc-product.git"), cloneB]);
    const res = initRepo({ cwd: cloneB, project: "ABC", backend: "git", url: fx.store });
    expect(res.repo.name).toBe("product");
    expect(() => initRepo({ cwd: cloneB, project: "ABC", backend: "git", url: fx.store, repoName: "catalog" })).toThrow(/already names this repo "product"/);
  });

  it("reads older user configs that listed bare remotes", () => {
    const root = tempDir();
    process.env.CODEKIT_HOME = join(root, "home");
    mkdirSync(join(root, "home"), { recursive: true });
    writeFileSync(userConfigPath(), stringify({ projects: [{ name: "shop", remotes: ["github.com/acme/shop"], store: { backend: "git" } }] }));
    expect(loadUserConfig().projects[0]!.repos).toEqual([{ name: "shop", remote: "github.com/acme/shop" }]);
  });

  it("applies per-repo overrides from codekit.yaml", () => {
    const yaml = "project: ABC\nexclude: ['*.lock']\nrepos:\n  product:\n    defaultBranch: develop\n    exclude: ['**/generated/**']\n    description: Catalog and pricing\n";
    const product = parseStoreConfig(yaml, "ABC", "product");
    expect(product.defaultBranch).toBe("develop");
    expect(product.exclude).toEqual(["*.lock", "**/generated/**"]);
    expect(parseStoreConfig(yaml, "ABC", "core").defaultBranch).toBe("main");
  });
});
