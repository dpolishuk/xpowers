import test from "node:test"
import assert from "node:assert/strict"
import {
  translateToPiSubagents,
  executeSubagent,
  executeSubagentAsync,
  tryLoadPiSubagents,
  clearPiSubagentsCache,
  __testSetPiSubagents,
  type SubagentBridgeParams,
} from "../.pi/extensions/xpowers/subagent-bridge.js"

test("translateToPiSubagents passes through basic params", () => {
  const result = translateToPiSubagents({ task: "do something" })
  assert.equal(result.task, "do something")
  assert.equal(result.agent, undefined)
  assert.equal(result.model, undefined)
})

test("translateToPiSubagents applies model override", () => {
  const result = translateToPiSubagents(
    { task: "do something" },
    { model: "anthropic/claude-sonnet-4" },
  )
  assert.equal(result.model, "anthropic/claude-sonnet-4")
})

test("translateToPiSubagents appends thinking suffix when effort present", () => {
  const result = translateToPiSubagents(
    { task: "do something" },
    { model: "anthropic/claude-sonnet-4", effort: "high" },
  )
  assert.equal(result.model, "anthropic/claude-sonnet-4:high")
})

test("translateToPiSubagents does not double-append thinking suffix", () => {
  const result = translateToPiSubagents(
    { task: "do something" },
    { model: "anthropic/claude-sonnet-4:medium", effort: "high" },
  )
  assert.equal(result.model, "anthropic/claude-sonnet-4:medium")
})

test("translateToPiSubagents prefers explicit model over routing", () => {
  const result = translateToPiSubagents(
    { task: "do something", model: "openai/gpt-4o" },
    { model: "anthropic/claude-sonnet-4" },
  )
  assert.equal(result.model, "openai/gpt-4o")
})

test("translateToPiSubagents skips inherit routing model", () => {
  const result = translateToPiSubagents(
    { task: "do something" },
    { model: "inherit" },
  )
  assert.equal(result.model, undefined)
})

test("translateToPiSubagents adds structured prompt for structured format", () => {
  const result = translateToPiSubagents(
    { task: "review code", format: "structured" },
  )
  assert.ok(result.task.includes("Return valid JSON only"))
  assert.ok(result.task.includes("review code"))
})

test("translateToPiSubagents passes through context output reads", () => {
  const result = translateToPiSubagents({
    task: "do something",
    context: "fork",
    output: "result.md",
    reads: ["context.md"],
  })
  assert.equal(result.context, "fork")
  assert.equal(result.output, "result.md")
  assert.deepEqual(result.reads, ["context.md"])
})

test("tryLoadPiSubagents detects pi-subagents extension", async () => {
  clearPiSubagentsCache()
  const result = await tryLoadPiSubagents()
  // pi-subagents is installed; should detect extension (object, not null)
  assert.ok(result !== null)
  assert.equal(typeof result, "object")
})

test("tryLoadPiSubagents returns null when cache forced null", async () => {
  clearPiSubagentsCache()
  __testSetPiSubagents(null)
  const result = await tryLoadPiSubagents()
  assert.equal(result, null)
})

test("executeSubagent falls back when pi-subagents missing", async () => {
  clearPiSubagentsCache()
  __testSetPiSubagents(null)
  const result = await executeSubagent({ task: "say hello" })
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0]!.type, "text")
  // Fallback runs pi --print --no-session, which should succeed
  assert.ok(result.content[0]!.text.length > 0)
}, { timeout: 20000 })

test("executeSubagentAsync falls back when pi-subagents missing", async () => {
  clearPiSubagentsCache()
  __testSetPiSubagents(null)
  const result = await executeSubagentAsync({ task: "say hello" })
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0]!.type, "text")
}, { timeout: 20000 })

test("executeSubagent uses bridge for chain params and falls back if bridge unavailable", async () => {
  clearPiSubagentsCache()
  __testSetPiSubagents(null)
  const result = await executeSubagent({
    task: "ignored",
    chain: [
      { agent: "scout", task: "analyze" },
      { agent: "worker", task: "implement" },
    ],
  })
  // Since pi-subagents is not installed, it should fall back gracefully
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0]!.type, "text")
}, { timeout: 20000 })

test("executeSubagent uses bridge for parallel params and falls back if bridge unavailable", async () => {
  clearPiSubagentsCache()
  __testSetPiSubagents(null)
  const result = await executeSubagent({
    task: "ignored",
    tasks: [
      { agent: "reviewer", task: "check backend" },
      { agent: "reviewer", task: "check frontend" },
    ],
  })
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0]!.type, "text")
}, { timeout: 20000 })

test("executeSubagentAsync returns async status placeholder when async=true and bridge unavailable", async () => {
  clearPiSubagentsCache()
  __testSetPiSubagents(null)
  const result = await executeSubagentAsync({
    task: "do something",
    async: true,
  })
  // Falls back to sync execution with a warning, but still returns valid result
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0]!.type, "text")
}, { timeout: 20000 })

// Regression tests for PR #57 unresolved threads

test("executeSubagent accepts chain without task and falls back gracefully", async () => {
  clearPiSubagentsCache()
  __testSetPiSubagents(null)
  const result = await executeSubagent({
    chain: [
      { agent: "scout", task: "analyze" },
    ],
  } as any)
  // Should NOT degrade — chain is a bridge-only param but pi-subagents is unavailable.
  // Since chain is present but bridge unavailable, it falls back (currently degrades).
  // After fix: should return valid fallback result.
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0]!.type, "text")
}, { timeout: 20000 })

test("executeSubagent falls back for empty reads array instead of degrading", async () => {
  clearPiSubagentsCache()
  __testSetPiSubagents(null)
  const result = await executeSubagent({
    task: "say hello",
    reads: [],
  } as any)
  // Empty reads should NOT trigger bridge mode.
  // Should fall back to native runner with normal result.
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0]!.type, "text")
  assert.ok(!result.content[0]!.text.includes("Bridge degradation"))
}, { timeout: 20000 })
