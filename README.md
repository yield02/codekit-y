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

```bash
# 1. Build the kit (once per machine)
git clone https://github.com/yield02/codekit-y.git && cd codekit-y
npm install && npm run build

# 2. Create the project's knowledge store (once per project)
#    git backend: an EMPTY internal repo
node dist/cli/codekit.js project create shop --backend git --url https://git.internal/acme/shop-codemap.git
#    or folder backend: a shared folder
node dist/cli/codekit.js project create shop --backend folder --path "\\\\NAS\\codemap\\shop"

# 3. Register your clone of the source repo (once per developer)
node dist/cli/codekit.js init --project shop --backend git --url https://git.internal/acme/shop-codemap.git -C path/to/shop

# 4. Claude Code: install the plugin from this repo (local marketplace) + Superpowers
claude plugin marketplace add path/to/codekit-y
claude plugin install codekit@codekit-y
claude plugin marketplace add obra/superpowers-marketplace
claude plugin install superpowers@superpowers-marketplace

# 5. Cursor / Copilot: user-level MCP server, push-guard hooks (Cursor), Copilot instructions
node dist/cli/codekit.js setup-tools --dry-run   # then without --dry-run

# 6. Check everything
node dist/cli/codekit.js doctor -C path/to/shop
```

Optionally run `npm link` to get `codekit`, `codemap` and `codemap-mcp` on your `PATH`.

## Commands

| Command | Purpose |
|---|---|
| `codekit project create <name> --backend git\|folder` | Scaffold a knowledge store from `templates/store` |
| `codekit init --project <name> ...` | Register a source repo (user config `~/.codekit/config.yaml`) |
| `codekit setup-tools [--cursor] [--vscode] [--dry-run]` | Write user-level Cursor/VS Code config, with backups (MCP, guard hooks, instructions) |
| `codekit mcp-config` | Print MCP snippets for Cursor and VS Code |
| `codekit doctor` | Check the setup |
| `codemap status [paths...]` | Coverage plus missing and stale maps |
| `codemap lookup <paths...>` | Show maps |
| `codemap sync [--no-github]` | Detect new branches, syncs and merges (squash PRs via the GitHub API, GET only), and update maps |
| `codemap merge <from> --into <to> [--pr N]` | Manual map merge, for squash merges |
| `codemap lineage [branch]` / `lineage set-parent <b> <p>` | Branch history |
| `codemap search <query>` | Search maps |
| `codemap report [-b branch...] [--format md\|json] [--out f]` | Coverage, missing and stale maps per branch, from committed source |
| `codemap view [--open]` | Static HTML viewer (search, detail, dependency graph) in `~/.codekit/cache` |
| `codemap hook <event>` | Claude Code hook entry point |

## MCP tools
- **Map:** `codemap_context`, `codemap_lookup`, `codemap_write`, `codemap_search`
- **Plans:** `plan_save`, `plan_list`
- **Naming convention:** `naming_list`, `naming_add_rule`, `naming_edit_rule`
- **Logging convention:** `logging_convention`, `logging_add_tag`, `logging_sample`

## Repository layout
```
src/core/        map model, hashing, storage adapters (git | folder), sync/merge, lineage, hooks, logger
src/cli/         codekit and codemap CLIs
src/mcp/         codemap-mcp server (stdio)
plugins/codekit/ Claude Code plugin: hooks (incl. push guard), skills (codemap, naming, logging), bundled MCP server
logging/         reference logging implementations: node, python (tested), java, dotnet
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
