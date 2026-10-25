import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { handlePreToolUse } from "../src/core/guard-hooks.js";
import { handlePostToolUse, handleSessionStart, handleStop } from "../src/core/hooks.js";
import { resolveRoots, workspaceForPath } from "../src/core/parent.js";
import { createProjectStore, initAll } from "../src/core/setup.js";
import { createServer } from "../src/mcp/server.js";
import { requireWorkspaces } from "../src/cli/shared.js";
import { IDENTITY, MAP_BODY, sh, tempDir, writeSource } from "./helpers.js";

const SERVICES = ["Transactions", "Core", "Abs", "Admin"];

/** Transfer/{Transactions,Core,Abs,Admin}: a parent folder (not a repo) holding 4 registered repos. */
function createTransfer() {
  const root = tempDir("codekit-transfer-");
  process.env.CODEKIT_HOME = join(root, "home");
  Object.assign(process.env, IDENTITY);
  const store = join(root, "nas", "transfer");
  createProjectStore({ project: "Transfer", backend: "folder", path: store, actor: "Test Dev (test)" });
  const parent = join(root, "Transfer");
  mkdirSync(join(parent, "docs"), { recursive: true }); // a plain folder next to the repos
  for (const name of SERVICES) {
    const remote = join(root, "github", `transfer-${name.toLowerCase()}.git`);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    const dir = join(parent, name);
    execFileSync("git", ["clone", "-q", remote, dir]);
    sh(dir, "config", "core.autocrlf", "false");
    sh(dir, "checkout", "-q", "-b", "main");
    writeSource(dir, "src/index.ts", `export const service = "${name}";\n`);
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "init");
    sh(dir, "push", "-q", "-u", "origin", "main");
  }
  const results = initAll({ parent, project: "Transfer", backend: "folder", path: store });
  return { root, parent, store, results };
}

async function mcpClient(rootDir: string) {
  process.env.CODEKIT_REPO = rootDir;
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0]!.text, isError: !!r.isError };
  };
  return { client, call };
}

