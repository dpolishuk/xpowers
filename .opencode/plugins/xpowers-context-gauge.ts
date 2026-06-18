import type { Plugin } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// XPowers Context Gauge Plugin
// Monitors estimated context window usage and warns at configurable thresholds.
// Hooks into message updates to accumulate content size, estimates tokens,
// and shows toast notifications when approaching model limits.
//
// Inspired by pi-agent-extensions statusline context tracking.
// ─────────────────────────────────────────────────────────────────────────────

type ContextGaugeConfig = {
  enabled?: boolean
  warnThreshold?: number           // percentage (0-1), default 0.70
  dangerThreshold?: number         // percentage (0-1), default 0.90
  showTokensInToast?: boolean
  suggestCompactAt?: number        // percentage at which to suggest /compact
  modelLimits?: Record<string, number>  // model name -> context limit in tokens
  defaultLimit?: number            // fallback context limit in tokens
  logDir?: string
}

// Known model context limits (in tokens)
const DEFAULT_MODEL_LIMITS: Record<string, number> = {
  // OpenAI
  "gpt-4": 8192,
  "gpt-4-turbo": 128000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4.1": 1000000,
  "gpt-4.1-mini": 1000000,
  "gpt-4.1-nano": 1000000,
  "gpt-4.5": 128000,
  "gpt-5": 128000,
  "gpt-5.4": 128000,
  "o1": 128000,
  "o1-mini": 128000,
  "o3": 128000,
  "o3-mini": 128000,
  "o4-mini": 128000,
  // Anthropic
  "claude-3-haiku": 200000,
  "claude-3-sonnet": 200000,
  "claude-3-opus": 200000,
  "claude-3-5-sonnet": 200000,
  "claude-3-5-haiku": 200000,
  "claude-3-7-sonnet": 200000,
  "claude-4-sonnet": 200000,
  "claude-4-opus": 200000,
  // Google
  "gemini-2.0-flash": 1000000,
  "gemini-2.0-flash-lite": 1000000,
  "gemini-2.5": 1000000,
  "gemini-2.5-flash": 1000000,
  // Groq
  "llama-3.3-70b": 128000,
  "llama-4-scout": 128000,
  "llama-4-maverick": 128000,
  // Generic fallbacks
  "default": 128000,
}

const DEFAULT_CONFIG: Required<ContextGaugeConfig> = {
  enabled: true,
  warnThreshold: 0.70,
  dangerThreshold: 0.90,
  showTokensInToast: true,
  suggestCompactAt: 0.90,
  modelLimits: DEFAULT_MODEL_LIMITS,
  defaultLimit: 128000,
  logDir: ".opencode/cache/context-gauge",
}

// ── Config Loading ──────────────────────────────────────────────────────────

const loadConfig = async (directory: string): Promise<Required<ContextGaugeConfig>> => {
  const configPath = join(directory, ".opencode", "context-gauge-config.json")
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG }

  try {
    const raw = await readFile(configPath, "utf8")
    const parsed = JSON.parse(raw) as ContextGaugeConfig
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      modelLimits: {
        ...DEFAULT_MODEL_LIMITS,
        ...(parsed.modelLimits ?? {}),
      },
    }
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

// ── Token Estimation ────────────────────────────────────────────────────────

/**
 * Rough token estimation:
 * - English text: ~4 characters per token
 * - Code: ~3.5 characters per token (more symbols)
 * - Unicode: varies widely
 *
 * We use a conservative 3.5 chars/token for mixed content.
 */
