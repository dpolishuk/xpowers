import type { Plugin } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, extname } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// XPowers Lint Gate Plugin
// Runs project-appropriate linters after write/edit tool calls.
// Shows toast notifications with lint results and optionally blocks on errors.
// Auto-detects linter from project files (package.json, pyproject.toml, etc.)
//
// Inspired by pre-commit hooks and CI lint gates.
// ─────────────────────────────────────────────────────────────────────────────

type LintGateConfig = {
  enabled?: boolean
  autoFix?: boolean              // run with --fix flag
  blockOnError?: boolean         // throw error if lint fails
  showWarnings?: boolean         // show warnings or just errors
  showStyleIssues?: boolean      // show style/formatting issues
  maxIssuesInToast?: number      // max issues to show per toast
  quietDurationMs?: number       // ms to suppress duplicate toasts
  linters?: Record<string, string>  // extension -> linter command override
  logDir?: string
}

type LinterConfig = {
  name: string
  command: string
  args: string[]
  fixArgs?: string[]
  checkCommand?: string  // alternative command to check availability
  parseOutput: (output: string, stderr: string) => LintIssue[]
}

type LintIssue = {
  severity: "error" | "warning" | "style"
  message: string
  line?: number
  column?: number
  rule?: string
}

type LintResult = {
  ok: boolean
  issues: LintIssue[]
  fixed: boolean
  command: string
}

type FileLinterMap = Record<string, LinterConfig>

const DEFAULT_CONFIG: Required<LintGateConfig> = {
  enabled: true,
  autoFix: false,
  blockOnError: false,
  showWarnings: true,
  showStyleIssues: false,
  maxIssuesInToast: 5,
  quietDurationMs: 5000,
  linters: {},
  logDir: ".opencode/cache/lint-gate",
}

// ── Config Loading ──────────────────────────────────────────────────────────

