/**
 * XPowers extension for Pi coding agent (pi.dev)
 *
 * Registers all xpowers skills as slash commands, provides
 * memsearch long memory integration, subagent delegation tool,
 * and TUI-based routing wizard.
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join, resolve, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { Type } from "@sinclair/typebox"
import { Container, SelectList, Text, Spacer } from "@mariozechner/pi-tui"
import askUserPlugin from "pi-ask-user"
import { executeSubagent, executeSubagentAsync } from "./subagent"
import { tryLoadPiSubagents } from "./subagent-bridge.js"
import { executePiTaskAsync } from "./task-runner"
import { runParallelReview } from "./review-parallel"
import { parsePiSkillMetadataFromSkillContent } from "./skill-metadata"
import { registerHooksPipeline } from "./hooks-pipeline"
import { registerTmTools } from "./tm-tools"
import { getReadyTasks, getOpenTasks, getBlockedTasks, getAssignedTasks, getClosedTasks, claimTask, closeTask, type TmTask } from "./tm-cli-wrapper"
import { TmDashboard } from "./tm-dashboard-tui"
import {
  XPOWERS_AGENTS,
  normalizeRoutingConfig,
  resetAllAgentOverrides,
  resolveRoutingEntry,
  serializeRoutingConfig,
  withAgentModel,
  withSubagentModel,
  withoutAgentOverride,
  type RoutingConfig,
  type RoutingMap,
} from "./routing"

// Resolve skill paths: try extension-local skills first, then repo root
const SOURCE_DIR = dirname(fileURLToPath(import.meta.url))
const EXTENSION_DIR = basename(SOURCE_DIR) === "dist" ? resolve(SOURCE_DIR, "..") : SOURCE_DIR
const ROUTING_CONFIG_PATH = join(EXTENSION_DIR, "routing.json")
const SKILLS_DIRS = [
  join(EXTENSION_DIR, "skills"),                        // installed: ~/.pi/agent/extensions/xpowers/skills/
  resolve(EXTENSION_DIR, "..", "..", "..", "skills"),    // dev: repo root skills/
]
const COMMANDS_DIRS = [
  join(EXTENSION_DIR, "commands"),
  resolve(EXTENSION_DIR, "..", "..", "..", "commands"),
]

// Skills to register as slash commands
const SKILLS = [
  { command: "brainstorm", skill: "brainstorming", description: "Interactive design refinement using Socratic questioning" },
  { command: "write-plan", skill: "writing-plans", description: "Create detailed implementation plan with bite-sized tasks" },
  { command: "execute-plan", skill: "executing-plans", description: "Execute plan in batches with review checkpoints" },
  { command: "execute-ralph", skill: "execute-ralph", description: "Execute entire epic autonomously without stopping" },
  { command: "review-impl", skill: "review-implementation", description: "Verify implementation matches requirements" },
  { command: "recall", skill: "recall", description: "Search long-term memory from previous sessions" },
  { command: "refactor", skill: "refactoring-safely", description: "Refactor code safely with tests green" },
  { command: "fix-bug", skill: "fixing-bugs", description: "Systematic bug fixing workflow" },
  { command: "debug", skill: "debugging-with-tools", description: "Systematic debugging using debuggers and agents" },
  { command: "tdd", skill: "test-driven-development", description: "Test-driven development: RED-GREEN-REFACTOR" },
  { command: "analyze-tests", skill: "analyzing-test-effectiveness", description: "Audit test quality for tautological tests" },
  { command: "verify", skill: "verification-before-completion", description: "Verify work before claiming complete" },
]

function loadSkillContent(skillName: string): string | null {
  for (const dir of SKILLS_DIRS) {
    const p = join(dir, skillName, "SKILL.md")
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf8")
      } catch {
        continue
      }
    }
  }
  return null
}

function loadSkillPiMetadata(skillName: string) {
  const content = loadSkillContent(skillName)
  return content ? parsePiSkillMetadataFromSkillContent(content) : null
}

function loadCommandContent(commandName: string): string | null {
  for (const dir of COMMANDS_DIRS) {
    const p = join(dir, `${commandName}.md`)
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf8")
      } catch {
        continue
      }
    }
  }
  return null
}

function formatPiCommandArgs(args: unknown): string {
  if (args === undefined || args === null) return ""
  if (typeof args === "string") {
    const trimmed = args.trim()
    return trimmed ? `\n\nPi invocation arguments: ${trimmed}` : ""
  }
  if (typeof args === "object") {
    const serialized = JSON.stringify(args)
    return serialized && serialized !== "{}"
      ? `\n\nPi invocation arguments: ${serialized}`
      : ""
  }
  return `\n\nPi invocation arguments: ${String(args)}`
}

function resolveArgumentsString(args: unknown): string {
  if (args === undefined || args === null) return ""
  if (typeof args === "string") return args.trim()
  if (typeof args === "object") {
    const serialized = JSON.stringify(args)
    return serialized && serialized !== "{}" ? serialized : ""
  }
  return String(args)
}

function getPiCompatBlock(skillName: string): string {
  const askQuestionInstruction = skillName === "brainstorming"
    ? "- In the brainstorming skill, you MUST use the `update_brainstorm_state` tool for interactive Q&A instead of AskUserQuestion."
    : "- ALWAYS use the provided `AskUserQuestion` tool for clarifying questions. It triggers an interactive TUI.";

  return `
<pi_compat>
This workflow was ported from Claude Code. In Pi, please adapt your tool usage:
${askQuestionInstruction}
- Map skill instructions: tools for interaction are available as first-class functions in your toolbox.
- When asked to "Use Skill tool: [name]", use your \`read\` tool to load \`skills/[name]/SKILL.md\` from the repository.
- When asked to use "Task()" or dispatch parallel agents, use the \`xpowers_subagent\` tool.
</pi_compat>
`;
}

function loadPiCommandPrompt(commandName: string, skillName: string, args: unknown): string | null {
  const argsStr = resolveArgumentsString(args)
  const compatBlock = getPiCompatBlock(skillName)

  const commandContent = loadCommandContent(commandName)
  if (commandContent) {
    const substituted = commandContent.replace(/\$ARGUMENTS/g, () => argsStr)
    return `${substituted}${formatPiCommandArgs(args)}\n${compatBlock}`
  }

  const skillContent = loadSkillContent(skillName)
  if (skillContent) {
    const substituted = skillContent.replace(/\$ARGUMENTS/g, () => argsStr)
    return `${substituted}${formatPiCommandArgs(args)}\n${compatBlock}`
  }

  return null
}

function getRoutingSettingsFallbackMessage(): string {
  return [
    "# XPowers Routing Settings",
    "",
    "The interactive routing wizard requires Pi's TUI UI context.",
    "Run `/routing-settings` inside an interactive Pi session to configure subagent type defaults and concrete agent overrides.",
    "",
    `Config file: ${ROUTING_CONFIG_PATH}`,
  ].join("\n")
}

async function executePiCommand(commandName: string, skillName: string, args: unknown, ctx: any): Promise<string> {
  const content = loadPiCommandPrompt(commandName, skillName, args)
  if (!content) {
    return `Skill "${skillName}" not found. Make sure xpowers is installed correctly.`
  }

  const metadata = loadSkillPiMetadata(skillName)
  if (metadata?.subProcess) {
    const routing = resolveSubagentRouting()
    const routingIsExplicit = routing.source !== "inherit" && (routing.model !== null || routing.effort !== undefined)
    const sessionSeedPath = ctx?.sessionManager?.getSessionFile?.()
    const requestedContextMode = metadata.subProcessContext
    const contextMode = requestedContextMode === "fork" && sessionSeedPath ? "fork" : "fresh"
    const result = await executePiTaskAsync({
      task: content,
      model: routingIsExplicit ? routing.model : metadata.model,
      effort: routingIsExplicit ? routing.effort : metadata.thinkingLevel,
      cwd: ctx?.cwd || process.cwd(),
      format: "text",
      contextMode,
      sessionSeedPath: contextMode === "fork" ? sessionSeedPath : undefined,
    })
    return result.content[0]?.text || "(subagent returned empty result)"
  }

  return content
}

// Subagent routing config
function loadRoutingConfig(): RoutingConfig {
  try {
    if (existsSync(ROUTING_CONFIG_PATH)) {
      return normalizeRoutingConfig(JSON.parse(readFileSync(ROUTING_CONFIG_PATH, "utf8")))
    }
  } catch { /* skip */ }
  return normalizeRoutingConfig({})
}

