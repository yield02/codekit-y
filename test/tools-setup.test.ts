import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyChanges, parseJsonc, planCursor, planVsCode } from "../src/core/tools-setup.js";
import { tempDir } from "./helpers.js";

describe("user-level tool setup", () => {
  it("creates Cursor MCP + guard hooks and VS Code MCP + instructions", () => {
    const root = tempDir();
    const dirs = { cursorDir: join(root, ".cursor"), vscodeUserDir: join(root, "Code", "User") };
    const changes = [...planCursor(dirs), ...planVsCode(dirs)];
    expect(changes.map((c) => c.action)).toEqual(["create", "create", "create", "create"]);
    applyChanges(changes);

    const cursorMcp = JSON.parse(readFileSync(join(dirs.cursorDir, "mcp.json"), "utf8"));
    expect(cursorMcp.mcpServers.codemap.command).toBe("node");
    expect(cursorMcp.mcpServers.codemap.args[0]).toMatch(/dist\/mcp\/main\.js$/);
    const hooks = JSON.parse(readFileSync(join(dirs.cursorDir, "hooks.json"), "utf8"));
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.beforeShellExecution[0].command).toContain("hook cursor-shell");
    expect(hooks.hooks.beforeMCPExecution[0].command).toContain("hook cursor-mcp");
    const vscode = JSON.parse(readFileSync(join(dirs.vscodeUserDir, "mcp.json"), "utf8"));
    expect(vscode.servers.codemap.type).toBe("stdio");
    expect(readFileSync(join(dirs.vscodeUserDir, "prompts", "codekit.instructions.md"), "utf8")).toContain("NEVER push");

    // Idempotent
    expect([...planCursor(dirs), ...planVsCode(dirs)].map((c) => c.action)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
  });

  it("merges into existing config, keeps other entries, and backs up", () => {
    const root = tempDir();
    const dirs = { cursorDir: join(root, ".cursor"), vscodeUserDir: join(root, "vs") };
    mkdirSync(dirs.cursorDir, { recursive: true });
    writeFileSync(join(dirs.cursorDir, "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    writeFileSync(join(dirs.cursorDir, "hooks.json"), JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: "my-audit" }] } }));
    applyChanges(planCursor(dirs));
    const mcp = JSON.parse(readFileSync(join(dirs.cursorDir, "mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(["codemap", "other"]);
    const hooks = JSON.parse(readFileSync(join(dirs.cursorDir, "hooks.json"), "utf8"));
    expect(hooks.hooks.beforeShellExecution.map((h: { command: string }) => h.command)[0]).toBe("my-audit");
    expect(readdirSync(dirs.cursorDir).some((f) => f.includes("codekit-backup"))).toBe(true);
  });

  it("never rewrites files with comments", () => {
    const root = tempDir();
    const dirs = { cursorDir: join(root, ".cursor"), vscodeUserDir: join(root, "vs") };
    mkdirSync(dirs.vscodeUserDir, { recursive: true });
    writeFileSync(join(dirs.vscodeUserDir, "mcp.json"), '{\n  // my servers\n  "servers": {},\n}\n');
    const [mcp] = planVsCode(dirs);
    expect(mcp!.action).toBe("skipped");
    expect(parseJsonc('{ /* c */ "a": 1, }')).toEqual({ a: 1 });
    expect(parseJsonc('{ "url": "http://x//y" }')).toEqual({ url: "http://x//y" });
  });
});
