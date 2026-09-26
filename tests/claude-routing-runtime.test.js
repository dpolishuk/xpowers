const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { spawn, spawnSync } = require("node:child_process")

const runtime = path.resolve(__dirname, "../scripts/claude-routing")

function installedFixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xpowers-routing-integrity-")))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const project = path.join(dir, "project")
  const home = path.join(dir, "home")
  fs.mkdirSync(project)
  fs.mkdirSync(home)
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), PYTHONDONTWRITEBYTECODE: "1" }
  const run = (args, installed = false) => spawnSync("python3", ["-B", path.join(installed ? path.join(project, ".claude/xpowers-routing") : runtime, "cli.py"), ...args, "--project", project], {
    env, encoding: "utf8", timeout: 10000,
  })
  const result = run(["install"])
  assert.equal(result.status, 0, result.stderr)
  const hash = crypto.createHash("sha256").update(project).digest("hex").slice(0, 24)
  const manifest = path.join(home, ".claude/xpowers-routing", hash, "install-manifest.json")
  return { dir, project, home, env, run, manifest, runtime: path.join(project, ".claude/xpowers-routing") }
}

function assertSuccess(result) { assert.equal(result.status, 0, result.stderr) }

function routingCommand(project, session, name = "routing-on") {
  const markdown = fs.readFileSync(path.join(project, `.claude/commands/${name}.md`), "utf8")
  const match = markdown.match(/```bash\n([^\n]+)\n```/)
  assert.ok(match, `missing executable command in ${name}`)
  return match[1].replaceAll("${CLAUDE_SESSION_ID}", session)
}

function observeActivation(f, session, overrides = {}) {
  const cli = path.join(f.project, ".claude/xpowers-routing/cli.py")
  const command = routingCommand(f.project, session)
  const payload = {
    hook_event_name: "PreToolUse",
    session_id: session,
    tool_use_id: `tool-${session}`,
    cwd: f.project,
    tool_name: "Bash",
    tool_input: { command, description: "activate routing", timeout: 10000, run_in_background: false },
    ...overrides,
  }
  const result = spawnSync("python3", ["-B", cli, "guard", "--project", f.project], {
    env: f.env, cwd: f.project, input: JSON.stringify(payload), encoding: "utf8", timeout: 10000,
  })
  assertSuccess(result)
  return { command, payload, output: JSON.parse(result.stdout) }
}

function executeObserved(f, observation) {
  const command = observation.output.hookSpecificOutput?.updatedInput?.command
  assert.ok(command, "installed PreToolUse guard did not attest the activation command")
  return spawnSync("bash", ["-c", command], {
    env: f.env, cwd: f.project, encoding: "utf8", timeout: 10000,
  })
}

function activationPath(f, session) {
  const hash = crypto.createHash("sha256").update(session).digest("hex")
  return path.join(path.dirname(f.manifest), "activation-proofs", `${hash}.json`)
}

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

test("activation requires and consumes a live installed PreToolUse proof", t => {
  const f = installedFixture(t)
  const direct = f.run(["on", "--session", "proof-session"], true)
  assert.equal(direct.status, 1)
  assert.equal(f.run(["status", "--session", "proof-session"]).stdout.trim(), "OFF")

  const observed = observeActivation(f, "proof-session")
  const hook = observed.output.hookSpecificOutput
  assert.equal(hook.hookEventName, "PreToolUse")
  assert.equal(hook.permissionDecision, undefined)
  assert.equal(hook.updatedInput.description, "activate routing")
  assert.equal(hook.updatedInput.timeout, 10000)
  assert.equal(hook.updatedInput.run_in_background, false)
  assert.match(hook.updatedInput.command, /--hook-token [0-9a-f]+$/)
  assertSuccess(executeObserved(f, observed))
  assert.equal(f.run(["status", "--session", "proof-session"]).stdout.trim(), "ON")

  const replay = executeObserved(f, observed)
  assert.equal(replay.status, 1)
  assert.equal(f.run(["status", "--session", "proof-session"]).stdout.trim(), "OFF")
})

