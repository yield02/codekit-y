#!/usr/bin/env node
import { Command } from "commander";
import { buildIndex, lookup, search } from "../core/codemap.js";
import { handlePostToolUse, handleSessionStart, handleStop, handleUserPromptSubmit, type HookPayload } from "../core/hooks.js";
import { formatLineageTree } from "../core/lineage.js";
import { withCorrelation } from "../core/logger.js";
import { manualMerge, setParent, sync } from "../core/sync.js";
import { fail, print, readStdinJson, requireWorkspace } from "./shared.js";

const program = new Command("codemap")
  .description("Per-branch codebase map stored outside the source repo")
  .option("-C, --repo <dir>", "source repository directory", process.cwd())
  .option("--json", "machine-readable output", false);

const ws = () => requireWorkspace(program.opts().repo as string);
const json = () => program.opts().json as boolean;

program
  .command("status")
  .description("Coverage and missing/stale maps for the current branch (or the given files)")
  .argument("[paths...]", "files to check")
  .option("--all", "list every missing file", false)
  .action((paths: string[], opts: { all: boolean }) => {
    const w = ws();
    const targets = paths.length ? paths : w.source.listFiles();
    const entries = lookup(w, targets).filter((e) => e.status !== "excluded");
    const missing = entries.filter((e) => e.status === "missing");
    const stale = entries.filter((e) => e.status === "stale");
    const ok = entries.filter((e) => e.status === "ok");
    if (json()) return print({ branch: w.branch, ok: ok.length, missing: missing.map((e) => e.path), stale: stale.map((e) => ({ path: e.path, reason: e.reason })) }, true);
    const lines = [
      `Project ${w.project.name} · branch ${w.branch} · ${w.store.kind} store`,
      `ok ${ok.length} · missing ${missing.length} · stale ${stale.length}`,
      ...stale.map((e) => `  stale    ${e.path} (${e.reason})`),
      ...(opts.all || paths.length ? missing : missing.slice(0, 15)).map((e) => `  missing  ${e.path}`),
    ];
    if (!opts.all && !paths.length && missing.length > 15) lines.push(`  …${missing.length - 15} more (use --all)`);
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
  .description("Detect new branches, syncs and merges, and update maps accordingly")
  .action(() => {
    const report = withCorrelation(undefined, () => sync(ws()));
    if (json()) return print(report, true);
    const lines = [`branch ${report.branch}`];
    if (report.created) lines.push(`created map from ${report.created.parent ?? "(root)"}`);
    for (const s of report.synced) lines.push(`synced from ${s.from}: ${s.result.changed} files, ${s.result.markedStale.length} stale`);
    for (const m of report.merged) lines.push(`merged ${m.branch} into ${m.into}: ${m.result.changed} files, ${m.result.markedStale.length} stale`);
    for (const a of report.archived) lines.push(`archived ${a}`);
    if (lines.length === 1) lines.push("up to date");
    print(lines.join("\n"), false);
  });

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
  .action((query: string) => {
    const hits = search(ws(), query);
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
  .argument("<event>", "session-start | prompt | track | stop")
  .action((event: string) => {
    const payload = readStdinJson() as HookPayload;
    const handlers: Record<string, (p: HookPayload) => Record<string, unknown> | null> = {
      "session-start": handleSessionStart,
      prompt: handleUserPromptSubmit,
      track: handlePostToolUse,
      stop: handleStop,
    };
    const handler = handlers[event];
    if (!handler) return; // unknown events are ignored so a newer plugin never breaks an older CLI
    const out = handler(payload);
    if (out) process.stdout.write(JSON.stringify(out));
  });

program.parseAsync().catch(fail);
