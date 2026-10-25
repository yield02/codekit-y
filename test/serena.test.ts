import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildContextText } from "../src/core/context.js";
import { claudeAddCommand, findSerena, planSerenaConfig, serenaArgs, serenaProjectFolder, serenaStatus } from "../src/core/serena.js";
import { applyChanges, planCursor, planVsCode } from "../src/core/tools-setup.js";
import { createFixture, tempDir } from "./helpers.js";

const TEMPLATE = `# Serena global configuration
# The web dashboard can be opened on launch; leave unset to be asked.
web_dashboard: True
web_dashboard_open_on_launch:
# Where each project's .serena folder lives
project_serena_folder_location: "$projectDir/.serena"
base_modes:
  - interactive
  - editing
projects: []
`;

describe("Serena launch arguments", () => {
  it("uses the documented context per client, no memories, no dashboard pop-up", () => {
    expect(serenaArgs("claude-code")).toEqual(["start-mcp-server", "--context", "claude-code", "--project-from-cwd", "--agent-interface", "tools", "--add-mode", "no-memories", "--open-web-dashboard", "False"]);
    expect(serenaArgs("cursor")).toContain("ide");
    expect(serenaArgs("vscode")).toContain("vscode");
    expect(claudeAddCommand("C:/u/.local/bin/serena.exe")).toEqual(["mcp", "add", "--scope", "user", "serena", "--", "C:/u/.local/bin/serena.exe", ...serenaArgs("claude-code")]);
  });

  it("can be pointed at a specific executable", () => {
    process.env.CODEKIT_SERENA_PATH = "D:\\tools\\serena.exe";
    try {
      expect(findSerena().executable).toBe("D:/tools/serena.exe");
    } finally {
      delete process.env.CODEKIT_SERENA_PATH;
    }
  });
});

describe("Serena global config", () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir("serena-home-");
    process.env.CODEKIT_HOME = join(dir, "codekit");
  });

  it("turns off the dashboard pop-up and moves .serena out of the repos, keeping comments", () => {
    const file = join(dir, "serena_config.yml");
    writeFileSync(file, TEMPLATE);
    const plan = planSerenaConfig(file);
    expect(plan.action).toBe("update");
    applyChanges([{ ...plan, action: "update" }]);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# The web dashboard can be opened on launch");
    expect(text).toMatch(/web_dashboard_open_on_launch: false/);
    expect(text).toContain(serenaProjectFolder());
    expect(serenaProjectFolder()).toMatch(/codekit\/serena\/\$projectFolderName\/\.serena$/);
    expect(text).toContain("- editing"); // untouched keys stay
    expect(planSerenaConfig(file).action).toBe("unchanged");
    const status = serenaStatus({ executable: "x", version: "2.1.0", uv: "uv" }, file);
    expect(status.config).toEqual({ exists: true, dashboardQuiet: true, folderOutsideRepo: true });
  });

  it("keeps a folder location the user chose, and waits for `serena init` when there is no config", () => {
    const file = join(dir, "custom.yml");
    writeFileSync(file, 'web_dashboard_open_on_launch: false\nproject_serena_folder_location: "/meta/$projectFolderName/.serena"\n');
    expect(planSerenaConfig(file).action).toBe("unchanged");
    expect(planSerenaConfig(join(dir, "missing.yml"))).toMatchObject({ action: "skipped" });
    expect(planSerenaConfig(join(dir, "missing.yml")).detail).toContain("serena init");
  });
});

describe("Serena in Cursor and VS Code config", () => {
  it("adds Serena next to codemap with the absolute executable path", () => {
    const root = tempDir();
    const dirs = { cursorDir: join(root, ".cursor"), vscodeUserDir: join(root, "Code", "User") };
    const exe = "C:/Users/dev/.local/bin/serena.exe";
    applyChanges([...planCursor(dirs, { serena: exe }), ...planVsCode(dirs, { serena: exe })]);
    const cursor = JSON.parse(readFileSync(join(dirs.cursorDir, "mcp.json"), "utf8"));
    expect(cursor.mcpServers.serena).toEqual({ command: exe, args: serenaArgs("cursor") });
    expect(cursor.mcpServers.codemap).toBeDefined();
    const vscode = JSON.parse(readFileSync(join(dirs.vscodeUserDir, "mcp.json"), "utf8"));
    expect(vscode.servers.serena).toEqual({ type: "stdio", command: exe, args: serenaArgs("vscode") });
    expect(readFileSync(join(dirs.vscodeUserDir, "prompts", "codekit.instructions.md"), "utf8")).toContain("activate_project");
    expect(planCursor(dirs, { serena: exe })[0]!.action).toBe("unchanged");
    // Without Serena, codemap alone.
    const bare = tempDir();
    applyChanges(planCursor({ cursorDir: join(bare, ".cursor"), vscodeUserDir: join(bare, "vs") }));
    expect(JSON.parse(readFileSync(join(bare, ".cursor", "mcp.json"), "utf8")).mcpServers.serena).toBeUndefined();
  });

  it("never replaces a Serena entry the user configured themselves", () => {
    const root = tempDir();
    const dirs = { cursorDir: join(root, ".cursor"), vscodeUserDir: join(root, "vs") };
    mkdirSync(dirs.cursorDir, { recursive: true });
    const mine = { command: "uvx", args: ["--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server"] };
    writeFileSync(join(dirs.cursorDir, "mcp.json"), JSON.stringify({ mcpServers: { serena: mine } }));
    const [plan] = planCursor(dirs, { serena: "/usr/local/bin/serena" });
    expect(plan!.detail).toContain('existing "serena" entry was kept');
    applyChanges([plan!]);
    expect(JSON.parse(readFileSync(join(dirs.cursorDir, "mcp.json"), "utf8")).mcpServers.serena).toEqual(mine);
  });
});

describe("session context tells agents how to activate Serena", () => {
  let fx: ReturnType<typeof createFixture>;
  afterEach(() => fx?.cleanup());
  it("includes the repo root", () => {
    fx = createFixture("folder");
    const ws = fx.ws();
    expect(buildContextText(ws)).toContain(`- Repo root: ${ws.source.root} (Serena: activate_project`);
  });
});
