import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// XPowers Task Monitor Plugin
// Live polling of `tm ready` with toast notifications when new tasks unlock.
// Shows task count summaries on session events and provides a custom tool
// for the AI to query current task status.
//
// Inspired by pi-agent-extensions statusline (task tracking concept).
// ─────────────────────────────────────────────────────────────────────────────

type TaskMonitorConfig = {
  enabled?: boolean
  pollIntervalMs?: number
  minPriority?: number
  showTaskCount?: boolean
  trackSeenTasks?: boolean
  seenTasksTtlMs?: number
  notifyOnNewTasks?: boolean
  notifyOnSessionIdle?: boolean
  notifyOnSessionStart?: boolean
  maxTasksInToast?: number
  logDir?: string
}

type SeenTask = {
  id: string
  title: string
  priority: number
  firstSeenAt: number
}

type ParsedTask = {
  id: string
  title: string
  priority: number
}

const DEFAULT_CONFIG: Required<TaskMonitorConfig> = {
  enabled: true,
  pollIntervalMs: 60000,
  minPriority: 2,
  showTaskCount: true,
  trackSeenTasks: true,
  seenTasksTtlMs: 86400000,
  notifyOnNewTasks: true,
  notifyOnSessionIdle: true,
  notifyOnSessionStart: false,
  maxTasksInToast: 3,
  logDir: ".opencode/cache/task-monitor",
}

// ── Config Loading ──────────────────────────────────────────────────────────

const loadConfig = async (directory: string): Promise<Required<TaskMonitorConfig>> => {
  const configPath = join(directory, ".opencode", "task-monitor-config.json")
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG }

  try {
    const raw = await readFile(configPath, "utf8")
    const parsed = JSON.parse(raw) as TaskMonitorConfig
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

// ── Safe Toast Helper ───────────────────────────────────────────────────────

const showToast = async (
  client: any,
  title: string,
  message: string,
  variant: "success" | "error" | "info" | "warning" = "info",
  duration: number = 5000,
): Promise<void> => {
  try {
    await client.tui.showToast({
      body: { title, message, variant, duration },
    })
  } catch {
    // Toast is informational — never block execution on display failure.
  }
}

// ── Task Parsing ────────────────────────────────────────────────────────────

const parseTasks = (output: string): ParsedTask[] => {
  const tasks: ParsedTask[] = []

  for (const line of output.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("---")) continue
    if (trimmed.startsWith("Ready:")) continue
    if (trimmed.startsWith("Status:")) continue
    if (trimmed.includes("no active blockers")) continue

    // Try agent-style format first: [indicator] [id] [status] P[priority] [title]
    // ○ hyper-5ct ● P1 [epic] Project: Rename repository to xpowers
    const agentMatch = trimmed.match(
      /^[○◐●✓❄]\s+([a-z]+-[a-z0-9]+)\s+.*?P(\d+)\s+(.+)/,
    )
    if (agentMatch) {
      tasks.push({
        id: agentMatch[1],
        priority: parseInt(agentMatch[2], 10),
        title: agentMatch[3].trim(),
      })
      continue
    }

    // Fallback: simple format without priority — [indicator] [ID] [title]
    // ○ ENG_CORE-123 Some Task
    // ○ ENG-456 In Progress Task
    const simpleMatch = trimmed.match(
      /^[○◐●✓❄]\s+([A-Z_]+-\d+)\s+(.+)/,
    )
    if (simpleMatch) {
      tasks.push({
        id: simpleMatch[1],
        priority: 2, // default medium priority when not specified
        title: simpleMatch[2].trim(),
      })
    }
  }

  return tasks
}

// ── Seen Tasks Cache ────────────────────────────────────────────────────────

const loadSeenTasks = async (cachePath: string): Promise<Map<string, SeenTask>> => {
  if (!existsSync(cachePath)) return new Map()
  try {
    const raw = await readFile(cachePath, "utf8")
    const parsed = JSON.parse(raw)
    const entries = Array.isArray(parsed) ? parsed : []
    return new Map(entries.map((e: SeenTask) => [e.id, e]))
  } catch {
    return new Map()
  }
}

const saveSeenTasks = async (cachePath: string, tasks: Map<string, SeenTask>) => {
  try {
    await mkdir(dirname(cachePath), { recursive: true })
    const entries = Array.from(tasks.values())
    await writeFile(cachePath, JSON.stringify(entries, null, 2), "utf8")
  } catch {
    // Cache is best-effort.
  }
}

const cleanupOldTasks = (tasks: Map<string, SeenTask>, ttlMs: number): Map<string, SeenTask> => {
  const now = Date.now()
  const cleaned = new Map<string, SeenTask>()
  for (const [id, task] of tasks) {
    if (now - task.firstSeenAt < ttlMs) {
      cleaned.set(id, task)
    }
  }
  return cleaned
}

// ── Task Fetching ───────────────────────────────────────────────────────────

