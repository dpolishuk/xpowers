const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const repoRoot = path.resolve(__dirname, "..")

const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8")

test("test_execute_ralph_continues_when_criteria_unmet", () => {
  const skill = read("skills/execute-ralph/SKILL.md")

  assert.equal(
    skill.includes("If no ready or in-progress tasks exist and epic success criteria are still unmet"),
    true,
  )
  assert.equal(skill.includes("do not stop - create and execute the next task"), true)
})

test("test_execute_ralph_auto_creates_and_refines_next_task", () => {
  const skill = read("skills/execute-ralph/SKILL.md")

  assert.equal(skill.includes("Auto-create next task from unmet criterion"), true)
  assert.equal(skill.includes("Use Skill tool: xpowers:sre-task-refinement"), true)
})

test("test_execute_plan_still_stops_after_single_task", () => {
  const command = read("commands/execute-plan.md")
  const skill = read("skills/executing-plans/SKILL.md")

  assert.equal(command.includes("Each task execution ends with a STOP checkpoint"), true)
  assert.equal(skill.includes("STOP after each task for user review"), true)
})

test("test_dual_final_gate_requires_both_approvals", () => {
  const command = read("commands/execute-ralph.md")
  const skill = read("skills/execute-ralph/SKILL.md")

  assert.equal(
    command.includes("Final close requires BOTH: autonomous-reviewer APPROVED and review-implementation PASS"),
    true,
  )
  assert.equal(
    skill.includes("Only close epic when BOTH final reviewers approve"),
    true,
  )
})

test("test_no_progress_cycles_until_retry_50_then_escalates", () => {
  const command = read("commands/execute-ralph.md")
  const skill = read("skills/execute-ralph/SKILL.md")

  assert.equal(command.includes("Max autonomous no-progress retries: 50"), true)
  assert.equal(skill.includes("max 50 no-progress remediation cycles"), true)
})

test("test_execute_ralph_intent_not_overridden_by_context_pack", () => {
  const orchestrator = read(".opencode/plugins/task-context-orchestrator.ts")

  assert.equal(orchestrator.includes("Task Command Intent Lock"), true)
  assert.equal(orchestrator.includes("execute-ralph intent is authoritative"), true)
})

test("test_execute_ralph_intent_has_explicit_activation_rule", () => {
  const rules = JSON.parse(read("hooks/skill-rules.json"))

  assert.ok(rules["execute-ralph"])
  assert.equal(rules["execute-ralph"].priority, "critical")
})

test("test_verdict_matrix_contains_all_supported_tokens", () => {
  const files = [
    "commands/execute-ralph.md",
    "skills/execute-ralph/SKILL.md",
    ".opencode/commands/execute-ralph.md",
    ".opencode/skills/xpowers-execute-ralph/SKILL.md",
  ]

  for (const file of files) {
    const text = read(file)
    assert.equal(text.includes("Verdict Normalization Matrix"), true, file)
    assert.equal(text.includes("PASS, APPROVED -> continue or close path"), true, file)
    assert.equal(
      text.includes("NEEDS_FIX, ISSUES_FOUND, GAPS_FOUND, CRITICAL_ISSUES -> remediation path"),
      true,
      file,
    )
    assert.equal(
      text.includes("Unknown or malformed verdict -> remediation path (never auto-approve)"),
      true,
      file,
    )
  }
})

test("test_unknown_verdict_forces_remediation_path", () => {
  const skill = read("skills/execute-ralph/SKILL.md")

  assert.equal(
    skill.includes("Unknown or malformed verdict must create a remediation task and continue the loop"),
    true,
  )
})

test("test_mixed_final_verdicts_do_not_close_epic", () => {
  const skill = read("skills/execute-ralph/SKILL.md")

  assert.equal(skill.includes("Mixed final reviewer outputs are non-approval"), true)
  assert.equal(skill.includes("Do not close the epic unless both final reviewers return an approval verdict"), true)
})

test("test_execute_ralph_contract_consistency_across_source_and_wrappers", () => {
  const files = [
    "commands/execute-ralph.md",
    ".opencode/commands/execute-ralph.md",
    ".kimi/skills/codex-command-execute-ralph/SKILL.md",
  ]

  for (const file of files) {
    const text = read(file)
    assert.equal(
      text.includes("Quality Gate Sequence (pre-commit-equivalent for this repo)"),
      true,
      file,
    )
  }
})

test("test_final_gate_mixed_verdict_routes_to_remediation", () => {
  const command = read("commands/execute-ralph.md")
  const skill = read("skills/execute-ralph/SKILL.md")

  assert.equal(command.includes("Mixed final reviewer outputs -> remediation path (no epic close)."), true)
  assert.equal(skill.includes("Mixed final reviewer outputs -> remediation path (no epic close)."), true)
})

