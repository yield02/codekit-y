---
name: codemap
description: Read and write the project's codebase map (stored outside the source repo). Use before exploring source files, and whenever the codekit Stop hook reports files whose map is missing or stale.
---

# codemap

The map lives in the project's knowledge store, one Markdown file per source file and one map branch per git branch. Never write map files, plans or notes into the source repository; always go through the codemap MCP tools.

## Before reading code
1. If you have not done so this session, call `codemap_context` to load the project rules and conventions.
2. Call `codemap_lookup` with every file you plan to open.
   - `ok`: trust the map, and open the source only for the exact lines you need.
   - `missing` or `stale`: read the source. Use Serena `get_symbols_overview` and `find_referencing_symbols` first, so you only read what matters.
3. To find where something lives, try `codemap_search` (by tag, path or keyword) before grepping.

## Other services (multi-repo projects)
- When code calls another service, read that service's map instead of guessing: `codemap_lookup("core:src/api/user.controller.ts")`.
  - A status of `remote` means the map exists but that repo is not cloned here, so trust it as documentation only.
- Use `codemap_search` with `scope: "project"` to find where something lives across services.
- `service_list` shows what each service exposes and consumes.
- In a parent folder that holds several repos (for example `Transfer/` with `Core/`, `Admin/`…), write paths as `Core/src/x.ts` or `core:src/x.ts`. Give `repo` to `service_write` and `plan_save`.
- If this repo's service summary is missing or out of date, write it with `service_write`. Use these sections: Purpose, Exposes, Consumes, Data owned, Notes.

## Writing a map
For each file that the Stop hook lists, and for any `missing` or `stale` file you read in depth or edited, call `codemap_write`:

- `path`: the source file.
- `body`: exactly these sections, under ~60 lines:
  ```markdown
  ## Purpose
  ## Public API
  ## Main flow
  ## Caveats
  ```
- `dependsOn`: the project files it imports or calls (not third-party packages). Write another service's file as `<repo>:<path>`.
- `tags`: domain tags (`auth`, `payment`, `db`…), reusing tags that already appear in the map.

Describe intent, contracts and non-obvious behavior. Do not paste code, and do not write frontmatter; the server adds the hash, author and branch.

Batch the work: write every pending map, then stop. If one file is generated or vendored and does not deserve a map, say so to the user. They can add it to `exclude` in `codekit.yaml`.