function saveRoutingConfig(config: RoutingConfig): void {
  writeFileSync(ROUTING_CONFIG_PATH, serializeRoutingConfig(config), "utf8")
}

function getRoutingMap(config: RoutingConfig): RoutingMap {
  return config.subagents
}

function resolveSubagentRouting(type?: string, agent?: string, explicitModel?: string) {
  return resolveRoutingEntry(loadRoutingConfig(), { type, agent, explicitModel })
}

// Discover available models from Pi's built-in providers and models.json
function discoverModels(): Array<{ provider: string; model: string; label: string }> {
  const models: Array<{ provider: string; model: string; label: string }> = []

  // Built-in models (always available)
  const builtins: Record<string, string[]> = {
    anthropic: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
    openai: ["o3", "o3-mini", "o4-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"],
    google: ["gemini-2.5-pro", "gemini-2.5-flash"],
  }
  for (const [provider, ids] of Object.entries(builtins)) {
    for (const id of ids) {
      models.push({ provider, model: `${provider}/${id}`, label: `${provider}/${id}` })
    }
  }

  // Custom models from ~/.pi/agent/models.json
  try {
    const modelsPath = join(homedir(), ".pi", "agent", "models.json")
    if (existsSync(modelsPath)) {
      const config = JSON.parse(readFileSync(modelsPath, "utf8"))
      for (const [provider, providerConfig] of Object.entries(config.providers || {})) {
        for (const m of (providerConfig as any).models || []) {
          const id = m.id || m.name
          if (id) {
            models.push({ provider, model: `${provider}/${id}`, label: `${provider}/${id}` })
          }
        }
      }
    }
  } catch { /* skip */ }

  return models
}

// Subagent types with descriptions
const SUBAGENT_TYPES = [
  { type: "review", description: "Code review, quality checks", recommended: "Fast (haiku)" },
  { type: "research", description: "Codebase investigation, API docs", recommended: "Balanced (sonnet)" },
  { type: "validation", description: "Final review, complex analysis", recommended: "Capable (opus)" },
  { type: "test-runner", description: "Run tests, check results", recommended: "Fast (haiku)" },
  { type: "default", description: "Any untyped subagent", recommended: "inherit (session model)" },
]

// Presets for quick configuration
const PRESETS: Record<string, RoutingConfig> = {
  "cost-optimized": normalizeRoutingConfig({
    subagents: {
      review: { model: "anthropic/claude-haiku-4-5" },
      research: { model: "anthropic/claude-haiku-4-5" },
      validation: { model: "anthropic/claude-sonnet-4-5" },
      "test-runner": { model: "anthropic/claude-haiku-4-5" },
      default: { model: "inherit" },
    },
  }),
  performance: normalizeRoutingConfig({
    subagents: {
      review: { model: "anthropic/claude-sonnet-4-5" },
      research: { model: "anthropic/claude-sonnet-4-5" },
      validation: { model: "anthropic/claude-opus-4-5" },
      "test-runner": { model: "anthropic/claude-haiku-4-5" },
      default: { model: "inherit" },
    },
  }),
  "all-inherit": normalizeRoutingConfig({
    subagents: {
      review: { model: "inherit" },
      research: { model: "inherit" },
      validation: { model: "inherit" },
      "test-runner": { model: "inherit" },
      default: { model: "inherit" },
    },
  }),
}

function recallMemories(cwd: string): string | null {
  try {
    const projectName = basename(cwd) || "project"
    const result = spawnSync("memsearch", ["search", `recent work on ${projectName}`, "--top-k", "5", "--format", "compact"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    })
    const output = result.stdout?.trim() || ""
    if (output && !output.startsWith("No results")) {
      return output
    }
  } catch {
    // memsearch not installed or failed — skip silently
  }
  return null
}

// TUI wizard helpers
interface SelectItem {
  label: string
  value: string | null
  description: string
}

