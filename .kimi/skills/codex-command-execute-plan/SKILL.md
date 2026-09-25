---
name: codex-command-execute-plan
description: "Use when task intent matches command 'execute-plan'. Do not use for unrelated workflows."
---

# Codex Command Wrapper

This skill wraps the source file `commands/execute-plan.md` for Codex Skills compatibility.

## Usage

- Use this skill when the request matches the intent of `commands/execute-plan.md`.
- Follow the source instructions exactly.
- Do not use this skill for unrelated tasks.

## Source Content

````markdown
---
description: Execute plan in batches with review checkpoints
---

Use the xpowers:executing-plans skill exactly as written.

Execution context: $ARGUMENTS

If no context is provided, resume from current bd state.

**Resumption:** This command supports explicit resumption. Run it multiple times to continue execution:

1. First run: Executes first ready task  STOP
2. User reviews implementation, clears context
3. Next run: Resumes from bd state, executes next task  STOP
4. Repeat until epic complete

**Checkpoints:** Each task execution ends with a STOP checkpoint. User must run this command again to continue.
````
