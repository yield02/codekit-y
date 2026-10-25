#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Command } from "commander";
import { buildIndex, lookup, search } from "../core/codemap.js";
import { handleCursorMcp, handleCursorShell, handlePreToolUse } from "../core/guard-hooks.js";
import { handlePostToolUse, handleSessionStart, handleStop, handleUserPromptSubmit, type HookPayload } from "../core/hooks.js";
import { detectPrMerges } from "../core/github.js";
import { formatLineageTree } from "../core/lineage.js";
import { withCorrelation } from "../core/logger.js";
import { formatReportMarkdown, projectReport } from "../core/report.js";
import { manualMerge, setParent, sync } from "../core/sync.js";
import { writeView } from "../core/view.js";
import type { Workspace } from "../core/workspace.js";
import { fail, print, readStdinJson, requireWorkspace, requireWorkspaces } from "./shared.js";

const program = new Command("codemap")
  .description("Per-branch codebase map stored outside the source repo")
  .option("-C, --repo <dir>", "source repository directory", process.cwd())
  .option("--json", "machine-readable output", false);

const ws = () => requireWorkspace(program.opts().repo as string);
/** One repo, or every registered repo of a parent folder (Transfer/{Core,Admin,…}). */
const workspaces = () => requireWorkspaces(program.opts().repo as string);
const json = () => program.opts().json as boolean;

program
  .command("status")
  .description("Coverage and missing/stale maps for the current branch (or the given files)")
  .argument("[paths...]", "files to check")
  .option("--all", "list every missing file", false)
  .action((paths: string[], opts: { all: boolean }) => {
    const results = workspaces().map((w) => {
      const targets = paths.length ? paths : w.source.listFiles();
      const entries = lookup(w, targets).filter((e) => e.status !== "excluded" && e.status !== "not-found");
      return { w, ok: entries.filter((e) => e.status === "ok"), missing: entries.filter((e) => e.status === "missing"), stale: entries.filter((e) => e.status === "stale") };
    });
    if (json()) return print(results.map(({ w, ok, missing, stale }) => ({ repo: w.repo.name, branch: w.branch, ok: ok.length, missing: missing.map((e) => e.path), stale: stale.map((e) => ({ path: e.path, reason: e.reason })) })), true);
    const lines: string[] = [];
    for (const { w, ok, missing, stale } of results) {
      lines.push(
        `${lines.length ? "\n" : ""}Project ${w.project.name} · repo ${w.repo.name} · branch ${w.branch} · ${w.store.kind} store`,
        `ok ${ok.length} · missing ${missing.length} · stale ${stale.length}`,
        ...stale.map((e) => `  stale    ${e.path} (${e.reason})`),
        ...(opts.all || paths.length ? missing : missing.slice(0, 15)).map((e) => `  missing  ${e.path}`),
      );
      if (!opts.all && !paths.length && missing.length > 15) lines.push(`  …${missing.length - 15} more (use --all)`);
    }
    print(lines.join("\n"), false);
  });

program
  .command("lookup")
  .description("Show the maps of the given files")
  .argument("<paths...>")
  .action((paths: string[]) => {
    const entries = lookup(ws(), paths);
    if (json()) return print(entries, true);
    for (const e of entries) {
      print(`=== ${e.path} [${e.status}${e.reason ? `: ${e.reason}` : ""}]`, false);
      if (e.map) print(e.map.body, false);
    }
  });

program
  .command("sync")
  .description("Detect new branches, syncs and merges (incl. squash PR merges on GitHub), and update maps")
  .option("--no-github", "skip the GitHub PR check")
  .action(async (opts: { github: boolean }) => {
    for (const w of workspaces()) await syncOne(w, opts.github);
  });

async function syncOne(w: Workspace, github: boolean): Promise<void> {
  const report = withCorrelation(undefined, () => sync(w));
  if (github) {
    const prs = await detectPrMerges(w, { force: true });
    for (const m of prs.merged) report.merged.push({ branch: m.branch, into: m.into, commit: `PR #${m.pr}`, result: m.result });
    if (prs.skipped && !json()) process.stderr.write(`github (${w.repo.name}): ${prs.skipped}\n`);
  }
  if (json()) return print({ repo: w.repo.name, ...report }, true);
  const lines = [`repo ${w.repo.name} · branch ${report.branch}`];
  if (report.created) lines.push(`created map from ${report.created.parent ?? "(root)"}`);
  for (const s of report.synced) lines.push(`synced from ${s.from}: ${s.result.changed} files, ${s.result.markedStale.length} stale`);
  for (const m of report.merged) lines.push(`merged ${m.branch} into ${m.into}: ${m.result.changed} files, ${m.result.markedStale.length} stale`);
  for (const a of report.archived) lines.push(`archived ${a}`);
  if (lines.length === 1) lines.push("up to date");
  print(lines.join("\n"), false);
}

