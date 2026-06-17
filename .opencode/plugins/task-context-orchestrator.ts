import type { Plugin } from "@opencode-ai/plugin"
import { XPOWERS_AGENTS } from "./agent-routing-config"
import { type EffortLevel, isValidEffort } from "./routing-wizard-core"
import matter from "gray-matter"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

type TaskContextConfig = {
  enabled?: boolean
  timeoutMs?: number
  retries?: number
  maxItems?: number
  maxChars?: number
  maxSummaryCount?: number
  maxSummaryAgeHours?: number
  logLevel?: "silent" | "warn"
}

type TaskMemoryEntry = {
  key: string
  content: string
  score: number
  timestamp: number
  source: "serena" | "supermemory"
}

type TaskSummaryRecord = {
  run_id: string
  task_fingerprint: string
  prompt_excerpt: string
  status: string
  narrative: string
  timestamp: string
}

type CommandIntent = "execute-ralph" | "execute-plan" | null

type AgentModelSettings = {
  model?: string
}

type WorkflowOverrideMap = Record<string, Record<string, AgentModelSettings>>

type OpenCodeRoutingConfig = {
  model?: string
  agent?: Record<string, AgentModelSettings>
}

type XPowersRoutingConfig = {
  workflowOverrides?: WorkflowOverrideMap
}

const DEFAULT_CONFIG: Required<TaskContextConfig> = {
  enabled: true,
  timeoutMs: 2500,
  retries: 1,
  maxItems: 8,
  maxChars: 1500,
  maxSummaryCount: 50,
  maxSummaryAgeHours: 72,
  logLevel: "warn",
}

const normalizeConfig = (config: TaskContextConfig): Required<TaskContextConfig> => {
  const merged = { ...DEFAULT_CONFIG, ...config }
  return {
    enabled: Boolean(merged.enabled),
    timeoutMs: Math.max(200, Number(merged.timeoutMs) || DEFAULT_CONFIG.timeoutMs),
    retries: Math.max(0, Number(merged.retries) || DEFAULT_CONFIG.retries),
    maxItems: Math.max(1, Number(merged.maxItems) || DEFAULT_CONFIG.maxItems),
    maxChars: Math.max(120, Number(merged.maxChars) || DEFAULT_CONFIG.maxChars),
    maxSummaryCount: Math.max(1, Number(merged.maxSummaryCount) || DEFAULT_CONFIG.maxSummaryCount),
    maxSummaryAgeHours: Math.max(1, Number(merged.maxSummaryAgeHours) || DEFAULT_CONFIG.maxSummaryAgeHours),
    logLevel: merged.logLevel === "silent" ? "silent" : "warn",
  }
}

const ensureDir = async (filePath: string) => {
  await mkdir(dirname(filePath), { recursive: true })
}

const appendStructuredLog = async (
  filePath: string,
  payload: Record<string, unknown>,
  logLevel: "silent" | "warn",
) => {
  if (logLevel === "silent") return
  await ensureDir(filePath)
  await appendFile(
    filePath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...payload })}\n`,
    "utf8",
  )
}

const writeJsonFile = async (filePath: string, payload: unknown) => {
  await ensureDir(filePath)
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8")
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number) => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error("timeout")), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

const sourceCommand = (
  source: "serena" | "supermemory",
  mode: "context" | "summaries" | "save",
  shell: any,
  payload: string,
  narrative?: string,
) => {
  if (source === "serena" && mode === "context") {
    return shell`serena-memory context ${payload} --json`
  }
  if (source === "serena" && mode === "summaries") {
    return shell`serena-memory summaries ${payload} --json`
  }
  if (source === "serena") {
    return shell`serena-memory save ${payload} ${narrative ?? ""} --json`
  }
  if (mode === "context") {
    return shell`supermemory-memory context ${payload} --json`
  }
  if (mode === "summaries") {
    return shell`supermemory-memory summaries ${payload} --json`
  }
  return shell`supermemory-memory save ${payload} ${narrative ?? ""} --json`
}

const runSourceOperation = async (
  source: "serena" | "supermemory",
  mode: "context" | "summaries" | "save",
  shell: any,
  payload: string,
  timeoutMs: number,
  retries: number,
  narrative?: string,
) => {
  let lastError = "unknown"
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const process = sourceCommand(source, mode, shell, payload, narrative)
      const output = await withTimeout(process.text(), timeoutMs)
      const exitCode = await process.exited
      if (exitCode === 0) {
        return { ok: true as const, output }
      }
      lastError = `${source} ${mode} exited with code ${exitCode}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : `${source} ${mode} execution failed`
    }
  }

  return { ok: false as const, error: lastError }
}

