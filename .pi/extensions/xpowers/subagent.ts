import { spawn, spawnSync } from "node:child_process"

import {
  XPOWERS_SUBAGENT_DEPTH_ENV,
  MAX_ASYNC_SUBAGENT_OUTPUT_BYTES,
  MAX_XPOWERS_SUBAGENT_DEPTH,
  PI_THINKING_LEVELS,
  STRUCTURED_TASK_STATUSES,
  buildPiTaskArgs,
  buildStructuredTaskPrompt,
  executeFallbackSubagent,
  executeFallbackSubagentAsync,
  normalizeThinkingLevel,
  parseStructuredTaskOutput,
  parseSubagentDepth,
  type ExecutePiTaskParams,
  type PiTaskFormat,
  type PiTaskResult,
  type PiThinkingLevel,
  type SpawnAsyncLike,
  type SpawnSyncLike,
  type StructuredTaskOutput,
  type StructuredTaskStatus,
} from "./fallback-runner"

export type PiSubagentFormat = PiTaskFormat
export type StructuredSubagentStatus = StructuredTaskStatus
export type PiSubagentResult = PiTaskResult
export type StructuredSubagentOutput = StructuredTaskOutput
export interface ExecutePiSubagentParams extends ExecutePiTaskParams {}
export type { SpawnSyncLike, SpawnAsyncLike }
export { XPOWERS_SUBAGENT_DEPTH_ENV, MAX_XPOWERS_SUBAGENT_DEPTH, MAX_ASYNC_SUBAGENT_OUTPUT_BYTES, PI_THINKING_LEVELS }
export const STRUCTURED_SUBAGENT_STATUSES = STRUCTURED_TASK_STATUSES

// Re-export bridge types for consumers that need advanced execution modes
export type {
  SubagentBridgeParams,
  ChainStep,
  ParallelTask,
  RoutingEntry,
} from "./subagent-bridge.js"
export {
  executeSubagent,
  executeSubagentAsync,
  translateToPiSubagents,
  tryLoadPiSubagents,
  clearPiSubagentsCache,
} from "./subagent-bridge.js"

export function buildStructuredSubagentTask(task: string): string {
  return buildStructuredTaskPrompt(task)
}

export function parseStructuredSubagentOutput(output: string): StructuredSubagentOutput {
  return parseStructuredTaskOutput(output)
}

export function buildPiSubagentArgs(task: string, model?: string | null, thinking?: string): string[] {
  return buildPiTaskArgs(task, model, thinking, "fresh")
}

export { normalizeThinkingLevel, parseSubagentDepth }
export type { PiThinkingLevel }

export function executePiSubagent(
  params: ExecutePiSubagentParams,
  run: SpawnSyncLike = spawnSync,
): PiSubagentResult {
  return executeFallbackSubagent({
    ...params,
    contextMode: "fresh",
  }, run)
}

export async function executePiSubagentAsync(
  params: ExecutePiSubagentParams,
  run: SpawnAsyncLike = spawn,
  signal?: AbortSignal,
): Promise<PiSubagentResult> {
  return await executeFallbackSubagentAsync({
    ...params,
    contextMode: "fresh",
  }, run, signal)
}
