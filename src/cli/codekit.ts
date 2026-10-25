#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Command } from "commander";
import { loadUserConfig } from "../core/config.js";
import { tryGit } from "../core/git.js";
import { readLineage } from "../core/lineage.js";
import { formatLog, formatNoiseReport, matches, noiseReport, parseLogLine, sinceToIso, type ParsedLog } from "../core/logview.js";
import { packageRoot, userConfigPath } from "../core/paths.js";
import { createProjectStore, initAll, initRepo, prePushGuardInstalled } from "../core/setup.js";
import { applyChanges, defaultToolDirs, planCursor, planVsCode, USER_RULES, VSCODE_SETTINGS_SNIPPET } from "../core/tools-setup.js";
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
  .description("Register a source repo with its project's knowledge store (per developer, once per repo; all repos of a project share one store)")
  .requiredOption("--project <name>")
  .requiredOption("--backend <kind>", "git | folder")
  .option("--url <url>", "git backend: store repo URL")
  .option("--path <dir>", "folder backend: shared folder")
  .option("--repo-name <name>", "key of this repo in the project, e.g. core, product (default: from the remote)")
  .option("--all", "register every git repo under -C (a parent folder such as Transfer/), named after its folder unless the store already knows it")
  .option("-C, --repo <dir>", "source repository directory (or the parent folder with --all)", process.cwd())
  .action((opts: { project: string; backend: string; url?: string; path?: string; repo: string; repoName?: string; all?: boolean }) => {
    const base = { project: opts.project, backend: parseBackend(opts.backend), url: opts.url, path: opts.path };
    if (opts.all && opts.repoName) throw new Error("--repo-name cannot be combined with --all (each repo is named after its folder).");
    const results = opts.all ? initAll({ ...base, parent: opts.repo }) : [initRepo({ ...base, cwd: opts.repo, repoName: opts.repoName })];
    const entry = results.at(-1)!.entry;
    const plugin = `${packageRoot().replace(/\\/g, "/")}`;
    print([
      ...results.map(({ repo, source, guard }) =>
        `Registered ${source.root} as repo "${repo.name}" · push guard: ${guard.installed ? `pre-push hook installed${guard.chained ? " (chaining your hook)" : ""}` : `NOT installed — ${guard.reason}`}`),
      `Project "${entry.name}" (${entry.store.backend} store) now has ${entry.repos.length} repo${entry.repos.length === 1 ? "" : "s"}: ${entry.repos.map((r) => r.name).join(", ")}.`,
      `User config: ${userConfigPath()}`,
      "AI agents can edit and commit locally but never push. Open the AI tool on one repo or on the parent folder; both work.",
      "",
      "Claude Code (once per machine):",
      `  claude plugin marketplace add "${plugin}"`,
      "  claude plugin install codekit@codekit-y",
      "  claude plugin marketplace add obra/superpowers-marketplace && claude plugin install superpowers@superpowers-marketplace",
      "",
      "Cursor / Copilot (user-level MCP, push-guard hooks, instructions): codekit setup-tools",
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
  .command("setup-tools")
  .description("Write user-level config for Cursor and VS Code/Copilot: MCP server, push-guard hooks, instructions")
  .option("--cursor", "configure Cursor (~/.cursor)")
  .option("--vscode", "configure VS Code / Copilot (user data dir)")
  .option("--dry-run", "show what would change without writing", false)
  .action((opts: { cursor?: boolean; vscode?: boolean; dryRun: boolean }) => {
    const both = !opts.cursor && !opts.vscode;
    const dirs = defaultToolDirs();
    const changes = [...(both || opts.cursor ? planCursor(dirs) : []), ...(both || opts.vscode ? planVsCode(dirs) : [])];
    const lines = changes.map((c) => `${c.action.padEnd(9)} ${c.file}\n          ${c.detail}`);
    if (!opts.dryRun) applyChanges(changes);
    const skipped = changes.filter((c) => c.action === "skipped" && c.content);
    print([
      opts.dryRun ? "Dry run — nothing written:" : "User-level tool config:",
      ...lines,
      ...skipped.flatMap((c) => ["", `Merge manually into ${c.file}:`, c.content!]),
      "",
      "Cursor: also paste these lines into Settings → Rules → User Rules:",
      USER_RULES.split("\n").slice(0, 5).join("\n"),
      "",
      "VS Code: add to your user settings.json so agent pushes always need your approval:",
      JSON.stringify(VSCODE_SETTINGS_SNIPPET, null, 2),
    ].join("\n"), false);
  });

program
  .command("logs")
  .description("Read convention JSON logs (any stack): filter, trace one request, or find the noisiest messages")
  .argument("[files...]", "log files (default: stdin)")
  .option("--cid <id>", "correlationId (full, or last 6+ chars as shown in pretty lines)")
  .option("-t, --tag <tag...>", "keep lines with any of these tags")
  .option("-l, --level <level>", "minimum level: debug | info | warn | error")
  .option("--logger <name>", "logger name contains")
  .option("--service <name>", "service equals")
  .option("-g, --grep <text>", "text in message, context or error")
  .option("--since <when>", "ISO time or relative (15m, 2h, 1d)")
  .option("--trace <cid>", "timeline of one request across services, +ms from its first line, with stacks")
  .option("--stats", "noise report: volume by level/message/logger and over-logging hints")
  .option("--show-logger", "print service/logger on each line")
  .option("--stack", "print error stacks")
  .option("--no-color", "plain output")
  .option("--json", "output matching lines as JSON")
  .action(async (files: string[], o: { cid?: string; tag?: string[]; level?: string; logger?: string; service?: string; grep?: string; since?: string; trace?: string; stats?: boolean; showLogger?: boolean; stack?: boolean; color: boolean; json?: boolean }) => {
    const filter = { cid: o.trace ?? o.cid, tags: o.tag, level: o.level, logger: o.logger, service: o.service, grep: o.grep, since: o.since };
    const sinceIso = o.since ? sinceToIso(o.since) : undefined;
    const color = o.color && !!process.stdout.isTTY;
    const collected: ParsedLog[] = [];
    const streaming = !o.trace && !o.stats;
    const inputs = files.length ? files.map((f) => createReadStream(f)) : [process.stdin];
    for (const input of inputs) {
      for await (const raw of createInterface({ input, crlfDelay: Infinity })) {
        const log = parseLogLine(raw);
        if (!log) {
          if (streaming && !Object.values(filter).some(Boolean) && !o.json && raw.trim()) process.stdout.write(raw + "\n"); // pass non-JSON lines through
          continue;
        }
        if (!matches(log, filter, sinceIso)) continue;
        if (streaming) process.stdout.write((o.json ? JSON.stringify(log) : formatLog(log, { color, showLogger: o.showLogger, showStack: o.stack })) + "\n");
        else collected.push(log);
      }
    }
    if (o.stats) return print(formatNoiseReport(noiseReport(collected)), false);
    if (o.trace) {
      collected.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      if (!collected.length) return print(`No lines for correlationId ${o.trace}.`, false);
      const first = collected[0]!;
      const total = Date.parse(collected.at(-1)!.timestamp) - Date.parse(first.timestamp);
      const services = [...new Set(collected.map((l) => l.service).filter(Boolean))];
      print([
        `Request ${first.correlationId} · ${collected.length} lines · ${total}ms · services: ${services.join(", ") || "-"} · started ${first.timestamp}`,
        ...collected.map((l) => formatLog(l, { color, showLogger: true, showStack: true, relativeTo: first.timestamp })),
      ].join("\n"), false);
    }
  });

program
  .command("projects")
  .description("List registered projects")
  .action(() => {
    const cfg = loadUserConfig();
    print(cfg.projects.length
      ? cfg.projects.map((p) => [
          `${p.name}  ${p.store.backend}  ${p.store.url ?? p.store.path ?? "(local)"}`,
          ...p.repos.map((r) => `  - ${r.name.padEnd(16)} ${r.remote}${r.localPath ? `  (${r.localPath})` : ""}`),
        ].join("\n")).join("\n")
      : "No projects registered.", false);
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
      checks.push(["repo registered", true, `repo ${w.repo.name} of project ${w.project.name} (${w.project.repos.length} repos registered here)`]);
      try {
        w.store.refresh();
        checks.push(["store reachable", true, `${w.store.kind}`]);
        checks.push(["store config", !!w.store.readConfig("codekit.yaml"), w.store.readConfig("codekit.yaml") ? "codekit.yaml found" : "codekit.yaml missing"]);
        const mapExists = w.store.hasBranch(w.branch);
        const lineage = mapExists ? readLineage(w.store, w.branch) : null;
        checks.push(["branch map", true, mapExists ? `${w.branch} (from ${lineage?.parent ?? "root"})` : `${w.branch} — will be created on first use`]);
        const guarded = prePushGuardInstalled(w.source);
        checks.push(["push guard (pre-push)", guarded, guarded ? "installed" : w.source.hooksPath() ? "core.hooksPath set; relying on PreToolUse/Cursor guards" : "missing — run `codekit init` again"]);
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
