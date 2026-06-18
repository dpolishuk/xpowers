import type { Plugin } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// XPowers Notify Plugin
// Sends desktop notifications when AI agents finish responding or tasks complete.
// Supports: OSC 777 (Ghostty/iTerm2/WezTerm), OSC 99 (Kitty), osascript (macOS),
//           notify-send (Linux), and growlnotify (legacy macOS).
// ─────────────────────────────────────────────────────────────────────────────

type NotifyVariant = "success" | "error" | "info" | "warning"

type NotifyConfig = {
  enabled?: boolean
  onAgentIdle?: boolean
  onTaskComplete?: boolean
  onTaskError?: boolean
  onSessionCompact?: boolean
  backends?: Backend[]
  durationMs?: number
  titlePrefix?: string
}

const BACKENDS = [
  "osc777",
  "osc99",
  "osascript",
  "notify-send",
  "growlnotify",
] as const
type Backend = (typeof BACKENDS)[number]

const DEFAULT_CONFIG: Required<NotifyConfig> = {
  enabled: true,
  onAgentIdle: true,
  onTaskComplete: true,
  onTaskError: true,
  onSessionCompact: false,
  // Prefer native OS notifications; OSC terminals are fallbacks
  backends: ["osascript", "notify-send", "growlnotify", "osc777", "osc99"],
  durationMs: 4000,
  titlePrefix: "XPowers",
}

// ── Config Loading ──────────────────────────────────────────────────────────

