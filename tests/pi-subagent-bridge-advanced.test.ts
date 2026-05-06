import test from "node:test"
import assert from "node:assert/strict"
import {
  executeChainViaBridge,
  executeParallelViaBridge,
  executeAsyncViaBridge,
  clearPiSubagentsCache,
  __testSetPiSubagents,
  type PiSubagentsAPI,
} from "../.pi/extensions/xpowers/subagent-bridge.js"

function createMockAPI(overrides: Partial<PiSubagentsAPI> = {}): PiSubagentsAPI {
  const api: PiSubagentsAPI = {}
  if ("runAgent" in overrides) api.runAgent = overrides.runAgent
  else api.runAgent = async () => ({ content: [{ type: "text" as const, text: "mock-agent" }] })

  if ("runChain" in overrides) api.runChain = overrides.runChain
  else api.runChain = async () => ({ content: [{ type: "text" as const, text: "mock-chain" }] })

  if ("runParallel" in overrides) api.runParallel = overrides.runParallel
  else api.runParallel = async () => ({ content: [{ type: "text" as const, text: "mock-parallel" }] })

  if ("runAsync" in overrides) api.runAsync = overrides.runAsync
  else api.runAsync = async () => ({ runId: "mock-id", status: "running" })

  return api
}

test("executeChainViaBridge calls runChain with translated steps", async () => {
  let captured: any = null
  const mockApi = createMockAPI({
    runChain: async (params) => {
      captured = params
      return { content: [{ type: "text" as const, text: "chain-result" }] }
    },
  })

  // Temporarily inject mock
  __testSetPiSubagents(mockApi)

  const steps = [
    { agent: "scout", task: "analyze" },
    { agent: "worker", task: "implement" },
  ]
  const result = await executeChainViaBridge(
    steps,
    () => ({ model: "anthropic/claude-sonnet-4", effort: "high" }),
    "/tmp",
    "fresh",
    false,
  )

  assert.equal(result.content[0]!.text, "chain-result")
  assert.equal(captured.chain.length, 2)
  assert.equal(captured.chain[0]!.agent, "scout")
  assert.equal(captured.chain[0]!.model, "anthropic/claude-sonnet-4:high")
  assert.equal(captured.chain[1]!.agent, "worker")
  assert.equal(captured.cwd, "/tmp")
  assert.equal(captured.context, "fresh")
  assert.equal(captured.worktree, false)

  clearPiSubagentsCache()
})

test("executeParallelViaBridge calls runParallel with translated tasks", async () => {
  let captured: any = null
  const mockApi = createMockAPI({
    runParallel: async (params) => {
      captured = params
      return { content: [{ type: "text" as const, text: "parallel-result" }] }
    },
  })

  __testSetPiSubagents(mockApi)

  const tasks = [
    { agent: "reviewer", task: "check backend" },
    { agent: "reviewer", task: "check frontend" },
  ]
  const result = await executeParallelViaBridge(
    tasks,
    () => ({ model: "openai/gpt-4o", effort: "medium" }),
    "/tmp",
    "fork",
    true,
    2,
  )

  assert.equal(result.content[0]!.text, "parallel-result")
  assert.equal(captured.tasks.length, 2)
  assert.equal(captured.tasks[0]!.model, "openai/gpt-4o:medium")
  assert.equal(captured.context, "fork")
  assert.equal(captured.worktree, true)
  assert.equal(captured.concurrency, 2)

  clearPiSubagentsCache()
})

test("executeAsyncViaBridge calls runAsync and returns status", async () => {
  let captured: any = null
  const mockApi = createMockAPI({
    runAsync: async (params) => {
      captured = params
      return { runId: "run-123", status: "started" }
    },
  })

  __testSetPiSubagents(mockApi)

  const result = await executeAsyncViaBridge(
    { task: "do work", agent: "worker", model: "anthropic/claude-haiku-4-5" },
    { model: "anthropic/claude-haiku-4-5" },
  )

  assert.equal(result.runId, "run-123")
  assert.equal(result.status, "started")
  assert.equal(captured.agent, "worker")
  assert.ok(captured.model.includes("claude-haiku-4-5"))

  clearPiSubagentsCache()
})

test("executeChainViaBridge falls back when runChain unavailable", async () => {
  const mockApi = createMockAPI({ runChain: undefined })

  __testSetPiSubagents(mockApi)

  await assert.rejects(
    executeChainViaBridge([{ agent: "scout", task: "analyze" }], () => ({}), "/tmp", "fresh", false),
    /chain runner not available/,
  )

  clearPiSubagentsCache()
})

test("executeParallelViaBridge falls back when runParallel unavailable", async () => {
  const mockApi = createMockAPI({ runParallel: undefined })

  __testSetPiSubagents(mockApi)

  await assert.rejects(
    executeParallelViaBridge([{ agent: "reviewer", task: "check" }], () => ({}), "/tmp", "fresh", false),
    /parallel runner not available/,
  )

  clearPiSubagentsCache()
})

test("executeAsyncViaBridge falls back when runAsync unavailable", async () => {
  const mockApi = createMockAPI({ runAsync: undefined })

  __testSetPiSubagents(mockApi)

  await assert.rejects(
    executeAsyncViaBridge({ task: "work" }, {}),
    /async runner not available/,
  )

  clearPiSubagentsCache()
})

test("routing resolver skips inherit model", async () => {
  let captured: any = null
  const mockApi = createMockAPI({
    runChain: async (params) => {
      captured = params
      return { content: [{ type: "text" as const, text: "ok" }] }
    },
  })

  __testSetPiSubagents(mockApi)

  await executeChainViaBridge(
    [{ agent: "scout", task: "analyze" }],
    () => ({ model: "inherit", effort: "high" }),
    "/tmp",
    "fresh",
    false,
  )

  assert.equal(captured.chain[0]!.model, undefined)

  clearPiSubagentsCache()
})