const estimateTokens = (text: string): number => {
  if (!text) return 0
  // Count characters, adjust for code-heavy content
  const charCount = text.length
  // Heuristic: code has more tokens per char due to symbols/brackets
  const isCode = /[{}[\];=+&|!?\/<>~`@#$%^]/.test(text)
  const ratio = isCode ? 3.2 : 4.0
  return Math.ceil(charCount / ratio)
}

const formatNumber = (n: number): string => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`
  return String(n)
}

// ── Model Limit Resolution ──────────────────────────────────────────────────

const resolveModelLimit = (
  modelId: string | undefined,
  limits: Record<string, number>,
  defaultLimit: number,
): number => {
  if (!modelId) return defaultLimit

  // Strip provider prefix (e.g., "openai/gpt-4o" → "gpt-4o")
  const withoutProvider = modelId.includes("/")
    ? modelId.split("/").pop() ?? modelId
    : modelId

  const normalized = withoutProvider.toLowerCase().replace(/[^a-z0-9.-]/g, "")

  // Try exact match first
  if (limits[withoutProvider]) return limits[withoutProvider]
  if (limits[modelId]) return limits[modelId]

  // Try normalized exact match
  if (limits[normalized]) return limits[normalized]

  // Try partial match: prefer longest/specific match first to avoid
  // "gpt-4" matching before "gpt-4o" or "gpt-4.1"
  const candidates: { key: string; limit: number; len: number }[] = []
  for (const [key, limit] of Object.entries(limits)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9.-]/g, "")
    if (!normalizedKey || normalizedKey === "default") continue

    // Key must be a prefix of the model ID, followed by a separator or end
    if (
      normalized === normalizedKey ||
      normalized.startsWith(normalizedKey + "-") ||
      normalized.startsWith(normalizedKey + ".")
    ) {
      candidates.push({ key, limit, len: normalizedKey.length })
    }
  }

  // Prefer longest match (most specific)
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.len - a.len)
    return candidates[0].limit
  }

  return defaultLimit
}

// ── Session State ───────────────────────────────────────────────────────────

type GaugeState = {
  estimatedTokens: number
  messageCount: number
  lastWarnLevel: "none" | "warn" | "danger"
  modelId: string | null
  contextLimit: number
  compactSuggested: boolean
  createdAt: number
  messageContents: Map<string, string>  // messageId -> previous content for delta counting
}

const sessions = new Map<string, GaugeState>()

const getState = (sessionId: string): GaugeState => {
  let state = sessions.get(sessionId)
  if (!state) {
    state = {
      estimatedTokens: 0,
      messageCount: 0,
      lastWarnLevel: "none",
      modelId: null,
      contextLimit: DEFAULT_CONFIG.defaultLimit,
      compactSuggested: false,
      createdAt: Date.now(),
      messageContents: new Map(),
    }
    sessions.set(sessionId, state)
  }
  return state
}

