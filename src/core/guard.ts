// Source repositories are read + local-commit only for AI agents: nothing may be
// pushed or written to the remote. This module decides whether a shell command or
// MCP tool call would do that. It is deliberately strict: when unsure, block.

export interface GuardVerdict {
  blocked: boolean;
  rule?: string;
  reason?: string;
}

const ALLOW: GuardVerdict = { blocked: false };
const block = (rule: string, reason: string): GuardVerdict => ({ blocked: true, rule, reason });

/** Env vars that mark a process as started by an AI agent (used by the pre-push hook too). */
export const AGENT_ENV_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "AI_AGENT", "CURSOR_AGENT", "CODEKIT_AGENT"];

const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix"]);
const GIT_PUSH_SUBCOMMANDS = new Set(["push", "send-pack"]);
const GIT_NESTED_PUSH: Record<string, string[]> = { subtree: ["push"], lfs: ["push"], svn: ["dcommit"], p4: ["submit"] };

const GH_WRITE: Record<string, string[] | "*"> = {
  pr: ["create", "merge", "edit", "close", "reopen", "ready", "review", "comment", "update-branch", "revert"],
  repo: ["create", "delete", "edit", "fork", "sync", "rename", "archive", "unarchive", "set-default"],
  release: ["create", "edit", "delete", "delete-asset", "upload"],
  workflow: ["run", "enable", "disable"],
  run: ["rerun", "cancel", "delete"],
  ruleset: "*",
};

const HOSTING = /(github\.com|githubusercontent\.com|\/api\/v3|gitlab|bitbucket|dev\.azure\.com|visualstudio\.com)/i;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "pwsh", "powershell", "cmd"]);
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time", "nice", "xargs", "&", "call", "start", "start-process"]);

export interface ShellGuardOptions {
  /** git aliases of the repo (`alias.p` -> `push`), so `git p` is caught. */
  gitAliases?: Record<string, string>;
  /** Reads a script passed to a shell (`bash deploy.sh`, `pwsh -File x.ps1`) so its content is checked too. */
  readScript?: (path: string) => string | null;
}

export function checkShellCommand(command: string, opts: ShellGuardOptions = {}, depth = 0): GuardVerdict {
  if (depth > 4) return block("nesting", "Command nesting is too deep to verify.");
  for (const segment of splitSegments(command)) {
    const verdict = checkSegment(tokenize(segment), opts, depth);
    if (verdict.blocked) return verdict;
  }
  return ALLOW;
}

function checkSegment(tokens: string[], opts: ShellGuardOptions, depth: number): GuardVerdict {
  let i = 0;
  // Skip env assignments and wrappers: `FOO=1 sudo env git push`
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || WRAPPERS.has(exeName(tokens[i]!)) || /^-/.test(tokens[i]!) && i > 0 && WRAPPERS.has(exeName(tokens[i - 1]!)))) i++;
  if (i >= tokens.length) return ALLOW;
  const exe = exeName(tokens[i]!);
  const args = tokens.slice(i + 1);

  if (SHELLS.has(exe)) {
    const idx = args.findIndex((a) => /^(-c|-command|\/c|\/k|-encodedcommand|-ec)$/i.test(a));
    if (idx !== -1 && /encodedcommand|^-ec$/i.test(args[idx]!)) return block("encoded-shell", "Encoded shell commands cannot be verified.");
    if (idx !== -1) return checkShellCommand(args.slice(idx + 1).join(" "), opts, depth + 1);
    const fileIdx = args.findIndex((a) => /^-file$/i.test(a));
    const script = fileIdx !== -1 ? args[fileIdx + 1] : args.find((a) => !a.startsWith("-"));
    return script ? checkScript(script, opts, depth) : ALLOW;
  }
  if (/\.(sh|bash|ps1|cmd|bat)$/i.test(tokens[i]!)) return checkScript(tokens[i]!, opts, depth);
  if (exe === "eval" || exe === "invoke-expression" || exe === "iex") {
    return checkShellCommand(args.join(" "), opts, depth + 1);
  }
  if (exe === "git") return checkGit(args, opts);
  if (exe === "gh") return checkGh(args);
  if (exe === "hub" && ["push", "pull-request", "create", "delete", "release", "fork", "merge"].includes(args[0] ?? "")) {
    return block("hub-write", `\`hub ${args[0]}\` writes to the remote.`);
  }
  if (["curl", "wget", "invoke-webrequest", "invoke-restmethod", "iwr", "irm", "http", "https", "xh"].includes(exe)) {
    return checkHttp(exe, args);
  }
  // Strict fallback: a git/gh token anywhere (`xargs -I{} git push`, an unquoted path with spaces).
  for (let j = i + 1; j < tokens.length; j++) {
    const name = exeName(tokens[j]!);
    const verdict = name === "git" ? checkGit(tokens.slice(j + 1), opts) : name === "gh" ? checkGh(tokens.slice(j + 1)) : ALLOW;
    if (verdict.blocked) return verdict;
  }
  return ALLOW;
}

