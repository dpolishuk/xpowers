const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const repoRoot = path.resolve(__dirname, "..")

function bunPath() {
  return spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()
}

function installEnv(home) {
  const bunDir = path.dirname(bunPath())
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    NO_COLOR: "1",
    XPOWERS_SKIP_THIRD_PARTY_FEATURES: "1",
    // Minimal PATH without npm: keeps --yes runs hermetic (the tm-cli feature
    // skips its npm dependency install when npm is unavailable), so parallel
    // test files cannot race each other through network installs.
    PATH: `${bunDir}:/usr/bin:/bin`,
  }
}

function combinedOutput(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`
}

function parseJsonOutput(stdout) {
  const line = stdout.split("\n").filter((l) => l.trim().length > 0).find((l) => l.trim().startsWith("{"))
  assert.ok(line, `expected a JSON line in installer output:\n${stdout}`)
  return JSON.parse(line)
}

function runInstaller(home, args) {
  const bun = bunPath()
  assert.ok(bun, "bun must be available to run the TypeScript installer")
  return spawnSync(bun, ["scripts/install.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
  })
}

test("zcode host installs skills, commands, and agent wrappers under ~/.zcode", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-host-install-"))
  fs.mkdirSync(path.join(home, ".zcode"), { recursive: true })

  const result = runInstaller(home, ["--hosts", "zcode", "--yes", "--json", "--allow-conflicts"])
  assert.equal(result.status, 0, combinedOutput(result))

  const zcode = path.join(home, ".zcode")

  // Canonical skills land in ~/.zcode/skills
  assert.ok(
    fs.existsSync(path.join(zcode, "skills", "brainstorming", "SKILL.md")),
    "canonical skill brainstorming should be installed",
  )
  // Reference material referenced by other skills via relative paths is kept
  assert.ok(
    fs.existsSync(path.join(zcode, "skills", "common-patterns", "bd-commands.md")),
    "common-patterns reference dir should be installed",
  )
  // Slash commands land in ~/.zcode/commands
  assert.ok(
    fs.existsSync(path.join(zcode, "commands", "brainstorm.md")),
    "command brainstorm.md should be installed",
  )
  // Agents are exposed as codex-agent-* wrapper skills (ZCode has no native
  // user-scope agent registry)
  assert.ok(
    fs.existsSync(path.join(zcode, "skills", "codex-agent-ralph", "SKILL.md")),
    "codex-agent-ralph wrapper skill should be installed",
  )

  const payload = parseJsonOutput(result.stdout)
  assert.deepEqual(payload.hosts, ["zcode"], `expected hosts to include zcode: ${result.stdout}`)
})

test("zcode host uninstall removes installed skills, commands, and wrappers", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-host-uninstall-"))
  fs.mkdirSync(path.join(home, ".zcode"), { recursive: true })

  const install = runInstaller(home, ["--hosts", "zcode", "--yes", "--json", "--allow-conflicts"])
  assert.equal(install.status, 0, combinedOutput(install))

  const uninstall = runInstaller(home, ["--uninstall", "--json"])
  assert.equal(uninstall.status, 0, combinedOutput(uninstall))

  const zcode = path.join(home, ".zcode")
  assert.ok(!fs.existsSync(path.join(zcode, "skills", "brainstorming")), "skills/brainstorming should be removed")
  assert.ok(!fs.existsSync(path.join(zcode, "skills", "codex-agent-ralph")), "codex-agent-ralph should be removed")
  assert.ok(!fs.existsSync(path.join(zcode, "commands", "brainstorm.md")), "commands/brainstorm.md should be removed")
  assert.ok(!fs.existsSync(path.join(zcode, ".xpowers-version")), ".xpowers-version should be removed")
})

test("installer help lists zcode as a host id", { timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-host-help-"))
  const result = runInstaller(home, ["--help"])
  assert.equal(result.status, 0, combinedOutput(result))
  assert.match(result.stdout, /--hosts[^\n]*\bzcode\b/, `--hosts help line should mention zcode:\n${result.stdout}`)
})
