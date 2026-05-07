/**
 * Fallback subagent runner — delegates to task-runner.ts.
 * Used when pi-subagents is unavailable or incompatible.
 * Preserves exact behavior of the original executePiTask / executePiTaskAsync.
 */

import { spawn, spawnSync } from "node:child_process"
import {
  type PiTaskFormat,
  type PiTaskResult,
  type SpawnSyncLike,
  type SpawnAsyncLike,
  buildPiTaskArgs,
  buildFailureResult,
  parseStructuredTaskOutput,
  prepareTask,
  resolveContextMode,
  buildContextFailure,
  createForkSessionSync,
  createForkSessionAsync,
  cleanupForkSessionSync,
  cleanupForkSessionAsync,
  XPOWERS_SUBAGENT_DEPTH_ENV,
  MAX_XPOWERS_SUBAGENT_DEPTH,
  MAX_ASYNC_SUBAGENT_OUTPUT_BYTES,
  parseSubagentDepth,
} from "./task-runner.js"

export {
  type PiTaskFormat,
  type PiTaskResult,
  type SpawnSyncLike,
  type SpawnAsyncLike,
  buildStructuredTaskPrompt,
  parseStructuredTaskOutput,
  normalizeThinkingLevel,
  parseSubagentDepth,
  XPOWERS_SUBAGENT_DEPTH_ENV,
  MAX_XPOWERS_SUBAGENT_DEPTH,
  MAX_ASYNC_SUBAGENT_OUTPUT_BYTES,
  PI_THINKING_LEVELS,
  STRUCTURED_TASK_STATUSES,
  type StructuredTaskStatus,
  type StructuredTaskOutput,
  type ExecutePiTaskParams,
  type PiThinkingLevel,
  type PiTaskContextMode,
} from "./task-runner.js"

export function executeFallbackSubagent(
  params: import("./task-runner.js").ExecutePiTaskParams,
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

  let forkSession: { dir: string; seedPath: string } | undefined
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
  params: import("./task-runner.js").ExecutePiTaskParams,
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

  let forkSession: { dir: string; seedPath: string } | undefined
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
