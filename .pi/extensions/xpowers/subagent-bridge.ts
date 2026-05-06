/**
 * Subagent bridge — translates XPowers xpowers_subagent calls to pi-subagents
 * when available, with graceful fallback to fallback-runner.ts.
 */

import {
  executeFallbackSubagent,
  executeFallbackSubagentAsync,
  type ExecutePiTaskParams,
  type PiTaskResult,
  type SpawnSyncLike,
  type SpawnAsyncLike,
  buildStructuredTaskPrompt,
  PI_THINKING_LEVELS,
} from "./fallback-runner.js"

export interface SubagentBridgeParams extends ExecutePiTaskParams {
  chain?: Array<{ agent: string; task: string }>
  tasks?: Array<{ agent: string; task: string }>
  async?: boolean
  context?: "fresh" | "fork"
  worktree?: boolean
  output?: string
  reads?: string[]
}

export interface ChainStep {
  agent: string
  task: string
  model?: string
  output?: string
  reads?: string[]
}

export interface ParallelTask {
  agent: string
  task: string
  model?: string
  output?: string
  reads?: string[]
}

export interface RoutingEntry {
  model?: string
  effort?: string
}

export interface PiSubagentsAPI {
  runAgent?: (params: {
    agent: string
    task: string
    model?: string
    thinking?: string
    cwd?: string
    context?: "fresh" | "fork"
    output?: string
    reads?: string[]
    format?: "text" | "structured"
  }) => Promise<PiTaskResult>

  runChain?: (params: {
    chain: Array<{
      agent: string
      task: string
      model?: string
      thinking?: string
      output?: string
      reads?: string[]
    }>
    cwd?: string
    context?: "fresh" | "fork"
    worktree?: boolean
  }) => Promise<PiTaskResult>

  runParallel?: (params: {
    tasks: Array<{
      agent: string
      task: string
      model?: string
      thinking?: string
      output?: string
      reads?: string[]
    }>
    cwd?: string
    context?: "fresh" | "fork"
    worktree?: boolean
    concurrency?: number
  }) => Promise<PiTaskResult>

  runAsync?: (params: {
    agent: string
    task: string
    model?: string
    thinking?: string
    cwd?: string
    context?: "fresh" | "fork"
    output?: string
    reads?: string[]
  }) => Promise<{ runId: string; status: string }>
}

let cachedPiSubagents: PiSubagentsAPI | null | undefined

export async function tryLoadPiSubagents(): Promise<PiSubagentsAPI | null> {
  if (cachedPiSubagents !== undefined) {
    return cachedPiSubagents
  }

  try {
    const mod = await import("pi-subagents")
    const api: PiSubagentsAPI = {}

    // Accept multiple possible export shapes
    if (mod.runAgent && typeof mod.runAgent === "function") {
      api.runAgent = mod.runAgent
    } else if (mod.default?.runAgent && typeof mod.default.runAgent === "function") {
      api.runAgent = mod.default.runAgent
    }

    if (mod.runChain && typeof mod.runChain === "function") {
      api.runChain = mod.runChain
    } else if (mod.default?.runChain && typeof mod.default.runChain === "function") {
      api.runChain = mod.default.runChain
    }

    if (mod.runParallel && typeof mod.runParallel === "function") {
      api.runParallel = mod.runParallel
    } else if (mod.default?.runParallel && typeof mod.default.runParallel === "function") {
      api.runParallel = mod.default.runParallel
    }

    if (mod.runAsync && typeof mod.runAsync === "function") {
      api.runAsync = mod.runAsync
    } else if (mod.default?.runAsync && typeof mod.default.runAsync === "function") {
      api.runAsync = mod.default.runAsync
    }

    cachedPiSubagents = api
    return api
  } catch {
    cachedPiSubagents = null
    return null
  }
}

export function clearPiSubagentsCache(): void {
  cachedPiSubagents = undefined
}

/** Test-only helper to inject a mock pi-subagents API. */
export function __testSetPiSubagents(api: PiSubagentsAPI | null): void {
  cachedPiSubagents = api
}

function appendThinkingSuffix(model: string, effort?: string): string {
  if (!effort) return model
  const lastColon = model.lastIndexOf(":")
  if (lastColon !== -1) {
    const suffix = model.slice(lastColon + 1)
    if (PI_THINKING_LEVELS.includes(suffix as any)) {
      return model
    }
  }
  return `${model}:${effort}`
}

