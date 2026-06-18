import type { Plugin } from "@opencode-ai/plugin"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// XPowers Git Guard Plugin
// Tracks file modifications and git commits during a session.
// Warns on session idle if uncommitted changes exist.
// Injects reminder on stop if files were modified but not committed.
// Optionally auto-commits on session end.
//
// Inspired by pi-agent-extensions commit reminder patterns.
// ─────────────────────────────────────────────────────────────────────────────

type GitGuardConfig = {
  enabled?: boolean
  blockStopIfUncommitted?: boolean
  autoCommitOnSessionEnd?: boolean
  autoCommitMessage?: string
  showDiffOnWarning?: boolean
  maxFilesInToast?: number
  protectedPaths?: string[]
  logDir?: string
  warnOnIdle?: boolean
  warnOnStop?: boolean
}

type GitStatus = {
  hasChanges: boolean
  modifiedFiles: string[]
  stagedFiles: string[]
  untrackedFiles: string[]
  deletedFiles: string[]
  ahead?: number
  behind?: number
}

type SessionState = {
  filesModified: Set<string>
  filesCommitted: Set<string>
  commitMade: boolean
  warnedOnIdle: boolean
  createdAt: number
  pendingCommitStagedFiles: string[]  // staged files captured before git commit
}

const DEFAULT_CONFIG: Required<GitGuardConfig> = {
  enabled: true,
  blockStopIfUncommitted: false,
  autoCommitOnSessionEnd: false,
  autoCommitMessage: "wip: session changes",
  showDiffOnWarning: true,
  maxFilesInToast: 5,
  protectedPaths: [
    ".env",
    ".env.*",
    "**/.git/hooks/*",
    "id_rsa",
    "*.pem",
    "*.key",
  ],
  logDir: ".opencode/cache/git-guard",
  warnOnIdle: true,
  warnOnStop: true,
}

// ── Config Loading ──────────────────────────────────────────────────────────

