const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const repoRoot = path.resolve(__dirname, "..")
const hookPath = path.join(repoRoot, "hooks/stop/30-ralph-autopilot-continue.js")

function withTempState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-autopilot-hook-"))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function envFor(stateHome, extra = {}) {
  const env = {
    ...process.env,
    XDG_STATE_HOME: stateHome,
    HOME: path.join(stateHome, "home"),
    ...extra,
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key]
    }
  }

  return env
}

function payloadWithText(text, overrides = {}) {
  return {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: repoRoot,
    transcript_path: path.join(os.tmpdir(), "ralph-transcript.jsonl"),
    last_assistant_message: text,
    ...overrides,
  }
}

function runHook(input, env) {
  const serialized = typeof input === "string" ? input : JSON.stringify(input)
  const result = spawnSync(process.execPath, [hookPath], {
    cwd: repoRoot,
    input: serialized,
    encoding: "utf8",
    env,
    timeout: 5000,
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, "")
  assert.ok(result.stdout.trim() !== "", "hook should always print JSON")
  return JSON.parse(result.stdout)
}

function assertAllow(output) {
  assert.deepEqual(output, {})
}

function assertBlock(output) {
  assert.deepEqual(Object.keys(output).sort(), ["decision", "reason"])
  assert.equal(output.decision, "block")
  assert.match(output.reason, /continue execute-ralph/i)
  assert.match(output.reason, /bv --robot-next \|\| tm ready/)
  assert.match(output.reason, /tm show/)
  assert.match(output.reason, /avoid user confirmation/i)
  assert.match(output.reason, /call a tool before producing another response/i)
}

test("active sentinel blocks stop with exact block response shape", () => {
  withTempState((stateHome) => {
    const output = runHook(
      payloadWithText("Phase 1\nRALPH AUTOPILOT ACTIVE\nTask: hyper-3o0.1"),
      envFor(stateHome),
    )

    assertBlock(output)
  })
})

test("inactive assistant response allows stop", () => {
  withTempState((stateHome) => {
    const output = runHook(
      payloadWithText("Finished looking at execute-ralph state."),
      envFor(stateHome),
    )

    assertAllow(output)
  })
})

test("keyword-only and lowercase mentions do not activate the hook", () => {
  withTempState((stateHome) => {
    assertAllow(
      runHook(
        payloadWithText("ralph autopilot active; execute-ralph should keep working"),
        envFor(stateHome),
      ),
    )
    assertAllow(
      runHook(
        payloadWithText("RALPH AUTOPILOT is discussed here without the active sentinel"),
        envFor(stateHome),
      ),
    )
  })
})

test("terminal sentinels allow stop and clear existing retry state", () => {
  withTempState((stateHome) => {
    const env = envFor(stateHome, { XPOWERS_RALPH_AUTOPILOT_MAX_BLOCKS: "1" })

    assertBlock(runHook(payloadWithText("RALPH AUTOPILOT ACTIVE"), env))
    assertAllow(
      runHook(
        payloadWithText("RALPH AUTOPILOT ACTIVE\nRALPH AUTOPILOT COMPLETE"),
        env,
      ),
    )
    assertBlock(runHook(payloadWithText("RALPH AUTOPILOT ACTIVE"), env))
    assertAllow(runHook(payloadWithText("RALPH AUTOPILOT BLOCKED"), env))
  })
})

test("malformed, empty, and missing assistant text inputs fail open", () => {
  withTempState((stateHome) => {
    const env = envFor(stateHome)

    assertAllow(runHook("{bad json", env))
    assertAllow(runHook("", env))
    assertAllow(
      runHook(
        {
          hook_event_name: "Stop",
          session_id: "session-no-text",
          cwd: repoRoot,
        },
        env,
      ),
    )
  })
})

test("state path that cannot be created fails open", () => {
  withTempState((stateHome) => {
    const stateFile = path.join(stateHome, "not-a-directory")
    fs.writeFileSync(stateFile, "file blocks state directory creation", "utf8")
    const env = envFor(stateFile)

    assertAllow(runHook(payloadWithText("RALPH AUTOPILOT ACTIVE"), env))
  })
})

test("missing XDG_STATE_HOME and HOME fails open", () => {
  withTempState((stateHome) => {
    const env = envFor(stateHome, {
      XDG_STATE_HOME: undefined,
      HOME: undefined,
    })

    assertAllow(runHook(payloadWithText("RALPH AUTOPILOT ACTIVE"), env))
  })
})

test("retry boundary allows stop when next block would exceed max", () => {
  withTempState((stateHome) => {
    const env = envFor(stateHome, { XPOWERS_RALPH_AUTOPILOT_MAX_BLOCKS: "2" })
    const payload = payloadWithText("RALPH AUTOPILOT ACTIVE")

    assertBlock(runHook(payload, env))
    assertBlock(runHook(payload, env))
    assertAllow(runHook(payload, env))
  })
})

test("invalid retry max falls back to default instead of disabling blocks", () => {
  withTempState((stateHome) => {
    const env = envFor(stateHome, { XPOWERS_RALPH_AUTOPILOT_MAX_BLOCKS: "0" })

    assertBlock(runHook(payloadWithText("RALPH AUTOPILOT ACTIVE"), env))
  })
})

test("SubagentStop retry state is separated by agent id", () => {
  withTempState((stateHome) => {
    const env = envFor(stateHome, { XPOWERS_RALPH_AUTOPILOT_MAX_BLOCKS: "1" })
    const basePayload = payloadWithText("RALPH AUTOPILOT ACTIVE", {
      hook_event_name: "SubagentStop",
      session_id: "shared-session",
      transcript_path: "/tmp/shared-main-transcript.jsonl",
    })

    assertBlock(runHook({ ...basePayload, agent_id: "agent-a" }, env))
    assertBlock(runHook({ ...basePayload, agent_id: "agent-b" }, env))
    assertAllow(runHook({ ...basePayload, agent_id: "agent-a" }, env))
  })
})

test("safe transcript fallback can extract the latest assistant text", () => {
  withTempState((stateHome) => {
    const transcriptPath = path.join(stateHome, "transcript.jsonl")
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: "user", message: { content: "Start" } }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "RALPH AUTOPILOT ACTIVE" }] },
        }),
      ].join("\n"),
      "utf8",
    )

    assertBlock(
      runHook(
        {
          hook_event_name: "Stop",
          session_id: "session-transcript",
          cwd: repoRoot,
          transcript_path: transcriptPath,
        },
        envFor(stateHome),
      ),
    )
  })
})