export function translateToPiSubagents(
  params: SubagentBridgeParams,
  routingEntry?: RoutingEntry,
): {
  agent?: string
  task: string
  model?: string
  cwd?: string
  context?: "fresh" | "fork"
  output?: string
  reads?: string[]
} {
  const effectiveModel = params.model
    ?? (routingEntry?.model && routingEntry.model !== "inherit" ? routingEntry.model : undefined)

  const effectiveThinking = params.effort ?? routingEntry?.effort

  const effectiveModelWithThinking = effectiveModel
    ? appendThinkingSuffix(effectiveModel, effectiveThinking)
    : undefined

  let task = params.task
  if (params.format === "structured") {
    task = buildStructuredTaskPrompt(task)
  }

  return {
    agent: params.agent,
    task,
    model: effectiveModelWithThinking,
    cwd: params.cwd,
    context: params.context,
    output: params.output,
    reads: params.reads,
  }
}

export async function executeSingleViaBridge(
  params: SubagentBridgeParams,
  routingEntry?: RoutingEntry,
): Promise<PiTaskResult> {
  const api = await tryLoadPiSubagents()
  if (!api?.runAgent) {
    throw new Error("pi-subagents single-agent runner not available")
  }

  const translated = translateToPiSubagents(params, routingEntry)
  return api.runAgent(translated)
}

export async function executeChainViaBridge(
  steps: ChainStep[],
  resolveRouting: (agent?: string, type?: string) => RoutingEntry,
  cwd?: string,
  context?: "fresh" | "fork",
  worktree?: boolean,
): Promise<PiTaskResult> {
  const api = await tryLoadPiSubagents()
  if (!api?.runChain) {
    throw new Error("pi-subagents chain runner not available")
  }

  const translatedSteps = steps.map((step) => {
    const routing = resolveRouting(step.agent)
    const model = step.model
      ?? (routing.model && routing.model !== "inherit" ? routing.model : undefined)
    return {
      agent: step.agent,
      task: step.task,
      model: model ? appendThinkingSuffix(model, routing.effort) : undefined,
      output: step.output,
      reads: step.reads,
    }
  })

  return api.runChain({ chain: translatedSteps, cwd, context, worktree })
}

export async function executeParallelViaBridge(
  tasks: ParallelTask[],
  resolveRouting: (agent?: string, type?: string) => RoutingEntry,
  cwd?: string,
  context?: "fresh" | "fork",
  worktree?: boolean,
  concurrency?: number,
): Promise<PiTaskResult> {
  const api = await tryLoadPiSubagents()
  if (!api?.runParallel) {
    throw new Error("pi-subagents parallel runner not available")
  }

  const translatedTasks = tasks.map((task) => {
    const routing = resolveRouting(task.agent)
    const model = task.model
      ?? (routing.model && routing.model !== "inherit" ? routing.model : undefined)
    return {
      agent: task.agent,
      task: task.task,
      model: model ? appendThinkingSuffix(model, routing.effort) : undefined,
      output: task.output,
      reads: task.reads,
    }
  })

  return api.runParallel({ tasks: translatedTasks, cwd, context, worktree, concurrency })
}

export async function executeAsyncViaBridge(
  params: SubagentBridgeParams,
  routingEntry?: RoutingEntry,
): Promise<{ runId: string; status: string }> {
  const api = await tryLoadPiSubagents()
  if (!api?.runAsync) {
    throw new Error("pi-subagents async runner not available")
  }

  const translated = translateToPiSubagents(params, routingEntry)
  return api.runAsync(translated)
}

export type RoutingResolver = (agent?: string, type?: string) => RoutingEntry

function hasBridgeOnlyParams(params: SubagentBridgeParams): boolean {
  return Boolean(
    params.chain ||
    params.tasks ||
    params.worktree ||
    params.output ||
    params.reads,
  )
}

function buildDegradationResult(
  format: SubagentBridgeParams["format"],
  dropped: string[],
  reason: string,
): PiTaskResult {
  const message = `Bridge degradation: pi-subagents is required for ${dropped.join(", ")} but is unavailable (${reason}). Install with: pi install npm:pi-subagents`
  if (format === "structured") {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        status: "FAIL",
        summary: message,
        findings: [{ message, type: "bridge-unavailable", source: "xpowers-subagent" }],
        nextAction: "Install pi-subagents or remove bridge-only parameters",
      }) }],
    }
  }
  return { content: [{ type: "text" as const, text: message }] }
}

