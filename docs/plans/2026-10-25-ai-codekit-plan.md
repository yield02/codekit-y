# Plan: AI Code Kit — AI-integrated source code management (fully separated from the source repo)

*Last revised after milestone 1, milestone 2, logging adoption and multi-repo support were merged to `main` (PRs #1–#4). Section 7 records what is done and what comes next.*

## 1. Context
The team needs a kit that helps AI tools (Claude Code, Cursor, GitHub Copilot) and developers understand a codebase quickly and consistently:
1. A codebase **map** shared between team members.
2. When the AI touches a part that has no map yet, it **writes the map** for that part (lazy — no full upfront scan).
3. **Each branch has its own map**, with a record of which branch it was checked out from; merging code also merges the map.
4. Coding and code exploration use **Superpowers** for planning.
5. A **naming convention** file that users can add to and edit.
6. **Readable logs** with mandatory `correlationId` + `tags`, easy to debug without over-logging.

**Agreed constraints:**
- **The source repo contains no AI files at all** (map, AGENTS.md/CLAUDE.md, Cursor/Copilot rules, conventions, plans, hooks, CI). Everything lives in an **internal knowledge store** plus **user-level** configuration. The only exception: logger code (correlationId) is application code, so it lives in the source.
- **Source repos are read + local-commit only for AI agents: never push** (strict; see 4.7).
- The knowledge store supports **2 backends**: a **separate Git repo** or an **internal shared folder** (NAS / network drive).
- **One store per project**, shared by all of its repos (microservices such as ABC: `core`, `product`, …).
- Stacks: Node/TS, Java/Spring, .NET, Python · Source host: GitHub · AI tools: Claude Code + Cursor + Copilot.

**Why Understand-Anything is not the primary map:** it must be run proactively up front, spends LLM tokens on every file, outputs one large JSON graph inside the repo, and has no per-branch merge mechanism.

## 2. Overall architecture

```
┌──────────── Developer machine ────────────────────────────────────────┐
│  Source repos (clean, no AI files)        ~/.codekit/                 │
│  one repo, or a parent folder:            ├─ config.yaml  (project →  │
│  Transfer/{Transactions,Core,Abs,Admin}   │   store + repos + clones) │
│     │  current branch per repo            └─ cache/<project>/<repo>/  │
│     ▼                                                                  │
│  Claude Code ─┐                                                        │
│  Cursor ──────┼──► codemap-mcp (MCP) ──► StorageAdapter (scoped per repo)
│  Copilot ─────┘    + Serena MCP (LSP)        │                │       │
│  (user-level config, push guard hooks)       ▼                ▼       │
└────────────────────────────────────── Git backend      Folder backend ┘
                                       <project>-codemap   \\NAS\codemap\<project>
```

### 2.1 Two-layer map
| | Layer 1 — Structural | Layer 2 — Semantic |
|---|---|---|
| Tool | **Serena MCP** (LSP: tsserver, JDTLS, C# LS, pyright) | AI-written `.md` maps stored in the knowledge store |
| Content | symbols, references, outlines | purpose, public API, main flows, caveats, dependencies |
| Created when | queried on demand | lazily — when the AI reads/edits a file whose map is missing or stale |
| Stored where | local cache (`.serena/` excluded via `.git/info/exclude`, never committed) | knowledge store (separate git repo / shared folder) |

### 2.2 `codemap-mcp` — the single access point for all 3 AI tools
The AI **never reads/writes the knowledge store directly**; every operation goes through the MCP server, so behavior is the same across Claude/Cursor/Copilot and both backends. The server computes hash, branch and author itself. Every tool also accepts `repoPath` and `repo` (to pick a repo when the workspace is a parent folder).

| Tool | Purpose |
|---|---|
| `codemap_context()` | Detect project/repo/branch (or a parent folder), sync map branches, return AI rules, conventions, coverage and every service's summary |
| `codemap_lookup(paths[])` | Maps + status (`ok`/`missing`/`stale`/`excluded`/`not-found`/`remote`). Paths may be repo-relative, absolute, parent-relative (`Core/src/x.ts`) or another service (`core:src/x.ts`) |
| `codemap_write(path, body, dependsOn, tags)` | Write a map; `dependsOn` may reference other services as `<repo>:<path>` |
| `codemap_search(query, scope)` | Search by tag/path/dependency/text in this repo or the whole project |
| `service_write(body)` / `service_list()` | Per-repo service summary (Purpose, Exposes, Consumes, Data owned, Notes) shown to every agent of the project |
| `plan_save(name, content)` / `plan_list(name?)` | Save/read plans per repo + branch |
| `naming_list` / `naming_add_rule` / `naming_edit_rule` | Naming convention |
| `logging_convention` / `logging_add_tag` | Logging standard + tag registry |
| `logging_detect` | Read-only scan for the project's existing logging (library, in-house logger, raw calls) → adoption strategy |
| `logging_sample(stack, library?)` | Reference implementation + adoption guide for an existing library or in-house logger |
| `logging_set_project(library, entryPoint, notes)` | Record the project's logger entry point in the convention |

The MCP server also returns `instructions` on initialization (lookup order, workflow, never push), so Cursor/Copilot get the rules without any file in the repo.

### 2.3 Leave no trace in the source repo
- AI configuration is installed at **user level**: Claude plugin (user scope), `~/.cursor/mcp.json` + `~/.cursor/hooks.json` + Cursor User Rules, VS Code user `mcp.json` + user instructions for Copilot (`codekit setup-tools`).
- Every hook/tool **activates only for repos registered** in `~/.codekit/config.yaml`; any other folder → no-op.
- Local tool caches (`.serena/`, `.ua/`) → `.git/info/exclude`; the only file written into `.git/` is the local `pre-push` guard (4.7). Nothing is committed.
- Branches/merges are **detected lazily** (4.3); no git hooks are needed for maps.

## 3. Knowledge store — one per project

### 3.1 Git backend — internal repo `<project>-codemap`
```
branch _config                         # shared by every repo of the project
├── codekit.yaml                       # settings, repos (name → remote) and per-repo overrides
├── rules/AGENTS.md                    # rules for AI
├── conventions/naming.md
├── conventions/logging.md             # standard, project logger, tag registry
└── .github/workflows/codemap-report.yml   # coverage report, matrix over the project's repos

branch maps/<repo>/<branch>            # one per source repo + branch (e.g. maps/core/main, maps/product/feature__x)
├── modules/**.md                      # semantic map
├── lineage/<branch>.json              # checkout/sync/merge history
├── plans/YYYY-MM-DD-<name>.md         # plans for the branch
└── service.md                         # service summary of the repo
```
- Each map branch is a **git worktree** in `~/.codekit/stores/<project>/wt/<repo>/<branch>`, so several branches and repos can be worked on in parallel.
- Copy on checkout = new branch from `maps/<repo>/<parent>`; merge = a real `git merge` (with the resolved tree) → history, review, revert.
- Every write is committed and pushed **to the store** immediately (`pull --rebase` + retry on conflict), so tools without a Stop hook never hold unpushed maps.
- Branch name normalization: `feature/login-otp` → `feature__login-otp`. Archived branches become tags `archive/maps/<repo>/<branch>`.

### 3.2 Folder backend — `\\NAS\codemap\<project>\`
```
config/                                # codekit.yaml, rules/, conventions/
repos/<repo>/branches/<branch>/
├── modules/**.md
├── lineage/<branch>.json
├── plans/
├── service.md
└── .base-manifest.json                # hash of every map file at fork/last sync (3-way merge base)
repos/<repo>/archive/                  # archived branches
history/YYYY-MM.jsonl                  # append-only log: who wrote what, when, repo + branch
locks/                                 # TTL locks for merges
```
- **Atomic** writes (temp → rename) + `history`; maps are per file, so two people rarely write the same file. Recommended for small teams; git backend for teams > 5.
- Backups rely on the NAS backup mechanism.

### 3.3 Map file format
`modules/src/auth/login.service.ts.md` (mirrors the source path, 1 source file = 1 map file):
```yaml
path: src/auth/login.service.ts
sourceHash: 9f2c1a7e3b41        # sha256 of LF-normalized content, 12 chars
updatedAt: 2026-10-25T09:12:03Z
updatedBy: dev-a (claude-code)
branch: feature/login-otp
dependsOn: [src/auth/token.ts, core:src/api/user.ts]
tags: [auth]
stale: false
```
Body: `## Purpose` · `## Public API` · `## Main flow` · `## Caveats` (limit ~60 lines).
`index.json` (entries + `dependsOn` graph + coverage) is **not stored**; it is generated in `~/.codekit/cache/` (frontmatter only, < 1 s).

### 3.4 Multi-repo projects (microservices)
| | Shared by all repos | Per repo |
|---|---|---|
| Content | rules, naming and logging conventions, tag registry, `repos:` (name → remote, overrides) | maps, lineage, plans, `service.md` |

- **The store decides repo names.** The first `codekit init --project ABC --repo-name core` records `core → remote` in codekit.yaml. Later developers get the same name automatically, and a conflicting name is rejected.
- **Branches are per repo.** A repo's first map branch is rooted at its default branch, even when the developer starts on a feature branch.
- **Cross-service lookups:** `codemap_lookup("core:src/api/user.ts")` reads core's map. It uses the branch with the same name if it exists, otherwise core's default branch. Freshness is checked against core's clone when its path is known on this machine; otherwise the status is `remote`.
- **Service summaries** of every repo are part of each session's context. `codemap_search` (`scope: project`) and `codemap view --project` cover every repo, cross-service edges included.
- **Per-repo overrides** in codekit.yaml: `defaultBranch`, `include`, `exclude` (added to the project list), `description`.

### 3.5 Parent folder / multi-root workspace
Developers often open the whole system: `Transfer/` holding the `Transactions`, `Core`, `Abs` and `Admin` repos, or a VS Code multi-root workspace of those repos. codekit resolves such a folder to every registered repo inside it. It uses the clone paths recorded by `codekit init`, and only falls back to a shallow scan for older configs, so hooks stay fast in large unrelated folders.
- **SessionStart:** one context listing every repo (folder → repo, branch, coverage), then the project's services, rules and conventions, once per project.
- **PostToolUse / Stop:** a file is tracked under the repo that owns it. Stop lists pending maps as `<repo>:<path>`.
- **MCP:** paths may be relative to the parent (`Core/src/x.ts`), absolute, or `<repo>:<path>`. Tools without a path take `repo`. Search defaults to project scope.
- **Push guard:** from a parent folder every push-like command is denied.
- **CLI:** `codekit init --all -C Transfer --project Transfer` registers every sub-repo (named after its folder unless the store already knows it). `codemap status` / `sync` run for every repo.

## 4. Feature details

### 4.1 Shared map (requirement 1)
- All members point at the same knowledge store → same map; access via internal repo permissions / NAS folder permissions.
- `codemap view [--project]` generates a static HTML viewer (search, map detail, dependency graph) in `~/.codekit/cache`.
- Understand-Anything remains optional (`/understand <folder>`; `.ua/` is excluded locally).

### 4.2 AI writes maps for unmapped parts (requirement 2)
**Lookup order** (in `rules/AGENTS.md` + MCP instructions): `codemap_context` → `codemap_lookup` → Serena symbol tools → only then read source. After reading deeply / editing a `missing`/`stale` file → `codemap_write`.

**Claude Code — `codekit` plugin (user scope):**
- `SessionStart` → `codemap sync` (+ GitHub PR check) for the repo or every repo of a parent folder, and inject rules/conventions/services/coverage into context.
- `UserPromptSubmit` → short workflow reminder (map, plan, conventions, never push).
- `PreToolUse` (`Bash`, `PowerShell`, `mcp__*`) → push guard (4.7).
- `PostToolUse` (`Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, Serena tools) → record the file in `~/.codekit/cache/<project>/<repo>/session/<session_id>.txt` of the repo that owns it.
- `Stop` → touched files with missing/stale maps → `{"decision":"block"}` (`enforce: fail`) or a warning (`enforce: warn`); skipped when `stop_hook_active`.
- Skills: `codemap`, `naming`, `logging`.

**Cursor / Copilot:** MCP `instructions` + user rules/instructions (`codekit setup-tools`). Cursor also gets the push guard through user-level hooks. Neither tool has a Stop hook, so map completeness relies on the rules and on the periodic report.

### 4.3 Per-branch map, checkout history, merge (requirement 3)
**Lazy detection.** Every SessionStart and the first MCP call per repo and branch runs `codemap sync`:

| Event | Detection | Action |
|---|---|---|
| New branch | No map branch yet; parent from the HEAD reflog (`checkout: moving from main to feature/x`), fallback: nearest merge-base | Create from the parent's map; lineage `{branch, parent, baseCommit, createdBy, createdAt}` |
| Sync (parent merged into branch) | Parent tip is an ancestor of HEAD and newer than the last sync | Merge parent map → branch map; event `sync` |
| Merge into parent | Branch tip is an ancestor of the parent tip (local or `origin/` refs) | Merge branch map → parent map; event `merge` |
| Squash / rebase merge | GitHub API, GET only: merged PR `head` → `base` (GitHub Enterprise via `github.apiUrl`), checked at most every `checkIntervalMinutes` | Same as merge, with the PR number |
| Other cases | — | `codemap merge <b> --into <t> [--pr N]`, `codemap lineage set-parent <b> <p>` |
| Source branch deleted after merge | No local or `origin/` ref left | Archive the map branch |

**Automatic map conflict resolution:**
1. Only one side changed (vs. the merge-base / base manifest) → take that side.
2. Both changed → keep the version whose `sourceHash` matches the source after the merge.
3. Neither matches → keep the newer one and flag it `stale` for the AI to rewrite.

Lineage files are unioned. Conflicting plans are kept side by side (`<name>.from-<branch>.md`). `codemap lineage <branch>` prints the history tree.

### 4.4 Superpowers (requirement 4)
- Superpowers is installed at user level (`codekit init` prints the commands).
- Workflow (SessionStart + `rules/AGENTS.md`): explore → `brainstorming`; feature → `brainstorming` → `writing-plans` → `executing-plans`/`subagent-driven-development` + `test-driven-development`; bug → `systematic-debugging`.
- **Plans are never written into the source repo.** They are saved with `plan_save` into `plans/` of the repo's map branch.
  - **Open gap:** Superpowers itself writes plans to `docs/plans/` (or `docs/superpowers/`) inside the repo, and today only the rules forbid that.
  - **Next step (7.2):** deny AI-artifact writes in registered repos through `PreToolUse` and redirect them to `plan_save`.
- Cursor/Copilot get a condensed workflow in the MCP instructions.

### 4.5 Naming convention (requirement 5)
- `conventions/naming.md` in the shared config area: a common section + one section per stack; each rule `ID | Scope | Rule | Correct | Incorrect | enforcedBy`.
- Edited in the store directly or via `naming_add_rule` / `naming_edit_rule` (duplicate check, next `NC-###` ID); git backend → one commit per change.
- Linters (`@typescript-eslint/naming-convention`, Checkstyle, `.editorconfig` IDE1006, ruff `N`) only when the project agrees; otherwise the AI checks names against the convention.

### 4.6 Logging (requirement 6)
**Standard** (`conventions/logging.md`):
- **Fields:** `timestamp, level, service, logger, correlationId, tags[], message`, plus optional `context{}`, `durationMs`, `error{type,message,stack}`.
- **Levels:** `debug` is off in production.
- **What to log / what not to log:**
  - one line per request or job
  - one `error` per failure, carrying the ids needed to reproduce it
  - no logging in loops, no log-and-rethrow, no payloads, no secrets
- **correlationId:** taken from `X-Correlation-Id`, else the OpenTelemetry trace id, else a new UUIDv7. It is returned in the response and propagated on outgoing calls.
- **Output:** production writes single-line JSON. Development writes `09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)`.

**Reference implementations** (`logging/<stack>/`, served by `logging_sample`). The AI adapts them into the source using the project's naming:

| Stack | Logger | correlationId propagation | Verified |
|---|---|---|---|
| Node/TS | pino | AsyncLocalStorage + middleware, `fetch`/axios | tests run |
| Python | standard library `logging` | contextvars + ASGI/Django middleware, requests/httpx | tests run |
| Java/Spring | SLF4J + Logback + logstash-logback-encoder | MDC + filter, RestTemplate/RestClient/WebClient | not compiled |
| .NET | Serilog | LogContext + middleware, `DelegatingHandler` | not compiled |

- The wrapper enforces the rules in code: a `logger` field on every line, redaction and size limits on `context`, the cause chain in `error.stack`, repeated errors collapsed (1 per 60 s), one request line (`warn` when slow). Node and Python implement all of these; Java and .NET implement the request line only.
- **Projects that already log** (a library or their own logger) never get a second logger. `logging_detect` returns `in-house` / `library` / `reference-sample`. The adoption guides in `logging/adapters/` cover in-house loggers, log4j2, NLog, Microsoft.Extensions.Logging, winston, bunyan, loguru and structlog. Old calls default to tag `legacy`. `logging_set_project` records the entry point.
- **`codekit logs`** reads JSON logs from any stack. It filters by correlationId (also the short id), tag, level, logger, text and time. `--trace <cid>` shows one request's timeline, and `--stats` prints a noise report with over-logging hints.

### 4.7 Push guard — source repos are read + local-commit only (strict)
| Layer | Covers | Mechanism |
|---|---|---|
| 1. Agent hooks | Claude Code `PreToolUse`, Cursor `beforeShellExecution` / `beforeMCPExecution` | Denies `git push` in any form: aliases (including existing repo aliases), `-C` or `cd` into the repo, nested shells, `eval`, `$(…)`, encoded commands, and scripts run through a shell. Also denies `gh pr create/merge/…`, `gh api` writes, `curl`/`Invoke-RestMethod` writes to code hosts, and code-host MCP write tools. From a parent folder every push-like command is denied. Fails closed. |
| 2. `pre-push` git hook | any process with an agent marker (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `AI_AGENT`, `CURSOR_AGENT`, `CODEKIT_AGENT`) | Installed by `codekit init` into `.git/hooks`. Chains an existing hook. Not installed when `core.hooksPath` is set (`doctor` reports it). |
| 3. Kit code | codemap, codemap-mcp, hooks | `SourceRepo` runs an allow-list of read-only git commands. GitHub calls are GET only. |

The guard cannot be disabled; only individual MCP tools can be allow-listed (`guard.allowMcpTools`). Copilot has no hook API: `setup-tools` prints a `chat.tools.terminal.autoApprove` snippet that forces manual approval of pushes.

## 5. Kit repository — `codekit-y`
```
codekit-y/
├── src/core/        storage (git | folder, scoped per repo), map model, hash, index, sync/merge, lineage,
│                    hooks, push guard, parent-folder resolution, GitHub, report, view, logging detection, log viewer
├── src/cli/         codekit: project create · init [--all] · setup-tools · mcp-config · logs · projects · doctor
│                    codemap: status · lookup · sync · index · search · merge · report · view · lineage · hook
├── src/mcp/         codemap-mcp (stdio)
├── plugins/codekit/ Claude plugin: hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop), skills, bundled MCP
├── .claude-plugin/  marketplace.json (the kit repo is a local plugin marketplace)
├── templates/store/ knowledge store skeleton: codekit.yaml, rules/AGENTS.md, conventions/*, report workflow
├── logging/         reference implementations (node, python, java, dotnet) + adapters/ guides
├── test/            unit, storage contract (both backends), e2e, guard, GitHub, report, logging, multi-repo, parent folder
└── docs/plans/      this plan
```
- Node/TS single package (Node 20+ on developer machines; Serena needs `uv`). The plugin is used from a local clone through a local marketplace (`node <kit>/dist/...`).
- `StorageAdapter`: `forRepo`, `listRepos`, `refresh`, `readConfig`/`writeConfig`, `listBranches`, `hasBranch`, `createBranch`, `archiveBranch`, `read`/`write`/`list`, `baseSnapshot`, `commitMerge`, `localPath`.

## 6. Reporting & enforcement
- **Claude Code:** hard block via the Stop hook. **Cursor:** push guard via hooks; maps via rules. **Copilot:** rules + manual approval of pushes.
- **`codemap report`:** coverage and missing/stale maps per branch from committed source. The store repo's `codemap-report.yml` runs it on a schedule as a matrix over `SOURCE_REPOSITORIES`, with a read-only source token and `persist-credentials: false`. Folder backend: a scheduled job on an internal machine.

## 7. Status and next steps

### 7.1 Done (merged to `main`)
| PR | Scope |
|---|---|
| #1 Milestone 1 | Core (map model, hash, index), git + folder backends, lazy branch/sync/merge detection, automatic conflict resolution, lineage, CLI, MCP server, Claude plugin (hooks + skills), store templates |
| #2 Milestone 2 | Push guard (3 layers), GitHub API squash-merge detection, `report` + CI template, `view`, `setup-tools` (Cursor/VS Code), logging reference implementations for 4 stacks |
| #3 Logging adoption | `logging_detect`, adapter guides for 8 libraries/in-house loggers, `logging_set_project`, debug/noise rules in the wrappers, `codekit logs` (`--trace`, `--stats`) |
| #4 Multi-repo | One store per project, per-repo maps/branches, store-owned repo names, cross-service lookups, service summaries, project view/search, parent-folder and multi-root workspaces, `init --all` |

187 automated tests run for both backends. Smoke tests ran the real CLI and the MCP server over stdio on a single repo, on a two-service project, and on a parent folder.

### 7.2 Next steps (in order)
| # | Step | Why | Size |
|---|---|---|---|
| 1 | **Block AI artifacts in source repos**: `PreToolUse` denies `Write`/`Edit` to `docs/plans/**`, `docs/superpowers/**`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `.cursor/**`, `.github/copilot-instructions.md`, … in registered repos and points to `plan_save` / the store. Same for Cursor (`beforeShellExecution` cannot see file writes → rules + report check). | Closes the Superpowers gap (4.4); today only rules enforce "no AI files in the source repo" | 1–2 days |
| 2 | **Serena wiring**: `setup-tools` adds the Serena MCP server (when `uv` is present) for Claude/Cursor/VS Code; `doctor` checks it | Layer 1 of the map is documented but not configured by the kit | 1 day |
| 3 | **Live verification spike** on a real machine with Claude Code, Cursor and VS Code: plugin install + hooks in a real session, Cursor hook payload names, Copilot user-instruction loading, Serena start-up time on each stack | Several integrations are written to the docs but untested in the real tools | 2–3 days |
| 4 | **Compile the Java and .NET samples** and the log4j2/NLog/MEL guides on a machine with JDK 17+/.NET 8 SDK; add the same redaction, size limits and repeat collapse that Node/Python have | Not compiled so far | 2–3 days |
| 5 | **Pilot** on the Transfer project (Transactions, Core, Abs, Admin) with 2–3 developers for 2 weeks, git backend | Real numbers: tokens and time per question with and without maps, coverage growth, conflicts/stale entries, guard false positives, hook latency | 2 weeks |
| 6 | Rollout guide: team onboarding (`project create` once, `init --all` per developer, `setup-tools`), store permissions, backup | After the pilot | 1 day |

## 8. Risks & mitigations
- **AI files written into the source repo** (Superpowers plans, rule files): rules today; `PreToolUse` deny in step 7.2-1.
- **Soft map enforcement for Cursor/Copilot** (no Stop hook): rules, periodic report, pilot data.
- **Copilot push protection is weaker** (no hooks): manual-approval setting, rules, and the pre-push hook when an agent marker is present.
- **Repos using `core.hooksPath`** (husky) do not get layer 2 of the push guard: `doctor` reports it, and layers 1 and 3 still apply.
- **Wrong parent/merge detection** (branches created in the GitHub UI, squash merges): GitHub API, `lineage set-parent`, manual `codemap merge`.
- **Concurrent writes on the folder backend**: per-file maps, atomic writes, merge locks; recommend the git backend for teams > 5.
- **Map drift**: `sourceHash`, the `stale` flag, reports.
- **Store layout changed** in PR #4 (`maps/<repo>/<branch>`, `repos/<repo>/…`): stores made earlier must be recreated (none are in use).
- **Java/.NET samples not compiled**: step 7.2-4.
- **Serena slow on large Java/.NET repos**: measured in step 7.2-3; fallback `codebase-memory-mcp` / `code-graph-mcp`.
- **Knowledge store security** (maps describe customer code): internal store, per-project permissions, never uploaded to external services.

## 9. Verification
1. **Automated (in place, `npm test`):**
   - unit tests
   - a storage contract suite run for both backends
   - e2e for maps, branches, merges, conflicts, squash merges and hooks
   - push guard: about 80 command cases, plus a real `pre-push` run with and without agent markers
   - the read-only git allow-list
   - GitHub detection (GET only)
   - report and view
   - setup-tools merging and backups
   - logging detection and the log viewer
   - multi-repo projects and parent folders
   - Node and Python sample tests (`node --test`, `python -m unittest`)
2. **Still to run (7.2-3/4/5):**
   - in real Claude Code / Cursor / VS Code sessions: `git status` of every source repo stays clean; a feature prompt touching unmapped files ends with those maps in the store; plans land in the store
   - every push attempt is blocked
   - compile the Java and .NET samples
   - pilot metrics: tokens and time per question (no map / Layer 1 / Layer 1 + 2), coverage after 2 weeks, conflicts and stale entries, hook latency in a parent folder with 4 repos
