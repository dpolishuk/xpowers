---
name: codex-command-write-plan
description: "Use when task intent matches command 'write-plan'. Do not use for unrelated workflows."
---

# Codex Command Wrapper

This skill wraps the source file `commands/write-plan.md` for Codex Skills compatibility.

## Usage

- Use this skill when the request matches the intent of `commands/write-plan.md`.
- Follow the source instructions exactly.
- Do not use this skill for unrelated tasks.

## Source Content

````markdown
---
description: Create detailed implementation plan with bite-sized tasks
---

Use the xpowers:writing-plans skill exactly as written.

Planning topic: $ARGUMENTS

If no topic is provided, ask the user for the feature or goal to plan before proceeding.
````