test("activation proofs are session-bound, fresh and superseded", t => {
  const f = installedFixture(t)

  const wrongToken = observeActivation(f, "wrong-token")
  const wrongTokenCommand = wrongToken.output.hookSpecificOutput.updatedInput.command.replace(/--hook-token [0-9a-f]+$/, "--hook-token deadbeef")
  assert.notEqual(spawnSync("bash", ["-c", wrongTokenCommand], { env: f.env, cwd: f.project }).status, 0)
  assert.equal(fs.existsSync(activationPath(f, "wrong-token")), false)
  assertSuccess(executeObserved(f, observeActivation(f, "wrong-token")))
  assertSuccess(f.run(["off", "--session", "wrong-token"]))

  const wrongSession = observeActivation(f, "bound-session")
  const wrongSessionCommand = wrongSession.output.hookSpecificOutput.updatedInput.command.replace('--session "bound-session"', '--session "other-session"')
  assert.notEqual(spawnSync("bash", ["-c", wrongSessionCommand], { env: f.env, cwd: f.project }).status, 0)
  assertSuccess(executeObserved(f, wrongSession))
  assertSuccess(f.run(["off", "--session", "bound-session"]))

  const expired = observeActivation(f, "expired-session")
  const receipt = JSON.parse(fs.readFileSync(activationPath(f, "expired-session"), "utf8"))
  receipt.issuedAt = Date.now() / 1000 - 301
  fs.writeFileSync(activationPath(f, "expired-session"), JSON.stringify(receipt))
  assert.notEqual(executeObserved(f, expired).status, 0)
  assert.equal(fs.existsSync(activationPath(f, "expired-session")), false)
  assert.equal(f.run(["status", "--session", "expired-session"]).stdout.trim(), "OFF")

  const malformed = observeActivation(f, "malformed-session")
  fs.writeFileSync(activationPath(f, "malformed-session"), "not json\n")
  assert.notEqual(executeObserved(f, malformed).status, 0)
  assert.equal(fs.existsSync(activationPath(f, "malformed-session")), false)
  assert.equal(f.run(["status", "--session", "malformed-session"]).stdout.trim(), "OFF")

  const malformedShape = observeActivation(f, "malformed-shape")
  fs.writeFileSync(activationPath(f, "malformed-shape"), "[]\n")
  assert.notEqual(executeObserved(f, malformedShape).status, 0)
  assert.equal(fs.existsSync(activationPath(f, "malformed-shape")), false)
  assert.equal(f.run(["status", "--session", "malformed-shape"]).stdout.trim(), "OFF")

  const superseded = observeActivation(f, "superseded-session")
  observeActivation(f, "superseded-session")
  assert.notEqual(executeObserved(f, superseded).status, 0)
  assert.equal(fs.existsSync(activationPath(f, "superseded-session")), false)
  assertSuccess(executeObserved(f, observeActivation(f, "superseded-session")))
})

test("only a qualifying live main-session hook can mint an activation proof", t => {
  const f = installedFixture(t)
  for (const [name, overrides] of [
    ["delegated", { agent_id: "agent-123", agent_type: "xpowers-routing-worker" }],
    ["missing tool use", { tool_use_id: undefined }],
    ["wrong hook event", { hook_event_name: "PostToolUse" }],
  ]) {
    const session = name.replaceAll(" ", "-")
    const observed = observeActivation(f, session, overrides)
    assert.equal(observed.output.hookSpecificOutput?.updatedInput, undefined, name)
    assert.equal(fs.existsSync(activationPath(f, session)), false, name)
  }

  const sourceSession = "source-runtime"
  const sourcePayload = {
    hook_event_name: "PreToolUse", session_id: sourceSession, tool_use_id: "tool-source",
    cwd: f.project, tool_name: "Bash", tool_input: { command: routingCommand(f.project, sourceSession) },
  }
  const sourceGuard = spawnSync("python3", ["-B", path.join(runtime, "cli.py"), "guard", "--project", f.project], {
    env: f.env, cwd: f.project, input: JSON.stringify(sourcePayload), encoding: "utf8", timeout: 10000,
  })
  assertSuccess(sourceGuard)
  assert.equal(JSON.parse(sourceGuard.stdout).hookSpecificOutput.permissionDecision, "deny")
  assert.equal(fs.existsSync(activationPath(f, sourceSession)), false)

  assertSuccess(executeObserved(f, observeActivation(f, "source-on")))
  assert.equal(f.run(["on", "--session", "source-on"]).status, 1)
  assert.equal(f.run(["status", "--session", "source-on"]).stdout.trim(), "OFF")

  const observed = observeActivation(f, "smoke-session")
  assertSuccess(executeObserved(f, observed))
  assert.equal(fs.existsSync(activationPath(f, "smoke-session")), false)
  assertSuccess(f.run(["smoke", "--session", "smoke-session"], true))
  assert.equal(fs.existsSync(activationPath(f, "smoke-session")), false, "synthetic smoke minted a proof")
})

