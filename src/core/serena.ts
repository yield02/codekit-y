import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { codekitHome } from "./paths.js";

// Serena (https://github.com/oraios/serena) is layer 1 of the map: LSP-backed symbol tools.
// It is installed as a uv tool (`uv tool install -p 3.13 serena-agent`) and launched as
// `serena start-mcp-server`. codekit configures it for each AI tool so that:
// - its memory/onboarding tools are off (`--add-mode no-memories`): notes and maps go to codemap;
// - the web dashboard does not pop up (`--open-web-dashboard False`);
// - its per-project `.serena/` folder lives outside the source repo (serena_config.yml);
// - the classic tool interface is used (`--agent-interface tools`). Serena 2.x defaults to a
//   REPL interface (one `serena_repl` tool running code), which would hide which files are
//   read or edited from codekit's hooks and from the artifact guard.

export type SerenaClient = "claude-code" | "cursor" | "vscode";

export const SERENA_INSTALL = ["uv", "tool", "install", "-p", "3.13", "serena-agent"] as const;

/** Arguments after the executable. Single-project contexts take the project from the cwd; agents can still call activate_project. */
export function serenaArgs(client: SerenaClient): string[] {
  const context = client === "claude-code" ? "claude-code" : client === "cursor" ? "ide" : "vscode";
  return ["start-mcp-server", "--context", context, "--project-from-cwd", "--agent-interface", "tools", "--add-mode", "no-memories", "--open-web-dashboard", "False"];
}

export interface SerenaInstall {
  /** Absolute path of the `serena` executable (GUI clients often lack the shell PATH). */
  executable: string | null;
  version: string | null;
  uv: string | null;
}

function which(cmd: string): string | null {
  const res = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8", timeout: 10_000 });
  if (res.status !== 0) return null;
  const first = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Prefer the real executable over a shell shim on Windows.
  return first.find((p) => /\.exe$/i.test(p)) ?? first[0] ?? null;
}

export function findSerena(): SerenaInstall {
  const uv = which("uv");
  let executable = process.env.CODEKIT_SERENA_PATH ?? which("serena");
  if (!executable && uv) {
    // uv installs tools into its bin dir, which may not be on PATH yet.
    const binDir = spawnSync("uv", ["tool", "dir", "--bin"], { encoding: "utf8", timeout: 10_000 }).stdout?.trim();
    const candidate = binDir ? join(binDir, process.platform === "win32" ? "serena.exe" : "serena") : "";
    if (candidate && existsSync(candidate)) executable = candidate;
  }
  let version: string | null = null;
  if (uv) {
    const list = spawnSync("uv", ["tool", "list"], { encoding: "utf8", timeout: 10_000 }).stdout ?? "";
    version = /serena-agent v?([\d.]+\S*)/.exec(list)?.[1] ?? null;
  }
  return { executable: executable ? executable.replace(/\\/g, "/") : null, version, uv };
}

/** `~/.serena` (or `SERENA_HOME`). */
export function serenaHome(): string {
  return process.env.SERENA_HOME ?? join(homedir(), ".serena");
}

export function serenaConfigPath(): string {
  return join(serenaHome(), "serena_config.yml");
}

/** Where codekit asks Serena to keep each project's `.serena/` folder: outside the source repo. */
export function serenaProjectFolder(): string {
  return `${join(codekitHome(), "serena").replace(/\\/g, "/")}/$projectFolderName/.serena`;
}

export interface SerenaConfigPlan {
  file: string;
  action: "update" | "unchanged" | "skipped";
  detail: string;
  content?: string;
}

/**
 * Settings codekit needs in Serena's global config, merged without losing comments:
 * - `web_dashboard_open_on_launch: false` (no browser pop-up for every session);
 * - `project_serena_folder_location` outside the repo, unless the user already chose one.
 *   Existing `<repo>/.serena` folders keep working: Serena falls back to them.
 */
export function planSerenaConfig(file = serenaConfigPath()): SerenaConfigPlan {
  if (!existsSync(file)) {
    return { file, action: "skipped", detail: "Serena's global config does not exist yet: run `serena init` once, then run setup-tools again." };
  }
  const text = readFileSync(file, "utf8");
  const doc = parseDocument(text);
  if (doc.errors.length) return { file, action: "skipped", detail: `could not parse ${file}; set web_dashboard_open_on_launch: false and project_serena_folder_location manually.` };
  const changes: string[] = [];
  if (doc.get("web_dashboard_open_on_launch") !== false) {
    doc.set("web_dashboard_open_on_launch", false);
    changes.push("web_dashboard_open_on_launch: false");
  }
  const location = doc.get("project_serena_folder_location");
  if (location === undefined || location === null || location === "" || location === "$projectDir/.serena") {
    doc.set("project_serena_folder_location", serenaProjectFolder());
    changes.push(`project_serena_folder_location: ${serenaProjectFolder()}`);
  }
  if (!changes.length) return { file, action: "unchanged", detail: "Serena global config: already configured." };
  return { file, action: "update", detail: `Serena global config: ${changes.join(", ")}`, content: doc.toString({ lineWidth: 0 }) };
}

export interface SerenaStatus {
  install: SerenaInstall;
  config: { exists: boolean; dashboardQuiet: boolean; folderOutsideRepo: boolean };
}

export function serenaStatus(install = findSerena(), file = serenaConfigPath()): SerenaStatus {
  if (!existsSync(file)) return { install, config: { exists: false, dashboardQuiet: false, folderOutsideRepo: false } };
  const doc = parseDocument(readFileSync(file, "utf8"));
  const location = String(doc.get("project_serena_folder_location") ?? "");
  return {
    install,
    config: {
      exists: true,
      dashboardQuiet: doc.get("web_dashboard_open_on_launch") === false,
      folderOutsideRepo: !!location && !location.startsWith("$projectDir"),
    },
  };
}

/** `claude mcp add --scope user serena -- <serena> start-mcp-server …` (Claude Code keeps user MCP servers itself). */
export function claudeAddCommand(executable: string): string[] {
  return ["mcp", "add", "--scope", "user", "serena", "--", executable, ...serenaArgs("claude-code")];
}

/** Index a repo once so the first symbol lookup is fast (Serena keeps it updated afterwards). */
export function indexCommand(executable: string): string[] {
  return [executable, "project", "index"];
}
