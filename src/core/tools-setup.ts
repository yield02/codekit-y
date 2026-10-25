import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MCP_INSTRUCTIONS } from "./context.js";
import { packageRoot } from "./paths.js";

// User-level configuration for Cursor and VS Code (Copilot). Nothing is ever written
// into a source repo. Existing files are merged, backed up, and left alone if unparsable.

export interface ToolDirs {
  cursorDir: string;
  vscodeUserDir: string;
}

export function defaultToolDirs(): ToolDirs {
  const home = homedir();
  const vscode =
    process.env.CODEKIT_VSCODE_USER_DIR ??
    (process.platform === "win32"
      ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Code", "User")
      : process.platform === "darwin"
        ? join(home, "Library", "Application Support", "Code", "User")
        : join(home, ".config", "Code", "User"));
  return { cursorDir: process.env.CODEKIT_CURSOR_DIR ?? join(home, ".cursor"), vscodeUserDir: vscode };
}

export interface PlannedChange {
  file: string;
  action: "create" | "update" | "unchanged" | "skipped";
  detail: string;
  content?: string;
}

function kitPath(...parts: string[]): string {
  return join(packageRoot(), ...parts).replace(/\\/g, "/");
}

function mcpServer() {
  return { command: "node", args: [kitPath("dist", "mcp", "main.js")] };
}

function hookCommand(event: string): string {
  return `node "${kitPath("dist", "cli", "codemap.js")}" hook ${event}`;
}

/** JSON with comments / trailing commas (VS Code style). Returns null when it cannot be parsed safely. */
export function parseJsonc(text: string): Record<string, unknown> | null {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // fall through to the tolerant parser
  }
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  try {
    return JSON.parse(out.replace(/,\s*([}\]])/g, "$1")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function planJsonMerge(file: string, merge: (current: Record<string, unknown>) => Record<string, unknown>, label: string): PlannedChange {
  const exists = existsSync(file);
  const text = exists ? readFileSync(file, "utf8") : "";
  const current = parseJsonc(text);
  if (current === null) return { file, action: "skipped", detail: `${label}: could not parse existing file; add the snippet manually.` };
  const hadComments = exists && /\/\/|\/\*/.test(text) && (() => { try { JSON.parse(text); return false; } catch { return true; } })();
  if (hadComments) return { file, action: "skipped", detail: `${label}: file has comments; merge the snippet manually to keep them.`, content: JSON.stringify(merge({}), null, 2) };
  const next = merge(structuredClone(current));
  const content = JSON.stringify(next, null, 2) + "\n";
  if (exists && JSON.stringify(current) === JSON.stringify(next)) return { file, action: "unchanged", detail: `${label}: already configured.` };
  return { file, action: exists ? "update" : "create", detail: label, content };
}

export function planCursor(dirs: ToolDirs): PlannedChange[] {
  const mcp = planJsonMerge(join(dirs.cursorDir, "mcp.json"), (cur) => {
    const servers = (cur.mcpServers as Record<string, unknown>) ?? {};
    return { ...cur, mcpServers: { ...servers, codemap: mcpServer() } };
  }, "Cursor MCP server (codemap)");

  const hooks = planJsonMerge(join(dirs.cursorDir, "hooks.json"), (cur) => {
    const all = (cur.hooks as Record<string, { command: string }[]>) ?? {};
    const add = (event: string, command: string) => {
      const list = (all[event] ?? []).filter((h) => !String(h.command).includes("codemap.js\" hook cursor-"));
      return [...list, { command }];
    };
    return {
      ...cur,
      version: cur.version ?? 1,
      hooks: { ...all, beforeShellExecution: add("beforeShellExecution", hookCommand("cursor-shell")), beforeMCPExecution: add("beforeMCPExecution", hookCommand("cursor-mcp")) },
    };
  }, "Cursor hooks (push guard)");
  return [mcp, hooks];
}

export function planVsCode(dirs: ToolDirs): PlannedChange[] {
  const mcp = planJsonMerge(join(dirs.vscodeUserDir, "mcp.json"), (cur) => {
    const servers = (cur.servers as Record<string, unknown>) ?? {};
    return { ...cur, servers: { ...servers, codemap: { type: "stdio", ...mcpServer() } } };
  }, "VS Code MCP server (codemap)");

  const instructionsFile = join(dirs.vscodeUserDir, "prompts", "codekit.instructions.md");
  const instructions = `---\napplyTo: "**"\ndescription: codekit rules for registered repos\n---\n\n${USER_RULES}\n`;
  const existing = existsSync(instructionsFile) ? readFileSync(instructionsFile, "utf8") : null;
  const instr: PlannedChange = {
    file: instructionsFile,
    action: existing === instructions ? "unchanged" : existing ? "update" : "create",
    detail: "Copilot user instructions",
    content: instructions,
  };
  return [mcp, instr];
}

/** Text for Cursor User Rules (Settings → Rules) and Copilot user instructions. */
export const USER_RULES = `For repositories registered with codekit (the codemap MCP server answers for them):
- Call the codemap tool codemap_context at the start of a task and follow the rules it returns.
- Check codemap_lookup before reading source files; write maps with codemap_write for files you read deeply or edit.
- Save plans with plan_save; never create AI files (AGENTS.md, rules, plans, notes) inside the source repository.
- You may edit and commit locally, but NEVER push or write to the remote (no git push, PR create/merge, API writes). The developer pushes.

${MCP_INSTRUCTIONS}`;

/** VS Code settings.json snippet: terminal commands that must never be auto-approved. */
export const VSCODE_SETTINGS_SNIPPET = {
  "chat.tools.terminal.autoApprove": {
    "/^git\\b.*\\bpush\\b/": false,
    "/^gh\\s+(pr|repo|release|workflow|api)\\b/": false,
  },
};

export function applyChanges(changes: PlannedChange[]): string[] {
  const done: string[] = [];
  for (const c of changes) {
    if ((c.action !== "create" && c.action !== "update") || c.content === undefined) continue;
    mkdirSync(dirname(c.file), { recursive: true });
    if (c.action === "update") copyFileSync(c.file, `${c.file}.codekit-backup-${Date.now()}`);
    writeFileSync(c.file, c.content);
    done.push(c.file);
  }
  return done;
}
