# AI rules — {{project}}

These rules apply to every AI tool (Claude Code, Cursor, GitHub Copilot) working on this project.
They live in the internal knowledge store, **not** in the source repository.

## 0. Never add AI files to the source repo
Never create, edit or commit AI files inside the source repository. That includes:
- `AGENTS.md` and `CLAUDE.md`
- `.claude/`, `.cursor/`, `.cursorrules`, `.github/copilot-instructions.md`, `.mcp.json`
- `docs/plans/`, `docs/superpowers/`
- Serena memories, notes and maps

Use the codekit MCP tools instead:
- `plan_save` for plans
- `codemap_write` for file maps
- `service_write` for the service summary

**If a skill such as Superpowers tells you to save a plan or spec under `docs/plans/` or `docs/superpowers/`, call `plan_save` instead.**
codekit enforces this rule. A `PreToolUse` guard and a local `pre-commit` hook reject these writes, and never use `--no-verify` or change `core.hooksPath` to get around them.

## 0.1 Never push the source repo (strict)
You may read, edit and commit **locally** in the source repository. You must **never** publish anything:
no `git push` (in any form), no `gh pr create/merge`, no GitHub API or MCP write calls, no pushing via aliases or nested shells.
When the work is done, tell the developer which commits are ready; they review and push themselves.
codekit enforces this with a PreToolUse guard and a `pre-push` hook — do not try to work around them.

## 1. Look before you read
1. `codemap_context` once per session (rules, conventions, coverage).
2. `codemap_lookup` for the files you are about to open. If the map is `ok`, trust it and read source only for the exact lines you need.
3. Serena symbol tools (`get_symbols_overview`, `find_symbol`, `find_referencing_symbols`) for structure.
4. Read whole source files only when the map is `missing` or `stale`.

## 2. Leave a map behind
After reading a file in depth or editing it, if its map was `missing` or `stale`, call `codemap_write`:

```markdown
## Purpose
One or two sentences: why this file exists.
## Public API
Exported functions/classes/endpoints with one line each.
## Main flow
The important path(s) through the code, in steps.
## Caveats
Gotchas, invariants, surprising behavior, TODOs.
```

- Keep it under ~60 lines. Describe *intent and behavior*, not a line-by-line copy.
- Fill `dependsOn` with the project files it relies on, and `tags` with domain tags (e.g. `auth`, `payment`).
- The server computes `sourceHash`, author and branch; do not write frontmatter yourself.

## 2.1 Multi-repo projects (microservices)
All repos of the project share this knowledge store. Each repo has its own maps and branches.
- Read another service's file map with `codemap_lookup("<repo>:<path>")`, e.g. `core:src/api/user.controller.ts`, instead of guessing its API.
- Search every service with `codemap_search` and `scope: "project"`.
- In `dependsOn`, reference other services as `<repo>:<path>`.
- Keep this service's summary current with `service_write` (sections: Purpose, Exposes, Consumes, Data owned, Notes). Other agents read it through `service_list` and in their session context.
- A change that crosses services (an API contract or an event) belongs in the plan for every repo it touches. Each repo is still edited, committed and pushed separately, and the developer does the pushing.
- When the tool is opened on a parent folder that holds several repos (e.g. `Transfer/` with `Core/` and `Admin/`), pass paths relative to that folder (`Core/src/x.ts`) or as `<repo>:<path>`. Tools without a path (`plan_save`, `service_write`, `logging_detect`) take `repo`. Commits happen inside each repo folder.

## 3. Plan with Superpowers
- Exploring code: map lookup → `brainstorming`.
- New feature / change: `brainstorming` → `writing-plans` → `executing-plans` or `subagent-driven-development`, with `test-driven-development`.
- Bug: `systematic-debugging`.
- Save every plan with `plan_save` (stored per branch in the knowledge store). Never write plans into the source repo.

## 4. Conventions
- Follow `conventions/naming.md` (see `naming_list`). To add or change a rule, use `naming_add_rule` / `naming_edit_rule` — only when the user asks.
- Follow `conventions/logging.md`: every log has a `correlationId` and `tags` from the registry. New tags go through `logging_add_tag`.
- Logging always goes through the project's existing logger (see the **Project logger** entry, or run `logging_detect`). Never add a second logging library or a parallel logger. Extend the existing one.
- Log so failures are easy to debug, without noise: one line per request or job, one `error` line per failure carrying the ids needed to reproduce it, nothing inside loops, no payloads and no secrets.
