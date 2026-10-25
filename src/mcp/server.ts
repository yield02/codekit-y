import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listPlans, lookup, readPlan, readServices, savePlan, search, writeMap, writeService } from "../core/codemap.js";
import { MCP_INSTRUCTIONS, buildContextText, buildParentContextText } from "../core/context.js";
import { folderOf, resolveRoots, workspaceByRepo, workspaceForPath, type ParentContext } from "../core/parent.js";
import { addLogTag, addNamingRule, editNamingRule, parseLogTags, parseNamingRules, parseProjectLogger, setProjectLogger } from "../core/conventions.js";
import { detectLogging, formatDetection } from "../core/logging-detect.js";
import { createLogger, withCorrelation } from "../core/logger.js";
import { detectPrMerges } from "../core/github.js";
import { packageRoot } from "../core/paths.js";
import { ensureBranch, sync } from "../core/sync.js";
import type { Workspace } from "../core/workspace.js";

export const VERSION = "0.1.0";
const log = createLogger("codemap-mcp");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const repoPath = z.string().optional().describe("Absolute path of the source repo (or of a parent folder holding several repos). Optional; defaults to the client's workspace roots.");
const repoArg = z.string().optional().describe("Repo of the project to act on (e.g. core). Needed when the workspace is a parent folder holding several repos and the tool has no path to infer it from.");