test("off, reinstall and restore invalidate pending activation proofs", t => {
  const f = installedFixture(t)

  const stopped = observeActivation(f, "off-proof")
  assertSuccess(f.run(["off", "--session", "off-proof"]))
  assert.notEqual(executeObserved(f, stopped).status, 0)

  const reinstalled = observeActivation(f, "reinstall-proof")
  assertSuccess(f.run(["install"]))
  assert.notEqual(executeObserved(f, reinstalled).status, 0)

  const restored = observeActivation(f, "restore-proof")
  assertSuccess(f.run(["install", "--restore"]))
  assertSuccess(f.run(["install"]))
  assert.notEqual(executeObserved(f, restored).status, 0)
  assert.equal(f.run(["status", "--session", "restore-proof"]).stdout.trim(), "OFF")
})

test("generated commands work through the guard after Claude substitutes the session ID", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xpowers-routing-commands-")))
  const project = path.join(dir, "project with spaces")
  const home = path.join(dir, "home")
  fs.mkdirSync(project)
  fs.mkdirSync(home)
  const session = "501ac37b-9e0e-4990-b4a2-caf5d08728a2"
  // Local command content is substituted by Claude before Bash/PreToolUse.
  // A conflicting shell environment must never select the session instead.
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CLAUDE_SESSION_ID: "different-shell-session" }
  const invoke = (file, args, input) => spawnSync(file, args, { env, cwd: project, input, encoding: "utf8", timeout: 10000 })
  try {
    const installed = invoke("python3", ["-B", path.join(runtime, "cli.py"), "install", "--project", project])
    assert.equal(installed.status, 0, installed.stderr)
    const cli = path.join(project, ".claude/xpowers-routing/cli.py")
    const guard = (command, toolUseId) => {
      const result = invoke("python3", ["-B", cli, "guard", "--project", project], JSON.stringify({
        hook_event_name: "PreToolUse", session_id: session, tool_use_id: toolUseId,
        cwd: project, tool_name: "Bash", tool_input: { command },
      }))
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(result.stdout)
    }
    const template = (name) => {
      const markdown = fs.readFileSync(path.join(project, `.claude/commands/${name}.md`), "utf8")
      const match = markdown.match(/```bash\n([^\n]+)\n```/)
      assert.ok(match, `missing executable command in ${name}`)
      assert.ok(match[1].includes("${CLAUDE_SESSION_ID}"))
      return match[1]
    }
    for (const name of ["routing-on", "routing-smoke-test", "routing-off"]) {
      const command = template(name).replaceAll("${CLAUDE_SESSION_ID}", session)
      if (name === "routing-on") assert.doesNotMatch(command, /--hook-token/)
      const decision = guard(command, `tool-${name}`)
      if (name === "routing-on") {
        assert.equal(decision.hookSpecificOutput.permissionDecision, undefined)
        assert.match(decision.hookSpecificOutput.updatedInput.command, /--hook-token/)
      } else {
        assert.deepEqual(decision, {}, name)
      }
      const result = invoke("bash", ["-c", decision.hookSpecificOutput?.updatedInput?.command || command])
      assert.equal(result.status, 0, `${name}: ${result.stderr}`)
      if (name === "routing-smoke-test") assert.match(result.stdout, /PASS/)
      if (name === "routing-on") {
        for (const invalid of [template("routing-off"), template("routing-off").replaceAll("${CLAUDE_SESSION_ID}", "other-session")]) {
          assert.equal(guard(invalid, "tool-invalid").hookSpecificOutput.permissionDecision, "deny")
        }
      }
    }
    const status = invoke("python3", ["-B", cli, "status", "--project", project, "--session", session])
    assert.equal(status.status, 0, status.stderr)
    assert.equal(status.stdout.trim(), "OFF")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("on/off and session-start affect only one session without modifying project files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpowers-routing-runtime-"))
  const project = path.join(dir, "project")
  const home = path.join(dir, "home")
  const configDir = path.join(home, "custom-claude")
  fs.mkdirSync(project)
  fs.mkdirSync(home)
  const run = (args, input) => spawnSync("python3", ["-B", path.join(runtime, "cli.py"), ...args, "--project", project], {
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: configDir }, input: input ? JSON.stringify(input) : undefined,
    encoding: "utf8", timeout: 10000,
  })
  try {
    const installed = run(["install"])
    assert.equal(installed.status, 0, installed.stderr)
    const routing = { project, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: configDir } }
    const snapshot = () => JSON.stringify(fs.readdirSync(project, { recursive: true }).filter((p) => fs.statSync(path.join(project, p)).isFile()).sort().map((p) => [p, fs.readFileSync(path.join(project, p), "utf8")]))
    const before = snapshot()
    const on = executeObserved(routing, observeActivation(routing, "session-a"))
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
    fs.mkdirSync(configDir, { recursive: true })
    const globalSettings = path.join(configDir, "settings.json")
    fs.writeFileSync(globalSettings, JSON.stringify({ disableAllHooks: true }))
    assert.equal(run(["smoke", "--session", "session-a"]).status, 1, "smoke must check the effective user settings directory")
    fs.unlinkSync(globalSettings)
    // Claude supports project-local settings.local.json, but no user-level
    // settings.local.json scope. An unused file must not disable routing.
    fs.writeFileSync(path.join(configDir, "settings.local.json"), JSON.stringify({ disableAllHooks: true }))
    assert.equal(run(["smoke", "--session", "session-a"]).status, 0)
    assert.equal(run(["off", "--session", "session-a"]).status, 0)
    assert.deepEqual(JSON.parse(run(["session-start"], { session_id: "session-a", cwd: project }).stdout), {})
    assert.equal(snapshot(), before)
    const configPath = path.join(project, ".claude/routing.json")
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
    const staleProof = observeActivation(routing, "session-a")
    config.roles.worker.maxTurns = 90
    fs.writeFileSync(configPath, JSON.stringify(config))
    const stale = executeObserved(routing, staleProof)
    assert.equal(stale.status, 1)
    assert.match(stale.stderr, /regenerate|reinstall|setup-claude-routing/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("activation and smoke reject changed or missing installed runtime modules", t => {
  const f = installedFixture(t)
  assertSuccess(executeObserved(f, observeActivation(f, "already-active")))
  for (const name of ["guard.py", "cli.py", "common.py", "install.py"]) {
    const target = path.join(f.runtime, name)
    const original = fs.readFileSync(target)
    for (const action of ["modified", "missing"]) {
      const proof = observeActivation(f, `drift-${name}-${action}`)
      if (action === "modified") fs.writeFileSync(target, name === "guard.py" ? "def handle(data, project): return {}\n" : "# accidental truncation\n")
      else fs.unlinkSync(target)
      const on = executeObserved(f, proof)
      if (name === "guard.py") {
        assert.equal(on.status, 1, `${name} ${action} must block activation`)
        assert.match(on.stderr, /runtime.*(changed|missing|modified)/i)
      }
      // An erased CLI or startup dependency cannot validate itself, but none
      // may turn the session on. The external profile check diagnoses drift.
      assert.equal(f.run(["status", "--session", `drift-${name}-${action}`]).stdout.trim(), "OFF")
      const smoke = f.run(["smoke", "--session", "already-active"])
      assert.equal(smoke.status, 1, `${name} ${action} must fail smoke`)
      assert.match(smoke.stderr, /runtime.*(changed|missing|modified)/i)
      if (name === "guard.py") {
        const installedSmoke = f.run(["smoke", "--session", "already-active"], true)
        assert.equal(installedSmoke.status, 1)
        assert.match(installedSmoke.stderr, /runtime.*guard\.py/i)
      }
      fs.writeFileSync(target, original)
    }
  }
  assertSuccess(f.run(["smoke", "--session", "already-active"], true))
})

test("installed activation rejects a guard that silently allows project writes", t => {
  const f = installedFixture(t)
  fs.writeFileSync(path.join(f.runtime, "guard.py"), "def handle(data, project): return {}\n")
  const observed = observeActivation(f, "changed-guard")
  assert.equal(observed.output.hookSpecificOutput.permissionDecision, "deny")
  assert.match(observed.output.hookSpecificOutput.permissionDecisionReason, /runtime.*guard\.py/i)
  assert.equal(fs.existsSync(activationPath(f, "changed-guard")), false)
  assert.equal(f.run(["status", "--session", "changed-guard"]).stdout.trim(), "OFF")
})

test("runtime integrity requires ownership snapshots and covers extra helper modules", t => {
  const f = installedFixture(t)
  const original = fs.readFileSync(f.manifest, "utf8")
  const missingProof = observeActivation(f, "missing-backup")
  fs.unlinkSync(f.manifest)
  const missing = executeObserved(f, missingProof)
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /ownership.*(backup|manifest).*missing|missing.*ownership/i)
  const manifest = JSON.parse(original)
  delete manifest.files["xpowers-routing/guard.py"]
  fs.writeFileSync(f.manifest, original)
  const missingSnapshotProof = observeActivation(f, "missing-snapshot")
  fs.writeFileSync(f.manifest, JSON.stringify(manifest))
  const missingSnapshot = executeObserved(f, missingSnapshotProof)
  assert.equal(missingSnapshot.status, 1)
  assert.match(missingSnapshot.stderr, /snapshot.*guard\.py|guard\.py.*snapshot/i)
  const complete = JSON.parse(original)
  const helper = path.join(f.runtime, "future-helper.py")
  fs.writeFileSync(helper, "# helper\n")
  complete.files["xpowers-routing/future-helper.py"] = { before: null, installed: { data: Buffer.from("# helper\n").toString("base64"), mode: fs.statSync(helper).mode & 0o777 } }
  fs.writeFileSync(f.manifest, JSON.stringify(complete))
  assertSuccess(executeObserved(f, observeActivation(f, "valid-helper")))
  const changedHelperProof = observeActivation(f, "changed-helper")
  fs.writeFileSync(helper, "# drift\n")
  const changedHelper = executeObserved(f, changedHelperProof)
  assert.equal(changedHelper.status, 1)
  assert.match(changedHelper.stderr, /runtime.*future-helper\.py/i)
})