const loadConfig = async (directory: string): Promise<Required<LintGateConfig>> => {
  const configPath = join(directory, ".opencode", "lint-gate-config.json")
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG }

  try {
    const raw = await readFile(configPath, "utf8")
    const parsed = JSON.parse(raw) as LintGateConfig
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

// ── Linter Definitions ──────────────────────────────────────────────────────

const createESLintParser = (linterName: string): LinterConfig["parseOutput"] => {
  return (output: string, stderr: string) => {
    const issues: LintIssue[] = []
    const text = output || stderr

    // ESLint format: /path/to/file.ts
    //   42:5  error  Missing semicolon  semi
    //   43:1  warning  Unused variable  @typescript-eslint/no-unused-vars
    const lines = text.split("\n")
    let currentFile = ""

    for (const line of lines) {
      const fileMatch = line.match(/^\s*(\S+\.(?:ts|tsx|js|jsx|mjs|cjs))\s*$/)
      if (fileMatch) {
        currentFile = fileMatch[1]
        continue
      }

      const issueMatch = line.match(
        /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+([\w@/-]+)\s*$/,
      )
      if (issueMatch) {
        issues.push({
          line: parseInt(issueMatch[1], 10),
          column: parseInt(issueMatch[2], 10),
          severity: issueMatch[3] as "error" | "warning",
          message: issueMatch[4].trim(),
          rule: issueMatch[5].trim(),
        })
      }
    }

    return issues
  }
}

const createPrettierParser = (): LinterConfig["parseOutput"] => {
  return (output: string, stderr: string) => {
    const issues: LintIssue[] = []
    const text = output || stderr

    // Prettier --check: [warn] src/file.ts
    // Prettier --check with diff-like output
    const lines = text.split("\n")
    for (const line of lines) {
      if (line.includes("[warn]") || line.includes("Code style issues")) {
        const fileMatch = line.match(/\[warn\]\s+(.+)/) || line.match(/in\s+(.+?)!/)
        if (fileMatch) {
          issues.push({
            severity: "style",
            message: `Formatting issues in ${fileMatch[1]}`,
          })
        }
      }
    }

    return issues
  }
}

const createFlake8Parser = (): LinterConfig["parseOutput"] => {
  return (output: string) => {
    const issues: LintIssue[] = []
    // flake8: file.py:42:5: E501 line too long
    const lines = output.split("\n")
    for (const line of lines) {
      const match = line.match(/^(.+?):(\d+):(\d+):\s*(\w\d+)\s+(.+)/)
      if (match) {
        const code = match[4]
        const severity = code.startsWith("E") || code.startsWith("F") ? "error" : "warning"
        issues.push({
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          severity,
          message: match[5].trim(),
          rule: code,
        })
      }
    }
    return issues
  }
}

const createRustfmtParser = (): LinterConfig["parseOutput"] => {
  return (output: string, stderr: string) => {
    const issues: LintIssue[] = []
    const text = output || stderr
    if (text.includes("Diff") || text.includes("left:")) {
      issues.push({ severity: "style", message: "Formatting issues detected" })
    }
    if (text.includes("error")) {
      const lines = text.split("\n")
      for (const line of lines) {
        const match = line.match(/error:\s*(.+)/)
        if (match) {
          issues.push({ severity: "error", message: match[1] })
        }
      }
    }
    return issues
  }
}

const createGofmtParser = (): LinterConfig["parseOutput"] => {
  return (output: string) => {
    const issues: LintIssue[] = []
    if (output.trim()) {
      issues.push({ severity: "style", message: "Go formatting issues" })
    }
    return issues
  }
}

const createShellCheckParser = (): LinterConfig["parseOutput"] => {
  return (output: string) => {
    const issues: LintIssue[] = []
    // shellcheck: file.sh:42:5: warning: SC2086: Double quote...
    const lines = output.split("\n")
    for (const line of lines) {
      const match = line.match(/^(.+?):(\d+):(\d+):\s*(\w+):\s*(\w+):\s*(.+)/)
      if (match) {
        const rawSeverity = match[4].toLowerCase()
        // ShellCheck emits: error, warning, info, style
        const severity: LintIssue["severity"] =
          rawSeverity === "error" ? "error" :
          rawSeverity === "warning" ? "warning" : "style"
        issues.push({
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          severity,
          rule: match[5],
          message: match[6].trim(),
        })
      }
    }
    return issues
  }
}

// ── Linter Registry ─────────────────────────────────────────────────────────

const LINTER_REGISTRY: FileLinterMap = {
  ".ts": {
    name: "eslint",
    command: "eslint",
    args: [],
    fixArgs: ["--fix"],
    parseOutput: createESLintParser("eslint"),
  },
  ".tsx": {
    name: "eslint",
    command: "eslint",
    args: [],
    fixArgs: ["--fix"],
    parseOutput: createESLintParser("eslint"),
  },
  ".js": {
    name: "eslint",
    command: "eslint",
    args: [],
    fixArgs: ["--fix"],
    parseOutput: createESLintParser("eslint"),
  },
  ".jsx": {
    name: "eslint",
    command: "eslint",
    args: [],
    fixArgs: ["--fix"],
    parseOutput: createESLintParser("eslint"),
  },
  ".mjs": {
    name: "eslint",
    command: "eslint",
    args: [],
    fixArgs: ["--fix"],
    parseOutput: createESLintParser("eslint"),
  },
  ".cjs": {
    name: "eslint",
    command: "eslint",
    args: [],
    fixArgs: ["--fix"],
    parseOutput: createESLintParser("eslint"),
  },
  ".py": {
    name: "flake8",
    command: "flake8",
    args: [],
    parseOutput: createFlake8Parser(),
  },
  ".rs": {
    name: "rustfmt",
    command: "rustfmt",
    args: ["--check"],
    fixArgs: ["--emit", "files"],
    parseOutput: createRustfmtParser(),
  },
  ".go": {
    name: "gofmt",
    command: "gofmt",
    args: ["-l"],
    parseOutput: createGofmtParser(),
  },
  ".sh": {
    name: "shellcheck",
    command: "shellcheck",
    args: ["-f", "gcc"],
    parseOutput: createShellCheckParser(),
  },
  ".bash": {
    name: "shellcheck",
    command: "shellcheck",
    args: ["-f", "gcc"],
    parseOutput: createShellCheckParser(),
  },
}

// ── Linter Detection ────────────────────────────────────────────────────────

const detectProjectLinter = async (
  $: any,
  directory: string,
  filePath: string,
): Promise<LinterConfig | null> => {
  const ext = extname(filePath).toLowerCase()

  // Check user override first
  // (Handled in main logic)

  // Check if there's a project-specific linter config
  const hasESLintConfig =
    existsSync(join(directory, ".eslintrc.js")) ||
    existsSync(join(directory, ".eslintrc.json")) ||
    existsSync(join(directory, ".eslintrc.yml")) ||
    existsSync(join(directory, ".eslintrc.yaml")) ||
    existsSync(join(directory, ".eslintrc")) ||
    existsSync(join(directory, "eslint.config.js")) ||
    existsSync(join(directory, "eslint.config.mjs"))

  const hasPrettierConfig =
    existsSync(join(directory, ".prettierrc")) ||
    existsSync(join(directory, ".prettierrc.json")) ||
    existsSync(join(directory, "prettier.config.js"))

  const hasFlake8Config =
    existsSync(join(directory, ".flake8")) ||
    existsSync(join(directory, "setup.cfg"))

  const hasPyprojectToml = existsSync(join(directory, "pyproject.toml"))

  // Determine which linter to use based on file extension and project config
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
    if (hasESLintConfig) {
      // Check if eslint is available
      const check = await $`which eslint`.quiet().nothrow()
      if (check.exitCode === 0) {
        return LINTER_REGISTRY[ext] ?? null
      }
    }
    if (hasPrettierConfig) {
      const check = await $`which prettier`.quiet().nothrow()
      if (check.exitCode === 0) {
        return {
          name: "prettier",
          command: "prettier",
          args: ["--check"],
          fixArgs: ["--write"],
          parseOutput: createPrettierParser(),
        }
      }
    }
  }

  if (ext === ".py") {
    if (hasFlake8Config || hasPyprojectToml) {
      const check = await $`which flake8`.quiet().nothrow()
      if (check.exitCode === 0) {
        return LINTER_REGISTRY[ext] ?? null
      }
    }
    // Fallback to black check
    const check = await $`which black`.quiet().nothrow()
    if (check.exitCode === 0) {
      return {
        name: "black",
        command: "black",
        args: ["--check"],
        fixArgs: ["--quiet"],
        parseOutput: (output: string) => {
          if (output.includes("would reformat")) {
            return [{ severity: "style", message: "Would reformat" }]
          }
          return []
        },
      }
    }
  }

  if (ext === ".rs") {
    const check = await $`which rustfmt`.quiet().nothrow()
    if (check.exitCode === 0) {
      return LINTER_REGISTRY[ext] ?? null
    }
  }

  if (ext === ".go") {
    const check = await $`which gofmt`.quiet().nothrow()
    if (check.exitCode === 0) {
      return LINTER_REGISTRY[ext] ?? null
    }
  }

  if (ext === ".sh" || ext === ".bash") {
    const check = await $`which shellcheck`.quiet().nothrow()
    if (check.exitCode === 0) {
      return LINTER_REGISTRY[ext] ?? null
    }
  }

  return null
}

