# Plan: AI Code Kit — AI-integrated source code management (fully separated from the source repo)

## 1. Context
The team needs a kit that helps AI tools (Claude Code, Cursor, GitHub Copilot) and developers understand a codebase quickly and consistently:
1. A codebase **map** shared between team members.
2. When the AI touches a part that has no map yet, it **writes the map** for that part (lazy — no full upfront scan).
3. **Each branch has its own map**, with a record of which branch it was checked out from; merging code also merges the map.
4. Coding and code exploration use **Superpowers** for planning.
5. A **naming convention** file that users can add to and edit.
6. **Readable logs** with mandatory `correlationId` + `tags`.

**Agreed constraints:**
- **The source repo contains no AI files at all** (map, AGENTS.md/CLAUDE.md, Cursor/Copilot rules, conventions, plans, hooks, CI). Everything lives in an **internal knowledge store** plus **user-level** configuration. The only exception: logger code (correlationId) is application code, so it lives in the source.
- The knowledge store supports **2 backends**: a **separate Git repo** or an **internal shared folder** (NAS / network drive).
- Stacks: Node/TS, Java/Spring, .NET, Python · Source host: GitHub · AI tools: Claude Code + Cursor + Copilot.

**Why Understand-Anything is not the primary map:** it must be run proactively up front, spends LLM tokens on every file, outputs one large JSON graph inside the repo, and has no per-branch merge mechanism.

## 2. Overall architecture

```
┌──────────── Developer machine ───────────────────────────────────┐
│  Source repo (clean, no AI files)       ~/.codekit/              │
│     │  current git branch                 ├─ config.yaml (project │
│     ▼                                     │   ↔ store mapping)    │
│  Claude Code ─┐                           └─ cache/<project>/     │
│  Cursor ──────┼──► codemap-mcp (MCP) ──► Storage adapter          │
│  Copilot ─────┘    + Serena MCP (LSP)       │            │        │
│  (user-level config)                        ▼            ▼        │
└──────────────────────────────────── Git backend   Folder backend ─┘
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
The AI **never reads/writes the knowledge store directly**; every operation goes through the MCP server → identical behavior across Claude/Cursor/Copilot, identical logic across both backends, and the server computes hash/branch/author itself.

| Tool | Purpose |
|---|---|
| `codemap_context()` | Detect project + branch, sync the map branch, return AI rules, naming/logging conventions, coverage |
| `codemap_lookup(paths[])` | Return maps for the given files + `missing`/`stale` flags |
| `codemap_write(path, body, dependsOn, tags)` | Write a map; the server fills in `sourceHash`, `updatedAt`, `updatedBy`, `branch` |
| `codemap_search(query)` | Search the index by tag/keyword/dependency |
| `plan_save(name, content)` / `plan_list()` | Save/read Superpowers plans per branch |
| `naming_list()` / `naming_add_rule(...)` / `naming_edit_rule(id, ...)` | Manage the naming convention |
| `logging_convention()` / `logging_add_tag(tag, desc)` | Logging standard + tag registry |

The MCP server also returns `instructions` on initialization (lookup order, workflow) so Cursor/Copilot receive the rules without any file in the repo.

### 2.3 Leave no trace in the source repo
- AI configuration is installed at **user level**: Claude plugin (user scope), `~/.cursor/mcp.json` + Cursor User Rules, VS Code user `mcp` + user instructions for Copilot.
- Every hook/plugin **activates only when the current repo's remote matches a project registered** in `~/.codekit/config.yaml`; any other repo → no-op.
- Locally generated files (`.serena/`, …) → added to `.git/info/exclude` (never committed, `.gitignore` untouched).
- No mandatory git hooks: branches/merges are **detected lazily** (section 4.3). Git hooks are optional, installed into `.git/hooks/` chaining any existing hook; skipped if the repo uses `core.hooksPath` (husky).

## 3. Knowledge store (same logical structure for both backends)

### 3.1 Git backend — internal repo `<project>-codemap`
```
branch _config                 # shared data, NOT branched per source branch
├── codekit.yaml               # source remote, stacks, exclude, enforce, merge-detection method
├── rules/AGENTS.md            # rules for AI
├── conventions/naming.md
├── conventions/logging.md     # standard + tag registry
└── .github/workflows/report.yml   # periodic coverage report (CI of the internal repo)