const fetchTasks = async ($: any): Promise<{ ok: true; tasks: ParsedTask[] } | { ok: false; error: string }> => {
  try {
    const result = await $`tm ready`.quiet().nothrow()
    if (result.exitCode !== 0) {
      return { ok: false, error: `tm ready exited with code ${result.exitCode}` }
    }
    const output = await result.text()
    const tasks = parseTasks(output)
    return { ok: true, tasks }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    return { ok: false, error: message }
  }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const xpowersTaskMonitorPlugin: Plugin = async (ctx) => {
  const config = await loadConfig(ctx.directory)

  if (!config.enabled) {
    return {}
  }

  const cachePath = join(ctx.directory, config.logDir, "seen-tasks.json")
  let seenTasks = await loadSeenTasks(cachePath)

  // Cleanup old entries on load
  seenTasks = cleanupOldTasks(seenTasks, config.seenTasksTtlMs)

  let lastTaskCount = 0
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let isPolling = false
  let isShuttingDown = false

  const notifyNewTasks = async (tasks: ParsedTask[]) => {
    // When trackSeenTasks is disabled, treat all tasks as new
    const newTasks = config.trackSeenTasks
      ? tasks.filter((t) => !seenTasks.has(t.id))
      : tasks

    if (newTasks.length === 0) return

    for (const task of newTasks.slice(0, config.maxTasksInToast)) {
      await showToast(
        ctx.client,
        "New Task Ready",
        `${task.id} · P${task.priority}\n${task.title.slice(0, 60)}${
          task.title.length > 60 ? "..." : ""
        }`,
        "info",
        5000,
      )
    }

    if (newTasks.length > config.maxTasksInToast) {
      await showToast(
        ctx.client,
        "New Tasks Ready",
        `+${newTasks.length - config.maxTasksInToast} more task(s) available`,
        "info",
        3000,
      )
    }

    // Record newly seen tasks (only when tracking is enabled)
    if (config.trackSeenTasks) {
      for (const task of newTasks) {
        seenTasks.set(task.id, { ...task, firstSeenAt: Date.now() })
      }
      await saveSeenTasks(cachePath, seenTasks)
    }
  }

  const notifyTaskCount = async (count: number, changed: boolean) => {
    if (!config.showTaskCount) return
    if (!changed && count === lastTaskCount) return

    lastTaskCount = count

    const variant = count > 0 ? "info" : "success"
    const emoji = count > 0 ? "🔴" : "🟢"

    await showToast(
      ctx.client,
      "Task Status",
      `${emoji} ${count} task(s) ready`,
      variant,
      3000,
    )
  }

  const doPoll = async () => {
    if (isPolling || isShuttingDown) return
    isPolling = true

    try {
      const result = await fetchTasks(ctx.$)
      if (!result.ok) return

      const relevantTasks = result.tasks.filter((t) => t.priority <= config.minPriority)
      const prevCount = lastTaskCount
      const changed = relevantTasks.length !== prevCount

      if (config.notifyOnNewTasks) {
        await notifyNewTasks(relevantTasks)
      }

      if (config.showTaskCount) {
        await notifyTaskCount(relevantTasks.length, changed)
      }
    } finally {
      isPolling = false
    }
  }

  const stopPolling = () => {
    isShuttingDown = true
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  // Start background polling
  if (config.pollIntervalMs >= 5000) {
    pollTimer = setInterval(doPoll, config.pollIntervalMs)
    // Initial poll after short delay to let OpenCode fully initialize
    setTimeout(doPoll, 3000)
  }

  return {
    // Show task count when session starts
    event: async ({ event }) => {
      const sessionId = (event as any).session_id ?? (event as any).sessionID

      if (event.type === "session.created" && config.notifyOnSessionStart) {
        const result = await fetchTasks(ctx.$)
        if (result.ok) {
          const tasks = result.tasks.filter((t) => t.priority <= config.minPriority)
          if (tasks.length > 0) {
            const summary = tasks
              .slice(0, config.maxTasksInToast)
              .map((t) => `• ${t.title.slice(0, 40)}`)
              .join("\n")
            await showToast(
              ctx.client,
              `${tasks.length} Task(s) Available`,
              summary,
              "info",
              6000,
            )
          }
        }
        return
      }

      // Show task summary when agent goes idle
      if (event.type === "session.idle" && config.notifyOnSessionIdle) {
        const result = await fetchTasks(ctx.$)
        if (!result.ok) return

        const tasks = result.tasks.filter((t) => t.priority <= config.minPriority)

        if (tasks.length > 0) {
          const summary = tasks
            .slice(0, config.maxTasksInToast)
            .map((t) => `• ${t.title.slice(0, 40)}${t.title.length > 40 ? "..." : ""}`)
            .join("\n")

          await showToast(
            ctx.client,
            `${tasks.length} Task(s) Available`,
            summary,
            "info",
            6000,
          )
        }
        return
      }

      // Note: pollTimer is per-plugin, not per-session.
      // In long-lived OpenCode processes, new sessions after deletion
      // should still receive task notifications, so we do NOT stop polling here.
      // The timer is only cleaned up when the plugin itself is destroyed.
    },

    // Custom tool: AI can query task status
    tool: {
      xpowers_task_status: tool({
        description:
          "Check the current XPowers task board status. Returns the number of ready tasks and a summary of the top-priority items.",
        args: {
          showAll: tool.schema.boolean().optional().describe("Show all ready tasks, not just top priority"),
        },
        async execute(args, toolCtx) {
          const result = await fetchTasks(ctx.$)
          if (!result.ok) {
            return `Error checking tasks: ${result.error}`
          }

          const allTasks = result.tasks
          const relevantTasks = allTasks.filter((t) => t.priority <= config.minPriority)

          const lines = [
            `Task Board Status`,
            `=================`,
            `Ready tasks: ${allTasks.length}`,
            `High-priority (≤P${config.minPriority}): ${relevantTasks.length}`,
            ``,
          ]

          const tasksToShow = args.showAll ? allTasks : relevantTasks

          if (tasksToShow.length > 0) {
            lines.push(`Top tasks:`)
            for (const task of tasksToShow.slice(0, 10)) {
              lines.push(`  • ${task.id} · P${task.priority} · ${task.title.slice(0, 60)}`)
            }
          } else {
            lines.push("No tasks ready at this priority level.")
          }

          return lines.join("\n")
        },
      }),
    },
  }
}

export default xpowersTaskMonitorPlugin