// ── Lint Execution ──────────────────────────────────────────────────────────

const runLinter = async (
  $: any,
  linter: LinterConfig,
  filePath: string,
  autoFix: boolean,
): Promise<LintResult> => {
  try {
    // When auto-fixing, use fix-mode args instead of check-mode args.
    // Some linters (black, rustfmt) use check-only base args (--check)
    // that prevent fixes when combined with fix args.
    const args = autoFix && linter.fixArgs
      ? [...linter.fixArgs, filePath]
      : [...linter.args, filePath]

    // Build command as array for Bun shell to safely pass each arg
    const cmdParts = [linter.command, ...args]
    const result = await $`${cmdParts}`.quiet().nothrow()
    const stdout = await result.text()
    // Bun shell returns stderr as a property on the result object
    const stderr = typeof result.stderr === "string" ? result.stderr : ""

    const issues = linter.parseOutput(stdout, stderr)

    // Determine if lint passed
    const hasErrors = issues.some((i) => i.severity === "error")
    const ok = result.exitCode === 0 && !hasErrors

    return {
      ok,
      issues,
      fixed: autoFix && result.exitCode === 0,
      command: `${linter.command} ${args.join(" ")}`,
    }
  } catch (err) {
    return {
      ok: false,
      issues: [{
        severity: "error",
        message: err instanceof Error ? err.message : "Linter execution failed",
      }],
      fixed: false,
      command: linter.command,
    }
  }
}

// ── Result Formatting ───────────────────────────────────────────────────────

