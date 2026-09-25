---
name: codex-command-review-implementation
description: "Use when task intent matches command 'review-implementation'. Do not use for unrelated workflows."
---

# Codex Command Wrapper

This skill wraps the source file `commands/review-implementation.md` for Codex Skills compatibility.

## Usage

- Use this skill when the request matches the intent of `commands/review-implementation.md`.
- Follow the source instructions exactly.
- Do not use this skill for unrelated tasks.

## Source Content

````markdown
---
description: Review implementation was faithfully executed
---

Use the xpowers:review-implementation skill exactly as written.

Scope: $ARGUMENTS

If no scope is provided, review the current branch against its plan/epic.
````