function createSelectUI(
  items: SelectItem[],
  title: string,
  ctx: any,
  maxVisible = 10,
): Promise<string | null> {
  return ctx.ui.custom<string | null>(
    (tui: any, theme: any, _keybindings: any, done: (v: string | null) => void) => {
      const container = new Container()
      container.addChild(new Text(theme.fg("accent", theme.bold(title))))
      container.addChild(new Spacer(1))

      const selectList = new SelectList(
        items,
        Math.min(items.length, maxVisible),
        {
          selectedPrefix: (text: string) => theme.fg("accent", text),
          description: (text: string) => theme.fg("muted", text),
          scrollInfo: (text: string) => theme.fg("muted", text),
          scrollPrefix: (text: string) => theme.fg("muted", text),
          noMatch: (text: string) => theme.fg("warning", text),
        }
      )
      selectList.onSelect = (item: any) => done(item.value)
      container.addChild(selectList)

      return {
        render(width: number) { return container.render(width) },
        invalidate() { container.invalidate() },
        handleInput(data: string) {
          if (data === "\x1b") { done(null); return true }
          selectList.handleInput(data)
          return true
        },
      }
    }
  )
}

function createSearchableSelectUI(
  items: SelectItem[],
  title: string,
  subtitle: string,
  ctx: any,
): Promise<string | null> {
  return ctx.ui.custom<string | null>(
    (tui: any, theme: any, _keybindings: any, done: (v: string | null) => void) => {
      const container = new Container()
      container.addChild(new Text(theme.fg("accent", theme.bold(title))))
      container.addChild(new Text(theme.fg("muted", subtitle)))
      container.addChild(new Spacer(1))

      let filterText = ""

      const selectList = new SelectList(
        items,
        Math.min(items.length, 12),
        {
          selectedPrefix: (text: string) => theme.fg("accent", text),
          description: (text: string) => theme.fg("muted", text),
          scrollInfo: (text: string) => theme.fg("muted", text),
          scrollPrefix: (text: string) => theme.fg("muted", text),
          noMatch: (text: string) => theme.fg("warning", text),
        }
      )
      selectList.onSelect = (item: any) => done(item.value)
      container.addChild(selectList)

      const applyFilter = () => {
        if (!filterText) {
          selectList.setItems(items)
          return
        }
        const q = filterText.toLowerCase()
        const filtered = items.filter((item) =>
          item.label.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q)
        )
        selectList.setItems(filtered.length > 0 ? filtered : [
          { label: `No match for "${filterText}"`, value: null, description: "Backspace to clear" },
        ])
      }

      return {
        render(width: number) { return container.render(width) },
        invalidate() { container.invalidate() },
        handleInput(data: string) {
          // Printable character — add to filter
          if (data.length === 1 && data >= " " && data <= "~") {
            filterText += data
            applyFilter()
            return true
          }
          // Backspace — remove from filter
          if (data === "\x7f" || data === "\b") {
            filterText = filterText.slice(0, -1)
            applyFilter()
            return true
          }
          // Escape — clear filter or exit
          if (data === "\x1b") {
            if (filterText) {
              filterText = ""
              applyFilter()
            } else {
              done(null)
            }
            return true
          }
          selectList.handleInput(data)
          return true
        },
      }
    }
  )
}

