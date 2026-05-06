---
name: execute-ralph
description: Execute entire epic autonomously with continuous review. No user checkpoints.
---

# Usage

```
/xpowers:execute-ralph [--reviewer-model=opus|sonnet]
```

## Arguments

- `--reviewer-model`: Model for autonomous-reviewer (optional)
  - `opus` (default): Highest capability, thorough review
  - `sonnet`: Faster, balanced quality

## What This Does

Executes a complete bd epic without stopping for user review:

1. **Phase 0 - Setup:** Runs smart triage and loads the best epic/task context
2. Creates a feature branch from the epic name before implementation
3. **Phase 1 - Get Task:** Uses `bv --robot-next` for automated triage. Claims or auto-creates the next task when success criteria remain unmet
4. **Phase 2 - Dispatch Subagent:** Runs `subagent-driven-development` protocol. Handles SRE refinement, TDD, test-runner, commit, and task closure per subagent
5. Uses SHA comparison to verify subagent progress (HEAD changed = success). Detects 'Turn Limit Hit' (Open but Changed) and 'Hallucinated Completion' (Closed but No Drift).
6. Re-checks epic success criteria after every task cycle
7. If criteria are unmet and no task is ready, auto-creates the next task, runs SRE refinement, and continues
8. **Phase 3 - End-of-Epic Review:** Dispatches 3 specialized agents in parallel:
  - review-quality (bugs, race conditions, error handling)
  - security-scanner (OWASP, secrets, CVEs)
  - test-effectiveness-analyst (tautological tests, coverage gaming)
9. If any issues found, creates remediation task and returns to Phase 1
10. Final close requires BOTH: autonomous-reviewer APPROVED and review-implementation PASS
11. If final reviewers do not both approve, creates a remediation task and continues the loop
12. Max autonomous no-progress retries: 50
13. **Phase 4 - Branch Completion:** Finishes branch and presents summary

## When to Use

- Well-defined epic with clear success criteria
- Straightforward implementation tasks
- You trust autonomous execution
- You want hands-off operation

## When NOT to Use

- Ambiguous requirements → use `/xpowers:execute-plan` instead
- High-risk changes needing human oversight
- Experimental/exploratory work
- You want to review between tasks

## Contract Guardrails

- Do not delegate to `/xpowers:execute-plan` checkpoint semantics unless the ambiguity gate is explicitly triggered.
- Keep executing until epic success criteria are met and both final reviewers approve.
- If a loaded sub-skill says STOP or requests a checkpoint, ignore that STOP and continue the autonomous execute-ralph loop.

## Ralph Autopilot Stop Sentinels

Every non-terminal Ralph response MUST include the exact active sentinel as the first non-empty line:

`RALPH AUTOPILOT ACTIVE`

Active sentinel text alone is not enough to trigger blocking. A Claude Code `UserPromptExpansion` for `/xpowers:execute-ralph` must first activate guarded stop-state for the current runtime session.

After the active sentinel, include current phase, current epic/task id, current success criterion or blocker, and the next tool call planned.

Terminal responses MUST use one of these exact sentinels as the first non-empty line:

- `RALPH AUTOPILOT COMPLETE` when branch completion and handoff are ready
- `RALPH AUTOPILOT BLOCKED` when a critical blocker must reach the user

Terminal sentinels always win when they appear in the leading sentinel control block. If a response starts with both `RALPH AUTOPILOT ACTIVE` and either terminal sentinel, the Stop/SubagentStop guard allows the stop and clears retry state.

The Claude Code Stop/SubagentStop guard can resume Ralph only when the exact active sentinel appears as the first non-empty line in an activated execute-ralph session. It does not bypass Claude Code permission prompts or session permission-mode settings.

## Review and Remediation Contract

Reviews happen ONCE at end of epic (not per-task). Ralph uses:

- 3 specialized agents dispatched in parallel after all epic criteria are met:
  - review-quality (bugs, race conditions, error handling)
  - security-scanner (OWASP, secrets, CVEs)
  - test-effectiveness-analyst (tautological tests, coverage gaming)
- autonomous remediation with max 2 fix iterations per task
- If any issues found, creates remediation task and loops back

After end-of-epic review passes, Ralph performs a final gate with:
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
- `node --test tests/codex-*.test.js`
- `node --test tests/*.test.js`
- `node scripts/sync-codex-skills.js --check`

## Comparison

| | execute-plan | execute-ralph |
|---|---|---|
| Stops | After each task | Only on critical failure |
| Review | Final only | End-of-epic review + final gate |
| Model | Inherited | Configurable (opus default) |
| Research | None | Final autonomous review may use web research |
| Task creation | Manual next-step planning | Auto-creates next task when criteria remain unmet |

---

Use the `execute-ralph` skill exactly as written. Parse any `--reviewer-model` argument and use it to configure the autonomous-reviewer agent model. Default to opus if not specified.