function checkScript(path: string, opts: ShellGuardOptions, depth: number): GuardVerdict {
  const content = opts.readScript?.(path);
  if (!content) return ALLOW;
  const verdict = checkShellCommand(content, opts, depth + 1);
  return verdict.blocked ? { ...verdict, reason: `Script ${path}: ${verdict.reason}` } : ALLOW;
}

function checkGit(args: string[], opts: ShellGuardOptions): GuardVerdict {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    const a = args[i]!;
    if (a === "-c" || a.startsWith("--config-env")) {
      const kv = a === "-c" ? args[i + 1] ?? "" : a.split("=").slice(1).join("=");
      if (/^alias\./i.test(kv) && /push|send-pack/i.test(kv)) return block("git-alias-push", "Defining a git alias that pushes is not allowed.");
    }
    if (GIT_GLOBAL_WITH_VALUE.has(a)) i += 2;
    else i += 1;
  }
  const sub = (args[i] ?? "").toLowerCase();
  const rest = args.slice(i + 1).map((a) => a.toLowerCase());
  if (!sub) return ALLOW;
  if (GIT_PUSH_SUBCOMMANDS.has(sub)) return block("git-push", `\`git ${sub}\` would publish to the remote.`);
  const nested = GIT_NESTED_PUSH[sub];
  if (nested && rest.some((r) => nested.includes(r))) return block("git-push", `\`git ${sub} ${rest.find((r) => nested.includes(r))}\` would publish to the remote.`);
  if (sub === "config" && rest.some((r) => /^alias\./.test(r)) && rest.some((r) => /push|send-pack/.test(r))) {
    return block("git-alias-push", "Defining a git alias that pushes is not allowed.");
  }
  const alias = opts.gitAliases?.[sub];
  if (alias && /(^|[\s!])(push|send-pack)\b|git\s+push/.test(alias)) return block("git-alias-push", `\`git ${sub}\` is an alias for "${alias}", which pushes.`);
  return ALLOW;
}

function checkGh(args: string[]): GuardVerdict {
  const [group = "", action = ""] = args.map((a) => a.toLowerCase());
  if (group === "api") return checkGhApi(args.slice(1));
  const writes = GH_WRITE[group];
  if (writes === "*" || writes?.includes(action)) return block("gh-write", `\`gh ${group} ${action}\` writes to GitHub.`);
  return ALLOW;
}

function checkGhApi(args: string[]): GuardVerdict {
  let method: string | null = null;
  let hasBody = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-X" || a === "--method") method = (args[i + 1] ?? "").toUpperCase();
    else if (/^--method=/.test(a)) method = a.split("=")[1]!.toUpperCase();
    else if (/^-X[A-Z]+$/i.test(a)) method = a.slice(2).toUpperCase();
    else if (["-f", "-F", "--field", "--raw-field", "--input"].includes(a) || /^--(raw-)?field=/.test(a)) hasBody = true;
  }
  const effective = method ?? (hasBody ? "POST" : "GET");
  if (effective !== "GET" && effective !== "HEAD") return block("gh-api-write", `\`gh api\` with ${effective} writes to GitHub.`);
  return ALLOW;
}

