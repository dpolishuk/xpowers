---
name: codex-command-analyze-tests
description: "Use when task intent matches command 'analyze-tests'. Do not use for unrelated workflows."
---

# Codex Command Wrapper

This skill wraps the source file `commands/analyze-tests.md` for Codex Skills compatibility.

## Usage

- Use this skill when the request matches the intent of `commands/analyze-tests.md`.
- Follow the source instructions exactly.
- Do not use this skill for unrelated tasks.

## Source Content

````markdown
---
description: Audit test quality - identify tautological tests, coverage gaming, missing corner cases
---

Use the xpowers:analyzing-test-effectiveness skill exactly as written.

Scope: $ARGUMENTS

If no scope is provided, analyze test quality across the repository.
````
