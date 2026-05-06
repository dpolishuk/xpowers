import { executeSubagentAsync } from "./subagent-bridge.js"
import { executePiTasksParallel } from "./task-runner"
import { resolveRoutingEntry, type RoutingConfig, normalizeRoutingConfig } from "./routing"
import { readFileSync, existsSync } from "node:fs"
import { join, dirname, basename, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { StructuredTaskOutput } from "./fallback-runner.js"

export interface ResolvedParallelReviewRoute {
  model?: string | null
  effort?: string
}

export interface ParallelReviewParams {
  task: string
  type: "review" | "validation"
  agent: "review-quality" | "review-implementation" | "review-simplification"
  format: "structured"
  model?: string | null
  effort?: string
  cwd?: string
}

export interface ParallelReviewRequest {
  lane: "quality" | "implementation" | "simplification"
  params: ParallelReviewParams
}

export interface ParallelReviewExecutionContext {
  cwd?: string
  resolveRoute?: (params: Pick<ParallelReviewParams, "type" | "agent">) => ResolvedParallelReviewRoute
  uiCtx?: any
}

export type ParallelReviewExecutor = (params: ParallelReviewParams) => Promise<StructuredTaskOutput>

function getRoutingConfigPath(): string {
  const sourceDir = dirname(fileURLToPath(import.meta.url))
  const extDir = basename(sourceDir) === "dist" ? resolve(sourceDir, "..") : sourceDir
  return join(extDir, "routing.json")
}

function loadRoutingConfig(): RoutingConfig {
  try {
    const routingPath = getRoutingConfigPath()
    if (existsSync(routingPath)) {
      return normalizeRoutingConfig(JSON.parse(readFileSync(routingPath, "utf8")))
    }
  } catch {
    // ignore
  }
  return normalizeRoutingConfig({})
}

async function defaultParallelReviewExecutor(params: ParallelReviewParams): Promise<StructuredTaskOutput> {
  const config = loadRoutingConfig()
  const routing = resolveRoutingEntry(config, {
    type: params.type,
    agent: params.agent,
    explicitModel: params.model ?? undefined,
  })
  const result = await executeSubagentAsync(
    {
      task: params.task,
      model: params.model,
      effort: params.effort,
      agent: params.agent,
      cwd: params.cwd,
      format: params.format,
    },
    routing.model ? { model: routing.model, effort: routing.effort } : undefined,
  )
  return JSON.parse(result.content[0]?.text || "{}") as StructuredTaskOutput
}

export function buildParallelReviewRequests(cwd?: string): ParallelReviewRequest[] {
  return [
    {
      lane: "quality",
      params: {
        cwd,
        type: "review",
        agent: "review-quality",
        format: "structured",
        task: "Review the recent code changes for bugs, security issues, and race conditions. Check git diff HEAD~1. Return PASS or ISSUES_FOUND with file:line references.",
      },
    },
    {
      lane: "implementation",
      params: {
        cwd,
        type: "validation",
        agent: "review-implementation",
        format: "structured",
        task: "Verify the recent changes achieve their stated goals. Check git log --oneline -5 for context. Return PASS or ISSUES_FOUND with missing items.",
      },
    },
    {
      lane: "simplification",
      params: {
        cwd,
        type: "review",
        agent: "review-simplification",
        format: "structured",
        task: "Check for over-engineering in recent changes. Look for unnecessary abstractions. Return PASS or ISSUES_FOUND with recommendations.",
      },
    },
  ]
}

function applyResolvedRoute(
  request: ParallelReviewRequest,
  resolveRoute?: (params: Pick<ParallelReviewParams, "type" | "agent">) => ResolvedParallelReviewRoute,
): ParallelReviewRequest {
  if (!resolveRoute) return request
  const resolved = resolveRoute({ type: request.params.type, agent: request.params.agent })
  return {
    lane: request.lane,
    params: {
      ...request.params,
      model: resolved.model ?? undefined,
      effort: resolved.effort,
    },
  }
}

export async function runParallelReview(
  ctx: ParallelReviewExecutionContext,
  execute: ParallelReviewExecutor = defaultParallelReviewExecutor,
): Promise<string> {
  const requests = buildParallelReviewRequests(ctx.cwd).map((request) => applyResolvedRoute(request, ctx.resolveRoute))

  let dashboard: any = null
  let handle: any = null
  const controller = new AbortController()

  if (ctx.uiCtx?.ui?.custom) {
    const { LiveExecutionDashboard } = await import("./execution-dashboard-tui.js")
    const initialState = {
      title: "Parallel Review",
      tasks: requests.map(req => ({
        id: req.lane,
        title: `Review ${req.lane}`,
        status: "pending" as const,
        effort: req.params.effort
      }))
    }
    dashboard = new LiveExecutionDashboard(initialState, () => {
      controller.abort()
    })
    handle = ctx.uiCtx.ui.custom(
      (tui: any, _theme: any, _keybindings: any, _done: (v: unknown) => void) => {
        dashboard.tui = tui
        dashboard.onCancel = () => {
          controller.abort()
          _done(null)
        }
        return dashboard
      },
      { overlay: true, overlayOptions: { width: "96%", maxHeight: "90%", margin: 1 } }
    )
  }

  let results: any[] = []
  try {
    results = await executePiTasksParallel(requests, async ({ lane, params }) => {
      try {
        if (dashboard && handle) {
          dashboard.updateTask(lane, { status: "running" })
          handle.requestRender()
        }
        const result = await execute(params)
        if (dashboard && handle) {
          dashboard.updateTask(lane, { status: result.status, summary: result.summary })
          handle.requestRender()
        }
        return {
          lane,
          status: result.status,
          summary: result.summary,
        }
      } catch (error: any) {
        const summary = error?.message || String(error)
        if (dashboard && handle) {
          dashboard.updateTask(lane, { status: "FAIL", summary })
          handle.requestRender()
        }
        return {
          lane,
          status: "FAIL",
          summary,
        }
      }
    }, { maxConcurrency: 3, signal: controller.signal })
  } finally {
    handle?.close()
  }

  const lines = [
    "# Parallel Review",
    "",
    "Lane | Status | Summary",
    "--- | --- | ---",
    ...results.map((result) => `${result.lane} | ${result.status} | ${result.summary}`),
  ]

  return lines.join("\n")
}