interface ToolOptions {
  /** In a parent folder with several repos the caller must say which repo (no path to infer it from). */
  needsRepo?: boolean;
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "codemap", version: VERSION }, { instructions: MCP_INSTRUCTIONS });
  const synced = new Set<string>();

  /** Roots: explicit repoPath > CODEKIT_REPO > all client roots (multi-root workspaces) > process cwd. */
  async function rootsFor(explicit?: string): Promise<string[]> {
    if (explicit) return [explicit];
    if (process.env.CODEKIT_REPO) return [process.env.CODEKIT_REPO];
    try {
      const { roots } = await server.server.listRoots();
      const dirs = roots.map((r) => r.uri).filter((u) => u.startsWith("file:")).map((u) => fileURLToPath(u));
      if (dirs.length) return dirs;
    } catch {
      // client does not support roots
    }
    return [process.cwd()];
  }

  async function prepare(ws: Workspace): Promise<Workspace> {
    const key = `${ws.project.name}:${ws.repo.name}:${ws.branch}`;
    if (!synced.has(key)) {
      sync(ws);
      synced.add(key);
      await detectPrMerges(ws).catch((err) => log.warn(["mcp", "github"], "PR merge detection failed", { error: String(err), repo: ws.repo.name }));
    } else {
      ensureBranch(ws);
    }
    return ws;
  }

  /**
   * The repo a call acts on. In a parent folder (Transfer/{Core,Admin,…}) it is taken from
   * `repo`, then from the `path` argument, then defaults to the first repo for project-level tools.
   */
  async function target(args: Record<string, unknown>, opts: ToolOptions): Promise<{ ws: Workspace; parent?: ParentContext }> {
    const res = resolveRoots(await rootsFor(args.repoPath as string | undefined), "mcp");
    if (res.kind === "none") {
      throw new Error(/not-registered/.test(res.reason)
        ? `This repo is not registered with codekit (${res.reason}); codemap tools do not apply. Run \`codekit init\` to register it.`
        : `codekit could not resolve a repo: ${res.reason}. Pass repoPath.`);
    }
    if (res.kind === "repo") return { ws: await prepare(res.ws) };
    const parent = res.parent;
    const names = parent.workspaces.map((w) => w.repo.name).join(", ");
    let ws: Workspace | undefined;
    if (typeof args.repo === "string") {
      ws = workspaceByRepo(parent, args.repo);
      if (!ws) throw new Error(`No repo "${args.repo}" in this folder. Repos: ${names}.`);
    } else if (typeof args.path === "string") {
      ws = workspaceForPath(parent, args.path)?.ws;
      if (!ws) throw new Error(`${args.path} is not inside any registered repo of this folder (${names}). Use a path like ${folderOf(parent, parent.workspaces[0]!)}/src/... or <repo>:<path>.`);
    } else if (opts.needsRepo && parent.workspaces.length > 1) {
      throw new Error(`This folder holds several repos; pass repo: one of ${names}.`);
    }
    for (const w of parent.workspaces) await prepare(w);
    return { ws: ws ?? parent.workspaces[0]!, parent };
  }

  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    handler: (args: z.objectOutputType<S, z.ZodTypeAny>, ws: Workspace, parent?: ParentContext) => string | Promise<string>,
    opts: ToolOptions = {},
  ): void {
    const fullShape = { ...shape, repoPath, repo: repoArg };
    server.registerTool(name, { description, inputSchema: fullShape }, (async (args: Record<string, unknown>): Promise<ToolResult> =>
      withCorrelation(undefined, async () => {
        const started = Date.now();
        try {
          const { ws, parent } = await target(args, opts);
          const text = await handler(args as z.objectOutputType<S, z.ZodTypeAny>, ws, parent);
          log.info(["mcp", name], "Tool call", { branch: ws.branch, durationMs: Date.now() - started });
          return { content: [{ type: "text", text }] };
        } catch (err) {
          log.error(["mcp", name], "Tool call failed", err, { durationMs: Date.now() - started });
          return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      })) as never);
  }

  tool("codemap_context", "Project rules, naming/logging conventions, branch lineage and map coverage. Call once at the start of a session.", {}, (_args, ws, parent) =>
    parent ? buildParentContextText(parent) : buildContextText(ws));

  tool(
    "codemap_lookup",
    "Maps for the given source files with status ok | missing | stale | excluded | not-found | remote. Read source only when missing or stale. Files of another service of the project: \"<repo>:<path>\" (e.g. \"core:src/api/user.ts\").",
    { paths: z.array(z.string()).min(1).describe("Source file paths, repo-relative or absolute, or <repo>:<path> for another repo of the project") },
    (args, ws, parent) => {
      const entries = parent
        ? args.paths.flatMap((p) => {
            const owner = workspaceForPath(parent, p);
            if (owner) return lookup(owner.ws, [owner.path]).map((e) => ({ ...e, path: `${owner.ws.repo.name}:${e.path}` }));
            if (/^[A-Za-z0-9._-]{2,}:/.test(p)) return lookup(ws, [p]); // a service not cloned in this folder
            return [{ path: p, status: "not-found" as const, reason: `not inside any registered repo of ${parent.root}` }];
          })
        : lookup(ws, args.paths);
      return entries
        .map((e) => [`=== ${e.path} [${e.status}${e.reason ? `: ${e.reason}` : ""}]`, e.map ? formatMeta(e.map.meta) + "\n" + e.map.body : ""].filter(Boolean).join("\n"))
        .join("\n\n");
    },
  );

  tool(
    "codemap_write",
    "Write or replace the map of one source file. Body sections: ## Purpose, ## Public API, ## Main flow, ## Caveats (under ~60 lines). Do not include frontmatter.",
    {
      path: z.string().describe("Source file path"),
      body: z.string().min(1).describe("Markdown body of the map"),
      dependsOn: z.array(z.string()).optional().describe("Project files this file depends on"),
      tags: z.array(z.string()).optional().describe("Domain tags, e.g. auth, payment"),
    },
    (args, ws, parent) => {
      // In a parent folder, `path` is relative to it (Core/src/x.ts) or <repo>:<path>; `ws` is already its repo.
      // With an explicit `repo`, a path that does not resolve from the parent is repo-relative.
      const owner = parent ? workspaceForPath(parent, args.path) : null;
      const path = owner && owner.ws.repo.name === ws.repo.name ? owner.path : args.path;
      const res = writeMap(ws, { path, body: args.body, dependsOn: args.dependsOn, tags: args.tags });
      return `Saved ${res.mapPath} for repo ${ws.repo.name} on branch ${ws.branch} (sourceHash ${res.sourceHash}).${res.warnings.length ? `\nWarnings:\n- ${res.warnings.join("\n- ")}` : ""}`;
    },
  );

  tool("codemap_search", "Search maps by tag, path, dependency or text. scope \"project\" searches every repo/service of the project (results as <repo>:<path>).", {
    query: z.string().min(1),
    limit: z.number().int().positive().max(100).optional(),
    scope: z.enum(["repo", "project"]).optional(),
  }, (args, ws, parent) => {
    const hits = search(ws, args.query, args.limit ?? 20, args.scope ?? (parent ? "project" : "repo"));
    return hits.length ? hits.map((h) => `${h.path}  [${h.tags.join(",")}]${h.stale ? " (stale)" : ""}  deps: ${h.dependsOn.join(", ") || "-"}`).join("\n") : "No matching maps.";
  });

  tool(
    "service_write",
    "Write this repo's service summary (shown to every agent working on any repo of the project). Sections: ## Purpose, ## Exposes (HTTP endpoints, events, packages), ## Consumes (other services/APIs/events, as <repo>:<path> when known), ## Data owned, ## Notes. Keep it under ~40 lines.",
    { body: z.string().min(1) },
    (args, ws) => {
      const res = writeService(ws, args.body);
      return `Saved service summary of ${ws.repo.name} on branch ${ws.branch}.${res.warnings.length ? `\nWarnings:\n- ${res.warnings.join("\n- ")}` : ""}`;
    },
    { needsRepo: true },
  );

  tool("service_list", "Summaries of every service (repo) of the project, to understand how they fit together.", {}, (_args, ws) =>
    readServices(ws).map((sv) => `=== ${sv.repo}${sv.current ? " (this repo)" : ""} @ ${sv.branch}${sv.description ? ` — ${sv.description}` : ""}\n${sv.body?.trim() ?? "(no summary yet)"}`).join("\n\n"));

  tool("plan_save", "Save a plan (e.g. from Superpowers writing-plans) for the current branch in the knowledge store. Never write plans into the source repo.", {
    name: z.string().min(1).describe("Short plan name; the date prefix is added automatically"),
    content: z.string().min(1).describe("Full Markdown plan"),
  }, (args, ws) => `Saved ${savePlan(ws, args.name, args.content)} for repo ${ws.repo.name} on branch ${ws.branch}.`, { needsRepo: true });

  tool("plan_list", "List plans saved for the current branch, or read one when `name` is given.", { name: z.string().optional() }, (args, ws) => {
    if (args.name) return readPlan(ws, args.name) ?? `Plan not found: ${args.name}`;
    const plans = listPlans(ws);
    return plans.length ? plans.join("\n") : "No plans saved on this branch.";
  }, { needsRepo: true });

  tool("naming_list", "The project's naming convention rules.", { section: z.string().optional().describe("Filter by section, e.g. Java / Spring") }, (args, ws) => {
    const md = ws.store.readConfig("conventions/naming.md") ?? "";
    if (!args.section) return md || "No naming convention defined.";
    const rules = parseNamingRules(md).filter((r) => r.section.toLowerCase().includes(args.section!.toLowerCase()));
    return rules.map((r) => `${r.id} [${r.scope}] ${r.rule} — ok: ${r.correct} · not: ${r.incorrect} · ${r.enforcedBy}`).join("\n") || "No rules in that section.";
  });

  const ruleShape = {
    section: z.string().describe("Section heading, e.g. General, Node / TypeScript, Java / Spring, .NET, Python"),
    scope: z.string(),
    rule: z.string(),
    correct: z.string(),
    incorrect: z.string(),
    enforcedBy: z.string().optional(),
  };

  tool("naming_add_rule", "Add a naming rule (only when the user asks). Returns the new rule ID.", ruleShape, (args, ws) => {
    const md = ws.store.readConfig("conventions/naming.md") ?? "# Naming convention\n";
    const { md: next, rule } = addNamingRule(md, { ...args, enforcedBy: args.enforcedBy ?? "AI review" });
    ws.store.writeConfig("conventions/naming.md", next, `naming: add ${rule.id}`);
    return `Added ${rule.id}: ${rule.rule}`;
  });

  tool("naming_edit_rule", "Edit an existing naming rule by ID (only when the user asks).", {
    id: z.string().regex(/^NC-\d+$/),
    scope: z.string().optional(),
    rule: z.string().optional(),
    correct: z.string().optional(),
    incorrect: z.string().optional(),
    enforcedBy: z.string().optional(),
  }, (args, ws) => {
    const md = ws.store.readConfig("conventions/naming.md") ?? "";
    const { id, ...patch } = args;
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const { md: next, rule } = editNamingRule(md, id, clean);
    ws.store.writeConfig("conventions/naming.md", next, `naming: edit ${rule.id}`);
    return `Updated ${rule.id}: ${rule.rule}`;
  });

  tool("logging_convention", "The project's logging standard (required fields, correlationId rules, tag registry).", {}, (_args, ws) =>
    ws.store.readConfig("conventions/logging.md") ?? "No logging convention defined.");

  tool(
    "logging_detect",
    "Scan the source repo (read-only) for its existing logging: libraries, the project's own logger code, raw print/console calls. Call this BEFORE adding or changing logging; it returns the adoption strategy.",
    {},
    (_args, ws) => formatDetection(detectLogging(ws)),
    { needsRepo: true },
  );

  tool(
    "logging_sample",
    "Reference implementation of the logging convention for a stack, plus the adoption guide when the project already uses a library or its own logger. Adapt names to the project's naming convention; never add a second logger.",
    {
      stack: z.enum(["node", "java", "dotnet", "python"]),
      library: z.string().optional().describe("Existing library (e.g. log4j2, nlog, microsoft-logging, winston, bunyan, loguru, structlog) or 'in-house' for the project's own logger"),
    },
    (args) => readSample(args.stack, args.library),
  );

  tool(
    "logging_set_project",
    "Record the project's logging entry point in the logging convention (after adopting it), so every agent uses the same logger.",
    {
      library: z.string().optional(),
      entryPoint: z.string().optional().describe("Module/class developers call, e.g. src/common/logger.ts"),
      notes: z.string().optional(),
    },
    (args, ws) => {
      const md = ws.store.readConfig("conventions/logging.md") ?? "# Logging convention\n";
      const next = setProjectLogger(md, args);
      ws.store.writeConfig("conventions/logging.md", next, "logging: set project logger");
      const p = parseProjectLogger(next);
      return `Project logger: library=${p?.library || "-"}, entryPoint=${p?.entryPoint || "-"}, notes=${p?.notes || "-"}`;
    },
  );

  tool("logging_add_tag", "Register a new log tag (kebab-case) in the tag registry.", { tag: z.string(), description: z.string().min(1) }, (args, ws) => {
    const md = ws.store.readConfig("conventions/logging.md") ?? "# Logging convention\n";
    ws.store.writeConfig("conventions/logging.md", addLogTag(md, args.tag, args.description), `logging: add tag ${args.tag}`);
    return `Registered tag \`${args.tag}\`. Current tags: ${parseLogTags(addLogTag(md, args.tag, args.description)).map((t) => t.tag).join(", ")}`;
  });

  return server;
}

