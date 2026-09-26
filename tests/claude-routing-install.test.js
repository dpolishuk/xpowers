const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const yaml = require("js-yaml")
const { spawn, spawnSync } = require("node:child_process")

const repoRoot = path.resolve(__dirname, "..")
const installer = path.join(repoRoot, "scripts", "claude-routing", "install.py")

function fixture(t, projectName = "project") {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xpowers-routing-install-")))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const project = path.join(tmp, projectName)
  const runtime = path.join(tmp, "source")
  const home = path.join(tmp, "home")
  for (const dir of [project, runtime, home]) fs.mkdirSync(dir, { recursive: true })
  for (const source of fs.readdirSync(path.dirname(installer)).filter(name => name.endsWith(".py"))) {
    fs.copyFileSync(path.join(path.dirname(installer), source), path.join(runtime, source))
  }
  return { project, runtime, home }
}

function invoke(f, action = "install", preset = "") {
  const args = [path.join(f.runtime, "cli.py"), "install", "--project", f.project]
  if (action === "restore") args.push("--restore")
  if (preset) args.push("--preset", preset)
  return spawnSync("python3", args, {
    cwd: f.runtime,
    env: { ...process.env, HOME: f.home, PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
    timeout: 10000,
  })
}

function success(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

function file(f, relative) { return path.join(f.project, ".claude", relative) }
function write(f, relative, content) {
  const target = file(f, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}
function read(f, relative) { return fs.readFileSync(file(f, relative), "utf8") }
function json(f, relative) { return JSON.parse(read(f, relative)) }
function manifestPath(f) {
  const hash = crypto.createHash("sha256").update(f.project).digest("hex").slice(0, 24)
  return path.join(f.home, ".claude", "xpowers-routing", hash, "install-manifest.json")
}
function sessionPath(f, session = "test-session") {
  const hash = crypto.createHash("sha256").update(session).digest("hex")
  return path.join(path.dirname(manifestPath(f)), "sessions", `${hash}.json`)
}
function activationProofPath(f, session = "test-session") {
  const hash = crypto.createHash("sha256").update(session).digest("hex")
  return path.join(path.dirname(manifestPath(f)), "activation-proofs", `${hash}.json`)
}

test("routing install generates configured roles, native limits and independent verification", t => {
  const f = fixture(t)
  success(invoke(f))
  assert.equal(json(f, "routing.json").preset, "opus")
  for (const role of ["worker", "verifier"]) assert.match(read(f, `agents/xpowers-routing-${role}.md`), /^maxTurns: 80$/m)
  assert.match(read(f, "agents/xpowers-routing-reviewer.md"), /^maxTurns: 60$/m)
  assert.match(read(f, "agents/xpowers-routing-worker.md"), /^model: "claude-opus-5-5"$/m)
  assert.match(read(f, "agents/xpowers-routing-worker.md"), /^effort: medium$/m)
  assert.doesNotMatch(read(f, "agents/xpowers-routing-explorer.md"), /^effort:/m)
  assert.match(read(f, "agents/xpowers-routing-reviewer.md"), /fresh/i)
  assert.match(read(f, "agents/xpowers-routing-verifier.md"), /author/i)
  assert.match(read(f, "agents/xpowers-routing-reviewer.md"), /^tools: Read, Glob, Grep$/m)
  assert.equal(fs.existsSync(file(f, "xpowers-routing/common.py")), true)
  assert.equal(fs.existsSync(file(f, "agents/xpowers-routing-coordinator.md")), false)
  assert.match(read(f, "commands/routing-on.md"), /^disable-model-invocation: true$/m)
  const settings = json(f, "settings.json")
  assert.equal(settings.hooks.PreToolUse[0].matcher, ".*")
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].timeout, 5)
})

test("routing reinstall preserves custom config and unrelated settings, explicit preset updates policy", t => {
  const f = fixture(t)
  write(f, "settings.json", JSON.stringify({ permissions: { allow: ["Read"] }, hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "echo user" }] }] } }))
  success(invoke(f))
  const custom = json(f, "routing.json")
  custom.roles.worker.maxTurns = 123
  custom.roles.worker.model = "custom-worker"
  write(f, "routing.json", JSON.stringify(custom, null, 4) + "\n")
  const original = read(f, "routing.json")
  success(invoke(f))
  assert.equal(read(f, "routing.json"), original)
  assert.match(read(f, "agents/xpowers-routing-worker.md"), /^maxTurns: 123$/m)
  assert.equal(json(f, "settings.json").hooks.PreToolUse.length, 2)
  assert.deepEqual(json(f, "settings.json").permissions, { allow: ["Read"] })
  success(invoke(f, "install", "fable-review"))
  assert.equal(json(f, "routing.json").preset, "fable-review")
  assert.match(read(f, "agents/xpowers-routing-reviewer.md"), /^model: "claude-fable-5-1"$/m)
})

