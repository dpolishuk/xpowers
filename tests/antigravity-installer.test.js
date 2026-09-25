const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawn, spawnSync } = require("node:child_process")

const repoRoot = path.resolve(__dirname, "..")
const bun = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()

function fixture(t, hasCli = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-installer-"))
  const bin = path.join(home, "bin")
  fs.mkdirSync(bin)
  fs.symlinkSync(process.execPath, path.join(bin, "node"))
  fs.symlinkSync(bun, path.join(bin, "bun"))
  // Neither GNU timeout variant is usable: the installer must enforce its own bound.
  for (const name of ["timeout", "gtimeout"]) {
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 127\n", { mode: 0o755 })
  }
  if (hasCli) fs.writeFileSync(path.join(bin, "agy"), `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const operation = args[0] === '--version' ? 'version' : args[1]
const state = path.join(process.env.HOME, 'agy-installed')
fs.appendFileSync(path.join(process.env.HOME, 'agy-calls.jsonl'), JSON.stringify(args) + '\\n')
if (process.env.AGY_HANG === operation) {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 100)
} else if (process.env.AGY_FAIL === operation) {
  console.error('fake ' + operation + ' failed')
  process.exit(42)
} else if (operation === 'version') console.log('agy 1.2.5')
else if (operation === 'import') {
  if (!fs.existsSync(path.join(args[2], 'gemini-extension.json'))) process.exit(43)
  fs.writeFileSync(state, 'xpowers')
} else if (operation === 'list') console.log(fs.existsSync(state) ? 'xpowers' : 'No plugins installed')
else if (operation === 'uninstall') {
  if (args[2] !== 'xpowers') process.exit(44)
  fs.rmSync(state, { force: true })
} else process.exit(45)
`, { mode: 0o755 })
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    CODEX_HOME: path.join(home, ".codex"),
    KIMI_CODE_HOME: path.join(home, ".kimi-code"),
    PATH: `${bin}:/usr/bin:/bin`,
    XPOWERS_SKIP_THIRD_PARTY_FEATURES: "1",
    XPOWERS_AGY_TIMEOUT_MS: "500",
    NO_COLOR: "1",
    TERM: "dumb",
    CI: "true",
  }
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return { home, env, calls: () => {
    const file = path.join(home, "agy-calls.jsonl")
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : []
  } }
}

function run(kind, f, args = [], extraEnv = {}) {
  const command = kind === "shell" ? "/bin/bash" : bun
  const script = kind === "shell" ? "scripts/install.sh" : "scripts/install.ts"
  const defaults = kind === "shell" ? ["--yes"] : ["--yes", "--json", "--features", "__none__"]
  return new Promise((resolve) => {
    const child = spawn(command, [script, ...defaults, ...args], {
      cwd: repoRoot, env: { ...f.env, ...extraEnv }, detached: true,
    })
    let output = ""
    let timedOut = false
    child.stdout.on("data", (data) => { output += data })
    child.stderr.on("data", (data) => { output += data })
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, "SIGKILL") } catch { /* already exited */ }
    }, 3000)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, output, timedOut })
    })
  })
}

