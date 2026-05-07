const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const repoRoot = path.resolve(__dirname, "..")

const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8")

test("test_execute_ralph_cc_uses_schedulewakeup_for_continuation", () => {
  const skill = read("skills/execute-ralph-cc/SKILL.md")

  assert.equal(skill.includes("ScheduleWakeup"), true)
  assert.equal(skill.includes("delaySeconds: 60"), true)
  assert.equal(skill.includes("<<autonomous-loop-dynamic>>"), true)
})

test("test_execute_ralph_cc_does_not_use_sentinels_as_operational_control", () => {
  const skill = read("skills/execute-ralph-cc/SKILL.md")

  // The skill may reference sentinels in comparison/context sections but
  // must NOT emit them as operational instructions
  assert.equal(
    skill.includes("Do not emit sentinel markers"),
    true,
  )
  assert.equal(
    skill.includes("This variant does NOT use or depend on RALPH AUTOPILOT ACTIVE"),
    true,
  )
})

test("test_execute_ralph_cc_state_recovery_from_bd_tm", () => {
  const skill = read("skills/execute-ralph-cc/SKILL.md")

  assert.equal(skill.includes("Phase 0: State Recovery"), true)
  assert.equal(skill.includes("bv --robot-triage"), true)
  assert.equal(skill.includes("tm show bd-EPIC"), true)
  assert.equal(skill.includes("reconstructs all context from bd/tm"), true)
})

test("test_execute_ralph_cc_one_task_per_turn", () => {
  const skill = read("skills/execute-ralph-cc/SKILL.md")

  assert.equal(skill.includes("one task per turn"), true)
  assert.equal(skill.includes("ONE task per turn"), true)
})

test("test_execute_ralph_cc_loop_termination_on_success", () => {
  const skill = read("skills/execute-ralph-cc/SKILL.md")

  assert.equal(
    skill.includes("Do NOT call ScheduleWakeup after Phase 5"),
    true,
  )
  assert.equal(
    skill.includes("loop ends naturally"),
    true,
  )
})

test("test_execute_ralph_cc_verdict_normalization_matrix", () => {
  const command = read("commands/execute-ralph-cc.md")
  const skill = read("skills/execute-ralph-cc/SKILL.md")

  assert.equal(command.includes("Verdict Normalization Matrix"), true)
  assert.equal(skill.includes("Verdict Normalization Matrix"), true)
  assert.equal(skill.includes("PASS, APPROVED -> continue or close path"), true)
  assert.equal(
    skill.includes("NEEDS_FIX, ISSUES_FOUND, GAPS_FOUND, CRITICAL_ISSUES -> remediation path"),
    true,
  )
  assert.equal(
    skill.includes("Unknown or malformed verdict -> remediation path (never auto-approve)"),
    true,
  )
})

test("test_execute_ralph_cc_quality_gate_sequence", () => {
  const command = read("commands/execute-ralph-cc.md")
  const skill = read("skills/execute-ralph-cc/SKILL.md")

  assert.equal(
    command.includes("Quality Gate Sequence (pre-commit-equivalent for this repo)"),
    true,
  )
  assert.equal(
    skill.includes("direct .git/hooks/pre-commit execution may be blocked by safety guardrails"),
    true,
  )
})

test("test_execute_ralph_cc_dual_final_gate", () => {
  const command = read("commands/execute-ralph-cc.md")
  const skill = read("skills/execute-ralph-cc/SKILL.md")

  assert.equal(
    command.includes("autonomous-reviewer must return APPROVED and review-implementation must return PASS"),
    true,
  )
  assert.equal(
    skill.includes("Only close epic when BOTH final reviewers approve"),
    true,
  )
})

test("test_execute_ralph_cc_max_50_remediation_cycles", () => {
  const command = read("commands/execute-ralph-cc.md")
  const skill = read("skills/execute-ralph-cc/SKILL.md")

  assert.equal(skill.includes("max 50 no-progress remediation cycles"), true)
  assert.equal(skill.includes("Track max 50 no-progress remediation cycles"), true)
})

test("test_execute_ralph_cc_auto_creates_tasks_when_criteria_unmet", () => {
  const skill = read("skills/execute-ralph-cc/SKILL.md")

  assert.equal(
    skill.includes("Task list exhaustion alone is NEVER a stop condition"),
    true,
  )
  assert.equal(
    skill.includes("auto-create the next task"),
    true,
  )
})

test("test_execute_ralph_cc_sre_refinement_required", () => {
  const skill = read("skills/execute-ralph-cc/SKILL.md")

  assert.equal(skill.includes("Use Skill tool: `xpowers:sre-task-refinement`"), true)
})

test("test_execute_ralph_cc_sha_drift_verification", () => {
  const skill = read("skills/execute-ralph-cc/SKILL.md")

  assert.equal(skill.includes("PRE_SHA=$(git rev-parse HEAD)"), true)
  assert.equal(skill.includes("POST_SHA=$(git rev-parse HEAD)"), true)
})

test("test_execute_ralph_cc_mixed_verdicts_do_not_close_epic", () => {
  const skill = read("skills/execute-ralph-cc/SKILL.md")

  assert.equal(skill.includes("Mixed final reviewer outputs are non-approval"), true)
  assert.equal(
    skill.includes("Do not close the epic unless both final reviewers return an approval verdict"),
    true,
  )
})

test("test_execute_ralph_cc_unknown_verdict_forces_remediation", () => {
  const skill = read("skills/execute-ralph-cc/SKILL.md")

  assert.equal(
    skill.includes("Unknown or malformed verdict must create a remediation task and continue the loop"),
    true,
  )
})

test("test_execute_ralph_cc_activation_rule_exists", () => {
  const rules = JSON.parse(read("hooks/skill-rules.json"))

  assert.ok(rules["execute-ralph-cc"])
  assert.equal(rules["execute-ralph-cc"].priority, "critical")
  assert.equal(rules["execute-ralph-cc"].type, "workflow")
})

test("test_execute_ralph_cc_command_references_correct_skill", () => {
  const command = read("commands/execute-ralph-cc.md")

  assert.equal(command.includes("execute-ralph-cc"), true)
  assert.equal(command.includes("ScheduleWakeup"), true)
})

test("test_execute_ralph_cc_phase_4_max_2_reentries", () => {
  const skill = read("skills/execute-ralph-cc/SKILL.md")

  assert.equal(
    skill.includes("Max 2 consecutive Phase 4 re-entries"),
    true,
  )
})
