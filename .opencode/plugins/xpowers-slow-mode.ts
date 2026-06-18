import type { Plugin } from "@opencode-ai/plugin"
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// XPowers Slow Mode Plugin
// Review gate for write and edit tool calls.
// Captures original content before edits, computes diffs after, and shows
// toast notifications with change summaries. All diffs are logged to a review
// file for later inspection.
//
// Inspired by pi-agent-extensions slow-mode:
// https://github.com/rytswd/pi-agent-extensions/tree/main/slow-mode
// ─────────────────────────────────────────────────────────────────────────────

type SlowModeConfig = {
  enabled?: boolean
  autoApproveThreshold?: number        // lines changed; 0 = always review
  maxDiffLinesInToast?: number         // max diff lines shown in toast
  logDir?: string                      // override log directory
  protectedPaths?: string[]            // glob patterns for protected files
  showDiffInToast?: boolean            // show actual diff lines vs just stats
  notifyOnSmallChanges?: boolean       // toast even for small changes
}

type FileChange = {
  filePath: string
  tool: "write" | "edit"
  originalContent: string | null        // null if file didn't exist
  newContent: string | null            // null if we couldn't read after
  timestamp: number
  linesAdded: number
  linesRemoved: number
}

const DEFAULT_CONFIG: Required<SlowModeConfig> = {
  enabled: true,
  autoApproveThreshold: 0,              // 0 = always show review toast
  maxDiffLinesInToast: 8,
  logDir: ".opencode/cache/slow-mode",
  protectedPaths: [
    ".env",
    ".env.*",
    "**/.git/hooks/*",
    "**/.beads/issues.jsonl",
    "id_rsa",
    "*.pem",
    "*.key",
  ],
  showDiffInToast: true,
  notifyOnSmallChanges: true,
}

// ── Config Loading ──────────────────────────────────────────────────────────

const loadConfig = async (directory: string): Promise<Required<SlowModeConfig>> => {
  const configPath = join(directory, ".opencode", "slow-mode-config.json")
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG }

  try {
    const raw = await readFile(configPath, "utf8")
    const parsed = JSON.parse(raw) as SlowModeConfig
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
  duration: number = 6000,
): Promise<void> => {
  try {
    await client.tui.showToast({
      body: { title, message, variant, duration },
    })
  } catch {
    // Toast is informational — never block execution on display failure.
  }
}

// ── Path Matching ───────────────────────────────────────────────────────────

const escapeRegex = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const matchGlob = (pattern: string, path: string): boolean => {
  const normalizedPath = path.replace(/\\/g, "/")
  const normalizedPattern = pattern.replace(/\\/g, "/")

  // Simple glob matching: ** (any depth), * (any chars within segment)
  // Escape regex special chars in the pattern first, then restore glob wildcards
  const regexPattern = escapeRegex(normalizedPattern)
    .replace(/\\\*\\\*/g, "\u0000")   // restore **
    .replace(/\\\*/g, "[^/]*")         // restore *
    .replace(/\u0000/g, ".*")           // ** = any depth
    .replace(/\\\?/g, ".")             // restore ?

  const regex = new RegExp(`^(.*/)?${regexPattern}$`, "i")
  return regex.test(normalizedPath)
}

const isProtectedPath = (filePath: string, patterns: string[]): boolean => {
  const basename = filePath.split(/[\\/]/).pop() ?? filePath
  for (const pattern of patterns) {
    if (matchGlob(pattern, filePath) || matchGlob(pattern, basename)) {
      return true
    }
  }
  return false
}

// ── Diff Computation ────────────────────────────────────────────────────────

/**
 * Compute LCS (Longest Common Subsequence) between two arrays.
 * Returns a Set of indices into `a` that are part of the LCS.
 */
