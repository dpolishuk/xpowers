#!/usr/bin/env node

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const ACTIVE_SENTINEL = "RALPH AUTOPILOT ACTIVE"
const COMPLETE_SENTINEL = "RALPH AUTOPILOT COMPLETE"
const BLOCKED_SENTINEL = "RALPH AUTOPILOT BLOCKED"
const EXECUTE_RALPH_COMMANDS = new Set(["execute-ralph", "xpowers:execute-ralph"])
const DEFAULT_MAX_BLOCKS = 50
const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024

const BLOCK_REASON = [
  "RALPH AUTOPILOT ACTIVE is present.",
  "Continue execute-ralph autonomously.",
  "Call a tool before producing another response.",
  "Re-establish objective state with `bv --robot-next || tm ready` and `tm show <current task or epic>`.",
  "Avoid user confirmation and continue from the current phase/task/criterion state unless a terminal sentinel is required.",
].join(" ")

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function allow() {
  printJson({})
}

function block(reason) {
  printJson({ decision: "block", reason })
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

function parsePayload(input) {
  if (!input || input.trim() === "") {
    return null
  }

  try {
    const parsed = JSON.parse(input)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function textFromValue(value) {
  if (typeof value === "string") {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(textFromValue).filter(Boolean).join("\n")
  }

  if (!value || typeof value !== "object") {
    return ""
  }

  const fields = [
    "text",
    "output_text",
    "content",
    "message",
    "body",
    "value",
  ]

  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      const text = textFromValue(value[field])
      if (text) {
        return text
      }
    }
  }

  return ""
}

function isAssistantRecord(record) {
  if (!record || typeof record !== "object") {
    return false
  }

  return (
    record.type === "assistant" ||
    record.role === "assistant" ||
    record.sender === "assistant" ||
    record.message?.role === "assistant"
  )
}

function textFromTranscriptRecord(record) {
  if (!isAssistantRecord(record)) {
    return ""
  }

  return (
    textFromValue(record.message?.content) ||
    textFromValue(record.content) ||
    textFromValue(record.message)
  )
}

function extractFromTranscriptArray(transcript) {
  if (!Array.isArray(transcript)) {
    return ""
  }

  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const text = textFromTranscriptRecord(transcript[index])
    if (text) {
      return text
    }
  }

  return ""
}

function safeTranscriptText(transcriptPath) {
  if (
    typeof transcriptPath !== "string" ||
    transcriptPath.includes("\0") ||
    !path.isAbsolute(transcriptPath)
  ) {
    return ""
  }

  try {
    const stat = fs.statSync(transcriptPath)
    if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) {
      return ""
    }

    const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim()
      if (!line) {
        continue
      }

      try {
        const record = JSON.parse(line)
        const text = textFromTranscriptRecord(record)
        if (text) {
          return text
        }
      } catch {
        continue
      }
    }
  } catch {
    return ""
  }

  return ""
}

function extractAssistantText(payload) {
  const textFields = [
    "last_assistant_message",
    "assistant_response",
    "response",
    "text",
  ]

  for (const field of textFields) {
    const text = textFromValue(payload[field])
    if (text) {
      return text
    }
  }

  const transcriptText = extractFromTranscriptArray(payload.transcript)
  if (transcriptText) {
    return transcriptText
  }

  return (
    safeTranscriptText(payload.agent_transcript_path) ||
    safeTranscriptText(payload.transcript_path)
  )
}

function detectSentinel(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const terminal =
    lines.includes(COMPLETE_SENTINEL) || lines.includes(BLOCKED_SENTINEL)

  return {
    active: lines.includes(ACTIVE_SENTINEL),
    terminal,
  }
}

function isExecuteRalphExpansion(payload) {
  if (payload.hook_event_name !== "UserPromptExpansion") {
    return false
  }

  const commandName = stringOrEmpty(payload.command_name).trim()
  if (EXECUTE_RALPH_COMMANDS.has(commandName)) {
    return true
  }

  const prompt = stringOrEmpty(payload.prompt).trim()
  return /^\/(?:xpowers:)?execute-ralph(?:\s|$)/.test(prompt)
}

function maxBlocks(env) {
  const raw = env.XPOWERS_RALPH_AUTOPILOT_MAX_BLOCKS
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    return DEFAULT_MAX_BLOCKS
  }

  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BLOCKS
}

function pathInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath)
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
}

