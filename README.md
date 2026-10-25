# codekit-y — AI Code Kit

A kit for AI-assisted source code management. It helps AI tools (Claude Code, Cursor, GitHub Copilot) and developers understand a codebase quickly and consistently, without adding any AI files to the source repository.

## Goals
1. **Shared codebase map** that every team member and AI tool can read.
2. **Lazy mapping**: when the AI touches code that has no map yet, it writes the map for that part. There is no full upfront scan.
3. **Per-branch maps**: a new branch starts from its parent's map, the checkout history is recorded, and maps are merged when code is merged.
4. **Planning with Superpowers** for coding and code exploration.
5. **Editable naming convention** that users can extend.
6. **Readable logs** with a mandatory `correlationId` and `tags`.

## Key design points
- **Two-layer map**
  - Structural layer: Serena MCP (LSP-based, on demand, local cache only).
  - Semantic layer: AI-written Markdown maps, one per source file, tracked by `sourceHash` and flagged `stale` when the code changes.
- **Knowledge store separate from the source repo.** The store is either a dedicated internal Git repo (one map branch per source branch) or an internal shared folder. The source repo stays clean.
- **`codemap-mcp`** is the single access point for all three AI tools. All configuration is user-level.

## Documents
- [Implementation plan](docs/plans/2026-10-25-ai-codekit-plan.md)
