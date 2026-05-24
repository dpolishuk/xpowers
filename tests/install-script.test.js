const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")
const fs = require("node:fs")
const os = require("node:os")
const { spawnSync } = require("node:child_process")

const repoRoot = path.resolve(__dirname, "..")

function makeConflictFixture(home) {
  const conflicts = [
    path.join(home, ".claude", "plugins", "hyperpowers@hyperpowers"),
    path.join(home, ".claude", "plugins", "myhyperpowers@myhyperpowers"),
    path.join(home, ".config", "opencode", "plugins", "superpowers"),
    path.join(home, ".pi", "agent", "extensions", "hyperpowers"),
  ]

  for (const conflict of conflicts) {
    fs.mkdirSync(conflict, { recursive: true })
    fs.writeFileSync(path.join(conflict, "marker.txt"), "legacy conflict\n", "utf8")
  }

  return conflicts
}

function combinedOutput(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`
}

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    ...options,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result
}

function installEnv(home, extra = {}) {
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    NO_COLOR: "1",
    XPOWERS_SKIP_THIRD_PARTY_FEATURES: "1",
    ...extra,
  }
  if (env.PATH) {
    const parts = env.PATH.split(path.delimiter)
    const firstPart = parts[0]
    if (firstPart && fs.existsSync(firstPart)) {
      const bashSymlink = path.join(firstPart, "bash")
      if (!fs.existsSync(bashSymlink)) {
        try {
          const bashPath = findExecutable("bash") || "/bin/bash"
          fs.symlinkSync(bashPath, bashSymlink)
        } catch (e) {
          // Ignore errors
        }
      }
      const npmMock = path.join(firstPart, "npm")
      if (!fs.existsSync(npmMock)) {
        try {
          fs.writeFileSync(npmMock, "#!/usr/bin/env bash\nexit 0\n", "utf8")
          fs.chmodSync(npmMock, 0o755)
        } catch (e) {
          // Ignore errors
        }
      }
      const npxMock = path.join(firstPart, "npx")
      if (!fs.existsSync(npxMock)) {
        try {
          fs.writeFileSync(npxMock, "#!/usr/bin/env bash\nexit 0\n", "utf8")
          fs.chmodSync(npxMock, 0o755)
        } catch (e) {
          // Ignore errors
        }
      }
    }
  }
  return env
}

function findExecutable(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Keep searching PATH.
    }
  }
  return null
}

function linkManifestRuntime(binDir) {
  const nodePath = process.versions.bun ? findExecutable("node") : process.execPath
  if (nodePath) {
    fs.symlinkSync(nodePath, path.join(binDir, "node"))
  } else {
    fs.symlinkSync(process.execPath, path.join(binDir, "bun"))
  }
  const bashPath = findExecutable("bash") || "/bin/bash"
  fs.symlinkSync(bashPath, path.join(binDir, "bash"))
}

function linkCommand(binDir, name) {
  const commandPath = findExecutable(name)
  assert.ok(commandPath, `expected ${name} to be available on PATH`)
  fs.symlinkSync(commandPath, path.join(binDir, name))
}

function makeBootstrapRepo(installShContent = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8")) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-bootstrap-source-"))
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true })
  fs.mkdirSync(path.join(repo, ".claude-plugin"), { recursive: true })
  fs.writeFileSync(path.join(repo, "scripts", "install.sh"), installShContent, "utf8")
  fs.writeFileSync(path.join(repo, "scripts", "install.ts"), "#!/usr/bin/env bun\n", "utf8")
  fs.writeFileSync(path.join(repo, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "99.0.0" }) + "\n", "utf8")
  runGit(["init"], { cwd: repo })
  runGit(["config", "user.email", "test@example.invalid"], { cwd: repo })
  runGit(["config", "user.name", "Install Test"], { cwd: repo })
  runGit(["add", "."], { cwd: repo })
  runGit(["commit", "-m", "fixture"], { cwd: repo })
  const ref = runGit(["rev-parse", "HEAD"], { cwd: repo }).stdout.trim()
  return { repo, ref }
}

test("install.sh bootstraps from stdin using an offline repository override", { timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-bootstrap-home-"))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-bootstrap-cwd-"))
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-bootstrap-tmp-"))
  const { repo, ref } = makeBootstrapRepo()
  const script = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8")

  const result = spawnSync("bash", ["-s", "--", "--help"], {
    cwd,
    input: script,
    encoding: "utf8",
    env: installEnv(home, {
      TMPDIR: tmpRoot,
      XPOWERS_REPO_URL: repo,
      XPOWERS_REF: ref,
    }),
    timeout: 60000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.match(output, /Unified installer for XPowers/)
  assert.match(output, /--hosts <list>/)
  assert.deepEqual(fs.readdirSync(tmpRoot).filter((name) => name.startsWith("xpowers-install.")), [])
})

test("install.sh bootstrap preserves delegated arguments and exit code", { timeout: 60000 }, () => {
  const delegatedScript = [
    "#!/usr/bin/env bash",
    "printf 'delegated argc=%s\\n' \"$#\"",
    "printf 'delegated args=%s\\n' \"$*\"",
    "exit 37",
    "",
  ].join("\n")
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-bootstrap-exit-home-"))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-bootstrap-exit-cwd-"))
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-bootstrap-exit-tmp-"))
  const { repo, ref } = makeBootstrapRepo(delegatedScript)
  const script = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8")

  const result = spawnSync("bash", ["-s", "--", "--hosts", "claude,pi", "--dry-run", "--yes"], {
    cwd,
    input: script,
    encoding: "utf8",
    env: installEnv(home, {
      TMPDIR: tmpRoot,
      XPOWERS_REPO_URL: repo,
      XPOWERS_REF: ref,
    }),
    timeout: 60000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 37, output)
  assert.match(output, /delegated argc=4/)
  assert.match(output, /delegated args=--hosts claude,pi --dry-run --yes/)
  assert.deepEqual(fs.readdirSync(tmpRoot).filter((name) => name.startsWith("xpowers-install.")), [])
})

test("install.sh --hosts pi delegates through the Bun installer entrypoint", { timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-pi-delegate-home-"))
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-pi-delegate-bin-"))
  const argsFile = path.join(home, "bun-args.txt")
  const bunShim = path.join(binDir, "bun")
  fs.writeFileSync(
    bunShim,
    [
      "#!/usr/bin/env bash",
      "printf '%s\\n' \"$@\" > \"$BUN_ARGS_FILE\"",
      "exit 23",
      "",
    ].join("\n"),
    "utf8",
  )
  fs.chmodSync(bunShim, 0o755)

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "pi", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      BUN_ARGS_FILE: argsFile,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    }),
    timeout: 60000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 23, output)
  assert.deepEqual(fs.readFileSync(argsFile, "utf8").trim().split("\n"), [
    "scripts/install.ts",
    "--hosts",
    "pi",
    "--features",
    "tm-cli",
    "--allow-conflicts",
  ])
  assert.doesNotMatch(output, /setup-pi\.sh/)
})

test("install.sh mixed claude+pi install reports both agents in summary", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-mixed-pi-summary-home-"))
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-mixed-pi-summary-bin-"))
  const bunShim = path.join(binDir, "bun")
  fs.writeFileSync(
    bunShim,
    [
      "#!/usr/bin/env bash",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  )
  fs.chmodSync(bunShim, 0o755)
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "claude,pi", "--yes", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.match(output, /2 agent\(s\)/)
  assert.match(output, /Claude Code/)
  assert.match(output, /Pi Agent/)
})

test("install.sh mixed claude+pi install keeps br/bv delegated but installs graphify for non-Pi hosts", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-mixed-pi-third-party-home-"))
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-mixed-pi-third-party-bin-"))
  const hostIndependentMarker = path.join(home, "host-independent-third-party-called")
  const graphifyMarker = path.join(home, "graphify-called")
  const npxMarker = path.join(home, "npx-called")
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })

  fs.writeFileSync(
    path.join(binDir, "bun"),
    "#!/usr/bin/env bash\nprintf '%s\\n' '{\"features\":{\"br\":true,\"bv\":true,\"graphify\":true},\"featureResults\":{\"br\":true,\"bv\":true,\"graphify\":true}}'\nexit 0\n",
    "utf8",
  )
  fs.chmodSync(path.join(binDir, "bun"), 0o755)

  fs.writeFileSync(path.join(binDir, "curl"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$0 $*\" >> \"$HOST_INDEPENDENT_MARKER\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(binDir, "curl"), 0o755)
  fs.writeFileSync(
    path.join(binDir, "python3"),
    [
      "#!/usr/bin/env bash",
      "case \"$*\" in",
      "  *'pip install --user graphifyy'*) printf '%s\\n' \"$0 $*\" >> \"$GRAPHIFY_MARKER\" ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  )
  fs.chmodSync(path.join(binDir, "python3"), 0o755)
  fs.writeFileSync(path.join(binDir, "graphify"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$GRAPHIFY_MARKER\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(binDir, "graphify"), 0o755)
  fs.writeFileSync(path.join(binDir, "npx"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$NPX_MARKER\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(binDir, "npx"), 0o755)

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "claude,pi", "--yes", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      HOST_INDEPENDENT_MARKER: hostIndependentMarker,
      GRAPHIFY_MARKER: graphifyMarker,
      NPX_MARKER: npxMarker,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      XPOWERS_SKIP_THIRD_PARTY_FEATURES: "0",
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.equal(fs.existsSync(hostIndependentMarker), false, "Pi delegation should own br/bv for mixed installs")
  const graphifyCalls = fs.readFileSync(graphifyMarker, "utf8")
  assert.match(graphifyCalls, /pip install --user graphifyy/)
  assert.match(graphifyCalls, /^install$/m)
  assert.match(fs.readFileSync(npxMarker, "utf8"), /claude-mem install/)
  assert.equal(
    fs.readFileSync(path.join(home, ".xpowers", "third-party-tools"), "utf8"),
    "br\nbv\ngraphify\nclaude-mem\n",
  )

  fs.rmSync(binDir, { recursive: true, force: true })
})

test("install.sh mixed claude+pi install retries host-independent tools when Pi features fail", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-mixed-pi-third-party-retry-home-"))
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-mixed-pi-third-party-retry-bin-"))
  const hostIndependentMarker = path.join(home, "host-independent-third-party-called")
  const npxMarker = path.join(home, "npx-called")
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })

  fs.writeFileSync(
    path.join(binDir, "bun"),
    "#!/usr/bin/env bash\nprintf '%s\\n' '{\"features\":{\"br\":true,\"bv\":true,\"graphify\":true},\"featureResults\":{\"br\":false,\"bv\":false,\"graphify\":false}}'\nexit 0\n",
    "utf8",
  )
  fs.chmodSync(path.join(binDir, "bun"), 0o755)
  fs.writeFileSync(path.join(binDir, "curl"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$0 $*\" >> \"$HOST_INDEPENDENT_MARKER\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(binDir, "curl"), 0o755)
  fs.writeFileSync(
    path.join(binDir, "python3"),
    [
      "#!/usr/bin/env bash",
      "case \"$*\" in",
      "  *'pip install --user graphifyy'*) printf '%s\\n' \"$0 $*\" >> \"$HOST_INDEPENDENT_MARKER\" ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  )
  fs.chmodSync(path.join(binDir, "python3"), 0o755)
  fs.writeFileSync(path.join(binDir, "graphify"), "#!/usr/bin/env bash\nexit 0\n", "utf8")
  fs.chmodSync(path.join(binDir, "graphify"), 0o755)
  fs.writeFileSync(path.join(binDir, "npx"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$NPX_MARKER\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(binDir, "npx"), 0o755)

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "claude,pi", "--yes", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      HOST_INDEPENDENT_MARKER: hostIndependentMarker,
      NPX_MARKER: npxMarker,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      XPOWERS_SKIP_THIRD_PARTY_FEATURES: "0",
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  const hostIndependentCalls = fs.readFileSync(hostIndependentMarker, "utf8")
  assert.match(hostIndependentCalls, /beads_rust/)
  assert.match(hostIndependentCalls, /beads_viewer/)
  assert.match(hostIndependentCalls, /graphifyy/)
  assert.match(fs.readFileSync(npxMarker, "utf8"), /claude-mem install/)
  assert.equal(
    fs.readFileSync(path.join(home, ".xpowers", "third-party-tools"), "utf8"),
    "br\nbv\ngraphify\nclaude-mem\n",
  )

  fs.rmSync(binDir, { recursive: true, force: true })
})

test("install.sh mixed claude+pi install records partial Pi third-party success before retry", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-mixed-pi-third-party-partial-home-"))
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-mixed-pi-third-party-partial-bin-"))
  const npxMarker = path.join(home, "npx-called")
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })

  fs.writeFileSync(
    path.join(binDir, "bun"),
    "#!/usr/bin/env bash\nprintf '%s\\n' '{\"features\":{\"br\":true,\"bv\":true,\"graphify\":true},\"featureResults\":{\"br\":true,\"bv\":true,\"graphify\":false}}'\nexit 0\n",
    "utf8",
  )
  fs.chmodSync(path.join(binDir, "bun"), 0o755)
  fs.writeFileSync(path.join(binDir, "curl"), "#!/usr/bin/env bash\nexit 9\n", "utf8")
  fs.chmodSync(path.join(binDir, "curl"), 0o755)
  fs.writeFileSync(path.join(binDir, "python3"), "#!/usr/bin/env bash\nexit 9\n", "utf8")
  fs.chmodSync(path.join(binDir, "python3"), 0o755)
  fs.writeFileSync(path.join(binDir, "npx"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$NPX_MARKER\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(binDir, "npx"), 0o755)

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "claude,pi", "--yes", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      NPX_MARKER: npxMarker,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      XPOWERS_SKIP_THIRD_PARTY_FEATURES: "0",
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.match(output, /br install failed/)
  assert.match(output, /bv install failed/)
  assert.equal(
    fs.readFileSync(path.join(home, ".xpowers", "third-party-tools"), "utf8"),
    "br\nbv\nclaude-mem\n",
  )
  assert.match(fs.readFileSync(npxMarker, "utf8"), /claude-mem install/)

  fs.rmSync(binDir, { recursive: true, force: true })
})

test("install.sh pi-only install records delegated third-party ownership", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-pi-only-third-party-state-home-"))
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-pi-only-third-party-state-bin-"))

  fs.writeFileSync(
    path.join(binDir, "bun"),
    "#!/usr/bin/env bash\nprintf '%s\\n' '{\"features\":{\"br\":true,\"bv\":true,\"graphify\":true},\"featureResults\":{\"br\":true,\"bv\":true,\"graphify\":true}}'\nexit 0\n",
    "utf8",
  )
  fs.chmodSync(path.join(binDir, "bun"), 0o755)

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "pi", "--yes", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      XPOWERS_SKIP_THIRD_PARTY_FEATURES: "0",
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.equal(
    fs.readFileSync(path.join(home, ".xpowers", "third-party-tools"), "utf8"),
    "br\nbv\ngraphify\n",
  )

  fs.rmSync(binDir, { recursive: true, force: true })
})

test("install.sh --all detects Pi when pi executable is in PATH even without ~/.pi", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-pi-detect-exec-home-"))
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-pi-detect-exec-bin-"))
  const piShim = path.join(binDir, "pi")
  fs.writeFileSync(piShim, "#!/bin/sh\nexit 0\n", "utf8")
  fs.chmodSync(piShim, 0o755)
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })

  const result = spawnSync("bash", ["scripts/install.sh", "--all", "--dry-run", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  // Pi is detected but fails because --dry-run is not supported for Pi;
  // other detected agents skip install in dry-run mode.
  assert.notEqual(result.status, 0, output)
  assert.match(output, /Pi Agent/)
  assert.match(output, /dry-run/)
})

test("install.sh mixed claude+pi skips Pi when Bun is missing and continues with Claude", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-mixed-pi-no-bun-home-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-mixed-pi-no-bun-bin-"))
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })

  const bashPath = findExecutable("bash") || "/bin/bash"
  fs.symlinkSync(bashPath, path.join(tmpBinDir, "bash"))

  const result = spawnSync(bashPath, ["scripts/install.sh", "--hosts", "claude,pi", "--yes", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      PATH: `${tmpBinDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  fs.rmSync(tmpBinDir, { recursive: true, force: true })

  assert.notEqual(result.status, 0, output)
  assert.match(output, /Claude Code/)
  assert.match(output, /Pi Agent/)
  assert.match(output, /requires Bun/)
})