const asArray = (value: unknown) => (Array.isArray(value) ? value : [])

const normalizeKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ")

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

const getString = (value: unknown) => {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const getNestedString = (value: unknown, key: string) => getString(asRecord(value)[key])

const normalizePrefixedLookupName = (value: string | null) => {
  if (!value) return null
  const withoutLeadingSlash = value.replace(/^\/+/, "")
  const segments = withoutLeadingSlash.split(":")
  const candidate = segments[segments.length - 1]?.trim()
  return candidate && candidate.length > 0 ? candidate : withoutLeadingSlash
}

const findConfigEntry = <T>(entries: Record<string, T> | undefined, key: string | null) => {
  if (!entries || !key) return null
  const normalizedKey = normalizeKey(key)
  for (const [entryKey, entryValue] of Object.entries(entries)) {
    if (normalizeKey(entryKey) === normalizedKey) return entryValue
  }
  return null
}

const INHERIT_SENTINEL = "__inherit__" as const

const parseFrontmatterModel = (content: string): string | null => {
  try {
    const { data } = matter(content)
    const value = getString((data as Record<string, unknown>).model)
    if (value === "inherit") return INHERIT_SENTINEL
    return value || null
  } catch {
    return null
  }
}

const hashPrompt = (input: string) => {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0
  }
  return hash.toString(16)
}

const parseSourceEntries = (source: "serena" | "supermemory", output: string): TaskMemoryEntry[] => {
  const payload = JSON.parse(output)
  const rootEntries = asArray((payload as any)?.entries)
  const nestedEntries = asArray((payload as any)?.data?.entries)
  const entries = rootEntries.length > 0 ? rootEntries : nestedEntries

  return entries
    .map((entry: any) => {
      const id = String(entry?.id ?? entry?.key ?? "").trim()
      const content = String(entry?.content ?? entry?.text ?? entry?.summary ?? "").trim()
      if (!id || !content) return null
      const score = typeof entry?.score === "number" ? entry.score : 0
      const timestamp = Number(new Date(entry?.timestamp ?? 0).getTime())

      return {
        key: normalizeKey(id),
        content,
        score,
        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
        source,
      }
    })
    .filter((entry: TaskMemoryEntry | null): entry is TaskMemoryEntry => Boolean(entry))
}

const mergeEntries = (
  serenaEntries: TaskMemoryEntry[],
  supermemoryEntries: TaskMemoryEntry[],
  maxItems: number,
) => {
  const merged = new Map<string, TaskMemoryEntry>()

  for (const entry of supermemoryEntries) {
    merged.set(entry.key, entry)
  }
  for (const entry of serenaEntries) {
    merged.set(entry.key, entry)
  }

  return Array.from(merged.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp
      return a.key.localeCompare(b.key)
    })
    .slice(0, maxItems)
}

const applyTruncation = (text: string, maxChars: number) => {
  if (text.length <= maxChars) return text
  const marker = "\n(truncated)"
  const sliceLength = Math.max(0, maxChars - marker.length)
  return `${text.slice(0, sliceLength).trimEnd()}${marker}`
}

const formatContextPack = (entries: TaskMemoryEntry[], maxChars: number) => {
  if (entries.length === 0) return null

  const lines = ["Task Context Pack"]
  for (const entry of entries) {
    lines.push(`- [${entry.source}] ${entry.key}: ${entry.content}`)
  }

  return applyTruncation(lines.join("\n"), maxChars)
}

