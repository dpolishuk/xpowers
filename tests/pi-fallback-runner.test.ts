import test from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  executeFallbackSubagent,
  executeFallbackSubagentAsync,
  parseStructuredTaskOutput,
  buildStructuredTaskPrompt,
  XPOWERS_SUBAGENT_DEPTH_ENV,
  MAX_XPOWERS_SUBAGENT_DEPTH,
} from "../.pi/extensions/xpowers/fallback-runner.js"

test("executeFallbackSubagent returns stdout on success", () => {
  const mockRun = (_cmd: string, args: string[], _opts: any) => {
    const taskArg = args[args.length - 1]
    return {
      status: 0,
      stdout: `result for: ${taskArg}`,
      stderr: "",
      signal: null,
      error: undefined,
    } as any
  }

  const result = executeFallbackSubagent(
    { task: "say hello" },
    mockRun as any,
  )

  assert.equal(result.content.length, 1)
  assert.equal(result.content[0]!.type, "text")
  assert.ok(result.content[0]!.text.includes("say hello"))
})

test("executeFallbackSubagent returns structured output when format=structured", () => {
  const mockRun = (_cmd: string, _args: string[], _opts: any) => {
    return {
      status: 0,
      stdout: JSON.stringify({
        status: "PASS",
        summary: "all good",
        findings: [],
        nextAction: "none",
      }),
      stderr: "",
      signal: null,
      error: undefined,
    } as any
  }

  const result = executeFallbackSubagent(
    { task: "review code", format: "structured" },
    mockRun as any,
  )

  assert.equal(result.content.length, 1)
  const parsed = JSON.parse(result.content[0]!.text)
  assert.equal(parsed.status, "PASS")
  assert.equal(parsed.summary, "all good")
})

test("executeFallbackSubagent blocks recursion at max depth", () => {
  const originalDepth = process.env[XPOWERS_SUBAGENT_DEPTH_ENV]
  process.env[XPOWERS_SUBAGENT_DEPTH_ENV] = String(MAX_XPOWERS_SUBAGENT_DEPTH)
  try {
    const result = executeFallbackSubagent({ task: "should not run" }, null as any)
    assert.equal(result.content.length, 1)
    assert.ok(result.content[0]!.text.includes("recursion depth"))
  } finally {
    if (originalDepth !== undefined) {
      process.env[XPOWERS_SUBAGENT_DEPTH_ENV] = originalDepth
    } else {
      delete process.env[XPOWERS_SUBAGENT_DEPTH_ENV]
    }
  }
})

test("executeFallbackSubagent handles fork context with sessionSeedPath", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "fallback-test-"))
  const seedPath = join(tmpDir, "seed.jsonl")
  writeFileSync(seedPath, "{}")

  const mockRun = (_cmd: string, args: string[], _opts: any) => {
    return {
      status: 0,
      stdout: `forked with args: ${args.join(", ")}`,
      stderr: "",
      signal: null,
      error: undefined,
    } as any
  }

  const result = executeFallbackSubagent(
    { task: "fork test", contextMode: "fork", sessionSeedPath: seedPath },
    mockRun as any,
  )

  assert.equal(result.content.length, 1)
  assert.ok(result.content[0]!.text.includes("forked with args"))

  rmSync(tmpDir, { recursive: true, force: true })
})

test("executeFallbackSubagent returns error when fork context lacks sessionSeedPath", () => {
  const result = executeFallbackSubagent(
    { task: "fork test", contextMode: "fork" },
    null as any,
  )

  assert.equal(result.content.length, 1)
  assert.ok(result.content[0]!.text.includes("context unavailable"))
})

test("executeFallbackSubagentAsync returns stdout on success", async () => {
  const mockRun = (_cmd: string, _args: string[], _opts: any) => {
    const child = {
      stdout: {
        setEncoding() {},
        on(_event: string, handler: (chunk: string) => void) {
          if (_event === "data") handler("async result")
        },
      },
      stderr: {
        setEncoding() {},
        on() {},
      },
      on(_event: string, handler: (...args: any[]) => void) {
        if (_event === "close") handler(0, null)
      },
    } as any
    return child
  }

  const result = await executeFallbackSubagentAsync(
    { task: "say hello" },
    mockRun as any,
  )

  assert.equal(result.content.length, 1)
  assert.equal(result.content[0]!.type, "text")
  assert.ok(result.content[0]!.text.includes("async result"))
})

test("parseStructuredTaskOutput validates required fields", () => {
  const valid = '{"status":"PASS","summary":"ok","findings":[]}'
  const parsed = parseStructuredTaskOutput(valid)
  assert.equal(parsed.status, "PASS")
  assert.equal(parsed.summary, "ok")

  assert.throws(() => parseStructuredTaskOutput("not json"), /not valid JSON/)
  assert.throws(() => parseStructuredTaskOutput('{"status":"UNKNOWN","summary":"x","findings":[]}'), /must be one of PASS/)
  assert.throws(() => parseStructuredTaskOutput('{"status":"PASS","findings":[]}'), /must include string field 'summary'/)
})

test("buildStructuredTaskPrompt appends JSON shape instruction", () => {
  const prompt = buildStructuredTaskPrompt("do something")
  assert.ok(prompt.startsWith("do something"))
  assert.ok(prompt.includes('"status": "PASS|ISSUES_FOUND|FAIL"'))
})