test("install.sh deduplicates duplicate --hosts entries", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-dedup-test-"))
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "claude,claude", "--dry-run", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  // Should only mention one Claude Code install, not two
  const matches = output.match(/Would install to Claude Code/g)
  assert.equal(matches ? matches.length : 0, 1, `Expected exactly one Claude mention, got: ${output}`)
})

test("bun installer --yes includes third-party tool features by default", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-third-party-features-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-third-party-bin-"))
  const bunPath = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })

  const result = spawnSync(bunPath, ["scripts/install.ts", "--hosts", "claude", "--yes", "--json", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, { PATH: `${tmpBinDir}${path.delimiter}${process.env.PATH || ""}` }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  const payload = JSON.parse(result.stdout.trim())
  for (const feature of ["br", "bv", "graphify", "claude-mem"]) {
    assert.equal(Object.hasOwn(payload.features, feature), true, `${feature} should be part of the default feature set`)
  }

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("bun installer pins br and bv upstream installer refs by default", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-pinned-third-party-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-pinned-third-party-bin-"))
  const curlLog = path.join(home, "curl-calls")
  const bunPath = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(tmpBinDir, "curl"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$CURL_LOG\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "curl"), 0o755)

  const result = spawnSync(bunPath, ["scripts/install.ts", "--hosts", "claude", "--features", "br,bv", "--yes", "--json", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      CURL_LOG: curlLog,
      PATH: `${tmpBinDir}${path.delimiter}${process.env.PATH || ""}`,
      XPOWERS_SKIP_THIRD_PARTY_FEATURES: "0",
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  const curlCalls = fs.readFileSync(curlLog, "utf8")
  assert.match(curlCalls, /beads_rust\/f4687e51a5aa155fe27cb8ea6d7fdae942b0154f\/install\.sh/)
  assert.match(curlCalls, /beads_viewer\/bb977f5b812b2987d77544872287b502b5b3a444\/install\.sh/)
  assert.doesNotMatch(curlCalls, /beads_(rust|viewer)\/main\/install\.sh/)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("bun installer treats failed br and bv downloads as feature failures", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-third-party-pipefail-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-third-party-pipefail-bin-"))
  const bunPath = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(tmpBinDir, "curl"), "#!/usr/bin/env bash\nexit 9\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "curl"), 0o755)

  const result = spawnSync(bunPath, ["scripts/install.ts", "--hosts", "claude", "--features", "br,bv", "--yes", "--json", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      PATH: `${tmpBinDir}${path.delimiter}${process.env.PATH || ""}`,
      XPOWERS_SKIP_THIRD_PARTY_FEATURES: "0",
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  const payload = JSON.parse(result.stdout.trim())
  assert.equal(payload.featureResults.br, false)
  assert.equal(payload.featureResults.bv, false)
  assert.equal(payload.features.br, false)
  assert.equal(payload.features.bv, false)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("bun installer omits claude-mem for unsupported hosts by default", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-unsupported-claude-mem-"))
  const bunPath = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()
  fs.mkdirSync(path.join(home, ".config", "agents"), { recursive: true })

  const result = spawnSync(bunPath, ["scripts/install.ts", "--hosts", "kimi", "--yes", "--json", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  const payload = JSON.parse(result.stdout.trim())
  assert.equal(Object.hasOwn(payload.features, "claude-mem"), false, "claude-mem should not be selected for Kimi-only installs")
})

test("bun installer omits graphify for unsupported hosts by default", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-unsupported-graphify-"))
  const bunPath = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()
  fs.mkdirSync(path.join(home, ".config", "agents"), { recursive: true })

  const result = spawnSync(bunPath, ["scripts/install.ts", "--hosts", "kimi", "--yes", "--json", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  const payload = JSON.parse(result.stdout.trim())
  assert.equal(Object.hasOwn(payload.features, "graphify"), false, "graphify should not be selected for hosts without upstream platform support")
})

test("bun installer skips default features when selected hosts are invalid", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-invalid-host-default-features-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-invalid-host-default-features-bin-"))
  const markerPath = path.join(home, "feature-tool-called")
  const bunPath = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()

  for (const name of ["curl", "python3", "npx", "npm"]) {
    fs.writeFileSync(
      path.join(tmpBinDir, name),
      "#!/usr/bin/env bash\nprintf '%s\\n' \"${0##*/} $*\" >> \"$FEATURE_TOOL_MARKER\"\nexit 0\n",
      "utf8",
    )
    fs.chmodSync(path.join(tmpBinDir, name), 0o755)
  }

  const result = spawnSync(bunPath, ["scripts/install.ts", "--hosts", "not-a-host", "--yes", "--json", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      FEATURE_TOOL_MARKER: markerPath,
      PATH: `${tmpBinDir}${path.delimiter}${process.env.PATH || ""}`,
      XPOWERS_SKIP_THIRD_PARTY_FEATURES: "0",
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 1, output)
  const payload = JSON.parse(result.stdout.trim())
  assert.equal(payload.ok, false)
  assert.deepEqual(payload.hosts, [])
  assert.deepEqual(payload.features, {})
  assert.equal(fs.existsSync(markerPath), false, "default feature installers should not run after invalid host selection")
  const manifest = JSON.parse(fs.readFileSync(path.join(home, ".xpowers", "manifest.json"), "utf8"))
  assert.deepEqual(manifest.features, {})

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("bun installer runs graphify platform setup for each supported selected host", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-graphify-platforms-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-graphify-platforms-bin-"))
  const graphifyLog = path.join(home, "graphify-calls")
  const pythonLog = path.join(home, "python-calls")
  const bunPath = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  const bashPath = spawnSync("bash", ["-lc", "command -v bash"], { encoding: "utf8" }).stdout.trim() || "/bin/bash"
  fs.symlinkSync(bashPath, path.join(tmpBinDir, "bash"))
  fs.writeFileSync(
    path.join(tmpBinDir, "python3"),
    [
      "#!/usr/bin/env bash",
      "printf '%s\\n' \"$*\" >> \"$PYTHON_LOG\"",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  )
  fs.chmodSync(path.join(tmpBinDir, "python3"), 0o755)
  fs.writeFileSync(
    path.join(tmpBinDir, "graphify"),
    [
      "#!/usr/bin/env bash",
      "printf '%s\\n' \"$*\" >> \"$GRAPHIFY_LOG\"",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  )
  fs.chmodSync(path.join(tmpBinDir, "graphify"), 0o755)

  const result = spawnSync(bunPath, ["scripts/install.ts", "--hosts", "claude,opencode,gemini,pi", "--features", "graphify", "--yes", "--json", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      GRAPHIFY_LOG: graphifyLog,
      PYTHON_LOG: pythonLog,
      PATH: tmpBinDir,
      XPOWERS_SKIP_THIRD_PARTY_FEATURES: "0",
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 1, output)
  assert.match(fs.readFileSync(pythonLog, "utf8"), /pip install --user graphifyy --quiet/)
  const graphifyCalls = fs.readFileSync(graphifyLog, "utf8").trim().split("\n")
  assert.deepEqual(graphifyCalls, [
    "install",
    "install --platform opencode",
    "install --platform gemini",
    "install --platform pi",
  ])
})

test("bun installer reports claude-mem skipped before requiring npx for unsupported hosts", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-claude-mem-skip-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-claude-mem-skip-bin-"))
  const bunPath = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()
  fs.mkdirSync(path.join(home, ".config", "agents"), { recursive: true })
  const bashPath = spawnSync("bash", ["-lc", "command -v bash"], { encoding: "utf8" }).stdout.trim() || "/bin/bash"
  fs.symlinkSync(bashPath, path.join(tmpBinDir, "bash"))

  const result = spawnSync(bunPath, ["scripts/install.ts", "--hosts", "kimi", "--features", "claude-mem", "--yes", "--json", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, { PATH: tmpBinDir, XPOWERS_SKIP_THIRD_PARTY_FEATURES: "0" }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  const manifest = JSON.parse(fs.readFileSync(path.join(home, ".xpowers", "manifest.json"), "utf8"))
  assert.equal(manifest.features["claude-mem"].metadata.lastResult, "skipped (Claude Code, OpenCode, Gemini CLI, or Antigravity CLI not selected)")

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("bun installer attempts all claude-mem targets before reporting failures", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-claude-mem-all-targets-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-claude-mem-all-targets-bin-"))
  const npxLog = path.join(home, "npx-calls")
  const bunPath = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(
    path.join(tmpBinDir, "npx"),
    [
      "#!/usr/bin/env bash",
      "printf '%s\\n' \"$*\" >> \"$NPX_LOG\"",
      "case \"$*\" in",
      "  *'--ide opencode'*) exit 0 ;;",
      "  *) exit 7 ;;",
      "esac",
      "",
    ].join("\n"),
    "utf8",
  )
  fs.chmodSync(path.join(tmpBinDir, "npx"), 0o755)

  const result = spawnSync(bunPath, ["scripts/install.ts", "--hosts", "claude,opencode", "--features", "claude-mem", "--yes", "--json", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      NPX_LOG: npxLog,
      PATH: `${tmpBinDir}${path.delimiter}${process.env.PATH || ""}`,
      XPOWERS_SKIP_THIRD_PARTY_FEATURES: "0",
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  const calls = fs.readFileSync(npxLog, "utf8").trim().split("\n")
  assert.equal(calls.length, 2)
  assert.match(calls[0], /claude-mem install$/)
  assert.match(calls[1], /claude-mem install --ide opencode$/)
  const manifest = JSON.parse(fs.readFileSync(path.join(home, ".xpowers", "manifest.json"), "utf8"))
  assert.match(manifest.features["claude-mem"].metadata.lastResult, /installed for OpenCode/)
  assert.match(manifest.features["claude-mem"].metadata.lastResult, /Claude Code/)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("bun installer preserves installed state when third-party features are skipped", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-third-party-preserve-"))
  const bunPath = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.mkdirSync(path.join(home, ".xpowers"), { recursive: true })
  fs.writeFileSync(
    path.join(home, ".xpowers", "manifest.json"),
    JSON.stringify({
      version: "test",
      installedAt: "2026-05-04T00:00:00.000Z",
      hosts: {},
      features: {
        br: { installed: true, metadata: { lastResult: "br installed" } },
      },
    }) + "\n",
    "utf8",
  )

  const result = spawnSync(bunPath, ["scripts/install.ts", "--hosts", "claude", "--features", "br", "--yes", "--json", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  const payload = JSON.parse(result.stdout.trim())
  assert.equal(payload.features.br, true)
  assert.equal(payload.featureResults.br, false)
  const manifest = JSON.parse(fs.readFileSync(path.join(home, ".xpowers", "manifest.json"), "utf8"))
  assert.equal(manifest.features.br.installed, true)
  assert.equal(manifest.features.br.metadata.lastResult, "skipped (XPOWERS_SKIP_THIRD_PARTY_FEATURES=1)")
})

test("install.sh skips third-party tool bundle when requested by environment", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-skip-"))
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })

  const result = spawnSync("bash", ["scripts/install.sh", "--claude", "--yes", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.match(output, /Skipping third-party tool bundle/)
})

test("install.sh does not run third-party tool bundle without --yes", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-no-force-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-no-force-bin-"))
  const markerPath = path.join(home, "third-party-called")
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ statusline: "existing" }) + "\n", "utf8")
  for (const name of ["curl", "npx"]) {
    fs.writeFileSync(
      path.join(tmpBinDir, name),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$0 $*" >> "$THIRD_PARTY_MARKER"\nexit 0\n`,
      "utf8",
    )
    fs.chmodSync(path.join(tmpBinDir, name), 0o755)
  }
  fs.writeFileSync(path.join(tmpBinDir, "python3"), "#!/usr/bin/env bash\nexit 1\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "python3"), 0o755)

  const result = spawnSync("bash", ["scripts/install.sh", "--claude", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      PATH: `${tmpBinDir}${path.delimiter}${process.env.PATH || ""}`,
      THIRD_PARTY_MARKER: markerPath,
      XPOWERS_SKIP_THIRD_PARTY_FEATURES: "0",
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.equal(fs.existsSync(markerPath), false, "third-party installer shims should not run without --yes")

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("install.sh skips third-party tool bundle when all selected hosts fail", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-all-hosts-fail-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-all-hosts-fail-bin-"))
  const markerPath = path.join(home, "third-party-called")

  for (const name of ["curl", "python3", "npx"]) {
    fs.writeFileSync(
      path.join(tmpBinDir, name),
      "#!/usr/bin/env bash\nprintf '%s\\n' \"${0##*/} $*\" >> \"$THIRD_PARTY_MARKER\"\nexit 0\n",
      "utf8",
    )
    fs.chmodSync(path.join(tmpBinDir, name), 0o755)
  }
  fs.writeFileSync(path.join(tmpBinDir, "npm"), "#!/usr/bin/env bash\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "npm"), 0o755)
  fs.writeFileSync(path.join(tmpBinDir, "gemini"), "#!/usr/bin/env bash\nexit 9\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "gemini"), 0o755)

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "gemini", "--yes", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      PATH: `${tmpBinDir}${path.delimiter}${process.env.PATH || ""}`,
      THIRD_PARTY_MARKER: markerPath,
      XPOWERS_SKIP_THIRD_PARTY_FEATURES: "0",
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 1, output)
  assert.match(output, /Skipping third-party tool bundle because no selected agents installed successfully/)
  assert.equal(fs.existsSync(markerPath), false, "third-party installer shims should not run after all host installs fail")

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("install.sh runs claude-mem only for successfully installed selected hosts", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-successful-hosts-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-successful-hosts-bin-"))
  const npxMarker = path.join(home, "npx-called")
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ statusline: "existing" }) + "\n", "utf8")

  fs.writeFileSync(path.join(tmpBinDir, "curl"), "#!/usr/bin/env bash\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "curl"), 0o755)
  fs.writeFileSync(path.join(tmpBinDir, "python3"), "#!/usr/bin/env bash\nexit 9\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "python3"), 0o755)
  fs.writeFileSync(path.join(tmpBinDir, "npm"), "#!/usr/bin/env bash\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "npm"), 0o755)
  fs.writeFileSync(path.join(tmpBinDir, "gemini"), "#!/usr/bin/env bash\nexit 9\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "gemini"), 0o755)
  fs.writeFileSync(path.join(tmpBinDir, "npx"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$NPX_MARKER\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "npx"), 0o755)

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "claude,gemini", "--yes", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      NPX_MARKER: npxMarker,
      PATH: `${tmpBinDir}${path.delimiter}${process.env.PATH || ""}`,
      XPOWERS_SKIP_THIRD_PARTY_FEATURES: "0",
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 1, output)
  const npxCalls = fs.readFileSync(npxMarker, "utf8").trim().split("\n")
  assert.equal(npxCalls.length, 1)
  assert.match(npxCalls[0], /claude-mem install$/)
  assert.doesNotMatch(npxCalls[0], /gemini-cli/)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("install.sh runs graphify Codex platform setup for Codex installs", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-graphify-codex-home-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-graphify-codex-bin-"))
  const graphifyLog = path.join(home, "graphify-calls")
  const pythonLog = path.join(home, "python-calls")
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true })

  fs.writeFileSync(path.join(tmpBinDir, "curl"), "#!/usr/bin/env bash\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "curl"), 0o755)
  fs.writeFileSync(
    path.join(tmpBinDir, "python3"),
    [
      "#!/usr/bin/env bash",
      "printf '%s\\n' \"$*\" >> \"$PYTHON_LOG\"",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  )
  fs.chmodSync(path.join(tmpBinDir, "python3"), 0o755)
  fs.writeFileSync(
    path.join(tmpBinDir, "graphify"),
    [
      "#!/usr/bin/env bash",
      "printf '%s\\n' \"$*\" >> \"$GRAPHIFY_LOG\"",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  )
  fs.chmodSync(path.join(tmpBinDir, "graphify"), 0o755)
  fs.writeFileSync(path.join(tmpBinDir, "npx"), "#!/usr/bin/env bash\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "npx"), 0o755)

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "codex", "--yes", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      GRAPHIFY_LOG: graphifyLog,
      PYTHON_LOG: pythonLog,
      PATH: `${tmpBinDir}${path.delimiter}${process.env.PATH || ""}`,
      XPOWERS_SKIP_THIRD_PARTY_FEATURES: "0",
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.match(fs.readFileSync(pythonLog, "utf8"), /pip install --user graphifyy/)
  assert.deepEqual(fs.readFileSync(graphifyLog, "utf8").trim().split("\n"), ["install --platform codex"])

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("install.sh supports pinned third-party installer ref overrides", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-pinned-third-party-home-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-pinned-third-party-bin-"))
  const curlLog = path.join(home, "curl-calls")
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ statusline: "existing" }) + "\n", "utf8")
  fs.writeFileSync(path.join(tmpBinDir, "curl"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$CURL_LOG\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "curl"), 0o755)
  fs.writeFileSync(path.join(tmpBinDir, "python3"), "#!/usr/bin/env bash\nexit 9\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "python3"), 0o755)
  fs.writeFileSync(path.join(tmpBinDir, "npx"), "#!/usr/bin/env bash\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "npx"), 0o755)

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "claude", "--yes", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      CURL_LOG: curlLog,
      PATH: `${tmpBinDir}${path.delimiter}${process.env.PATH || ""}`,
      XPOWERS_BEADS_RUST_INSTALL_REF: "rust-test-ref",
      XPOWERS_BEADS_VIEWER_INSTALL_REF: "viewer-test-ref",
      XPOWERS_SKIP_THIRD_PARTY_FEATURES: "0",
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  const curlCalls = fs.readFileSync(curlLog, "utf8")
  assert.match(curlCalls, /beads_rust\/rust-test-ref\/install\.sh/)
  assert.match(curlCalls, /beads_viewer\/viewer-test-ref\/install\.sh/)
  assert.doesNotMatch(curlCalls, /beads_(rust|viewer)\/main\/install\.sh/)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("install.sh uninstall removes tracked third-party tools", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-uninstall-home-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-uninstall-bin-"))
  const pipLog = path.join(home, "pip-uninstall")
  const npxLog = path.join(home, "npx-uninstall")
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.mkdirSync(path.join(home, ".xpowers"), { recursive: true })
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".xpowers-manifest"), "# .xpowers-manifest\n", "utf8")
  fs.writeFileSync(path.join(home, ".xpowers", "third-party-tools"), "br\nbv\ngraphify\nclaude-mem\n", "utf8")
  fs.writeFileSync(path.join(home, ".local", "bin", "br"), "br\n", "utf8")
  fs.writeFileSync(path.join(home, ".local", "bin", "bv"), "bv\n", "utf8")
  fs.writeFileSync(path.join(tmpBinDir, "python3"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$PIP_LOG\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "python3"), 0o755)
  fs.writeFileSync(path.join(tmpBinDir, "npx"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$NPX_LOG\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "npx"), 0o755)

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "claude", "--uninstall", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      PATH: `${tmpBinDir}${path.delimiter}/usr/bin:/bin`,
      PIP_LOG: pipLog,
      NPX_LOG: npxLog,
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "br")), false)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "bv")), false)
  assert.match(fs.readFileSync(pipLog, "utf8"), /pip uninstall -y graphifyy/)
  assert.match(fs.readFileSync(npxLog, "utf8"), /claude-mem uninstall --all/)
  assert.equal(fs.existsSync(path.join(home, ".xpowers", "third-party-tools")), false)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("install.sh uninstall removes manifest-only third-party tools", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-manifest-uninstall-home-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-manifest-uninstall-bin-"))
  const pipLog = path.join(home, "pip-uninstall")
  const npxLog = path.join(home, "npx-uninstall")
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.mkdirSync(path.join(home, ".xpowers"), { recursive: true })
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".xpowers-manifest"), "# .xpowers-manifest\n", "utf8")
  fs.writeFileSync(path.join(home, ".local", "bin", "br"), "br\n", "utf8")
  fs.writeFileSync(path.join(home, ".local", "bin", "bv"), "bv\n", "utf8")
  fs.writeFileSync(
    path.join(home, ".xpowers", "manifest.json"),
    JSON.stringify({
      version: "test",
      installedAt: "2026-05-05T00:00:00.000Z",
      hosts: {},
      features: {
        br: { installed: true },
        bv: { installed: true },
        graphify: { installed: true },
        "claude-mem": { installed: true },
      },
    }) + "\n",
    "utf8",
  )
  fs.writeFileSync(path.join(tmpBinDir, "python3"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$PIP_LOG\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "python3"), 0o755)
  fs.writeFileSync(path.join(tmpBinDir, "npx"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$NPX_LOG\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "npx"), 0o755)
  linkManifestRuntime(tmpBinDir)

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "claude", "--uninstall", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      PATH: `${tmpBinDir}${path.delimiter}/usr/bin:/bin`,
      PIP_LOG: pipLog,
      NPX_LOG: npxLog,
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "br")), false)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "bv")), false)
  assert.match(fs.readFileSync(pipLog, "utf8"), /pip uninstall -y graphifyy/)
  assert.match(fs.readFileSync(npxLog, "utf8"), /claude-mem uninstall --all/)
  assert.equal(fs.existsSync(path.join(home, ".xpowers", "third-party-tools")), false)
  const manifest = JSON.parse(fs.readFileSync(path.join(home, ".xpowers", "manifest.json"), "utf8"))
  assert.equal(manifest.features.br.installed, false)
  assert.equal(manifest.features.bv.installed, false)
  assert.equal(manifest.features.graphify.installed, false)
  assert.equal(manifest.features["claude-mem"].installed, false)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("install.sh manifest probes fall back when node runtime fails", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-manifest-node-fail-home-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-manifest-node-fail-bin-"))
  const nodeLog = path.join(home, "node-probe")
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.mkdirSync(path.join(home, ".xpowers"), { recursive: true })
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".xpowers-manifest"), "# .xpowers-manifest\n", "utf8")
  fs.writeFileSync(path.join(home, ".local", "bin", "br"), "br\n", "utf8")
  fs.writeFileSync(path.join(home, ".local", "bin", "bv"), "bv\n", "utf8")
  fs.writeFileSync(
    path.join(home, ".xpowers", "manifest.json"),
    JSON.stringify({
      version: "test",
      installedAt: "2026-05-05T00:00:00.000Z",
      hosts: {},
      features: {
        br: { installed: true },
        bv: { installed: true },
      },
    }) + "\n",
    "utf8",
  )
  fs.writeFileSync(path.join(tmpBinDir, "node"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$NODE_LOG\"\nexit 9\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "node"), 0o755)

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "claude", "--uninstall", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      NODE_LOG: nodeLog,
      PATH: `${tmpBinDir}${path.delimiter}/usr/bin:/bin`,
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.match(fs.readFileSync(nodeLog, "utf8"), /manifest\.features/)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "br")), false)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "bv")), false)
  const manifest = JSON.parse(fs.readFileSync(path.join(home, ".xpowers", "manifest.json"), "utf8"))
  assert.equal(manifest.features.br.installed, false)
  assert.equal(manifest.features.bv.installed, false)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("install.sh manifest fallback reads pretty manifest without js or python runtimes", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-manifest-awk-home-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-manifest-awk-bin-"))
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.mkdirSync(path.join(home, ".xpowers"), { recursive: true })
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".xpowers-manifest"), "# .xpowers-manifest\n", "utf8")
  fs.writeFileSync(path.join(home, ".local", "bin", "br"), "br\n", "utf8")
  fs.writeFileSync(path.join(home, ".local", "bin", "bv"), "bv\n", "utf8")
  fs.writeFileSync(
    path.join(home, ".xpowers", "manifest.json"),
    JSON.stringify(
      {
        version: "test",
        installedAt: "2026-05-05T00:00:00.000Z",
        hosts: {},
        features: {
          br: { installed: true },
          bv: { installed: true },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  )
  for (const command of ["awk", "basename", "bash", "dirname", "grep", "rm", "rmdir", "tr"]) {
    linkCommand(tmpBinDir, command)
  }

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "claude", "--uninstall", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      PATH: tmpBinDir,
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "br")), false)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "bv")), false)
  assert.match(output, /Could not update third-party entries/)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("install.sh uninstall preserves third-party state when cleanup fails", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-uninstall-fail-home-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-uninstall-fail-bin-"))
  const pipLog = path.join(home, "pip-uninstall")
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.mkdirSync(path.join(home, ".xpowers"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".xpowers-manifest"), "# .xpowers-manifest\n", "utf8")
  fs.writeFileSync(path.join(home, ".xpowers", "third-party-tools"), "graphify\n", "utf8")
  fs.writeFileSync(path.join(tmpBinDir, "python3"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$PIP_LOG\"\nexit 9\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "python3"), 0o755)

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "claude", "--uninstall", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      PATH: `${tmpBinDir}${path.delimiter}/usr/bin:/bin`,
      PIP_LOG: pipLog,
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.match(fs.readFileSync(pipLog, "utf8"), /pip uninstall -y graphifyy/)
  assert.equal(fs.readFileSync(path.join(home, ".xpowers", "third-party-tools"), "utf8"), "graphify\n")
  assert.match(output, /Keeping third-party tracking for retry/)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("install.sh dry-run uninstall preserves tracked third-party tools", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-dry-run-uninstall-home-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-dry-run-uninstall-bin-"))
  const pipLog = path.join(home, "pip-uninstall")
  const npxLog = path.join(home, "npx-uninstall")
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.mkdirSync(path.join(home, ".xpowers"), { recursive: true })
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".xpowers-manifest"), "# .xpowers-manifest\n", "utf8")
  fs.writeFileSync(path.join(home, ".xpowers", "third-party-tools"), "br\nbv\ngraphify\nclaude-mem\n", "utf8")
  fs.writeFileSync(path.join(home, ".local", "bin", "br"), "br\n", "utf8")
  fs.writeFileSync(path.join(home, ".local", "bin", "bv"), "bv\n", "utf8")
  fs.writeFileSync(path.join(tmpBinDir, "python3"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$PIP_LOG\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "python3"), 0o755)
  fs.writeFileSync(path.join(tmpBinDir, "npx"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$NPX_LOG\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "npx"), 0o755)

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "claude", "--uninstall", "--dry-run", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      PATH: `${tmpBinDir}${path.delimiter}/usr/bin:/bin`,
      PIP_LOG: pipLog,
      NPX_LOG: npxLog,
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.match(output, /Would remove tracked third-party tool bundle/)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "br")), true)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "bv")), true)
  assert.equal(fs.existsSync(pipLog), false)
  assert.equal(fs.existsSync(npxLog), false)
  assert.equal(fs.existsSync(path.join(home, ".xpowers", "third-party-tools")), true)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("install.sh partial uninstall preserves tracked third-party tools", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-partial-uninstall-home-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-partial-uninstall-bin-"))
  const pipLog = path.join(home, "pip-uninstall")
  const npxLog = path.join(home, "npx-uninstall")
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true })
  fs.mkdirSync(path.join(home, ".xpowers"), { recursive: true })
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".xpowers-manifest"), "# .xpowers-manifest\n", "utf8")
  fs.writeFileSync(path.join(home, ".codex", ".xpowers-manifest"), "# .xpowers-manifest\n", "utf8")
  fs.writeFileSync(path.join(home, ".xpowers", "third-party-tools"), "br\nbv\ngraphify\nclaude-mem\n", "utf8")
  fs.writeFileSync(path.join(home, ".local", "bin", "br"), "br\n", "utf8")
  fs.writeFileSync(path.join(home, ".local", "bin", "bv"), "bv\n", "utf8")
  fs.writeFileSync(path.join(tmpBinDir, "python3"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$PIP_LOG\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "python3"), 0o755)
  fs.writeFileSync(path.join(tmpBinDir, "npx"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$NPX_LOG\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "npx"), 0o755)

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "claude", "--uninstall", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      PATH: `${tmpBinDir}${path.delimiter}/usr/bin:/bin`,
      PIP_LOG: pipLog,
      NPX_LOG: npxLog,
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "br")), true)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "bv")), true)
  assert.equal(fs.existsSync(pipLog), false)
  assert.equal(fs.existsSync(npxLog), false)
  assert.equal(fs.readFileSync(path.join(home, ".xpowers", "third-party-tools"), "utf8"), "br\nbv\ngraphify\nclaude-mem\n")

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("install.sh partial uninstall compares selected and detected host sets before third-party cleanup", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-mismatched-host-uninstall-home-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-mismatched-host-uninstall-bin-"))
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.mkdirSync(path.join(home, ".xpowers"), { recursive: true })
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true })
  fs.writeFileSync(path.join(home, ".xpowers", "third-party-tools"), "br\nbv\n", "utf8")
  fs.writeFileSync(path.join(home, ".local", "bin", "br"), "br\n", "utf8")
  fs.writeFileSync(path.join(home, ".local", "bin", "bv"), "bv\n", "utf8")

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "gemini", "--uninstall", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      PATH: `${tmpBinDir}${path.delimiter}/usr/bin:/bin`,
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "br")), true)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "bv")), true)
  assert.equal(fs.readFileSync(path.join(home, ".xpowers", "third-party-tools"), "utf8"), "br\nbv\n")
  assert.doesNotMatch(output, /Removing tracked third-party tool bundle/)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("install.sh explicit purge cleans shared tools when no hosts are detected", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-no-detected-host-uninstall-home-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-third-party-no-detected-host-uninstall-bin-"))
  fs.mkdirSync(path.join(home, ".xpowers"), { recursive: true })
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true })
  fs.writeFileSync(path.join(home, ".xpowers", "third-party-tools"), "br\nbv\n", "utf8")
  fs.writeFileSync(path.join(home, ".local", "bin", "br"), "br\n", "utf8")
  fs.writeFileSync(path.join(home, ".local", "bin", "bv"), "bv\n", "utf8")

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "claude", "--uninstall", "--yes", "--purge"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      PATH: `${tmpBinDir}${path.delimiter}/usr/bin:/bin`,
    }),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "br")), false)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "bv")), false)
  assert.equal(fs.existsSync(path.join(home, ".xpowers", "third-party-tools")), false)
  assert.match(output, /Removing tracked third-party tool bundle/)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("bun installer fails fast on legacy package conflicts unless explicitly overridden", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-conflict-test-"))
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  const conflicts = makeConflictFixture(home)

  const blocked = spawnSync("bun", ["scripts/install.ts", "--yes", "--hosts", "claude"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 120000,
  })

  const blockedOutput = combinedOutput(blocked)
  assert.notEqual(blocked.status, 0)
  assert.match(blockedOutput, /conflicting install/i)
  assert.match(blockedOutput, /hyperpowers/i)
  assert.match(blockedOutput, new RegExp(conflicts[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(blockedOutput, /--allow-conflicts/)

  const allowed = spawnSync("bun", ["scripts/install.ts", "--yes", "--hosts", "claude", "--features", "not-a-real-feature", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 120000,
  })

  const allowedOutput = combinedOutput(allowed)
  assert.equal(allowed.status, 0, allowedOutput)
  assert.doesNotMatch(allowedOutput, /conflicting install/i)
})

test("install.sh fails fast on legacy package conflicts in non-interactive mode", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-conflict-test-"))
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  const conflicts = makeConflictFixture(home)

  const result = spawnSync("bash", ["scripts/install.sh", "--claude", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.notEqual(result.status, 0)
  assert.match(output, /conflicting install/i)
  assert.match(output, /hyperpowers/i)
  assert.match(output, new RegExp(conflicts[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(output, /--allow-conflicts/)

  const allowed = spawnSync("bash", ["scripts/install.sh", "--claude", "--yes", "--allow-conflicts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 120000,
  })

  const allowedOutput = combinedOutput(allowed)
  assert.equal(allowed.status, 0, allowedOutput)
  assert.doesNotMatch(allowedOutput, /conflicting install/i)
})

test("bun installer conflict guard stays before host selection and keeps --hosts interactive", () => {
  const source = fs.readFileSync(path.join(repoRoot, "scripts", "install.ts"), "utf8")
  const conflictGuardIndex = source.indexOf("const conflicts = detectConflictingInstalls()")
  const phase2Index = source.indexOf("// Phase 2: Select hosts")
  assert.ok(conflictGuardIndex > -1, "conflict guard should exist")
  assert.ok(phase2Index > -1, "Phase 2 host selection should exist")
  assert.ok(conflictGuardIndex < phase2Index, "conflict guard should run before host selection UI")

  const nonInteractiveLine = source.match(/const nonInteractive = (?<expr>[^\n]+)/)?.groups?.expr || ""
  assert.ok(nonInteractiveLine.length > 0, "nonInteractive expression should be present in install.ts")
  assert.doesNotMatch(nonInteractiveLine, /args\.hosts/, "--hosts alone must not suppress the conflict prompt")
})

test("bun installer json mode reports structured conflict failures", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-json-conflict-test-"))
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  const conflicts = makeConflictFixture(home)

  const result = spawnSync("bun", ["scripts/install.ts", "--json", "--hosts", "claude"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 120000,
  })

  assert.notEqual(result.status, 0)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, false)
  assert.match(payload.error, /conflicting install/i)
  assert.match(payload.error, new RegExp(conflicts[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(payload.error, /--allow-conflicts/)
})

test("setup-pi.sh fails fast on legacy package conflicts before download", { timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "setup-pi-conflict-test-"))
  const binDir = path.join(home, "bin")
  fs.mkdirSync(binDir, { recursive: true })
  for (const cmd of ["pi", "git", "bun"]) {
    const cmdPath = path.join(binDir, cmd)
    fs.writeFileSync(cmdPath, "#!/usr/bin/env bash\nexit 0\n", "utf8")
    fs.chmodSync(cmdPath, 0o755)
  }
  const conflicts = makeConflictFixture(home)

  const result = spawnSync("bash", ["scripts/setup-pi.sh"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, { PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` }),
    timeout: 60000,
  })

  const output = combinedOutput(result)
  assert.notEqual(result.status, 0)
  assert.match(output, /conflicting install/i)
  assert.match(output, /hyperpowers/i)
  assert.match(output, new RegExp(conflicts[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(output, /--allow-conflicts/)
})

test("README documents safe curl installer and conflict override", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8")

  assert.match(readme, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/dpolishuk\/xpowers\/main\/scripts\/install\.sh \| bash/)
  assert.match(readme, /--allow-conflicts/)
  assert.match(readme, /hyperpowers/i)
  assert.match(readme, /myhyperpowers/i)
  assert.match(readme, /superpowers/i)
})

test("install.sh full uninstall preserves unrelated ~/.local/bin/node_modules directory", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-test-"))
  const codexHome = path.join(home, ".codex")
  const binDir = path.join(home, ".local", "bin")
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true })
  fs.mkdirSync(path.join(home, ".config", "agents"), { recursive: true })

  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, ".xpowers-manifest"), "# test manifest\n", "utf8")
  fs.writeFileSync(path.join(codexHome, ".xpowers-version"), "test\n", "utf8")
  fs.mkdirSync(path.join(binDir, "node_modules"), { recursive: true })

  fs.writeFileSync(path.join(home, ".claude", ".xpowers-manifest"), "# test manifest\n", "utf8")
  fs.writeFileSync(path.join(home, ".claude", ".xpowers-version"), "test\n", "utf8")
  fs.writeFileSync(path.join(home, ".config", "opencode", ".xpowers-manifest"), "# test manifest\n", "utf8")
  fs.writeFileSync(path.join(home, ".config", "opencode", ".xpowers-version"), "test\n", "utf8")
  fs.writeFileSync(path.join(home, ".config", "agents", ".xpowers-manifest"), "# test manifest\n", "utf8")
  fs.writeFileSync(path.join(home, ".config", "agents", ".xpowers-version"), "test\n", "utf8")

  const result = spawnSync("bash", ["scripts/install.sh", "--uninstall", "--all", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 20000,
  })

  assert.equal(result.status, 0)
  assert.equal(fs.existsSync(path.join(binDir, "node_modules")), true)
})

test("install.sh full uninstall removes managed ~/.local/bin/node_modules symlink", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-test-"))
  const codexHome = path.join(home, ".codex")
  const binDir = path.join(home, ".local", "bin")
  const libNodeModules = path.join(home, ".local", "lib", "tm", "node_modules")

  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true })
  fs.mkdirSync(path.join(home, ".config", "agents"), { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, ".xpowers-manifest"), "# test manifest\n", "utf8")
  fs.writeFileSync(path.join(codexHome, ".xpowers-version"), "test\n", "utf8")
  fs.writeFileSync(path.join(home, ".claude", ".xpowers-manifest"), "# test manifest\n", "utf8")
  fs.writeFileSync(path.join(home, ".claude", ".xpowers-version"), "test\n", "utf8")
  fs.writeFileSync(path.join(home, ".config", "opencode", ".xpowers-manifest"), "# test manifest\n", "utf8")
  fs.writeFileSync(path.join(home, ".config", "opencode", ".xpowers-version"), "test\n", "utf8")
  fs.writeFileSync(path.join(home, ".config", "agents", ".xpowers-manifest"), "# test manifest\n", "utf8")
  fs.writeFileSync(path.join(home, ".config", "agents", ".xpowers-version"), "test\n", "utf8")
  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(libNodeModules, { recursive: true })
  fs.symlinkSync(libNodeModules, path.join(binDir, "node_modules"), "dir")

  const result = spawnSync("bash", ["scripts/install.sh", "--uninstall", "--all", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 20000,
  })

  assert.equal(result.status, 0)
  assert.equal(fs.existsSync(path.join(binDir, "node_modules")), false)
})

test("install.sh uninstall accepts legacy manifest name", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-legacy-manifest-test-"))
  const codexHome = path.join(home, ".codex")
  const oldNs = "hyper" + "powers"

  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true })
  fs.mkdirSync(path.join(home, ".config", "agents"), { recursive: true })
  fs.mkdirSync(path.join(codexHome, "skills", "legacy-skill"), { recursive: true })
  fs.writeFileSync(path.join(codexHome, `.${oldNs}-manifest`), "skills/legacy-skill/\n", "utf8")
  fs.writeFileSync(path.join(codexHome, `.${oldNs}-version`), "test\n", "utf8")

  const result = spawnSync("bash", ["scripts/install.sh", "--uninstall", "--codex", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 20000,
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(fs.existsSync(path.join(codexHome, "skills", "legacy-skill")), false)
  assert.equal(fs.existsSync(path.join(codexHome, `.${oldNs}-manifest`)), false)
  assert.equal(fs.existsSync(path.join(codexHome, `.${oldNs}-version`)), false)
})

test("install.sh partial uninstall preserves shared tm runtime", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-test-"))
  const codexHome = path.join(home, ".codex")
  const binDir = path.join(home, ".local", "bin")
  const libDir = path.join(home, ".local", "lib", "tm")

  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true })
  fs.mkdirSync(path.join(home, ".config", "agents"), { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(libDir, { recursive: true })
  fs.writeFileSync(path.join(codexHome, ".xpowers-manifest"), "# test manifest\n", "utf8")
  fs.writeFileSync(path.join(codexHome, ".xpowers-version"), "test\n", "utf8")
  fs.writeFileSync(path.join(binDir, "tm"), "#!/bin/sh\n", "utf8")
  fs.writeFileSync(path.join(binDir, "tm-linear-sync.js"), "sync\n", "utf8")
  fs.writeFileSync(path.join(binDir, "tm-linear-sync-config.js"), "config\n", "utf8")
  fs.mkdirSync(path.join(binDir, "node_modules"), { recursive: true })
  fs.writeFileSync(path.join(libDir, "tm-linear-sync.js"), "sync\n", "utf8")
  fs.writeFileSync(path.join(libDir, "tm-linear-sync-config.js"), "config\n", "utf8")

  const result = spawnSync("bash", ["scripts/install.sh", "--uninstall", "--codex", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 20000,
  })

  assert.equal(result.status, 0)
  assert.equal(fs.existsSync(path.join(binDir, "tm")), true)
  assert.equal(fs.existsSync(path.join(libDir, "tm-linear-sync.js")), true)
  assert.equal(fs.existsSync(path.join(binDir, "node_modules")), true)
})

test("install.sh opencode moves pre-existing node_modules directory aside and installs managed symlink", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-test-"))
  const binDir = path.join(home, ".local", "bin")
  const libDir = path.join(home, ".local", "lib", "tm")
  const opencodeHome = path.join(home, ".config", "opencode")

  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.mkdirSync(opencodeHome, { recursive: true })
  fs.mkdirSync(path.join(home, ".config", "agents"), { recursive: true })
  // Pre-create a real directory at ~/.local/bin/node_modules
  fs.mkdirSync(path.join(binDir, "node_modules", "some-pkg"), { recursive: true })

  const result = spawnSync("bash", ["scripts/install.sh", "--opencode", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 120000,
  })

  assert.equal(result.status, 0)
  const nmPath = path.join(binDir, "node_modules")
  const stat = fs.lstatSync(nmPath)
  assert.equal(stat.isSymbolicLink(), true, "node_modules should be a symlink, not a directory")
  assert.equal(fs.readlinkSync(nmPath), path.join(libDir, "node_modules"))
  const backupPath = path.join(binDir, "node_modules.xpowers-backup")
  assert.equal(fs.existsSync(backupPath), true)
  assert.equal(fs.existsSync(path.join(backupPath, "some-pkg")), true)
})

test("bun installer uninstall reads legacy manifest location", { timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-legacy-manifest-test-"))
  const oldNs = "hyper" + "powers"
  const claudeHome = path.join(home, ".claude")
  const legacyManifestDir = path.join(home, `.${oldNs}`)
  const legacyFile = path.join(claudeHome, "legacy-file.txt")

  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(legacyManifestDir, { recursive: true })
  fs.writeFileSync(legacyFile, "installed by old manifest\n", "utf8")
  fs.writeFileSync(
    path.join(legacyManifestDir, "manifest.json"),
    JSON.stringify({
      version: "legacy",
      installedAt: "2026-01-01T00:00:00Z",
      hosts: { claude: { targetDir: claudeHome, files: ["legacy-file.txt"] } },
      features: {},
    }, null, 2) + "\n",
    "utf8",
  )

  const result = spawnSync("bun", ["scripts/install.ts", "--uninstall", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 120000,
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(fs.existsSync(legacyFile), false)
  assert.equal(fs.existsSync(path.join(legacyManifestDir, "manifest.json")), false)
})

test("bun installer uninstall runs claude-mem cleanup", { timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-claude-mem-uninstall-test-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-claude-mem-uninstall-bin-"))
  const manifestDir = path.join(home, ".xpowers")
  const npxLog = path.join(home, "npx-uninstall")

  fs.mkdirSync(manifestDir, { recursive: true })
  fs.writeFileSync(
    path.join(manifestDir, "manifest.json"),
    JSON.stringify({
      version: "test",
      installedAt: "2026-01-01T00:00:00Z",
      hosts: {},
      features: { "claude-mem": { installed: true } },
    }, null, 2) + "\n",
    "utf8",
  )
  fs.writeFileSync(path.join(tmpBinDir, "npx"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$NPX_LOG\"\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "npx"), 0o755)

  const result = spawnSync("bun", ["scripts/install.ts", "--uninstall", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, {
      PATH: `${tmpBinDir}${path.delimiter}${process.env.PATH || ""}`,
      NPX_LOG: npxLog,
    }),
    timeout: 120000,
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(fs.readFileSync(npxLog, "utf8"), /claude-mem uninstall --all/)
  assert.equal(fs.existsSync(path.join(manifestDir, "manifest.json")), false)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("bun installer statusline uninstall removes legacy statusline path", { timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-ts-legacy-statusline-test-"))
  const oldNs = "hyper" + "powers"
  const claudeHome = path.join(home, ".claude")
  const manifestDir = path.join(home, ".xpowers")
  const settingsPath = path.join(claudeHome, "settings.json")

  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(manifestDir, { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify({ statusline: path.join(claudeHome, `${oldNs}-statusline.sh`) }, null, 2) + "\n", "utf8")
  fs.writeFileSync(
    path.join(manifestDir, "manifest.json"),
    JSON.stringify({
      version: "test",
      installedAt: "2026-01-01T00:00:00Z",
      hosts: {},
      features: { statusline: { installed: true } },
    }, null, 2) + "\n",
    "utf8",
  )

  const result = spawnSync("bun", ["scripts/install.ts", "--uninstall", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 120000,
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"))
  assert.equal(Object.hasOwn(settings, "statusline"), false)
})

test("pi installer replaces and removes legacy Pi AGENTS section markers", { timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-pi-legacy-agents-test-"))
  const piHome = path.join(home, ".pi", "agent")
  const agentsPath = path.join(piHome, "AGENTS.md")
  const oldDisplay = "Hyper" + "powers"
  const trailingNotes = "User notes after legacy section"

  fs.mkdirSync(piHome, { recursive: true })
  fs.writeFileSync(
    agentsPath,
    [
      "# Existing Pi Instructions",
      "Keep this preface.",
      "",
      `<!-- BEGIN ${oldDisplay.toUpperCase()} PI -->`,
      `# ${oldDisplay} for Pi`,
      "Old installed content",
      `<!-- END ${oldDisplay.toUpperCase()} PI -->`,
      "",
      trailingNotes,
      "",
    ].join("\n"),
    "utf8",
  )

  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-pi-legacy-bin-"))
  const piShimPath = path.join(tmpBinDir, "pi")
  fs.writeFileSync(piShimPath, "#!/bin/sh\nexit 0\n", "utf8")
  fs.chmodSync(piShimPath, 0o755)

  const env = installEnv(home, { PATH: `${tmpBinDir}:${process.env.PATH}` })
  const installResult = spawnSync("bun", ["scripts/install.ts", "--hosts", "pi", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 120000,
  })

  assert.equal(installResult.status, 0, installResult.stderr || installResult.stdout)
  const installedAgents = fs.readFileSync(agentsPath, "utf8")
  assert.match(installedAgents, /<!-- BEGIN XPOWERS PI -->/)
  assert.match(installedAgents, /# XPowers for Pi/)
  assert.doesNotMatch(installedAgents, new RegExp(`# ${oldDisplay} for Pi`))
  assert.match(installedAgents, /Keep this preface\./)
  assert.match(installedAgents, new RegExp(trailingNotes))

  const uninstallResult = spawnSync("bun", ["scripts/install.ts", "--hosts", "pi", "--uninstall", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 120000,
  })

  assert.equal(uninstallResult.status, 0, uninstallResult.stderr || uninstallResult.stdout)
  const uninstalledAgents = fs.readFileSync(agentsPath, "utf8")
  assert.doesNotMatch(uninstalledAgents, /<!-- BEGIN XPOWERS PI -->/)
  assert.doesNotMatch(uninstalledAgents, /# XPowers for Pi/)
  assert.match(uninstalledAgents, /Keep this preface\./)
  assert.match(uninstalledAgents, new RegExp(trailingNotes))

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("pi installer preserves freeform trailing AGENTS.md content across reinstall and uninstall", { timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-pi-agents-test-"))
  const piHome = path.join(home, ".pi", "agent")
  const agentsPath = path.join(piHome, "AGENTS.md")
  const trailingNotes = "User notes without heading\n- keep this list item\nplain trailing text"

  fs.mkdirSync(piHome, { recursive: true })
  fs.writeFileSync(
    agentsPath,
    [
      "# Existing Pi Instructions",
      "Keep the user's original preface.",
      "",
      "<!-- BEGIN XPOWERS PI -->",
      "# XPowers for Pi",
      "Old installed content",
      "<!-- END XPOWERS PI -->",
      "",
      trailingNotes,
      "",
    ].join("\n"),
    "utf8",
  )

  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-pi-bin-"))
  const piShimPath = path.join(tmpBinDir, "pi")
  fs.writeFileSync(piShimPath, "#!/bin/sh\nexit 0\n", "utf8")
  fs.chmodSync(piShimPath, 0o755)

  const env = installEnv(home, { PATH: `${tmpBinDir}:${process.env.PATH}` })

  const installResult = spawnSync("bun", ["scripts/install.ts", "--hosts", "pi", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 120000,
  })

  assert.equal(installResult.status, 0)
  const installedAgents = fs.readFileSync(agentsPath, "utf8")
  assert.match(installedAgents, /<!-- BEGIN XPOWERS PI -->/)
  assert.match(installedAgents, /# XPowers for Pi/)
  assert.match(installedAgents, /User notes without heading/)
  assert.match(installedAgents, /plain trailing text/)

  const uninstallResult = spawnSync("bun", ["scripts/install.ts", "--hosts", "pi", "--uninstall", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 120000,
  })

  assert.equal(uninstallResult.status, 0)
  const uninstalledAgents = fs.readFileSync(agentsPath, "utf8")
  assert.doesNotMatch(uninstalledAgents, /<!-- BEGIN XPOWERS PI -->/)
  assert.doesNotMatch(uninstalledAgents, /# XPowers for Pi/)
  assert.match(uninstalledAgents, /Keep the user's original preface\./)
  assert.match(uninstalledAgents, /User notes without heading/)
  assert.match(uninstalledAgents, /plain trailing text/)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("pi installer rolls back AGENTS.md if a later Pi postInstall step fails", { timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-pi-agents-rollback-test-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-pi-agents-rollback-bin-"))
  const piHome = path.join(home, ".pi", "agent")
  const piShimPath = path.join(tmpBinDir, "pi")
  const bunPath = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()
  const agentsPath = path.join(piHome, "AGENTS.md")
  const extDir = path.join(piHome, "extensions", "xpowers")
  const skillsPath = path.join(extDir, "skills")
  const originalAgents = "# Existing Pi Instructions\nKeep this untouched if install fails after AGENTS update.\n"

  fs.mkdirSync(extDir, { recursive: true })
  fs.writeFileSync(agentsPath, originalAgents, "utf8")
  fs.symlinkSync("/dev/full", skillsPath)
  fs.writeFileSync(piShimPath, "#!/bin/sh\nexit 0\n", "utf8")
  fs.chmodSync(piShimPath, 0o755)
  fs.writeFileSync(path.join(tmpBinDir, "bun"), "#!/bin/sh\nexit 0\n", "utf8")
  fs.chmodSync(path.join(tmpBinDir, "bun"), 0o755)

  const result = spawnSync(bunPath, ["scripts/install.ts", "--hosts", "pi", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, { PATH: `${tmpBinDir}:${process.env.PATH}` }),
    timeout: 120000,
  })

  assert.notEqual(result.status, 0)
  assert.equal(fs.readFileSync(agentsPath, "utf8"), originalAgents)
  assert.equal(fs.lstatSync(skillsPath).isSymbolicLink(), true)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("pi installer fails when dependency install tooling is unavailable", { timeout: 30000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-pi-deps-test-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-pi-bin-"))
  const piHome = path.join(home, ".pi", "agent")
  const piShimPath = path.join(tmpBinDir, "pi")
  const agentsPath = path.join(piHome, "AGENTS.md")
  const extensionPath = path.join(piHome, "extensions", "xpowers")
  const bunPath = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()
  const originalAgents = "# Existing Pi Instructions\nKeep this untouched when install fails.\n"

  fs.mkdirSync(piHome, { recursive: true })
  fs.writeFileSync(agentsPath, originalAgents, "utf8")
  fs.writeFileSync(piShimPath, "#!/bin/sh\nexit 0\n", "utf8")
  fs.chmodSync(piShimPath, 0o755)

  const result = spawnSync(bunPath, ["scripts/install.ts", "--hosts", "pi", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, { PATH: tmpBinDir }),
    timeout: 120000,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /Pi install requires bun to build the extension|Pi extension dependency install failed/)
  assert.equal(fs.readFileSync(agentsPath, "utf8"), originalAgents)
  assert.equal(fs.existsSync(extensionPath), false)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("pi installer json mode reports failure when host install fails", { timeout: 30000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-pi-json-fail-test-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-pi-json-bin-"))
  const piHome = path.join(home, ".pi", "agent")
  const piShimPath = path.join(tmpBinDir, "pi")
  const bunPath = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()

  fs.mkdirSync(piHome, { recursive: true })
  fs.writeFileSync(piShimPath, "#!/bin/sh\nexit 0\n", "utf8")
  fs.chmodSync(piShimPath, 0o755)

  const result = spawnSync(bunPath, ["scripts/install.ts", "--hosts", "pi", "--features", "__none__", "--yes", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, { PATH: tmpBinDir }),
    timeout: 120000,
  })

  assert.notEqual(result.status, 0)
  const payload = JSON.parse(result.stdout.trim())
  assert.equal(payload.ok, false)
  assert.equal(Array.isArray(payload.hosts), true)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("pi installer rollback preserves pre-existing extension files on failure", { timeout: 30000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-pi-existing-ext-test-"))
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-pi-existing-ext-bin-"))
  const piHome = path.join(home, ".pi", "agent")
  const piShimPath = path.join(tmpBinDir, "pi")
  const extDir = path.join(piHome, "extensions", "xpowers")
  const routingPath = path.join(extDir, "routing.json")
  const bunPath = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()
  const originalRouting = '{\n  "default": "existing-model"\n}\n'

  fs.mkdirSync(extDir, { recursive: true })
  fs.writeFileSync(routingPath, originalRouting, "utf8")
  fs.writeFileSync(piShimPath, "#!/bin/sh\nexit 0\n", "utf8")
  fs.chmodSync(piShimPath, 0o755)

  const result = spawnSync(bunPath, ["scripts/install.ts", "--hosts", "pi", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home, { PATH: tmpBinDir }),
    timeout: 120000,
  })

  assert.notEqual(result.status, 0)
  assert.equal(fs.existsSync(extDir), true)
  assert.equal(fs.readFileSync(routingPath, "utf8"), originalRouting)

  fs.rmSync(tmpBinDir, { recursive: true, force: true })
})

test("install.sh opencode provisions tm runtime and OpenCode command surface", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-test-"))
  const opencodeHome = path.join(home, ".config", "opencode")

  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.mkdirSync(opencodeHome, { recursive: true })
  fs.mkdirSync(path.join(home, ".config", "agents"), { recursive: true })

  const result = spawnSync("bash", ["scripts/install.sh", "--opencode", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 120000,
  })

  assert.equal(result.status, 0)
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "tm")), true)
  assert.equal(fs.existsSync(path.join(home, ".local", "lib", "tm", "tm-linear-sync.js")), true)
  assert.equal(fs.existsSync(path.join(opencodeHome, "commands", "tm-linear-setup.md")), true)
  assert.equal(fs.existsSync(path.join(opencodeHome, "package.json")), true)
})

function makeLegacyFixture(home) {
  const legacyPaths = [
    path.join(home, ".claude", "plugins", "hyperpowers@hyperpowers"),
    path.join(home, ".claude", "plugins", "myhyperpowers"),
    path.join(home, ".config", "opencode", "skills", "superpowers"),
    path.join(home, ".codex", "skills", "hyperpowers"),
    path.join(home, ".agents", "skills", "myhyperpowers"),
    path.join(home, ".config", "agents", "skills", "superpowers"),
    path.join(home, ".pi", "agent", "extensions", "hyperpowers"),
  ]
  for (const p of legacyPaths) {
    fs.mkdirSync(p, { recursive: true })
    fs.writeFileSync(path.join(p, "marker.txt"), "legacy\n", "utf8")
  }
  return legacyPaths
}

test("install.sh --remove-legacy --dry-run previews exact legacy paths to remove", { timeout: 30000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-legacy-dry-run-"))
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  const legacyPaths = makeLegacyFixture(home)

  const result = spawnSync("bash", ["scripts/install.sh", "--remove-legacy", "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 30000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  for (const p of legacyPaths) {
    assert.match(output, new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }
  for (const p of legacyPaths) {
    assert.equal(fs.existsSync(p), true, `Expected ${p} to still exist after dry-run`)
  }
})

test("install.sh --replace-legacy removes legacy then installs XPowers", { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-replace-legacy-"))
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  const legacyPaths = makeLegacyFixture(home)

  const result = spawnSync("bash", ["scripts/install.sh", "--replace-legacy", "--claude", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 120000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  for (const p of legacyPaths) {
    assert.equal(fs.existsSync(p), false, `Expected ${p} to be removed`)
  }
  assert.equal(fs.existsSync(path.join(home, ".claude", ".xpowers-version")), true)
})

test("install.sh non-interactive legacy deletion fails without explicit flag", { timeout: 30000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-legacy-blocked-"))
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  makeLegacyFixture(home)

  const result = spawnSync("bash", ["scripts/install.sh", "--claude", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 30000,
  })

  const output = combinedOutput(result)
  assert.notEqual(result.status, 0, output)
  assert.match(output, /conflicting install/i)
})

test("install.sh legacy cleanup with manifest prefers manifest entries", { timeout: 30000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-legacy-manifest-"))
  const claudeHome = path.join(home, ".claude")
  fs.mkdirSync(claudeHome, { recursive: true })

  fs.mkdirSync(path.join(claudeHome, "skills", "legacy-skill"), { recursive: true })
  fs.writeFileSync(path.join(claudeHome, ".hyperpowers-manifest"), "skills/legacy-skill/\n", "utf8")
  fs.writeFileSync(path.join(claudeHome, ".hyperpowers-version"), "legacy\n", "utf8")

  fs.mkdirSync(path.join(claudeHome, "plugins", "hyperpowers@hyperpowers"), { recursive: true })
  fs.writeFileSync(path.join(claudeHome, "plugins", "hyperpowers@hyperpowers", "marker.txt"), "legacy\n", "utf8")

  fs.mkdirSync(path.join(claudeHome, "skills", "unrelated-skill"), { recursive: true })
  fs.writeFileSync(path.join(claudeHome, "skills", "unrelated-skill", "keep.txt"), "keep\n", "utf8")

  const result = spawnSync("bash", ["scripts/install.sh", "--remove-legacy", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 30000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)

  assert.equal(fs.existsSync(path.join(claudeHome, "skills", "legacy-skill")), false)
  assert.equal(fs.existsSync(path.join(claudeHome, "plugins", "hyperpowers@hyperpowers")), false)
  assert.equal(fs.existsSync(path.join(claudeHome, "skills", "unrelated-skill")), true)
  assert.equal(fs.existsSync(path.join(claudeHome, "skills", "unrelated-skill", "keep.txt")), true)
  assert.equal(fs.existsSync(path.join(claudeHome, ".hyperpowers-manifest")), false)
  assert.equal(fs.existsSync(path.join(claudeHome, ".hyperpowers-version")), false)
})

test("install.sh legacy cleanup without manifest removes exact namespace paths only", { timeout: 30000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-legacy-no-manifest-"))
  const claudeHome = path.join(home, ".claude")
  fs.mkdirSync(claudeHome, { recursive: true })

  fs.mkdirSync(path.join(claudeHome, "plugins", "hyperpowers@hyperpowers"), { recursive: true })
  fs.writeFileSync(path.join(claudeHome, "plugins", "hyperpowers@hyperpowers", "marker.txt"), "legacy\n", "utf8")

  fs.writeFileSync(path.join(claudeHome, "plugins", "unrelated.txt"), "keep\n", "utf8")

  fs.mkdirSync(path.join(claudeHome, "skills", "other-skill"), { recursive: true })
  fs.writeFileSync(path.join(claudeHome, "skills", "other-skill", "keep.txt"), "keep\n", "utf8")

  const result = spawnSync("bash", ["scripts/install.sh", "--remove-legacy", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 30000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)

  assert.equal(fs.existsSync(path.join(claudeHome, "plugins", "hyperpowers@hyperpowers")), false)
  assert.equal(fs.existsSync(path.join(claudeHome, "plugins", "unrelated.txt")), true)
  assert.equal(fs.existsSync(path.join(claudeHome, "skills", "other-skill")), true)
})

test("install.sh repeated legacy cleanup is idempotent", { timeout: 30000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-legacy-idempotent-"))
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  makeLegacyFixture(home)

  const first = spawnSync("bash", ["scripts/install.sh", "--remove-legacy", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 30000,
  })
  assert.equal(first.status, 0, combinedOutput(first))

  const second = spawnSync("bash", ["scripts/install.sh", "--remove-legacy", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 30000,
  })
  const output = combinedOutput(second)
  assert.equal(second.status, 0, output)
})


test("install.sh quarantine ignores path-traversal manifest entries", { timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-traversal-test-"))
  const claudeHome = path.join(home, ".claude")
  fs.mkdirSync(claudeHome, { recursive: true })

  // Create a conflict candidate so manifest processing is triggered
  fs.mkdirSync(path.join(claudeHome, "plugins"), { recursive: true })
  fs.writeFileSync(path.join(claudeHome, "plugins", "hyperpowers"), "legacy", "utf8")

  // Create a manifest with path-traversal entries
  const manifest = path.join(claudeHome, ".hyperpowers-manifest")
  fs.writeFileSync(
    manifest,
    [
      "skills/test-skill/",
      "../../../etc/passwd",
      ".",
      "agents/../",
      "commands/test.md",
      "",
    ].join("\n"),
    "utf8",
  )
  fs.writeFileSync(path.join(claudeHome, ".hyperpowers-version"), "1.0.0", "utf8")
  fs.mkdirSync(path.join(claudeHome, "skills", "test-skill"), { recursive: true })
  fs.writeFileSync(path.join(claudeHome, "skills", "test-skill", "SKILL.md"), "test", "utf8")
  fs.mkdirSync(path.join(claudeHome, "commands"), { recursive: true })
  fs.writeFileSync(path.join(claudeHome, "commands", "test.md"), "test", "utf8")

  const result = spawnSync("bash", ["scripts/install.sh", "--remove-legacy", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 60000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  // The safe entries should be removed
  assert.equal(fs.existsSync(path.join(claudeHome, "skills", "test-skill")), false)
  assert.equal(fs.existsSync(path.join(claudeHome, "commands", "test.md")), false)
  // The traversal entries should NOT cause removal outside the agent home
  assert.equal(fs.existsSync("/etc/passwd"), true)
  // The candidate itself should also be removed
  assert.equal(fs.existsSync(path.join(claudeHome, "plugins", "hyperpowers")), false)
})

test("install.sh marker-driven purge removes exact files without manifest", { timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-purge-test-"))
  const claudeHome = path.join(home, ".claude")
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(path.join(claudeHome, "skills", "unrelated-skill"), { recursive: true })
  fs.writeFileSync(path.join(claudeHome, "skills", "unrelated-skill", "SKILL.md"), "keep me", "utf8")
  fs.writeFileSync(path.join(claudeHome, ".xpowers-version"), "1.0.0", "utf8")
  fs.mkdirSync(path.join(claudeHome, ".xpowers-backups"), { recursive: true })
  fs.writeFileSync(path.join(claudeHome, ".xpowers-backups", "backup.txt"), "backup", "utf8")

  const result = spawnSync("bash", ["scripts/install.sh", "--uninstall", "--claude", "--purge", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 60000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  // Marker files and backups should be removed
  assert.equal(fs.existsSync(path.join(claudeHome, ".xpowers-version")), false)
  assert.equal(fs.existsSync(path.join(claudeHome, ".xpowers-manifest")), false)
  assert.equal(fs.existsSync(path.join(claudeHome, ".xpowers-backups")), false)
  // Broad directories should be preserved
  assert.equal(fs.existsSync(path.join(claudeHome, "skills", "unrelated-skill", "SKILL.md")), true)
})

test("install.sh --replace-legacy --dry-run exits before installing and does not write files", { timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-replace-legacy-dry-run-test-"))
  const claudeHome = path.join(home, ".claude")
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, ".xpowers-version"), "1.0.0", "utf8")

  const result = spawnSync("bash", ["scripts/install.sh", "--replace-legacy", "--dry-run", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 60000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.match(output, /Dry run/)
  // .xpowers-version should NOT be overwritten by install
  assert.equal(fs.readFileSync(path.join(claudeHome, ".xpowers-version"), "utf8"), "1.0.0")
})

test("install.sh --hosts claude --dry-run does not write any files", { timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-dry-run-test-"))
  const claudeHome = path.join(home, ".claude")
  fs.mkdirSync(claudeHome, { recursive: true })

  const result = spawnSync("bash", ["scripts/install.sh", "--hosts", "claude", "--dry-run", "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 60000,
  })

  const output = combinedOutput(result)
  assert.equal(result.status, 0, output)
  assert.match(output, /dry-run/)
  // No manifest or version file should be written
  assert.equal(fs.existsSync(path.join(claudeHome, ".xpowers-manifest")), false)
  assert.equal(fs.existsSync(path.join(claudeHome, ".xpowers-version")), false)
  // No skills/agents/commands/hooks should be copied
  assert.equal(fs.existsSync(path.join(claudeHome, "skills")), false)
  assert.equal(fs.existsSync(path.join(claudeHome, "agents")), false)
  assert.equal(fs.existsSync(path.join(claudeHome, "commands")), false)
})

test("setup-pi.sh shim rejects piped execution with helpful error", { timeout: 60000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "setup-pi-pipe-test-"))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "setup-pi-pipe-cwd-"))
  const script = fs.readFileSync(path.join(repoRoot, "scripts", "setup-pi.sh"), "utf8")

  const result = spawnSync("bash", ["-s"], {
    cwd,
    input: script,
    encoding: "utf8",
    env: installEnv(home),
    timeout: 60000,
  })

  const output = combinedOutput(result)
  assert.notEqual(result.status, 0, output)
  assert.match(output, /cannot determine script location when piped/i)
  assert.match(output, /universal installer instead/i)
})
