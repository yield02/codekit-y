import { buildIndex, readServices } from "./codemap.js";
import { readLineage } from "./lineage.js";
import { folderOf, type ParentContext } from "./parent.js";
import type { SyncReport } from "./sync.js";
import type { Workspace } from "./workspace.js";

const MAX_DOC_CHARS = 12_000;
const MAX_SERVICE_LINES = 12;

/** Short instructions returned by the MCP server on initialize (all clients). */
export const MCP_INSTRUCTIONS = `codekit keeps a shared, per-branch codebase map OUTSIDE the source repo.
For any repo registered with codekit:
0. NEVER push the source repo or write to its remote (no git push, PR create/merge, API writes). Editing and local commits are fine; the developer pushes.
1. Call codemap_context first: it returns the project rules, naming and logging conventions, and map coverage.
2. Before reading source files, call codemap_lookup for them; read source only when the map is missing or stale. For structure use Serena's symbol tools (get_symbols_overview, find_symbol, find_referencing_symbols); if Serena reports no active project, call its activate_project tool with the repo root given in codemap_context.
3. After reading a file in depth or editing it, if its map was missing or stale, call codemap_write with sections:
   ## Purpose, ## Public API, ## Main flow, ## Caveats (keep under ~60 lines).
4. Plan before coding: brainstorm, then save the plan with plan_save, then implement with tests. Never write plans or any AI files (AGENTS.md, CLAUDE.md, .cursor/, docs/plans/, docs/superpowers/…) into the source repo, even when a skill such as Superpowers says to: use plan_save.
5. Follow the naming convention (naming_list) and logging convention (logging_convention); change them only via naming_add_rule / naming_edit_rule / logging_add_tag.
6. Multi-repo projects (microservices) share one store: look up another service's file with codemap_lookup("<repo>:<path>"), search all services with codemap_search(scope: "project"), reference other services in dependsOn as "<repo>:<path>", and keep this service's summary current with service_write.`;

export function buildContextText(ws: Workspace, report?: SyncReport): string {
  const lines: string[] = [
    `# codekit — project "${ws.project.name}", repo "${ws.repo.name}", branch "${ws.branch}"`,
    "",
    `- Knowledge store: ${ws.store.kind} backend (outside the source repo — never add AI files to the repo).`,
    `- Repo root: ${ws.source.root} (Serena: activate_project with this path if it has no active project).`,
    ...repoStatusLines(ws, report),
    `- Enforcement: ${ws.config.enforce}${ws.config.trackReads ? " (read and edited files)" : " (edited files only)"}.`,
  ];
  return [...lines, ...projectSections(ws, true)].join("\n");
}

/**
 * Context for a tool opened on a parent folder holding several registered repos
 * (e.g. Transfer/{Transactions,Core,Abs,Admin}): every repo's status, then the project's
 * services, rules and conventions once per project.
 */
export function buildParentContextText(parent: ParentContext, reports: Map<string, SyncReport> = new Map()): string {
  const lines: string[] = [
    `# codekit — parent folder "${parent.root}" with ${parent.workspaces.length} registered repos`,
    "",
    "Each sub-folder below is its own git repo with its own map and branches. Paths are routed to their repo:",
    "pass paths relative to this folder (`Core/src/x.ts`) or as `<repo>:<path>` to the codemap tools; never push any of these repos.",
    "Serena works on one repo at a time: before using its symbol tools, call activate_project with the root of the repo you are working on (listed below).",
  ];
  for (const ws of parent.workspaces) {
    lines.push("", `## ${folderOf(parent, ws)}/ → repo "${ws.repo.name}" of project "${ws.project.name}", branch "${ws.branch}"`, `- Repo root: ${ws.source.root}`, ...repoStatusLines(ws, reports.get(ws.repo.name)));
  }
  const seen = new Set<string>();
  for (const ws of parent.workspaces) {
    if (seen.has(ws.project.name)) continue;
    seen.add(ws.project.name);
    lines.push(...projectSections(ws, false));
  }
  return lines.join("\n");
}