for (const kind of ["shell", "bun"]) {
  test(`${kind}: Antigravity installs, reports status and uninstalls through agy`, async (t) => {
    const f = fixture(t)
    const sourceMarker = path.join(repoRoot, ".gemini-extension", ".xpowers-version")
    const before = fs.existsSync(sourceMarker) ? fs.readFileSync(sourceMarker, "utf8") : null
    const install = await run(kind, f, ["--hosts", "antigravity"])
    assert.equal(install.code, 0, install.output)
    assert.equal(fs.existsSync(path.join(f.home, "agy-installed")), true)
    assert.equal(fs.existsSync(sourceMarker) ? fs.readFileSync(sourceMarker, "utf8") : null, before, "must not write into the source checkout")
    const status = await run(kind, f, ["--hosts", "antigravity", "--status"])
    assert.equal(status.code, 0, status.output)
    assert.match(status.output, /Antigravity|antigravity/)
    assert.equal(f.calls().filter((args) => args[1] === "import").length, 1, "status must not reinstall")
    assert.ok(f.calls().some((args) => args[1] === "list"), "status must query agy")
    const uninstall = await run(kind, f, ["--hosts", "antigravity", "--uninstall"])
    assert.equal(uninstall.code, 0, uninstall.output)
    assert.equal(fs.existsSync(path.join(f.home, "agy-installed")), false)
  })

  test(`${kind}: --all detects Antigravity and imports the local plugin`, async (t) => {
    const f = fixture(t)
    const result = await run(kind, f, ["--all"])
    assert.equal(result.code, 0, result.output)
    assert.ok(f.calls().some((args) => args[0] === "--version"))
    assert.deepEqual(f.calls().find((args) => args[1] === "import"), ["plugin", "import", path.join(repoRoot, ".gemini-extension")])
  })

  test(`${kind}: dry-run never imports or uninstalls an Antigravity plugin`, async (t) => {
    const f = fixture(t)
    for (const args of [[], ["--uninstall"]]) {
      const result = await run(kind, f, ["--hosts", "antigravity", "--dry-run", ...args])
      assert.equal(result.code, 0, result.output)
    }
    assert.equal(f.calls().some((args) => ["import", "uninstall"].includes(args[1])), false)
    assert.equal(fs.existsSync(path.join(f.home, ".xpowers", "manifest.json")), false)
  })

  test(`${kind}: explicitly requested Antigravity fails when agy is missing`, async (t) => {
    const f = fixture(t, false)
    const result = await run(kind, f, ["--hosts", "antigravity"])
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /agy.*not found/)
  })

  for (const operation of ["import", "uninstall"]) {
    test(`${kind}: failed Antigravity ${operation} is reported`, async (t) => {
      const f = fixture(t)
      if (operation === "uninstall") assert.equal((await run(kind, f, ["--hosts", "antigravity"])).code, 0)
      const result = await run(kind, f, ["--hosts", "antigravity", ...(operation === "uninstall" ? ["--uninstall"] : [])], { AGY_FAIL: operation })
      assert.equal(result.code, 1, result.output)
      assert.match(result.output, new RegExp(`fake ${operation} failed`))
      if (operation === "import") assert.equal(fs.existsSync(path.join(f.home, "agy-installed")), false)
    })
  }

  for (const operation of ["version", "import", "uninstall", "list"]) {
    test(`${kind}: hung Antigravity ${operation} is bounded without GNU timeout`, async (t) => {
      const f = fixture(t)
      if (operation === "uninstall") assert.equal((await run(kind, f, ["--hosts", "antigravity"])).code, 0)
      const args = operation === "version" ? ["--all"] : ["--hosts", "antigravity", ...(operation === "uninstall" ? ["--uninstall"] : operation === "list" ? ["--status"] : [])]
      const result = await run(kind, f, args, { AGY_HANG: operation })
      assert.equal(result.timedOut, false, `${operation} must finish before the outer safety timeout`)
      assert.ok(f.calls().some((args) => (args[0] === "--version" ? "version" : args[1]) === operation), `${operation} was actually invoked`)
      if (operation === "version") assert.equal(f.calls().some((args) => args[1] === "import"), false)
      else {
        assert.equal(result.code, 1, result.output)
        assert.match(result.output, /timed out|timeout/i)
      }
    })
  }
}

for (const kind of ["shell", "bun"]) {
  test(`${kind}: Antigravity does not configure claude-mem for Gemini`, async (t) => {
    const f = fixture(t)
    const bin = path.join(f.home, "bin")
    for (const name of ["curl", "python3"]) {
      fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    }
    fs.writeFileSync(path.join(bin, "npx"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/npx-calls"\n', { mode: 0o755 })
    const result = await run(kind, f, ["--hosts", "antigravity", ...(kind === "bun" ? ["--features", "claude-mem"] : [])], { XPOWERS_SKIP_THIRD_PARTY_FEATURES: "0" })
    assert.equal(result.code, 0, result.output)
    assert.equal(fs.existsSync(path.join(f.home, "npx-calls")), false, "Antigravity must not write Gemini-specific memory configuration")
  })
}