async function runRoutingWizard(ctx: any): Promise<string> {
  while (true) {
    const routing = loadRoutingConfig()
    const subagentRouting = getRoutingMap(routing)

    const action = await ctx.ui.custom<string | null>(
      (_tui: any, theme: any, _keybindings: any, done: (v: string | null) => void) => {
        const container = new Container()

        container.addChild(new Text(theme.fg("accent", theme.bold("XPowers Routing Wizard"))))
        container.addChild(new Spacer(1))

        container.addChild(new Text(theme.fg("accent", "Subagent Type Defaults:")))
        for (const { type } of SUBAGENT_TYPES) {
          const entry = subagentRouting[type]
          const model = entry?.model || "inherit"
          const effort = entry?.effort ? ` (effort: ${entry.effort})` : ""
          const modelStr = model === "inherit"
            ? theme.fg("muted", "inherit (session model)")
            : theme.fg("success", model)
          container.addChild(new Text(`  ${theme.bold(type.padEnd(12))} ${modelStr}${effort}`))
        }

        container.addChild(new Spacer(1))
        container.addChild(new Text(theme.fg("accent", "Concrete Agent Overrides:")))
        if (Object.keys(routing.agents).length === 0) {
          container.addChild(new Text(`  ${theme.fg("muted", "(none configured)")}`))
        } else {
          for (const agent of XPOWERS_AGENTS) {
            const entry = routing.agents[agent.name]
            if (!entry) continue
            const model = entry.model || "inherit"
            const effort = entry.effort ? ` (effort: ${entry.effort})` : ""
            const modelStr = model === "inherit"
              ? theme.fg("muted", "inherit (session model)")
              : theme.fg("success", model)
            container.addChild(new Text(`  ${theme.bold(agent.name.padEnd(24))} ${modelStr}${effort}`))
          }
        }
        container.addChild(new Spacer(1))

        const actions: SelectItem[] = [
          { label: "Configure subagent type default", value: "single", description: "Set model for one abstract subagent type" },
          { label: "Configure concrete agent override", value: "agent", description: "Set model for one XPowers agent name" },
          { label: "Reset one concrete agent override", value: "reset-agent", description: "Remove one per-agent override and fall back to type/default" },
          { label: "Reset all concrete agent overrides", value: "reset-agents", description: "Keep type defaults, remove per-agent overrides" },
          { label: "Apply preset", value: "preset", description: "Cost-optimized, performance, or all-inherit" },
          { label: "Reset all to inherit", value: "reset", description: "All subagents use session model" },
          { label: "Done", value: "done", description: "Save and exit wizard" },
        ]

        const selectList = new SelectList(actions, actions.length, {
          selectedPrefix: (text: string) => theme.fg("accent", text),
          description: (text: string) => theme.fg("muted", text),
        })
        selectList.onSelect = (item: any) => done(item.value)
        container.addChild(selectList)

        return {
          render(width: number) { return container.render(width) },
          invalidate() { container.invalidate() },
          handleInput(data: string) {
            if (data === "\x1b") { done("done"); return true }
            selectList.handleInput(data)
            return true
          },
        }
      },
    )

    if (!action || action === "done") break

    if (action === "reset") {
      saveRoutingConfig(PRESETS["all-inherit"])
      ctx.ui.notify("All subagent defaults and concrete agent overrides reset to inherit", "success")
      continue
    }

    if (action === "reset-agents") {
      saveRoutingConfig(resetAllAgentOverrides(routing))
      ctx.ui.notify("All concrete agent overrides removed", "success")
      continue
    }

    if (action === "reset-agent") {
      const configuredAgents: SelectItem[] = XPOWERS_AGENTS
        .filter((agent) => routing.agents[agent.name])
        .map((agent) => ({
          label: `${agent.name} (current: ${routing.agents[agent.name]?.model || "inherit"})`,
          value: agent.name,
          description: `${agent.group} | falls back to ${agent.type}`,
        }))

      if (configuredAgents.length === 0) {
        ctx.ui.notify("No concrete agent overrides are currently configured", "warning")
        continue
      }

      configuredAgents.push({ label: "Back", value: null, description: "Return to main menu" })
      const agentName = await createSelectUI(configuredAgents, "Select Concrete Agent Override to Reset", ctx)
      if (!agentName) continue

      saveRoutingConfig(withoutAgentOverride(routing, agentName))
      ctx.ui.notify(`Removed concrete override for ${agentName}`, "success")
      continue
    }

    if (action === "preset") {
      const presetItems: SelectItem[] = [
        { label: "Cost-optimized", value: "cost-optimized", description: "Haiku for review/research/test, Sonnet for validation" },
        { label: "Performance", value: "performance", description: "Sonnet for review/research, Opus for validation, Haiku for tests" },
        { label: "All inherit", value: "all-inherit", description: "All subagents use your current session model" },
        { label: "Back", value: null, description: "Return to main menu" },
      ]

      const presetName = await createSelectUI(presetItems, "Select Preset", ctx)
      if (presetName && PRESETS[presetName]) {
        saveRoutingConfig(PRESETS[presetName])
        ctx.ui.notify(`Applied "${presetName}" preset`, "success")
      }
      continue
    }

    const models = discoverModels()
    const providers = [...new Set(models.map((m) => m.provider))]
    const modelItems: SelectItem[] = [
      { label: "inherit (use session model)", value: "inherit", description: "Subagent uses whatever model the session is running" },
    ]
    for (const provider of providers) {
      const providerModels = models.filter((m) => m.provider === provider)
      for (const m of providerModels) {
        modelItems.push({ label: m.label, value: m.model, description: provider })
      }
    }
    modelItems.push({ label: "Back", value: null, description: "Return to previous menu" })

    if (action === "single") {
      const agentItems: SelectItem[] = SUBAGENT_TYPES.map(({ type, description, recommended }) => {
        const current = subagentRouting[type]?.model || "inherit"
        return {
          label: `${type} (current: ${current})`,
          value: type,
          description: `${description} | recommended: ${recommended}`,
        }
      })
      agentItems.push({ label: "Back", value: null, description: "Return to main menu" })

      const agentType = await createSelectUI(agentItems, "Select Subagent Type", ctx)
      if (!agentType) continue

      const selectedModel = await createSearchableSelectUI(
        modelItems,
        `Select Model for subagent type "${agentType}"`,
        "Type to filter, Enter to select, Esc to go back",
        ctx,
      )

      if (selectedModel === null) continue

      saveRoutingConfig(withSubagentModel(routing, agentType, selectedModel))
      ctx.ui.notify(`${agentType} -> ${selectedModel}`, "success")
      continue
    }

    if (action === "agent") {
      const agentItems: SelectItem[] = XPOWERS_AGENTS.map((agent) => {
        const current = routing.agents[agent.name]?.model || "inherit"
        return {
          label: `${agent.name} (current: ${current})`,
          value: agent.name,
          description: `${agent.group} | fallback type: ${agent.type} | ${agent.description}`,
        }
      })
      agentItems.push({ label: "Back", value: null, description: "Return to main menu" })

      const agentName = await createSelectUI(agentItems, "Select Concrete XPowers Agent", ctx)
      if (!agentName) continue

      const selectedModel = await createSearchableSelectUI(
        modelItems,
        `Select Model for concrete agent "${agentName}"`,
        "Type to filter, Enter to select, Esc to go back",
        ctx,
      )

      if (selectedModel === null) continue

      saveRoutingConfig(withAgentModel(routing, agentName, selectedModel))
      ctx.ui.notify(`${agentName} -> ${selectedModel}`, "success")
    }
  }

  const finalRouting = loadRoutingConfig()
  const lines = [
    ...SUBAGENT_TYPES.map(({ type }) => {
      const entry = finalRouting.subagents[type]
      const model = entry?.model || "inherit"
      return `  type:${type} -> ${model}`
    }),
    ...XPOWERS_AGENTS
      .filter((agent) => finalRouting.agents[agent.name])
      .map((agent) => `  agent:${agent.name} -> ${finalRouting.agents[agent.name]?.model || "inherit"}`),
  ]
  return `Routing configuration saved:\n${lines.join("\n")}\n\nConfig file: ${ROUTING_CONFIG_PATH}`
}