function checkHttp(exe: string, args: string[]): GuardVerdict {
  if (!args.some((a) => HOSTING.test(a))) return ALLOW;
  let method: string | null = null;
  let hasBody = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const lower = a.toLowerCase();
    if (["-x", "--request", "-method", "--method"].includes(lower)) method = (args[i + 1] ?? "").toUpperCase();
    else if (/^--(request|method)=/i.test(a)) method = a.split("=")[1]!.toUpperCase();
    else if (/^-X[A-Z]+$/.test(a)) method = a.slice(2).toUpperCase();
    else if (/^(-d|--data.*|-f|--form.*|-t|--upload-file|-body|--post-data|--post-file|--body-data|--body-file|-infile)$/i.test(a) || /^--data/.test(lower)) hasBody = true;
    else if (/^(post|put|patch|delete)$/i.test(a) && (exe === "http" || exe === "https" || exe === "xh")) method = a.toUpperCase();
  }
  const effective = method ?? (hasBody ? "POST" : "GET");
  if (effective !== "GET" && effective !== "HEAD") return block("http-write", `${exe} ${effective} to a code-hosting API writes to the remote.`);
  return ALLOW;
}

const MCP_HOSTING = /(github|gitlab|bitbucket|azure[-_]?devops|ado)/i;
const MCP_WRITE_FIRST_WORD = new Set([
  "push", "create", "merge", "update", "delete", "fork", "edit", "close", "reopen", "submit", "request", "add", "remove",
  "rename", "write", "upload", "commit", "approve", "dismiss", "enable", "disable", "run", "rerun", "cancel", "assign",
  "label", "lock", "unlock", "transfer", "mark", "set", "manage", "trigger", "revert", "resolve", "star", "unstar",
]);
const MCP_WRITE_ANY_WORD = new Set(["push", "merge", "commit"]);

/** MCP tools of code-hosting servers that write (push files, PRs, merges...). */
export function checkMcpTool(toolName: string, allow: readonly string[] = []): GuardVerdict {
  if (allow.includes(toolName)) return ALLOW;
  const parts = toolName.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") return ALLOW;
  const server = parts.slice(1, -1).join("__");
  const tool = parts.at(-1)!;
  if (!MCP_HOSTING.test(server) && !MCP_HOSTING.test(tool)) return ALLOW;
  const words = tool.toLowerCase().split(/[_\-]+/).filter(Boolean);
  if (MCP_WRITE_FIRST_WORD.has(words[0] ?? "") || words.some((w) => MCP_WRITE_ANY_WORD.has(w))) {
    return block("mcp-hosting-write", `MCP tool ${toolName} writes to the code host.`);
  }
  return ALLOW;
}

/** Directories a command operates on (`cd X`, `git -C X`, `Set-Location X`, `pushd X`), for repo scoping. */
export function commandTargetDirs(command: string): string[] {
  const dirs: string[] = [];
  for (const segment of splitSegments(command)) {
    const t = tokenize(segment);
    const isGit = t.some((tok) => exeName(tok) === "git");
    for (let i = 0; i < t.length; i++) {
      const raw = t[i]!;
      const next = t[i + 1];
      if (next && ["cd", "pushd", "set-location", "sl", "chdir"].includes(raw.toLowerCase())) dirs.push(next);
      if (next && isGit && (raw === "-C" || raw === "--git-dir" || raw === "--work-tree")) dirs.push(next);
      if (isGit && /^--(git-dir|work-tree)=/.test(raw)) dirs.push(raw.split("=").slice(1).join("="));
    }
  }
  return dirs;
}

export function exeName(token: string): string {
  const base = token.replace(/\\/g, "/").split("/").pop() ?? token;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

/** Split on unquoted `;`, `&&`, `||`, `|`, `&`, newlines. */
export function splitSegments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) {
        cur += c + command[++i];
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || (c === "&" && command[i + 1] === "&")) {
      if (c === "|" && command[i + 1] === "|") i++;
      if (c === "&") i++;
      out.push(cur);
      cur = "";
      continue;
    }
    if (c === "&" && command[i - 1] !== ">" && command[i + 1] !== ">") {
      // bash background `&` ends a command; PowerShell call operator `& git` starts one
      out.push(cur);
      cur = "";
      continue;
    }
    // Command substitution: check the inner command as its own segment.
    if ((c === "$" && command[i + 1] === "(") || c === "`") {
      cur += " ";
      continue;
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && /["\\$`]/.test(segment[i + 1] ?? "")) cur += segment[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) tokens.push(cur);
      cur = "";
      has = false;
      continue;
    }
    if (c === "\\" && i + 1 < segment.length && !/[A-Za-z]/.test(segment[i + 1]!)) {
      cur += segment[++i];
      has = true;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has || cur) tokens.push(cur);
  return tokens;
}