const cleanupOldGaugeSessions = (ttlMs: number = 86400000) => {
  const cutoff = Date.now() - ttlMs
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) {
      sessions.delete(id)
    }
  }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const xpowersContextGaugePlugin: Plugin = async (ctx) => {
  const config = await loadConfig(ctx.directory)

  if (!config.enabled) {
    return {}
  }

  return {
    // ── Monitor message additions to estimate context growth ──────────────
    event: async ({ event }) => {
      const sessionId =
        (event as any).session_id ?? (event as any).sessionID ?? "unknown"
      const state = getState(sessionId)

      if (event.type === "session.created" && sessionId) {
        // Reset state for new session
        sessions.set(sessionId, {
          estimatedTokens: 0,
          messageCount: 0,
          lastWarnLevel: "none",
          modelId: null,
          contextLimit: config.defaultLimit,
          compactSuggested: false,
          createdAt: Date.now(),
          messageContents: new Map(),
        })
        return
      }

      if (event.type === "session.compacted" && sessionId) {
        // Reset counter after compaction
        state.estimatedTokens = Math.floor(state.estimatedTokens * 0.3) // rough: summary keeps ~30%
        state.messageCount = Math.min(state.messageCount, 4) // summary + system + few messages
        state.lastWarnLevel = "none"
        state.compactSuggested = false

        await showToast(
          ctx.client,
          "Context Compacted",
          `Estimated context reduced to ~${formatNumber(state.estimatedTokens)} tokens`,
          "success",
          4000,
        )
        return
      }

      if (event.type === "session.deleted" && sessionId) {
        sessions.delete(sessionId)
        // Cleanup orphaned sessions older than 24 hours
        cleanupOldGaugeSessions()
        return
      }

      if (event.type === "message.updated") {
        const message = (event as any).properties?.message
        if (!message) return

        // Try to extract content from message
        let content = ""
        if (message.content) {
          if (typeof message.content === "string") {
            content = message.content
          } else if (Array.isArray(message.content)) {
            content = message.content
              .map((part: any) => {
                if (typeof part === "string") return part
                if (part?.text) return part.text
                if (part?.code) return part.code
                return ""
              })
              .join(" ")
          }
        }

        // Also check parts
        const parts = (event as any).properties?.parts ?? []
        if (parts.length > 0 && !content) {
          content = parts
            .map((part: any) => {
              if (part.type === "text") return part.text ?? ""
              if (part.type === "code") return part.code ?? ""
              return ""
            })
            .join(" ")
        }

        // Incremental token counting: only count the delta on streaming updates
        const messageId = message.id ?? (event as any).properties?.messageId ?? ""
        const prevContent = messageId ? state.messageContents.get(String(messageId)) : undefined
        const prevTokens = prevContent !== undefined ? estimateTokens(prevContent) : 0
        const newTokens = estimateTokens(content)
        const deltaTokens = Math.max(0, newTokens - prevTokens)

        state.estimatedTokens += deltaTokens
        if (prevContent === undefined) {
          state.messageCount += 1 // only count new messages, not streaming updates
        }
        if (messageId) {
          state.messageContents.set(String(messageId), content)
        }

        // Try to detect model from message metadata
        const detectedModel =
          message.model ??
          (event as any).properties?.model ??
          (event as any).properties?.provider

        if (detectedModel && detectedModel !== state.modelId) {
          state.modelId = detectedModel
          state.contextLimit = resolveModelLimit(
            detectedModel,
            config.modelLimits,
            config.defaultLimit,
          )
        }

        // Calculate usage percentage
        const usage = state.estimatedTokens / state.contextLimit
        const usagePercent = Math.round(usage * 100)

        // Check thresholds
        const prevLevel = state.lastWarnLevel
        let newLevel: "none" | "warn" | "danger" = "none"

        if (usage >= config.dangerThreshold) {
          newLevel = "danger"
        } else if (usage >= config.warnThreshold) {
          newLevel = "warn"
        }

        // Only notify on level change or first time crossing threshold
        if (newLevel !== prevLevel) {
          state.lastWarnLevel = newLevel

          const tokenInfo = config.showTokensInToast
            ? `\n${formatNumber(state.estimatedTokens)} / ${formatNumber(state.contextLimit)} tokens`
            : ""

          if (newLevel === "danger") {
            const suggestion = state.compactSuggested
              ? ""
              : "\n\nRun /compact to reduce context."

            await showToast(
              ctx.client,
              "🚨 Context Critical",
              `${usagePercent}% context used${tokenInfo}${suggestion}`,
              "error",
              8000,
            )

            if (!state.compactSuggested && usage >= config.suggestCompactAt) {
              state.compactSuggested = true

              // Inject suggestion into session
              try {
                await ctx.client.session.prompt({
                  path: { id: sessionId },
                  body: {
                    noReply: true,
                    parts: [
                      {
                        type: "text",
                        text: `Context window is at ${usagePercent}% capacity. Consider running /compact to summarize older messages and free up space.`,
                      },
                    ],
                  },
                })
              } catch {
                // Best-effort injection.
              }
            }
          } else if (newLevel === "warn") {
            await showToast(
              ctx.client,
              "⚠️ Context Warning",
              `${usagePercent}% context used${tokenInfo}`,
              "warning",
              6000,
            )
          }
        }

        return
      }

      // ── Show context gauge on session idle ───────────────────────────────
      if (event.type === "session.idle") {
        const usage = state.estimatedTokens / state.contextLimit
        const usagePercent = Math.round(usage * 100)

        if (usage >= config.warnThreshold) {
          const variant = usage >= config.dangerThreshold ? "error" : "warning"
          const tokenInfo = config.showTokensInToast
            ? `\n${formatNumber(state.estimatedTokens)} / ${formatNumber(state.contextLimit)}`
            : ""

          await showToast(
            ctx.client,
            `Context: ${usagePercent}%`,
            `${state.messageCount} messages${tokenInfo}`,
            variant,
            4000,
          )
        }
      }
    },

    // ── Monitor bash commands for model switches ───────────────────────────
    "tool.execute.after": async (input, output) => {
      // Detect if a bash command changed the model
      if (input.tool === "bash") {
        const command = String((output.args as any)?.command ?? "")

        // Check for model switching commands
        const modelMatch = command.match(
          /(?:model|provider)\s*[:=]\s*["']?([^"'\s]+)/,
        )
        if (modelMatch) {
          const sessionId = (input as any).sessionID ?? "unknown"
          const state = getState(sessionId)
          const detectedModel = modelMatch[1]

          state.modelId = detectedModel
          state.contextLimit = resolveModelLimit(
            detectedModel,
            config.modelLimits,
            config.defaultLimit,
          )
        }
      }
    },
  }
}

export default xpowersContextGaugePlugin
