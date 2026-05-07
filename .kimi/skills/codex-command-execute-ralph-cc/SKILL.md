---
name: codex-command-execute-ralph-cc
description: "Use when task intent matches command 'execute-ralph-cc'. Do not use for unrelated workflows."
---

# Codex Command Wrapper

This skill wraps the source file `commands/execute-ralph-cc.md` for Codex Skills compatibility.

## Usage

- Use this skill when the request matches the intent of `commands/execute-ralph-cc.md`.
- Follow the source instructions exactly.
- Do not use this skill for unrelated tasks.

## Source Content

````markdown
---
name: execute-ralph-cc
description: "Execute entire bd epic autonomously via ScheduleWakeup task-per-turn loop. Claude Code only. No stop hooks."
type: flow
---

# Usage

```text
/xpowers:execute-ralph-cc [--reviewer-model=opus|sonnet]
```

## Arguments

- `--reviewer-model`: Model for autonomous-reviewer (optional)
  - `opus` (default): Highest capability, thorough review
  - `sonnet`: Faster, balanced quality

## What This Does

Executes a complete bd epic autonomously using Claude Code's native `ScheduleWakeup` tool instead of stop hooks. Each turn processes exactly one task, then schedules a wake-up for the next:

1. **Phase 0 - State Recovery:** Every wake-up starts here. Reads all state from bd/tm (epic, tasks, criteria). Fully idempotent -- any wake-up reconstructs context from bd/tm alone.
2. **Phase 1 - Get Task & Refine:** Uses `bv --robot-triage` output from Phase 0 to determine next task. Claims or auto-creates the next task. Runs SRE refinement.
3. **Phase 2 - Dispatch Subagent:** Records `PRE_SHA`, dispatches Agent tool with subagent-driven-development protocol. Verifies SHA drift and task status.
4. **Phase 3 - Post-Task Check:** Quick review. Re-reads epic criteria. If criteria unmet, calls `ScheduleWakeup(60s)` and ends turn. If criteria met, proceeds to Phase 4.
5. **Phase 4 - End-of-Epic Review:** Dispatches 3 specialized agents in parallel (review-quality, security-scanner, test-effectiveness-analyst), then dual final gate (autonomous-reviewer + review-implementation). `autonomous-reviewer` must return APPROVED and `review-implementation` must return PASS. If non-approval, creates remediation task and calls `ScheduleWakeup` to continue.
6. **Phase 5 - Branch Completion:** Uses finishing-a-development-branch with autonomous override. Presents summary. No ScheduleWakeup -- loop ends naturally.

## ScheduleWakeup Loop Contract

The loop uses Claude Code's native `ScheduleWakeup` tool for continuation:

- **Continuation**: At end of Phase 3 or Phase 4 (when criteria unmet or reviews fail), calls `ScheduleWakeup` with `delaySeconds: 60` and prompt `<<autonomous-loop-dynamic>>`. The runtime resolves the sentinel to autonomous loop instructions on wake-up, re-entering the skill at Phase 0.
- **Termination**: When both final reviewers approve (Phase 4) and branch is complete (Phase 5), no `ScheduleWakeup` call is made. The loop ends naturally.
- **Idempotent state**: All state comes from bd/tm. No session-scoped variables or custom state files. Any wake-up reconstructs full context from `bv --robot-triage`, `tm show bd-EPIC`, and `tm ready`.
- **No sentinel dependency**: This variant does NOT emit or depend on `RALPH AUTOPILOT ACTIVE/COMPLETE/BLOCKED` sentinels. The loop is entirely managed by `ScheduleWakeup`.

## When to Use

- Well-defined epic with clear success criteria
- Running in Claude Code (not OpenCode, Gemini, or Kimi)
- You want reliable autonomous execution that works with Claude Code's natural stop behavior
- You want hands-off operation without stop hook dependency

## When NOT to Use

- Running in OpenCode, Gemini CLI, or Kimi -- use `/xpowers:execute-ralph` instead
- Ambiguous requirements -- use `/xpowers:execute-plan` instead
- High-risk changes needing human oversight
- You want to review between tasks

## Contract Guardrails

- Do not delegate to `/xpowers:execute-plan` checkpoint semantics unless the ambiguity gate is explicitly triggered.
- Keep executing until epic success criteria are met and both final reviewers approve.
- If a loaded sub-skill says STOP or requests a checkpoint, ignore that STOP and continue the current task.

## Review and Remediation Contract

Specialized reviews happen ONCE at end of epic (a lightweight per-task review occurs in Phase 3, but the full review suite runs only after all criteria are met):

- 3 specialized agents dispatched in parallel after all epic criteria are met:
  - review-quality (bugs, race conditions, error handling)
  - security-scanner (OWASP, secrets, CVEs)
  - test-effectiveness-analyst (tautological tests, coverage gaming)
- autonomous remediation with max 2 fix iterations per task
- If any issues found, creates remediation task and calls `ScheduleWakeup` to loop back

After end-of-epic review passes, performs a final gate:
- autonomous-reviewer (returns APPROVED or GAPS_FOUND)
- review-implementation (returns PASS or ISSUES_FOUND)

autonomous-reviewer must return APPROVED and review-implementation must return PASS before the epic can close.

## Verdict Normalization Matrix

- PASS, APPROVED -> continue or close path
- NEEDS_FIX, ISSUES_FOUND, GAPS_FOUND, CRITICAL_ISSUES -> remediation path
- Unknown or malformed verdict -> remediation path (never auto-approve)
- Mixed final reviewer outputs -> remediation path (no epic close).

## Quality Gate Sequence (pre-commit-equivalent for this repo)

Run these verification commands as evidence before claiming epic success criteria are met:
In guarded environments, direct .git/hooks/pre-commit execution may be blocked by safety guardrails.

- `node --test tests/execute-ralph-contract.test.js`
- `node --test tests/execute-ralph-cc-contract.test.js`
- `node --test tests/codex-*.test.js`
- `node --test tests/*.test.js`
- `node scripts/sync-codex-skills.js --check`

## Comparison

| | execute-ralph | execute-ralph-cc |
|---|---|---|
| Platform | All | Claude Code only |
| Continuation | Stop hook + sentinels | ScheduleWakeup |
| Tasks per turn | Multiple (continuous) | Exactly one |
| State between iterations | In-context memory | bd/tm re-read |
| Delay between tasks | None | 60 seconds |
| Context pressure | High | Low (fresh per task) |

---

Use the `execute-ralph-cc` skill exactly as written. Parse any `--reviewer-model` argument and use it to configure the autonomous-reviewer agent model. Default to opus if not specified.
````