/**
 * All text files of `logging/<stack>/`, concatenated with path headers, preceded by the
 * adoption guide when the project already has a library or its own logger.
 */
export function readSample(stack: string, library?: string): string {
  const root = join(packageRoot(), "logging", stack);
  if (!existsSync(root)) return `No sample for ${stack} in this kit build.`;
  const adapters = join(packageRoot(), "logging", "adapters");
  const lib = library?.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const inHouse = join(adapters, "in-house.md");
  const guideFile = !lib ? null : ["in-house", "inhouse", "custom"].includes(lib) ? "in-house.md" : `${stack}-${lib}.md`;
  let guide = "";
  if (guideFile && existsSync(join(adapters, guideFile))) {
    guide = `=== logging/adapters/${guideFile}\n${readFileSync(join(adapters, guideFile), "utf8")}`;
  } else if (guideFile) {
    guide = `(No dedicated guide for "${library}" on ${stack}: treat it like the project's own logger.)\n` +
      (existsSync(inHouse) ? `=== logging/adapters/in-house.md\n${readFileSync(inHouse, "utf8")}` : "");
  }
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!["node_modules", "__pycache__", "bin", "obj", "target"].includes(e.name)) walk(child); }
      else files.push(child);
    }
  };
  walk("");
  const sample = files.sort((a, b) => (a === "README.md" ? -1 : b === "README.md" ? 1 : a.localeCompare(b)))
    .map((f) => `=== logging/${stack}/${f}\n${readFileSync(join(root, f), "utf8")}`)
    .join("\n\n");
  // The guide comes first: it says which parts of the sample to reuse.
  return guide ? `${guide}\n\n${sample}` : sample;
}

function formatMeta(meta: { sourceHash: string; updatedAt: string; updatedBy: string; dependsOn: string[]; tags: string[] }): string {
  return `(updated ${meta.updatedAt} by ${meta.updatedBy}; tags: ${meta.tags.join(", ") || "-"}; dependsOn: ${meta.dependsOn.join(", ") || "-"})`;
}
