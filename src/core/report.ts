import { artifactKind } from "./artifacts.js";
import { isTrackable } from "./codemap.js";
import { hashContent } from "./hash.js";
import { readLineage } from "./lineage.js";
import { parseMapFile, type MapFile } from "./mapfile.js";
import { sourcePathFromMap } from "./paths.js";
import type { Workspace } from "./workspace.js";

// Coverage of committed source (per branch ref), so the report is the same on a
// developer machine and in CI. Read-only on both the source repo and the store.

export interface BranchReport {
  branch: string;
  parent: string | null;
  sourceRef: string | null;
  total: number;
  mapped: number;
  percent: number;
  missing: string[];
  stale: { path: string; reason: string }[];
  /** AI files committed to the source branch (rules, plans, tool config…): the guard was bypassed or not installed. */
  artifacts: { path: string; kind: string }[];
  lastActivity?: string;
}

export interface ProjectReport {
  project: string;
  generatedAt: string;
  branches: BranchReport[];
}

export function readBranchMaps(ws: Workspace, branch: string): Map<string, MapFile> {
  const maps = new Map<string, MapFile>();
  for (const rel of ws.store.list(branch, "modules/")) {
    if (!sourcePathFromMap(rel)) continue;
    const text = ws.store.read(branch, rel);
    const parsed = text ? parseMapFile(text) : null;
    if (parsed) maps.set(parsed.meta.path, parsed);
  }
  return maps;
}

export function branchReport(ws: Workspace, branch: string): BranchReport {
  const lineage = readLineage(ws.store, branch);
  const ref = ws.source.resolveBranch(branch);
  const base: BranchReport = { branch, parent: lineage?.parent ?? null, sourceRef: ref, total: 0, mapped: 0, percent: 0, missing: [], stale: [], artifacts: [] };
  const lastEvent = lineage?.events.at(-1)?.at;
  if (lastEvent) base.lastActivity = lastEvent;
  if (!ref) return base;

  const all = ws.source.listFilesAt(ref);
  const rules = { extra: ws.config.guard.artifactPaths, allow: ws.config.guard.allowPaths };
  for (const path of all) {
    const kind = artifactKind(path, rules);
    if (kind) base.artifacts.push({ path, kind });
  }
  const files = all.filter((f) => isTrackable(ws, f));
  const contents = ws.source.catFiles(ref, files);
  const maps = readBranchMaps(ws, branch);
  for (const path of files) {
    const map = maps.get(path);
    const content = contents.get(path);
    if (!map) {
      base.missing.push(path);
      continue;
    }
    base.mapped++;
    if (map.meta.stale) base.stale.push({ path, reason: "flagged by merge" });
    else if (content !== undefined && map.meta.sourceHash !== hashContent(content)) base.stale.push({ path, reason: "source changed" });
    const updated = map.meta.updatedAt;
    if (updated && (!base.lastActivity || updated > base.lastActivity)) base.lastActivity = updated;
  }
  base.total = files.length;
  base.percent = files.length ? Math.round((base.mapped / files.length) * 100) : 0;
  return base;
}

export function projectReport(ws: Workspace, branches?: string[]): ProjectReport {
  const names = branches?.length
    ? branches
    : ws.store.listBranches().filter((b) => readLineage(ws.store, b)?.status !== "archived");
  const sorted = [...names].sort((a, b) => (a === ws.config.defaultBranch ? -1 : b === ws.config.defaultBranch ? 1 : a.localeCompare(b)));
  return { project: `${ws.project.name}/${ws.repo.name}`, generatedAt: new Date().toISOString(), branches: sorted.map((b) => branchReport(ws, b)) };
}

export function formatReportMarkdown(report: ProjectReport, detailLimit = 15): string {
  const lines = [
    `## codemap report — ${report.project}`,
    "",
    `Generated ${report.generatedAt.slice(0, 16).replace("T", " ")} UTC from committed source.`,
    "",
    "| Branch | From | Coverage | Missing | Stale | AI files | Last activity |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const b of report.branches) {
    const coverage = b.sourceRef ? `${b.mapped}/${b.total} (${b.percent}%)` : "branch not in source";
    lines.push(`| \`${b.branch}\` | ${b.parent ? `\`${b.parent}\`` : "—"} | ${coverage} | ${b.missing.length} | ${b.stale.length} | ${b.artifacts.length ? `⚠ ${b.artifacts.length}` : "0"} | ${b.lastActivity?.slice(0, 10) ?? "—"} |`);
  }
  for (const b of report.branches) {
    if (!b.stale.length && !b.missing.length && !b.artifacts.length) continue;
    lines.push("", `### \`${b.branch}\``);
    if (b.artifacts.length) {
      lines.push("", "AI files committed to the source repo (remove them; move plans/rules to the knowledge store):");
      for (const a of b.artifacts.slice(0, detailLimit)) lines.push(`- \`${a.path}\` (${a.kind})`);
      if (b.artifacts.length > detailLimit) lines.push(`- …${b.artifacts.length - detailLimit} more`);
    }
    if (b.stale.length) {
      lines.push("", "Stale:");
      for (const s of b.stale.slice(0, detailLimit)) lines.push(`- \`${s.path}\` (${s.reason})`);
      if (b.stale.length > detailLimit) lines.push(`- …${b.stale.length - detailLimit} more`);
    }
    if (b.missing.length) {
      lines.push("", "Missing:");
      for (const m of b.missing.slice(0, detailLimit)) lines.push(`- \`${m}\``);
      if (b.missing.length > detailLimit) lines.push(`- …${b.missing.length - detailLimit} more`);
    }
  }
  return lines.join("\n") + "\n";
}
