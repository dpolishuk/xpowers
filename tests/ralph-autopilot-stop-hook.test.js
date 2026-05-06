const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const repoRoot = path.resolve(__dirname, "..")
const hookPath = path.join(repoRoot, "hooks/stop/30-ralph-autopilot-continue.js")
const defaultSessionId = "session-1"
const defaultTranscriptPath = path.join(os.tmpdir(), "ralph-transcript.jsonl")

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
    session_id: defaultSessionId,
    cwd: repoRoot,
    transcript_path: defaultTranscriptPath,
    last_assistant_message: text,
    ...overrides,
  }
}

function activationPayload(overrides = {}) {
  return {
    hook_event_name: "UserPromptExpansion",
    session_id: defaultSessionId,
    cwd: repoRoot,
    transcript_path: defaultTranscriptPath,
    command_name: "execute-ralph",
    prompt: "/xpowers:execute-ralph hyper-3o0",
    ...overrides,
  }
}

function activateRalph(env, overrides = {}) {
  return runHook(activationPayload(overrides), env)
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
    const env = envFor(stateHome)
    assertAllow(activateRalph(env))

    const output = runHook(
      payloadWithText("Phase 1\nRALPH AUTOPILOT ACTIVE\nTask: hyper-3o0.1"),
      env,
    )

    assertBlock(output)
  })
})

test("active sentinel without execute-ralph activation state fails open", () => {
  withTempState((stateHome) => {
    const output = runHook(
      payloadWithText("Phase 1\nRALPH AUTOPILOT ACTIVE\nTask: hyper-3o0.1"),
      envFor(stateHome),
    )

    assertAllow(output)
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
    const env = envFor(stateHome)
    assertAllow(activateRalph(env))

    assertAllow(
      runHook(
        payloadWithText("ralph autopilot active; execute-ralph should keep working"),
        env,
      ),
    )
    assertAllow(
      runHook(
        payloadWithText("RALPH AUTOPILOT is discussed here without the active sentinel"),
        env,
      ),
    )
  })
})

test("inline sentinel prose neither blocks nor clears activated retry state", () => {
  withTempState((stateHome) => {
    const env = envFor(stateHome, { XPOWERS_RALPH_AUTOPILOT_MAX_BLOCKS: "2" })
    assertAllow(activateRalph(env))

    assertAllow(
      runHook(
        payloadWithText("Review says RALPH AUTOPILOT ACTIVE is mentioned inline."),
        env,
      ),
    )
    assertBlock(runHook(payloadWithText("RALPH AUTOPILOT ACTIVE"), env))
    assertAllow(
      runHook(
        payloadWithText("A sentence says RALPH AUTOPILOT COMPLETE but not as a line."),
        env,
      ),
    )
    assertBlock(runHook(payloadWithText("RALPH AUTOPILOT ACTIVE"), env))
    assertAllow(runHook(payloadWithText("RALPH AUTOPILOT ACTIVE"), env))
  })
})

test("terminal sentinels allow stop and clear existing retry state", () => {
  withTempState((stateHome) => {
    const env = envFor(stateHome, { XPOWERS_RALPH_AUTOPILOT_MAX_BLOCKS: "1" })

    assertAllow(activateRalph(env))
    assertBlock(runHook(payloadWithText("RALPH AUTOPILOT ACTIVE"), env))
    assertAllow(
      runHook(
        payloadWithText("RALPH AUTOPILOT ACTIVE\nRALPH AUTOPILOT COMPLETE"),
        env,
      ),
    )
    assertAllow(activateRalph(env))
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

test("execute-ralph command expansion activates only matching command sessions", () => {
  withTempState((stateHome) => {
    const env = envFor(stateHome)

    assertAllow(
      runHook(
        activationPayload({
          command_name: "brainstorm",
          prompt: "/xpowers:brainstorm hyper-3o0",
        }),
        env,
      ),
    )
    assertAllow(runHook(payloadWithText("RALPH AUTOPILOT ACTIVE"), env))

    assertAllow(
      runHook(
        activationPayload({
          command_name: "",
          prompt: "/xpowers:execute-ralph hyper-3o0",
        }),
        env,
      ),
    )
    assertBlock(runHook(payloadWithText("RALPH AUTOPILOT ACTIVE"), env))
  })
})

test("state path that cannot be created fails open", () => {
  withTempState((stateHome) => {
    const stateFile = path.join(stateHome, "not-a-directory")
    fs.writeFileSync(stateFile, "file blocks state directory creation", "utf8")
    const env = envFor(stateFile)

    assertAllow(activateRalph(env))
    assertAllow(runHook(payloadWithText("RALPH AUTOPILOT ACTIVE"), env))
  })
})

test("missing XDG_STATE_HOME and HOME fails open", () => {
  withTempState((stateHome) => {
    const env = envFor(stateHome, {
      XDG_STATE_HOME: undefined,
      HOME: undefined,
    })

    assertAllow(activateRalph(env))
    assertAllow(runHook(payloadWithText("RALPH AUTOPILOT ACTIVE"), env))
  })
})

test("missing runtime identity fields fail open instead of sharing empty state", () => {
  withTempState((stateHome) => {
    const env = envFor(stateHome)
    assertAllow(activateRalph(env))

    assertAllow(
      runHook(
        payloadWithText("RALPH AUTOPILOT ACTIVE", {
          session_id: undefined,
          cwd: undefined,
          transcript_path: undefined,
          agent_transcript_path: undefined,
        }),
        env,
      ),
    )
    assertAllow(
      runHook(
        payloadWithText("RALPH AUTOPILOT ACTIVE", {
          session_id: "",
          cwd: "",
          transcript_path: "",
          agent_transcript_path: "",
        }),
        env,
      ),
    )
  })
})

test("retry boundary allows stop when next block would exceed max", () => {
  withTempState((stateHome) => {
    const env = envFor(stateHome, { XPOWERS_RALPH_AUTOPILOT_MAX_BLOCKS: "2" })
    const payload = payloadWithText("RALPH AUTOPILOT ACTIVE")

    assertAllow(activateRalph(env))
    assertBlock(runHook(payload, env))
    assertBlock(runHook(payload, env))
    assertAllow(runHook(payload, env))
  })
})

test("invalid retry max falls back to default instead of disabling blocks", () => {
  withTempState((stateHome) => {
    const env = envFor(stateHome, { XPOWERS_RALPH_AUTOPILOT_MAX_BLOCKS: "0" })

    assertAllow(activateRalph(env))
    assertBlock(runHook(payloadWithText("RALPH AUTOPILOT ACTIVE"), env))
  })
})

test("SubagentStop retry state is separated by agent id", () => {
  withTempState((stateHome) => {
    const env = envFor(stateHome, { XPOWERS_RALPH_AUTOPILOT_MAX_BLOCKS: "1" })
    assertAllow(
      activateRalph(env, {
        session_id: "shared-session",
        transcript_path: "/tmp/shared-main-transcript.jsonl",
      }),
    )

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

    const env = envFor(stateHome)
    assertAllow(
      activateRalph(env, {
        session_id: "session-transcript",
        transcript_path: transcriptPath,
      }),
    )
    assertBlock(
      runHook(
        {
          hook_event_name: "Stop",
          session_id: "session-transcript",
          cwd: repoRoot,
          transcript_path: transcriptPath,
        },
        env,
      ),
    )
  })
})
