#!/usr/bin/env bun

import * as p from "@clack/prompts"
import { existsSync, readFileSync } from "node:fs"
import { cp, mkdir, readFile, readdir, rm, writeFile, symlink, unlink, stat, rename, chmod } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "..")
const VERSION = JSON.parse(await readFile(join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8")).version as string

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SourceMapping = {
  from: string
  pattern?: string
  exclude?: string[]
}

type HostConfig = {
  id: string
  name: string
  detect: () => boolean
  targetDir: () => string
  sources: Record<string, SourceMapping>
  postInstall?: (targetDir: string) => Promise<void>
  postUninstall?: (targetDir: string) => Promise<void>
  availableFeatures: string[]
}

type FeatureConfig = {
  id: string
  name: string
  hint: string
  install: (hosts: string[], repoRoot: string) => Promise<string>
  uninstall: (manifest: InstallManifest) => Promise<void>
}

type InstallManifest = {
  version: string
  installedAt: string
  hosts: Record<string, { targetDir: string; files: string[] }>
  features: Record<string, { installed: boolean; metadata?: Record<string, unknown> }>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const xdgConfig = () => process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
const legacyNs = () => "hyper" + "powers"
const conflictingNamespaces = ["hyperpowers", "myhyperpowers", "superpowers"]
const manifestPath = () => join(homedir(), ".xpowers", "manifest.json")
const legacyManifestPath = () => join(homedir(), `.${legacyNs()}`, "manifest.json")

const commandExists = (cmd: string): boolean => {
  try {
    const result = Bun.spawnSync(["bash", "-c", `command -v ${cmd}`], { stdout: "pipe", stderr: "pipe" })
    return result.exitCode === 0
  } catch {
    return false
  }
}

const throwOnSpawnFailure = (result: { exitCode: number, stdout: Uint8Array, stderr: Uint8Array }, label: string) => {
  if (result.exitCode === 0) return
  const stderr = result.stderr.toString().trim()
  const stdout = result.stdout.toString().trim()
  throw new Error(`${label}${stderr || stdout ? `: ${stderr || stdout}` : ""}`)
}

const THIRD_PARTY_SKIP_ENV = "XPOWERS_SKIP_THIRD_PARTY_FEATURES"
const THIRD_PARTY_FEATURES = new Set(["br", "bv", "graphify", "claude-mem"])
const HOST_INDEPENDENT_FEATURES = new Set(["tm-cli", "br", "bv"])
const BEADS_RUST_INSTALL_REF = process.env.XPOWERS_BEADS_RUST_INSTALL_REF || "f4687e51a5aa155fe27cb8ea6d7fdae942b0154f"
const BEADS_VIEWER_INSTALL_REF = process.env.XPOWERS_BEADS_VIEWER_INSTALL_REF || "bb977f5b812b2987d77544872287b502b5b3a444"

const skipThirdPartyFeatures = () => {
  const value = process.env[THIRD_PARTY_SKIP_ENV]?.toLowerCase()
  return value === "1" || value === "true" || value === "yes"
}

const thirdPartySkipMessage = () => `skipped (${THIRD_PARTY_SKIP_ENV}=1)`

const GRAPHIFY_SUPPORTED_HOSTS = "Claude Code, Codex, OpenCode, Gemini CLI, or Pi Agent"
const GRAPHIFY_TARGETS = [
  { hostId: "claude", label: "Claude Code", args: ["graphify", "install"] },
  { hostId: "codex", label: "Codex", args: ["graphify", "install", "--platform", "codex"] },
  { hostId: "opencode", label: "OpenCode", args: ["graphify", "install", "--platform", "opencode"] },
  { hostId: "gemini", label: "Gemini CLI", args: ["graphify", "install", "--platform", "gemini"] },
  { hostId: "pi", label: "Pi Agent", args: ["graphify", "install", "--platform", "pi"] },
]

const graphifyTargetsForHosts = (hosts: string[]) => {
  const selectedHosts = new Set(hosts)
  return GRAPHIFY_TARGETS.filter((target) => selectedHosts.has(target.hostId))
}

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
const graphifyCommand = (args: string[]) => args.join(" ")
const beadsRustInstallUrl = () => `https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/${BEADS_RUST_INSTALL_REF}/install.sh`
const beadsViewerInstallUrl = () => `https://raw.githubusercontent.com/Dicklesworthstone/beads_viewer/${BEADS_VIEWER_INSTALL_REF}/install.sh`

const copyDir = async (src: string, dest: string) => {
  await mkdir(dest, { recursive: true })
  await cp(src, dest, { recursive: true })
}

const copyFile = async (src: string, dest: string) => {
  await mkdir(dirname(dest), { recursive: true })
  await cp(src, dest)
}

const listItems = async (dir: string, pattern?: string, exclude?: string[]): Promise<string[]> => {
  if (!existsSync(dir)) return []
  const items = await readdir(dir)
  return items.filter((item) => {
    if (exclude?.includes(item)) return false
    if (pattern) {
      const regex = new RegExp("^(" + pattern.replace(/\*/g, ".*") + ")$")
      if (!regex.test(item)) return false
    }
    return true
  })
}

type ConflictInstall = { name: string, path: string, removalHint: string }

const candidateConflictPaths = (name: string): string[] => [
  join(homedir(), ".claude", "plugins", `${name}@${name}`),
  join(homedir(), ".claude", "plugins", name),
  join(xdgConfig(), "opencode", "plugins", name),
  join(xdgConfig(), "opencode", "skills", name),
  join(xdgConfig(), "agents", "skills", name),
  join(homedir(), ".codex", "skills", name),
  join(homedir(), ".agents", "skills", name),
  join(homedir(), ".pi", "agent", "extensions", name),
]

const removalHintFor = (name: string, conflictPath: string): string => {
  if (conflictPath.includes(`${name}@${name}`)) return `Claude Code: /plugin uninstall ${name}@${name} --scope user`
  return `Remove or uninstall ${name} from this host before installing XPowers.`
}

const detectConflictingInstalls = (): ConflictInstall[] => {
  const seen = new Set<string>()
  const conflicts: ConflictInstall[] = []

  for (const name of conflictingNamespaces) {
    for (const conflictPath of candidateConflictPaths(name)) {
      if (!existsSync(conflictPath)) continue
      const key = `${name}\0${conflictPath}`
      if (seen.has(key)) continue
      seen.add(key)
      conflicts.push({ name, path: conflictPath, removalHint: removalHintFor(name, conflictPath) })
    }
  }

  return conflicts
}

const formatConflictMessage = (conflicts: ConflictInstall[]): string => [
  "Conflicting install(s) detected. Remove these before installing XPowers, or rerun with --allow-conflicts if you intentionally want both systems active:",
  ...conflicts.map((conflict) => `- ${conflict.name}: ${conflict.path}\n  ${conflict.removalHint}`),
].join("\n")

// ---------------------------------------------------------------------------
// Host Configurations (data-driven, not 5x functions)
// ---------------------------------------------------------------------------

const HOSTS: HostConfig[] = [
  {
    id: "claude",
    name: "Claude Code",
    detect: () => existsSync(join(homedir(), ".claude")),
    targetDir: () => join(homedir(), ".claude"),
    sources: {
      skills: { from: "skills", exclude: ["common-patterns"] },
      agents: { from: "agents", exclude: ["CLAUDE.md"] },
      commands: { from: "commands" },
      hooks: { from: "hooks" },
    },
    availableFeatures: ["memsearch", "statusline", "graphify", "claude-mem"],
    postInstall: async (targetDir) => {
      // Copy statusline script
      const src = join(REPO_ROOT, "scripts", "xpowers-statusline.sh")
      if (existsSync(src)) {
        await copyFile(src, join(targetDir, "xpowers-statusline.sh"))
      }
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    detect: () => existsSync(join(xdgConfig(), "opencode")),
    targetDir: () => join(xdgConfig(), "opencode"),
    sources: {
      skills: { from: ".opencode/skills", pattern: "xpowers-*|beads-*" },
      agents: { from: ".opencode/agents" },
      commands: { from: ".opencode/commands" },
      plugins: { from: ".opencode/plugins" },
      scripts: { from: ".opencode/scripts" },
    },
    availableFeatures: ["memsearch", "supermemory", "routing-wizard", "graphify", "claude-mem"],
    postInstall: async (targetDir) => {
      // Copy package.json and run bun install
      const pkgSrc = join(REPO_ROOT, ".opencode", "package.json")
      if (existsSync(pkgSrc)) {
        await copyFile(pkgSrc, join(targetDir, "package.json"))
        if (commandExists("bun")) {
          const installResult = Bun.spawnSync(["bun", "install", "--silent"], { cwd: targetDir, stdout: "pipe", stderr: "pipe" })
          throwOnSpawnFailure(installResult, "OpenCode dependency install failed")
        }
      }
      // Copy config files
      for (const f of ["task-context.json", "cass-memory.json"]) {
        const src = join(REPO_ROOT, ".opencode", f)
        if (existsSync(src)) await copyFile(src, join(targetDir, f))
      }
    },
  },
  {
    id: "kimi",
    name: "Kimi CLI",
    detect: () => existsSync(join(xdgConfig(), "agents")) || existsSync(join(homedir(), ".kimi")),
    targetDir: () => {
      // Prefer XDG agents path (modern); fall back to ~/.kimi only if it exists and XDG doesn't
      if (existsSync(join(xdgConfig(), "agents"))) return join(xdgConfig(), "agents")
      if (existsSync(join(homedir(), ".kimi"))) return join(homedir(), ".kimi")
      return join(xdgConfig(), "agents") // default to XDG on fresh machines
    },
    sources: {
      skills: { from: ".kimi/skills" },
      agents: { from: ".kimi/agents" },
    },
    availableFeatures: [],
    postInstall: async (targetDir) => {
      // Copy top-level config files to target dir
      for (const f of ["xpowers.yaml", "xpowers-system.md"]) {
        const src = join(REPO_ROOT, ".kimi", f)
        if (existsSync(src)) await copyFile(src, join(targetDir, f))
      }
      // MCP config: merge into ~/.config/kimi/mcp.json (don't overwrite existing entries)
      const kimiConfigDir = join(xdgConfig(), "kimi")
      const mcpSrc = join(REPO_ROOT, ".kimi", "mcp.json")
      const mcpDest = join(kimiConfigDir, "mcp.json")
      if (existsSync(mcpSrc)) {
        await mkdir(kimiConfigDir, { recursive: true })
        try {
          const newConfig = JSON.parse(await readFile(mcpSrc, "utf8")) as Record<string, unknown>
          let existing: Record<string, unknown> = {}
          if (existsSync(mcpDest)) {
            existing = JSON.parse(await readFile(mcpDest, "utf8")) as Record<string, unknown>
          }
          // Deep-merge mcpServers to preserve user's existing entries
          const merged = { ...existing }
          for (const [key, value] of Object.entries(newConfig)) {
            if (key === "mcpServers" && typeof value === "object" && typeof merged[key] === "object") {
              merged[key] = { ...(merged[key] as Record<string, unknown>), ...(value as Record<string, unknown>) }
            } else {
              merged[key] = value
            }
          }
          await writeFile(mcpDest, JSON.stringify(merged, null, 2) + "\n", "utf8")
        } catch {
          // Fall back to copy if merge fails
          await copyFile(mcpSrc, mcpDest)
        }
      }
    },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    detect: () => commandExists("gemini"),
    targetDir: () => join(REPO_ROOT, ".gemini-extension"),
    sources: {},
    availableFeatures: ["graphify", "claude-mem"],
    postInstall: async () => {
      if (!commandExists("gemini")) {
        throw new Error("gemini CLI not found — cannot install extension")
      }
      const installResult = Bun.spawnSync(["gemini", "extensions", "install", REPO_ROOT], { stdout: "pipe", stderr: "pipe" })
      throwOnSpawnFailure(installResult, "Gemini extension install failed")
    },
    postUninstall: async () => {
      if (commandExists("gemini")) {
        const uninstallResult = Bun.spawnSync(["gemini", "extensions", "uninstall", "xpowers"], { stdout: "pipe", stderr: "pipe" })
        throwOnSpawnFailure(uninstallResult, "Gemini extension uninstall failed")
      }
    },
  },
  {
    id: "pi",
    name: "Pi Agent",
    detect: () => commandExists("pi"),
    targetDir: () => join(homedir(), ".pi", "agent"),
    sources: {
      "extensions/xpowers": { from: ".pi/extensions/xpowers", exclude: ["routing.json"] },
    },
    availableFeatures: ["memsearch", "graphify"],
    postInstall: async (targetDir) => {
      const extDir = join(targetDir, "extensions", "xpowers")

      // Install extension dependencies (pi-tui, typebox, etc.) before mutating user files.
      if (existsSync(join(extDir, "package.json"))) {
        if (!commandExists("bun")) {
          throw new Error("Pi install requires bun to build the extension (npm is not sufficient to generate dist/index.js)")
        }

        const installResult = Bun.spawnSync(["bun", "install", "--silent"], { cwd: extDir, stdout: "pipe", stderr: "pipe" })

        if (installResult.exitCode !== 0) {
          const stderr = installResult.stderr.toString().trim()
          const stdout = installResult.stdout.toString().trim()
          throw new Error(`Pi extension dependency install failed${stderr || stdout ? `: ${stderr || stdout}` : ""}`)
        }

        // Build the TypeScript source to ESM to avoid Jiti transpilation bugs in Pi
        const buildResult = Bun.spawnSync(["bun", "build", "index.ts", "--target=node", "--format=esm", "--packages=external", "--outfile=dist/index.js"], { cwd: extDir, stdout: "pipe", stderr: "pipe" })
        if (buildResult.exitCode !== 0) {
          const stderr = buildResult.stderr.toString().trim()
          throw new Error(`Pi extension build failed: ${stderr}`)
        }

        if (!existsSync(join(extDir, "dist", "index.js"))) {
          throw new Error("Pi extension build failed to produce dist/index.js")
        }
      }

      // Append/replace XPowers section in AGENTS.md (preserve user content before AND after)
      const agentsMdSrc = join(REPO_ROOT, ".pi", "AGENTS.md")
      const agentsMdDest = join(targetDir, "AGENTS.md")
      if (existsSync(agentsMdSrc)) {
        const newContent = readFileSync(agentsMdSrc, "utf8")
        if (existsSync(agentsMdDest)) {
          const existing = readFileSync(agentsMdDest, "utf8")
          await writeFile(agentsMdDest, replacePiAgentsSection(existing, newContent), "utf8")
        } else {
          await writeFile(agentsMdDest, wrapPiAgentsSection(newContent) + "\n", "utf8")
        }
      }
      // Copy skills directory for runtime skill loading
      const skillsSrc = join(REPO_ROOT, "skills")
      if (existsSync(skillsSrc)) {
        await copyDir(skillsSrc, join(targetDir, "extensions", "xpowers", "skills"))
      }
      // Copy commands directory for command-specific Pi wrappers such as execute-ralph
      const commandsSrc = join(REPO_ROOT, "commands")
      if (existsSync(commandsSrc)) {
        await copyDir(commandsSrc, join(targetDir, "extensions", "xpowers", "commands"))
      }
      // Preserve user routing.json if it exists (don't overwrite custom model assignments)
      const routingDest = join(extDir, "routing.json")
      const routingSrc = join(REPO_ROOT, ".pi", "extensions", "xpowers", "routing.json")
      if (!existsSync(routingDest) && existsSync(routingSrc)) {
        await copyFile(routingSrc, routingDest)
      }
    },
    postUninstall: async (targetDir) => {
      // Remove XPowers section from AGENTS.md (preserve user content)
      const agentsMdPath = join(targetDir, "AGENTS.md")
      if (existsSync(agentsMdPath)) {
        const content = readFileSync(agentsMdPath, "utf8")
        const remaining = removePiAgentsSection(content)
        if (remaining) {
          await writeFile(agentsMdPath, remaining + "\n", "utf8")
        } else {
          await rm(agentsMdPath, { force: true })
        }
      }
      // Remove entire xpowers extension directory (includes skills, routing, node_modules)
      const extDir = join(targetDir, "extensions", "xpowers")
      if (existsSync(extDir)) {
        await rm(extDir, { recursive: true, force: true })
      }
    },
  },
]

// ---------------------------------------------------------------------------
// Feature Configurations
// ---------------------------------------------------------------------------

const PI_AGENTS_SECTION_BEGIN = "<!-- BEGIN XPOWERS PI -->"
const PI_AGENTS_SECTION_END = "<!-- END XPOWERS PI -->"
const LEGACY_PI_AGENTS_SECTION_BEGIN = `<!-- BEGIN ${"HYPER"}POWERS PI -->`
const LEGACY_PI_AGENTS_SECTION_END = `<!-- END ${"HYPER"}POWERS PI -->`
const PI_AGENTS_LEGACY_MARKERS = ["# XPowers for Pi", `# ${"Hyper"}powers for Pi`]

function wrapPiAgentsSection(content: string): string {
  return `${PI_AGENTS_SECTION_BEGIN}\n${content.trim()}\n${PI_AGENTS_SECTION_END}`
}

function findDelimitedSection(existing: string, beginMarker: string, endMarker: string): { beginIdx: number; endIdx: number; endLength: number } | null {
  const beginIdx = existing.indexOf(beginMarker)
  const endIdx = existing.indexOf(endMarker)
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    return { beginIdx, endIdx, endLength: endMarker.length }
  }
  return null
}

function findPiAgentsSection(existing: string): { beginIdx: number; endIdx: number; endLength: number } | null {
  return findDelimitedSection(existing, PI_AGENTS_SECTION_BEGIN, PI_AGENTS_SECTION_END)
    ?? findDelimitedSection(existing, LEGACY_PI_AGENTS_SECTION_BEGIN, LEGACY_PI_AGENTS_SECTION_END)
}

function replacePiAgentsSection(existing: string, newContent: string): string {
  const wrapped = wrapPiAgentsSection(newContent)
  const section = findPiAgentsSection(existing)

  if (section) {
    const before = existing.slice(0, section.beginIdx).trimEnd()
    const after = existing.slice(section.endIdx + section.endLength).trimStart()
    return [...[before, wrapped, after].filter(Boolean)].join("\n\n") + "\n"
  }

  for (const legacyMarker of PI_AGENTS_LEGACY_MARKERS) {
    const markerIdx = existing.indexOf(legacyMarker)
    if (markerIdx !== -1) {
      const before = existing.slice(0, markerIdx).trimEnd()
      return [...[before, wrapped].filter(Boolean)].join("\n\n") + "\n"
    }
  }

  return [...[existing.trimEnd(), wrapped].filter(Boolean)].join("\n\n") + "\n"
}

function removePiAgentsSection(existing: string): string {
  const section = findPiAgentsSection(existing)

  if (section) {
    const before = existing.slice(0, section.beginIdx).trimEnd()
    const after = existing.slice(section.endIdx + section.endLength).trimStart()
    return [...[before, after].filter(Boolean)].join("\n\n").trim()
  }

  for (const legacyMarker of PI_AGENTS_LEGACY_MARKERS) {
    const markerIdx = existing.indexOf(legacyMarker)
    if (markerIdx !== -1) {
      return existing.slice(0, markerIdx).trim()
    }
  }

  return existing.trim()
}

const FEATURES: FeatureConfig[] = [
  {
    id: "memsearch",
    name: "memsearch long memory",
    hint: "local ONNX embeddings, markdown storage, cross-session recall",
    install: async () => {
      if (commandExists("python3")) {
        const result = Bun.spawnSync(["python3", "-m", "pip", "install", "--user", "memsearch[onnx]", "--quiet"], {
          stdout: "pipe",
          stderr: "pipe",
        })
        if (result.exitCode === 0) {
          // Try to init config (may fail if ~/.local/bin not on PATH yet)
          if (commandExists("memsearch")) {
            Bun.spawnSync(["memsearch", "config", "init", "--non-interactive"], { stdout: "pipe", stderr: "pipe" })
          }
          return "memsearch[onnx] installed"
        }
        return "memsearch install failed"
      }
      return "python3 not found — install manually: python3 -m pip install --user memsearch[onnx]"
    },
    uninstall: async () => {
      if (commandExists("python3")) {
        Bun.spawnSync(["python3", "-m", "pip", "uninstall", "-y", "memsearch"], { stdout: "pipe", stderr: "pipe" })
      }
    },
  },
  {
    id: "br",
    name: "Beads Rust (br)",
    hint: "classic beads-compatible Rust task CLI",
    install: async () => {
      if (skipThirdPartyFeatures()) return thirdPartySkipMessage()
      const installUrl = beadsRustInstallUrl()
      if (!commandExists("curl")) {
        return `curl not found — install manually: curl -fsSL ${installUrl} | bash -s -- --skip-skills`
      }
      const result = Bun.spawnSync([
        "bash",
        "-lc",
        `curl -fsSL ${shellQuote(installUrl)} | bash -s -- --skip-skills --quiet --no-gum`,
      ], { stdout: "pipe", stderr: "pipe" })
      return result.exitCode === 0
        ? "br installed"
        : `br install failed — try: curl -fsSL ${installUrl} | bash -s -- --skip-skills`
    },
    uninstall: async () => {
      await unlink(join(homedir(), ".local", "bin", "br")).catch(() => {})
      await unlink(join(homedir(), ".local", "bin", "br.exe")).catch(() => {})
    },
  },
  {
    id: "bv",
    name: "Beads Viewer (bv)",
    hint: "graph-aware Beads TUI and robot-mode triage sidecar",
    install: async () => {
      if (skipThirdPartyFeatures()) return thirdPartySkipMessage()
      const installUrl = beadsViewerInstallUrl()
      if (!commandExists("curl")) {
        return `curl not found — install manually: curl -fsSL ${installUrl} | bash`
      }
      const result = Bun.spawnSync([
        "bash",
        "-lc",
        `curl -fsSL ${shellQuote(installUrl)} | bash`,
      ], { stdout: "pipe", stderr: "pipe" })
      return result.exitCode === 0
        ? "bv installed"
        : `bv install failed — try: curl -fsSL ${installUrl} | bash`
    },
    uninstall: async () => {
      await unlink(join(homedir(), ".local", "bin", "bv")).catch(() => {})
      await unlink(join(homedir(), ".local", "bin", "bv.exe")).catch(() => {})
    },
  },
  {
    id: "graphify",
    name: "graphify knowledge graph",
    hint: "code/docs/media knowledge graph skill and CLI",
    install: async (hosts) => {
      if (skipThirdPartyFeatures()) return thirdPartySkipMessage()
      const targets = graphifyTargetsForHosts(hosts)
      if (targets.length === 0) return `skipped (${GRAPHIFY_SUPPORTED_HOSTS} not selected)`
      if (!commandExists("python3")) {
        return `python3 not found — install manually: python3 -m pip install --user graphifyy && ${graphifyCommand(targets[0].args)}`
      }
      const packageResult = Bun.spawnSync(["python3", "-m", "pip", "install", "--user", "graphifyy", "--quiet"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      if (packageResult.exitCode !== 0) {
        return "graphify package install failed — try: python3 -m pip install --user graphifyy"
      }

      const installed: string[] = []
      const failed: string[] = []
      for (const target of targets) {
        const result = Bun.spawnSync([
          "bash",
          "-lc",
          `PATH="$HOME/.local/bin:$PATH" ${target.args.map(shellQuote).join(" ")}`,
        ], { stdout: "pipe", stderr: "pipe" })
        if (result.exitCode !== 0) {
          failed.push(`${target.label} (exit ${result.exitCode}; try: ${graphifyCommand(target.args)})`)
          continue
        }
        installed.push(target.label)
      }

      if (failed.length > 0) {
        return installed.length > 0
          ? `graphify installed for ${installed.join(", ")}; could not install for ${failed.join(", ")}`
          : `graphify install failed for ${failed.join(", ")}`
      }
      return `graphify installed for ${installed.join(", ")}`
    },
    uninstall: async () => {
      if (commandExists("python3")) {
        Bun.spawnSync(["python3", "-m", "pip", "uninstall", "-y", "graphifyy"], { stdout: "pipe", stderr: "pipe" })
      }
    },
  },
  {
    id: "claude-mem",
    name: "Claude-Mem",
    hint: "persistent memory plugin for Claude Code, OpenCode, and Gemini CLI",
    install: async (hosts) => {
      if (skipThirdPartyFeatures()) return thirdPartySkipMessage()

      const targets: Array<{ label: string, args: string[] }> = []
      if (hosts.includes("claude")) targets.push({ label: "Claude Code", args: ["npx", "--yes", "claude-mem", "install"] })
      if (hosts.includes("opencode")) targets.push({ label: "OpenCode", args: ["npx", "--yes", "claude-mem", "install", "--ide", "opencode"] })
      if (hosts.includes("gemini")) targets.push({ label: "Gemini CLI", args: ["npx", "--yes", "claude-mem", "install", "--ide", "gemini-cli"] })

      if (targets.length === 0) return "skipped (Claude Code, OpenCode, or Gemini CLI not selected)"
      if (!commandExists("npx")) return "npx not found — install manually: npx --yes claude-mem install"

      const installed: string[] = []
      const failed: string[] = []
      for (const target of targets) {
        const result = Bun.spawnSync(target.args, { stdout: "pipe", stderr: "pipe" })
        if (result.exitCode !== 0) {
          failed.push(`${target.label} (exit ${result.exitCode}; try: ${target.args.join(" ")})`)
          continue
        }
        installed.push(target.label)
      }
      if (failed.length > 0) {
        return installed.length > 0
          ? `claude-mem installed for ${installed.join(", ")}; could not install for ${failed.join(", ")}`
          : `claude-mem install failed for ${failed.join(", ")}`
      }
      return `claude-mem installed for ${installed.join(", ")}`
    },
    uninstall: async () => {
      if (!commandExists("npx")) {
        p.log.warn("npx not found — skipping claude-mem uninstall")
        return
      }
      const result = Bun.spawnSync(["npx", "--yes", "claude-mem", "uninstall"], { stdout: "pipe", stderr: "pipe" })
      if (result.exitCode !== 0) {
        p.log.warn("claude-mem uninstall failed — try: npx --yes claude-mem uninstall")
      }
    },
  },
  {
    id: "supermemory",
    name: "supermemory (cloud)",
    hint: "cloud-hosted memory by supermemory.ai — requires API key (free tier available)",
    install: async (hosts) => {
      if (!hosts.includes("opencode")) return "skipped (OpenCode not selected)"
      if (!commandExists("bun")) return "skipped (bun not found)"

      // Install the npm plugin
      const result = Bun.spawnSync(["bunx", "opencode-supermemory@latest", "install", "--no-tui"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      if (result.exitCode === 0) {
        return "supermemory plugin installed — run /supermemory-login in OpenCode to authenticate"
      }
      return "supermemory install failed — try: bunx opencode-supermemory@latest install"
    },
    uninstall: async () => {
      // Remove plugin from opencode.jsonc
      const configPaths = [
        join(xdgConfig(), "opencode", "opencode.jsonc"),
        join(xdgConfig(), "opencode", "opencode.json"),
      ]
      for (const configPath of configPaths) {
        if (!existsSync(configPath)) continue
        try {
          const raw = await readFile(configPath, "utf8")
          // Remove the supermemory plugin entry via line-level filtering
          // to avoid breaking JSONC (trailing commas, comments)
          const lines = raw.split("\n")
          const filtered = lines.filter((line) => !line.includes("opencode-supermemory"))
          const cleaned = filtered.join("\n").replace(/,(\s*[\]\}])/g, "$1") // fix trailing commas
          await writeFile(configPath, cleaned, "utf8")
        } catch { /* skip */ }
      }
      // Remove credentials
      await rm(join(homedir(), ".supermemory-opencode"), { recursive: true, force: true }).catch(() => {})
      // Remove commands
      const cmdDir = join(xdgConfig(), "opencode", "commands")
      for (const cmd of ["supermemory-init.md", "supermemory-login.md", "supermemory-logout.md"]) {
        await unlink(join(cmdDir, cmd)).catch(() => {})
      }
    },
  },
  {
    id: "statusline",
    name: "Status line",
    hint: "shows active agent + model in Claude Code bottom bar",
    install: async (hosts) => {
      if (!hosts.includes("claude")) return "skipped (Claude Code not selected)"
      const home = join(homedir(), ".claude")
      const scriptPath = join(home, "xpowers-statusline.sh")
      const settingsPath = join(home, "settings.json")

      try {
        let settings: Record<string, unknown> = {}
        if (existsSync(settingsPath)) {
          settings = JSON.parse(await readFile(settingsPath, "utf8"))
        }
        if (!settings.statusline) {
          settings.statusline = scriptPath
          await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8")
        }
      } catch { /* skip if settings.json is invalid */ }
      return "status line configured"
    },
    uninstall: async () => {
      const settingsPath = join(homedir(), ".claude", "settings.json")
      if (existsSync(settingsPath)) {
        try {
          const settings = JSON.parse(await readFile(settingsPath, "utf8"))
          const statusline = typeof settings.statusline === "string" ? settings.statusline : ""
          if (statusline.includes("xpowers") || statusline.includes(legacyNs())) {
            delete settings.statusline
            await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8")
          }
        } catch { /* skip */ }
      }
    },
  },
  {
    id: "routing-wizard",
    name: "Agent routing wizard",
    hint: "configure models + effort per agent (OpenCode)",
    install: async (hosts, repoRoot) => {
      if (!hosts.includes("opencode")) return "skipped (OpenCode not selected)"
      if (!commandExists("bun")) return "skipped (bun not found)"
      const wizardPath = join(repoRoot, "scripts", "opencode-routing-wizard.ts")
      if (existsSync(wizardPath)) {
        // Skip interactive wizard in non-TTY / --yes mode
        if (!process.stdin.isTTY) {
          return "skipped (non-interactive mode — run wizard manually later)"
        }
        const result = Bun.spawnSync(["bun", wizardPath], { stdout: "inherit", stderr: "inherit", stdin: "inherit" })
        return result.exitCode === 0 ? "routing wizard completed" : "routing wizard failed"
      }
      return "wizard script not found"
    },
    uninstall: async () => { /* no-op, routing config is user data */ },
  },
  {
    id: "tm-cli",
    name: "tm CLI",
    hint: "task manager wrapper for beads",
    install: async () => {
      const binDir = join(homedir(), ".local", "bin")
      const libDir = join(homedir(), ".local", "lib", "tm")
      await mkdir(binDir, { recursive: true })
      await mkdir(libDir, { recursive: true })

      const tmSrc = join(REPO_ROOT, "scripts", "tm")
      if (existsSync(tmSrc)) {
        await copyFile(tmSrc, join(binDir, "tm"))
        await chmod(join(binDir, "tm"), 0o755)

        // Copy companion files
        for (const name of ["tm-backends.sh", "tm-linear-backend.js", "tm-linear-sync.js", "tm-linear-sync-config.js"]) {
          const src = join(REPO_ROOT, "scripts", name)
          if (existsSync(src)) {
            await copyFile(src, join(libDir, name))
            await symlink(join(libDir, name), join(binDir, name)).catch(() => {})
          }
        }
        // Install @linear/sdk for Linear sync support
        if (commandExists("npm")) {
          const npmResult = Bun.spawnSync(["npm", "install", "--prefix", libDir, "@linear/sdk", "--save", "--silent"], { stdout: "pipe", stderr: "pipe" })
          throwOnSpawnFailure(npmResult, "tm CLI dependency install failed")
        }
        return "tm CLI installed to ~/.local/bin/"
      }
      return "tm script not found"
    },
    uninstall: async () => {
      const binDir = join(homedir(), ".local", "bin")
      const libDir = join(homedir(), ".local", "lib", "tm")
      for (const f of ["tm", "tm-backends.sh", "tm-linear-backend.js", "tm-linear-sync.js", "tm-linear-sync-config.js"]) {
        await unlink(join(binDir, f)).catch(() => {})
      }
      await rm(libDir, { recursive: true, force: true }).catch(() => {})
    },
  },
]

// ---------------------------------------------------------------------------
// Core Install Engine
// ---------------------------------------------------------------------------

const installHost = async (host: HostConfig): Promise<string[]> => {
  const target = host.targetDir()
  const installedFiles: string[] = []
  const backupEntries: Array<{ originalPath: string, backupPath: string }> = []
  const createdPaths: string[] = []
  const piExtensionDir = join(target, "extensions", "xpowers")
  const piExtensionExistedBeforeInstall = host.id === "pi" && existsSync(piExtensionDir)
  const piAgentsPath = host.id === "pi" ? join(target, "AGENTS.md") : null
  const piAgentsExistedBeforeInstall = piAgentsPath ? existsSync(piAgentsPath) : false
  const piAgentsOriginalContent = piAgentsPath && piAgentsExistedBeforeInstall ? readFileSync(piAgentsPath, "utf8") : null

  try {
    for (const [category, source] of Object.entries(host.sources)) {
      const srcDir = join(REPO_ROOT, source.from)
      if (!existsSync(srcDir)) continue

      const items = await listItems(srcDir, source.pattern, source.exclude)
      const destDir = join(target, category)
      await mkdir(destDir, { recursive: true })

      for (const item of items) {
        const srcPath = join(srcDir, item)
        const destPath = join(destDir, item)
        const backupPath = existsSync(destPath)
          ? `${destPath}.xpowers-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          : null

        if (backupPath) {
          await rename(destPath, backupPath)
          backupEntries.push({ originalPath: destPath, backupPath })
        }

        const s = await stat(srcPath)
        if (s.isDirectory()) {
          await copyDir(srcPath, destPath)
          installedFiles.push(`${category}/${item}/`)
        } else {
          await copyFile(srcPath, destPath)
          installedFiles.push(`${category}/${item}`)
        }
        createdPaths.push(destPath)
      }
    }

    // Run post-install and track additional files (before writing version marker)
    if (host.postInstall) {
      await host.postInstall(target)
      // Re-scan for files that postInstall may have added
      if (host.id === "opencode") {
        for (const f of ["package.json", "task-context.json", "cass-memory.json"]) {
          if (existsSync(join(target, f))) installedFiles.push(f)
        }
      }
      if (host.id === "claude") {
        if (existsSync(join(target, "xpowers-statusline.sh"))) installedFiles.push("xpowers-statusline.sh")
      }
      if (host.id === "kimi") {
        for (const f of ["xpowers.yaml", "xpowers-system.md", "mcp.json"]) {
          if (existsSync(join(target, f))) installedFiles.push(f)
        }
      }
      // Pi: AGENTS.md and skills/ are NOT tracked in manifest because postUninstall
      // handles them surgically (removes only XPowers section from AGENTS.md,
      // removes entire extensions/xpowers/ dir). Tracking them would cause
      // uninstallHost to delete the whole AGENTS.md before postUninstall runs.
    }

    // Write version file last (after postInstall succeeds)
    await writeFile(join(target, ".xpowers-version"), VERSION + "\n", "utf8")
    installedFiles.push(".xpowers-version")

    for (const { backupPath } of backupEntries.reverse()) {
      await rm(backupPath, { recursive: true, force: true }).catch(() => {})
    }

    return installedFiles
  } catch (error) {
    for (const createdPath of createdPaths.reverse()) {
      await rm(createdPath, { recursive: true, force: true }).catch(() => {})
    }
    for (const { originalPath, backupPath } of backupEntries.reverse()) {
      if (existsSync(backupPath)) {
        await rename(backupPath, originalPath).catch(() => {})
      }
    }
    if (host.id === "pi") {
      if (piAgentsExistedBeforeInstall && piAgentsPath) {
        await writeFile(piAgentsPath, piAgentsOriginalContent ?? "", "utf8").catch(() => {})
      } else if (piAgentsPath) {
        await rm(piAgentsPath, { force: true }).catch(() => {})
      }
    }
    if (host.id === "pi" && !piExtensionExistedBeforeInstall) {
      await rm(piExtensionDir, { recursive: true, force: true }).catch(() => {})
    }
    throw error
  }
}

const uninstallHost = async (hostId: string, manifest: InstallManifest) => {
  const hostData = manifest.hosts[hostId]
  if (!hostData) return

  // Clean generated artifacts not in manifest
  if (hostId === "opencode") {
    await rm(join(hostData.targetDir, "node_modules"), { recursive: true, force: true }).catch(() => {})
    await unlink(join(hostData.targetDir, "bun.lock")).catch(() => {})
  }

  for (const file of hostData.files) {
    const fullPath = join(hostData.targetDir, file)
    if (file.endsWith("/")) {
      await rm(fullPath, { recursive: true, force: true }).catch(() => {})
    } else {
      await unlink(fullPath).catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const readManifest = async (): Promise<InstallManifest | null> => {
  for (const path of [manifestPath(), legacyManifestPath()]) {
    if (!existsSync(path)) continue
    try {
      return JSON.parse(await readFile(path, "utf8"))
    } catch {
      return null
    }
  }
  return null
}

const writeManifest = async (manifest: InstallManifest) => {
  const path = manifestPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n", "utf8")
}

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

type CliArgs = {
  yes: boolean
  uninstall: boolean
  json: boolean
  hosts: string[]
  features: string[]
  help: boolean
  allowConflicts: boolean
}

const parseArgs = (): CliArgs => {
  const args: CliArgs = { yes: false, uninstall: false, json: false, hosts: [], features: [], help: false, allowConflicts: false }
  const argv = process.argv.slice(2)

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--yes":
      case "-y":
        args.yes = true
        break
      case "--uninstall":
      case "--remove":
        args.uninstall = true
        break
      case "--json":
      case "-j":
        args.json = true
        args.yes = true // JSON implies non-interactive
        break
      case "--hosts":
        args.hosts = (argv[++i] || "").split(",").filter(Boolean)
        break
      case "--features":
        args.features = (argv[++i] || "").split(",").filter(Boolean)
        break
      case "--allow-conflicts":
        args.allowConflicts = true
        break
      case "--help":
      case "-h":
        args.help = true
        break
    }
  }
  return args
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async () => {
  const args = parseArgs()

  // In JSON mode, redirect all non-JSON output to stderr
  if (args.json) {
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: any, ...rest: any[]) => {
      // Only let through raw JSON lines (our explicit console.log at the end)
      if (typeof chunk === "string" && chunk.startsWith("{")) return origWrite(chunk, ...rest)
      return process.stderr.write(chunk, ...rest)
    }
  }

  if (args.help) {
    console.log(`XPowers Installer v${VERSION}

Usage:
  bun scripts/install.ts              # Interactive TUI installer
  bun scripts/install.ts --yes        # Install all detected hosts + all features
  bun scripts/install.ts --uninstall  # Remove everything
  bun scripts/install.ts --hosts claude,opencode --features memsearch,tm-cli
  bun scripts/install.ts --yes --json    # Agent-friendly JSON output

Options:
  --yes, -y          Auto-install all detected hosts and features
  --json, -j         Output structured JSON (implies --yes, for AI agents)
  --uninstall        Remove all installed files and features
  --hosts <list>     Comma-separated host IDs: claude,opencode,kimi,gemini,pi
  --features <list>  Comma-separated feature IDs: memsearch,br,bv,graphify,claude-mem,supermemory,statusline,routing-wizard,tm-cli
  --allow-conflicts  Advanced: continue despite detected hyperpowers/myhyperpowers/superpowers installs
  --help, -h         Show this help
`)
    return
  }

  // --- Uninstall ---
  if (args.uninstall) {
    p.intro("XPowers Uninstaller")

    const manifest = await readManifest()
    if (!manifest) {
      p.log.warn("No new-format manifest found. Checking for legacy install...")
      // Fall back to old install.sh if available
      const legacyScript = join(REPO_ROOT, "scripts", "install.sh")
      if (existsSync(legacyScript)) {
        p.log.info("Running legacy uninstall via install.sh --uninstall --yes")
        const legacyResult = Bun.spawnSync(["bash", legacyScript, "--uninstall", "--yes"], { stdout: "inherit", stderr: "inherit" })
        if (legacyResult.exitCode === 0) {
          p.outro("Legacy uninstall completed.")
        } else {
          p.log.error(`Legacy uninstall failed (exit code ${legacyResult.exitCode})`)
          p.outro("Partial uninstall — check output above for errors.")
          process.exit(1)
        }
      } else {
        p.log.error("No manifest found and no legacy installer available.")
        p.outro("Nothing to uninstall.")
      }
      return
    }

    p.log.info(`Found installation v${manifest.version} from ${manifest.installedAt}`)

    const s = p.spinner()

    // Uninstall features
    for (const feature of FEATURES) {
      if (manifest.features[feature.id]?.installed) {
        s.start(`Removing ${feature.name}...`)
        await feature.uninstall(manifest)
        s.stop(`${feature.name} removed`)
      }
    }

    // Uninstall hosts
    for (const hostId of Object.keys(manifest.hosts)) {
      s.start(`Removing from ${hostId}...`)
      await uninstallHost(hostId, manifest)
      const host = HOSTS.find((h) => h.id === hostId)
      if (host?.postUninstall) await host.postUninstall(manifest.hosts[hostId].targetDir)
      s.stop(`${hostId} removed`)
    }

    // Remove manifest, including legacy manifest if this was a migration uninstall
    await unlink(manifestPath()).catch(() => {})
    await unlink(legacyManifestPath()).catch(() => {})

    p.outro("XPowers uninstalled completely.")
    return
  }

  // --- Install ---
  p.intro(`XPowers Installer v${VERSION}`)

  // Phase 1: Detect hosts
  const detected = HOSTS.filter((h) => h.detect())
  const notDetected = HOSTS.filter((h) => !h.detect())

  for (const h of detected) p.log.success(`${h.name} detected`)
  for (const h of notDetected) p.log.warn(`${h.name} not found`)

  if (detected.length === 0 && args.hosts.length === 0 && args.features.length === 0) {
    p.log.error("No supported hosts detected. Install Claude Code, OpenCode, or another supported tool first.")
    p.log.info("You can still install host-independent features: bun scripts/install.ts --features tm-cli,br,bv")
    p.outro("Nothing to install.")
    return
  }

  const conflicts = detectConflictingInstalls()
  if (conflicts.length > 0 && !args.allowConflicts) {
    const message = formatConflictMessage(conflicts)
    const nonInteractive = args.yes || args.json || process.env.CI === "true" || !process.stdin.isTTY
    if (args.json) {
      console.log(JSON.stringify({
        ok: false,
        version: VERSION,
        error: message,
        conflicts: conflicts.map((conflict) => ({ name: conflict.name, path: conflict.path })),
      }))
      process.exit(1)
    }
    if (nonInteractive) {
      p.log.error(message)
      process.exit(1)
    }

    p.log.warn(message)
    const continueAnyway = await p.confirm({
      message: "Continue installing XPowers despite these conflicting installs?",
      initialValue: false,
    })
    if (p.isCancel(continueAnyway) || continueAnyway !== true) {
      p.cancel("Cancelled. Remove the conflicting installs and rerun the installer.")
      return
    }
  }

  // Phase 2: Select hosts
  let selectedHostIds: string[]

  if (args.yes || args.hosts.length > 0) {
    selectedHostIds = args.hosts.length > 0 ? args.hosts : detected.map((h) => h.id)
  } else {
    const result = await p.multiselect({
      message: "Install to which hosts?",
      options: detected.map((h) => ({ value: h.id, label: h.name, hint: h.targetDir() })),
      initialValues: detected.map((h) => h.id),
      required: true,
    })
    if (p.isCancel(result)) { p.cancel("Cancelled."); return }
    selectedHostIds = result as string[]
  }

  // Phase 3: Select features
  const availableFeatures = FEATURES.filter((f) =>
    HOST_INDEPENDENT_FEATURES.has(f.id) || selectedHostIds.some((hid) => HOSTS.find((h) => h.id === hid)?.availableFeatures.includes(f.id)),
  )

  let selectedFeatureIds: string[]

  if (args.yes || args.features.length > 0) {
    selectedFeatureIds = args.features.length > 0 ? args.features : availableFeatures.map((f) => f.id)
  } else {
    if (availableFeatures.length > 0) {
      const result = await p.multiselect({
        message: "Select optional features:",
        options: availableFeatures.map((f) => ({ value: f.id, label: f.name, hint: f.hint })),
        initialValues: availableFeatures.map((f) => f.id),
        required: false,
      })
      if (p.isCancel(result)) { p.cancel("Cancelled."); return }
      selectedFeatureIds = result as string[]
    } else {
      selectedFeatureIds = []
    }
  }

  // Phase 4: Install hosts
  const s = p.spinner()
  const existingManifest = await readManifest()
  const manifest: InstallManifest = {
    version: VERSION,
    installedAt: new Date().toISOString(),
    hosts: { ...(existingManifest?.hosts ?? {}) },
    features: { ...(existingManifest?.features ?? {}) },
  }

  let hostInstallFailed = false
  const successfulHostIds: string[] = []

  for (const hostId of selectedHostIds) {
    const host = HOSTS.find((h) => h.id === hostId)
    if (!host) {
      p.log.warn(`Unknown host "${hostId}" — skipping. Supported: ${HOSTS.map((h) => h.id).join(", ")}`)
      hostInstallFailed = true
      continue
    }

    s.start(`Installing to ${host.name}...`)
    try {
      const files = await installHost(host)
      manifest.hosts[hostId] = { targetDir: host.targetDir(), files }
      successfulHostIds.push(hostId)
      s.stop(`${host.name}: ${files.length} items installed`)
    } catch (err) {
      hostInstallFailed = true
      s.stop(`${host.name}: install failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Phase 5: Install features
  const featuresWereExplicitlyRequested = args.features.length > 0
  const shouldInstallFeatures = featuresWereExplicitlyRequested || successfulHostIds.length > 0
  const featureHostIds = featuresWereExplicitlyRequested ? selectedHostIds : successfulHostIds
  const featureResults: Record<string, boolean> = {}

  if (!shouldInstallFeatures && selectedFeatureIds.length > 0) {
    p.log.warn("Skipping default feature setup because no selected hosts installed successfully.")
    for (const featureId of selectedFeatureIds) featureResults[featureId] = false
  }

  const selectedThirdPartyFeatureIds = selectedFeatureIds.filter((id) => THIRD_PARTY_FEATURES.has(id))
  if (shouldInstallFeatures && selectedThirdPartyFeatureIds.length > 0 && !skipThirdPartyFeatures() && !args.json) {
    p.log.warn(`Third-party features run upstream installers/packages: ${selectedThirdPartyFeatureIds.join(", ")}`)
  }

  for (const featureId of shouldInstallFeatures ? selectedFeatureIds : []) {
    const feature = FEATURES.find((f) => f.id === featureId)
    if (!feature) {
      p.log.warn(`Unknown feature "${featureId}" — skipping. Supported: ${FEATURES.map((f) => f.id).join(", ")}`)
      featureResults[featureId] = false
      continue
    }

    s.start(`Setting up ${feature.name}...`)
    const result = await feature.install(featureHostIds, REPO_ROOT)
    const success = !result.includes("failed") && !result.includes("not found") && !result.includes("skipped")
    featureResults[featureId] = success
    const existingFeature = manifest.features[featureId]
    manifest.features[featureId] = {
      installed: success || existingFeature?.installed === true,
      metadata: { ...(existingFeature?.metadata ?? {}), lastResult: result },
    }
    s.stop(result)
  }

  // Phase 6: Write manifest
  await writeManifest(manifest)

  if (args.json) {
    // Structured JSON output for AI agents
    console.log(JSON.stringify({
      ok: !hostInstallFailed,
      version: VERSION,
      hosts: Object.keys(manifest.hosts),
      features: Object.fromEntries(
        Object.entries(manifest.features).map(([k, v]) => [k, v.installed]),
      ),
      featureResults,
      manifestPath: manifestPath(),
    }))
  } else {
    p.log.info(`Manifest written to ${manifestPath()}`)
    if (hostInstallFailed) {
      p.outro(`Completed with host install failures. v${VERSION} installed to ${Object.keys(manifest.hosts).length}/${selectedHostIds.length} host(s) with ${selectedFeatureIds.length} feature(s).`)
    } else {
      p.outro(`Done! v${VERSION} installed to ${selectedHostIds.length} host(s) with ${selectedFeatureIds.length} feature(s).`)
    }
  }

  if (hostInstallFailed) {
    process.exitCode = 1
  }
}

await main()