program
  .command("index")
  .description("Rebuild the local index (~/.codekit/cache)")
  .action(() => {
    const index = buildIndex(ws());
    print(json() ? index : `${index.entries.length} maps · coverage ${index.coverage.mapped}/${index.coverage.total} (${index.coverage.percent}%)`, json());
  });

program
  .command("search")
  .argument("<query>")
  .description("Search maps by tag, path, dependency or text")
  .option("--project", "search every repo/service of the project", false)
  .action((query: string, opts: { project: boolean }) => {
    const hits = search(ws(), query, 20, opts.project ? "project" : "repo");
    print(json() ? hits : hits.map((h) => `${h.path}  [${h.tags.join(",")}]${h.stale ? " (stale)" : ""}`).join("\n") || "no matches", json());
  });

program
  .command("merge")
  .description("Merge a branch's map manually (squash merges, merges into a non-parent)")
  .argument("<from>", "source branch whose map is merged")
  .requiredOption("--into <branch>", "target branch")
  .option("--pr <number>", "pull request number", (v) => Number(v))
  .action((from: string, opts: { into: string; pr?: number }) => {
    const res = withCorrelation(undefined, () => manualMerge(ws(), from, opts.into, opts.pr));
    print(json() ? res : `merged ${from} into ${opts.into}: ${res.changed} files, ${res.resolvedConflicts.length} conflicts resolved, ${res.markedStale.length} stale`, json());
  });

program
  .command("report")
  .description("Coverage, missing and stale maps per branch, from committed source (for teams and CI)")
  .option("-b, --branch <name...>", "branches to report (default: all active map branches)")
  .option("--format <fmt>", "md | json", "md")
  .option("--out <file>", "write to a file instead of stdout")
  .action((opts: { branch?: string[]; format: string; out?: string }) => {
    const report = projectReport(ws(), opts.branch);
    const text = opts.format === "json" || json() ? JSON.stringify(report, null, 2) + "\n" : formatReportMarkdown(report);
    if (opts.out) writeFileSync(opts.out, text);
    else process.stdout.write(text);
  });

program
  .command("view")
  .description("Generate a static HTML viewer for the current branch's map (in ~/.codekit/cache)")
  .option("--open", "open it in the default browser", false)
  .option("--project", "all services (repos) of the project in one view", false)
  .action((opts: { open: boolean; project: boolean }) => {
    const file = writeView(ws(), opts.project ? "project" : "repo");
    print(file, false);
    if (opts.open) {
      const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : process.platform === "darwin" ? ["open", [file]] : ["xdg-open", [file]];
      spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" }).unref();
    }
  });

const lineage = program.command("lineage").description("Branch history: checkout origin, syncs, merges");
lineage
  .command("show", { isDefault: true })
  .argument("[branch]")
  .action((branch?: string) => {
    const w = ws();
    print(formatLineageTree(w.store, branch ?? w.branch), false);
  });
lineage
  .command("set-parent")
  .argument("<branch>")
  .argument("<parent>")
  .action((branch: string, parent: string) => {
    setParent(ws(), branch, parent);
    print(`parent of ${branch} set to ${parent}`, false);
  });

program
  .command("hook")
  .description("Claude Code hook entry point (reads the hook payload from stdin)")
  .argument("<event>", "session-start | prompt | pre-tool-use | track | stop | cursor-shell | cursor-mcp")
  .action(async (event: string) => {
    const payload = readStdinJson() as HookPayload;
    type Out = Record<string, unknown> | null;
    const handlers: Record<string, (p: HookPayload) => Out | Promise<Out>> = {
      "session-start": handleSessionStart,
      prompt: handleUserPromptSubmit,
      "pre-tool-use": handlePreToolUse,
      track: handlePostToolUse,
      stop: handleStop,
      "cursor-shell": handleCursorShell,
      "cursor-mcp": handleCursorMcp,
    };
    const handler = handlers[event];
    if (!handler) return; // unknown events are ignored so a newer plugin never breaks an older CLI
    const out = await handler(payload);
    if (out) process.stdout.write(JSON.stringify(out));
  });

program.parseAsync().catch(fail);