export default function (pi: any) {
  // Prevent loading both project-local and global copies simultaneously.
  // When running inside the xpowers source repo, Pi discovers .pi/extensions/xpowers/
  // as a project-level extension AND loads the global install from
  // ~/.pi/agent/extensions/xpowers/.  Bail out of the project-local copy so only
  // the global install registers tools (avoids "Tool X conflicts" errors).
  const globalDir = join(homedir(), ".pi", "agent", "extensions", "xpowers")
  if (!SOURCE_DIR.startsWith(globalDir) && existsSync(join(globalDir, "package.json"))) {
    return
  }

  // Register hooks pipeline
  registerHooksPipeline(pi)
  
  // Register TM (Task Manager) tools
  registerTmTools(pi)

  // Capture ask_user tool definition to use in shim
  let askUserTool: any = null
  const piShim = {
    ...pi,
    registerTool(def: any) {
      if (def.name === "ask_user") {
        askUserTool = def
      }
      return pi.registerTool(def)
    }
  }


  // Brainstorm TUI Tool
  pi.registerTool({
    name: "update_brainstorm_state",
    label: "Brainstorm Dashboard",
    description: "Update the interactive Brainstorm Dashboard TUI with the current Epic state and ask the next multiple-choice question. Always use this instead of AskUserQuestion when brainstorming.",
    parameters: Type.Object({
      requirements: Type.Optional(Type.Array(Type.String())),
      antiPatterns: Type.Optional(Type.Array(Type.Object({
        pattern: Type.String(),
        reason: Type.String()
      }))),
      researchFindings: Type.Optional(Type.Array(Type.String())),
      openQuestions: Type.Optional(Type.Array(Type.String())),
      history: Type.Optional(Type.Array(Type.Object({
        role: Type.Union([Type.Literal("agent"), Type.Literal("user")]),
        content: Type.String()
      }))),
      question: Type.Optional(Type.String({ description: "The next question to ask the user" })),
      options: Type.Optional(Type.Array(Type.Object({
        label: Type.String(),
        description: Type.Optional(Type.String())
      }))),
      priority: Type.Optional(Type.String({ description: "CRITICAL, IMPORTANT, or NICE_TO_HAVE" }))
    }),
    async execute(_toolCallId: string, params: any, _signal?: unknown, _update?: unknown, ctx?: any) {
      if (!ctx?.ui?.custom) {
        return { content: [{ type: "text", text: "TUI not supported in this environment." }] };
      }
      const { BrainstormDashboard } = await import("./brainstorm-tui.js");
      
      const state = {
        requirements: params.requirements || [],
        antiPatterns: params.antiPatterns || [],
        researchFindings: params.researchFindings || [],
        openQuestions: params.openQuestions || [],
        history: params.history || []
      };
      
      if (params.question && params.options?.length > 0) {
        state.currentQuestion = {
          question: params.question,
          options: params.options,
          priority: params.priority || "IMPORTANT"
        };
      }

      const result = await ctx.ui.custom<string>(
        (tui: any, _theme: any, _keybindings: any, done: (v: string) => void) => {
          const dashboard = new BrainstormDashboard(state);
          dashboard.tui = tui;
          
          dashboard.onOptionSelect = (index: number) => {
            const selected = params.options?.[index]?.label
              ?? state.currentQuestion?.options?.[index]?.label
              ?? `option ${index}`;
            done(selected);
          };
          
          dashboard.onCancel = () => {
            done("User cancelled the question.");
          };
          
          return dashboard;
        },
        { overlay: true, overlayOptions: { width: "96%", maxHeight: "90%", margin: 1 } }
      );

      return { content: [{ type: "text", text: result }] };
    }
  });

  // Ralph Execution TUI Tool
  const ralphSessions = new Map<string, {
    dashboard: any
    handle: any
    hidden?: boolean
    closeTimer?: ReturnType<typeof setTimeout>
    doneCalled?: boolean
  }>()

  pi.registerTool({
    name: "update_ralph_state",
    label: "Ralph Dashboard",
    description: "Update the non-blocking Ralph Execution Dashboard TUI with current phase, epic/task status, and logs. The dashboard can be hidden with q/Esc/Ctrl+C and should never block normal Pi input.",
    parameters: Type.Object({
      close: Type.Optional(Type.Boolean({ description: "Close/hide the Ralph dashboard for this session" })),
      reopen: Type.Optional(Type.Boolean({ description: "Reopen the Ralph dashboard after it was hidden" })),
      phase: Type.Optional(Type.String({ description: "setup, get_task, subagent, review, completion, done" })),
      epicId: Type.Optional(Type.String()),
      epicTitle: Type.Optional(Type.String()),
      currentTaskId: Type.Optional(Type.String()),
      currentTaskTitle: Type.Optional(Type.String()),
      subagentStatus: Type.Optional(Type.String({ description: "pending, running, pass, fail, issues_found" })),
      subagentOutput: Type.Optional(Type.String()),
      branchName: Type.Optional(Type.String()),
      gitProgress: Type.Optional(Type.String()),
      unmetCriteria: Type.Optional(Type.Number()),
      totalCriteria: Type.Optional(Type.Number()),
      logMessage: Type.Optional(Type.String({ description: "A new log message to append" }))
    }),
    async execute(_toolCallId: string, params: any, _signal?: unknown, _update?: unknown, ctx?: any) {
      if (!ctx?.ui?.custom) {
        return { content: [] };
      }
      
      const { RalphDashboard } = await import("./ralph-dashboard-tui.js");

      const sessionKey = ctx?.sessionManager?.getSessionFile?.() || "default"
      let session = ralphSessions.get(sessionKey)

      if (params.close === true) {
        if (session?.closeTimer) {
          clearTimeout(session.closeTimer)
          session.closeTimer = undefined
        }
        session?.dashboard?.onCancel?.()
        if (session) {
          session.handle = null
          session.hidden = true
        }
        return { content: [{ type: "text", text: "Ralph dashboard hidden." }] }
      }

      if (params.reopen === true && session?.hidden) {
        session.hidden = false
        session.doneCalled = false
      }

      if (session?.closeTimer) {
        clearTimeout(session.closeTimer)
        session.closeTimer = undefined
      }

      const { logMessage, ...stateUpdate } = params

      if (session?.hidden) {
        session.dashboard?.updateState(stateUpdate)
        if (logMessage) {
          session.dashboard?.addLog(logMessage)
        }
        if (params.phase === "done") {
          session.closeTimer = setTimeout(() => {
            const currSession = ralphSessions.get(sessionKey)
            if (currSession === session) {
              ralphSessions.delete(sessionKey)
            }
          }, 2000)
        }
        return { content: [] }
      }

      if (!session || !session.dashboard) {
        const dashboard = new RalphDashboard({
          phase: "setup",
          unmetCriteria: 0,
          totalCriteria: 0,
          logs: [],
          ...stateUpdate
        })
        dashboard.tui = ctx.ui.tui
        session = { dashboard, handle: null }
        ralphSessions.set(sessionKey, session)
      } else {
        session.dashboard.updateState(stateUpdate)
      }

      if (logMessage) {
        session.dashboard.addLog(logMessage)
      }

      if (!session.handle) {
        const createdHandle = ctx.ui.custom(
          (tui: any, _theme: any, _keybindings: any, _done: (v: unknown) => void) => {
            session!.dashboard.tui = tui
            session!.dashboard.onCancel = () => {
              if (session!.doneCalled) return
              session!.doneCalled = true
              _done(null)
              const currSession = ralphSessions.get(sessionKey)
              if (currSession?.handle === createdHandle) {
                currSession.handle = null
                currSession.hidden = true
              }
            }
            return session!.dashboard
          },
          { overlay: true, overlayOptions: { width: "96%", maxHeight: "90%", margin: 1 } }
        )
        session.handle = createdHandle

        if (createdHandle && typeof createdHandle.then === 'function') {
          createdHandle.then(() => {
            const currSession = ralphSessions.get(sessionKey)
            if (currSession?.handle === createdHandle) {
              currSession.doneCalled = true
              currSession.handle = null
              currSession.hidden = true
            }
          }).catch(() => {})
        }
      } else {
        session.handle.requestRender?.()
      }

      if (params.phase === "done") {
        session.closeTimer = setTimeout(() => {
          const currSession = ralphSessions.get(sessionKey)
          if (currSession === session) {
            currSession.dashboard?.onCancel?.()
            ralphSessions.delete(sessionKey)
          }
        }, 2000)
      }

      return { content: [] };
    }
  });

  // Register third-party plugins
  askUserPlugin(piShim)

  // Register each skill as a slash command
  for (const { command, skill, description } of SKILLS) {
    pi.registerCommand(command, {
      description,
      handler: async (args: unknown, ctx: any) => {
        const result = await executePiCommand(command, skill, args, ctx)
        if (result) {
          if (typeof pi.sendUserMessage === "function") {
            await pi.sendUserMessage(result)
          } else {
            console.log(result)
          }
          return result
        }
      },
    })
  }

  pi.registerCommand("routing-settings", {
    description: "Interactive TUI wizard to configure XPowers subagent type defaults and concrete agent overrides",
    handler: async (_args: unknown, ctx: any) => {
      if (!ctx?.ui?.custom) {
        return getRoutingSettingsFallbackMessage()
      }
      return await runRoutingWizard(ctx)
    },
  })

  // Model setup wizard — generates ~/.pi/agent/models.json
  pi.registerCommand("setup-models", {
    description: "Configure Pi model providers (Anthropic, OpenAI, Ollama, etc.)",
    handler: async (_args: unknown, ctx: any) => {
      return `# Pi Model Setup

To configure your AI model providers, edit \`~/.pi/agent/models.json\`.

## Quick Setup Examples

### Anthropic (Claude)
No config needed — built-in. Just set \`ANTHROPIC_API_KEY\` env var.

### OpenAI
No config needed — built-in. Just set \`OPENAI_API_KEY\` env var.

### Ollama (local models, free)
\`\`\`json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b", "name": "Llama 3.1 8B" },
        { "id": "qwen2.5-coder:7b", "name": "Qwen 2.5 Coder 7B" }
      ]
    }
  }
}
\`\`\`

## Tips
- Switch models during session: \`/model\` or \`Ctrl+L\`
- Set \`"reasoning": true\` for models that support extended thinking
- Set \`"cost"\` to track token spending

Write your config to \`~/.pi/agent/models.json\` and restart Pi to apply.`
    },
  })

  // Subagent tool — delegates tasks to isolated Pi subprocess with model routing
  pi.registerTool({
    name: "xpowers_subagent",
    label: "Subagent",
    description: "Delegate a task to an isolated Pi subagent. Optionally specify an explicit model, a concrete agent, and/or an abstract type to route to a configured model. Runs in a separate process with its own context. Supports chain, parallel, async, worktree, and forked context modes when pi-subagents is installed.",
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "The task for the subagent to perform" })),
      model: Type.Optional(Type.String({ description: "Explicit one-off provider/model override with highest precedence (optional)" })),
      type: Type.Optional(Type.String({ description: "Subagent type for model routing: review, research, validation, test-runner (optional, uses routing.json config)" })),
      agent: Type.Optional(Type.String({ description: "Concrete XPowers agent name for routing precedence (optional, e.g. code-reviewer, internet-researcher, autonomous-reviewer)" })),
      format: Type.Optional(Type.Union([
        Type.Literal("text"),
        Type.Literal("structured"),
      ], { description: "Response format: raw text or structured JSON parsed by the helper (optional, defaults to text)" })),
      chain: Type.Optional(Type.Array(Type.Object({
        agent: Type.String(),
        task: Type.String(),
      }), { description: "Chain of sequential agent steps (mutually exclusive with tasks)" })),
      tasks: Type.Optional(Type.Array(Type.Object({
        agent: Type.String(),
        task: Type.String(),
      }), { description: "Parallel tasks to run simultaneously (mutually exclusive with chain)" })),
      async: Type.Optional(Type.Boolean({ description: "Run in background and return a run ID (requires pi-subagents)" })),
      context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")], { description: "fresh = clean session; fork = branched from parent session" })),
      worktree: Type.Optional(Type.Boolean({ description: "Isolate parallel tasks in git worktrees" })),
      output: Type.Optional(Type.String({ description: "Write results to this file path" })),
      reads: Type.Optional(Type.Array(Type.String(), { description: "Read these files before executing" })),
    }),
    async execute(_toolCallId: string, params: any, _signal?: unknown, _update?: unknown, ctx?: any) {
      try {
        const hasChain = Array.isArray(params.chain) && params.chain.length > 0
        const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0
        const hasTask = typeof params.task === "string" && params.task.length > 0

        if (!hasTask && !hasChain && !hasTasks) {
          const error = "Must provide at least one of: task, chain, or tasks."
          if (params.format === "structured") {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                status: "FAIL",
                summary: error,
                findings: [{ message: error, type: "validation-error" }],
                nextAction: "Provide task, chain, or tasks parameter",
              }) }],
            }
          }
          return { content: [{ type: "text" as const, text: error }] }
        }

        if (hasChain && hasTasks) {
          const error = "Cannot specify both chain and tasks. Choose one execution mode."
          if (params.format === "structured") {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                status: "FAIL",
                summary: error,
                findings: [{ message: error, type: "validation-error" }],
                nextAction: "Retry with either chain or tasks, not both",
              }) }],
            }
          }
          return { content: [{ type: "text" as const, text: error }] }
        }

        const routing = resolveSubagentRouting(params.type, params.agent, params.model)
        const cwd = ctx?.cwd || process.cwd()
        let sessionSeedPath: string | undefined
        let effectiveContext = params.context
        if (params.context === "fork") {
          sessionSeedPath = ctx?.sessionManager?.getSessionFile?.()
          if (!sessionSeedPath) {
            console.warn("[xpowers] Fork context requested but no parent session seed available; downgrading to fresh context")
            effectiveContext = "fresh"
          }
        }
        const bridgeParams = {
          task: params.task,
          model: routing.model,
          effort: routing.effort,
          agent: params.agent,
          cwd,
          format: params.format,
          chain: hasChain ? params.chain : undefined,
          tasks: hasTasks ? params.tasks : undefined,
          async: params.async,
          context: effectiveContext,
          worktree: params.worktree,
          output: params.output,
          reads: Array.isArray(params.reads) && params.reads.length > 0 ? params.reads : undefined,
          sessionSeedPath,
        }
        const routingEntry = { model: routing.model ?? undefined, effort: routing.effort }
        const resolveRouting = (agent?: string, type?: string) => resolveSubagentRouting(type, agent, undefined)

        if (params.async) {
          return await executeSubagentAsync(bridgeParams, routingEntry, resolveRouting)
        }
        return await executeSubagent(bridgeParams, routingEntry, resolveRouting)
      } catch (err: any) {
        if (params.format === "structured") {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              status: "FAIL",
              summary: err?.message || "Subagent failed unexpectedly",
              findings: [{
                message: err?.message || String(err),
                type: "tool-error",
                source: "xpowers-subagent-tool",
              }],
              nextAction: "Inspect routing resolution and subagent runtime state before retrying",
            }) }],
          }
        }
        return {
          content: [{ type: "text" as const, text: `Subagent failed: ${err?.message || String(err)}` }],
        }
      }
    },
  })

  // TUI-based routing wizard — interactive model assignment
  pi.registerCommand("configure-routing", {
    description: "Alias for /routing-settings",
    handler: async (_args: unknown, ctx: any) => {
      if (!ctx?.ui?.custom) {
        return getRoutingSettingsFallbackMessage()
      }
      return await runRoutingWizard(ctx)
    },
  })

  // Shim for Claude Code's AskUserQuestion tool to trigger pi-ask-user TUI
  pi.registerTool({
    name: "AskUserQuestion",
    label: "Ask User",
    description: "Ask the user a clarifying question with optional multiple-choice options. Triggers an interactive TUI menu.",
    promptSnippet: "Ask the user a clarifying question with optional multiple-choice options via interactive TUI",
    promptGuidelines: [
      "Use AskUserQuestion when a XPowers skill requires a user decision or clarifying question.",
      "Prefer AskUserQuestion over plain text responses when multiple options exist.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask the user" }),
      header: Type.Optional(Type.String({ description: "Context header shown above the question" })),
      options: Type.Optional(Type.Array(
        Type.Object({
          label: Type.String({ description: "The text shown for this option" }),
          description: Type.Optional(Type.String({ description: "Sub-text describing the option" })),
        })
      , { description: "Multiple choice options" })),
    }),
    async execute(_id: string, params: any, _sig: any, _upd: any, ctx: any) {
      if (!askUserTool) {
        return {
          content: [{ type: "text", text: "Error: ask_user tool not found" }],
          isError: true
        }
      }

      // Map Claude params to pi-ask-user params
      const askUserArgs = {
        question: params.question,
        context: params.header,
        options: params.options?.map((o: any) => ({
          title: o.label,
          description: o.description
        }))
      }
      
      return await askUserTool.execute(_id, askUserArgs, _sig, _upd, ctx)
    },
    renderCall(params: any, theme: any) {
      if (!askUserTool?.renderCall) return new Text(`AskUserQuestion: ${params.question}`, 0, 0)
      const mappedArgs = {
        question: params.question,
        options: params.options?.map((o: any) => ({ title: o.label, description: o.description }))
      }
      return askUserTool.renderCall(mappedArgs, theme)
    },
    renderResult(result: any, options: any, theme: any) {
      if (!askUserTool?.renderResult) return new Text("User answered question", 0, 0)
      return askUserTool.renderResult(result, options, theme)
    }
  })

  // Task Management dashboard — interactive TUI for tm
  pi.registerCommand("tm", {
    description: "Open interactive task management dashboard",
    handler: async (_args: unknown, ctx: any) => {
      if (!ctx?.ui?.custom) {
        return "Task Management TUI requires an interactive Pi session with UI support."
      }

      const cwd = ctx?.cwd || process.cwd()

      async function fetchTasks() {
        const ready = getReadyTasks(cwd) // keep ready tasks since they are unblocked (for backends that don't distinct well)
        const open = getOpenTasks(cwd)
        const blocked = getBlockedTasks(cwd)
        const assigned = getAssignedTasks(cwd)
        const closed = getClosedTasks(cwd)

        const tasks: TmTask[] = []
        const errors: string[] = []
        let hadSuccess = false

        if (ready.ok && ready.data) {
          tasks.push(...ready.data)
          hadSuccess = true
        } else if (ready.error) {
          errors.push(ready.error)
        }

        const seen = new Set(tasks.map((t) => t.id))

        if (open.ok && open.data) {
          hadSuccess = true
          for (const task of open.data) {
            if (!seen.has(task.id)) {
              tasks.push(task)
              seen.add(task.id)
            }
          }
        } else if (open.error) {
          errors.push(open.error)
        }

        if (blocked.ok && blocked.data) {
          hadSuccess = true
          for (const task of blocked.data) {
            if (!seen.has(task.id)) {
              tasks.push(task)
              seen.add(task.id)
            }
          }
        } else if (blocked.error) {
          errors.push(blocked.error)
        }

        if (assigned.ok && assigned.data) {
          hadSuccess = true
          for (const task of assigned.data) {
            if (!seen.has(task.id)) {
              tasks.push(task)
              seen.add(task.id)
            }
          }
        } else if (assigned.error) {
          errors.push(assigned.error)
        }

        if (closed.ok && closed.data) {
          hadSuccess = true
          // Add up to 50 recent closed tasks to prevent performance issues
          const recentClosed = closed.data.slice(0, 50)
          for (const task of recentClosed) {
            if (!seen.has(task.id)) {
              tasks.push(task)
              seen.add(task.id)
            }
          }
        } else if (closed.error) {
          errors.push(closed.error)
        }

        return { tasks, error: errors.join("; ") || undefined, hadSuccess }
      }

      const initial = await fetchTasks()
      const dashboard = new TmDashboard(initial)

      dashboard.onClaim = async (id: string) => {
        const result = claimTask(id, cwd)
        if (!result.ok) {
          dashboard.updateState({ error: result.error })
          return
        }
        const refreshed = await fetchTasks()
        dashboard.updateState({
          ...(refreshed.hadSuccess ? { tasks: refreshed.tasks } : {}),
          error: refreshed.error
            ? `Claimed ${id}, but refresh failed: ${refreshed.error}`
            : undefined,
        })
      }

      dashboard.onClose = async (id: string) => {
        const result = closeTask(id, cwd)
        if (!result.ok) {
          dashboard.updateState({ error: result.error })
          return
        }
        const refreshed = await fetchTasks()
        dashboard.updateState({
          ...(refreshed.hadSuccess ? { tasks: refreshed.tasks } : {}),
          error: refreshed.error
            ? `Closed ${id}, but refresh failed: ${refreshed.error}`
            : undefined,
        })
      }

      dashboard.onRefresh = async () => {
        const refreshed = await fetchTasks()
        dashboard.updateState({
          ...(refreshed.hadSuccess ? { tasks: refreshed.tasks } : {}),
          error: refreshed.error
        })
      }

      return await ctx.ui.custom<string>(
        (_tui: any, _theme: any, _keybindings: any, _done: (v: string) => void) => {
          dashboard.tui = _tui

          try {
            // Enable SGR mouse tracking for scrolling
            _tui.terminal.write("\x1b[?1000h\x1b[?1006h")

            dashboard.onCancel = () => {
              _done("Task Management dashboard closed.")
            }

            return dashboard
          } finally {
            dashboard.dispose = () => {
              _tui.terminal.write("\x1b[?1000l\x1b[?1006l")
            }
          }
        },
        { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%" } }
      )
    },
  })

  // Chain execution — sequential agent steps
  pi.registerCommand("chain", {
    description: "Run agents in sequence: /chain scout 'analyze' -> planner -> worker",
    handler: async (args: unknown, ctx: any) => {
      const api = await tryLoadPiSubagents()
      if (!api?.runChain) {
        return "Chain execution requires pi-subagents. Install with: pi install npm:pi-subagents"
      }
      const chainStr = typeof args === "string" ? args : ""
      return `Chain command parsed: ${chainStr}\n\n(Chain execution via pi-subagents is available once installed.)`
    },
  })

  // Parallel execution — fan-out/fan-in
  pi.registerCommand("parallel", {
    description: "Run agents in parallel: /parallel reviewer 'backend' -> reviewer 'frontend'",
    handler: async (args: unknown, ctx: any) => {
      const api = await tryLoadPiSubagents()
      if (!api?.runParallel) {
        return "Parallel execution requires pi-subagents. Install with: pi install npm:pi-subagents"
      }
      const parallelStr = typeof args === "string" ? args : ""
      return `Parallel command parsed: ${parallelStr}\n\n(Parallel execution via pi-subagents is available once installed.)`
    },
  })

  // Run-chain — reusable .chain.md workflows
  pi.registerCommand("run-chain", {
    description: "Run a reusable .chain.md workflow: /run-chain scout-planner -- refactor auth",
    handler: async (args: unknown, ctx: any) => {
      const api = await tryLoadPiSubagents()
      if (!api?.runChain) {
        return "Chain workflows require pi-subagents. Install with: pi install npm:pi-subagents"
      }
      const chainName = typeof args === "string" ? args.split(" ")[0] : ""
      return `Run-chain command for: ${chainName}\n\n(Chain workflows via pi-subagents are available once installed.)`
    },
  })

  // Async status — inspect background runs
  pi.registerCommand("async-status", {
    description: "Inspect background subagent runs",
    handler: async (_args: unknown, _ctx: any) => {
      const api = await tryLoadPiSubagents()
      if (!api?.runAsync) {
        return "Async status requires pi-subagents. Install with: pi install npm:pi-subagents"
      }
      return "Async status tracking is available once pi-subagents is installed."
    },
  })

  // Parallel review — dispatches multiple subagents
  pi.registerCommand("review-parallel", {
    description: "Run 3 parallel review subagents: quality, implementation, simplification",
    handler: async (_args: unknown, ctx: any) => {
      return await runParallelReview({
        cwd: ctx?.cwd || process.cwd(),
        resolveRoute: ({ type, agent }) => resolveSubagentRouting(type, agent, undefined),
        uiCtx: ctx,
      })
    },
  })

  // Session-aware review
  pi.registerCommand("review-branch", {
    description: "Review code in an isolated subprocess (won't affect main session)",
    handler: async (_args: unknown, ctx: any) => {
      return `# Branched Review

Use the xpowers_subagent tool to delegate the review. The subagent runs in a completely isolated Pi process — its context won't affect your main session.

Example: Call xpowers_subagent with task:
"Read the files changed in the last commit (git diff HEAD~1 --name-only), then review each file for bugs, security issues, and code quality. Provide a structured report."`
    },
  })

  // Memory recall on session start
  pi.on("session_start", async (event: any) => {
    const cwd = event?.cwd || process.cwd()
    const memories = recallMemories(cwd)
    if (memories) {
      return {
        context: `## Long-term Memory (memsearch)\nThe following memories from previous sessions may be relevant:\n\n${memories}\n\nUse these as background context. Do not repeat them unless asked.`,
      }
    }
  })
}