branch map/<source-branch>     # mirrors each source branch (e.g. map/main, map/feature__login-otp)
├── modules/**.md              # semantic map
├── lineage/<branch>.json      # checkout/sync/merge history
└── plans/YYYY-MM-DD-<name>.md # Superpowers plans for the branch
```
- Each map branch is a **git worktree** in `~/.codekit/cache/<project>/wt/<branch>` → work on several branches in parallel without switching.
- Copy on checkout = `git worktree add -b map/<b> ... map/<parent>`; merge = a real `git merge` → history, review, revert.
- Branch name normalization: `feature/login-otp` → `feature__login-otp` (avoids the `map/feature` vs `map/feature/x` ref conflict).

### 3.2 Folder backend — `\\NAS\codemap\<project>\`
```
config/  (codekit.yaml, rules/, conventions/)
branches/<branch>/
├── modules/**.md
├── lineage.json
├── plans/
└── .base-manifest.json        # hash of every map file at fork time (for 3-way merge)
history/YYYY-MM.jsonl          # append-only log: who wrote what, when, on which branch
locks/                         # TTL locks for merge/sync operations
```
- **Atomic** writes (write temp → rename) + append to `history`; maps are per file, so two people rarely write the same file.
- 3-way merge needs no base content, only `.base-manifest.json` (section 4.3).
- Backups rely on the NAS backup mechanism (documented in the operations guide).

### 3.3 Map file format
`modules/src/auth/login.service.ts.md` (mirrors the source path, 1 source file = 1 map file; optional `_dir.md` folder summaries):
```yaml
path: src/auth/login.service.ts
sourceHash: 9f2c1a7e3b41        # sha256 of LF-normalized content, 12 chars
updatedAt: 2026-10-25T09:12:03Z
updatedBy: dev-a (claude-code)
branch: feature/login-otp
dependsOn: [src/auth/token.ts, src/db/user.repo.ts]
tags: [auth]
stale: false
```
Body: `## Purpose` · `## Public API` · `## Main flow` · `## Caveats` (limit ~60 lines).
`index.json` (entry list + `dependsOn` graph + coverage) is **not stored in the knowledge store**; it is generated in `~/.codekit/cache/` (reads frontmatter only, < 1s).

## 4. Feature details

### 4.1 Shared map (requirement 1)
- All members point at the same knowledge store → same map; access is managed by internal repo permissions / NAS folder permissions.
- Viewer: `codemap view` generates a static HTML page (search + dependency graph) from the index — later phase.
- Understand-Anything: optionally run `/understand <folder>` for a dashboard; its `.ua/` output is added to `.git/info/exclude`.

### 4.2 AI writes maps for unmapped parts (requirement 2)
**Lookup order (in `rules/AGENTS.md` + MCP instructions):** `codemap_context` → `codemap_lookup` → Serena symbol tools → only then read source. After reading deeply / editing a `missing`/`stale` file → `codemap_write`.

**Claude Code — `codekit` plugin (user scope), fully automated:**
- `SessionStart` → `codemap sync` + inject rules/conventions/coverage into context (replacing an in-repo CLAUDE.md).
- `PostToolUse` matcher `Read|Edit|Write|MultiEdit|mcp__serena__.*` → record the path in `~/.codekit/cache/<project>/session/<session_id>.txt`.
- `Stop` → compare touched files with the map; if missing/stale → `{"decision":"block","reason":"..."}` asking for `codemap_write`; skipped when `stop_hook_active=true`. When complete → commit + `pull --rebase` + push the map branch (git backend) / write history (folder backend).
- `codemap` skill: uses Serena (`get_symbols_overview`, `find_referencing_symbols`) to write maps instead of reading whole files.

**Cursor / Copilot:** receive rules from MCP `instructions` + short User Rules / user instructions ("for registered projects, always call `codemap_context` first"). The spike checks user-level Cursor hooks (`~/.cursor/hooks.json`) to get behavior similar to Claude's `Stop`.

### 4.3 Per-branch map, checkout history, merge (requirement 3)
**Lazy detection** — every time the MCP server/hook runs, `codemap sync` reads the source repo's current branch:

| Event | Detection | Action |
|---|---|---|
| New branch | No map branch yet; parent from reflog (`checkout: moving from main to feature/x`), fallback: branch with the nearest merge-base | Create map branch from parent; `lineage`: `{branch, parent, baseCommit, createdBy, createdAt}` |
| Sync (main merged into feature) | New merge commit in source whose parent belongs to another branch | Merge parent map → branch map; record `{event:"sync", from, commit, at}` |
| Merge into target | GitHub API: merged PR (`head`→`base`, squash supported); fallback `git branch -r --merged`; manual fallback `codemap merge <b> --into <t>` | Merge branch map → target map; record `{event:"merge", into, pr, at}` |
| Source branch deleted after merge | No longer on the remote | Git: tag `archive/map/<b>` then delete the map branch; Folder: move to `archive/` |
| Wrong parent | — | `codemap lineage set-parent <b> <parent>` |

**Automatic map conflict resolution (both backends)** — maps are derived from code, so no human merging is needed:
1. Only one side changed (vs. base: merge-base for git, `.base-manifest.json` for folder) → take the changed side.
2. Both changed → keep the version whose `sourceHash` matches the source file content on the target after merge.
3. Neither matches → keep the newer version + set `stale: true` → the AI rewrites it when it next touches the file.

`codemap lineage <branch>` prints the history tree: where it was checked out from, sync events, where it was merged, which PR.

### 4.4 Superpowers (requirement 4)
- Install the Superpowers plugin at user level; `codekit init` checks and prompts for installation.
- Workflow (injected via SessionStart + `rules/AGENTS.md`):
  - Exploring code: `codemap_context`/`lookup` → `brainstorming`.
  - New feature: `brainstorming` → `writing-plans` → `executing-plans`/`subagent-driven-development` + `test-driven-development`.
  - Bug: `systematic-debugging`.
- **Plans are never written into the source repo**: rules require saving plans via `plan_save` → `plans/` of the current map branch (spike: confirm the default Superpowers `docs/plans` path can be overridden; if not, a `PostToolUse` hook moves the plan file into the store and removes it from the repo).
- `UserPromptSubmit` injects a short workflow reminder.
- Cursor/Copilot: a condensed workflow in the MCP instructions (brainstorm → `plan_save` → follow the plan + TDD).

### 4.5 Naming convention (requirement 5)
- `conventions/naming.md` lives in the shared area (`_config` / `config/`), not branched: a common section + one section per stack; each rule: `ID | Scope | Rule | Correct | Incorrect | enforcedBy`.
- Edit the file in the store directly, or ask the AI via `naming_add_rule`/`naming_edit_rule` (checks duplicates/conflicts, assigns a new ID); git backend → each change is a commit (PRs can be required on the internal repo); folder backend → recorded in `history`.
- Linters (`@typescript-eslint/naming-convention`, Checkstyle, `.editorconfig` IDE1006, ruff `N`) are added to the source **only when the project agrees**; by default the AI checks against the convention when writing/reviewing code.

### 4.6 Logging (requirement 6)
**Standard** (`conventions/logging.md` in the store):
- Required fields: `timestamp, level, service, correlationId, tags[], message`; optional `context{}`, `durationMs`, `error{type,message,stack}`.
- `tags` come only from the **registry** (e.g. `auth, payment, db, cache, external-api, job`); new tags are added via `logging_add_tag`.
- `correlationId`: read `X-Correlation-Id` (use `traceId` when OpenTelemetry is present), otherwise generate a UUIDv7 at the entry point (HTTP, consumer, cron); return it in a response header; propagate it to every outgoing HTTP call/message.
- Prod: single-line JSON. Dev: `09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)`.
- Wrapper API with mandatory tags: `log.info(tags, message, context?)`.

**Sample code in the kit** (`logging/<stack>/`) — the AI **generates it into the source following the project's naming convention** (the code belongs to the project, no dependency on an internal package):
| Stack | Logger | correlationId propagation |
|---|---|---|
| Node/TS | pino (+ pino-pretty in dev) | AsyncLocalStorage + Express/Nest middleware |
| Java/Spring | SLF4J + Logback + logstash-logback-encoder | MDC + `OncePerRequestFilter`, RestTemplate/WebClient interceptor |
| .NET | Serilog | `LogContext` + ASP.NET Core middleware, `DelegatingHandler` |
| Python | standard library `logging` (no new dependency) | contextvars + ASGI (FastAPI/Starlette) and Django middleware |
- `logging` skill/rule: new code must use the wrapper, tags from the registry, and log at boundaries (request in/out, external calls, errors).
- Lint rules banning raw loggers (ESLint `no-console`, ArchUnit, BannedApiAnalyzers, ruff `TID251`): optional, when the project agrees.
- `codemap`/`codemap-mcp` themselves log to this standard in `~/.codekit/logs/` (`tags: [codemap, mcp|hook|sync]`).

### 4.7 Push guard — source repos are read + local-commit only (strict)
AI agents may read, edit and commit **locally** in a registered source repo, but must **never** push or write to its remote. The developer reviews and pushes. Three independent layers enforce this:

| Layer | Covers | Mechanism |
|---|---|---|
| 1. Agent hooks | Claude Code (`PreToolUse` on `Bash`/`PowerShell`/`mcp__*`), Cursor (`beforeShellExecution`, `beforeMCPExecution` via `codekit setup-tools`) | Command analysis that denies `git push`/`send-pack`/`subtree push`/`lfs push`, push aliases (also existing repo aliases), `-C`/`cd` into the repo from elsewhere, nested shells (`bash -c`, `pwsh -Command`, `cmd /c`, `eval`, `$(…)`), encoded commands, `gh pr create/merge/…`, `gh api` writes, `curl`/`Invoke-RestMethod` writes to code-host APIs, and code-host MCP write tools. Fails closed on errors. |
| 2. `pre-push` git hook | every tool that sets an agent marker (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `AI_AGENT`, `CURSOR_AGENT`, `CODEKIT_AGENT`) | Installed locally into `.git/hooks` by `codekit init` (never committed). It chains an existing hook and does not affect pushes from the developer's own terminal. Skipped when the repo uses `core.hooksPath` (husky); `doctor` reports it. |
| 3. Kit code | `codemap`, `codemap-mcp`, hooks | `SourceRepo` runs only an allow-list of read-only git commands (`rev-parse`, `show`, `cat-file`, `ls-tree`, `log`, `config --get`, …) and throws on anything else. The GitHub integration sends GET requests only. |

- The guard cannot be disabled in `codekit.yaml`. Only individual MCP tools can be allow-listed (`guard.allowMcpTools`, e.g. issue comments).
- Copilot (VS Code) has no hook API, so `setup-tools` prints a `chat.tools.terminal.autoApprove` snippet that makes `git push` / `gh pr` always require manual approval. The rules forbid pushing, and layer 2 applies when an agent marker is present.

## 5. Kit repository — `codekit-y`
```
codekit-y/
├── src/core/             # TS: storage adapters (git | folder), map model, hash, index, sync/merge, lineage, hooks, logger
├── src/cli/              # codekit init|project create|mcp-config|doctor ; codemap status|lookup|sync|merge|lineage|search|hook
├── src/mcp/              # codemap-mcp (stdio)
├── plugins/codekit/      # Claude plugin: hooks, skills (codemap, naming, logging), bundled MCP
├── .claude-plugin/       # marketplace.json (the kit repo is a local Claude plugin marketplace)
├── templates/store/      # knowledge store skeleton: codekit.yaml, rules/AGENTS.md, conventions/*
├── logging/{node,java,dotnet,python}/   # (milestone 2)
├── fixtures/{node,java,dotnet,python}-sample/   # (milestone 2)
└── docs/
```
- Written in Node/TS as a single package (Node 20+ on developer machines; Serena needs `uv`). The plugin is named `codekit` (plugin names starting with `claude-` are rejected by the plugin validator). Hooks and the bundled MCP server run `node <kit>/dist/...`, so the kit is used from a local clone via a local marketplace.
- `StorageAdapter` interface: `refresh, readConfig, writeConfig, listBranches, hasBranch, createBranch, archiveBranch, read, write, list, baseSnapshot, commitMerge` — 2 implementations, `GitStorage` and `FolderStorage`.
- `codekit project create <name> --backend git|folder` → scaffold a knowledge store from the template.
- `codekit init` (per developer, once per project): register remote ↔ store in `~/.codekit/config.yaml`, clone the store, add `.git/info/exclude` entries, print plugin/MCP setup steps.
- `codekit doctor`: verify the setup (kit built, Serena's `uv`, store reachable, branch map).

## 6. Reporting & enforcement (no CI in the source repo)
*Implemented in milestone 2:* `codemap report` (per-branch coverage from committed source, one `git cat-file --batch` per branch) with the `codemap-report.yml` workflow template for the store repo (read-only source token, `persist-credentials: false`), and `codemap view` (static HTML: search, map detail, dependency graph).

- **Claude Code**: hard block via the `Stop` hook.
- **Cursor**: user-level hooks if the spike confirms them; otherwise soft (rules + MCP).
- **Copilot**: soft (rules + MCP).
- **Periodic report** `codemap report`: coverage, `missing`/`stale` files on active branches — runs as GitHub Actions in the internal repo (git backend, needs a token to read the source repo) or a scheduled job on an internal machine (folder backend); publishes a summary/issue.

## 7. Roadmap (2 developers)
| Phase | Scope | Duration |
|---|---|---|
| 0. Spike | Serena on 4 stacks; Claude hook payloads; Superpowers plan-path override; Cursor user hooks; Copilot user instructions; GitHub API squash-merge detection | 4 days |
| 1. Core | Map model, hash, index, `StorageAdapter` + `GitStorage` | 1.5 weeks |
| 2. MCP + Claude plugin | `codemap-mcp`, SessionStart/PostToolUse/Stop/UserPromptSubmit hooks, skills | 1.5 weeks |
| 3. Branch & merge | lazy sync, lineage, automatic merge, archiving, GitHub API | 1 week |
| 4. Folder backend | `FolderStorage`, base manifest, atomic writes, locks, history | 1 week |
| 5. Conventions & logging | `rules/` templates, `naming.md`, `logging.md`, sample code for 4 stacks (split between 2 devs) | 1.5 weeks |
| 6. Installer & integration | `codekit init/doctor`, user-level Cursor/Copilot config, `report` | 1 week |
| 7. Pilot | 1 real repo × 2–3 people (one group on git backend, one on folder backend) | 2 weeks |
| | **Total** | **~10 weeks** |

## 8. Risks & mitigations
- **Soft enforcement for Cursor/Copilot** (no CI in source) → Claude hooks + periodic reports + Cursor hooks spike.
- **Wrong parent/merge detection** (branches created in the GitHub UI, squash merges) → GitHub API + manual `lineage set-parent` / `codemap merge`.
- **Concurrent writes on the folder backend** → per-file maps + atomic writes + merge locks; recommend the git backend for teams > 5 people.
- **Map drifting from code** → `sourceHash` + `stale` flag + reports.
- **Superpowers writing plans into the source repo** → rules + a hook that moves the file; confirmed in the spike.
- **Serena slow on large Java/.NET repos** → measured in the spike; fallback `codebase-memory-mcp`/`code-graph-mcp`.
- **Knowledge store security** (maps describe customer code) → internal store, per-project permissions, never uploaded to external services.

## 9. Verification
1. **Unit tests** for `core`: CRLF/LF-normalized hashing, index, missing/stale, branch name normalization, 3-way merge (all 3 rule branches), lineage — the same suite runs against both `GitStorage` and `FolderStorage`.
2. **E2E on each fixture** (`fixtures/*-sample`), for each backend:
   - After `codekit init`: `git status` of the source repo is **completely clean** (no new files, `.gitignore` untouched).
   - Claude Code: a feature prompt touching 3–5 unmapped files → the Stop hook asks for maps; exactly those files appear in the store on the current map branch; the plan is in the store's `plans/`, not in the source repo.
   - `git checkout -b feature/x` from main → the first MCP call creates `map/feature__x` from `map/main`, with lineage showing the correct parent/baseCommit.
   - Edit the same file on main and feature/x → merge the PR (merge commit and squash) → `codemap sync` merges maps by the rules; non-matching entries get `stale: true`.
   - Cursor and Copilot: `codemap_context`/`lookup`/`write` work via user-level MCP.
   - Unregistered repo → plugin/hooks are no-ops.
3. **Logging**: call a fixture API with and without `X-Correlation-Id` → every log line for the request has the same `correlationId` and `tags`; the header is propagated to downstream services.
4. **Pilot**: compare tokens + time for the same set of questions (no map / Layer 1 / Layer 1 + Layer 2); coverage after 2 weeks; number of conflicts/stale entries per backend.