const computeLcsIndices = (a: string[], b: string[]): Set<number> => {
  const m = a.length
  const n = b.length
  // Use two rows for space efficiency
  let prev = new Array(n + 1).fill(0)
  let curr = new Array(n + 1).fill(0)

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1])
      }
    }
    ;[prev, curr] = [curr, prev]
  }

  // Backtrack to find which indices of `a` are in the LCS
  const lcsIndices = new Set<number>()
  let i = m
  let j = n
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lcsIndices.add(i - 1)
      i--
      j--
    } else if (prev[j] > curr[j - 1]) {
      i--
    } else {
      j--
    }
  }
  return lcsIndices
}

const computeLineDiff = (original: string, updated: string): { added: number; removed: number; diffLines: string[] } => {
  const origLines = original.split("\n")
  const newLines = updated.split("\n")

  const lcsIndices = computeLcsIndices(origLines, newLines)

  let added = 0
  let removed = 0
  const diffLines: string[] = []

  // Lines in original but not in LCS = removed
  for (let i = 0; i < origLines.length; i++) {
    if (!lcsIndices.has(i) && origLines[i].trim().length > 0) {
      removed++
      if (diffLines.length < 20) {
        diffLines.push(`- ${origLines[i].slice(0, 80)}`)
      }
    }
  }

  // Build a set of LCS lines for quick lookup on the new side
  const lcsLines = new Set<string>()
  for (let i = 0; i < origLines.length; i++) {
    if (lcsIndices.has(i)) lcsLines.add(origLines[i])
  }

  // Lines in new but not in LCS = added
  // We use a separate pass to handle duplicates correctly
  const newLcsIndices = computeLcsIndices(newLines, origLines)
  for (let i = 0; i < newLines.length; i++) {
    if (!newLcsIndices.has(i) && newLines[i].trim().length > 0) {
      added++
      if (diffLines.length < 20) {
        diffLines.push(`+ ${newLines[i].slice(0, 80)}`)
      }
    }
  }

  // If no semantic diff found, report line count change
  if (added === 0 && removed === 0) {
    const countDiff = newLines.length - origLines.length
    if (countDiff > 0) added = countDiff
    if (countDiff < 0) removed = -countDiff
  }

  return { added, removed, diffLines }
}

// ── Review Logging ──────────────────────────────────────────────────────────

const ensureDir = async (filePath: string) => {
  await mkdir(dirname(filePath), { recursive: true })
}

const formatChangeLog = (change: FileChange): string => {
  const lines = [
    `---`,
    `file: ${change.filePath}`,
    `tool: ${change.tool}`,
    `timestamp: ${new Date(change.timestamp).toISOString()}`,
    `lines: +${change.linesAdded} / -${change.linesRemoved}`,
  ]

  if (change.originalContent === null) {
    lines.push("status: NEW FILE")
  }

  lines.push("---")
  return lines.join("\n") + "\n"
}

const logChange = async (logDir: string, sessionId: string, change: FileChange) => {
  try {
    const logPath = join(logDir, sessionId, "review.log")
    await ensureDir(logPath)
    await appendFile(logPath, formatChangeLog(change), "utf8")
  } catch {
    // Logging failures should never block the editing workflow.
  }
}

