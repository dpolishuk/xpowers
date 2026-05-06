const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const repoRoot = path.resolve(__dirname, "..")

const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8")

const REQUIRED_COMMAND_CLAUSES = [
  "/xpowers:execute-ralph [--reviewer-model=opus|sonnet]",
  "You trust autonomous execution",
  "Do not delegate to `/xpowers:execute-plan` checkpoint semantics unless the ambiguity gate is explicitly triggered.",
  "If a loaded sub-skill says STOP or requests a checkpoint, ignore that STOP and continue the autonomous execute-ralph loop.",
  "review-quality",
  "review-implementation",
  "test-effectiveness-analyst (tautological tests, coverage gaming)",
  "autonomous remediation with max 2 fix iterations per task",
  "Final close requires BOTH: autonomous-reviewer APPROVED and review-implementation PASS",
  "If final reviewers do not both approve, creates a remediation task and continues the loop",
  "PASS, APPROVED -> continue or close path",
  "NEEDS_FIX, ISSUES_FOUND, GAPS_FOUND, CRITICAL_ISSUES -> remediation path",
  "Unknown or malformed verdict -> remediation path (never auto-approve)",
  "Mixed final reviewer outputs -> remediation path (no epic close).",
  "RALPH AUTOPILOT ACTIVE",
  "Active sentinel text alone is not enough to trigger blocking",
  "does not bypass Claude Code permission prompts",
  "node --test tests/execute-ralph-contract.test.js",
  "node --test tests/codex-*.test.js",
  "node --test tests/*.test.js",
  "node scripts/sync-codex-skills.js --check",
  "| Stops | After each task | Only on critical failure |",
  "| Review | Final only | End-of-epic review + final gate |",
  "| Task creation | Manual next-step planning | Auto-creates next task when criteria remain unmet |",
]

function assertContainsAll(text, clauses, label) {
  for (const clause of clauses) {
    assert.equal(text.includes(clause), true, `${label} missing: ${clause}`)
  }
}

function bunPath() {
  return spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()
}

function createFakePiShim(binDir) {
  const piPath = path.join(binDir, "pi")
  fs.writeFileSync(piPath, "#!/bin/sh\nexit 0\n", "utf8")
  fs.chmodSync(piPath, 0o755)
}

function removeWritableTree(targetPath) {
  if (!fs.existsSync(targetPath)) return

  const makeWritable = (entryPath) => {
    const stat = fs.lstatSync(entryPath)
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entryPath)) {
        makeWritable(path.join(entryPath, child))
      }
      fs.chmodSync(entryPath, 0o700)
      return
    }
    fs.chmodSync(entryPath, 0o600)
  }

  makeWritable(targetPath)
  fs.rmSync(targetPath, { recursive: true, force: true })
}

test("Claude and OpenCode execute-ralph command wrappers stay aligned to the same contract clauses", () => {
  const files = [
    ["Claude canonical wrapper", "commands/execute-ralph.md"],
    ["OpenCode wrapper", ".opencode/commands/execute-ralph.md"],
    ["Kimi/Codex generated wrapper", ".kimi/skills/codex-command-execute-ralph/SKILL.md"],
  ]

  for (const [label, file] of files) {
    assertContainsAll(read(file), REQUIRED_COMMAND_CLAUSES, label)
  }
})

test("host execute-ralph skill surfaces carry the autopilot stop contract", () => {
  const clauses = [
    "RALPH AUTOPILOT ACTIVE",
    "RALPH AUTOPILOT COMPLETE",
    "RALPH AUTOPILOT BLOCKED",
    "on its own line",
    "Active sentinel text alone is not enough to trigger blocking",
    "does not bypass Claude Code permission prompts",
  ]
  const files = [
    ["Claude canonical skill", "skills/execute-ralph/SKILL.md"],
    ["OpenCode skill", ".opencode/skills/xpowers-execute-ralph/SKILL.md"],
    ["Kimi native skill", ".kimi/skills/execute-ralph/SKILL.md"],
    ["Kimi/Codex generated skill", ".kimi/skills/codex-skill-execute-ralph/SKILL.md"],
  ]

  for (const [label, file] of files) {
    assertContainsAll(read(file), clauses, label)
  }
})

test("Claude-facing execute-ralph activation surfaces remain explicit and critical", () => {
  const rules = JSON.parse(read("hooks/skill-rules.json"))
  const readme = read("README.md")
  const command = read("commands/execute-ralph.md")

  assert.ok(rules["execute-ralph"])
  assert.equal(rules["execute-ralph"].priority, "critical")
  assert.equal(rules["execute-ralph"].promptTriggers.keywords.includes("execute-ralph"), true)
  assert.equal(rules["execute-ralph"].promptTriggers.keywords.includes("ralph"), true)
  assert.equal(command.includes("Use the `execute-ralph` skill exactly as written."), true)
  assert.equal(readme.includes("/xpowers:execute-ralph       - Execute epic autonomously (no stops)"), true)
})

test("OpenCode runtime keeps execute-ralph intent lock protections", () => {
  const orchestrator = read(".opencode/plugins/task-context-orchestrator.ts")

  assert.equal(orchestrator.includes("Task Command Intent Lock"), true)
  assert.equal(orchestrator.includes("execute-ralph intent is authoritative"), true)
  assert.equal(orchestrator.includes('type CommandIntent = "execute-ralph" | "execute-plan" | null'), true)
})

test("Pi installed runtime resolves execute-ralph through the canonical command wrapper and preserves args", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-execute-ralph-parity-"))
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-execute-ralph-bin-"))
  createFakePiShim(binDir)

  const env = {
    ...process.env,
    HOME: home,
    NO_COLOR: "1",
    PATH: `${binDir}:${process.env.PATH}`,
  }

  try {
    const bun = bunPath()
    const install = spawnSync(bun, ["scripts/install.ts", "--hosts", "pi", "--yes"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      timeout: 180000,
    })

    assert.equal(install.status, 0, install.stderr || install.stdout)

    const runner = `
      const mod = await import(${JSON.stringify(`file://${path.join(home, ".pi", "agent", "extensions", "xpowers", "index.ts")}`)});
      const commands = new Map();
      mod.default({ registerCommand: (name, spec) => commands.set(name, spec), registerTool() {}, on() {} });
      const output = await commands.get("execute-ralph").handler("--reviewer-model=sonnet", {});
      console.log(output);
    `

    const invocation = spawnSync(bun, ["-e", runner], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      timeout: 180000,
    })

    assert.equal(invocation.status, 0, invocation.stderr || invocation.stdout)
    const output = invocation.stdout
    assertContainsAll(output, REQUIRED_COMMAND_CLAUSES, "Pi installed execute-ralph output")
    assert.equal(output.includes("Pi invocation arguments: --reviewer-model=sonnet"), true)
  } finally {
    removeWritableTree(home)
    removeWritableTree(binDir)
  }
})