test("activation and restore serialize so reinstall cannot revive the old session", async t => {
  const f = installedFixture(t)
  const observed = observeActivation(f, "concurrent-session")
  const hookToken = observed.output.hookSpecificOutput.updatedInput.command.match(/--hook-token ([0-9a-f]+)$/)[1]
  const paused = path.join(f.dir, "activation-validated")
  const restoreAttempted = path.join(f.dir, "restore-attempted")
  const restoreFinished = path.join(f.dir, "restore-finished")
  const release = path.join(f.dir, "release-activation")
  const start = code => {
    const child = spawn("python3", ["-B", "-c", code, f.runtime, f.project, paused, restoreAttempted, release], { env: f.env })
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
  const on = start(`import sys,time
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import cli
project,paused,release=sys.argv[2],Path(sys.argv[3]),Path(sys.argv[5])
check=cli.check_profile
def pause_after_check(project, config):
    manifest=check(project,config)
    paused.touch()
    deadline=time.monotonic()+8
    while not release.exists():
        if time.monotonic()>deadline: raise RuntimeError('activation was not released')
        time.sleep(0.01)
    return manifest
cli.check_profile=pause_after_check
sys.argv=['cli.py','on','--project',project,'--session','concurrent-session','--hook-token',${JSON.stringify(hookToken)}]
raise SystemExit(cli.main())
`)
  await waitFor(paused)
  const restore = start(`import sys,contextlib,fcntl
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import install,common
project,attempted=Path(sys.argv[2]),Path(sys.argv[4])
lock=install._locked
@contextlib.contextmanager
def observe_restore_lock(project):
    with (common.control_dir(project)/'install.lock').open('a+b') as probe:
        try:
            fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            attempted.write_text('blocked')
        else:
            attempted.write_text('available')
            fcntl.flock(probe,fcntl.LOCK_UN)
    with lock(project) as control: yield control
install._locked=observe_restore_lock
install.restore(project)
attempted.with_name('restore-finished').touch()
`)
  await waitFor(restoreAttempted)
  // A nonblocking probe proves whether activation owns the install lock. If it
  // does not, complete restore before releasing activation to expose the race.
  if (fs.readFileSync(restoreAttempted, "utf8") !== "blocked") await waitFor(restoreFinished)
  fs.writeFileSync(release, "continue\n")
  const results = await Promise.all([on, restore])
  results.forEach(assertSuccess)
  assertSuccess(f.run(["install"]))
  assert.equal(f.run(["status", "--session", "concurrent-session"]).stdout.trim(), "OFF")
})

test("activation after restore fails and leaves its old session disabled", t => {
  const f = installedFixture(t)
  assertSuccess(executeObserved(f, observeActivation(f, "restored-session")))
  assertSuccess(f.run(["install", "--restore"]))
  assert.equal(f.run(["on", "--session", "restored-session"]).status, 1)
  assertSuccess(f.run(["install"]))
  assert.equal(f.run(["status", "--session", "restored-session"]).stdout.trim(), "OFF")
})
