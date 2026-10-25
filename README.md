# codekit-y — AI Code Kit

A kit for AI-assisted source code management. It helps AI tools (Claude Code, Cursor, GitHub Copilot) and developers understand a codebase quickly and consistently, without adding any AI files to the source repository.

## Goals
1. **Shared codebase map** that every team member and AI tool can read.
2. **Lazy mapping.** When the AI touches code that has no map yet, it writes the map for that part. There is no full upfront scan.
3. **Per-branch maps.** A new branch starts from its parent's map, the checkout history is recorded, and maps are merged together with the code.
4. **Planning with Superpowers** for coding and code exploration.
5. **Editable naming convention** that users can extend.
6. **Readable logs** with a mandatory `correlationId` and `tags`.

## How it works
- **Two-layer map**
  - Structural layer: Serena MCP. It is LSP-based, runs on demand, and keeps only a local cache.
  - Semantic layer: AI-written Markdown maps, one per source file. Each map records a `sourceHash` and is flagged `stale` when the code changes.
- **Knowledge store, outside the source repo.** It is either a dedicated internal Git repo or an internal shared folder, and it holds:
  - maps
  - branch lineage
  - plans
  - AI rules
  - the naming and logging conventions

  The source repo stays clean. Local tool caches are ignored through `.git/info/exclude`.
- **Multi-repo projects (microservices).** All repos of a project (e.g. ABC: `core`, `product`, …) share **one** knowledge store, with one set of rules and conventions.
  - Each repo keeps its own maps and branches in that store (`maps/<repo>/<branch>`).
  - Agents read other services' maps with `codemap_lookup("core:src/…")` and search every service at once.
  - Each service has a summary (`service_write`) that appears in every agent's context.
  - `codemap view --project` draws the whole system.
- **Artifact guard.** No AI files go into source repos. Agents cannot create or change `AGENTS.md`, `CLAUDE.md`, `.cursor/`, `.claude/`, `.github/copilot-instructions.md`, `docs/plans/`, `docs/superpowers/`, Serena memories and similar files.
  - This applies to file tools, shell commands and MCP tools alike.
  - A local `pre-commit` hook rejects agent commits that include such files.
  - Hook bypasses (`--no-verify`, `core.hooksPath`) are denied.
  - `codemap report` flags AI files that slipped through anyway.
  - Plans go to `plan_save`, even when Superpowers asks for `docs/plans/`.
- **Parent folder or multi-root workspace.** You can open the AI tool on `Transfer/` (holding `Transactions/`, `Core/`, `Abs/`, `Admin/`) or on a VS Code multi-root workspace of those repos.
  - Every path is routed to its own repo: `Core/src/x.ts` and `core:src/x.ts` both work.
  - Session context covers every repo, and the Stop hook lists missing maps per repo.
  - Every push-like command is denied.
- **Serena (structural layer)** is set up by `codekit setup-tools` for Claude Code, Cursor and VS Code, using the classic tool interface with memories off. The dashboard does not pop up, and Serena's `.serena/` data stays outside the repos. Run `codekit serena index` once for large repos.
- **`codemap-mcp`** is the single access point for all three AI tools. All configuration lives at user level.
- **Claude Code plugin** (`codekit`):
  - `SessionStart` syncs and injects the rules.
  - `PostToolUse` tracks the files the AI touches.
  - `Stop` asks for any missing or stale maps.
  - `UserPromptSubmit` adds a workflow reminder.

- **Push guard.** In a registered source repo, AI agents may read, edit and commit locally, but they can **never push** or write to the remote. Three independent layers enforce this:
  1. A Claude Code `PreToolUse` hook and Cursor `beforeShellExecution`/`beforeMCPExecution` hooks deny `git push` in every form. That includes aliases, `-C`/`cd` into the repo, nested shells and `eval`. They also deny PR create/merge, GitHub API writes and code-host MCP write tools.
  2. A local `pre-push` git hook, installed by `codekit init`, rejects pushes from any process that has an agent marker (`CLAUDECODE`, `AI_AGENT`, …). It chains any existing hook.
  3. The kit itself only runs an allow-list of read-only git commands against source repos.

See the [implementation plan](docs/plans/2026-10-25-ai-codekit-plan.md) for the full design.

## Quick start

Requirements: Node.js 20+ and git on `PATH`. Serena additionally needs `uv`.
- **Tested in CI** on every push (see `.github/workflows/ci.yml`):
  - Ubuntu with Node 20, 22 and 24
  - stock `ubuntu:22.04` (distribution Git 2.34 and Python 3.10) and `ubuntu:24.04` images
  - Windows and macOS
- **Linux:** the `nodejs` package in Ubuntu's apt is too old. Install Node 20+ from NodeSource, nvm or fnm. Distribution git works (2.5+).
- **Git hooks:** the `pre-push` and `pre-commit` guards are POSIX `sh` scripts. Git for Windows runs them with its own `sh`.