const loadConfig = async (directory: string): Promise<Required<GitGuardConfig>> => {
  const configPath = join(directory, ".opencode", "git-guard-config.json")
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG }

  try {
    const raw = await readFile(configPath, "utf8")
    const parsed = JSON.parse(raw) as GitGuardConfig
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

// ── Git Operations ──────────────────────────────────────────────────────────

const getGitStatus = async ($: any, cwd: string): Promise<GitStatus> => {
  const result = await $`git -C ${cwd} status --porcelain -b`.quiet().nothrow()
  if (result.exitCode !== 0) {
    return { hasChanges: false, modifiedFiles: [], stagedFiles: [], untrackedFiles: [], deletedFiles: [] }
  }

  const output = await result.text()
  const lines = output.split("\n").filter((l) => l.trim())

  const status: GitStatus = {
    hasChanges: false,
    modifiedFiles: [],
    stagedFiles: [],
    untrackedFiles: [],
    deletedFiles: [],
  }

  for (const line of lines) {
    // Branch info line: ## main...origin/main [ahead 1, behind 2]
    if (line.startsWith("## ")) {
      const aheadMatch = line.match(/ahead\s+(\d+)/)
      const behindMatch = line.match(/behind\s+(\d+)/)
      if (aheadMatch) status.ahead = parseInt(aheadMatch[1], 10)
      if (behindMatch) status.behind = parseInt(behindMatch[1], 10)
      continue
    }

    // Status line: XY filename or XY "filename with spaces"
    // Renames: XY "old" -> "new"  (R status in index or worktree)
    const statusCode = line.slice(0, 2)
    let filePath = line.slice(3)

    // Handle rename entries: R  "old/path" -> "new/path"
    if (statusCode[0] === "R" || statusCode[1] === "R") {
      const renameMatch = line.match(/^\S{2}\s+(.+?)\s+->\s+(.+)$/)
      if (renameMatch) {
        filePath = renameMatch[2].replace(/^"(.*)"$/, "$1")
      }
    } else {
      filePath = filePath.replace(/^"(.*)"$/, "$1")
    }

    if (!filePath) continue

    status.hasChanges = true

    // X = index status, Y = working tree status
    const indexStatus = statusCode[0]
    const worktreeStatus = statusCode[1]

    if (indexStatus !== " " && indexStatus !== "?") {
      status.stagedFiles.push(filePath)
    }

    if (worktreeStatus === "M" || indexStatus === "M") {
      status.modifiedFiles.push(filePath)
    }
    if (worktreeStatus === "D" || indexStatus === "D") {
      status.deletedFiles.push(filePath)
    }
    if (worktreeStatus === "?") {
      status.untrackedFiles.push(filePath)
    }
    // Renames count as modified
    if (indexStatus === "R" || worktreeStatus === "R") {
      if (!status.modifiedFiles.includes(filePath)) {
        status.modifiedFiles.push(filePath)
      }
    }
  }

  return status
}

const getGitDiffStat = async ($: any, cwd: string): Promise<{ files: number; insertions: number; deletions: number } | null> => {
  const result = await $`git -C ${cwd} diff --stat`.quiet().nothrow()
  if (result.exitCode !== 0) return null

  const output = await result.text()
  const lastLine = output.split("\n").filter((l) => l.trim()).pop() ?? ""

  // Parse: " 5 files changed, 23 insertions(+), 10 deletions(-)"
  // Note: insertions or deletions may be absent in partial output
  const filesMatch = lastLine.match(/(\d+)\s+files?\s+changed/)
  if (filesMatch) {
    const insertionsMatch = lastLine.match(/(\d+)\s+insertions?/)
    const deletionsMatch = lastLine.match(/(\d+)\s+deletions?/)
    return {
      files: parseInt(filesMatch[1], 10),
      insertions: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
      deletions: deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0,
    }
  }

  return null
}

const hasUncommittedChanges = async ($: any, cwd: string): Promise<boolean> => {
  const status = await getGitStatus($, cwd)
  return status.hasChanges
}

const autoCommit = async (
  $: any,
  cwd: string,
  message: string,
  filesToCommit: string[],
): Promise<{ ok: boolean; error?: string }> => {
  if (filesToCommit.length === 0) {
    return { ok: true }
  }

  try {
    // Only stage files that were modified during this session, not everything
    const addResult = await $`git -C ${cwd} add ${filesToCommit}`.quiet().nothrow()
    if (addResult.exitCode !== 0) {
      return { ok: false, error: "git add failed" }
    }

    const commitResult = await $`git -C ${cwd} commit -m ${message}`.quiet().nothrow()
    if (commitResult.exitCode !== 0) {
      const stderr = await commitResult.text()
      // Check if nothing to commit
      if (stderr.includes("nothing to commit") || stderr.includes("no changes added")) {
        return { ok: true }
      }
      return { ok: false, error: stderr || "git commit failed" }
    }

    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ── Path Protection ─────────────────────────────────────────────────────────

const matchGlob = (pattern: string, path: string): boolean => {
  const normalizedPath = path.replace(/\\/g, "/")
  const normalizedPattern = pattern.replace(/\\/g, "/")
  const regexPattern = normalizedPattern
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".")
  const regex = new RegExp(`^(.*/)?${regexPattern}$`, "i")
  return regex.test(normalizedPath)
}

const isProtectedPath = (filePath: string, patterns: string[]): boolean => {
  const basename = filePath.split(/[\\/]/).pop() ?? filePath
  for (const pattern of patterns) {
    if (matchGlob(pattern, filePath) || matchGlob(pattern, basename)) return true
  }
  return false
}

// ── State Management ────────────────────────────────────────────────────────

const sessions = new Map<string, SessionState>()

const getSessionState = (sessionId: string): SessionState => {
  let state = sessions.get(sessionId)
  if (!state) {
    state = { filesModified: new Set(), filesCommitted: new Set(), commitMade: false, warnedOnIdle: false, createdAt: Date.now(), pendingCommitStagedFiles: [] }
    sessions.set(sessionId, state)
  }
  return state
}

const cleanupOldGitGuardSessions = (ttlMs: number = 86400000) => {
  const cutoff = Date.now() - ttlMs
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) {
      sessions.delete(id)
    }
  }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const xpowersGitGuardPlugin: Plugin = async (ctx) => {
  const config = await loadConfig(ctx.directory)

  if (!config.enabled) {
    return {}
  }

  return {
    // ── Pre-commit: capture staged files before git commit runs ───────────
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const command = String((output.args as any)?.command ?? "")
      if (!/git\s+commit/.test(command)) return

      const sessionId = (input as any).sessionID ?? "unknown"
      const state = getSessionState(sessionId)

      // Capture staged files BEFORE the commit executes
      const status = await getGitStatus(ctx.$, ctx.directory)
      state.pendingCommitStagedFiles = [...status.stagedFiles]
    },

    // ── Track file modifications and git commits ──────────────────────────
    "tool.execute.after": async (input, output) => {
      const sessionId = (input as any).sessionID ?? "unknown"
      const state = getSessionState(sessionId)

      // Track file writes/edits
      if (input.tool === "edit" || input.tool === "write") {
        const args = output.args ?? {}
        const filePath = String(args.filePath ?? args.file_path ?? "")
        if (filePath) {
          state.filesModified.add(filePath)

          // Extra warning for protected paths
          if (isProtectedPath(filePath, config.protectedPaths)) {
            await showToast(
              ctx.client,
              "⚠️ Protected File Modified",
              `${filePath}\nThis file is in the protected list. Consider reviewing before committing.`,
              "warning",
              6000,
            )
          }
        }
        return
      }

      // Track git commits
      if (input.tool === "bash") {
        const command = String((output.args as any)?.command ?? "")
        if (/git\s+commit/.test(command)) {
          state.commitMade = true

          // Use staged files captured BEFORE the commit (post-commit staged list is empty)
          for (const file of state.pendingCommitStagedFiles) {
            state.filesCommitted.add(file)
            state.filesModified.delete(file)
          }
          state.pendingCommitStagedFiles = []

          await showToast(
            ctx.client,
            "Git Commit",
            `Changes committed successfully`,
            "success",
            3000,
          )
        }
        return
      }
    },

    // ── Session lifecycle ─────────────────────────────────────────────────
    event: async ({ event }) => {
      const sessionId = (event as any).session_id ?? (event as any).sessionID ?? "unknown"

      if (event.type === "session.created" && sessionId) {
        // Reset state for new session
        sessions.set(sessionId, {
          filesModified: new Set(),
          filesCommitted: new Set(),
          commitMade: false,
          warnedOnIdle: false,
          createdAt: Date.now(),
          pendingCommitStagedFiles: [],
        })
        return
      }

      if (event.type === "session.deleted" && sessionId) {
        const state = sessions.get(sessionId)
        if (state && config.autoCommitOnSessionEnd && state.filesModified.size > 0 && !state.commitMade) {
          // Auto-commit on session end — only commit files modified during this session
          const filesToCommit = Array.from(state.filesModified)
          const result = await autoCommit(ctx.$, ctx.directory, config.autoCommitMessage, filesToCommit)
          if (result.ok) {
            await showToast(
              ctx.client,
              "Auto-Commit",
              `Committed ${state.filesModified.size} file(s) automatically`,
              "success",
              4000,
            )
          } else {
            await showToast(
              ctx.client,
              "Auto-Commit Failed",
              result.error ?? "Unknown error",
              "error",
              6000,
            )
          }
        }
        sessions.delete(sessionId)
        // Cleanup orphaned sessions older than 24 hours
        cleanupOldGitGuardSessions()
        return
      }

      // ── Warn on idle if uncommitted changes ──────────────────────────────
      if (event.type === "session.idle" && config.warnOnIdle) {
        const state = sessions.get(sessionId)
        if (!state || state.warnedOnIdle) return
        if (state.filesModified.size === 0 && !state.commitMade) return

        const hasChanges = await hasUncommittedChanges(ctx.$, ctx.directory)
        if (!hasChanges) return

        state.warnedOnIdle = true

        const gitStatus = await getGitStatus(ctx.$, ctx.directory)
        const diffStat = config.showDiffOnWarning
          ? await getGitDiffStat(ctx.$, ctx.directory)
          : null

        const lines: string[] = []

        if (diffStat) {
          lines.push(`${diffStat.files} files, +${diffStat.insertions}/-${diffStat.deletions}`)
        }

        const changedFiles = [
          ...gitStatus.modifiedFiles,
          ...gitStatus.stagedFiles,
          ...gitStatus.untrackedFiles,
        ]

        for (const file of changedFiles.slice(0, config.maxFilesInToast)) {
          const prefix = gitStatus.untrackedFiles.includes(file) ? "?" : "M"
          lines.push(`${prefix} ${file}`)
        }

        if (changedFiles.length > config.maxFilesInToast) {
          lines.push(`+${changedFiles.length - config.maxFilesInToast} more...`)
        }

        if (gitStatus.ahead) {
          lines.push(`\n↑ ${gitStatus.ahead} commit(s) ahead of origin`)
        }

        await showToast(
          ctx.client,
          "📝 Uncommitted Changes",
          lines.join("\n"),
          "warning",
          8000,
        )

        return
      }
    },

    // ── Stop hook: warn/block if uncommitted ───────────────────────────────
    stop: async (input) => {
      if (!config.warnOnStop) return

      const sessionId = (input as any).sessionID ?? (input as any).session_id ?? "unknown"
      const state = sessions.get(sessionId)

      if (!state) return
      if (state.filesModified.size === 0 && !state.commitMade) return

      const hasChanges = await hasUncommittedChanges(ctx.$, ctx.directory)
      if (!hasChanges) return

      const uncommittedCount = state.filesModified.size
      const committedCount = state.filesCommitted.size

      const message = [
        `## Git Guard Reminder`,
        ``,
        `You have ${uncommittedCount} uncommitted file(s) this session.`,
        committedCount > 0 ? `(Committed: ${committedCount} file(s))` : "",
        ``,
        `Modified files:`,
        ...Array.from(state.filesModified).slice(0, 10).map((f) => `- ${f}`),
        state.filesModified.size > 10 ? `- ...and ${state.filesModified.size - 10} more` : "",
        ``,
        `Consider committing before stopping:`,
        `\`git add -A && git commit -m "your message"\``,
      ]
        .filter(Boolean)
        .join("\n")

      // Inject reminder into session
      try {
        await ctx.client.session.prompt({
          path: { id: sessionId },
          body: {
            noReply: true,
            parts: [{ type: "text", text: message }],
          },
        })
      } catch {
        // Best-effort injection.
      }

      await showToast(
        ctx.client,
        "🛑 Uncommitted Changes",
        `${uncommittedCount} file(s) modified but not committed.\nConsider committing before stopping.`,
        "warning",
        10000,
      )

      if (config.blockStopIfUncommitted) {
        throw new Error(
          `XPowers Git Guard: ${uncommittedCount} uncommitted file(s). Commit before stopping or set blockStopIfUncommitted: false.`,
        )
      }
    },
  }
}

export default xpowersGitGuardPlugin
