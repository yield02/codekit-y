// Edits to the Markdown convention files in the store's config area.
// naming.md: one table per section, rows `| ID | Scope | Rule | Correct | Incorrect | enforcedBy |`
// logging.md: a `## Tag registry` table, rows `| Tag | Description |`

export interface NamingRule {
  id: string;
  section: string;
  scope: string;
  rule: string;
  correct: string;
  incorrect: string;
  enforcedBy: string;
}

const NAMING_HEADER = "| ID | Scope | Rule | Correct | Incorrect | enforcedBy |";
const NAMING_DIVIDER = "|---|---|---|---|---|---|";
const RULE_ROW = /^\|\s*(NC-\d+)\s*\|/;

export function parseNamingRules(md: string): NamingRule[] {
  const rules: NamingRule[] = [];
  let section = "";
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) section = heading[1]!;
    if (!RULE_ROW.test(line)) continue;
    const cells = splitRow(line);
    rules.push({
      id: cells[0] ?? "",
      section,
      scope: cells[1] ?? "",
      rule: cells[2] ?? "",
      correct: cells[3] ?? "",
      incorrect: cells[4] ?? "",
      enforcedBy: cells[5] ?? "",
    });
  }
  return rules;
}

export type NewNamingRule = Omit<NamingRule, "id">;

export function addNamingRule(md: string, input: NewNamingRule): { md: string; rule: NamingRule } {
  const rules = parseNamingRules(md);
  const duplicate = rules.find((r) => normalize(r.rule) === normalize(input.rule) && normalize(r.scope) === normalize(input.scope));
  if (duplicate) throw new Error(`Rule already exists as ${duplicate.id}: ${duplicate.rule}`);
  const next = rules.reduce((max, r) => Math.max(max, Number(r.id.slice(3)) || 0), 0) + 1;
  const rule: NamingRule = { ...input, id: `NC-${String(next).padStart(3, "0")}` };
  const row = toRow(rule);

  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const sectionIdx = lines.findIndex((l) => new RegExp(`^##\\s+${escapeRe(input.section)}\\s*$`, "i").test(l));
  if (sectionIdx === -1) {
    const trimmed = md.replace(/\s+$/, "");
    return { md: `${trimmed}\n\n## ${input.section}\n\n${NAMING_HEADER}\n${NAMING_DIVIDER}\n${row}\n`, rule };
  }
  // Insert after the last table row of the section (or create the table).
  let end = sectionIdx + 1;
  while (end < lines.length && !/^##\s/.test(lines[end]!)) end++;
  let lastRow = -1;
  for (let i = sectionIdx + 1; i < end; i++) if (lines[i]!.startsWith("|")) lastRow = i;
  if (lastRow === -1) lines.splice(sectionIdx + 1, 0, "", NAMING_HEADER, NAMING_DIVIDER, row);
  else lines.splice(lastRow + 1, 0, row);
  return { md: lines.join("\n"), rule };
}

export function editNamingRule(md: string, id: string, patch: Partial<NewNamingRule>): { md: string; rule: NamingRule } {
  const existing = parseNamingRules(md).find((r) => r.id === id);
  if (!existing) throw new Error(`Rule ${id} not found`);
  const { section: _ignored, ...rest } = patch;
  const rule: NamingRule = { ...existing, ...rest, id };
  const lines = md.replace(/\r\n/g, "\n").split("\n").map((l) => (RULE_ROW.exec(l)?.[1] === id ? toRow(rule) : l));
  return { md: lines.join("\n"), rule };
}

export interface LogTag {
  tag: string;
  description: string;
}

export function parseLogTags(md: string): LogTag[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^##\s+Tag registry/i.test(l));
  if (start === -1) return [];
  const tags: LogTag[] = [];
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]!); i++) {
    const line = lines[i]!;
    if (!line.startsWith("|") || /^\|\s*-/.test(line) || /^\|\s*Tag\s*\|/i.test(line)) continue;
    const [tag, description] = splitRow(line);
    if (tag) tags.push({ tag: tag.replace(/`/g, ""), description: description ?? "" });
  }
  return tags;
}

export function addLogTag(md: string, tag: string, description: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) throw new Error(`Tag "${tag}" must be kebab-case (a-z, 0-9, -)`);
  if (parseLogTags(md).some((t) => t.tag === tag)) throw new Error(`Tag "${tag}" is already registered`);
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^##\s+Tag registry/i.test(l));
  const row = `| \`${tag}\` | ${escapeCell(description)} |`;
  if (start === -1) return `${md.replace(/\s+$/, "")}\n\n## Tag registry\n\n| Tag | Description |\n|---|---|\n${row}\n`;
  let lastRow = start;
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]!); i++) if (lines[i]!.startsWith("|")) lastRow = i;
  lines.splice(lastRow + 1, 0, row);
  return lines.join("\n");
}

function toRow(r: NamingRule): string {
  return `| ${r.id} | ${escapeCell(r.scope)} | ${escapeCell(r.rule)} | ${escapeCell(r.correct)} | ${escapeCell(r.incorrect)} | ${escapeCell(r.enforcedBy || "AI review")} |`;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

function escapeCell(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalize(v: string): string {
  return v.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface ProjectLogger {
  library: string;
  entryPoint: string;
  notes: string;
}

const PROJECT_LOGGER_KEYS = ["library", "entryPoint", "notes"] as const;

/** The `## Project logger` key/value table in logging.md. */
export function parseProjectLogger(md: string): ProjectLogger | null {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^##\s+Project logger/i.test(l));
  if (start === -1) return null;
  const out: Record<string, string> = {};
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]!); i++) {
    const [key, value] = splitRow(lines[i]!);
    if (key && (PROJECT_LOGGER_KEYS as readonly string[]).includes(key)) out[key] = value ?? "";
  }
  const set = (v: string | undefined) => (v && v !== "(not set)" ? v : "");
  const result = { library: set(out.library), entryPoint: set(out.entryPoint), notes: set(out.notes) };
  return result.library || result.entryPoint || result.notes ? result : null;
}

export function setProjectLogger(md: string, value: Partial<ProjectLogger>): string {
  const current = parseProjectLogger(md) ?? { library: "", entryPoint: "", notes: "" };
  const next: ProjectLogger = { ...current, ...Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) };
  const table = [
    "| Key | Value |",
    "|---|---|",
    ...PROJECT_LOGGER_KEYS.map((k) => `| ${k} | ${escapeCell(next[k] || "(not set)")} |`),
  ];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^##\s+Project logger/i.test(l));
  if (start === -1) {
    const tagIdx = lines.findIndex((l) => /^##\s+Tag registry/i.test(l));
    const block = ["## Project logger", "", ...table, ""];
    if (tagIdx === -1) return `${md.replace(/\s+$/, "")}\n\n${block.join("\n")}`;
    lines.splice(tagIdx, 0, ...block);
    return lines.join("\n");
  }
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end]!)) end++;
  const firstRow = lines.findIndex((l, i) => i > start && i < end && l.startsWith("|"));
  let lastRow = firstRow;
  while (lastRow + 1 < end && lines[lastRow + 1]!.startsWith("|")) lastRow++;
  if (firstRow === -1) lines.splice(end, 0, ...table, "");
  else lines.splice(firstRow, lastRow - firstRow + 1, ...table);
  return lines.join("\n");
}