const detectCommandIntent = (prompt: string): CommandIntent => {
  const normalized = prompt.toLowerCase()
  if (/(?:\/xpowers:)?execute-ralph\b/.test(normalized) || /\bexecute-ralph\b/.test(normalized)) {
    return "execute-ralph"
  }
  if (/(?:\/xpowers:)?execute-plan\b/.test(normalized) || /\bexecute-plan\b/.test(normalized)) {
    return "execute-plan"
  }
  return null
}

const loadOpenCodeRoutingConfig = async (
  configPath: string,
  errorLogPath: string,
  logLevel: "silent" | "warn",
): Promise<OpenCodeRoutingConfig> => {
  if (!existsSync(configPath)) return {}
  try {
    const raw = await readFile(configPath, "utf8")
    const parsed = JSON.parse(raw)
    return asRecord(parsed) as OpenCodeRoutingConfig
  } catch (error) {
    try {
      await appendStructuredLog(
        errorLogPath,
        {
          level: "warn",
          source: "task-context-orchestrator.loadOpenCodeRoutingConfig",
          message: "Failed to read or parse OpenCode routing configuration",
          configPath,
          error: error instanceof Error ? error.message : String(error),
        },
        logLevel,
      )
    } catch {
      // Swallow logging failures to avoid blocking task execution.
    }
    return {}
  }
}

const loadXPowersRoutingConfig = async (
  configPath: string,
  errorLogPath: string,
  logLevel: "silent" | "warn",
): Promise<XPowersRoutingConfig> => {
  if (!existsSync(configPath)) return {}
  try {
    const raw = await readFile(configPath, "utf8")
    const parsed = JSON.parse(raw)
    return asRecord(parsed) as XPowersRoutingConfig
  } catch (error) {
    try {
      await appendStructuredLog(
        errorLogPath,
        {
          level: "warn",
          source: "task-context-orchestrator.loadXPowersRoutingConfig",
          message: "Failed to read or parse XPowers routing configuration",
          configPath,
          error: error instanceof Error ? error.message : String(error),
        },
        logLevel,
      )
    } catch {
      // Swallow logging failures to avoid blocking task execution.
    }
    return {}
  }
}

const extractTaskAgentName = (args: Record<string, unknown>) => {
  return normalizePrefixedLookupName(
    getString(args.agent) ??
      getString(args.subagent) ??
      getString(args.subagent_type) ??
      getString(args.subagentType) ??
      getNestedString(args.metadata, "agent") ??
      getNestedString(args.metadata, "subagent") ??
      getNestedString(args.metadata, "subagent_type"),
  )
}

const detectWorkflowOverride = (
  args: Record<string, unknown>,
  prompt: string,
  workflowOverrides: WorkflowOverrideMap | undefined,
) => {
  if (!workflowOverrides) return null

  const explicitWorkflow = normalizePrefixedLookupName(
    getString(args.workflow) ??
      getString(args.xpowersWorkflow) ??
      getNestedString(args.metadata, "workflow") ??
      getNestedString(args.metadata, "xpowersWorkflow"),
  )
  if (explicitWorkflow) {
    const explicitMatch = findConfigEntry(workflowOverrides, explicitWorkflow)
    if (explicitMatch) return explicitWorkflow
    // Explicit workflow arguments are authoritative; if a caller provided one
    // that has no configured override, do not guess a different workflow from
    // prompt text or command intent.
    return null
  }

  const commandIntent = detectCommandIntent(prompt)
  const intentMatch = findConfigEntry(workflowOverrides, commandIntent)
  if (intentMatch && commandIntent) return commandIntent

  const searchableText = `${prompt}\n${getString(args.description) ?? ""}`.toLowerCase()
  for (const workflowName of Object.keys(workflowOverrides).sort((a, b) => b.length - a.length || a.localeCompare(b))) {
    if (searchableText.includes(workflowName.toLowerCase())) return workflowName
  }

  return null
}