export async function executeSubagent(
  params: SubagentBridgeParams,
  routingEntry?: RoutingEntry,
  resolveRouting?: RoutingResolver,
): Promise<PiTaskResult> {
  // Reject mixed async + chain/tasks usage upfront
  if (params.async && (params.chain || params.tasks)) {
    const error = "async cannot be combined with chain or tasks"
    if (params.format === "structured") {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          status: "FAIL",
          summary: error,
          findings: [{ message: error, type: "validation-error" }],
          nextAction: "Use async alone, or use chain/tasks without async",
        }) }],
      }
    }
    return { content: [{ type: "text" as const, text: error }] }
  }

  const resolver: RoutingResolver = resolveRouting ?? (() => routingEntry ?? {})

  // Decide whether to use the bridge or fallback
  const useBridge = Boolean(
    params.chain ||
    params.tasks ||
    params.async ||
    params.worktree ||
    params.output ||
    params.reads,
  )

  if (useBridge) {
    try {
      if (params.chain) {
        const steps = params.chain.map((s) => ({
          agent: s.agent,
          task: s.task,
          model: params.model ?? undefined,
          output: params.output,
          reads: params.reads,
        }))
        return await executeChainViaBridge(
          steps,
          resolver,
          params.cwd,
          params.context,
          params.worktree,
        )
      }

      if (params.tasks) {
        const parallelTasks = params.tasks.map((t) => ({
          agent: t.agent,
          task: t.task,
          model: params.model ?? undefined,
          output: params.output,
          reads: params.reads,
        }))
        return await executeParallelViaBridge(
          parallelTasks,
          resolver,
          params.cwd,
          params.context,
          params.worktree,
        )
      }

      return await executeSingleViaBridge(params, routingEntry)
    } catch (err: any) {
      const dropped: string[] = []
      if (params.chain) dropped.push("chain")
      if (params.tasks) dropped.push("tasks")
      if (params.worktree) dropped.push("worktree")
      if (params.output) dropped.push("output")
      if (params.reads) dropped.push("reads")
      if (params.async) dropped.push("async")

      if (hasBridgeOnlyParams(params)) {
        return buildDegradationResult(params.format, dropped, err?.message)
      }

      // Bridge-only params not present — safe to fall back silently
      console.warn(`[xpowers] pi-subagents bridge failed (${err?.message}), falling back to native runner`)
    }
  }

  // Fallback path
  return executeFallbackSubagent({
    task: params.task,
    model: params.model,
    effort: params.effort,
    cwd: params.cwd,
    format: params.format,
    contextMode: params.context ?? "fresh",
    sessionSeedPath: params.sessionSeedPath,
  })
}

export async function executeSubagentAsync(
  params: SubagentBridgeParams,
  routingEntry?: RoutingEntry,
  resolveRouting?: RoutingResolver,
  signal?: AbortSignal,
): Promise<PiTaskResult> {
  if (params.async && (params.chain || params.tasks)) {
    const error = "async cannot be combined with chain or tasks"
    if (params.format === "structured") {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          status: "FAIL",
          summary: error,
          findings: [{ message: error, type: "validation-error" }],
          nextAction: "Use async alone, or use chain/tasks without async",
        }) }],
      }
    }
    return { content: [{ type: "text" as const, text: error }] }
  }

  const useBridge = Boolean(
    params.chain ||
    params.tasks ||
    params.async ||
    params.worktree ||
    params.output ||
    params.reads,
  )

  if (useBridge) {
    try {
      if (params.async && !params.chain && !params.tasks) {
        const status = await executeAsyncViaBridge(params, routingEntry)
        return {
          content: [{
            type: "text" as const,
            text: `Async subagent started. Run ID: ${status.runId}. Status: ${status.status}.`,
          }],
        }
      }

      return await executeSubagent(params, routingEntry, resolveRouting)
    } catch (err: any) {
      const dropped: string[] = []
      if (params.chain) dropped.push("chain")
      if (params.tasks) dropped.push("tasks")
      if (params.worktree) dropped.push("worktree")
      if (params.output) dropped.push("output")
      if (params.reads) dropped.push("reads")
      if (params.async) dropped.push("async")

      if (hasBridgeOnlyParams(params)) {
        return buildDegradationResult(params.format, dropped, err?.message)
      }

      console.warn(`[xpowers] pi-subagents bridge failed (${err?.message}), falling back to native runner`)
    }
  }

  return executeFallbackSubagentAsync({
    task: params.task,
    model: params.model,
    effort: params.effort,
    cwd: params.cwd,
    format: params.format,
    contextMode: params.context ?? "fresh",
    sessionSeedPath: params.sessionSeedPath,
  }, undefined, signal)
}