test("test_quality_gate_sequence_declared_and_verified", () => {
  const evidence = read("docs/execute-ralph-criteria-evidence.md")

  assert.equal(evidence.includes("# Execute-Ralph Criteria Evidence"), true)
  assert.equal(evidence.includes("node --test tests/execute-ralph-contract.test.js"), true)
  assert.equal(evidence.includes("node --test tests/codex-*.test.js"), true)
  assert.equal(evidence.includes("node --test tests/*.test.js"), true)
})

test("test_pre_commit_equivalent_path_documents_guardrail_constraint", () => {
  const files = [
    "commands/execute-ralph.md",
    ".opencode/commands/execute-ralph.md",
    "skills/execute-ralph/SKILL.md",
    ".opencode/skills/xpowers-execute-ralph/SKILL.md",
    "docs/execute-ralph-criteria-evidence.md",
  ]

  for (const file of files) {
    const text = read(file)
    assert.equal(
      text.includes("direct .git/hooks/pre-commit execution may be blocked by safety guardrails"),
      true,
      file,
    )
  }
})

test("test_pre_commit_equivalent_path_is_explicitly_named", () => {
  const evidence = read("docs/execute-ralph-criteria-evidence.md")

  assert.equal(evidence.includes("Pre-commit-equivalent verification path"), true)
})

test("test_ralph_autopilot_sentinels_documented_in_source_and_wrappers", () => {
  const files = [
    "commands/execute-ralph.md",
    "skills/execute-ralph/SKILL.md",
    ".opencode/commands/execute-ralph.md",
    ".opencode/skills/xpowers-execute-ralph/SKILL.md",
    ".kimi/skills/execute-ralph/SKILL.md",
    ".kimi/skills/codex-command-execute-ralph/SKILL.md",
    ".kimi/skills/codex-skill-execute-ralph/SKILL.md",
  ]

  for (const file of files) {
    const text = read(file)
    assert.equal(text.includes("RALPH AUTOPILOT ACTIVE"), true, file)
    assert.equal(text.includes("RALPH AUTOPILOT COMPLETE"), true, file)
    assert.equal(text.includes("RALPH AUTOPILOT BLOCKED"), true, file)
    assert.equal(text.includes("first non-empty line"), true, file)
    assert.equal(text.includes("leading sentinel control block"), true, file)
    assert.equal(text.includes("Required shapes"), true, file)
    assert.equal(text.includes("terminal responses must not include `RALPH AUTOPILOT ACTIVE`"), true, file)
    assert.equal(
      text.includes("Later quoted examples, logs, or code blocks are ignored"),
      true,
      file,
    )
    assert.equal(
      text.includes("terminal sentinels still win if they appear in a malformed leading sentinel control block"),
      true,
      file,
    )
    assert.equal(
      text.includes("Active sentinel text alone is not enough to trigger blocking"),
      true,
      file,
    )
    assert.equal(
      text.includes("does not bypass Claude Code permission prompts"),
      true,
      file,
    )
  }
})

test("test_ralph_autopilot_stop_hook_registered_for_activation_stop_and_subagent_stop", () => {
  const hooks = JSON.parse(read("hooks/hooks.json")).hooks
  const hookCommand = "${CLAUDE_PLUGIN_ROOT}/hooks/stop/30-ralph-autopilot-continue.js"
  const reminderCommand = "${CLAUDE_PLUGIN_ROOT}/hooks/stop/10-gentle-reminders.sh"
  const memsearchCommand = "${CLAUDE_PLUGIN_ROOT}/hooks/stop/20-memsearch-save.sh"
  const commandsFor = (eventName) =>
    (hooks[eventName] || []).flatMap((entry) =>
      (entry.hooks || []).map((hook) => hook.command),
    )

  const stopCommands = commandsFor("Stop")
  const subagentStopCommands = commandsFor("SubagentStop")
  const userPromptExpansionCommands = commandsFor("UserPromptExpansion")

  assert.equal(userPromptExpansionCommands.includes(hookCommand), true)
  assert.equal(stopCommands.includes(hookCommand), true)
  assert.equal(subagentStopCommands.includes(hookCommand), true)
  assert.equal(stopCommands.includes(reminderCommand), true)
  assert.equal(stopCommands.includes(memsearchCommand), true)
  assert.ok(stopCommands.indexOf(hookCommand) < stopCommands.indexOf(reminderCommand))
})

test("test_ralph_autopilot_stop_hook_is_executable_node_script", () => {
  const hookPath = path.join(repoRoot, "hooks/stop/30-ralph-autopilot-continue.js")
  const hook = read("hooks/stop/30-ralph-autopilot-continue.js")
  const mode = fs.statSync(hookPath).mode

  assert.equal(hook.startsWith("#!/usr/bin/env node"), true)
  assert.notEqual(mode & 0o111, 0)
})