const isValidAgentName = (name: string) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)

const getAgentFrontmatterPaths = (rootDir: string, agentName: string) => {
  if (!isValidAgentName(agentName)) return []
  const fileName = `${agentName}.md`
  const homeDir = process.env.HOME || homedir()
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(homeDir, ".config")

  const candidates = [
    join(rootDir, ".opencode", "agents", fileName),
    join(xdgConfigHome, "opencode", "agents", fileName),
    join(homeDir, ".opencode", "agents", fileName),
  ]

  return Array.from(new Set(candidates))
}

const readAgentFrontmatterModel = async (rootDir: string, agentName: string) => {
  for (const agentPath of getAgentFrontmatterPaths(rootDir, agentName)) {
    if (!existsSync(agentPath)) continue
    try {
      const raw = await readFile(agentPath, "utf8")
      const model = parseFrontmatterModel(raw)
      // The first existing agent file is authoritative. Both `model: inherit`
      // and a missing `model` field mean "inherit natively" — return null and
      // do NOT fall through to global agent files, which would override the
      // project-local intent (OpenCode omits `model` to inherit natively).
      if (model === INHERIT_SENTINEL) return null
      return model
    } catch {
      // Ignore unreadable agent files and keep searching fallback locations.
    }
  }

  return null
}

const resolveTaskModel = async (
  rootDir: string,
  args: Record<string, unknown>,
  prompt: string,
  errorLogPath: string,
  logLevel: "silent" | "warn",
) => {
  const explicitModel = getString(args.model)
  if (explicitModel) return explicitModel

  const agentName = extractTaskAgentName(args)
  if (!agentName) return null

  const config = await loadOpenCodeRoutingConfig(join(rootDir, "opencode.json"), errorLogPath, logLevel)
  const hpConfig = await loadXPowersRoutingConfig(
    join(rootDir, ".opencode", "xpowers-routing.json"),
    errorLogPath,
    logLevel,
  )
  const workflowName = detectWorkflowOverride(args, prompt, hpConfig.workflowOverrides)
  const workflowSettings = findConfigEntry(hpConfig.workflowOverrides, workflowName)
  const workflowModel = getString(findConfigEntry(workflowSettings, agentName)?.model)
  if (workflowModel) return workflowModel

  const agentModel = getString(findConfigEntry(config.agent, agentName)?.model)
  if (agentModel) return agentModel

  return readAgentFrontmatterModel(rootDir, agentName)
}

const resolveTaskEffort = async (
  rootDir: string,
  args: Record<string, unknown>,
  prompt: string,
  errorLogPath: string,
  logLevel: "silent" | "warn",
): Promise<EffortLevel | null> => {
  const agentName = extractTaskAgentName(args)
  if (!agentName) return null

  const config = await loadOpenCodeRoutingConfig(join(rootDir, "opencode.json"), errorLogPath, logLevel)
  const hpConfig = await loadXPowersRoutingConfig(
    join(rootDir, ".opencode", "xpowers-routing.json"),
    errorLogPath,
    logLevel,
  )

  // Check workflow override first
  const workflowName = detectWorkflowOverride(args, prompt, hpConfig.workflowOverrides)
  const workflowSettings = findConfigEntry(hpConfig.workflowOverrides, workflowName)
  const workflowEffort = getString(findConfigEntry(workflowSettings, agentName)?.effort)
  if (workflowEffort && isValidEffort(workflowEffort)) return workflowEffort

  // Then global agent config
  const agentEffort = getString(findConfigEntry(config.agent, agentName)?.effort)
  if (agentEffort && isValidEffort(agentEffort)) return agentEffort

  return null
}

