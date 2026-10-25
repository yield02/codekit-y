import { exeName, splitSegments, tokenize } from "./guard.js";
import { matchesAny } from "./glob.js";

// "No AI files in the source repo": paths that AI tools use for rules, plans, memories and
// notes. In a registered source repo agents must not create or change them — plans go to
// plan_save, maps to codemap_write, rules to the knowledge store.

/** What a blocked path is, so the deny message can point to the right place in the store. */
export type ArtifactKind = "plan" | "rules" | "tool-config" | "memory" | "guard";

export interface ArtifactPattern {
  glob: string;
  kind: ArtifactKind;
}

/** Patterns without a slash match a file name at any depth (`packages/api/CLAUDE.md`). */
export const DEFAULT_ARTIFACT_PATTERNS: ArtifactPattern[] = [
  // Plans and specs (Superpowers writes docs/plans/… or docs/superpowers/…; spec-kit uses .specify/)
  { glob: "docs/plans/**", kind: "plan" },
  { glob: "docs/superpowers/**", kind: "plan" },
  { glob: "**/docs/plans/**", kind: "plan" },
  { glob: "**/docs/superpowers/**", kind: "plan" },
  { glob: ".specify/**", kind: "plan" },
  // Rule / instruction files read by AI tools
  { glob: "AGENTS.md", kind: "rules" },
  { glob: "AGENT.md", kind: "rules" },
  { glob: "CLAUDE.md", kind: "rules" },
  { glob: "CLAUDE.local.md", kind: "rules" },
  { glob: "GEMINI.md", kind: "rules" },
  { glob: ".cursorrules", kind: "rules" },
  { glob: ".windsurfrules", kind: "rules" },
  { glob: ".clinerules", kind: "rules" },
  { glob: ".clinerules/**", kind: "rules" },
  { glob: ".github/copilot-instructions.md", kind: "rules" },
  { glob: ".github/instructions/**", kind: "rules" },
  { glob: ".github/prompts/**", kind: "rules" },
  { glob: ".github/chatmodes/**", kind: "rules" },
  // Tool configuration (must stay user-level)
  { glob: ".claude/**", kind: "tool-config" },
  { glob: "**/.claude/**", kind: "tool-config" },
  { glob: ".cursor/**", kind: "tool-config" },
  { glob: ".windsurf/**", kind: "tool-config" },
  { glob: ".continue/**", kind: "tool-config" },
  { glob: ".aider*", kind: "tool-config" },
  { glob: ".mcp.json", kind: "tool-config" },
  { glob: ".vscode/mcp.json", kind: "tool-config" },
  // Memories, maps and caches of AI tools
  { glob: ".serena/**", kind: "memory" },
  { glob: ".ua/**", kind: "memory" },
  { glob: ".understand-anything/**", kind: "memory" },
  { glob: ".codemap/**", kind: "memory" },
  { glob: "memory-bank/**", kind: "memory" },
  // The guards themselves
  { glob: ".git/hooks/**", kind: "guard" },
];

export interface ArtifactRules {
  /** Extra patterns from codekit.yaml (`guard.artifactPaths`). */
  extra: string[];
  /** Exceptions decided by the team (`guard.allowPaths`), e.g. a real `docs/plans/` folder of the product. */
  allow: string[];
}

export function artifactPatterns(rules: ArtifactRules): ArtifactPattern[] {
  return [...DEFAULT_ARTIFACT_PATTERNS, ...rules.extra.map((glob) => ({ glob, kind: "rules" as const }))];
}

/** The artifact kind of a repo-relative path, or null when it is ordinary source. Case-insensitive. */
export function artifactKind(relPath: string, rules: ArtifactRules): ArtifactKind | null {
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (!p || p.startsWith("../")) return null;
  if (matchesAny(p, rules.allow.map((a) => a.toLowerCase()))) return null;
  for (const { glob, kind } of artifactPatterns(rules)) {
    if (matchesAny(p, [glob.toLowerCase()])) return kind;
    // A directory itself (`mkdir docs/plans`) counts as the artifact folder.
    if (glob.endsWith("/**") && matchesAny(`${p}/x`, [glob.toLowerCase()])) return kind;
  }
  return null;
}

export function denyAdvice(kind: ArtifactKind): string {
  switch (kind) {
    case "plan":
      return "Save plans with the codemap MCP tool plan_save (they are stored per branch in the knowledge store). If a skill such as Superpowers tells you to write docs/plans/…, call plan_save instead.";
    case "rules":
      return "AI rules live in the knowledge store (rules/AGENTS.md, conventions/*); they are delivered through codemap_context. Ask the user if a rule should change; never add rule files to the repo.";
    case "tool-config":
      return "AI tool configuration is user-level only (codekit setup-tools); never add it to the repo.";
    case "memory":
      return "Notes and maps go to the knowledge store: codemap_write for file maps, service_write for the service summary, plan_save for plans.";
    case "guard":
      return "The repo's git hooks are codekit guards; AI agents must not change or bypass them.";
  }
}