test("routing restore preserves later unrelated settings and recovers overwritten original files", t => {
  const f = fixture(t)
  write(f, "commands/routing-on.md", "user original command\n")
  write(f, "settings.json", '{"theme":"dark"}\n')
  success(invoke(f))
  const settings = json(f, "settings.json")
  settings.theme = "light"
  settings.hooks.Stop = [{ hooks: [{ type: "command", command: "echo later" }] }]
  write(f, "settings.json", JSON.stringify(settings))
  success(invoke(f))
  success(invoke(f, "restore"))
  assert.equal(read(f, "commands/routing-on.md"), "user original command\n")
  assert.equal(json(f, "settings.json").theme, "light")
  assert.equal(json(f, "settings.json").hooks.Stop[0].hooks[0].command, "echo later")
  assert.equal(json(f, "settings.json").hooks.PreToolUse, undefined)
  assert.equal(fs.existsSync(file(f, "routing.json")), false)
  assert.equal(fs.existsSync(file(f, "xpowers-routing/common.py")), false)
})

test("routing restore detects conflict before changing any managed file", t => {
  const f = fixture(t)
  success(invoke(f))
  const before = read(f, "settings.json")
  write(f, "agents/xpowers-routing-worker.md", "later user modification\n")
  const result = invoke(f, "restore")
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /modif|conflict/i)
  assert.equal(read(f, "settings.json"), before)
  assert.equal(fs.existsSync(file(f, "routing.json")), true)
  assert.equal(read(f, "agents/xpowers-routing-worker.md"), "later user modification\n")
})

test("routing restore recovers exact original config/settings and permissions after repeated installs", t => {
  const f = fixture(t)
  success(invoke(f))
  const config = json(f, "routing.json")
  success(invoke(f, "restore"))
  const originalConfig = JSON.stringify(config, null, 4) + "\n\n"
  const originalSettings = '{ "theme": "dark", "hooks": {"PreToolUse": []} }\n'
  write(f, "routing.json", originalConfig)
  write(f, "settings.json", originalSettings)
  fs.chmodSync(file(f, "routing.json"), 0o600)
  success(invoke(f, "install", "fable-coordinator"))
  success(invoke(f))
  success(invoke(f, "restore"))
  assert.equal(read(f, "routing.json"), originalConfig)
  assert.equal(read(f, "settings.json"), originalSettings)
  assert.equal(fs.statSync(file(f, "routing.json")).mode & 0o777, 0o600)
})

test("routing restore preserves unrelated files and rejects edited owned hooks before restoring", t => {
  const f = fixture(t)
  success(invoke(f))
  write(f, "agents/user-agent.md", "unrelated\n")
  const settings = json(f, "settings.json")
  settings.hooks.PreToolUse[0].hooks[0].command = "echo manually changed"
  write(f, "settings.json", JSON.stringify(settings))
  const before = read(f, "routing.json")
  assert.notEqual(invoke(f, "restore").status, 0)
  assert.equal(read(f, "routing.json"), before)
  assert.equal(read(f, "agents/user-agent.md"), "unrelated\n")
})

test("routing reinstall refuses modified generated files before replacing config", t => {
  const f = fixture(t)
  success(invoke(f))
  write(f, "commands/routing-on.md", "manual change\n")
  const before = read(f, "routing.json")
  assert.notEqual(invoke(f, "install", "fable-review").status, 0)
  assert.equal(read(f, "routing.json"), before)
  assert.equal(read(f, "commands/routing-on.md"), "manual change\n")
})

