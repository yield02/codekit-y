#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { loadUserConfig } from "../core/config.js";
import { tryGit } from "../core/git.js";
import { readLineage } from "../core/lineage.js";
import { packageRoot, userConfigPath } from "../core/paths.js";
import { createProjectStore, initRepo } from "../core/setup.js";
import { resolveWorkspace } from "../core/workspace.js";
import { fail, print } from "./shared.js";

const program = new Command("codekit").description("AI Code Kit setup and diagnostics");

program
  .command("project")
  .description("Manage knowledge stores")
  .command("create")
  .description("Scaffold a new knowledge store for a project (run once per project)")
  .argument("<name>", "project name")
  .requiredOption("--backend <kind>", "git | folder")
  .option("--url <url>", "git backend: URL of an empty internal repo (omit for a local-only store)")
  .option("--path <dir>", "folder backend: shared folder, e.g. \\\\NAS\\codemap\\shop")
  .option("--default-branch <name>", "source default branch", "main")
  .action((name: string, opts: { backend: string; url?: string; path?: string; defaultBranch: string }) => {
    const backend = parseBackend(opts.backend);
    const actor = `${tryGit(["config", "user.name"], process.cwd()) || process.env.GIT_AUTHOR_NAME || process.env.USERNAME || "codekit"} (cli)`;
    createProjectStore({ project: name, backend, url: opts.url, path: opts.path, defaultBranch: opts.defaultBranch, actor });
    print(`Knowledge store for "${name}" created (${backend}${opts.url ? `, ${opts.url}` : ""}${opts.path ? `, ${opts.path}` : ""}).\n` +
      `Next, in each developer's clone of the source repo: codekit init --project ${name} --backend ${backend}${opts.url ? ` --url ${opts.url}` : ""}${opts.path ? ` --path "${opts.path}"` : ""}`, false);
  });

program
  .command("init")
  .description("Register the current source repo with a project's knowledge store (per developer)")
  .requiredOption("--project <name>")
  .requiredOption("--backend <kind>", "git | folder")
  .option("--url <url>", "git backend: store repo URL")
  .option("--path <dir>", "folder backend: shared folder")
  .option("-C, --repo <dir>", "source repository directory", process.cwd())
  .action((opts: { project: string; backend: string; url?: string; path?: string; repo: string }) => {
    const { entry, source } = initRepo({ cwd: opts.repo, project: opts.project, backend: parseBackend(opts.backend), url: opts.url, path: opts.path });
    const plugin = `${packageRoot().replace(/\\/g, "/")}`;
    print([
      `Registered ${source.root} -> project "${entry.name}" (${entry.store.backend} store).`,
      `User config: ${userConfigPath()}`,
      "",
      "Claude Code (once per machine):",
      `  claude plugin marketplace add "${plugin}"`,
      "  claude plugin install codekit@codekit-y",
      "  claude plugin marketplace add obra/superpowers-marketplace && claude plugin install superpowers@superpowers-marketplace",
      "",
      "Cursor / Copilot: run `codekit mcp-config` and paste the snippet into your *user-level* MCP settings.",
      "Then verify with: codekit doctor",
    ].join("\n"), false);
  });

program
  .command("mcp-config")
  .description("Print user-level MCP configuration snippets for Cursor and VS Code (Copilot)")
  .action(() => {
    const server = { command: "node", args: [`${packageRoot().replace(/\\/g, "/")}dist/mcp/main.js`] };
    print([
      "Cursor — ~/.cursor/mcp.json:",
      JSON.stringify({ mcpServers: { codemap: server } }, null, 2),
      "",
      "VS Code (Copilot) — user mcp.json (Command Palette: 'MCP: Open User Configuration'):",
      JSON.stringify({ servers: { codemap: { type: "stdio", ...server } } }, null, 2),
      "",
      "Serena (structural layer) — add alongside, per the Serena docs (requires uv).",
    ].join("\n"), false);
  });

program
  .command("projects")
  .description("List registered projects")
  .action(() => {
    const cfg = loadUserConfig();
    print(cfg.projects.length ? cfg.projects.map((p) => `${p.name}  ${p.store.backend}  ${p.store.url ?? p.store.path ?? "(local)"}  [${p.remotes.join(", ")}]`).join("\n") : "No projects registered.", false);
  });

program
  .command("doctor")
  .description("Check the codekit setup for the current repo")
  .option("-C, --repo <dir>", "source repository directory", process.cwd())
  .action((opts: { repo: string }) => {
    const checks: [string, boolean, string][] = [];
    const has = (cmd: string, args: string[] = ["--version"]) => {
      // Fixed command strings only (no user input), so a shell is safe and finds .cmd shims on Windows.
      const r = spawnSync([cmd, ...args].join(" "), { encoding: "utf8", shell: true, timeout: 10_000 });
      return r.status === 0 ? (r.stdout || r.stderr).trim().split("\n")[0]! : "";
    };
    checks.push(["node", true, process.version]);
    const gitV = has("git");
    checks.push(["git", !!gitV, gitV || "not found"]);
    const uvV = has("uv");
    checks.push(["uv (for Serena)", !!uvV, uvV || "not found — install uv to use Serena"]);
    const claudeV = has("claude");
    checks.push(["claude CLI", !!claudeV, claudeV || "not found (only needed for Claude Code)"]);
    const mcpOk = existsSync(join(packageRoot(), "dist", "mcp", "main.js"));
    checks.push(["kit built", mcpOk, mcpOk ? packageRoot() : "dist/ missing — run `npm install && npm run build` in the kit repo"]);
    const res = resolveWorkspace(opts.repo, "doctor");
    if (!res.ok) {
      checks.push(["repo registered", false, `${res.reason}: ${res.detail}`]);
    } else {
      const w = res.workspace;
      checks.push(["repo registered", true, `project ${w.project.name}`]);
      try {
        w.store.refresh();
        checks.push(["store reachable", true, `${w.store.kind}`]);
        checks.push(["store config", !!w.store.readConfig("codekit.yaml"), w.store.readConfig("codekit.yaml") ? "codekit.yaml found" : "codekit.yaml missing"]);
        const mapExists = w.store.hasBranch(w.branch);
        const lineage = mapExists ? readLineage(w.store, w.branch) : null;
        checks.push(["branch map", true, mapExists ? `${w.branch} (from ${lineage?.parent ?? "root"})` : `${w.branch} — will be created on first use`]);
      } catch (err) {
        checks.push(["store reachable", false, err instanceof Error ? err.message : String(err)]);
      }
    }
    print(checks.map(([name, ok, detail]) => `${ok ? "✔" : "✘"} ${name.padEnd(22)} ${detail}`).join("\n"), false);
    if (checks.some(([name, ok]) => !ok && ["git", "repo registered", "store reachable"].includes(name))) process.exitCode = 1;
  });

function parseBackend(v: string): "git" | "folder" {
  if (v !== "git" && v !== "folder") throw new Error(`--backend must be git or folder, got "${v}"`);
  return v;
}

program.parseAsync().catch(fail);