```bash
# 1. Build the kit (once per machine)
git clone https://github.com/yield02/codekit-y.git && cd codekit-y
npm install && npm run build

# 2. Create the project's knowledge store (once per project)
#    git backend: an EMPTY internal repo
node dist/cli/codekit.js project create shop --backend git --url https://git.internal/acme/shop-codemap.git
#    or folder backend: a shared folder
node dist/cli/codekit.js project create shop --backend folder --path "\\\\NAS\\codemap\\shop"

# 3. Register your clone of each source repo (once per developer and repo).
#    Microservices: every repo of the project uses the SAME --project and store.
node dist/cli/codekit.js init --project ABC --backend git --url https://git.internal/abc/abc-codemap.git -C path/to/abc-core --repo-name core
node dist/cli/codekit.js init --project ABC --backend git --url https://git.internal/abc/abc-codemap.git -C path/to/abc-product --repo-name product
#    (later developers can omit --repo-name: the store remembers each repo's name)
#    Or register every repo of a parent folder at once (named after their folders):
node dist/cli/codekit.js init --all --project Transfer --backend git --url https://git.internal/transfer/transfer-codemap.git -C path/to/Transfer

# 4. Claude Code: install the plugin from this repo (local marketplace) + Superpowers
claude plugin marketplace add path/to/codekit-y
claude plugin install codekit@codekit-y
claude plugin marketplace add obra/superpowers-marketplace
claude plugin install superpowers@superpowers-marketplace

# 5. Serena + Cursor / Copilot / Claude Code user-level config (MCP servers, push-guard hooks, instructions)
node dist/cli/codekit.js setup-tools --dry-run   # then without --dry-run; add --install-serena if Serena is missing

# 6. Check everything
node dist/cli/codekit.js doctor -C path/to/shop
```

Optionally run `npm link` to get `codekit`, `codemap` and `codemap-mcp` on your `PATH`.

## Commands

| Command | Purpose |
|---|---|
| `codekit project create <name> --backend git\|folder` | Scaffold a knowledge store from `templates/store` |
| `codekit init --project <name> ...` | Register a source repo (user config `~/.codekit/config.yaml`) |
| `codekit setup-tools [--claude] [--cursor] [--vscode] [--no-serena] [--install-serena] [--dry-run]` | User-level config for Claude Code, Cursor and VS Code, with backups: codemap + Serena MCP servers, guard hooks, instructions, Serena global config |
| `codekit serena index [-C repo\|parent]` | Index repos once so Serena's first symbol lookup is fast |
| `codekit mcp-config` | Print MCP snippets for Cursor and VS Code |
| `codekit doctor` | Check the setup |
| `codekit logs [files] [--cid] [--tag] [--level] [--trace <cid>] [--stats]` | Read convention JSON logs from any stack: filter, trace one request, or run a noise report |
| `codemap status [paths...]` | Coverage plus missing and stale maps |
| `codemap lookup <paths...>` | Show maps |
| `codemap sync [--no-github]` | Detect new branches, syncs and merges (squash PRs via the GitHub API, GET only), and update maps |
| `codemap merge <from> --into <to> [--pr N]` | Manual map merge, for squash merges |
| `codemap lineage [branch]` / `lineage set-parent <b> <p>` | Branch history |
| `codemap search <query> [--project]` | Search maps (of this repo, or of every repo in the project) |
| `codemap report [-b branch...] [--format md\|json] [--out f]` | Coverage, missing and stale maps per branch, from committed source |
| `codemap view [--open] [--project]` | Static HTML viewer (search, detail, dependency graph) for this repo or the whole project |
| `codemap hook <event>` | Claude Code hook entry point |

## MCP tools
- **Map:** `codemap_context`, `codemap_lookup` (also `<repo>:<path>`), `codemap_write`, `codemap_search` (`scope: project`)
- **Services:** `service_write`, `service_list`
- **Plans:** `plan_save`, `plan_list`
- **Naming convention:** `naming_list`, `naming_add_rule`, `naming_edit_rule`
- **Logging convention:** `logging_convention`, `logging_add_tag`, `logging_detect`, `logging_sample` (with an adoption guide for an existing library or in-house logger), `logging_set_project`

## Repository layout
```
src/core/        map model, hashing, storage adapters (git | folder), sync/merge, lineage, hooks, logger
src/cli/         codekit and codemap CLIs
src/mcp/         codemap-mcp server (stdio)
plugins/codekit/ Claude Code plugin: hooks (incl. push guard), skills (codemap, naming, logging), bundled MCP server
logging/         reference logging implementations (node, python tested; java, dotnet) + adapters/ guides for existing libraries and in-house loggers
templates/store/ knowledge store skeleton: codekit.yaml, rules/AGENTS.md, conventions/*.md
test/            unit, storage-contract (both backends) and end-to-end tests
```

## Development
```bash
npm test          # vitest
npm run typecheck
npm run build
```

Kit logs go to `~/.codekit/logs/` as JSON lines that carry a `correlationId` and `tags`. Set `CODEKIT_LOG_PRETTY=1` to also print them to stderr in readable form.

## Status
**Milestone 1:**
- core
- both backends
- lazy branch, sync and merge detection
- automatic map conflict resolution
- CLI
- MCP server
- Claude Code plugin
- store templates
- tests

**Milestone 2:**
- push guard (3 layers)
- squash/rebase PR merge detection through the GitHub API (read-only)
- `codemap report` with a CI workflow template for the store repo
- `codemap view`
- `codekit setup-tools` for Cursor and VS Code/Copilot
- logging reference implementations for 4 stacks

Not verified on the development machine:
- Java and .NET samples. No JDK or .NET SDK was available, so they were not compiled.
- Cursor hook payload names and Copilot user-instruction loading. Confirm both in a pilot.