test("routing install validates settings structure and unknown presets without project writes", t => {
  for (const content of ["[]", '{"hooks": []}', '{"hooks": {"PreToolUse": {}}}']) {
    const f = fixture(t)
    write(f, "settings.json", content)
    assert.notEqual(invoke(f).status, 0)
    assert.deepEqual(fs.readdirSync(file(f, "")), ["settings.json"])
  }
  const f = fixture(t)
  assert.notEqual(invoke(f, "install", "typo").status, 0)
  assert.equal(fs.existsSync(file(f, "")), false)
})

test("routing install rejects malformed settings or config without partial project writes", t => {
  for (const relative of ["settings.json", "routing.json"]) {
    const f = fixture(t, relative)
    write(f, relative, "{broken")
    assert.notEqual(invoke(f).status, 0)
    assert.deepEqual(fs.readdirSync(file(f, "")), [relative])
  }
})

test("routing installer rejects symlinked targets and ancestors", t => {
  for (const relative of ["", "settings.json", "agents", "routing.json"]) {
    const f = fixture(t)
    const outside = path.join(f.home, relative.includes(".json") ? "outside.json" : "outside")
    if (relative.includes(".json")) fs.writeFileSync(outside, "{}")
    else fs.mkdirSync(outside)
    fs.mkdirSync(path.dirname(file(f, relative)), { recursive: true })
    fs.symlinkSync(outside, file(f, relative))
    const result = invoke(f)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /symlink/i)
    if (relative.includes(".json")) assert.equal(fs.readFileSync(outside, "utf8"), "{}")
    else assert.deepEqual(fs.readdirSync(outside), [])
  }
})

test("routing hook commands quote project paths containing spaces and apostrophes", t => {
  const f = fixture(t, "project ' quoted")
  success(invoke(f))
  const command = json(f, "settings.json").hooks.PreToolUse[0].hooks[0].command
  const parsed = spawnSync("python3", ["-c", "import json,shlex,sys; print(json.dumps(shlex.split(sys.argv[1])))", command], { encoding: "utf8" })
  success(parsed)
  assert.deepEqual(JSON.parse(parsed.stdout), ["python3", file(f, "xpowers-routing/cli.py"), "guard", "--project", f.project])
})

test("routing installers serialize concurrent installs without duplicate hooks or lost originals", async t => {
  const f = fixture(t)
  write(f, "commands/routing-on.md", "original command\n")
  const run = () => new Promise((resolve, reject) => {
    const child = spawn("python3", [path.join(f.runtime, "cli.py"), "install", "--project", f.project], {
      env: { ...process.env, HOME: f.home, PYTHONDONTWRITEBYTECODE: "1" },
    })
    let output = ""
    child.stderr.on("data", chunk => { output += chunk })
    child.on("error", reject)
    child.on("close", status => resolve({ status, stderr: output }))
  })
  const results = await Promise.all([run(), run(), run()])
  results.forEach(success)
  assert.equal(json(f, "settings.json").hooks.PreToolUse.length, 1)
  success(invoke(f, "restore"))
  assert.equal(read(f, "commands/routing-on.md"), "original command\n")
})

