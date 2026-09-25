const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const runtime = path.resolve(__dirname, "../scripts/claude-routing")

function python(code, data = {}) {
  const result = spawnSync("python3", ["-B", "-c", `import sys,json; sys.path.insert(0,${JSON.stringify(runtime)}); import common; data=json.load(sys.stdin); ${code}`], {
    input: JSON.stringify(data), encoding: "utf8", timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test("routing presets assign independent verification and native turn budgets", () => {
  const cfg = python("print(json.dumps(common.preset_config('opus')))")
  assert.equal(cfg.roles.coordinator.model, "claude-opus-5-5")
  assert.equal(cfg.roles.worker.model, "claude-opus-5-5")
  assert.equal(cfg.roles.worker.effort, "medium")
  assert.equal(cfg.roles.worker.maxTurns, 80)
  assert.equal(cfg.roles.verifier.model, "claude-sonnet-5")
  assert.equal(cfg.roles.verifier.maxTurns, 80)
  assert.equal(cfg.roles.reviewer.model, cfg.roles.worker.model)
  assert.equal(cfg.roles.reviewer.maxTurns, 60)
  assert.equal(cfg.roles.reviewer.effort, "high")
  assert.equal(cfg.review.afterSeniorExhaustion, true)
  assert.deepEqual(cfg.review.riskTags, ["money", "concurrency", "data-migration"])
})

test("Fable presets change only the requested role", () => {
  for (const [preset, role] of [["fable-review", "reviewer"], ["fable-coordinator", "coordinator"]]) {
    const configs = python(`print(json.dumps([common.preset_config('opus'),common.preset_config(${JSON.stringify(preset)})]))`)
    assert.equal(configs[1].roles[role].model, "claude-fable-5-1")
    for (const name of Object.keys(configs[0].roles)) {
      if (name !== role) assert.deepEqual(configs[1].roles[name], configs[0].roles[name])
    }
  }
})

test("routing validation rejects unusable models, budgets, policies and missing roles", () => {
  const config = python("print(json.dumps(common.preset_config('opus')))")
  const variants = [
    (c) => { c.roles.worker.model = "opus\npermissionMode: bypassPermissions" },
    (c) => { c.roles.worker.maxTurns = 0 },
    (c) => { c.roles.worker.maxTurns = true },
    (c) => { c.roles.worker.effort = "turbo" },
    (c) => { delete c.roles.verifier },
    (c) => { c.roles.verifier.model = c.roles.worker.model },
    (c) => { c.escalation.workerAttempts = -1 },
    (c) => { c.review.riskTags = "money" },
    (c) => { c.review.afterSeniorExhaustion = "true" },
  ]
  for (const mutate of variants) {
    const changed = JSON.parse(JSON.stringify(config))
    mutate(changed)
    assert.equal(python("\ntry: common.validate_config(data); print('false')\nexcept ValueError: print('true')", changed), true)
  }
})

test("workflow uses configured budgets and requires fresh independent reviews", () => {
  const text = python("c=common.preset_config('opus'); c['escalation']['workerAttempts']=3; print(json.dumps(common.workflow(c)))")
  assert.match(text, /3 attempts/)
  assert.match(text, /worker.*verifier.*coordinator/i)
  assert.match(text, /fresh/i)
  assert.match(text, /resume|fork/)
  assert.match(text, /Haiku.*effort.*unsupported/i)
  assert.match(text, /money.*concurrency.*data-migration/)
})

test("session state cannot escape its directory and is scoped by project and session", () => {
  const paths = python("print(json.dumps([str(common.session_path('/tmp/project-a','../../escape')), str(common.session_path('/tmp/project-a','other')), str(common.session_path('/tmp/project-b','../../escape'))]))")
  assert.equal(new Set(paths).size, 3)
  assert.ok(paths.every((p) => !p.includes("..")))
})

test("on/off and session-start affect only one session without modifying project files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpowers-routing-runtime-"))
  const project = path.join(dir, "project")
  const home = path.join(dir, "home")
  fs.mkdirSync(project)
  fs.mkdirSync(home)
  const run = (args, input) => spawnSync("python3", ["-B", path.join(runtime, "cli.py"), ...args, "--project", project], {
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude") }, input: input ? JSON.stringify(input) : undefined,
    encoding: "utf8", timeout: 10000,
  })
  try {
    const installed = run(["install"])
    assert.equal(installed.status, 0, installed.stderr)
    const snapshot = () => JSON.stringify(fs.readdirSync(project, { recursive: true }).filter((p) => fs.statSync(path.join(project, p)).isFile()).sort().map((p) => [p, fs.readFileSync(path.join(project, p), "utf8")]))
    const before = snapshot()
    const on = run(["on", "--session", "session-a"])
    assert.equal(on.status, 0, on.stderr)
    assert.match(on.stdout, /claude-opus-5-5/)
    const active = run(["session-start"], { session_id: "session-a", cwd: project })
    assert.match(JSON.parse(active.stdout).hookSpecificOutput.additionalContext, /coordinator/i)
    const other = run(["session-start"], { session_id: "session-b", cwd: project })
    assert.deepEqual(JSON.parse(other.stdout), {})
    const smoke = run(["smoke", "--session", "session-a"])
    assert.equal(smoke.status, 0, smoke.stderr)
    assert.match(smoke.stdout, /PASS/)
    const workerPath = path.join(project, ".claude/agents/xpowers-routing-worker.md")
    const worker = fs.readFileSync(workerPath, "utf8")
    fs.writeFileSync(workerPath, worker.replace("claude-opus-5-5", "claude-sonnet-5"))
    assert.equal(run(["smoke", "--session", "session-a"]).status, 1, "smoke must catch edited agent models")
    fs.writeFileSync(workerPath, worker)
    const settingsPath = path.join(project, ".claude/settings.json")
    const settingsBytes = fs.readFileSync(settingsPath, "utf8")
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }))
    assert.equal(run(["smoke", "--session", "session-a"]).status, 1, "smoke must catch missing hook registration")
    fs.writeFileSync(settingsPath, settingsBytes)
    const localSettingsPath = path.join(project, ".claude/settings.local.json")
    fs.writeFileSync(localSettingsPath, JSON.stringify({ disableAllHooks: true }))
    assert.equal(run(["smoke", "--session", "session-a"]).status, 1, "smoke must catch locally disabled hooks")
    fs.unlinkSync(localSettingsPath)
    assert.equal(run(["off", "--session", "session-a"]).status, 0)
    assert.deepEqual(JSON.parse(run(["session-start"], { session_id: "session-a", cwd: project }).stdout), {})
    assert.equal(snapshot(), before)
    const configPath = path.join(project, ".claude/routing.json")
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
    config.roles.worker.maxTurns = 90
    fs.writeFileSync(configPath, JSON.stringify(config))
    const stale = run(["on", "--session", "session-a"])
    assert.equal(stale.status, 1)
    assert.match(stale.stderr, /regenerate|reinstall|setup-claude-routing/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