function stateDir(env, payload) {
  const xdgStateHome =
    typeof env.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.trim() !== ""
      ? env.XDG_STATE_HOME
      : null
  const home =
    typeof env.HOME === "string" && env.HOME.trim() !== "" ? env.HOME : null
  const base = xdgStateHome || (home ? path.join(home, ".local", "state") : null)

  if (!base) {
    return null
  }

  const dir = path.resolve(base, "xpowers", "ralph-autopilot")
  if (typeof payload.cwd === "string" && payload.cwd.trim() !== "") {
    const cwd = path.resolve(payload.cwd)
    if (pathInside(cwd, dir)) {
      return null
    }
  }

  return dir
}

function ensureStateDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const probePath = path.join(
      dir,
      `.write-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )
    fs.writeFileSync(probePath, "ok", { flag: "wx", mode: 0o600 })
    fs.rmSync(probePath, { force: true })
    return true
  } catch {
    return false
  }
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : ""
}

function stateIdentity(payload) {
  const sessionId = stringOrEmpty(payload.session_id).trim()
  const transcriptPath =
    stringOrEmpty(payload.transcript_path).trim() ||
    stringOrEmpty(payload.agent_transcript_path).trim()
  const cwd = stringOrEmpty(payload.cwd).trim()

  if (sessionId) {
    return [`session:${sessionId}`]
  }

  if (!cwd || !transcriptPath) {
    return null
  }

  return [`cwd:${cwd}`, `transcript:${transcriptPath}`]
}

function stateKey(payload, includeAgent = true) {
  const keyParts = stateIdentity(payload)
  if (!keyParts) {
    return null
  }

  if (
    includeAgent &&
    payload.hook_event_name === "SubagentStop" &&
    stringOrEmpty(payload.agent_id).trim() !== ""
  ) {
    keyParts.push(`agent:${payload.agent_id.trim()}`)
  }

  return crypto.createHash("sha256").update(keyParts.join("|")).digest("hex")
}

function stateFileFor(dir, payload, includeAgent = true) {
  const key = stateKey(payload, includeAgent)
  return key ? path.join(dir, `${key}.json`) : null
}

function readState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"))
    const count = Number(parsed?.count)
    return {
      active: parsed?.active === true,
      count: Number.isSafeInteger(count) && count > 0 ? count : 0,
    }
  } catch {
    return { active: false, count: 0 }
  }
}

function writeState(filePath, state) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(state)}\n`, {
      mode: 0o600,
    })
    fs.renameSync(tempPath, filePath)
    return true
  } catch {
    try {
      fs.rmSync(tempPath, { force: true })
    } catch {
      // Ignore cleanup failures; hook must fail open.
    }
    return false
  }
}

function clearCounter(payload) {
  try {
    const dir = stateDir(process.env, payload)
    if (!dir) {
      return
    }

    for (const filePath of [
      stateFileFor(dir, payload),
      stateFileFor(dir, payload, false),
    ]) {
      if (filePath) {
        fs.rmSync(filePath, { force: true })
      }
    }
  } catch {
    // Terminal sentinels must never block because cleanup failed.
  }
}

function activationStatePath(payload) {
  const dir = stateDir(process.env, payload)
  if (!dir || !ensureStateDir(dir)) {
    return null
  }
  return stateFileFor(dir, payload, false)
}

function activateSession(payload) {
  const filePath = activationStatePath(payload)
  if (!filePath) {
    return allow()
  }

  writeState(filePath, { active: true, count: 0 })
  return allow()
}

function main() {
  try {
    const payload = parsePayload(readStdin())
    if (!payload) {
      return allow()
    }

    if (isExecuteRalphExpansion(payload)) {
      return activateSession(payload)
    }

    const assistantText = extractAssistantText(payload)
    if (!assistantText) {
      return allow()
    }

    const sentinel = detectSentinel(assistantText)
    if (sentinel.terminal) {
      clearCounter(payload)
      return allow()
    }

    if (!sentinel.active) {
      return allow()
    }

    const dir = stateDir(process.env, payload)
    if (!dir || !ensureStateDir(dir)) {
      return allow()
    }

    const activationPath = stateFileFor(dir, payload, false)
    const counterPath = stateFileFor(dir, payload)
    if (!activationPath || !counterPath) {
      return allow()
    }

    const activationState = readState(activationPath)
    if (!activationState.active) {
      return allow()
    }

    const counterState = readState(counterPath)
    const nextCount = counterState.count + 1
    if (nextCount > maxBlocks(process.env)) {
      return allow()
    }

    if (!writeState(counterPath, { active: true, count: nextCount })) {
      return allow()
    }

    return block(BLOCK_REASON)
  } catch {
    return allow()
  }
}

main()