const formatLintResult = (
  result: LintResult,
  fileName: string,
  config: Required<LintGateConfig>,
): { title: string; message: string; variant: "success" | "warning" | "error" } => {
  if (result.ok && result.issues.length === 0) {
    return {
      title: "✓ Lint",
      message: `${fileName}\n${result.command}`,
      variant: "success",
    }
  }

  const errors = result.issues.filter((i) => i.severity === "error")
  const warnings = result.issues.filter((i) => i.severity === "warning")
  const styles = result.issues.filter((i) => i.severity === "style")

  const parts: string[] = []

  if (errors.length > 0) {
    parts.push(`${errors.length} error(s)`)
  }
  if (warnings.length > 0 && config.showWarnings) {
    parts.push(`${warnings.length} warning(s)`)
  }
  if (styles.length > 0 && config.showStyleIssues) {
    parts.push(`${styles.length} style issue(s)`)
  }

  const summary = parts.join(", ") || `${result.issues.length} issue(s)`

  // Show top issues
  const issuesToShow = result.issues
    .filter((i) => config.showStyleIssues || i.severity !== "style")
    .filter((i) => config.showWarnings || i.severity !== "warning")
    .slice(0, config.maxIssuesInToast)

  const issueLines = issuesToShow.map((issue) => {
    const loc = issue.line ? `:${issue.line}${issue.column ? `:${issue.column}` : ""}` : ""
    const rule = issue.rule ? ` [${issue.rule}]` : ""
    const prefix = issue.severity === "error" ? "✗" : issue.severity === "warning" ? "⚠" : "·"
    return `${prefix} ${issue.message.slice(0, 60)}${loc}${rule}`
  })

  if (result.issues.length > issuesToShow.length) {
    issueLines.push(`+${result.issues.length - issuesToShow.length} more...`)
  }

  const message = [`${fileName} — ${summary}`, ...issueLines].join("\n")

  return {
    title: errors.length > 0 ? "✗ Lint Errors" : "⚠ Lint Issues",
    message,
    variant: errors.length > 0 ? "error" : "warning",
  }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const xpowersLintGatePlugin: Plugin = async (ctx) => {
  const config = await loadConfig(ctx.directory)

  if (!config.enabled) {
    return {}
  }

  // Cache linter detection results per extension to avoid repeated `which` calls
  const linterCache = new Map<string, LinterConfig | null>()

  // Track recent toasts to avoid spam
  const lastToastTime = new Map<string, number>()

  const shouldSuppress = (filePath: string): boolean => {
    const last = lastToastTime.get(filePath) ?? 0
    const now = Date.now()
    if (now - last < config.quietDurationMs) {
      return true
    }
    lastToastTime.set(filePath, now)
    return false
  }

  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "write" && input.tool !== "edit") return

      const args = output.args ?? {}
      const filePath = String(args.filePath ?? args.file_path ?? "")
      if (!filePath) return

      // Skip non-source files
      const ext = extname(filePath).toLowerCase()
      if (!ext || ext === ".md" || ext === ".txt" || ext === ".json" || ext === ".yaml" || ext === ".yml") {
        return
      }

      // Check user override for linter
      const userLinter = config.linters[ext]
      let linter: LinterConfig | null = null

      if (userLinter) {
        // User specified a custom linter command
        linter = {
          name: userLinter,
          command: userLinter,
          args: [],
          parseOutput: (output: string) => {
            // Generic parser: assume each line is an issue
            return output
              .split("\n")
              .filter((l) => l.trim() && !l.includes("✖"))
              .map((l) => ({ severity: "error" as const, message: l.trim() }))
          },
        }
      } else {
        // Auto-detect project linter (cached per extension)
        const ext = extname(filePath).toLowerCase()
        if (linterCache.has(ext)) {
          linter = linterCache.get(ext) ?? null
        } else {
          linter = await detectProjectLinter(ctx.$, ctx.directory, filePath)
          linterCache.set(ext, linter)
        }
      }

      if (!linter) {
        // No linter available for this file type — silently skip
        return
      }

      // Suppress duplicate toasts for rapid edits
      if (shouldSuppress(filePath)) {
        return
      }

      const result = await runLinter(ctx.$, linter, filePath, config.autoFix)

      const fileName = filePath.split(/[\\/]/).pop() ?? filePath
      const { title, message, variant } = formatLintResult(result, fileName, config)

      await showToast(ctx.client, title, message, variant, result.ok ? 3000 : 8000)

      // Optionally block on errors
      if (!result.ok && config.blockOnError) {
        const errors = result.issues.filter((i) => i.severity === "error")
        if (errors.length > 0) {
          throw new Error(
            `XPowers Lint Gate: ${errors.length} lint error(s) in ${fileName}. ` +
              `Fix linting issues or set blockOnError: false in lint-gate-config.json.`,
          )
        }
      }

      // If auto-fix was applied, notify
      if (config.autoFix && result.fixed) {
        await showToast(
          ctx.client,
          "✓ Auto-Fixed",
          `${fileName}\nLinter auto-fixed issues`,
          "success",
          3000,
        )
      }
    },
  }
}

export default xpowersLintGatePlugin
