import { parse, stringify } from "yaml";

export interface MapMeta {
  path: string;
  sourceHash: string;
  updatedAt: string;
  updatedBy: string;
  branch: string;
  dependsOn: string[];
  tags: string[];
  stale: boolean;
}

export interface MapFile {
  meta: MapMeta;
  body: string;
}

export const MAP_SECTIONS = ["## Purpose", "## Public API", "## Main flow", "## Caveats"] as const;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseMapFile(content: string): MapFile | null {
  const m = FRONTMATTER.exec(content);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = parse(m[1]!);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== "string") return null;
  return {
    meta: {
      path: r.path,
      sourceHash: String(r.sourceHash ?? ""),
      updatedAt: String(r.updatedAt ?? ""),
      updatedBy: String(r.updatedBy ?? ""),
      branch: String(r.branch ?? ""),
      dependsOn: toStringArray(r.dependsOn),
      tags: toStringArray(r.tags),
      stale: r.stale === true,
    },
    body: m[2]!.replace(/\r\n/g, "\n").trim(),
  };
}

export function serializeMapFile(file: MapFile): string {
  const meta: MapMeta = { ...file.meta };
  const yaml = stringify(meta, { lineWidth: 0, flowCollectionPadding: false }).trimEnd();
  return `---\n${yaml}\n---\n\n${file.body.replace(/\r\n/g, "\n").trim()}\n`;
}

/** Non-fatal quality checks reported back to the AI after a write. */
export function lintMapBody(body: string, maxLines: number): string[] {
  const warnings: string[] = [];
  const lines = body.split("\n").length;
  if (lines > maxLines) warnings.push(`Map body has ${lines} lines; keep it under ${maxLines}.`);
  for (const section of MAP_SECTIONS) {
    if (!body.includes(section)) warnings.push(`Missing section "${section}".`);
  }
  return warnings;
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