const filterEntriesForIntent = (entries: TaskMemoryEntry[], intent: CommandIntent): TaskMemoryEntry[] => {
  if (!intent) return entries
  return entries.filter((entry) => {
    const normalized = `${entry.key} ${entry.content}`.toLowerCase()
    if (
      intent === "execute-ralph" &&
      normalized.includes("execute-plan") &&
      (normalized.includes("stop checkpoint") ||
        normalized.includes("stop after each task") ||
        normalized.includes("checkpoint"))
    ) {
      return false
    }
    if (intent === "execute-plan" && normalized.includes("execute-ralph") && normalized.includes("no checkpoint")) {
      return false
    }
    return true
  })
}

const formatIntentLock = (intent: CommandIntent) => {
  if (!intent) return null
  if (intent === "execute-ralph") {
    return [
      "Task Command Intent Lock",
      "- execute-ralph intent is authoritative",
      "- do not downgrade to execute-plan checkpoint semantics",
    ].join("\n")
  }
  return [
    "Task Command Intent Lock",
    "- execute-plan intent is authoritative",
    "- preserve STOP-after-each-task checkpoint semantics",
  ].join("\n")
}

const readSummaryCache = async (filePath: string): Promise<TaskSummaryRecord[]> => {
  if (!existsSync(filePath)) return []
  try {
    const raw = await readFile(filePath, "utf8")
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as TaskSummaryRecord[]) : []
  } catch {
    return []
  }
}

const trimSummaries = (
  summaries: TaskSummaryRecord[],
  maxSummaryCount: number,
  maxSummaryAgeHours: number,
) => {
  const cutoff = Date.now() - maxSummaryAgeHours * 60 * 60 * 1000
  return summaries
    .filter((summary) => {
      const ts = Number(new Date(summary.timestamp).getTime())
      return Number.isFinite(ts) && ts >= cutoff
    })
    .sort((a, b) => Number(new Date(b.timestamp).getTime()) - Number(new Date(a.timestamp).getTime()))
    .slice(0, maxSummaryCount)
}

const summariesToEntries = (summaries: TaskSummaryRecord[]): TaskMemoryEntry[] => {
  return summaries.map((summary) => ({
    key: normalizeKey(`summary:${summary.task_fingerprint}`),
    content: summary.narrative,
    score: 2,
    timestamp: Number(new Date(summary.timestamp).getTime()) || 0,
    source: "serena",
  }))
}