test("routing install rolls back earlier writes when a later atomic write fails", t => {
  const f = fixture(t)
  write(f, "settings.json", '{"user":"original"}\n')
  const script = `import sys
from pathlib import Path
import install
original = install._atomic_write
attempts = 0
def fail_once(target, snapshot):
    global attempts
    attempts += 1
    if attempts == 3: raise OSError('simulated full disk')
    original(target, snapshot)
install._atomic_write = fail_once
install.install(Path(sys.argv[1]))
`
  const result = spawnSync("python3", ["-c", script, f.project], {
    cwd: f.runtime,
    env: { ...process.env, HOME: f.home, PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
    timeout: 10000,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /simulated full disk/)
  assert.equal(read(f, "settings.json"), '{"user":"original"}\n')
  assert.deepEqual(fs.readdirSync(file(f, "")), ["settings.json"])
  success(invoke(f))
})

test("routing restore rejects a managed file replaced by a symlink without touching its target", t => {
  const f = fixture(t)
  success(invoke(f))
  const outside = path.join(f.home, "outside.md")
  fs.writeFileSync(outside, "unrelated\n")
  fs.unlinkSync(file(f, "agents/xpowers-routing-worker.md"))
  fs.symlinkSync(outside, file(f, "agents/xpowers-routing-worker.md"))
  const result = invoke(f, "restore")
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /symlink/i)
  assert.equal(fs.readFileSync(outside, "utf8"), "unrelated\n")
  assert.equal(fs.existsSync(file(f, "routing.json")), true)
})

test("routing restore disables session state so reinstall never silently reactivates routing", t => {
  const f = fixture(t)
  const sessionAction = action => spawnSync("python3", [path.join(f.runtime, "cli.py"), action, "--project", f.project, "--session", "test-session"], {
    env: { ...process.env, HOME: f.home, PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
    timeout: 10000,
  })
  success(invoke(f))
  const state = sessionPath(f)
  fs.mkdirSync(path.dirname(state), { recursive: true })
  fs.writeFileSync(state, '{"enabled":true}\n')
  assert.equal(sessionAction("status").stdout.trim(), "ON")
  success(invoke(f, "restore"))
  assert.equal(sessionAction("status").stdout.trim(), "OFF")
  success(invoke(f))
  assert.equal(sessionAction("status").stdout.trim(), "OFF")
})

test("routing installer rejects projects containing its external control directory", t => {
  for (const useHome of [true, false]) {
    const f = fixture(t)
    f.project = useHome ? f.home : path.dirname(f.home)
    const result = invoke(f)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /outside.*project|project.*control/i)
    assert.equal(fs.existsSync(file(f, "")), false)
    assert.equal(fs.existsSync(path.join(f.home, ".claude")), false)
  }
})

test("generated routing descriptions provide a distinct usage example for each role", t => {
  const f = fixture(t)
  success(invoke(f))
  const descriptions = []
  const scenarios = { explorer: /authentication/, worker: /acceptance tests/, verifier: /independently/, senior: /payment/, reviewer: /data migration/ }
  for (const role of ["explorer", "worker", "verifier", "senior", "reviewer"]) {
    const text = read(f, `agents/xpowers-routing-${role}.md`)
    const frontmatter = yaml.load(text.match(/^---\n([\s\S]*?)\n---/)[1])
    const example = frontmatter.description.match(/<example>(.*)<\/example>/)?.[1]
    assert.ok(example, `${role} description needs a usage example`)
    assert.match(example, new RegExp(`xpowers-routing-${role}`))
    assert.match(example, scenarios[role])
    descriptions.push(frontmatter.description)
  }
  assert.equal(new Set(descriptions).size, 5)
})

test("routing relocation replaces only owned absolute hooks and restores original files", t => {
  const f = fixture(t)
  const unrelated = { matcher: "Read", hooks: [{ type: "command", command: `echo '${f.project}/.claude/xpowers-routing/cli.py'` }] }
  write(f, "commands/routing-on.md", "original user command\n")
  write(f, "settings.json", JSON.stringify({ theme: "dark", hooks: { PreToolUse: [unrelated] } }))
  success(invoke(f))
  const oldManifest = manifestPath(f)
  const moved = { ...f, project: path.join(path.dirname(f.project), "moved ' project") }
  fs.renameSync(f.project, moved.project)
  success(invoke(moved))
  const hooks = json(moved, "settings.json").hooks
  assert.equal(hooks.PreToolUse.length, 2)
  assert.deepEqual(hooks.PreToolUse[0], unrelated)
  assert.match(hooks.PreToolUse[1].hooks[0].command, /moved/)
  assert.equal(hooks.SessionStart.length, 1)
  assert.equal(fs.existsSync(oldManifest), false)
  success(invoke(moved, "restore"))
  assert.equal(read(moved, "commands/routing-on.md"), "original user command\n")
  assert.deepEqual(json(moved, "settings.json"), { theme: "dark", hooks: { PreToolUse: [unrelated] } })
  assert.equal(fs.existsSync(file(moved, "routing.json")), false)
  assert.equal(fs.existsSync(file(moved, "xpowers-routing/cli.py")), false)
})

test("routing ownership follows the current marker across an A to B to A roundtrip", t => {
  const f = fixture(t, "project-a")
  const unrelated = { matcher: "Read", hooks: [{ type: "command", command: "echo user-hook" }] }
  write(f, "commands/routing-on.md", "original command bytes\n")
  write(f, "settings.json", JSON.stringify({ theme: "dark", hooks: { PreToolUse: [unrelated] } }))
  success(invoke(f))
  const destinationManifest = manifestPath(f)

  const moved = { ...f, project: path.join(path.dirname(f.project), "project-b") }
  fs.renameSync(f.project, moved.project)
  success(invoke(moved))
  const sourceManifest = manifestPath(moved)
  assert.equal(fs.existsSync(destinationManifest), false)
  assert.equal(fs.existsSync(sourceManifest), true)

  fs.renameSync(moved.project, f.project)
  success(invoke(f))
  const hooks = json(f, "settings.json").hooks
  assert.equal(hooks.PreToolUse.length, 2)
  assert.deepEqual(hooks.PreToolUse[0], unrelated)
  assert.match(hooks.PreToolUse[1].hooks[0].command, new RegExp(f.project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.equal(hooks.SessionStart.length, 1)
  assert.equal(fs.existsSync(sourceManifest), false)
  assert.equal(fs.existsSync(destinationManifest), true)

  success(invoke(f, "restore"))
  assert.equal(read(f, "commands/routing-on.md"), "original command bytes\n")
  assert.deepEqual(json(f, "settings.json"), { theme: "dark", hooks: { PreToolUse: [unrelated] } })
  assert.equal(fs.existsSync(file(f, "routing.json")), false)
  assert.equal(fs.existsSync(file(f, "xpowers-routing/cli.py")), false)
})

test("a relocated install releases an absent source path for an independent project", t => {
  const original = fixture(t, "project-a")
  write(original, "commands/routing-on.md", "original project command\n")
  write(original, "settings.json", JSON.stringify({ theme: "original" }))
  success(invoke(original))
  const oldManifest = manifestPath(original)
  const oldSession = sessionPath(original)
  fs.mkdirSync(path.dirname(oldSession), { recursive: true })
  fs.writeFileSync(oldSession, '{"enabled":true}\n')
  const oldProof = activationProofPath(original)
  fs.mkdirSync(path.dirname(oldProof), { recursive: true })
  fs.writeFileSync(oldProof, '{"pending":true}\n')

  const moved = { ...original, project: path.join(path.dirname(original.project), "project-b") }
  fs.renameSync(original.project, moved.project)
  success(invoke(moved))
  assert.equal(fs.existsSync(oldManifest), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(oldSession, "utf8")), { enabled: false })
  assert.equal(fs.existsSync(oldProof), false)

  fs.mkdirSync(original.project)
  success(invoke(original))
  const movedManifest = JSON.parse(fs.readFileSync(manifestPath(moved), "utf8"))
  const replacementManifest = JSON.parse(fs.readFileSync(manifestPath(original), "utf8"))
  assert.notEqual(replacementManifest.installationId, movedManifest.installationId)

  success(invoke(original, "restore"))
  assert.equal(fs.existsSync(file(original, "")), false)
  assert.equal(fs.existsSync(file(moved, "routing.json")), true)

  success(invoke(moved, "restore"))
  assert.equal(read(moved, "commands/routing-on.md"), "original project command\n")
  assert.deepEqual(json(moved, "settings.json"), { theme: "original" })
})

test("routing roundtrip refuses a bad hinted backup instead of using a legacy stale destination", t => {
  for (const kind of ["missing", "corrupt", "mismatched-origin", "mismatched-identity"]) {
    const f = fixture(t, `project-a-${kind}`)
    write(f, "commands/routing-on.md", `original ${kind}\n`)
    success(invoke(f))
    const destinationManifest = manifestPath(f)
    const destinationBefore = fs.readFileSync(destinationManifest)
    const moved = { ...f, project: path.join(path.dirname(f.project), `project-b-${kind}`) }
    fs.renameSync(f.project, moved.project)
    success(invoke(moved))
    const sourceManifest = manifestPath(moved)
    assert.equal(fs.existsSync(destinationManifest), false)
    fs.writeFileSync(destinationManifest, destinationBefore)
    fs.renameSync(moved.project, f.project)

    if (kind === "missing") {
      fs.unlinkSync(sourceManifest)
    } else if (kind === "corrupt") {
      fs.writeFileSync(sourceManifest, "not json\n")
    } else if (kind === "mismatched-origin") {
      const manifest = JSON.parse(fs.readFileSync(sourceManifest, "utf8"))
      manifest.project = path.join(path.dirname(f.project), "another-project")
      fs.writeFileSync(sourceManifest, JSON.stringify(manifest))
    } else {
      const manifest = JSON.parse(fs.readFileSync(sourceManifest, "utf8"))
      manifest.installationId = manifest.installationId === "f".repeat(32) ? "e".repeat(32) : "f".repeat(32)
      fs.writeFileSync(sourceManifest, JSON.stringify(manifest))
    }

    const settingsBefore = read(f, "settings.json")
    const commandBefore = read(f, "commands/routing-on.md")
    const originBefore = read(f, "xpowers-routing/install-origin.json")
    const result = invoke(f)
    assert.notEqual(result.status, 0, `${kind}: reinstall unexpectedly succeeded`)
    assert.equal(read(f, "settings.json"), settingsBefore, kind)
    assert.equal(read(f, "commands/routing-on.md"), commandBefore, kind)
    assert.equal(read(f, "xpowers-routing/install-origin.json"), originBefore, kind)
    assert.deepEqual(fs.readFileSync(destinationManifest), destinationBefore, kind)
  }
})

test("copied routing installations keep independent ownership and restoration", t => {
  const f = fixture(t)
  success(invoke(f))
  const oldManifest = fs.readFileSync(manifestPath(f), "utf8")
  const sourceProof = activationProofPath(f)
  fs.mkdirSync(path.dirname(sourceProof), { recursive: true })
  fs.writeFileSync(sourceProof, '{"pending":true}\n')
  const copied = { ...f, project: path.join(path.dirname(f.project), "copied") }
  fs.cpSync(f.project, copied.project, { recursive: true })
  success(invoke(copied))
  assert.equal(fs.readFileSync(sourceProof, "utf8"), '{"pending":true}\n')
  success(invoke(copied, "restore"))
  assert.equal(fs.existsSync(file(copied, "settings.json")), false)
  assert.equal(fs.readFileSync(manifestPath(f), "utf8"), oldManifest)
  assert.equal(fs.existsSync(file(f, "settings.json")), true)
  success(invoke(f, "restore"))
  assert.equal(fs.existsSync(file(f, "settings.json")), false)
})

test("legacy routing relocation finds only the exact manifest named by registered hooks", t => {
  const f = fixture(t)
  write(f, "commands/routing-on.md", "original before legacy installation\n")
  success(invoke(f))
  const manifest = JSON.parse(fs.readFileSync(manifestPath(f), "utf8"))
  delete manifest.installationId
  delete manifest.files["xpowers-routing/install-origin.json"]
  fs.writeFileSync(manifestPath(f), JSON.stringify(manifest))
  fs.rmSync(file(f, "xpowers-routing/install-origin.json"), { force: true })
  const moved = { ...f, project: path.join(path.dirname(f.project), "legacy-moved") }
  fs.renameSync(f.project, moved.project)
  success(invoke(moved))
  assert.equal(json(moved, "settings.json").hooks.PreToolUse.length, 1)
  success(invoke(moved, "restore"))
  assert.equal(read(moved, "commands/routing-on.md"), "original before legacy installation\n")
  assert.equal(fs.existsSync(file(moved, "xpowers-routing/cli.py")), false)
})

test("relocation without its ownership backup refuses before replacing project files", t => {
  const f = fixture(t)
  success(invoke(f))
  fs.unlinkSync(manifestPath(f))
  const moved = { ...f, project: path.join(path.dirname(f.project), "missing-backup") }
  fs.renameSync(f.project, moved.project)
  const beforeSettings = read(moved, "settings.json")
  const beforeCommand = read(moved, "commands/routing-on.md")
  const result = invoke(moved)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ownership|backup|manifest/i)
  assert.equal(read(moved, "settings.json"), beforeSettings)
  assert.equal(read(moved, "commands/routing-on.md"), beforeCommand)
  assert.equal(fs.existsSync(manifestPath(moved)), false)
})

test("relocation rejects modified generated files and preserves original ownership data", t => {
  const f = fixture(t)
  success(invoke(f))
  const oldManifest = manifestPath(f)
  const oldBackup = fs.readFileSync(oldManifest, "utf8")
  const moved = { ...f, project: path.join(path.dirname(f.project), "modified-copy") }
  fs.cpSync(f.project, moved.project, { recursive: true })
  write(moved, "agents/xpowers-routing-worker.md", "manual edit\n")
  const beforeSettings = read(moved, "settings.json")
  assert.notEqual(invoke(moved).status, 0)
  assert.equal(read(moved, "settings.json"), beforeSettings)
  assert.equal(fs.readFileSync(oldManifest, "utf8"), oldBackup)
  assert.equal(fs.existsSync(manifestPath(moved)), false)
})

test("relocation rolls back regenerated files and hooks when the new ownership manifest cannot be written", t => {
  const f = fixture(t)
  success(invoke(f))
  const oldManifest = manifestPath(f)
  const original = fs.readFileSync(oldManifest, "utf8")
  const moved = { ...f, project: path.join(path.dirname(f.project), "rollback-move") }
  fs.renameSync(f.project, moved.project)
  const beforeSettings = read(moved, "settings.json")
  const beforeCommand = read(moved, "commands/routing-on.md")
  const beforeOrigin = read(moved, "xpowers-routing/install-origin.json")
  const script = `import sys
from pathlib import Path
import install
original = install._atomic_write
def fail_manifest(target, snapshot):
    if target.name == 'install-manifest.json': raise OSError('simulated manifest failure')
    original(target, snapshot)
install._atomic_write = fail_manifest
install.install(Path(sys.argv[1]))
`
  const result = spawnSync("python3", ["-c", script, moved.project], {
    cwd: moved.runtime,
    env: { ...process.env, HOME: moved.home, PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
    timeout: 10000,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /simulated manifest failure/)
  assert.equal(read(moved, "settings.json"), beforeSettings)
  assert.equal(read(moved, "commands/routing-on.md"), beforeCommand)
  assert.equal(read(moved, "xpowers-routing/install-origin.json"), beforeOrigin)
  assert.equal(fs.readFileSync(oldManifest, "utf8"), original)
  assert.equal(fs.existsSync(manifestPath(moved)), false)
  success(invoke(moved))
})

test("relocation rolls back if retiring the absent source manifest fails", t => {
  const f = fixture(t)
  write(f, "commands/routing-on.md", "original command\n")
  success(invoke(f))
  const oldManifest = manifestPath(f)
  const originalManifest = fs.readFileSync(oldManifest)
  const oldSession = sessionPath(f)
  fs.mkdirSync(path.dirname(oldSession), { recursive: true })
  fs.writeFileSync(oldSession, '{"enabled":true}\n')
  const oldProof = activationProofPath(f)
  fs.mkdirSync(path.dirname(oldProof), { recursive: true })
  fs.writeFileSync(oldProof, '{"pending":true}\n')
  const moved = { ...f, project: path.join(path.dirname(f.project), "retire-rollback") }
  fs.renameSync(f.project, moved.project)
  const beforeSettings = read(moved, "settings.json")
  const beforeCommand = read(moved, "commands/routing-on.md")
  const beforeOrigin = read(moved, "xpowers-routing/install-origin.json")
  const script = `import sys
from pathlib import Path
import install
original = install._atomic_write
source_manifest = Path(sys.argv[2])
def fail_retirement(target, snapshot):
    if target == source_manifest and snapshot is None:
        raise OSError('simulated source manifest retirement failure')
    original(target, snapshot)
install._atomic_write = fail_retirement
install.install(Path(sys.argv[1]))
`
  const result = spawnSync("python3", ["-c", script, moved.project, oldManifest], {
    cwd: moved.runtime,
    env: { ...process.env, HOME: moved.home, PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
    timeout: 10000,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /source manifest retirement failure/)
  assert.equal(read(moved, "settings.json"), beforeSettings)
  assert.equal(read(moved, "commands/routing-on.md"), beforeCommand)
  assert.equal(read(moved, "xpowers-routing/install-origin.json"), beforeOrigin)
  assert.deepEqual(fs.readFileSync(oldManifest), originalManifest)
  assert.deepEqual(JSON.parse(fs.readFileSync(oldSession, "utf8")), { enabled: true })
  assert.equal(fs.readFileSync(oldProof, "utf8"), '{"pending":true}\n')
  assert.equal(fs.existsSync(manifestPath(moved)), false)
  success(invoke(moved))
  assert.deepEqual(JSON.parse(fs.readFileSync(oldSession, "utf8")), { enabled: false })
  assert.equal(fs.existsSync(oldProof), false)
})

test("relocation refuses a symlinked former project path promptly without locking the same control twice", t => {
  const f = fixture(t)
  success(invoke(f))
  const oldManifest = manifestPath(f)
  const original = fs.readFileSync(oldManifest, "utf8")
  const moved = { ...f, project: path.join(path.dirname(f.project), "symlink-move") }
  fs.renameSync(f.project, moved.project)
  fs.symlinkSync(moved.project, f.project)
  const beforeSettings = read(moved, "settings.json")
  const result = invoke(moved)
  assert.notEqual(result.status, 0)
  assert.equal(result.error, undefined, "installer must reject this without timing out")
  assert.match(result.stderr, /origin.*symlink|symlink.*origin/i)
  assert.equal(read(moved, "settings.json"), beforeSettings)
  assert.equal(fs.readFileSync(oldManifest, "utf8"), original)
  assert.equal(fs.existsSync(manifestPath(moved)), false)
})

test("a concurrent installer waits for a first install paused before its origin marker", async t => {
  const f = fixture(t)
  const paused = path.join(f.runtime, "first-paused")
  const release = path.join(f.runtime, "release-first")
  const observed = path.join(f.runtime, "second-observed")
  const start = script => {
    const child = spawn("python3", ["-c", script, f.project, paused, release, observed], {
      cwd: f.runtime,
      env: { ...process.env, HOME: f.home, PYTHONDONTWRITEBYTECODE: "1" },
    })
    t.after(() => child.kill())
    return new Promise((resolve, reject) => {
      let output = ""
      child.stderr.on("data", chunk => { output += chunk })
      child.on("error", reject)
      child.on("close", status => resolve({ status, stderr: output }))
    })
  }
  const waitFor = async target => {
    const deadline = Date.now() + 5000
    while (!fs.existsSync(target)) {
      assert.ok(Date.now() < deadline, `timed out waiting for ${target}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const first = start(`import sys, time
from pathlib import Path
import install
original = install._atomic_write
def pause_after_generated(target, snapshot):
    original(target, snapshot)
    if target.name == 'generated-config.json':
        Path(sys.argv[2]).touch()
        deadline = time.monotonic() + 8
        while not Path(sys.argv[3]).exists():
            if time.monotonic() > deadline: raise RuntimeError('first installer was not released')
            time.sleep(0.01)
install._atomic_write = pause_after_generated
install.install(Path(sys.argv[1]))
`)
  await waitFor(paused)
  const second = start(`import sys
from pathlib import Path
import install
original = install._origin_hint
def observe_partial_origin(project):
    try: return original(project)
    finally: Path(sys.argv[4]).touch()
install._origin_hint = observe_partial_origin
install.install(Path(sys.argv[1]))
`)
  await waitFor(observed)
  fs.writeFileSync(release, "release\n")
  const results = await Promise.all([first, second])
  results.forEach(success)
  assert.equal(json(f, "settings.json").hooks.PreToolUse.length, 1)
  success(invoke(f, "restore"))
  assert.equal(fs.existsSync(file(f, "routing.json")), false)
})