const loadConfig = async (directory: string): Promise<Required<NotifyConfig>> => {
  const configPath = join(directory, ".opencode", "notify-config.json")
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG }

  try {
    const raw = await readFile(configPath, "utf8")
    const parsed = JSON.parse(raw) as NotifyConfig
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

// ── Backend Detection ───────────────────────────────────────────────────────

const detectBackend = async ($: any, preferred: Backend[]): Promise<Backend | null> => {
  for (const backend of preferred) {
    const available = await checkBackend($, backend)
    if (available) return backend
  }
  return null
}

const checkBackend = async ($: any, backend: Backend): Promise<boolean> => {
  try {
    switch (backend) {
      case "osc777":
      case "osc99":
        // OSC sequences work in most modern terminals; always try them
        return true
      case "osascript": {
        const r = await $`which osascript`.quiet().nothrow()
        return r.exitCode === 0
      }
      case "notify-send": {
        const r = await $`which notify-send`.quiet().nothrow()
        return r.exitCode === 0
      }
      case "growlnotify": {
        const r = await $`which growlnotify`.quiet().nothrow()
        return r.exitCode === 0
      }
    }
  } catch {
    return false
  }
  return false
}

// ── Notification Sending ────────────────────────────────────────────────────

/**
 * Escape OSC sequence content to prevent terminal injection.
 * OSC 777/99 payloads must not contain BEL (\x07) or ESC (\x1b).
 */
const escapeOsc = (text: string): string =>
  text.replace(/\x1b/g, "").replace(/\x07/g, "")

const sendDesktopNotification = async (
  $: any,
  backend: Backend,
  title: string,
  message: string,
): Promise<boolean> => {
  try {
    switch (backend) {
      case "osascript": {
        // Use Bun shell template literal which safely escapes arguments
        const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`
        await $`osascript -e ${script}`.quiet().nothrow()
        return true
      }

      case "notify-send": {
        // Bun template literal safely passes arguments to subprocess
        await $`notify-send ${title} ${message}`.quiet().nothrow()
        return true
      }

      case "growlnotify": {
        await $`growlnotify -t ${title} -m ${message}`.quiet().nothrow()
        return true
      }

      case "osc777": {
        // OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
        // Format: ESC ] 777 ; notify ; title ; body BEL
        const safeTitle = escapeOsc(title)
        const safeMessage = escapeOsc(message)
        const osc = `\x1b]777;notify;${safeTitle};${safeMessage}\x07`
        process.stdout.write(osc)
        return true
      }

      case "osc99": {
        // OSC 99: Kitty
        // Format: ESC ] 99 ; i=1:d=0 ; body ESC \
        const safeMessage = escapeOsc(message)
        const osc = `\x1b]99;i=1:d=0;${safeMessage}\x1b\\`
        process.stdout.write(osc)
        return true
      }
    }
  } catch {
    return false
  }
  return false
}

// ── Safe Toast Helper ───────────────────────────────────────────────────────

const showToast = async (
  client: any,
  title: string,
  message: string,
  variant: NotifyVariant = "info",
  duration: number = 4000,
): Promise<void> => {
  try {
    await client.tui.showToast({
      body: { title, message, variant, duration },
    })
  } catch {
    // Toast is informational — never block execution on display failure.
  }
}

// ── Message Formatting ──────────────────────────────────────────────────────

const formatAgentName = (args: Record<string, unknown>): string => {
  const raw =
    args.agent ??
    args.subagent ??
    args.subagent_type ??
    args.subagentType ??
    "agent"
  return String(raw).trim() || "agent"
}

const formatModelInfo = (args: Record<string, unknown>): string => {
  const model = args.model
  if (typeof model === "string" && model.includes("/")) {
    const parts = model.split("/")
    return parts[parts.length - 1] ?? model
  }
  return ""
}

const formatTaskStatus = (status: string): { text: string; variant: NotifyVariant } => {
  const s = String(status).toLowerCase()
  if (s === "ok" || s === "success" || s === "completed") {
    return { text: "completed", variant: "success" }
  }
  if (s === "error" || s === "failed" || s === "failure") {
    return { text: "failed", variant: "error" }
  }
  if (s === "timeout" || s === "cancelled" || s === "aborted") {
    return { text: s, variant: "warning" }
  }
  return { text: s || "finished", variant: "info" }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const xpowersNotifyPlugin: Plugin = async (ctx) => {
  const config = await loadConfig(ctx.directory)

  if (!config.enabled) {
    return {}
  }

  // Detect best notification backend on first use (lazy)
  let cachedBackend: Backend | null = null
  const getBackend = async (): Promise<Backend | null> => {
    if (cachedBackend === null) {
      cachedBackend = await detectBackend(ctx.$, config.backends)
    }
    return cachedBackend
  }

  const notify = async (title: string, message: string, variant: NotifyVariant) => {
    const backend = await getBackend()
    if (backend) {
      const ok = await sendDesktopNotification(ctx.$, backend, title, message)
      // If OSC backend failed, invalidate cache so fallback is tried next time
      if (!ok && (backend === "osc777" || backend === "osc99")) {
        cachedBackend = null
      }
    }
    await showToast(ctx.client, title, message, variant, config.durationMs)
  }

  return {
    // When the AI agent finishes responding and goes idle
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        if (!config.onAgentIdle) return
        const title = `${config.titlePrefix}`
        const message = "Agent finished responding"
        await notify(title, message, "info")
        return
      }

      if (event.type === "session.compacted" && config.onSessionCompact) {
        const title = `${config.titlePrefix}`
        const message = "Session compacted"
        await notify(title, message, "info")
      }
    },

    // When tools complete: task (subagent) or bash (build/test)
    "tool.execute.after": async (input, output) => {
      // Task tool (subagent dispatch)
      if (input.tool === "task") {
        const args = (output.args ?? {}) as Record<string, unknown>
        const agentName = formatAgentName(args)
        const modelInfo = formatModelInfo(args)

        const resultPayload = (output as any)?.result
        const rawStatus =
          typeof resultPayload?.status === "string"
            ? resultPayload.status
            : "finished"

        const { text: statusText, variant } = formatTaskStatus(rawStatus)

        const modelSuffix = modelInfo ? ` (${modelInfo})` : ""
        const title = `${config.titlePrefix} · ${agentName}${modelSuffix}`
        const message = `Task ${statusText}`

        // Error notifications: honor onTaskError config
        if (variant === "error") {
          if (config.onTaskError) {
            await notify(title, message, variant)
          }
          return
        }

        // Non-error completions: honor onTaskComplete config
        if (config.onTaskComplete) {
          await notify(title, message, variant)
        }
        return
      }

      // Bash tool (long-running build/test commands)
      if (input.tool === "bash" && config.onTaskComplete) {
        const command = String((output.args as any)?.command ?? "")
        const isLongRunning =
          /\b(npm test|yarn test|pnpm test|bun test|pytest|jest|vitest|cargo test|go test|make|build|lint)\b/.test(
            command,
          )

        if (!isLongRunning) return

        const title = `${config.titlePrefix} · Build/Test`
        const message = `Completed: ${command.slice(0, 60)}${command.length > 60 ? "..." : ""}`
        await notify(title, message, "success")
      }
    },
  }
}

export default xpowersNotifyPlugin
