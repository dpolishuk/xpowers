---
name: codex-command-brainstorm
description: "Use when task intent matches command 'brainstorm'. Do not use for unrelated workflows."
---

# Codex Command Wrapper

This skill wraps the source file `commands/brainstorm.md` for Codex Skills compatibility.

## Usage

- Use this skill when the request matches the intent of `commands/brainstorm.md`.
- Follow the source instructions exactly.
- Do not use this skill for unrelated tasks.

## Source Content

````markdown
---
description: Interactive design refinement using Socratic method
---

Use the xpowers:brainstorming skill exactly as written.

Topic: $ARGUMENTS

If no topic is provided, ask the user for the topic with a single question before proceeding.
````
