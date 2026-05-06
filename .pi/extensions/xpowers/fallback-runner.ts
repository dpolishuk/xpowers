/**
 * Fallback subagent runner — extracted from task-runner.ts.
 * Used when pi-subagents is unavailable or incompatible.
 * Preserves exact behavior of the original executePiTask / executePiTaskAsync.
 */

import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type PiTaskFormat = "text" | "structured"
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
export type PiTaskContextMode = "fresh" | "fork"

export const STRUCTURED_TASK_STATUSES = ["PASS", "ISSUES_FOUND", "FAIL"] as const
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const
export const XPOWERS_SUBAGENT_DEPTH_ENV = "XPOWERS_SUBAGENT_DEPTH"
export const MAX_XPOWERS_SUBAGENT_DEPTH = 1
export const MAX_ASYNC_SUBAGENT_OUTPUT_BYTES = 1024 * 1024 * 10
export type StructuredTaskStatus = typeof STRUCTURED_TASK_STATUSES[number]

export interface StructuredTaskOutput {
  status: StructuredTaskStatus
  summary: string
  findings: unknown[]
  nextAction?: string
}

export interface ExecutePiTaskParams {
  task: string
  model?: string | null
  effort?: string
  cwd?: string
  format?: PiTaskFormat
  contextMode?: PiTaskContextMode
  sessionSeedPath?: string
}

export type SpawnSyncLike = (
  command: string,
  args: string[],
  options: {
    encoding: "utf8"
    timeout: number
    maxBuffer: number
    cwd: string
    env: NodeJS.ProcessEnv
  },
) => SpawnSyncReturns<string>

export interface PiTaskResult {
  content: Array<{ type: "text"; text: string }>
}

export type SpawnAsyncLike = (
  command: string,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    stdio: ["ignore", "pipe", "pipe"]
  },
) => import("node:child_process").ChildProcess

interface ForkSession {
  dir: string
  seedPath: string
}

export function buildStructuredTaskPrompt(task: string): string {
  return `${task}\n\nReturn valid JSON only. Do not include markdown fences, commentary, or prose outside the JSON object. Use exactly this shape:\n{\n  "status": "PASS|ISSUES_FOUND|FAIL",\n  "summary": "short summary",\n  "findings": [],\n  "nextAction": "optional next step"\n}`
}

export function parseStructuredTaskOutput(output: string): StructuredTaskOutput {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error("Structured subagent output was not valid JSON")
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Structured subagent output must be a JSON object")
  }

  const candidate = parsed as Record<string, unknown>
  if (typeof candidate.status !== "string") {
    throw new Error("Structured subagent output must include string field 'status'")
  }
  if (!STRUCTURED_TASK_STATUSES.includes(candidate.status as StructuredTaskStatus)) {
    throw new Error("Structured subagent output field 'status' must be one of PASS, ISSUES_FOUND, FAIL")
  }
  if (typeof candidate.summary !== "string") {
    throw new Error("Structured subagent output must include string field 'summary'")
  }
  if (!Array.isArray(candidate.findings)) {
    throw new Error("Structured subagent output must include array field 'findings'")
  }
  if (candidate.nextAction !== undefined && typeof candidate.nextAction !== "string") {
    throw new Error("Structured subagent output field 'nextAction' must be a string when present")
  }

  return {
    status: candidate.status as StructuredTaskStatus,
    summary: candidate.summary,
    findings: candidate.findings,
    nextAction: candidate.nextAction as string | undefined,
  }
}

export function normalizeThinkingLevel(effort?: string): PiThinkingLevel | undefined {
  if (!effort) return undefined
  return PI_THINKING_LEVELS.includes(effort as PiThinkingLevel)
    ? effort as PiThinkingLevel
    : undefined
}

export function parseSubagentDepth(value?: string): number {
  if (!value) return 0
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function buildFailureResult(
  format: PiTaskFormat | undefined,
  summary: string,
  details: string,
  nextAction: string,
  findingType = "subprocess-error",
): PiTaskResult {
  if (format === "structured") {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        status: "FAIL",
        summary,
        findings: [{
          message: details,
          type: findingType,
          source: "pi-subagent",
        }],
        nextAction,
      }) }],
    }
  }

  return {
    content: [{ type: "text" as const, text: `${summary}: ${details}` }],
  }
}

