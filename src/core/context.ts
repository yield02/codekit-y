import { buildIndex } from "./codemap.js";
import { readLineage } from "./lineage.js";
import type { SyncReport } from "./sync.js";
import type { Workspace } from "./workspace.js";

const MAX_DOC_CHARS = 12_000;

/** Short instructions returned by the MCP server on initialize (all clients). */
export const MCP_INSTRUCTIONS = `codekit keeps a shared, per-branch codebase map OUTSIDE the source repo.
For any repo registered with codekit:
1. Call codemap_context first: it returns the project rules, naming and logging conventions, and map coverage.
2. Before reading source files, call codemap_lookup for them; read source only when the map is missing or stale.
3. After reading a file in depth or editing it, if its map was missing or stale, call codemap_write with sections:
   ## Purpose, ## Public API, ## Main flow, ## Caveats (keep under ~60 lines).
4. Plan before coding: brainstorm, then save the plan with plan_save (never write plans or any AI files into the source repo), then implement with tests.
5. Follow the naming convention (naming_list) and logging convention (logging_convention); change them only via naming_add_rule / naming_edit_rule / logging_add_tag.`;

export function buildContextText(ws: Workspace, report?: SyncReport): string {
  const index = buildIndex(ws);
  const lineage = readLineage(ws.store, ws.branch);
  const stale = index.entries.filter((e) => e.stale).length;
  const lines: string[] = [
    `# codekit — project "${ws.project.name}", branch "${ws.branch}"`,
    "",
    `- Knowledge store: ${ws.store.kind} backend (outside the source repo — never add AI files to the repo).`,
    `- Map branch: ${ws.branch}${lineage?.parent ? ` (created from ${lineage.parent})` : ""}`,
    `- Coverage: ${index.coverage.mapped}/${index.coverage.total} files mapped (${index.coverage.percent}%), ${stale} flagged stale.`,
    `- Enforcement: ${ws.config.enforce}${ws.config.trackReads ? " (read and edited files)" : " (edited files only)"}.`,
  ];
  if (report?.created) lines.push(`- New map branch created from ${report.created.parent ?? "(root)"}.`);
  for (const s of report?.synced ?? []) lines.push(`- Synced map from ${s.from} (${s.result.changed} files, ${s.result.markedStale.length} stale).`);
  for (const m of report?.merged ?? []) lines.push(`- Merged map of ${m.branch} into ${m.into} (${m.result.changed} files).`);
  for (const a of report?.archived ?? []) lines.push(`- Archived map of deleted branch ${a}.`);

  const sections: [string, string | null][] = [
    ["Project rules", ws.store.readConfig("rules/AGENTS.md")],
    ["Naming convention", ws.store.readConfig("conventions/naming.md")],
    ["Logging convention", ws.store.readConfig("conventions/logging.md")],
  ];
  for (const [title, body] of sections) {
    if (!body) continue;
    lines.push("", `<!-- ${title} -->`, truncate(body.trim()));
  }
  return lines.join("\n");
}

export function workflowReminder(ws: Workspace): string {
  return `[codekit] Project "${ws.project.name}" on branch "${ws.branch}": check the map (codemap_lookup) before reading source; ` +
    `plan with Superpowers (brainstorming -> writing-plans, save via plan_save) before non-trivial changes; ` +
    `write maps for files you read deeply or edit; follow the naming and logging conventions.`;
}

function truncate(text: string): string {
  return text.length > MAX_DOC_CHARS ? `${text.slice(0, MAX_DOC_CHARS)}\n…(truncated; use the MCP tools for the full document)` : text;
}
