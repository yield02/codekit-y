# codekit-y — AI Code Kit

A kit for AI-assisted source code management. It helps AI tools (Claude Code, Cursor, GitHub Copilot) and developers understand a codebase quickly and consistently, without adding any AI files to the source repository.

**What you get:**
1. **A shared codebase map.** AI tools write one Markdown map per source file the first time they touch it. The maps are shared by the whole team.
2. **Per-branch maps.** A new branch starts from its parent's map. Merging code also merges the maps.
3. **Planning** with Superpowers. Plans are saved outside the source repo.
4. **A naming convention** the team can edit.
5. **Readable logs** with a mandatory `correlationId` and `tags`, and no noise.
6. **Guards.** AI agents may edit and commit locally, but they can never push, and they never add AI files to the source repo.

The full design is in the [implementation plan](docs/plans/2026-10-25-ai-codekit-plan.md). This README is the installation and operations guide.

---

## Contents
1. [Concepts in 2 minutes](#1-concepts-in-2-minutes)
2. [Requirements](#2-requirements)
3. [Install the prerequisites](#3-install-the-prerequisites)
4. [Install the kit](#4-install-the-kit)
5. [Create the project's knowledge store (once per project)](#5-create-the-projects-knowledge-store-once-per-project)
6. [Register your repos (once per developer)](#6-register-your-repos-once-per-developer)
7. [Set up the AI tools](#7-set-up-the-ai-tools)
8. [Verify the installation](#8-verify-the-installation)
9. [Daily use](#9-daily-use)
10. [Updating the kit](#10-updating-the-kit)
11. [Troubleshooting](#11-troubleshooting)
12. [Uninstall](#12-uninstall)
13. [Reference](#13-reference)
14. [Development](#14-development)

---

## 1. Concepts in 2 minutes

| Term | Meaning |
|---|---|
| **Project** | A product, for example `Transfer`. It can have one repo or many repos (microservices). |
| **Repo** | One git repository of the project, for example `core`, `transactions` or `admin`. |
| **Knowledge store** | One per project. It holds the maps, branch history, plans, AI rules and conventions. It **never** lives inside a source repo. |
| **Git backend** | The store is a separate internal git repo, for example `transfer-codemap`. This is recommended. |
| **Folder backend** | The store is a shared folder on a NAS or network drive. It suits small teams. |
| **Map** | One Markdown file per source file: purpose, public API, main flow, caveats. AI tools write maps lazily. |
| **Serena** | An optional, recommended MCP server that gives the AI LSP-based symbol tools. It is the "structural layer" of the map. |

**Who does what:**
- **Once per project** (tech lead): create the knowledge store. See [§5](#5-create-the-projects-knowledge-store-once-per-project).
- **Once per developer machine**: install the prerequisites and the kit, register your repo clones, and set up your AI tools. See [§3](#3-install-the-prerequisites), [§4](#4-install-the-kit), [§6](#6-register-your-repos-once-per-developer) and [§7](#7-set-up-the-ai-tools).

**Where things are written:**
- Into your source repos, the kit writes only two local git hooks (`.git/hooks/pre-push`, `.git/hooks/pre-commit`) and a few lines in `.git/info/exclude`. None of these are ever committed.
- On your machine, everything else lives in `~/.codekit/` and in your AI tools' user-level config.
- Everything the team shares lives in the knowledge store.

---

## 2. Requirements

| Software | Version | Needed for |
|---|---|---|
| **Git** | 2.5 or later. Tested with 2.34 (Ubuntu 22.04) to 2.56 | everything |
| **Node.js** | **20 or later** (20, 22 and 24 are tested) | the kit: CLI, MCP server, hooks |
| **npm** | the version bundled with Node | building the kit |
| **uv** | any recent version | Serena (optional, recommended) |
| **Claude Code** and/or **Cursor** and/or **VS Code + GitHub Copilot** | current | the AI tools you use |

**Tested platforms.** CI runs on every push (`.github/workflows/ci.yml`):
- Ubuntu with Node 20, 22 and 24
- stock `ubuntu:22.04` and `ubuntu:24.04` images, using the distribution's git and python
- Windows
- macOS

**Notes:**
- `node` and `git` must be on the `PATH` that your AI tool uses. On Windows, Claude Code runs its hooks through Git Bash.
- Ubuntu's own `nodejs` package is too old. Install Node from NodeSource or nvm (see below).
- Serena downloads language servers the first time it is used, so it needs internet access to GitHub, npm and NuGet:
  - Java: JDTLS with a bundled JRE
  - C#: Roslyn and .NET (on Windows this also needs `pwsh`)
  - Python: pyright via `uvx`
  - TypeScript: typescript-language-server via npm

---

## 3. Install the prerequisites

### Ubuntu / Debian
```bash
# git
sudo apt-get update && sudo apt-get install -y git curl ca-certificates

# Node.js 22 (NodeSource). Ubuntu's own "nodejs" package is too old.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
#   Alternative without sudo (nvm):
#   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
#   exec $SHELL && nvm install 22

# uv (for Serena)
curl -LsSf https://astral.sh/uv/install.sh | sh

node --version && git --version && uv --version
```

### macOS
```bash
brew install git node uv
node --version && git --version && uv --version
```

### Windows (PowerShell)
```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id astral-sh.uv -e      # or: powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# Open a NEW terminal, then check:
node --version; git --version; uv --version
```
If `node` is not found after installing, add `C:\Program Files\nodejs` to your **user** PATH and open a new terminal:
```powershell
$p = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable("Path", "$p;C:\Program Files\nodejs", "User")
```
Check from Git Bash too, because Claude Code runs its hooks there: `node --version`.

---

## 4. Install the kit

Every developer installs the kit once per machine. The AI tools run it from this clone, so keep it in a stable place.

```bash
# Pick a stable location, e.g. ~/tools (Windows: C:\tools)
git clone https://github.com/yield02/codekit-y.git
cd codekit-y
npm ci            # or: npm install
npm run build     # produces dist/
```

**Make the commands available.** Use one of these two options:
```bash
# Option A: link the commands globally (codekit, codemap, codemap-mcp)
npm link

# Option B: no global install. Call the CLI by path (used in this README as `codekit` / `codemap`):
#   node /path/to/codekit-y/dist/cli/codekit.js ...
#   node /path/to/codekit-y/dist/cli/codemap.js ...
#   Bash alias:  alias codekit="node $HOME/tools/codekit-y/dist/cli/codekit.js"
#                alias codemap="node $HOME/tools/codekit-y/dist/cli/codemap.js"
```

On Windows PowerShell, add these functions to your profile:
```powershell
function codekit { node C:\tools\codekit-y\dist\cli\codekit.js @args }
function codemap { node C:\tools\codekit-y\dist\cli\codemap.js @args }
```

Check that the commands work:
```bash
codekit --help
codemap --help
```

---

## 5. Create the project's knowledge store (once per project)

The tech lead does this once, for the whole project and all its repos.

### 5.1 Git backend (recommended)

1. On your internal git host, create an **empty** repo for the store, for example `transfer-codemap`. Leave out the README and the .gitignore. Make it private and give the team read/write access.
2. Scaffold the store:
   ```bash
   codekit project create Transfer --backend git --url https://git.internal/transfer/transfer-codemap.git
   # Options:
   #   --default-branch <name>   the source repos' default branch (default: main)
   ```
   This pushes a `_config` branch, which becomes the store repo's default branch. It contains:
   ```
   codekit.yaml                        project settings (see 5.3)
   rules/AGENTS.md                     rules every AI tool follows
   conventions/naming.md               naming convention (team-editable)
   conventions/logging.md              logging convention + tag registry
   .github/workflows/codemap-report.yml   optional coverage report (see 5.4)
   ```
   Map branches (`maps/<repo>/<branch>`) are created automatically the first time each repo is used.

### 5.2 Folder backend
```bash
# Windows (UNC path)
codekit project create Transfer --backend folder --path "\\NAS\codemap\Transfer"
# Linux / macOS (mounted share)
codekit project create Transfer --backend folder --path /mnt/nas/codemap/Transfer
```
- The layout is `config/` (settings, rules, conventions), `repos/<repo>/branches/<branch>/` (maps), `history/` (the write log) and `locks/`.
- Every developer must be able to read and write this folder. Each person may reach it through a different path (`\\NAS\…` on Windows, `/mnt/nas/…` on Linux), because the path is stored per machine.
- Backups are the NAS's job. For teams of more than about 5 people, prefer the git backend.

### 5.3 Adjust `codekit.yaml` (optional)

**Where to edit:**
- **Git backend:** clone the store repo, which checks out the `_config` branch. Edit, commit and push. Every developer's kit picks the change up on its next sync.
  ```bash
  git clone https://git.internal/transfer/transfer-codemap.git && cd transfer-codemap
  # edit codekit.yaml / rules/AGENTS.md / conventions/*.md
  git commit -am "config: ..." && git push
  ```
- **Folder backend:** edit `<path>/config/codekit.yaml` directly.

**What you can set:**

| Key | Default | Meaning |
|---|---|---|
| `defaultBranch` | `main` | Default branch of the source repos. It can be overridden per repo. |
| `include` / `exclude` | build output, tests, lock files, images, `*.md`… | Which source files need a map |
| `enforce` | `fail` | `fail`: Claude Code's Stop hook asks the AI to write missing maps before it finishes. `warn`: only a warning. Start with `warn` during a pilot if you prefer. |
| `trackReads` | `true` | Files the AI only *read* also need a map. Set `false` to require maps only for edited files. |
| `mapMaxLines` | `60` | Soft size limit of a map |
| `github.enabled` / `github.apiUrl` | `true` / GitHub.com | Detect squash and rebase merges through the GitHub API (read-only). Set `apiUrl` for GitHub Enterprise, e.g. `https://github.example.com/api/v3`. |
| `guard.allowPaths` | `[]` | Real project paths that look like AI files, e.g. `"docs/plans/**"` if your product has such a folder |
| `guard.artifactPaths` | `[]` | Extra AI-file patterns your team wants blocked |
| `guard.allowMcpTools` | `[]` | MCP tools exempt from the push guard, e.g. an issue-comment tool |
| `repos.<name>` | added by `codekit init` | Per repo: `remote`, `defaultBranch`, `include`, `exclude` (added to the global list), `description` (shown to AI agents) |

After you change `guard.*`, every developer should re-run `codekit init` (§6) so the local `pre-commit` hook picks up the new patterns.

### 5.4 Coverage report in CI (optional, git backend on GitHub)

The store repo contains `.github/workflows/codemap-report.yml`. It runs on weekdays and posts coverage plus missing, stale and AI-file findings for every repo.
1. In the **store repo** settings, add:
   - Variable `SOURCE_REPOSITORIES`: a JSON list, e.g. `["acme/transfer-core","acme/transfer-transactions"]`
   - Variable `CODEKIT_REPO_URL`: the clone URL of `codekit-y`
   - Secret `SOURCE_READ_TOKEN`: a fine-grained token with **Contents: read** on those repos only
2. Run it once by hand (Actions → codemap report → Run workflow) to check it works.

---

## 6. Register your repos (once per developer)

Registering connects your clone of a source repo to the project's store. It also installs the local guards.

**One repo:**
```bash
codekit init --project Transfer --backend git --url https://git.internal/transfer/transfer-codemap.git -C path/to/transfer-core
```

**A project with several repos (microservices).** Use the same `--project` and store for each repo:
```bash
codekit init --project Transfer --backend git --url <store-url> -C ~/src/Transfer/Core         --repo-name core
codekit init --project Transfer --backend git --url <store-url> -C ~/src/Transfer/Transactions --repo-name transactions
```

**All repos under a parent folder at once.** Each repo is named after its folder (`Core` becomes `core`):
```bash
codekit init --all --project Transfer --backend git --url <store-url> -C ~/src/Transfer
```

For the folder backend, replace `--backend git --url …` with `--backend folder --path <shared folder>`.

**Repo names are decided by the store.** The first person to register a repo records its name in `codekit.yaml`. Everyone after that gets the same name automatically, and a conflicting `--repo-name` is rejected. This keeps everyone's maps in the same place.

**What `codekit init` does** (it is safe to run again at any time):
1. Records the project, its store and your clone's path in `~/.codekit/config.yaml`.
2. For the git backend, clones the store into `~/.codekit/stores/<project>/`.
3. Adds `.serena/`, `.ua/` and `.understand-anything/` to the repo's **local** `.git/info/exclude`. Your `.gitignore` is not touched.
4. Installs two local git hooks. If the repo already has hooks, they are kept and chained.
   - `pre-push`: rejects pushes made by an AI agent process. Pushes from your own terminal work as usual.
   - `pre-commit`: rejects agent commits that add AI files (`CLAUDE.md`, `.cursor/`, `docs/plans/`, …).

> If a repo uses `core.hooksPath` (husky, lefthook), the kit leaves those tracked hooks alone. In that case the Claude Code and Cursor guards still apply, and `codekit doctor` tells you the git hooks are missing.

Run `codekit projects` to list what is registered on your machine.

---

## 7. Set up the AI tools

Set up the tools you actually use. Everything goes into **user-level** config, never into a repo.

### 7.1 Claude Code

1. Install the kit's plugin from your local clone. The clone works as a plugin marketplace:
   ```bash
   claude plugin marketplace add /path/to/codekit-y
   claude plugin install codekit@codekit-y
   ```
   Inside a Claude Code session you can do the same with `/plugin marketplace add …` and `/plugin install codekit@codekit-y`.
2. Install Superpowers, the planning skills:
   ```bash
   claude plugin marketplace add obra/superpowers-marketplace
   claude plugin install superpowers@superpowers-marketplace
   ```
3. Restart Claude Code, or run `/reload-plugins`.

The plugin provides:
- **Hooks:**
  - `SessionStart`: syncs maps and injects the rules, conventions and service summaries.
  - `UserPromptSubmit`: adds a short workflow reminder.
  - `PreToolUse`: the push and AI-file guards.
  - `PostToolUse`: tracks the files the AI reads or edits.
  - `Stop`: asks for missing or stale maps.
- **Skills:** `codemap`, `naming`, `logging`.
- **MCP server:** `codemap`.

The hooks run `node <kit>/dist/...`, so `node` must be on the PATH that Claude Code uses.

### 7.2 Serena (recommended, for every AI tool)
```bash
# Install Serena if needed (or install it yourself: uv tool install -p 3.13 serena-agent && serena init)
codekit setup-tools --install-serena --dry-run     # preview
codekit setup-tools --install-serena               # apply
```
`setup-tools` registers Serena with every tool it configures. It uses the absolute path of the `serena` executable, the classic tool interface, memory tools off and no dashboard pop-up. It also updates Serena's global config so that each project's `.serena/` folder lives under `~/.codekit/serena/`, outside your repos. For Claude Code it runs `claude mcp add --scope user serena …`, or prints that command if the `claude` CLI is not on your PATH.

For large repos, index once so the first symbol lookup is fast:
```bash
codekit serena index -C path/to/repo        # or a parent folder: indexes every registered repo in it
```

### 7.3 Cursor
```bash
codekit setup-tools --cursor          # add --no-serena to skip Serena
```
This writes:
- `~/.cursor/mcp.json`: the `codemap` server, plus `serena`
- `~/.cursor/hooks.json`: the push and AI-file guards (`beforeShellExecution`, `beforeMCPExecution`)

Then paste the rules that `setup-tools` prints into **Cursor Settings → Rules → User Rules**. Cursor keeps user rules in its own settings, so the kit cannot write them for you.

### 7.4 VS Code + GitHub Copilot
```bash
codekit setup-tools --vscode
```
This writes the VS Code **user** `mcp.json` (with the `codemap` and `serena` servers) and `prompts/codekit.instructions.md` (Copilot user instructions).

Then add the snippet that `setup-tools` prints to your **user** `settings.json`. It makes every agent `git push` / `gh pr …` command wait for your approval, because Copilot has no hook API.

The VS Code user folder is:
- Windows: `%APPDATA%\Code\User`
- macOS: `~/Library/Application Support/Code/User`
- Linux: `~/.config/Code/User`

For VS Code Insiders or a portable install, set `CODEKIT_VSCODE_USER_DIR` to its User folder before running `setup-tools`.

**About `setup-tools`:**
- Without `--claude`, `--cursor` or `--vscode`, it configures all three.
- It backs up every file it changes (`*.codekit-backup-<timestamp>`).
- It never rewrites a JSON file that contains comments; it prints the snippet for you to merge instead.
- It never replaces a `serena` entry you configured yourself.
- It is safe to run again.

---

## 8. Verify the installation

```bash
codekit doctor -C path/to/repo
```
Every line should show ✔. Typical output:
```
✔ node                   v22.x
✔ git                    git version 2.4x
✔ uv (for Serena)        uv 0.x
✔ serena                 2.x /home/you/.local/bin/serena
✔ serena config          dashboard quiet, .serena/ outside repos
✔ serena in AI tools     Cursor, VS Code, Claude Code
✔ claude CLI             x.y.z
✔ kit built              /home/you/tools/codekit-y/
✔ repo registered        repo core of project Transfer (4 repos registered here)
✔ store reachable        git
✔ store config           codekit.yaml found
✔ branch map             main (from root)
✔ push guard (pre-push)  installed
✔ artifact guard (pre-commit) installed
```

**Quick functional check** (run in a registered repo):
```bash
codemap sync            # creates the map branch for your current branch
codemap status          # coverage: ok / missing / stale
```
Then open your AI tool in the repo and ask *"What does codemap_context say about this project?"*. The answer should quote the project's rules.

---

## 9. Daily use

### What happens on its own
1. **Session start.** The current branch is synced, so a new branch gets its parent's map and merges are detected. The AI receives the rules, conventions, coverage and service summaries.
2. **While working.** The AI checks maps before reading code (`codemap_lookup`), uses Serena's symbol tools, and plans with Superpowers. Plans are saved with `plan_save` into the store.
3. **When it finishes** (Claude Code). If it read or edited files whose map is missing or stale, the Stop hook asks it to write those maps first. Maps are committed and pushed **to the store** immediately.
4. **Guards.** The agent may commit locally, but it cannot push and cannot add AI files to the repo. **You** review and push.

### Opening the AI tool
- **On one repo**, e.g. `Transfer/Core`: the normal case.
- **On a parent folder**, e.g. `Transfer/` holding several registered repos, or on a VS Code multi-root workspace of them: paths are routed to their own repo (`Core/src/x.ts` or `core:src/x.ts`). Context covers every repo, and every push-like command is denied.

### Useful commands
```bash
codemap status [--all]                 # coverage and missing/stale maps (a parent folder: all repos)
codemap sync                           # sync now (also checks squash-merged PRs on GitHub)
codemap lineage [branch]               # where a branch came from, syncs, merges
codemap merge feature/x --into main --pr 42   # merge maps by hand (squash merge without the GitHub API)
codemap search "payment" [--project]   # find maps by tag, path or text, in this repo or the whole project
codemap report [--out report.md]       # per-branch coverage + AI files found in the repo
codemap view --open [--project]        # HTML viewer with dependency graph
codekit logs app.log --trace <cid>     # follow one request through JSON logs (any stack)
codekit logs app.log --stats           # find noisy log lines
```

**Squash and rebase merges on GitHub** are detected through the API (read-only). For private repos, set a token in your environment:
- `GITHUB_TOKEN` or `GH_TOKEN`
- a fine-grained token with **Pull requests: read** and **Contents: read**

### Changing conventions
Ask the AI ("add a naming rule …"; it uses `naming_add_rule`), or edit `conventions/naming.md` / `conventions/logging.md` in the store (§5.3).

---

## 10. Updating the kit

```bash
cd /path/to/codekit-y
git pull
npm ci && npm run build
```
Then:
1. Restart your AI tools, or run `/reload-plugins` in Claude Code.
2. Re-run `codekit init …` (or `codekit init --all …`) for your repos. This refreshes the git hooks.
3. Re-run `codekit setup-tools` if the release notes mention tool config.
4. Run `codekit doctor` to confirm.

---

## 11. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Claude Code hooks do nothing; no codekit context at session start | `node` is not on the PATH Claude Code uses. On Windows, check `node --version` in **Git Bash**. Check that the repo is registered (`codekit doctor`). Hooks only act in registered repos. |
| `codekit doctor`: "repo registered ✘ not-registered" | The repo's `origin` remote does not match any registered project. Run `codekit init …` in that clone. |
| `push guard (pre-push) ✘` / `artifact guard (pre-commit) ✘` | Run `codekit init` again. If the message says `core.hooksPath is set`, your repo uses husky or lefthook. The kit keeps those hooks; the Claude Code and Cursor guards still protect you. |
| The AI says "codekit: … is an AI plan file" | Working as intended: plans go to `plan_save`. If the path is a real product folder, add it to `guard.allowPaths` (§5.3) and re-run `codekit init`. |
| Push from your own terminal is rejected | Your terminal has an agent marker set (`CLAUDECODE`, `AI_AGENT`, `CURSOR_AGENT`, `CLAUDE_CODE_ENTRYPOINT`, `CODEKIT_AGENT`), for example because it was opened from inside an AI tool. Push from a normal terminal. |
| Serena: "no active project" | You opened a parent folder, or a tool that does not start in the repo. Ask the AI to call `activate_project` with the repo root, which the session context lists. |
| Serena is slow the first time | It downloads language servers on first use. Run `codekit serena index -C <repo>` once. |
| Squash merges are not detected | Set `GITHUB_TOKEN`/`GH_TOKEN` (private repos), or set `github.apiUrl` (GitHub Enterprise). As a fallback, run `codemap merge <branch> --into <target> --pr <n>`. |
| Wrong parent for a branch (created in the GitHub UI, for example) | `codemap lineage set-parent <branch> <parent>` |
| Store push rejected / conflicts | The kit retries with `pull --rebase`. If it still fails, check your access to the store repo (`git -C ~/.codekit/stores/<project>/repo fetch`). |
| `setup-tools` says "skipped: file has comments" | Merge the printed snippet into that file by hand. The kit never rewrites commented JSON. |
| Kit logs | `~/.codekit/logs/codekit-YYYY-MM-DD.log` (JSON lines). Set `CODEKIT_LOG_PRETTY=1` to also print readable lines to stderr. |

---

## 12. Uninstall

1. **AI tools:**
   - Claude Code: `claude plugin uninstall codekit@codekit-y` (or `/plugin` inside a session) and `claude mcp remove serena --scope user`.
   - Cursor and VS Code: remove the `codemap` and `serena` entries from `~/.cursor/mcp.json`, `~/.cursor/hooks.json` and the VS Code user `mcp.json`. Delete `prompts/codekit.instructions.md`.
2. **Each source repo:**
   - Delete `.git/hooks/pre-push` and `.git/hooks/pre-commit`.
   - If `pre-push.codekit-chained` or `pre-commit.codekit-chained` exist, rename them back.
   - Remove the `# codekit` lines from `.git/info/exclude`.
3. **Your machine:** delete `~/.codekit/` (user config, store clones, caches, logs). If you want Serena's defaults back, remove `project_serena_folder_location` from `~/.serena/serena_config.yml`.

The knowledge store itself (the store repo or folder) belongs to the team. Delete it only if the whole project stops using the kit.

---

## 13. Reference

### Commands
| Command | Purpose |
|---|---|
| `codekit project create <name> --backend git\|folder [--url u] [--path p] [--default-branch b]` | Scaffold a knowledge store (once per project) |
| `codekit init --project <p> --backend git\|folder [--url u] [--path p] [--repo-name n] [-C dir]` | Register a repo (idempotent; refreshes hooks) |
| `codekit init --all --project <p> … -C <parent>` | Register every repo under a parent folder |
| `codekit setup-tools [--claude] [--cursor] [--vscode] [--no-serena] [--install-serena] [--dry-run]` | User-level AI tool config (with backups) |
| `codekit serena index [-C repo\|parent]` | Pre-index repos for Serena |
| `codekit doctor [-C dir]` | Check the whole setup |
| `codekit projects` | List registered projects and repos |
| `codekit mcp-config` | Print MCP snippets (manual setup) |
| `codekit logs [files] [--cid] [--tag] [--level] [--logger] [--service] [--grep] [--since] [--trace cid] [--stats] [--json]` | Read convention JSON logs from any stack |
| `codemap status [paths…] [--all]` | Coverage, missing and stale maps |
| `codemap lookup <paths…>` | Show maps |
| `codemap sync [--no-github]` | Detect new branches, syncs and merges; update maps |
| `codemap merge <from> --into <to> [--pr n]` | Manual map merge |
| `codemap lineage [branch]` / `codemap lineage set-parent <b> <p>` | Branch history / fix a parent |
| `codemap search <query> [--project]` | Search maps |
| `codemap report [-b branch…] [--format md\|json] [--out file]` | Coverage report from committed source |
| `codemap view [--open] [--project]` | Static HTML viewer |
| `codemap index` | Rebuild the local index |
| `codemap hook <event>` | Hook entry point (used by the plugin and the Cursor hooks) |

All `codemap` commands accept `-C <dir>` (a repo, or a parent folder for `status`/`sync`) and `--json`.

### MCP tools (server `codemap`)
- **Map:** `codemap_context`, `codemap_lookup` (also `<repo>:<path>`, or `Core/src/x.ts` from a parent folder), `codemap_write`, `codemap_search` (`scope: repo | project`)
- **Services:** `service_write`, `service_list`
- **Plans:** `plan_save`, `plan_list`
- **Naming convention:** `naming_list`, `naming_add_rule`, `naming_edit_rule`
- **Logging convention:** `logging_convention`, `logging_add_tag`, `logging_detect`, `logging_sample`, `logging_set_project`

Every tool also accepts `repoPath` and `repo` (to pick a repo when the workspace is a parent folder).

### Environment variables
| Variable | Effect |
|---|---|
| `CODEKIT_HOME` | Kit data directory (default `~/.codekit`) |
| `CODEKIT_LOG_PRETTY=1` / `CODEKIT_LOG_LEVEL` | Print kit logs to stderr / log level (`debug`, `info`, `warn`, `error`) |
| `GITHUB_TOKEN` / `GH_TOKEN` | Read-only GitHub API access for squash-merge detection |
| `CODEKIT_REPO` | Repo (or parent folder) the MCP server serves when the client sends no workspace roots |
| `CODEKIT_SERENA_PATH` | Use this Serena executable instead of searching `PATH` |
| `CODEKIT_CURSOR_DIR` / `CODEKIT_VSCODE_USER_DIR` | Non-standard Cursor / VS Code user config folders |
| `SERENA_HOME` | Serena's own data folder (default `~/.serena`) |

### Files on your machine
```
~/.codekit/
├── config.yaml                  projects, their store, your repo clones
├── stores/<project>/repo        clone of the store (git backend), on _config
├── stores/<project>/wt/<repo>/  worktrees of map branches
├── cache/<project>/<repo>/      index.json, view.html, Stop-hook session lists
├── serena/<folder>/.serena      Serena data, outside your repos
└── logs/                        kit logs (JSON lines)
```

### Repository layout (this kit)
```
src/core/        map model, storage (git | folder), sync/merge, lineage, hooks, guards, Serena, logging tools
src/cli/         codekit and codemap CLIs
src/mcp/         codemap-mcp server (stdio)
plugins/codekit/ Claude Code plugin: hooks, skills (codemap, naming, logging), bundled MCP server
logging/         reference logging implementations (node, python, java, dotnet) + adapters/ for existing loggers
templates/store/ knowledge store skeleton: codekit.yaml, rules/AGENTS.md, conventions/*.md, report workflow
test/            unit, storage contract (both backends), end-to-end, guards, multi-repo, parent folder, smoke/
```

---

## 14. Development
```bash
npm ci
npm run typecheck
npm run build
npm test                       # vitest: 268 tests, both storage backends
bash test/smoke/cli-smoke.sh   # end-to-end run of the built CLI (Linux/macOS/Git Bash)
```
- CI (`.github/workflows/ci.yml`) runs all of this on Ubuntu (Node 20, 22 and 24), on stock Ubuntu 22.04 and 24.04 images, on Windows and on macOS. It also runs the Python and Node logging samples.
- Not compiled yet: the Java and .NET logging samples and their adapter guides (`logging/java`, `logging/dotnet`, `logging/adapters/java-*`, `dotnet-*`).