/** Ways to switch off the commit/push hooks: `commit --no-verify`, `-c core.hooksPath=…`, `config core.hooksPath`. */
export function hookBypass(command: string): string | null {
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    const g = tokens.findIndex((t) => exeName(t) === "git");
    if (g === -1) continue;
    const args = tokens.slice(g + 1);
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if ((a === "-c" && /^core\.hookspath=/i.test(args[i + 1] ?? "")) || /^--config-env=core\.hookspath/i.test(a)) return "Overriding core.hooksPath would bypass the codekit guards.";
    }
    const sub = args.find((a, i) => !a.startsWith("-") && !(i > 0 && ["-c", "-C", "--git-dir", "--work-tree"].includes(args[i - 1]!)));
    const rest = sub ? args.slice(args.indexOf(sub) + 1) : [];
    if (sub === "config" && rest.some((r) => /^core\.hookspath$/i.test(r)) && !rest.some((r) => /^--(get|get-all|get-regexp|list|unset)$/.test(r) || r === "-l")) {
      return "Changing core.hooksPath would bypass the codekit guards.";
    }
    if ((sub === "commit" || sub === "merge" || sub === "am" || sub === "cherry-pick" || sub === "revert" || sub === "rebase") && rest.some((r) => r === "--no-verify" || (sub === "commit" && /^-[a-zA-Z]*n[a-zA-Z]*$/.test(r)))) {
      return `\`git ${sub} --no-verify\` would skip the codekit commit guard.`;
    }
  }
  return null;
}

// ------------------------------------------------------------------ shell commands

const WRITE_COMMANDS = new Set(["tee", "touch", "mkdir", "cp", "mv", "install", "rsync", "ln", "dd", "truncate", "sed", "perl"]);
const PS_WRITE = new Set(["set-content", "add-content", "out-file", "new-item", "copy-item", "move-item", "rename-item", "ni", "sc", "ac", "cpi", "mi", "copy", "move", "ren", "md", "mkdir"]);
const PS_PATH_PARAMS = /^-(path|literalpath|filepath|destination|name|newname)$/i;

/**
 * Paths a shell command would create or modify (redirections, tee, touch, mkdir, cp/mv
 * destinations, sed -i, PowerShell *-Content/Out-File/New-Item…), plus `git add <path>`.
 * Read-only uses (`cat CLAUDE.md`) are not returned.
 */
export function shellWriteTargets(command: string): string[] {
  const targets: string[] = [];
  // Redirections are found on the raw text so quotes and heredocs (`cat <<EOF > x`) are handled.
  for (const m of command.matchAll(/(?:^|[^<>&\d])(?:\d|&)?>>?\s*(?!&)("[^"]+"|'[^']+'|[^\s;&|<>()]+)/g)) {
    targets.push(m[1]!.replace(/^["']|["']$/g, ""));
  }
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment).filter((t) => !/^\d?>>?$/.test(t));
    let i = 0;
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || ["sudo", "env", "command", "&"].includes(tokens[i]!))) i++;
    const exe = exeName(tokens[i] ?? "");
    const args = tokens.slice(i + 1);
    const operands = args.filter((a) => !a.startsWith("-"));
    if (exe === "git") {
      const sub = args.find((a) => !a.startsWith("-"));
      const rest = args.slice(args.indexOf(sub ?? "") + 1).filter((a) => !a.startsWith("-"));
      if (sub === "add" || sub === "mv") targets.push(...(sub === "mv" ? rest.slice(-1) : rest));
      continue;
    }
    if (WRITE_COMMANDS.has(exe)) {
      if (exe === "sed" || exe === "perl") {
        if (args.some((a) => /^-[a-z]*i/i.test(a))) targets.push(...operands.slice(-1));
      } else if (exe === "dd") {
        targets.push(...args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)));
      } else if (["cp", "mv", "install", "rsync", "ln"].includes(exe)) {
        targets.push(...operands.slice(-1));
      } else {
        targets.push(...operands);
      }
      continue;
    }
    if (PS_WRITE.has(exe)) {
      const named = args.flatMap((a, k) => (PS_PATH_PARAMS.test(a) && args[k + 1] ? [args[k + 1]!] : []));
      const positional = args.filter((a, k) => !a.startsWith("-") && !(k > 0 && args[k - 1]!.startsWith("-")));
      if (/^(copy-item|move-item|cpi|mi|copy|move)$/.test(exe)) targets.push(...(named.length ? named : positional.slice(-1)));
      else targets.push(...(named.length ? named : positional.slice(0, 1)));
    }
  }
  return [...new Set(targets.filter(Boolean))];
}

// ------------------------------------------------------------------ MCP tools

const MCP_WRITE_WORD = /^(write|create|edit|replace|insert|delete|move|rename|append|update|save|put|patch|apply|remove|mkdir|copy)/i;
const PATH_KEYS = ["path", "file_path", "filePath", "relative_path", "filename", "file", "destination", "dest", "target", "new_path", "target_path", "uri"];

/** Paths an MCP tool call would write (other servers than codemap), e.g. Serena or filesystem servers. */
export function mcpWriteTargets(toolName: string, input: Record<string, unknown> | undefined): string[] {
  const parts = toolName.split("__");
  const server = parts.slice(1, -1).join("__").toLowerCase();
  const tool = (parts.at(-1) ?? "").toLowerCase();
  if (server.includes("codemap")) return []; // our own tools write to the knowledge store
  if (/serena/.test(server) && /memory/.test(tool) && /^(write|edit|delete)/.test(tool)) {
    const name = typeof input?.memory_file_name === "string" ? input.memory_file_name : "memory.md";
    return [`.serena/memories/${name}`];
  }
  if (!MCP_WRITE_WORD.test(tool.split(/[_-]/)[0] ?? "") && !/(write|create|replace|insert|edit)/.test(tool)) return [];
  const out: string[] = [];
  for (const key of PATH_KEYS) {
    const v = input?.[key];
    if (typeof v === "string" && v) out.push(v.replace(/^file:\/\//, ""));
  }
  if (Array.isArray(input?.paths)) for (const v of input!.paths) if (typeof v === "string") out.push(v);
  return out;
}