export function buildPiTaskArgs(
  task: string,
  model?: string | null,
  thinking?: string,
  contextMode: PiTaskContextMode = "fresh",
  sessionPath?: string,
  sessionDir?: string,
): string[] {
  const args = ["--print"]
  if (contextMode === "fresh") {
    args.push("--no-session")
  } else {
    if (!sessionPath || !sessionDir) {
      throw new Error("Fork context requires sessionPath and sessionDir")
    }
    args.push("--session", sessionPath, "--session-dir", sessionDir)
  }

  if (model) {
    args.push("--model", model)
  }
  const normalizedThinking = normalizeThinkingLevel(thinking)
  if (normalizedThinking) {
    args.push("--thinking", normalizedThinking)
  }
  args.push(task)
  return args
}

function createForkSessionSync(sessionSeedPath: string): ForkSession {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-runner-"))
  const seedPath = join(dir, "seed.jsonl")
  try {
    copyFileSync(sessionSeedPath, seedPath)
    return { dir, seedPath }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

async function createForkSessionAsync(sessionSeedPath: string): Promise<ForkSession> {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-runner-"))
  const seedPath = join(dir, "seed.jsonl")
  try {
    await copyFile(sessionSeedPath, seedPath)
    return { dir, seedPath }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

function cleanupForkSessionSync(session?: ForkSession): void {
  if (!session) return
  try {
    rmSync(session.dir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup — don't let cleanup errors override subagent results
  }
}

async function cleanupForkSessionAsync(session?: ForkSession): Promise<void> {
  if (!session) return
  try {
    await rm(session.dir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup — don't let cleanup errors override subagent results
  }
}

function resolveContextMode(params: ExecutePiTaskParams): PiTaskContextMode {
  return params.contextMode ?? "fresh"
}

function prepareTask(params: ExecutePiTaskParams): string {
  return params.format === "structured"
    ? buildStructuredTaskPrompt(params.task)
    : params.task
}

function buildContextFailure(
  format: PiTaskFormat | undefined,
  contextMode: PiTaskContextMode,
  details = `Context mode '${contextMode}' requires a session seed path but none was provided`,
): PiTaskResult {
  const isMissingSeed = details.includes("session seed path")
  const summary = isMissingSeed
    ? `Subagent failed (${contextMode} context unavailable)`
    : `Subagent failed (${contextMode} context setup error)`
  const nextAction = isMissingSeed
    ? "Retry with a fresh context or supply a valid parent session seed before using fork mode"
    : "Inspect the error details and retry with a fresh context if the issue persists"
  return buildFailureResult(
    format,
    summary,
    details,
    nextAction,
    isMissingSeed ? "missing-session" : "fork-setup-error",
  )
}

export function executeFallbackSubagent(
  params: ExecutePiTaskParams,
  run: SpawnSyncLike = spawnSync,
): PiTaskResult {
  const task = prepareTask(params)
  const cwd = params.cwd || process.cwd()
  const currentDepth = parseSubagentDepth(process.env[XPOWERS_SUBAGENT_DEPTH_ENV])
  if (currentDepth >= MAX_XPOWERS_SUBAGENT_DEPTH) {
    return buildFailureResult(
      params.format,
      `Subagent failed (maximum subagent recursion depth ${MAX_XPOWERS_SUBAGENT_DEPTH} reached)`,
      "Refusing to launch nested Pi subprocesses beyond the supported recursion limit",
      "Run the remaining review or investigation steps in the current session instead of spawning another subagent",
      "recursion-limit",
    )
  }

  const contextMode = resolveContextMode(params)
  if (contextMode === "fork" && !params.sessionSeedPath) {
    return buildContextFailure(params.format, contextMode)
  }

  let forkSession: ForkSession | undefined
  try {
    if (contextMode === "fork" && params.sessionSeedPath) {
      try {
        forkSession = createForkSessionSync(params.sessionSeedPath)
      } catch (error: any) {
        return buildContextFailure(
          params.format,
          contextMode,
          error?.message || `Unable to prepare fork session from '${params.sessionSeedPath}'`,
        )
      }
    }

    const args = buildPiTaskArgs(task, params.model, params.effort, contextMode, forkSession?.seedPath, forkSession?.dir)
    const result = run("pi", args, {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 10,
      cwd,
      env: {
        ...process.env,
        [XPOWERS_SUBAGENT_DEPTH_ENV]: String(currentDepth + 1),
      },
    })

    const output = result.stdout?.trim() || ""
    const details = result.stderr?.trim() || output || "unknown error"
    if (result.status === null) {
      const signalInfo = result.signal ? `; signal: ${result.signal}` : ""
      const errorInfo = result.error?.message ? `; error: ${result.error.message}` : ""
      return buildFailureResult(
        params.format,
        `Subagent failed (no exit status${signalInfo}${errorInfo})`,
        details,
        "Check Pi subprocess availability and runtime logs",
      )
    }
    if (result.status !== 0) {
      return buildFailureResult(
        params.format,
        `Subagent failed (exit ${result.status})`,
        details,
        "Inspect stderr/stdout details and retry once the subprocess issue is resolved",
      )
    }

    if (params.format === "structured") {
      try {
        const parsed = parseStructuredTaskOutput(output)
        return {
          content: [{ type: "text" as const, text: JSON.stringify(parsed) }],
        }
      } catch (error: any) {
        return buildFailureResult(
          params.format,
          error?.message || "Structured subagent output was not valid JSON",
          output || "(empty output)",
          "Retry with a clearer task or inspect the raw subagent output",
          "parse-error",
        )
      }
    }

    return {
      content: [{ type: "text" as const, text: output || "(subagent returned empty result)" }],
    }
  } finally {
    cleanupForkSessionSync(forkSession)
  }
}

export async function executeFallbackSubagentAsync(
  params: ExecutePiTaskParams,
  run: SpawnAsyncLike = spawn,
  signal?: AbortSignal,
): Promise<PiTaskResult> {
  const task = prepareTask(params)
  const cwd = params.cwd || process.cwd()
  const currentDepth = parseSubagentDepth(process.env[XPOWERS_SUBAGENT_DEPTH_ENV])
  if (currentDepth >= MAX_XPOWERS_SUBAGENT_DEPTH) {
    return buildFailureResult(
      params.format,
      `Subagent failed (maximum subagent recursion depth ${MAX_XPOWERS_SUBAGENT_DEPTH} reached)`,
      "Refusing to launch nested Pi subprocesses beyond the supported recursion limit",
      "Run the remaining review or investigation steps in the current session instead of spawning another subagent",
      "recursion-limit",
    )
  }

  if (signal?.aborted) {
    return buildFailureResult(
      params.format,
      "Subagent failed (cancelled)",
      "Subagent cancelled by parent signal",
      "Retry once the parent operation is resumed",
      "cancelled",
    )
  }

  const contextMode = resolveContextMode(params)
  if (contextMode === "fork" && !params.sessionSeedPath) {
    return buildContextFailure(params.format, contextMode)
  }

  let forkSession: ForkSession | undefined
  try {
    if (contextMode === "fork" && params.sessionSeedPath) {
      try {
        forkSession = await createForkSessionAsync(params.sessionSeedPath)
      } catch (error: any) {
        return buildContextFailure(
          params.format,
          contextMode,
          error?.message || `Unable to prepare fork session from '${params.sessionSeedPath}'`,
        )
      }
      if (signal?.aborted) {
        return buildFailureResult(
          params.format,
          "Subagent failed (cancelled)",
          "Subagent cancelled by parent signal during fork session setup",
          "Retry once the parent operation is resumed",
          "cancelled",
        )
      }
    }

    const args = buildPiTaskArgs(task, params.model, params.effort, contextMode, forkSession?.seedPath, forkSession?.dir)
    return await new Promise<PiTaskResult>((resolve) => {
      const child = run("pi", args, {
        cwd,
        env: {
          ...process.env,
          [XPOWERS_SUBAGENT_DEPTH_ENV]: String(currentDepth + 1),
        },
        stdio: ["ignore", "pipe", "pipe"],
      })

      let stdout = ""
      let stderr = ""
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      let timedOut = false
      let aborted = false
      let pendingExitResult: PiTaskResult | null = null
      let terminationTimer: ReturnType<typeof setTimeout> | undefined
      let abortHandler: (() => void) | undefined
      const finish = (result: PiTaskResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (terminationTimer) clearTimeout(terminationTimer)
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler)
        resolve(result)
      }
      const requestTermination = (result: PiTaskResult, reason: "timeout" | "abort" | "output-limit") => {
        if (settled || pendingExitResult) return
        pendingExitResult = result
        if (reason === "timeout") timedOut = true
        if (reason === "abort") aborted = true
        child.kill("SIGTERM")
        terminationTimer = setTimeout(() => {
          if (settled) return
          child.kill("SIGKILL")
          finish(result)
        }, 1000)
      }

      const timer = setTimeout(() => {
        requestTermination(buildFailureResult(
          params.format,
          "Subagent failed (timeout)",
          stderr.trim() || stdout.trim() || "subprocess timed out after 120000ms",
          "Inspect the delegated task and retry with a narrower scope",
        ), "timeout")
      }, 120000)

      if (signal) {
        abortHandler = () => {
          requestTermination(buildFailureResult(
            params.format,
            "Subagent failed (cancelled)",
            stderr.trim() || stdout.trim() || "Subagent cancelled by parent signal",
            "Retry once the parent operation is resumed",
            "cancelled",
          ), "abort")
        }
        signal.addEventListener("abort", abortHandler, { once: true })
        if (signal.aborted) {
          abortHandler()
          return
        }
      }

      child.stdout?.setEncoding?.("utf8")
      child.stderr?.setEncoding?.("utf8")
      child.stdout?.on("data", (chunk) => {
        if (settled || pendingExitResult) return
        stdout += chunk
        stdoutBytes += Buffer.byteLength(chunk)
        if (stdoutBytes > MAX_ASYNC_SUBAGENT_OUTPUT_BYTES) {
          requestTermination(buildFailureResult(
            params.format,
            "Subagent failed (output exceeded max buffer)",
            `stdout exceeded ${MAX_ASYNC_SUBAGENT_OUTPUT_BYTES} bytes`,
            "Reduce delegated output volume or narrow the task scope before retrying",
            "output-limit",
          ), "output-limit")
        }
      })
      child.stderr?.on("data", (chunk) => {
        if (settled || pendingExitResult) return
        stderr += chunk
        stderrBytes += Buffer.byteLength(chunk)
        if (stderrBytes > MAX_ASYNC_SUBAGENT_OUTPUT_BYTES) {
          requestTermination(buildFailureResult(
            params.format,
            "Subagent failed (output exceeded max buffer)",
            `stderr exceeded ${MAX_ASYNC_SUBAGENT_OUTPUT_BYTES} bytes`,
            "Reduce delegated output volume or narrow the task scope before retrying",
            "output-limit",
          ), "output-limit")
        }
      })
      child.on("error", (error) => {
        if (aborted || timedOut) return
        finish(buildFailureResult(
          params.format,
          `Subagent failed (spawn error: ${error.message})`,
          stderr.trim() || stdout.trim() || error.message,
          "Check Pi subprocess availability and runtime logs",
        ))
      })
      child.on("close", (code, closeSignal) => {
        if (pendingExitResult) {
          finish(pendingExitResult)
          return
        }
        const output = stdout.trim()
        const details = stderr.trim() || output || "unknown error"
        if (code === null) {
          finish(buildFailureResult(
            params.format,
            `Subagent failed (no exit status${closeSignal ? `; signal: ${closeSignal}` : ""})`,
            details,
            "Check Pi subprocess availability and runtime logs",
          ))
          return
        }
        if (code !== 0) {
          finish(buildFailureResult(
            params.format,
            `Subagent failed (exit ${code})`,
            details,
            "Inspect stderr/stdout details and retry once the subprocess issue is resolved",
          ))
          return
        }
        if (params.format === "structured") {
          try {
            const parsed = parseStructuredTaskOutput(output)
            finish({ content: [{ type: "text", text: JSON.stringify(parsed) }] })
          } catch (error: any) {
            finish(buildFailureResult(
              params.format,
              error?.message || "Structured subagent output was not valid JSON",
              output || "(empty output)",
              "Retry with a clearer task or inspect the raw subagent output",
              "parse-error",
            ))
          }
          return
        }
        finish({ content: [{ type: "text", text: output || "(subagent returned empty result)" }] })
      })
    })
  } finally {
    await cleanupForkSessionAsync(forkSession)
  }
}
