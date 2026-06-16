---
name: xpowers-agents
description: Use when you want to spawn a specialized subagent using the standard XPowers agent prompts (test-runner, code-reviewer, codebase-investigator, internet-researcher, test-effectiveness-analyst).
---

<skill_overview>
Provides a catalog of XPowers agent prompts and a consistent way to launch them via Kimi Code CLI's built-in subagents.
</skill_overview>

<rigidity_level>
MEDIUM FREEDOM - Follow the selection and launch steps, but adapt prompts to the task.
</rigidity_level>

<when_to_use>
Use when:
- You want a dedicated subagent to run tests or commits without cluttering the main context
- You need a focused code review or test effectiveness analysis
- You need a short, bounded investigation of the codebase
- You want to offload a self-contained task and keep the main thread clean
</when_to_use>

<the_process>
## 1. Pick the right agent

Use this mapping:
- `test-runner` → `references/test-runner.md` → subagent_type `coder`
- `code-reviewer` → `references/code-reviewer.md` → subagent_type `coder`
- `codebase-investigator` → `references/codebase-investigator.md` → subagent_type `explore`
- `internet-researcher` → `references/internet-researcher.md` → subagent_type `coder`
- `test-effectiveness-analyst` → `references/test-effectiveness-analyst.md` → subagent_type `coder`

## 2. Read the prompt file

Open the relevant reference file and reuse the exact prompt text.

## 3. Spawn the agent

Use `Agent` and pass the full prompt plus the specific task.

Example:
```json
{
  "tool": "kimi_cli.tools.agent:Agent",
  "parameters": {
    "subagent_type": "coder",
    "message": "[PASTE prompt from references/test-runner.md]\n\nTask: Run `pytest tests/` and return summary + failures only."
  }
}
```

## 4. Parallel dispatch (if needed)

If you need multiple agents at once, dispatch multiple `Agent` calls with `run_in_background=true` so they run concurrently.

## 5. Integrate results

Wait for all agents to complete, then integrate their summaries into the main work. Resolve conflicts manually before making final changes.
</the_process>