function repoStatusLines(ws: Workspace, report?: SyncReport): string[] {
  const index = buildIndex(ws);
  const lineage = readLineage(ws.store, ws.branch);
  const stale = index.entries.filter((e) => e.stale).length;
  const lines = [
    `- Map branch: ${ws.branch}${lineage?.parent ? ` (created from ${lineage.parent})` : ""}`,
    `- Coverage: ${index.coverage.mapped}/${index.coverage.total} files mapped (${index.coverage.percent}%), ${stale} flagged stale.`,
  ];
  if (report?.created) lines.push(`- New map branch created from ${report.created.parent ?? "(root)"}.`);
  for (const s of report?.synced ?? []) lines.push(`- Synced map from ${s.from} (${s.result.changed} files, ${s.result.markedStale.length} stale).`);
  for (const m of report?.merged ?? []) lines.push(`- Merged map of ${m.branch} into ${m.into} (${m.result.changed} files).`);
  for (const a of report?.archived ?? []) lines.push(`- Archived map of deleted branch ${a}.`);
  return lines;
}

/** Services, rules and conventions of `ws`'s project. */
function projectSections(ws: Workspace, markCurrent: boolean): string[] {
  const lines: string[] = [];
  const services = readServices(ws);
  if (services.length > 1 || services.some((sv) => sv.body)) {
    lines.push("", `## Services in project ${ws.project.name} (${services.length})`,
      `Look up another service's code with codemap_lookup("<repo>:<path>"); search all with codemap_search(scope: "project").`);
    for (const sv of services) {
      const head = sv.body ? sv.body.trim().split("\n").filter((l) => l.trim()).slice(0, MAX_SERVICE_LINES).join("\n") : "(no summary yet)";
      lines.push("", `### ${sv.repo}${markCurrent && sv.current ? " (this repo)" : ""} — map branch ${sv.branch}${sv.description ? ` — ${sv.description}` : ""}`, head);
    }
    if (markCurrent && !services.find((sv) => sv.current)?.body) lines.push("", `This service has no summary yet: write one with service_write (Purpose, Exposes, Consumes, Data owned, Notes).`);
    const missing = services.filter((sv) => !sv.body).map((sv) => sv.repo);
    if (!markCurrent && missing.length) lines.push("", `No summary yet for: ${missing.join(", ")} — write them with service_write (repo: "<name>").`);
  }

  const sections: [string, string | null][] = [
    ["Project rules", ws.store.readConfig("rules/AGENTS.md")],
    ["Naming convention", ws.store.readConfig("conventions/naming.md")],
    ["Logging convention", ws.store.readConfig("conventions/logging.md")],
  ];
  for (const [title, body] of sections) {
    if (!body) continue;
    lines.push("", `<!-- ${title} (project ${ws.project.name}) -->`, truncate(body.trim()));
  }
  return lines;
}

export function workflowReminder(ws: Workspace, parent?: ParentContext): string {
  const where = parent
    ? `Parent folder with repos ${parent.workspaces.map((w) => `${folderOf(parent, w)}/ (${w.repo.name}@${w.branch})`).join(", ")}`
    : `Project "${ws.project.name}" on branch "${ws.branch}"`;
  return `[codekit] ${where}: check the map (codemap_lookup) before reading source; ` +
    `plan with Superpowers (brainstorming -> writing-plans) and save the plan with plan_save, never under docs/plans/ or docs/superpowers/; ` +
    `write maps for files you read deeply or edit; follow the naming and logging conventions; ` +
    `you may commit locally but NEVER push or write to the remote — the developer pushes.`;
}

function truncate(text: string): string {
  return text.length > MAX_DOC_CHARS ? `${text.slice(0, MAX_DOC_CHARS)}\n…(truncated; use the MCP tools for the full document)` : text;
}