const logSessionSummary = async (
  logDir: string,
  sessionId: string,
  changes: FileChange[],
) => {
  if (changes.length === 0) return

  try {
    const logPath = join(logDir, sessionId, "review.log")
    await ensureDir(logPath)

    const totalAdded = changes.reduce((sum, c) => sum + c.linesAdded, 0)
    const totalRemoved = changes.reduce((sum, c) => sum + c.linesRemoved, 0)
    const files = [...new Set(changes.map((c) => c.filePath))]

    const summary = [
      `=== SESSION SUMMARY ===`,
      `files modified: ${files.length}`,
      `total changes: +${totalAdded} / -${totalRemoved}`,
      `files:`,
      ...files.map((f) => `  - ${f}`),
      `=======================\n`,
    ].join("\n")

    await appendFile(logPath, summary, "utf8")
  } catch {
    // Best-effort logging.
  }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const xpowersSlowModePlugin: Plugin = async (ctx) => {
  const config = await loadConfig(ctx.directory)

  if (!config.enabled) {
    return {}
  }

  // Per-session state tracking
  type SlowModeSession = {
    changes: FileChange[]
    pendingOriginals: Map<string, string | null>  // filePath -> original content
    createdAt: number
    summaryLogged: boolean  // prevent duplicate session summaries in review.log
  }

  const sessions = new Map<string, SlowModeSession>()

  const getSessionState = (sessionId: string): SlowModeSession => {
    let state = sessions.get(sessionId)
    if (!state) {
      state = { changes: [], pendingOriginals: new Map(), createdAt: Date.now(), summaryLogged: false }
      sessions.set(sessionId, state)
    }
    return state
  }

  const cleanupOldSessions = (ttlMs: number = 86400000) => {
    const cutoff = Date.now() - ttlMs
    for (const [id, s] of sessions) {
      if (s.createdAt < cutoff) {
        sessions.delete(id)
      }
    }
  }

  const logDir = join(ctx.directory, config.logDir)

  return {
    // ── Pre-edit: capture original content ─────────────────────────────────
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "write" && input.tool !== "edit") return

      const args = output.args ?? {}
      const filePath = String(args.filePath ?? args.file_path ?? "")
      if (!filePath) return

      // Check protected paths
      if (isProtectedPath(filePath, config.protectedPaths)) {
        throw new Error(
          `XPowers slow-mode: "${filePath}" is a protected path. ` +
            `Edit blocked. Remove from protectedPaths in slow-mode-config.json to allow.`,
        )
      }

      // Capture original content before the edit
      const sessionId = (input as any).sessionID ?? "unknown"
      const state = getSessionState(sessionId)

      try {
        const original = await readFile(filePath, "utf8")
        state.pendingOriginals.set(filePath, original)
      } catch {
        // File doesn't exist yet — store null to indicate new file
        state.pendingOriginals.set(filePath, null)
      }
    },

    // ── Post-edit: compute diff, show toast, log ───────────────────────────
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "write" && input.tool !== "edit") return

      const args = output.args ?? {}
      const filePath = String(args.filePath ?? args.file_path ?? "")
      if (!filePath) return

      const sessionId = (input as any).sessionID ?? "unknown"
      const state = getSessionState(sessionId)
      const originalContent = state.pendingOriginals.get(filePath)
      state.pendingOriginals.delete(filePath)

      // Read the updated file
      let newContent: string | null = null
      try {
        newContent = await readFile(filePath, "utf8")
      } catch {
        // Couldn't read after edit — might have been deleted or moved
      }

      // Skip if we couldn't capture before or after
      if (originalContent === undefined) return

      // Compute diff
      const { added, removed, diffLines } =
        originalContent === null && newContent !== null
          ? { added: newContent.split("\n").length, removed: 0, diffLines: [] }
          : originalContent !== null && newContent !== null
            ? computeLineDiff(originalContent, newContent)
            : { added: 0, removed: 0, diffLines: [] }

      const totalChanged = added + removed
      const isNewFile = originalContent === null

      // Record the change
      const change: FileChange = {
        filePath,
        tool: input.tool as "write" | "edit",
        originalContent,
        newContent,
        timestamp: Date.now(),
        linesAdded: added,
        linesRemoved: removed,
      }
      state.changes.push(change)

      // Determine if we should show notification
      const isSmallChange = config.autoApproveThreshold > 0 && totalChanged <= config.autoApproveThreshold
      if (isSmallChange && !config.notifyOnSmallChanges) {
        // Silently log small changes without toast
        await logChange(logDir, sessionId, change)
        return
      }

      // Build toast message
      const fileName = filePath.split(/[\\/]/).pop() ?? filePath
      const changeSummary = isNewFile
        ? `New file (${added} lines)`
        : `+${added} / -${removed} lines`

      let toastMessage = `${fileName}\n${changeSummary}`

      if (config.showDiffInToast && diffLines.length > 0) {
        const previewLines = diffLines.slice(0, config.maxDiffLinesInToast)
        toastMessage += "\n" + previewLines.join("\n")
        if (diffLines.length > config.maxDiffLinesInToast) {
          toastMessage += "\n..."
        }
      }

      const variant: "success" | "warning" | "error" =
        totalChanged > 50 ? "warning" : "success"

      await showToast(
        ctx.client,
        isNewFile ? "New File" : `Edit Review`,
        toastMessage,
        variant,
        totalChanged > 20 ? 8000 : 5000,
      )

      // Log to review file
      await logChange(logDir, sessionId, change)
    },

    // ── Session lifecycle: cleanup and summary ─────────────────────────────
    event: async ({ event }) => {
      const sessionId = (event as any).session_id ?? (event as any).sessionID ?? "unknown"

      if (event.type === "session.created" && sessionId) {
        // Initialize session state
        getSessionState(sessionId)
        return
      }

      if (event.type === "session.deleted" && sessionId) {
        const state = sessions.get(sessionId)
        if (state && !state.summaryLogged) {
          await logSessionSummary(logDir, sessionId, state.changes)
          state.summaryLogged = true
        }
        if (state) {
          sessions.delete(sessionId)
        }
        // Cleanup orphaned sessions older than 24 hours
        cleanupOldSessions()
        return
      }

      if (event.type === "session.idle") {
        const state = sessions.get(sessionId)
        if (state && state.changes.length > 0 && !state.summaryLogged) {
          const files = [...new Set(state.changes.map((c) => c.filePath))]
          const totalAdded = state.changes.reduce((sum, c) => sum + c.linesAdded, 0)
          const totalRemoved = state.changes.reduce((sum, c) => sum + c.linesRemoved, 0)

          await showToast(
            ctx.client,
            "Session Changes",
            `${files.length} file(s) modified\n+${totalAdded} / -${totalRemoved} lines`,
            "info",
            6000,
          )

          // Write summary to log (only once per session)
          await logSessionSummary(logDir, sessionId, state.changes)
          state.summaryLogged = true
        }
      }
    },

    // ── Stop hook: warn about unreviewed changes ───────────────────────────
    stop: async (input) => {
      const sessionId = (input as any).sessionID ?? (input as any).session_id ?? "unknown"
      const state = sessions.get(sessionId)

      if (!state || state.changes.length === 0) return

      const files = [...new Set(state.changes.map((c) => c.filePath))]
      const totalAdded = state.changes.reduce((sum, c) => sum + c.linesAdded, 0)
      const totalRemoved = state.changes.reduce((sum, c) => sum + c.linesRemoved, 0)

      // Inject a reminder into the session
      try {
        await ctx.client.session.prompt({
          path: { id: sessionId },
          body: {
            noReply: true,
            parts: [
              {
                type: "text",
                text: [
                  `## Slow Mode Review Reminder`,
                  ``,
                  `You have modified ${files.length} file(s) this session:`,
                  ...files.map((f) => `- ${f}`),
                  ``,
                  `Total changes: +${totalAdded} / -${totalRemoved} lines`,
                  ``,
                  `Review log: ${join(logDir, sessionId, "review.log")}`,
                  ``,
                  `Consider reviewing changes before committing.`,
                ].join("\n"),
              },
            ],
          },
        })
      } catch {
        // Best-effort reminder injection.
      }

      await showToast(
        ctx.client,
        "Unreviewed Changes",
        `${files.length} file(s) modified this session\nReview log: ${join(logDir, sessionId, "review.log")}`,
        "warning",
        8000,
      )
    },
  }
}

export default xpowersSlowModePlugin
