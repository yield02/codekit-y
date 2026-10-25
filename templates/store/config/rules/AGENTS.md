# AI rules — {{project}}

These rules apply to every AI tool (Claude Code, Cursor, GitHub Copilot) working on this project.
They live in the internal knowledge store, **not** in the source repository.

## 0. Never add AI files to the source repo
Do not create or commit `AGENTS.md`, `CLAUDE.md`, `.cursor/`, `.github/copilot-instructions.md`,
plans, maps, or notes inside the source repository. Use the codekit MCP tools instead.

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
