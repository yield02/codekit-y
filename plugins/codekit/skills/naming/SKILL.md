---
name: naming
description: Apply, list, add or edit the project's naming convention rules. Use when naming new code, reviewing names, or when the user asks to add or change a naming rule.
---

# naming

The naming convention is `conventions/naming.md` in the knowledge store. It is shared by the whole team and is not in the source repo.

- **Writing or reviewing code:** call `naming_list`, optionally with `section` (`General`, `Node / TypeScript`, `Java / Spring`, `.NET`, `Python`). Apply every rule for the stack. When a name breaks a rule, cite the rule ID (for example "violates NC-302").
- **Adding a rule (only when the user asks):** collect the section, scope, rule, a correct example, an incorrect example, and optionally the linter that enforces it. Call `naming_add_rule`, which assigns the next `NC-###` ID and rejects duplicates.
- **Changing a rule:** call `naming_edit_rule` with the ID and only the fields that change.
- When the user describes a rule loosely, restate it as one precise sentence with examples, and confirm it with them before saving.