describe("parent folder Transfer/{Transactions,Core,Abs,Admin}", () => {
  let fx: ReturnType<typeof createTransfer>;
  beforeEach(() => { fx = createTransfer(); });
  afterEach(() => { delete process.env.CODEKIT_REPO; });

  it("init --all registers every sub-repo, named after its folder", () => {
    expect(fx.results.map((r) => r.repo.name).sort()).toEqual(["abs", "admin", "core", "transactions"]);
    expect(fx.results.every((r) => r.guard.installed)).toBe(true);
    // A second developer runs init --all too and gets the same names from the store.
    process.env.CODEKIT_HOME = join(fx.root, "home-b");
    const again = initAll({ parent: fx.parent, project: "Transfer", backend: "folder", path: fx.store });
    expect(again.map((r) => r.repo.name).sort()).toEqual(["abs", "admin", "core", "transactions"]);
  });

  it("resolves the parent folder (and multi-root workspaces) to all its repos, and routes paths", () => {
    const res = resolveRoots([fx.parent]);
    expect(res.kind).toBe("parent");
    if (res.kind !== "parent") return;
    expect(res.parent.workspaces.map((w) => w.repo.name)).toEqual(["abs", "admin", "core", "transactions"]);
    expect(workspaceForPath(res.parent, "Core/src/index.ts")).toMatchObject({ path: "src/index.ts" });
    expect(workspaceForPath(res.parent, "Core/src/index.ts")!.ws.repo.name).toBe("core");
    expect(workspaceForPath(res.parent, "admin:src/index.ts")!.ws.repo.name).toBe("admin");
    expect(workspaceForPath(res.parent, join(fx.parent, "Abs", "src", "index.ts"))!.ws.repo.name).toBe("abs");
    expect(workspaceForPath(res.parent, "docs/readme.md")).toBeNull();

    const multiRoot = resolveRoots([join(fx.parent, "Core"), join(fx.parent, "Admin")]);
    expect(multiRoot.kind === "parent" && multiRoot.parent.workspaces.map((w) => w.repo.name)).toEqual(["admin", "core"]);
    expect(resolveRoots([join(fx.parent, "Core")]).kind).toBe("repo");
    expect(requireWorkspaces(fx.parent).map((w) => w.repo.name)).toEqual(["abs", "admin", "core", "transactions"]);
  });

  it("session start on the parent folder injects every repo and the project's rules once", async () => {
    const out = (await handleSessionStart({ session_id: "s", cwd: fx.parent })) as { hookSpecificOutput: { additionalContext: string } };
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("with 4 registered repos");
    for (const [folder, repo] of [["Transactions", "transactions"], ["Core", "core"], ["Abs", "abs"], ["Admin", "admin"]]) {
      expect(ctx).toContain(`## ${folder}/ → repo "${repo}" of project "Transfer", branch "main"`);
    }
    expect(ctx.match(/<!-- Project rules/g)).toHaveLength(1);
    expect(ctx).toContain("No summary yet for: abs, admin, core, transactions");
  });

  it("tracks edits in any sub-repo and asks for their maps at stop", async () => {
    const session = { session_id: "s2", cwd: fx.parent };
    await handlePostToolUse({ ...session, tool_name: "Edit", tool_input: { file_path: join(fx.parent, "Core", "src", "index.ts") } });
    await handlePostToolUse({ ...session, tool_name: "Read", tool_input: { file_path: "Admin/src/index.ts" } });
    await handlePostToolUse({ ...session, tool_name: "Read", tool_input: { file_path: join(fx.parent, "docs", "x.md") } }); // not a repo
    const stop = (await handleStop(session)) as { decision: string; reason: string };
    expect(stop.decision).toBe("block");
    expect(stop.reason).toContain("- admin:src/index.ts (missing)");
    expect(stop.reason).toContain("- core:src/index.ts (missing)");
    expect(stop.reason).toContain('"<repo>:<path>"');
  });

  it("denies every push-like command from the parent folder", () => {
    const deny = (command: string) => !!handlePreToolUse({ cwd: fx.parent, tool_name: "Bash", tool_input: { command } });
    expect(deny("git push")).toBe(true);
    expect(deny("cd Core && git push origin main")).toBe(true);
    expect(deny("gh pr create --fill")).toBe(true);
    expect(deny("git -C Admin status")).toBe(false);
    expect(deny("git -C Admin commit -am wip")).toBe(false);
    expect(handlePreToolUse({ cwd: tempDir("unrelated-"), tool_name: "Bash", tool_input: { command: "git push" } })).toBeNull();
  });

  it("denies AI files in any sub-repo from the parent folder, but not in the parent itself", () => {
    const tool = (tool_name: string, tool_input: Record<string, unknown>) => !!handlePreToolUse({ cwd: fx.parent, tool_name, tool_input });
    expect(tool("Write", { file_path: join(fx.parent, "Core", "CLAUDE.md") })).toBe(true);
    expect(tool("Write", { file_path: "Admin/docs/plans/x.md" })).toBe(true);
    expect(tool("Bash", { command: "echo x > Transactions/.cursorrules" })).toBe(true);
    expect(tool("Bash", { command: "cd Abs && git commit --no-verify -m x" })).toBe(true);
    expect(tool("Write", { file_path: join(fx.parent, "Core", "src", "index.ts") })).toBe(false);
    expect(tool("Write", { file_path: join(fx.parent, "docs", "notes.md") })).toBe(false); // the parent is not a repo
  });

  it("MCP tools route by path or repo from the parent folder", async () => {
    const { client, call } = await mcpClient(fx.parent);
    expect((await call("codemap_context")).text).toContain("with 4 registered repos");

    expect((await call("codemap_lookup", { paths: ["Core/src/index.ts"] })).text).toContain("=== core:src/index.ts [missing]");
    const write = await call("codemap_write", { path: "Admin/src/index.ts", body: MAP_BODY, tags: ["admin"] });
    expect(write.text).toContain("for repo admin");
    expect((await call("codemap_lookup", { paths: ["Admin/src/index.ts", "admin:src/index.ts"] })).text.match(/\[ok\]/g)).toHaveLength(2);
    expect((await call("codemap_write", { path: "src/index.ts", repo: "core", body: MAP_BODY })).text).toContain("for repo core");
    expect((await call("codemap_search", { query: "admin" })).text).toContain("admin:src/index.ts"); // project scope by default here

    const noRepo = await call("plan_save", { name: "x", content: "# x" });
    expect(noRepo.isError).toBe(true);
    expect(noRepo.text).toContain("pass repo: one of abs, admin, core, transactions");
    expect((await call("plan_save", { name: "Refund flow", content: "# Plan", repo: "transactions" })).text).toContain("for repo transactions");
    expect((await call("codemap_write", { path: "docs/readme.md", body: MAP_BODY })).isError).toBe(true);
    await client.close();
  });
});