const loadConfig = async (configPath: string) => {
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG }
  try {
    const raw = await readFile(configPath, "utf8")
    const parsed = JSON.parse(raw)
    return normalizeConfig(parsed)
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

const buildRoutingSummary = async (rootDir: string, errorLogPath: string, logLevel: "silent" | "warn") => {
  const ocConfig = await loadOpenCodeRoutingConfig(join(rootDir, "opencode.json"), errorLogPath, logLevel)
  const defaultModel = getString(ocConfig.model) ?? "(session default)"
  const agentMap = asRecord(ocConfig.agent)

  const lines: string[] = ["Agent Model Routing:"]
  for (const agent of XPOWERS_AGENTS) {
    const entry = asRecord(agentMap[agent])
    const model = getString(entry.model) ?? defaultModel
    const effort = getString(entry.effort)
    const effortSuffix = effort ? ` [effort: ${effort}]` : ""
    lines.push(`  ${agent}: ${model}${effortSuffix}`)
  }
  return lines.join("\n")
}

const showToastSafe = async (client: any, title: string, message: string, variant: "info" | "success" = "info") => {
  try {
    await client.tui.showToast({ body: { title, message, variant, duration: 4000 } })
  } catch {
    // Toast is informational — never block execution on display failure.
  }
}

const taskContextOrchestratorPlugin: Plugin = async (ctx) => {
  const configPath = join(ctx.directory, ".opencode", "task-context.json")
  const config = await loadConfig(configPath)
  const cacheDir = join(ctx.directory, ".opencode", "cache", "task-context")
  const errorLogPath = join(cacheDir, "errors.log")
  let shownRoutingSummary = false
  const lastContextPath = join(cacheDir, "last-context.json")
  const summariesPath = join(cacheDir, "summaries.json")

  // Cached routing config to avoid re-reading files on every chat.params/dispatch
  let cachedRoutingConfig: OpenCodeRoutingConfig | null = null
  let cachedRoutingTimestamp = 0
  const ROUTING_CACHE_TTL_MS = 10000 // 10 seconds
  const getCachedRoutingConfig = async () => {
    const now = Date.now()
    if (cachedRoutingConfig && now - cachedRoutingTimestamp < ROUTING_CACHE_TTL_MS) {
      return cachedRoutingConfig
    }
    cachedRoutingConfig = await loadOpenCodeRoutingConfig(join(ctx.directory, "opencode.json"), errorLogPath, config.logLevel)
    cachedRoutingTimestamp = now
    return cachedRoutingConfig
  }

  // Store resolved effort per agent during task dispatch for chat.params to use
  const resolvedEffortByAgent = new Map<string, EffortLevel>()

  // Memsearch recall: fetch once on first system.transform call
  let memsearchRecalled = false
  let memsearchContext: string | null = null

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      if (!config.enabled) return
      try {
        const summary = await buildRoutingSummary(ctx.directory, errorLogPath, config.logLevel)
        output.system.push(summary)
      } catch {
        // System prompt injection is best-effort — never block the session.
      }

      // Memsearch recall: fetch relevant memories on first call
      if (!memsearchRecalled) {
        memsearchRecalled = true
        try {
          const projectName = basename(ctx.directory) || "project"
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 5000)
          const proc = Bun.spawn(["memsearch", "search", `recent work on ${projectName}`, "--top-k", "5", "--format", "compact"], {
            cwd: ctx.directory,
            stdout: "pipe",
            stderr: "pipe",
            signal: controller.signal,
          })
          const text = await new Response(proc.stdout).text()
          const exitCode = await proc.exited
          clearTimeout(timeout)
          if (exitCode === 0 && text.trim() && !text.startsWith("No results")) {
            memsearchContext = text.trim()
          }
        } catch {
          // memsearch not installed or failed — skip silently
        }
      }
      if (memsearchContext) {
        output.system.push(`Long-term Memory (memsearch):\n${memsearchContext}`)
      }
    },
    "chat.params": async (input, output) => {
      if (!config.enabled) return
      try {
        const rawAgentName = input.agent
        if (!rawAgentName) return
        const agentName = normalizePrefixedLookupName(rawAgentName) ?? rawAgentName

        // Check dispatch-resolved effort first (includes workflow overrides),
        // then fall back to global config
        let effort: string | null = resolvedEffortByAgent.get(agentName) ?? null
        if (!effort) {
          const ocConfig = await getCachedRoutingConfig()
          const agentEntry = asRecord(findConfigEntry(ocConfig.agent, agentName))
          effort = getString(agentEntry.effort)
        }
        if (!effort || !isValidEffort(effort)) return

        const providerId = input.provider?.info?.id ?? ""
        const existing = asRecord(output.options)
        if (providerId.includes("anthropic")) {
          const existingAnthropic = asRecord(existing.anthropic)
          const existingThinking = asRecord(existingAnthropic.thinking)
          output.options = { ...existing, anthropic: { ...existingAnthropic, effort, thinking: { ...existingThinking, type: "adaptive" } } }
        } else if (providerId.includes("openai") || providerId.includes("opencode")) {
          output.options = { ...existing, openai: { ...asRecord(existing.openai), reasoningEffort: effort } }
        } else if (providerId.includes("google")) {
          const existingGoogle = asRecord(existing.google)
          const existingThinkingConfig = asRecord(existingGoogle.thinkingConfig)
          output.options = { ...existing, google: { ...existingGoogle, thinkingConfig: { ...existingThinkingConfig, thinkingLevel: effort } } }
        }
      } catch {
        // Effort injection is best-effort — never block execution.
      }
    },
    "tool.execute.before": async (input, output) => {
      if (!config.enabled) return
      if (input.tool !== "task") return

      const args = (output.args ?? {}) as Record<string, unknown>
      const prompt = typeof args.prompt === "string" ? args.prompt : ""
      if (!prompt.trim()) return
      if (prompt.startsWith("Task Context Pack")) return

      const resolvedModel = await resolveTaskModel(ctx.directory, args, prompt, errorLogPath, config.logLevel)
      if (resolvedModel) {
        args.model = resolvedModel
      }

      // Show routing info via toast
      const agentName = extractTaskAgentName(args)
      if (agentName) {
        const displayModel = resolvedModel ?? "(inherited)"
        const resolvedEffort = await resolveTaskEffort(ctx.directory, args, prompt, errorLogPath, config.logLevel)
        if (resolvedEffort) {
          resolvedEffortByAgent.set(agentName, resolvedEffort)
        } else {
          resolvedEffortByAgent.delete(agentName)
        }
        const effortLabel = resolvedEffort ? ` [${resolvedEffort}]` : ""
        if (!shownRoutingSummary) {
          shownRoutingSummary = true
          const summary = await buildRoutingSummary(ctx.directory, errorLogPath, config.logLevel)
          showToastSafe(ctx.client, "XPowers Routing", summary)
        }
        showToastSafe(ctx.client, "Agent Dispatch", `${agentName} → ${displayModel}${effortLabel}`)
      }

      const commandIntent = detectCommandIntent(prompt)

      const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
      ;(output.args as any).__taskContextRunId = runId
      ;(output.args as any).__taskContextFingerprint = hashPrompt(prompt)

      const serenaResult = await runSourceOperation(
        "serena",
        "context",
        ctx.$,
        prompt,
        config.timeoutMs,
        config.retries,
      )
      const supermemoryResult = await runSourceOperation(
        "supermemory",
        "context",
        ctx.$,
        prompt,
        config.timeoutMs,
        config.retries,
      )
      const serenaSummaryResult = await runSourceOperation(
        "serena",
        "summaries",
        ctx.$,
        prompt,
        config.timeoutMs,
        config.retries,
      )
      const supermemorySummaryResult = await runSourceOperation(
        "supermemory",
        "summaries",
        ctx.$,
        prompt,
        config.timeoutMs,
        config.retries,
      )

      const serenaEntries: TaskMemoryEntry[] = []
      const supermemoryEntries: TaskMemoryEntry[] = []

      if (!serenaResult.ok) {
        await appendStructuredLog(
          errorLogPath,
          { run_id: runId, source: "serena", operation: "fetch", error: serenaResult.error },
          config.logLevel,
        )
      } else {
        try {
          serenaEntries.push(...parseSourceEntries("serena", serenaResult.output))
        } catch (error) {
          await appendStructuredLog(
            errorLogPath,
            {
              run_id: runId,
              source: "serena",
              operation: "parse",
              error: error instanceof Error ? error.message : "invalid serena payload",
            },
            config.logLevel,
          )
        }
      }

      if (!supermemoryResult.ok) {
        await appendStructuredLog(
          errorLogPath,
          { run_id: runId, source: "supermemory", operation: "fetch", error: supermemoryResult.error },
          config.logLevel,
        )
      } else {
        try {
          supermemoryEntries.push(...parseSourceEntries("supermemory", supermemoryResult.output))
        } catch (error) {
          await appendStructuredLog(
            errorLogPath,
            {
              run_id: runId,
              source: "supermemory",
              operation: "parse",
              error: error instanceof Error ? error.message : "invalid supermemory payload",
            },
            config.logLevel,
          )
        }
      }

      if (serenaSummaryResult.ok) {
        try {
          serenaEntries.push(...parseSourceEntries("serena", serenaSummaryResult.output))
        } catch {
          // no-op: summary parsing should not block task execution
        }
      }
      if (supermemorySummaryResult.ok) {
        try {
          supermemoryEntries.push(...parseSourceEntries("supermemory", supermemorySummaryResult.output))
        } catch {
          // no-op: summary parsing should not block task execution
        }
      }

      const cachedSummaries = trimSummaries(
        await readSummaryCache(summariesPath),
        config.maxSummaryCount,
        config.maxSummaryAgeHours,
      )
      serenaEntries.push(...summariesToEntries(cachedSummaries))

      const merged = mergeEntries(serenaEntries, supermemoryEntries, config.maxItems)
      const intentScopedEntries = filterEntriesForIntent(merged, commandIntent)
      await writeJsonFile(lastContextPath, {
        run_id: runId,
        intent: commandIntent,
        entries: intentScopedEntries,
      })

      const contextPack = formatContextPack(intentScopedEntries, config.maxChars)
      const intentLock = formatIntentLock(commandIntent)

      if (!contextPack && !intentLock) return
      if (contextPack && intentLock) {
        output.args.prompt = `${intentLock}\n\n${contextPack}\n\n${prompt}`
        return
      }
      output.args.prompt = `${contextPack ?? intentLock}\n\n${prompt}`
    },
    "tool.execute.after": async (input, output) => {
      if (!config.enabled) return
      if (input.tool !== "task") return

      const args = (output.args ?? {}) as Record<string, unknown>
      const prompt = typeof args.prompt === "string" ? args.prompt : ""
      const runId =
        typeof args.__taskContextRunId === "string"
          ? args.__taskContextRunId
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`
      const taskFingerprint =
        typeof args.__taskContextFingerprint === "string"
          ? args.__taskContextFingerprint
          : hashPrompt(prompt)

      const resultPayload = (output as any)?.result
      const status = typeof resultPayload?.status === "string" ? resultPayload.status : "unknown"
      const resultText = typeof resultPayload?.message === "string" ? resultPayload.message : ""

      // Show completion toast
      const agentName = extractTaskAgentName(args)
      const resolvedModel = getString(args.model)
      if (agentName) {
        const modelInfo = resolvedModel ? ` (${resolvedModel})` : ""
        const variant = status === "ok" || status === "success" ? "success" as const : "info" as const
        showToastSafe(ctx.client, "Agent Complete", `${agentName}${modelInfo}: ${status}`, variant)
      }

      const jsonSummary = {
        run_id: runId,
        task_fingerprint: taskFingerprint,
        status,
        timestamp: new Date().toISOString(),
      }
      const narrativeSummary = `Task ${taskFingerprint} finished with status ${status}${
        resultText ? `: ${resultText.slice(0, 180)}` : ""
      }`

      const serenaSave = await runSourceOperation(
        "serena",
        "save",
        ctx.$,
        JSON.stringify(jsonSummary),
        config.timeoutMs,
        config.retries,
        narrativeSummary,
      )
      if (!serenaSave.ok) {
        await appendStructuredLog(
          errorLogPath,
          { run_id: runId, source: "serena", operation: "save", error: serenaSave.error },
          config.logLevel,
        )
      }

      const supermemorySave = await runSourceOperation(
        "supermemory",
        "save",
        ctx.$,
        JSON.stringify(jsonSummary),
        config.timeoutMs,
        config.retries,
        narrativeSummary,
      )
      if (!supermemorySave.ok) {
        await appendStructuredLog(
          errorLogPath,
          { run_id: runId, source: "supermemory", operation: "save", error: supermemorySave.error },
          config.logLevel,
        )
      }

      const existing = await readSummaryCache(summariesPath)
      if (!existing.some((item) => item.run_id === runId || item.task_fingerprint === taskFingerprint)) {
        const next: TaskSummaryRecord[] = [
          {
            run_id: runId,
            task_fingerprint: taskFingerprint,
            prompt_excerpt: prompt.slice(0, 160),
            status,
            narrative: narrativeSummary,
            timestamp: new Date().toISOString(),
          },
          ...existing,
        ]
        await writeJsonFile(
          summariesPath,
          trimSummaries(next, config.maxSummaryCount, config.maxSummaryAgeHours),
        )
      }
    },
  }
}

export default taskContextOrchestratorPlugin
