const test = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawn, spawnSync } = require("node:child_process")

const repoRoot = path.resolve(__dirname, "..")
const tmPath = path.join(repoRoot, "scripts", "tm")
const acceptancePath = path.join(repoRoot, "scripts", "tm-acceptance.js")

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeout || 15000,
  })
  assert.equal(result.error, undefined, result.error?.message)
  return result
}

function git(repo, ...args) {
  const result = run("git", args, { cwd: repo })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tm-acceptance-"))
  const repo = path.join(root, "repo")
  const bin = path.join(root, "bin")
  const backendLog = path.join(root, "br-calls.jsonl")
  fs.mkdirSync(repo)
  fs.mkdirSync(bin)
  fs.mkdirSync(path.join(repo, ".beads"))
  fs.mkdirSync(path.join(repo, ".xpowers"))
  fs.writeFileSync(path.join(repo, ".beads", "config.yaml"), "tm.backend: br\n")
  fs.writeFileSync(path.join(repo, "app.txt"), "version one\n")
  fs.writeFileSync(path.join(repo, ".xpowers", "acceptance.json"), JSON.stringify({
    version: 1,
    checks: [{ id: "tests", command: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 5000 }],
  }, null, 2) + "\n")
  fs.writeFileSync(path.join(bin, "br"), [
    "#!/usr/bin/env node",
    "const fs = require('node:fs')",
    `fs.appendFileSync(${JSON.stringify(backendLog)}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
    "const waitForRelease = (delayMs, complete) => {",
    "  const release = process.env.BR_RELEASE_FILE",
    "  if (!release) return setTimeout(complete, delayMs)",
    "  const poll = setInterval(() => {",
    "    if (!fs.existsSync(release)) return",
    "    clearInterval(poll)",
    "    complete()",
    "  }, 10)",
    "}",
    "if (process.env.BR_SIGNAL_MARKER) {",
    "  let handling = false",
    "  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {",
    "    if (handling) return",
    "    handling = true",
    "    fs.writeFileSync(process.env.BR_SIGNAL_MARKER, signal)",
    "    waitForRelease(Number(process.env.BR_SIGNAL_DELAY_MS || 0), () => {",
    "      fs.writeFileSync(process.env.BR_SIGNAL_DONE, `done:${signal}`)",
    "      process.exit(0)",
    "    })",
    "  })",
    "  if (process.env.BR_SIGNAL_READY) fs.writeFileSync(process.env.BR_SIGNAL_READY, 'ready')",
    "  setInterval(() => {}, 1000)",
    "} else {",
    "  waitForRelease(Number(process.env.BR_DELAY_MS || 0), () => process.exit(Number(process.env.BR_EXIT_CODE || 0)))",
    "}",
    "",
  ].join("\n"))
  fs.chmodSync(path.join(bin, "br"), 0o755)
  git(repo, "init")
  git(repo, "config", "user.email", "acceptance@example.invalid")
  git(repo, "config", "user.name", "Acceptance Test")
  git(repo, "add", ".")
  git(repo, "commit", "-m", "fixture")

  return {
    root,
    repo,
    backendLog,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
      TM_BACKEND: "br",
      TM_REPO_ROOT: repo,
    },
  }
}

function runTm(fixture, args, options = {}) {
  return run(tmPath, args, {
    cwd: fixture.repo,
    env: { ...fixture.env, ...options.env },
    timeout: options.timeout,
  })
}

function policy(checks) {
  return JSON.stringify({ version: 1, checks }, null, 2) + "\n"
}

function writePolicy(fixture, checks) {
  fs.writeFileSync(path.join(fixture.repo, ".xpowers", "acceptance.json"), policy(checks))
}

function passingCheck() {
  return { id: "tests", command: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 5000 }
}

function addTrackedDirectoryLink(fixture, options = {}) {
  const targetName = options.targetName || "generated-dir"
  const linkName = options.linkName || "dependency-link"
  const target = path.join(fixture.repo, targetName)
  fs.mkdirSync(path.join(target, "empty"), { recursive: true })
  fs.writeFileSync(path.join(target, "dependency.js"), "module.exports = 1\n")
  fs.appendFileSync(path.join(fixture.repo, ".gitignore"), `/${targetName}/\n`)
  fs.symlinkSync(targetName, path.join(fixture.repo, linkName))
  git(fixture.repo, "add", ".gitignore", linkName)
  git(fixture.repo, "commit", "-m", `track ${linkName}`)
  return { target, link: path.join(fixture.repo, linkName) }
}

function backendCalls(fixture) {
  if (!fs.existsSync(fixture.backendLog)) return []
  return fs.readFileSync(fixture.backendLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (status, signal) => resolve({ status, signal }))
  })
}

function killChildGroup(child, signal) {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== "ESRCH") throw error
  }
}

async function releaseAndWaitForChild(child, exitPromise, releaseFile, timeoutMs = 5000) {
  if (releaseFile && !fs.existsSync(releaseFile)) fs.writeFileSync(releaseFile, "release\n")
  if (!child || !exitPromise) return null

  const waitBounded = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs)
    exitPromise.then(
      outcome => { clearTimeout(timeout); resolve(outcome) },
      error => { clearTimeout(timeout); reject(error) },
    )
  })
  let outcome = await waitBounded()
  if (outcome) return outcome

  killChildGroup(child, "SIGTERM")
  outcome = await waitBounded()
  if (outcome) return outcome

  killChildGroup(child, "SIGKILL")
  outcome = await waitBounded()
  if (outcome) return outcome
  throw new Error("child process group did not exit after SIGKILL")
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("condition not met before timeout")
}

test("stale acceptance evidence blocks close before backend dispatch", () => {
  const fixture = makeFixture()
  try {
    const accepted = run(tmPath, ["acceptance", "run", "bd-test.1"], {
      cwd: fixture.repo,
      env: fixture.env,
    })
    assert.equal(accepted.status, 0, accepted.stderr)
    fs.writeFileSync(fixture.backendLog, "")

    fs.writeFileSync(path.join(fixture.repo, "app.txt"), "version two\n")
    const closed = run(tmPath, ["close", "bd-test.1"], {
      cwd: fixture.repo,
      env: fixture.env,
    })

    assert.equal(closed.status, 1, closed.stderr)
    assert.match(closed.stderr, /acceptance evidence is stale/i)
    assert.equal(fs.readFileSync(fixture.backendLog, "utf8"), "")
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("current acceptance evidence dispatches all explicit ids to br once", () => {
  const fixture = makeFixture()
  try {
    for (const task of ["bd-one", "bd-two.1"]) {
      const accepted = runTm(fixture, ["acceptance", "run", task])
      assert.equal(accepted.status, 0, accepted.stderr)
    }
    fs.writeFileSync(fixture.backendLog, "")

    const closed = runTm(fixture, ["close", "bd-one", "bd-two.1"])
    assert.equal(closed.status, 0, closed.stderr)
    assert.deepEqual(backendCalls(fixture), [["close", "bd-one", "bd-two.1"]])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("a failed latest run supersedes an older passing receipt", () => {
  const fixture = makeFixture()
  try {
    const original = fs.readFileSync(path.join(fixture.repo, ".xpowers", "acceptance.json"), "utf8")
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-retry"]).status, 0)
    writePolicy(fixture, [{ id: "tests", command: [process.execPath, "-e", "process.exit(9)"], timeoutMs: 5000 }])
    const failed = runTm(fixture, ["acceptance", "run", "bd-retry"])
    assert.equal(failed.status, 1)
    fs.writeFileSync(path.join(fixture.repo, ".xpowers", "acceptance.json"), original)
    fs.writeFileSync(fixture.backendLog, "")

    const closed = runTm(fixture, ["close", "bd-retry"])
    assert.equal(closed.status, 1)
    assert.match(closed.stderr, /latest acceptance run is failed/i)
    assert.deepEqual(backendCalls(fixture), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("a check command that edits the worktree cannot create eligible evidence", () => {
  const fixture = makeFixture()
  try {
    writePolicy(fixture, [{
      id: "mutator",
      command: [process.execPath, "-e", "require('node:fs').writeFileSync('app.txt', 'mutated\\n')"],
      timeoutMs: 5000,
    }])
    const accepted = runTm(fixture, ["acceptance", "run", "bd-mutator"])
    assert.equal(accepted.status, 1)
    assert.match(accepted.stderr, /changed while acceptance checks ran/i)
    fs.writeFileSync(fixture.backendLog, "")

    const closed = runTm(fixture, ["close", "bd-mutator"])
    assert.equal(closed.status, 1)
    assert.deepEqual(backendCalls(fixture), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("acceptance check is read-only and never executes project commands", () => {
  const fixture = makeFixture()
  const marker = path.join(fixture.root, "command-ran")
  try {
    writePolicy(fixture, [{
      id: "marker",
      command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
      timeoutMs: 5000,
    }])
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-read-only"]).status, 0)
    fs.unlinkSync(marker)

    const checked = runTm(fixture, ["acceptance", "check", "bd-read-only"])
    assert.equal(checked.status, 0, checked.stderr)
    assert.equal(fs.existsSync(marker), false)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("timeout and output overflow fail closed", () => {
  for (const scenario of [
    { id: "timeout", command: [process.execPath, "-e", "setTimeout(() => {}, 10000)"], timeoutMs: 20, message: /timed-out/ },
    { id: "output", command: [process.execPath, "-e", "process.stdout.write('x'.repeat(70000))"], timeoutMs: 5000, message: /output-limit/ },
  ]) {
    const fixture = makeFixture()
    try {
      writePolicy(fixture, [{ id: scenario.id, command: scenario.command, timeoutMs: scenario.timeoutMs }])
      const accepted = runTm(fixture, ["acceptance", "run", `bd-${scenario.id}`])
      assert.equal(accepted.status, 1)
      assert.match(accepted.stderr, scenario.message)
      fs.writeFileSync(fixture.backendLog, "")
      assert.equal(runTm(fixture, ["close", `bd-${scenario.id}`]).status, 1)
      assert.deepEqual(backendCalls(fixture), [])
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

test("literal argv is never interpreted by a shell", () => {
  const fixture = makeFixture()
  const touched = path.join(fixture.root, "shell-expanded")
  const marker = path.join(fixture.root, "argv.json")
  const literal = `$(touch ${touched})`
  try {
    writePolicy(fixture, [{
      id: "argv",
      command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv[1]))`, literal],
      timeoutMs: 5000,
    }])
    const accepted = runTm(fixture, ["acceptance", "run", "bd-argv"])
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")), literal)
    assert.equal(fs.existsSync(touched), false)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("index-only changes and ignored former tracked files make evidence stale", () => {
  const fixture = makeFixture()
  try {
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-index"]).status, 0)
    fs.writeFileSync(path.join(fixture.repo, "app.txt"), "staged version\n")
    git(fixture.repo, "add", "app.txt")
    fs.writeFileSync(path.join(fixture.repo, "app.txt"), "version one\n")
    assert.equal(runTm(fixture, ["acceptance", "check", "bd-index"]).status, 1)

    git(fixture.repo, "reset", "HEAD", "app.txt")
    fs.writeFileSync(path.join(fixture.repo, "legacy.txt"), "legacy one\n")
    git(fixture.repo, "add", "legacy.txt")
    git(fixture.repo, "commit", "-m", "add legacy")
    git(fixture.repo, "rm", "--cached", "legacy.txt")
    fs.writeFileSync(path.join(fixture.repo, ".gitignore"), "legacy.txt\n")
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-head-union"]).status, 0)
    fs.writeFileSync(path.join(fixture.repo, "legacy.txt"), "legacy two\n")
    assert.equal(runTm(fixture, ["acceptance", "check", "bd-head-union"]).status, 1)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("semantic Git index flags make acceptance evidence stale", () => {
  const fixture = makeFixture()
  try {
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-assume-unchanged"]).status, 0)
    git(fixture.repo, "update-index", "--assume-unchanged", "app.txt")
    assert.equal(runTm(fixture, ["acceptance", "check", "bd-assume-unchanged"]).status, 1)
    git(fixture.repo, "update-index", "--no-assume-unchanged", "app.txt")

    assert.equal(runTm(fixture, ["acceptance", "run", "bd-skip-worktree"]).status, 0)
    git(fixture.repo, "update-index", "--skip-worktree", "app.txt")
    assert.equal(runTm(fixture, ["acceptance", "check", "bd-skip-worktree"]).status, 1)
    git(fixture.repo, "update-index", "--no-skip-worktree", "app.txt")

    const empty = path.join(fixture.repo, "intent-empty.txt")
    fs.writeFileSync(empty, "")
    git(fixture.repo, "add", "-N", "intent-empty.txt")
    const itaStage = git(fixture.repo, "ls-files", "--stage", "intent-empty.txt")
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-intent-to-add"]).status, 0)
    git(fixture.repo, "add", "intent-empty.txt")
    assert.equal(git(fixture.repo, "ls-files", "--stage", "intent-empty.txt"), itaStage)
    assert.equal(runTm(fixture, ["acceptance", "check", "bd-intent-to-add"]).status, 1)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("semantic index flags for excluded task records do not stale evidence", () => {
  const fixture = makeFixture()
  try {
    fs.writeFileSync(path.join(fixture.repo, ".beads", "task-cache.txt"), "cache\n")
    fs.writeFileSync(path.join(fixture.repo, ".beads", "task-empty.txt"), "")
    git(fixture.repo, "add", ".beads/task-cache.txt", ".beads/task-empty.txt")
    git(fixture.repo, "commit", "-m", "add excluded task records")
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-excluded-index-flags"]).status, 0)

    git(fixture.repo, "update-index", "--assume-unchanged", ".beads/task-cache.txt")
    assert.equal(runTm(fixture, ["acceptance", "check", "bd-excluded-index-flags"]).status, 0)
    git(fixture.repo, "update-index", "--no-assume-unchanged", ".beads/task-cache.txt")
    git(fixture.repo, "update-index", "--skip-worktree", ".beads/task-cache.txt")
    assert.equal(runTm(fixture, ["acceptance", "check", "bd-excluded-index-flags"]).status, 0)
    git(fixture.repo, "update-index", "--no-skip-worktree", ".beads/task-cache.txt")
    git(fixture.repo, "rm", "--cached", ".beads/task-empty.txt")
    git(fixture.repo, "add", "-N", ".beads/task-empty.txt")
    assert.equal(runTm(fixture, ["acceptance", "check", "bd-excluded-index-flags"]).status, 0)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("symbolic and detached HEAD identity make acceptance evidence stale", () => {
  const fixture = makeFixture()
  const originalBranch = git(fixture.repo, "branch", "--show-current")
  try {
    git(fixture.repo, "branch", "acceptance-same-tip")
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-symbolic-head"]).status, 0)
    git(fixture.repo, "switch", "acceptance-same-tip")
    assert.equal(runTm(fixture, ["acceptance", "check", "bd-symbolic-head"]).status, 1)

    git(fixture.repo, "switch", originalBranch)
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-detached-head"]).status, 0)
    git(fixture.repo, "switch", "--detach")
    assert.equal(runTm(fixture, ["acceptance", "check", "bd-detached-head"]).status, 1)
  } finally {
    run("git", ["switch", originalBranch], { cwd: fixture.repo })
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("a same-tip branch switch during checks invalidates the run", () => {
  const fixture = makeFixture()
  try {
    git(fixture.repo, "branch", "acceptance-switch-during-check")
    writePolicy(fixture, [{
      id: "switch-branch",
      command: ["git", "switch", "acceptance-switch-during-check"],
      timeoutMs: 5000,
    }])
    const accepted = runTm(fixture, ["acceptance", "run", "bd-switch-during-check"])
    assert.equal(accepted.status, 1)
    assert.match(accepted.stderr, /worktree or policy changed while acceptance checks ran/i)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("task-store selector files are fingerprinted while task records stay excluded", () => {
  const fixture = makeFixture()
  try {
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-selector-missing"]).status, 0)
    fs.writeFileSync(path.join(fixture.repo, ".beads", "metadata.json"), '{"database":"beads.db"}\n')
    fs.writeFileSync(fixture.backendLog, "")
    const created = runTm(fixture, ["close", "bd-selector-missing"])
    assert.equal(created.status, 1)
    assert.match(created.stderr, /evidence is stale/i)
    assert.deepEqual(backendCalls(fixture), [])

    assert.equal(runTm(fixture, ["acceptance", "run", "bd-selector-content"]).status, 0)
    fs.writeFileSync(path.join(fixture.repo, ".beads", "config.yaml"), "tm.backend: br\nselector: changed\n")
    const changed = runTm(fixture, ["close", "bd-selector-content"])
    assert.equal(changed.status, 1)
    assert.match(changed.stderr, /evidence is stale/i)
    assert.deepEqual(backendCalls(fixture), [])

    assert.equal(runTm(fixture, ["acceptance", "run", "bd-task-record"]).status, 0)
    fs.writeFileSync(path.join(fixture.repo, ".beads", "issues.jsonl"), '{"id":"one"}\n')
    fs.appendFileSync(path.join(fixture.repo, ".beads", "issues.jsonl"), '{"id":"two"}\n')
    const ordinary = runTm(fixture, ["close", "bd-task-record"])
    assert.equal(ordinary.status, 0, ordinary.stderr)
    assert.deepEqual(backendCalls(fixture), [["close", "bd-task-record"]])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("unsafe task-store selector nodes fail closed", () => {
  const fixture = makeFixture()
  try {
    const metadata = path.join(fixture.repo, ".beads", "metadata.json")
    fs.symlinkSync(path.join(fixture.root, "outside-metadata.json"), metadata)
    fs.writeFileSync(path.join(fixture.root, "outside-metadata.json"), "{}\n")
    const accepted = runTm(fixture, ["acceptance", "run", "bd-selector-symlink"])
    assert.equal(accepted.status, 1)
    assert.match(accepted.stderr, /task-store selector.*regular file|symlink.*unsupported/i)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("task-store redirects added after acceptance refuse wrapper and direct-runtime operations", () => {
  const fixture = makeFixture()
  try {
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-redirect"]).status, 0)
    fs.writeFileSync(path.join(fixture.repo, ".beads", "redirect"), `${path.join(fixture.root, "target-beads")}\n`)
    fs.writeFileSync(fixture.backendLog, "")

    for (const args of [["acceptance", "check", "bd-redirect"], ["close", "bd-redirect"], ["show", "bd-redirect"]]) {
      const refused = runTm(fixture, args)
      assert.equal(refused.status, 1, args.join(" "))
      assert.match(refused.stderr, /task-store redirect is unsupported/i)
    }
    const direct = run(process.execPath, [acceptancePath, "check", "bd-redirect"], {
      cwd: fixture.repo,
      env: fixture.env,
    })
    assert.equal(direct.status, 1)
    assert.match(direct.stderr, /task-store redirect is unsupported/i)
    assert.deepEqual(backendCalls(fixture), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("all redirect node types and redirects created during checks fail closed", () => {
  const redirectCreators = [
    ["regular file", (target) => fs.writeFileSync(target, "/tmp/target-beads\n")],
    ["directory", (target) => fs.mkdirSync(target)],
    ["dangling symlink", (target) => fs.symlinkSync("missing-target", target)],
  ]
  for (const [label, createRedirect] of redirectCreators) {
    const fixture = makeFixture()
    try {
      createRedirect(path.join(fixture.repo, ".beads", "redirect"))
      const refused = runTm(fixture, ["acceptance", "run", `bd-redirect-${label.replaceAll(" ", "-")}`])
      assert.equal(refused.status, 1, label)
      assert.match(refused.stderr, /task-store redirect is unsupported/i)
      assert.deepEqual(backendCalls(fixture), [])
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  }

  const fixture = makeFixture()
  const redirect = path.join(fixture.repo, ".beads", "redirect")
  try {
    const originalPolicy = fs.readFileSync(path.join(fixture.repo, ".xpowers", "acceptance.json"), "utf8")
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-redirect-during-check"]).status, 0)
    writePolicy(fixture, [{
      id: "create-redirect",
      command: [process.execPath, "-e", "require('node:fs').writeFileSync('.beads/redirect', '/tmp/target-beads\\n')"],
      timeoutMs: 5000,
    }])
    const failed = runTm(fixture, ["acceptance", "run", "bd-redirect-during-check"])
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /task-store redirect is unsupported/i)
    fs.unlinkSync(redirect)
    fs.writeFileSync(path.join(fixture.repo, ".xpowers", "acceptance.json"), originalPolicy)
    const checked = runTm(fixture, ["acceptance", "check", "bd-redirect-during-check"])
    assert.equal(checked.status, 1)
    assert.match(checked.stderr, /latest acceptance run is failed/i)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("POSIX permission changes invalidate acceptance evidence", () => {
  const fixture = makeFixture()
  try {
    const source = path.join(fixture.repo, "app.txt")
    fs.chmodSync(source, 0o644)
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-mode"]).status, 0)
    fs.chmodSync(source, 0o600)
    fs.writeFileSync(fixture.backendLog, "")

    const closed = runTm(fixture, ["close", "bd-mode"])
    assert.equal(closed.status, 1)
    assert.match(closed.stderr, /evidence is stale/i)
    assert.deepEqual(backendCalls(fixture), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("POSIX permission changes on proof-covered ancestor directories invalidate acceptance evidence", () => {
  const fixture = makeFixture()
  try {
    const sourceDirectory = path.join(fixture.repo, "src")
    fs.mkdirSync(sourceDirectory)
    fs.writeFileSync(path.join(sourceDirectory, "proof.txt"), "proof\n")
    fs.chmodSync(sourceDirectory, 0o755)
    writePolicy(fixture, [{
      id: "directory-mode",
      command: [
        process.execPath,
        "-e",
        "const fs=require('node:fs'); process.exit((fs.statSync('src').mode & 0o7777) === 0o755 ? 0 : 1)",
      ],
      timeoutMs: 5000,
    }])

    assert.equal(runTm(fixture, ["acceptance", "run", "bd-directory-mode"]).status, 0)
    fs.chmodSync(sourceDirectory, 0o700)
    fs.writeFileSync(fixture.backendLog, "")

    const checked = runTm(fixture, ["acceptance", "check", "bd-directory-mode"])
    assert.equal(checked.status, 1)
    assert.match(checked.stderr, /evidence is stale/i)
    const closed = runTm(fixture, ["close", "bd-directory-mode"])
    assert.equal(closed.status, 1)
    assert.match(closed.stderr, /evidence is stale/i)
    assert.deepEqual(backendCalls(fixture), [])

    const rejectedRerun = runTm(fixture, ["acceptance", "run", "bd-directory-mode"])
    assert.equal(rejectedRerun.status, 1)
    assert.deepEqual(backendCalls(fixture), [])

    fs.chmodSync(sourceDirectory, 0o755)
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-directory-mode"]).status, 0)
    assert.equal(runTm(fixture, ["acceptance", "check", "bd-directory-mode"]).status, 0)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("large source files are chunk-hashed through the tail without whole-file reads", () => {
  const fixture = makeFixture()
  const preload = path.join(fixture.root, "reject-large-read-file-sync.cjs")
  try {
    const large = path.join(fixture.repo, "large-source.bin")
    fs.writeFileSync(large, Buffer.alloc(2 * 1024 * 1024 + 17, 0x61))
    fs.writeFileSync(preload, [
      "const fs = require('node:fs')",
      "const originalReadFileSync = fs.readFileSync",
      "fs.readFileSync = function(target) {",
      "  if (typeof target === 'number' && fs.fstatSync(target).size > 1024 * 1024) {",
      "    throw new Error('whole-file source read forbidden')",
      "  }",
      "  return originalReadFileSync.apply(this, arguments)",
      "}",
      "",
    ].join("\n"))
    const accepted = runTm(fixture, ["acceptance", "run", "bd-large"], {
      env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${preload}`.trim() },
    })
    assert.equal(accepted.status, 0, accepted.stderr)

    const descriptor = fs.openSync(large, "r+")
    try {
      fs.writeSync(descriptor, Buffer.from([0x62]), 0, 1, fs.statSync(large).size - 1)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.writeFileSync(fixture.backendLog, "")
    const closed = runTm(fixture, ["close", "bd-large"])
    assert.equal(closed.status, 1)
    assert.match(closed.stderr, /evidence is stale/i)
    assert.deepEqual(backendCalls(fixture), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("external symlinks and corrupt receipts fail closed", () => {
  const fixture = makeFixture()
  try {
    fs.symlinkSync(path.join(fixture.root, "outside"), path.join(fixture.repo, "external-link"))
    fs.writeFileSync(path.join(fixture.root, "outside"), "outside\n")
    const rejected = runTm(fixture, ["acceptance", "run", "bd-link"])
    assert.equal(rejected.status, 1)
    assert.match(rejected.stderr, /symlink external-link resolves outside the worktree/i)
    fs.unlinkSync(path.join(fixture.repo, "external-link"))

    assert.equal(runTm(fixture, ["acceptance", "run", "bd-corrupt"]).status, 0)
    const gitDir = git(fixture.repo, "rev-parse", "--absolute-git-dir")
    const stateDir = path.join(gitDir, "xpowers", "acceptance-v1")
    const receipt = fs.readdirSync(stateDir).find((name) => name.endsWith(".json"))
    assert.ok(receipt)
    fs.writeFileSync(path.join(stateDir, receipt), "not json\n")
    fs.writeFileSync(fixture.backendLog, "")
    const closed = runTm(fixture, ["close", "bd-corrupt"])
    assert.equal(closed.status, 1)
    assert.match(closed.stderr, /malformed or corrupt/i)
    assert.deepEqual(backendCalls(fixture), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("accepted in-worktree symlink targets are fingerprinted", () => {
  const fixture = makeFixture()
  try {
    fs.mkdirSync(path.join(fixture.repo, "generated"))
    fs.writeFileSync(path.join(fixture.repo, "generated", "artifact.txt"), "artifact one\n")
    fs.appendFileSync(path.join(fixture.repo, ".gitignore"), "generated/\n")
    fs.symlinkSync("generated/artifact.txt", path.join(fixture.repo, "artifact-link"))
    git(fixture.repo, "add", ".gitignore", "artifact-link")
    git(fixture.repo, "commit", "-m", "track generated artifact link")
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-symlink-target"]).status, 0)
    fs.writeFileSync(fixture.backendLog, "")

    fs.writeFileSync(path.join(fixture.repo, "generated", "artifact.txt"), "artifact two\n")
    const closed = runTm(fixture, ["close", "bd-symlink-target"])
    assert.equal(closed.status, 1)
    assert.match(closed.stderr, /evidence is stale/i)
    assert.deepEqual(backendCalls(fixture), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("internal directory symlink subtrees are fingerprinted without duplicate canonical nodes", () => {
  const scenarios = [
    ["edit", ({ target }) => fs.writeFileSync(path.join(target, "dependency.js"), "module.exports = 2\n")],
    ["add", ({ target }) => fs.writeFileSync(path.join(target, "ignored-new.js"), "new\n")],
    ["delete", ({ target }) => fs.unlinkSync(path.join(target, "dependency.js"))],
    ["file-mode", ({ target }) => fs.chmodSync(path.join(target, "dependency.js"), 0o600)],
    ["empty-directory-mode", ({ target }) => fs.chmodSync(path.join(target, "empty"), 0o700)],
    ["empty-directory-add", ({ target }) => fs.mkdirSync(path.join(target, "new-empty"))],
    ["empty-directory-delete", ({ target }) => fs.rmdirSync(path.join(target, "empty"))],
    ["target-directory-mode", ({ target }) => fs.chmodSync(target, 0o700)],
    ["retarget", ({ fixture, link }) => {
      const replacement = path.join(fixture.repo, "replacement-dir")
      fs.mkdirSync(replacement)
      fs.writeFileSync(path.join(replacement, "dependency.js"), "module.exports = 1\n")
      fs.unlinkSync(link)
      fs.symlinkSync("replacement-dir", link)
    }],
  ]
  for (const [name, mutate] of scenarios) {
    const fixture = makeFixture()
    try {
      const linked = addTrackedDirectoryLink(fixture)
      fs.symlinkSync("generated-dir", path.join(fixture.repo, "dependency-link-two"))
      git(fixture.repo, "add", "dependency-link-two")
      git(fixture.repo, "commit", "-m", "add duplicate directory alias")
      const task = `bd-directory-${name}`
      const accepted = runTm(fixture, ["acceptance", "run", task])
      assert.equal(accepted.status, 0, accepted.stderr)

      const gitDir = git(fixture.repo, "rev-parse", "--absolute-git-dir")
      const receiptPath = path.join(gitDir, "xpowers", "acceptance-v1", `${crypto.createHash("sha256").update(task).digest("hex")}.json`)
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"))
      assert.equal(receipt.snapshot.files.filter((entry) => entry.path === "generated-dir/dependency.js").length, 1)

      mutate({ fixture, ...linked })
      fs.writeFileSync(fixture.backendLog, "")
      const closed = runTm(fixture, ["close", task])
      assert.equal(closed.status, 1)
      assert.match(closed.stderr, /evidence is stale/i)
      assert.deepEqual(backendCalls(fixture), [])
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

test("nested internal directory links are covered and cycles are rejected", () => {
  const fixture = makeFixture()
  try {
    const linked = addTrackedDirectoryLink(fixture)
    const shared = path.join(fixture.repo, "shared-generated")
    fs.mkdirSync(shared)
    fs.writeFileSync(path.join(shared, "nested.txt"), "nested one\n")
    fs.symlinkSync("../shared-generated", path.join(linked.target, "nested-link"))
    fs.symlinkSync("../shared-generated/nested.txt", path.join(linked.target, "nested-file-link"))
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-nested-directory"]).status, 0)
    fs.writeFileSync(path.join(shared, "nested.txt"), "nested two\n")
    assert.equal(runTm(fixture, ["acceptance", "check", "bd-nested-directory"]).status, 1)

    fs.writeFileSync(path.join(shared, "nested.txt"), "nested one\n")
    fs.symlinkSync(".", path.join(linked.target, "cycle"))
    const cycle = runTm(fixture, ["acceptance", "run", "bd-directory-cycle"])
    assert.equal(cycle.status, 1)
    assert.match(cycle.stderr, /directory symlink cycle/i)

    fs.unlinkSync(path.join(linked.target, "cycle"))
    const cycleA = path.join(linked.target, "cycle-a")
    const cycleB = path.join(linked.target, "cycle-b")
    fs.mkdirSync(cycleA)
    fs.mkdirSync(cycleB)
    fs.symlinkSync("../cycle-b", path.join(cycleA, "to-b"))
    fs.symlinkSync("../cycle-a", path.join(cycleB, "to-a"))
    const crossCycle = runTm(fixture, ["acceptance", "run", "bd-directory-cross-cycle"])
    assert.equal(crossCycle.status, 1)
    assert.match(crossCycle.stderr, /directory symlink cycle/i)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("unsafe nodes inside directory symlink targets fail closed", () => {
  const scenarios = [
    ["dangling", (fixture, target) => fs.symlinkSync("missing", path.join(target, "unsafe")), /dangling symlink/i],
    ["external", (fixture, target) => {
      const outside = path.join(fixture.root, "outside")
      fs.writeFileSync(outside, "outside\n")
      fs.symlinkSync(outside, path.join(target, "unsafe"))
    }, /resolves outside the worktree/i],
    ["beads", (fixture, target) => fs.symlinkSync(path.join(fixture.repo, ".beads"), path.join(target, "unsafe")), /excluded \.beads metadata/i],
    ["git", (fixture, target) => fs.symlinkSync(path.join(fixture.repo, ".git"), path.join(target, "unsafe")), /Git metadata/i],
    ["special", (fixture, target) => {
      const made = run("mkfifo", [path.join(target, "unsafe")], { cwd: fixture.repo })
      assert.equal(made.status, 0, made.stderr)
    }, /special file/i],
  ]
  for (const [name, arrange, expected] of scenarios) {
    const fixture = makeFixture()
    try {
      const { target } = addTrackedDirectoryLink(fixture)
      arrange(fixture, target)
      const accepted = runTm(fixture, ["acceptance", "run", `bd-directory-${name}`])
      assert.equal(accepted.status, 1)
      assert.match(accepted.stderr, expected)
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  }

  const rootFixture = makeFixture()
  try {
    fs.symlinkSync(".", path.join(rootFixture.repo, "root-alias"))
    git(rootFixture.repo, "add", "root-alias")
    git(rootFixture.repo, "commit", "-m", "track unsafe root alias")
    const accepted = runTm(rootFixture, ["acceptance", "run", "bd-directory-root"])
    assert.equal(accepted.status, 1)
    assert.match(accepted.stderr, /worktree root.*unsupported/i)
  } finally {
    fs.rmSync(rootFixture.root, { recursive: true, force: true })
  }

  const ancestorFixture = makeFixture()
  try {
    const container = path.join(ancestorFixture.repo, "container")
    fs.mkdirSync(path.join(container, "generated"), { recursive: true })
    fs.writeFileSync(path.join(container, "generated", "inside.txt"), "inside\n")
    fs.appendFileSync(path.join(ancestorFixture.repo, ".gitignore"), "/container/\n")
    fs.symlinkSync("container/generated", path.join(ancestorFixture.repo, "ancestor-alias"))
    git(ancestorFixture.repo, "add", ".gitignore", "ancestor-alias")
    git(ancestorFixture.repo, "commit", "-m", "track alias with internal ancestors")
    const outside = path.join(ancestorFixture.root, "outside-container")
    fs.renameSync(container, outside)
    fs.symlinkSync(outside, container)
    const accepted = runTm(ancestorFixture, ["acceptance", "run", "bd-directory-parent-link"])
    assert.equal(accepted.status, 1)
    assert.match(accepted.stderr, /resolves outside the worktree|symlink parent directory is unsupported/i)
  } finally {
    fs.rmSync(ancestorFixture.root, { recursive: true, force: true })
  }
})

test("directory symlink traversal rejects invalid UTF-8 names", () => {
  const fixture = makeFixture()
  const preload = path.join(fixture.root, "invalid-directory-entry.cjs")
  try {
    const { target } = addTrackedDirectoryLink(fixture)
    fs.writeFileSync(preload, [
      "const fs = require('node:fs')",
      "const originalOpen = fs.opendirSync",
      "fs.opendirSync = function(directory, options) {",
      "  const handle = originalOpen.apply(this, arguments)",
      "  if (String(directory) !== process.env.INVALID_DIRECTORY_PATH) return handle",
      "  let injected = false",
      "  return {",
      "    readSync() {",
      "      if (!injected) { injected = true; return { name: Buffer.from([0xff]) } }",
      "      return handle.readSync()",
      "    },",
      "    closeSync() { return handle.closeSync() },",
      "  }",
      "}",
      "",
    ].join("\n"))
    const accepted = runTm(fixture, ["acceptance", "run", "bd-directory-invalid-utf8"], {
      env: {
        INVALID_DIRECTORY_PATH: fs.realpathSync(target),
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${preload}`.trim(),
      },
    })
    assert.equal(accepted.status, 1)
    assert.match(accepted.stderr, /not valid UTF-8/i)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("directory symlink traversal enforces depth, node, and path-byte bounds", () => {
  for (const [name, arrange, expected] of [
    ["depth", (target) => {
      let current = target
      for (let index = 0; index < 34; index += 1) {
        current = path.join(current, "d")
        fs.mkdirSync(current)
      }
    }, /depth limit/i],
    ["nodes", (target) => {
      for (let index = 0; index < 4100; index += 1) fs.writeFileSync(path.join(target, `f${index}`), "")
    }, /node limit/i],
    ["paths", (target) => {
      for (let index = 0; index < 1200; index += 1) {
        fs.writeFileSync(path.join(target, `${String(index).padStart(4, "0")}-${"x".repeat(215)}`), "")
      }
    }, /path-byte limit/i],
  ]) {
    const fixture = makeFixture()
    try {
      const { target } = addTrackedDirectoryLink(fixture)
      arrange(target)
      const accepted = runTm(fixture, ["acceptance", "run", `bd-directory-bound-${name}`], { timeout: 30000 })
      assert.equal(accepted.status, 1)
      assert.match(accepted.stderr, expected)
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

test("directory traversal changes during checks fail and supersede an older success", () => {
  const fixture = makeFixture()
  try {
    const { target } = addTrackedDirectoryLink(fixture)
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-directory-check-change"]).status, 0)
    writePolicy(fixture, [{
      id: "mutate-ignored-child",
      command: [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(path.join(target, "dependency.js"))}, 'changed\\n')`],
      timeoutMs: 5000,
    }])
    const changed = runTm(fixture, ["acceptance", "run", "bd-directory-check-change"])
    assert.equal(changed.status, 1)
    assert.match(changed.stderr, /worktree or policy changed while acceptance checks ran/i)

    writePolicy(fixture, [passingCheck()])
    const checked = runTm(fixture, ["acceptance", "check", "bd-directory-check-change"])
    assert.equal(checked.status, 1)
    assert.match(checked.stderr, /latest acceptance run is failed/i)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("symlinks into task-store or Git metadata and symlink parents are rejected", () => {
  for (const [name, target, message] of [
    ["beads-link", ".beads/config.yaml", /excluded \.beads metadata/i],
    ["git-link", ".git/config", /Git metadata/i],
  ]) {
    const fixture = makeFixture()
    try {
      fs.symlinkSync(target, path.join(fixture.repo, name))
      const accepted = runTm(fixture, ["acceptance", "run", `bd-${name}`])
      assert.equal(accepted.status, 1)
      assert.match(accepted.stderr, message)
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  }

  const fixture = makeFixture()
  try {
    fs.mkdirSync(path.join(fixture.repo, "src"))
    fs.writeFileSync(path.join(fixture.repo, "src", "source.txt"), "inside\n")
    git(fixture.repo, "add", "src/source.txt")
    git(fixture.repo, "commit", "-m", "track source")
    const outside = path.join(fixture.root, "outside-src")
    fs.renameSync(path.join(fixture.repo, "src"), outside)
    fs.symlinkSync(outside, path.join(fixture.repo, "src"))
    const accepted = runTm(fixture, ["acceptance", "run", "bd-parent-link"])
    assert.equal(accepted.status, 1)
    assert.match(accepted.stderr, /symlink src resolves outside the worktree|symlink parent directory is unsupported/i)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("a structurally incomplete passed receipt is corrupt and cannot close", () => {
  const fixture = makeFixture()
  try {
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-incomplete"]).status, 0)
    const gitDir = git(fixture.repo, "rev-parse", "--absolute-git-dir")
    const stateDir = path.join(gitDir, "xpowers", "acceptance-v1")
    const receiptName = fs.readdirSync(stateDir).find((name) => name.endsWith(".json"))
    const receiptPath = path.join(stateDir, receiptName)
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"))
    receipt.checks = []
    fs.writeFileSync(receiptPath, JSON.stringify(receipt))
    fs.writeFileSync(fixture.backendLog, "")

    const closed = runTm(fixture, ["close", "bd-incomplete"])
    assert.equal(closed.status, 1)
    assert.match(closed.stderr, /incomplete check evidence/i)
    assert.deepEqual(backendCalls(fixture), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("a receipt with an altered snapshot manifest is internally inconsistent", () => {
  const fixture = makeFixture()
  try {
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-manifest"]).status, 0)
    const gitDir = git(fixture.repo, "rev-parse", "--absolute-git-dir")
    const stateDir = path.join(gitDir, "xpowers", "acceptance-v1")
    const receiptName = fs.readdirSync(stateDir).find((name) => name.endsWith(".json"))
    const receiptPath = path.join(stateDir, receiptName)
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"))
    receipt.snapshot.files = []
    fs.writeFileSync(receiptPath, JSON.stringify(receipt))
    fs.writeFileSync(fixture.backendLog, "")

    const closed = runTm(fixture, ["close", "bd-manifest"])
    assert.equal(closed.status, 1)
    assert.match(closed.stderr, /snapshot is internally inconsistent/i)
    assert.deepEqual(backendCalls(fixture), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("receipts missing symbolic HEAD or semantic index flags are corrupt even with a matching fingerprint", () => {
  const fixture = makeFixture()
  try {
    for (const [task, mutate] of [
      ["bd-missing-head-state", (snapshot) => { delete snapshot.identity.headState }],
      ["bd-missing-index-flags", (snapshot) => { delete snapshot.index[0].flags.intentToAdd }],
    ]) {
      assert.equal(runTm(fixture, ["acceptance", "run", task]).status, 0)
      const gitDir = git(fixture.repo, "rev-parse", "--absolute-git-dir")
      const receiptPath = path.join(gitDir, "xpowers", "acceptance-v1", `${crypto.createHash("sha256").update(task).digest("hex")}.json`)
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"))
      mutate(receipt.snapshot)
      const payload = {
        runtimeVersion: receipt.snapshot.runtimeVersion,
        identity: receipt.snapshot.identity,
        policyFingerprint: receipt.snapshot.policyFingerprint,
        index: receipt.snapshot.index,
        directories: receipt.snapshot.directories,
        files: receipt.snapshot.files,
      }
      receipt.snapshot.fingerprint = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")
      fs.writeFileSync(receiptPath, JSON.stringify(receipt))
      fs.writeFileSync(fixture.backendLog, "")

      const closed = runTm(fixture, ["close", task])
      assert.equal(closed.status, 1)
      assert.match(closed.stderr, /malformed or corrupt/i)
      assert.deepEqual(backendCalls(fixture), [])
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("unsafe close-capable command forms are refused without backend dispatch", () => {
  const commands = [
    ["close"],
    ["close", "bd-safe", "--force"],
    ["epic", "close-eligible"],
    ["epic", "--quiet", "close-eligible"],
    ["update", "bd-safe", "--status", "closed"],
    ["update", "bd-safe", "-s", "closed"],
    ["update", "bd-safe", "-sclosed"],
    ["update", "bd-safe", "-s=closed"],
    ["update", "bd-safe", "-qsclosed"],
    ["update", "bd-safe", "-vqsclosed"],
    ["update", "bd-safe", "-qs=closed"],
    ["update", "bd-safe", "-vqs=closed"],
    ["create", "title", "--status=done"],
    ["create", "title", "-qsclosed", "--json"],
    ["create", "title", "-vqsclosed"],
    ["create", "title", "-qs=closed"],
    ["create", "title", "-vqs=closed"],
    ["create", "--file", "tasks.json"],
    ["create", "-f/tasks.json"],
    ["create", "-qftasks.json"],
    ["create", "-vqf=tasks.json"],
    ["--db", "other.db", "close", "bd-safe"],
  ]
  for (const args of commands) {
    const fixture = makeFixture()
    try {
      const result = runTm(fixture, args)
      assert.equal(result.status, 1, `${args.join(" ")}\n${result.stderr}`)
      assert.deepEqual(backendCalls(fixture), [])
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

test("malformed policy nodes, backend mismatch, and Git overrides fail closed", () => {
  const fixture = makeFixture()
  try {
    fs.rmSync(path.join(fixture.repo, ".xpowers", "acceptance.json"))
    fs.mkdirSync(path.join(fixture.repo, ".xpowers", "acceptance.json"))
    assert.equal(runTm(fixture, ["close", "bd-node"]).status, 1)
    assert.deepEqual(backendCalls(fixture), [])

    fs.rmSync(path.join(fixture.repo, ".xpowers", "acceptance.json"), { recursive: true })
    fs.symlinkSync("missing-policy.json", path.join(fixture.repo, ".xpowers", "acceptance.json"))
    assert.equal(runTm(fixture, ["close", "bd-node"]).status, 1)
    assert.deepEqual(backendCalls(fixture), [])

    fs.rmSync(path.join(fixture.repo, ".xpowers"), { recursive: true })
    fs.symlinkSync("missing-xpowers", path.join(fixture.repo, ".xpowers"))
    const unconfigured = runTm(fixture, ["close", "bd-node"])
    assert.equal(unconfigured.status, 0, unconfigured.stderr)
    assert.deepEqual(backendCalls(fixture), [["close", "bd-node"]])

    fs.unlinkSync(path.join(fixture.repo, ".xpowers"))
    fs.mkdirSync(path.join(fixture.repo, ".xpowers"))
    writePolicy(fixture, [passingCheck()])
    fs.writeFileSync(fixture.backendLog, "")
    assert.equal(runTm(fixture, ["close", "bd-node"], { env: { TM_BACKEND: "bd" } }).status, 1)
    const gitOverrides = {
      GIT_INDEX_FILE: path.join(fixture.root, "index"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(fixture.root, "objects"),
      GIT_CEILING_DIRECTORIES: fixture.root,
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
      GIT_NAMESPACE: "acceptance-test",
    }
    for (const [name, value] of Object.entries(gitOverrides)) {
      assert.equal(runTm(fixture, ["close", "bd-node"], { env: { [name]: value } }).status, 1, name)
      const directGitOverride = run(process.execPath, [acceptancePath, "check", "bd-node"], {
        cwd: fixture.repo,
        env: { ...fixture.env, [name]: value },
      })
      assert.equal(directGitOverride.status, 1, name)
      assert.match(directGitOverride.stderr, new RegExp(`${name} is unsupported`, "i"))
    }
    assert.equal(runTm(fixture, ["close", "bd-node"], { env: { BD_DB: path.join(fixture.root, "other.db") } }).status, 1)
    assert.equal(runTm(fixture, ["close", "bd-node"], { env: { BD_DATABASE: path.join(fixture.root, "other.db") } }).status, 1)
    assert.equal(runTm(fixture, ["close", "bd-node"], { env: { BEADS_DIR: path.join(fixture.root, "other-beads") } }).status, 1)
    assert.equal(runTm(fixture, ["close", "bd-node"], { env: { BEADS_DB: path.join(fixture.root, "other.db") } }).status, 1)
    const wrapperNoDbOverride = runTm(fixture, ["close", "bd-node"], { env: { BD_NO_DB: "true" } })
    assert.equal(wrapperNoDbOverride.status, 1)
    assert.match(wrapperNoDbOverride.stderr, /database environment overrides are unsupported/i)
    const wrapperJsonlOverride = runTm(fixture, ["close", "bd-node"], {
      env: { BEADS_JSONL: path.join(fixture.root, "alternate.jsonl") },
    })
    assert.equal(wrapperJsonlOverride.status, 1)
    assert.match(wrapperJsonlOverride.stderr, /database environment overrides are unsupported/i)
    const directBackendOverrides = {
      BEADS_DB: path.join(fixture.root, "other.db"),
      BEADS_JSONL: path.join(fixture.root, "alternate.jsonl"),
      BD_NO_DB: "true",
    }
    for (const [name, value] of Object.entries(directBackendOverrides)) {
      const directOverride = run(process.execPath, [acceptancePath, "check", "bd-node"], {
        cwd: fixture.repo,
        env: { ...fixture.env, [name]: value },
      })
      assert.equal(directOverride.status, 1, name)
      assert.match(directOverride.stderr, new RegExp(`${name} is unsupported`, "i"))
    }
    assert.deepEqual(backendCalls(fixture), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("an unconfigured project preserves ordinary tm passthrough behavior", () => {
  const fixture = makeFixture()
  try {
    fs.rmSync(path.join(fixture.repo, ".xpowers"), { recursive: true })
    const closed = runTm(fixture, ["close", "bd-ordinary"])
    assert.equal(closed.status, 0, closed.stderr)
    const created = runTm(fixture, ["create", "title", "-qsclosed", "--json"])
    assert.equal(created.status, 0, created.stderr)
    fs.writeFileSync(path.join(fixture.repo, ".beads", "redirect"), "/tmp/ordinary-target\n")
    const shown = runTm(fixture, ["show", "bd-ordinary"])
    assert.equal(shown.status, 0, shown.stderr)
    assert.deepEqual(backendCalls(fixture), [
      ["close", "bd-ordinary"],
      ["create", "title", "-qsclosed", "--json"],
      ["show", "bd-ordinary"],
    ])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("guarded close holds the acceptance lock until br exits", async () => {
  const fixture = makeFixture()
  const release = path.join(fixture.root, "br-close-release")
  let child
  let childExit
  try {
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-lock"]).status, 0)
    fs.writeFileSync(fixture.backendLog, "")
    child = spawn(tmPath, ["close", "bd-lock"], {
      cwd: fixture.repo,
      env: { ...fixture.env, BR_RELEASE_FILE: release },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    childExit = waitForExit(child)
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => { stderr += chunk })
    await waitFor(() => backendCalls(fixture).length === 1)

    const competing = runTm(fixture, ["acceptance", "run", "bd-lock"])
    assert.equal(competing.status, 1)
    assert.match(competing.stderr, /acceptance state is locked/i)
    assert.equal(fs.existsSync(release), false)
    const outcome = await releaseAndWaitForChild(child, childExit, release)
    assert.equal(outcome.status, 0, stderr)
    assert.equal(runTm(fixture, ["acceptance", "check", "bd-lock"]).status, 0)
  } finally {
    await releaseAndWaitForChild(child, childExit, release)
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("guarded close forwards graceful signals and holds the lock through backend cleanup", async () => {
  for (const [signal, expectedStatus] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    const fixture = makeFixture()
    const ready = path.join(fixture.root, `br-${signal}-ready`)
    const received = path.join(fixture.root, `br-${signal}-received`)
    const done = path.join(fixture.root, `br-${signal}-done`)
    const release = path.join(fixture.root, `br-${signal}-release`)
    let child
    let childExit
    try {
      assert.equal(runTm(fixture, ["acceptance", "run", `bd-${signal.toLowerCase()}`]).status, 0)
      fs.writeFileSync(fixture.backendLog, "")
      child = spawn(tmPath, ["close", `bd-${signal.toLowerCase()}`], {
        cwd: fixture.repo,
        env: {
          ...fixture.env,
          BR_SIGNAL_READY: ready,
          BR_SIGNAL_MARKER: received,
          BR_SIGNAL_DONE: done,
          BR_RELEASE_FILE: release,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      })
      childExit = waitForExit(child)
      let stderr = ""
      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk) => { stderr += chunk })
      await waitFor(() => fs.existsSync(ready))
      assert.equal(fs.readFileSync(ready, "utf8"), "ready")
      assert.deepEqual(backendCalls(fixture), [["close", `bd-${signal.toLowerCase()}`]])

      child.kill(signal)
      await waitFor(() => fs.existsSync(received))
      assert.equal(fs.readFileSync(received, "utf8"), signal)
      const competing = runTm(fixture, ["acceptance", "check", `bd-${signal.toLowerCase()}`])
      assert.equal(competing.status, 1)
      assert.match(competing.stderr, /acceptance state is locked/i)
      assert.equal(fs.existsSync(done), false)
      assert.equal(fs.existsSync(release), false)

      const outcome = await releaseAndWaitForChild(child, childExit, release)
      assert.equal(outcome.status, expectedStatus, stderr)
      assert.equal(fs.readFileSync(done, "utf8"), `done:${signal}`)
      assert.equal(runTm(fixture, ["acceptance", "check", `bd-${signal.toLowerCase()}`]).status, 0)
    } finally {
      await releaseAndWaitForChild(child, childExit, release)
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

test("an interrupted run leaves the latest receipt ineligible", async () => {
  for (const [signal, expectedStatus] of [["SIGTERM", 143], ["SIGHUP", 129]]) {
    const fixture = makeFixture()
    const marker = path.join(fixture.root, `long-check-${signal}-started`)
    const task = `bd-interrupted-${signal.toLowerCase()}`
    try {
      writePolicy(fixture, [{
        id: "long",
        command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000)`],
        timeoutMs: 10000,
      }])
      const child = spawn(tmPath, ["acceptance", "run", task], {
        cwd: fixture.repo,
        env: fixture.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stderr = ""
      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk) => { stderr += chunk })
      await waitFor(() => fs.existsSync(marker))
      child.kill(signal)
      const result = await waitForExit(child)
      assert.equal(result.status, expectedStatus, stderr)
      assert.equal(result.signal, null)
      fs.writeFileSync(fixture.backendLog, "")

      const closed = runTm(fixture, ["close", task])
      assert.equal(closed.status, 1)
      assert.match(closed.stderr, /latest acceptance run is interrupted/i)
      assert.deepEqual(backendCalls(fixture), [])
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

test("a signal queued when the lock is created invalidates an older passing receipt", () => {
  const fixture = makeFixture()
  const preload = path.join(fixture.root, "signal-after-lock.cjs")
  try {
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-lock-signal"]).status, 0)
    fs.writeFileSync(preload, [
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "const originalRenameSync = fs.renameSync",
      "let signaled = false",
      "fs.renameSync = function(source, target) {",
      "  const result = originalRenameSync.apply(this, arguments)",
      "  const ownerSuffix = `${path.sep}acceptance-v1${path.sep}lock${path.sep}owner.json`",
      "  if (!signaled && String(target).endsWith(ownerSuffix)) {",
      "    signaled = true",
      "    process.nextTick(() => process.kill(process.pid, 'SIGTERM'))",
      "  }",
      "  return result",
      "}",
      "",
    ].join("\n"))

    const rerun = runTm(fixture, ["acceptance", "run", "bd-lock-signal"], {
      env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${preload}`.trim() },
    })
    assert.equal(rerun.status, 143, rerun.stderr)

    const checked = runTm(fixture, ["acceptance", "check", "bd-lock-signal"])
    assert.equal(checked.status, 1)
    assert.doesNotMatch(checked.stderr, /acceptance state is locked/i)
    assert.match(checked.stderr, /latest acceptance run is interrupted/i)
    fs.writeFileSync(fixture.backendLog, "")
    assert.equal(runTm(fixture, ["close", "bd-lock-signal"]).status, 1)
    assert.deepEqual(backendCalls(fixture), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("signals during synchronous snapshot work release the lock and cannot revive or dispatch", async () => {
  const fixture = makeFixture()
  const preload = path.join(fixture.root, "pause-snapshot.cjs")
  try {
    fs.writeFileSync(preload, [
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "const originalLstatSync = fs.lstatSync",
      "let paused = false",
      "fs.lstatSync = function(target) {",
      "  if (!paused && process.env.SNAPSHOT_SIGNAL_MARKER && String(target).endsWith(`${path.sep}app.txt`)) {",
      "    paused = true",
      "    fs.writeFileSync(process.env.SNAPSHOT_SIGNAL_MARKER, 'snapshot')",
      "    const deadline = Date.now() + 1200",
      "    while (Date.now() < deadline) {}",
      "  }",
      "  return originalLstatSync.apply(this, arguments)",
      "}",
      "",
    ].join("\n"))
    const preloadEnv = (marker) => ({
      ...fixture.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${preload}`.trim(),
      SNAPSHOT_SIGNAL_MARKER: marker,
    })
    const runAndSignal = async (args, marker, signal = "SIGTERM", expectedStatus = 143) => {
      const child = spawn(tmPath, args, {
        cwd: fixture.repo,
        env: preloadEnv(marker),
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stderr = ""
      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk) => { stderr += chunk })
      await waitFor(() => fs.existsSync(marker))
      child.kill(signal)
      const outcome = await waitForExit(child)
      assert.equal(outcome.status, expectedStatus, stderr)
      assert.equal(outcome.signal, null)
    }

    assert.equal(runTm(fixture, ["acceptance", "run", "bd-snapshot-signal"]).status, 0)
    await runAndSignal(
      ["acceptance", "run", "bd-snapshot-signal"],
      path.join(fixture.root, "run-snapshot-ready"),
    )
    const interrupted = runTm(fixture, ["acceptance", "check", "bd-snapshot-signal"])
    assert.equal(interrupted.status, 1)
    assert.doesNotMatch(interrupted.stderr, /acceptance state is locked/i)
    assert.match(interrupted.stderr, /latest acceptance run is interrupted/i)
    fs.writeFileSync(fixture.backendLog, "")
    assert.equal(runTm(fixture, ["close", "bd-snapshot-signal"]).status, 1)
    assert.deepEqual(backendCalls(fixture), [])

    assert.equal(runTm(fixture, ["acceptance", "run", "bd-snapshot-signal"]).status, 0)
    await runAndSignal(
      ["close", "bd-snapshot-signal"],
      path.join(fixture.root, "close-snapshot-ready"),
    )
    assert.deepEqual(backendCalls(fixture), [])
    assert.equal(runTm(fixture, ["acceptance", "check", "bd-snapshot-signal"]).status, 0)

    await runAndSignal(
      ["acceptance", "check", "bd-snapshot-signal"],
      path.join(fixture.root, "check-snapshot-ready"),
      "SIGHUP",
      129,
    )
    assert.equal(runTm(fixture, ["acceptance", "check", "bd-snapshot-signal"]).status, 0)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("closed stdout and stderr fail a run without leaking the lock or reviving prior evidence", async () => {
  for (const streamName of ["stdout", "stderr"]) {
    const fixture = makeFixture()
    const task = `bd-${streamName}-closed`
    const marker = path.join(fixture.root, `${streamName}-check-ready`)
    try {
      const originalPolicy = fs.readFileSync(path.join(fixture.repo, ".xpowers", "acceptance.json"), "utf8")
      assert.equal(runTm(fixture, ["acceptance", "run", task]).status, 0)
      writePolicy(fixture, [{
        id: `${streamName}-output`,
        command: [
          process.execPath,
          "-e",
          [
            "const fs=require('node:fs')",
            `fs.writeFileSync(${JSON.stringify(marker)}, 'ready')`,
            `setTimeout(() => console.${streamName === "stdout" ? "log" : "error"}('check ${streamName}'), 500)`,
          ].join(";"),
        ],
        timeoutMs: 5000,
      }])
      const child = spawn(tmPath, ["acceptance", "run", task], {
        cwd: fixture.repo,
        env: fixture.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      child.stdout.on("data", () => {})
      child.stderr.on("data", () => {})
      await waitFor(() => fs.existsSync(marker))
      child[streamName].destroy()
      const outcome = await waitForExit(child)
      assert.notEqual(outcome.status, 0)
      assert.equal(outcome.signal, null)

      fs.writeFileSync(path.join(fixture.repo, ".xpowers", "acceptance.json"), originalPolicy)
      const checked = runTm(fixture, ["acceptance", "check", task])
      assert.equal(checked.status, 1)
      assert.doesNotMatch(checked.stderr, /acceptance state is locked/i)
      assert.match(checked.stderr, /latest acceptance run is failed/i)
      fs.writeFileSync(fixture.backendLog, "")
      assert.equal(runTm(fixture, ["close", task]).status, 1)
      assert.deepEqual(backendCalls(fixture), [])

      assert.equal(runTm(fixture, ["acceptance", "run", task]).status, 0)
      assert.equal(runTm(fixture, ["acceptance", "check", task]).status, 0)
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

test("a broken guarded-close stdout fails before backend dispatch and releases the lock", async () => {
  const fixture = makeFixture()
  const preload = path.join(fixture.root, "pause-close-snapshot.cjs")
  const marker = path.join(fixture.root, "close-snapshot-ready-for-broken-pipe")
  try {
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-close-pipe"]).status, 0)
    fs.writeFileSync(fixture.backendLog, "")
    fs.writeFileSync(preload, [
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "const originalLstatSync = fs.lstatSync",
      "let paused = false",
      "fs.lstatSync = function(target) {",
      "  if (!paused && process.env.CLOSE_PIPE_MARKER && String(target).endsWith(`${path.sep}app.txt`)) {",
      "    paused = true",
      "    fs.writeFileSync(process.env.CLOSE_PIPE_MARKER, 'snapshot')",
      "    const deadline = Date.now() + 800",
      "    while (Date.now() < deadline) {}",
      "  }",
      "  return originalLstatSync.apply(this, arguments)",
      "}",
      "",
    ].join("\n"))
    const child = spawn(tmPath, ["close", "bd-close-pipe"], {
      cwd: fixture.repo,
      env: {
        ...fixture.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${preload}`.trim(),
        CLOSE_PIPE_MARKER: marker,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout.on("data", () => {})
    child.stderr.on("data", () => {})
    await waitFor(() => fs.existsSync(marker))
    child.stdout.destroy()
    const outcome = await waitForExit(child)
    assert.notEqual(outcome.status, 0)
    assert.equal(outcome.signal, null)
    assert.deepEqual(backendCalls(fixture), [])
    assert.equal(runTm(fixture, ["acceptance", "check", "bd-close-pipe"]).status, 0)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("a spawn failure supersedes an older passing receipt", () => {
  const fixture = makeFixture()
  try {
    const original = fs.readFileSync(path.join(fixture.repo, ".xpowers", "acceptance.json"), "utf8")
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-spawn"]).status, 0)
    writePolicy(fixture, [{ id: "missing", command: [path.join(fixture.root, "does-not-exist")], timeoutMs: 5000 }])
    const failed = runTm(fixture, ["acceptance", "run", "bd-spawn"])
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /spawn-failed/i)
    fs.writeFileSync(path.join(fixture.repo, ".xpowers", "acceptance.json"), original)
    fs.writeFileSync(fixture.backendLog, "")

    const closed = runTm(fixture, ["close", "bd-spawn"])
    assert.equal(closed.status, 1)
    assert.match(closed.stderr, /latest acceptance run is failed/i)
    assert.deepEqual(backendCalls(fixture), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("a pending receipt write failure retains the lock until full-store recovery", () => {
  const fixture = makeFixture()
  const preload = path.join(fixture.root, "fail-receipt-rename.cjs")
  try {
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-receipt-write"]).status, 0)
    fs.writeFileSync(preload, [
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "const originalRenameSync = fs.renameSync",
      "fs.renameSync = function(source, target) {",
      "  const statePart = `${path.sep}acceptance-v1${path.sep}`",
      "  const lockPart = `${path.sep}acceptance-v1${path.sep}lock${path.sep}`",
      "  if (String(target).includes(statePart) && !String(target).includes(lockPart)) {",
      "    const error = new Error('simulated receipt ENOSPC')",
      "    error.code = 'ENOSPC'",
      "    throw error",
      "  }",
      "  return originalRenameSync.apply(this, arguments)",
      "}",
      "",
    ].join("\n"))

    const failed = runTm(fixture, ["acceptance", "run", "bd-receipt-write"], {
      env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${preload}`.trim() },
    })
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /simulated receipt ENOSPC/i)

    const checked = runTm(fixture, ["acceptance", "check", "bd-receipt-write"])
    assert.equal(checked.status, 1)
    assert.match(checked.stderr, /acceptance state is locked/i)
    fs.writeFileSync(fixture.backendLog, "")
    const closed = runTm(fixture, ["close", "bd-receipt-write"])
    assert.equal(closed.status, 1)
    assert.match(closed.stderr, /acceptance state is locked/i)
    assert.deepEqual(backendCalls(fixture), [])

    const gitDir = git(fixture.repo, "rev-parse", "--absolute-git-dir")
    fs.rmSync(path.join(gitDir, "xpowers", "acceptance-v1"), { recursive: true, force: true })
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-receipt-write"]).status, 0)
    assert.equal(runTm(fixture, ["close", "bd-receipt-write"]).status, 0)
    assert.deepEqual(backendCalls(fixture), [["close", "bd-receipt-write"]])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("a failed post-pass invalidation write retains the lock until full-store recovery", async () => {
  const fixture = makeFixture()
  const preload = path.join(fixture.root, "fail-post-pass-invalidation.cjs")
  const passedMarker = path.join(fixture.root, "passed-receipt-persisted")
  try {
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-post-pass-write"]).status, 0)
    fs.writeFileSync(preload, [
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "const originalRenameSync = fs.renameSync",
      "let receiptRenames = 0",
      "fs.renameSync = function(source, target) {",
      "  const statePart = `${path.sep}acceptance-v1${path.sep}`",
      "  const lockPart = `${path.sep}acceptance-v1${path.sep}lock${path.sep}`",
      "  if (String(target).includes(statePart) && !String(target).includes(lockPart)) {",
      "    receiptRenames += 1",
      "    if (receiptRenames === 3) {",
      "      const error = new Error('simulated invalidation ENOSPC')",
      "      error.code = 'ENOSPC'",
      "      throw error",
      "    }",
      "    const result = originalRenameSync.apply(this, arguments)",
      "    if (receiptRenames === 2) {",
      "      fs.writeFileSync(process.env.RECEIPT_PASSED_MARKER, 'passed')",
      "      const deadline = Date.now() + 800",
      "      while (Date.now() < deadline) {}",
      "    }",
      "    return result",
      "  }",
      "  return originalRenameSync.apply(this, arguments)",
      "}",
      "",
    ].join("\n"))
    const child = spawn(tmPath, ["acceptance", "run", "bd-post-pass-write"], {
      cwd: fixture.repo,
      env: {
        ...fixture.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${preload}`.trim(),
        RECEIPT_PASSED_MARKER: passedMarker,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout.on("data", () => {})
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => { stderr += chunk })
    await waitFor(() => fs.existsSync(passedMarker))
    child.kill("SIGTERM")
    const outcome = await waitForExit(child)
    assert.equal(outcome.status, 143, stderr)
    assert.equal(outcome.signal, null)
    assert.match(stderr, /acceptance run interrupted by SIGTERM/i)
    assert.match(stderr, /simulated invalidation ENOSPC/i)

    const checked = runTm(fixture, ["acceptance", "check", "bd-post-pass-write"])
    assert.equal(checked.status, 1)
    assert.match(checked.stderr, /acceptance state is locked/i)
    fs.writeFileSync(fixture.backendLog, "")
    const closed = runTm(fixture, ["close", "bd-post-pass-write"])
    assert.equal(closed.status, 1)
    assert.match(closed.stderr, /acceptance state is locked/i)
    assert.deepEqual(backendCalls(fixture), [])

    const gitDir = git(fixture.repo, "rev-parse", "--absolute-git-dir")
    fs.rmSync(path.join(gitDir, "xpowers", "acceptance-v1"), { recursive: true, force: true })
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-post-pass-write"]).status, 0)
    assert.equal(runTm(fixture, ["close", "bd-post-pass-write"]).status, 0)
    assert.deepEqual(backendCalls(fixture), [["close", "bd-post-pass-write"]])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("linked worktrees use isolated acceptance receipt stores", () => {
  const fixture = makeFixture()
  const linked = path.join(fixture.root, "linked")
  try {
    git(fixture.repo, "worktree", "add", "-b", "acceptance-linked", linked)
    assert.equal(runTm(fixture, ["acceptance", "run", "bd-worktree"]).status, 0)

    const linkedFixture = {
      ...fixture,
      repo: linked,
      env: { ...fixture.env, TM_REPO_ROOT: linked },
    }
    const absent = runTm(linkedFixture, ["acceptance", "check", "bd-worktree"])
    assert.equal(absent.status, 1)
    assert.match(absent.stderr, /receipt is missing/i)
    assert.equal(runTm(linkedFixture, ["acceptance", "run", "bd-worktree"]).status, 0)

    const primaryGitDir = git(fixture.repo, "rev-parse", "--absolute-git-dir")
    const linkedGitDir = git(linked, "rev-parse", "--absolute-git-dir")
    assert.notEqual(primaryGitDir, linkedGitDir)
    assert.equal(fs.existsSync(path.join(primaryGitDir, "xpowers", "acceptance-v1")), true)
    assert.equal(fs.existsSync(path.join(linkedGitDir, "xpowers", "acceptance-v1")), true)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("both installers package and uninstall the acceptance runtime companion", () => {
  const shell = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8")
  const typescript = fs.readFileSync(path.join(repoRoot, "scripts", "install.ts"), "utf8")
  assert.match(shell, /cp .*tm-acceptance\.js.*TM_LIB_DIR/)
  assert.match(shell, /ln -sfn .*tm-acceptance\.js.*TM_BIN_DIR/)
  assert.match(shell, /rm -f .*tm-acceptance\.js/)
  assert.match(typescript, /"tm-acceptance\.js"/)
})

test("the installed symlink companion layout runs acceptance", () => {
  const fixture = makeFixture()
  const installRoot = path.join(fixture.root, "install")
  const binDir = path.join(installRoot, "bin")
  const libDir = path.join(installRoot, "lib")
  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(libDir, { recursive: true })
  try {
    fs.copyFileSync(path.join(repoRoot, "scripts", "tm"), path.join(binDir, "tm"))
    fs.chmodSync(path.join(binDir, "tm"), 0o755)
    for (const name of ["tm-backends.sh", "tm-acceptance.js"]) {
      fs.copyFileSync(path.join(repoRoot, "scripts", name), path.join(libDir, name))
      fs.symlinkSync(path.join(libDir, name), path.join(binDir, name))
    }
    const accepted = run(path.join(binDir, "tm"), ["acceptance", "run", "bd-installed"], {
      cwd: fixture.repo,
      env: fixture.env,
    })
    assert.equal(accepted.status, 0, accepted.stderr)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})
