const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const repoRoot = path.resolve(__dirname, "..")
const tmPath = path.resolve(repoRoot, "scripts/tm")
const tmBackendsPath = path.resolve(repoRoot, "scripts/tm-backends.sh")

function runTm(args = [], opts = {}) {
  return spawnSync(tmPath, args, {
    cwd: opts.cwd || repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
    timeout: 10000,
  })
}

test("tm with no config defaults to bd backend", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tm-default-backend-"))

  try {
    // An empty project must not inherit this repository's configured backend.
    fs.mkdirSync(path.join(tmpRoot, ".beads"))
    const result = runTm(["--version"], {
      cwd: tmpRoot,
      env: { TM_BACKEND: "", TM_REPO_ROOT: tmpRoot },
    })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /backend: bd/)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test("tm with TM_BACKEND=bd explicitly selects bd backend", () => {
  const result = runTm(["--version"], { env: { TM_BACKEND: "bd" } })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /backend: bd/)
})

test("tm with TM_BACKEND=br explicitly selects br backend", () => {
  const result = runTm(["--version"], { env: { TM_BACKEND: "br" } })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /backend: br/)
})

test("tm with TM_BACKEND=tk explicitly selects tk backend", () => {
  const result = runTm(["--version"], { env: { TM_BACKEND: "tk" } })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /backend: tk/)
})

test("tm with TM_BACKEND=linear requires credentials before running commands", () => {
  const result = runTm(["ready"], {
    env: { TM_BACKEND: "linear", LINEAR_API_KEY: "", LINEAR_TEAM_KEY: "" },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Linear backend requires LINEAR_API_KEY and LINEAR_TEAM_KEY/)
})

test("tm with TM_BACKEND=linear routes commands through the linear backend entrypoint", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tm-linear-routing-"))
  const fakeRepo = path.join(tmpRoot, "fake-repo")
  const fakeScriptDir = path.join(fakeRepo, "scripts")
  const fakeBeadsDir = path.join(fakeRepo, ".beads")
  const fakeTmPath = path.join(fakeScriptDir, "tm")
  const outsideDir = path.join(tmpRoot, "outside")
  const symlinkTmPath = path.join(outsideDir, "tm")
  const capturePath = path.join(fakeRepo, "linear-backend-called.txt")

  try {
    fs.mkdirSync(fakeScriptDir, { recursive: true })
    fs.mkdirSync(fakeBeadsDir, { recursive: true })
    fs.mkdirSync(outsideDir)
    fs.copyFileSync(tmPath, fakeTmPath)
    fs.copyFileSync(tmBackendsPath, path.join(fakeScriptDir, "tm-backends.sh"))
    fs.writeFileSync(path.join(fakeScriptDir, "tm-linear-backend.js"), `require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2), repoRoot: process.env.TM_REPO_ROOT }))\n`)
    fs.chmodSync(fakeTmPath, 0o755)
    fs.symlinkSync(fakeTmPath, symlinkTmPath)

    const result = spawnSync(symlinkTmPath, ["ready"], {
      cwd: outsideDir,
      encoding: "utf8",
      env: { ...process.env, TM_BACKEND: "linear", LINEAR_API_KEY: "lin_api_test123", LINEAR_TEAM_KEY: "ENG" },
      timeout: 10000,
    })

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(fs.readFileSync(capturePath, "utf8")), { args: ["ready"], repoRoot: fakeRepo })
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test("tm with TM_BACKEND=linear reports missing Node.js clearly", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tm-linear-no-node-"))
  const fakeRepo = path.join(tmpRoot, "fake-repo")
  const fakeScriptDir = path.join(fakeRepo, "scripts")
  const fakeTmPath = path.join(fakeScriptDir, "tm")
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    fs.mkdirSync(fakeScriptDir, { recursive: true })
    fs.copyFileSync(tmPath, fakeTmPath)
    fs.copyFileSync(tmBackendsPath, path.join(fakeScriptDir, "tm-backends.sh"))
    fs.chmodSync(fakeTmPath, 0o755)

    const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-linear-no-node-bin-"))
    for (const commandName of ["dirname"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const result = spawnSync(bashPath, [fakeTmPath, "ready"], {
      cwd: fakeRepo,
      encoding: "utf8",
      env: { ...process.env, TM_BACKEND: "linear", PATH: tmpBinDir, LINEAR_API_KEY: "lin_api_test123", LINEAR_TEAM_KEY: "ENG" },
      timeout: 10000,
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /Linear backend requires Node\.js/)
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test("tm with TM_BACKEND=linear reports missing backend script clearly", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tm-linear-no-script-"))
  const fakeRepo = path.join(tmpRoot, "fake-repo")
  const fakeScriptDir = path.join(fakeRepo, "scripts")
  const fakeTmPath = path.join(fakeScriptDir, "tm")
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    fs.mkdirSync(fakeScriptDir, { recursive: true })
    fs.copyFileSync(tmPath, fakeTmPath)
    fs.copyFileSync(tmBackendsPath, path.join(fakeScriptDir, "tm-backends.sh"))
    fs.chmodSync(fakeTmPath, 0o755)

    const result = spawnSync(bashPath, [fakeTmPath, "ready"], {
      cwd: fakeRepo,
      encoding: "utf8",
      env: { ...process.env, TM_BACKEND: "linear", LINEAR_API_KEY: "lin_api_test123", LINEAR_TEAM_KEY: "ENG" },
      timeout: 10000,
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /tm-linear-backend\.js is missing/)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test("tm with TM_BACKEND=invalid exits with unknown-backend error", () => {
  const result = runTm(["ready"], { env: { TM_BACKEND: "gitlab" } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /unknown backend 'gitlab'/)
  assert.match(result.stderr, /Valid backends: bd, br, tk, linear/)
})

test("tm --help shows usage and configured backend", () => {
  const result = runTm(["--help"])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /Abstract Task Manager CLI/)
  assert.match(result.stdout, /Currently configured backend:/)
  assert.match(result.stdout, /tm ready/)
})

test("tm --help under linear avoids unsupported examples and passthrough claims", () => {
  const result = runTm(["--help"], { env: { TM_BACKEND: "linear" } })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Currently configured backend: linear/)
  assert.match(result.stdout, /tm show <id>/)
  assert.match(result.stdout, /tm update <id> --status in_progress/)
  assert.doesNotMatch(result.stdout, /tm create "Title"/)
  assert.doesNotMatch(result.stdout, /All arguments are passed through to the backend unchanged\./)
  assert.match(result.stdout, /Supported commands and behavior can vary by backend\./)
})

test("tm --version shows version and backend", () => {
  const result = runTm(["--version"])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /^tm \d+\.\d+\.\d+ \(backend: \w+\)/)
})

test("tm discovers repo config from the script location when cwd is outside the repo", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tm-script-root-"))
  const fakeRepo = path.join(tmpRoot, "fake-repo")
  const fakeScriptDir = path.join(fakeRepo, "scripts")
  const fakeBeadsDir = path.join(fakeRepo, ".beads")
  const outsideDir = path.join(tmpRoot, "outside")
  const fakeTmPath = path.join(fakeScriptDir, "tm")

  try {
    fs.mkdirSync(fakeScriptDir, { recursive: true })
    fs.mkdirSync(fakeBeadsDir, { recursive: true })
    fs.mkdirSync(outsideDir)
    fs.copyFileSync(tmPath, fakeTmPath)
    fs.copyFileSync(tmBackendsPath, path.join(fakeScriptDir, "tm-backends.sh"))
    fs.chmodSync(fakeTmPath, 0o755)
    fs.writeFileSync(path.join(fakeBeadsDir, "config.yaml"), 'tm.backend: "linear"\n')

    const result = spawnSync(fakeTmPath, ["--version"], {
      cwd: outsideDir,
      encoding: "utf8",
      env: { ...process.env, TM_BACKEND: "" },
      timeout: 10000,
    })

    assert.equal(result.status, 0)
    assert.match(result.stdout, /backend: linear/)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test("tm discovers repo config when invoked through a symlinked entrypoint", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tm-script-symlink-root-"))
  const fakeRepo = path.join(tmpRoot, "fake-repo")
  const fakeScriptDir = path.join(fakeRepo, "scripts")
  const fakeBeadsDir = path.join(fakeRepo, ".beads")
  const outsideDir = path.join(tmpRoot, "outside")
  const fakeTmPath = path.join(fakeScriptDir, "tm")
  const symlinkTmPath = path.join(outsideDir, "tm")

  try {
    fs.mkdirSync(fakeScriptDir, { recursive: true })
    fs.mkdirSync(fakeBeadsDir, { recursive: true })
    fs.mkdirSync(outsideDir)
    fs.copyFileSync(tmPath, fakeTmPath)
    fs.copyFileSync(tmBackendsPath, path.join(fakeScriptDir, "tm-backends.sh"))
    fs.chmodSync(fakeTmPath, 0o755)
    fs.symlinkSync(fakeTmPath, symlinkTmPath)
    fs.writeFileSync(path.join(fakeBeadsDir, "config.yaml"), 'tm.backend: "linear"\n')

    const result = spawnSync(symlinkTmPath, ["--version"], {
      cwd: outsideDir,
      encoding: "utf8",
      env: { ...process.env, TM_BACKEND: "" },
      timeout: 10000,
    })

    assert.equal(result.status, 0)
    assert.match(result.stdout, /backend: linear/)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test("tm sync resolves tm-linear-sync.js from the real script directory when invoked via symlink", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tm-sync-symlink-root-"))
  const fakeRepo = path.join(tmpRoot, "fake-repo")
  const fakeScriptDir = path.join(fakeRepo, "scripts")
  const fakeBeadsDir = path.join(fakeRepo, ".beads")
  const outsideDir = path.join(tmpRoot, "outside")
  const symlinkBinDir = path.join(tmpRoot, "bin")
  const fakeTmPath = path.join(fakeScriptDir, "tm")
  const symlinkTmPath = path.join(symlinkBinDir, "tm")
  const markerPath = path.join(fakeRepo, "linear-sync-called.txt")
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    fs.mkdirSync(fakeScriptDir, { recursive: true })
    fs.mkdirSync(fakeBeadsDir, { recursive: true })
    fs.mkdirSync(outsideDir)
    fs.mkdirSync(symlinkBinDir)
    fs.copyFileSync(tmPath, fakeTmPath)
    fs.copyFileSync(tmBackendsPath, path.join(fakeScriptDir, "tm-backends.sh"))
    fs.writeFileSync(path.join(fakeScriptDir, "tm-linear-sync.js"), `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'called')\n`)
    fs.chmodSync(fakeTmPath, 0o755)
    fs.symlinkSync(fakeTmPath, symlinkTmPath)

    const fakeBdPath = path.join(symlinkBinDir, "bd")
    fs.writeFileSync(fakeBdPath, `#!${bashPath}\nif [[ \"$1\" == \"sync\" ]]; then exit 0; fi\nif [[ \"$1\" == \"config\" && \"$2\" == \"get\" ]]; then\n  if [[ \"$3\" == \"linear.api-key\" ]]; then echo \"lin_api_cfg\"; exit 0; fi\n  if [[ \"$3\" == \"linear.team-key\" ]]; then echo \"ENG\"; exit 0; fi\n  echo \"$3 (not set)\"\n  exit 0\nfi\nexit 0\n`)
    fs.chmodSync(fakeBdPath, 0o755)

    const env = { ...process.env, TM_BACKEND: "bd", PATH: `${symlinkBinDir}${path.delimiter}${process.env.PATH || ""}` }
    delete env.LINEAR_API_KEY
    delete env.LINEAR_TEAM_KEY

    const result = spawnSync(symlinkTmPath, ["sync"], {
      cwd: outsideDir,
      encoding: "utf8",
      env,
      timeout: 10000,
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.readFileSync(markerPath, "utf8"), "called")
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test("tm passes through arguments unchanged to bd", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-bd-passthrough-"))
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    const fakeBdPath = path.join(tmpBinDir, "bd")
    fs.writeFileSync(fakeBdPath, `#!${bashPath}
printf '%s\n' "$*"
`, "utf8")
    fs.chmodSync(fakeBdPath, 0o755)

    const env = { ...process.env, TM_BACKEND: "bd", PATH: `${tmpBinDir}${path.delimiter}${process.env.PATH || ""}` }
    const tmResult = runTm(["list", "--status", "open"], { env })
    const bdResult = spawnSync("bd", ["list", "--status", "open"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      timeout: 10000,
    })

    assert.equal(tmResult.status, bdResult.status)
    assert.equal(tmResult.stdout, bdResult.stdout)
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm sync --help matches bd sync --help without running Linear sync", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-bd-sync-help-"))
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    const fakeBdPath = path.join(tmpBinDir, "bd")
    fs.writeFileSync(fakeBdPath, `#!${bashPath}
printf '%s\n' "$*"
`, "utf8")
    fs.chmodSync(fakeBdPath, 0o755)

    const env = { ...process.env, TM_BACKEND: "bd", LINEAR_API_KEY: "", PATH: `${tmpBinDir}${path.delimiter}${process.env.PATH || ""}` }
    const tmResult = runTm(["sync", "--help"], { env })
    const bdResult = spawnSync("bd", ["sync", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      timeout: 10000,
    })

    assert.equal(tmResult.status, bdResult.status)
    assert.equal(tmResult.stdout, bdResult.stdout)
    assert.equal(tmResult.stderr, bdResult.stderr)
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm sync no-ops when bd lacks a sync command", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-bd-sync-missing-"))
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const fakeBdPath = path.join(tmpBinDir, "bd")
    fs.writeFileSync(fakeBdPath, `#!${bashPath}
if [[ "$1" == "sync" ]]; then
  echo 'Error: unknown command "sync" for "bd"' >&2
  echo "Run 'bd --help' for usage." >&2
  exit 1
fi
exit 0
`, "utf8")
    fs.chmodSync(fakeBdPath, 0o755)

    const result = spawnSync(bashPath, [tmPath, "sync"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        TM_BACKEND: "bd",
        PATH: tmpBinDir,
        LINEAR_API_KEY: "",
        LINEAR_TEAM_KEY: "",
      },
      timeout: 10000,
    })

    assert.equal(result.status, 0)
    assert.match(result.stderr, /bd backend does not support sync; local sync skipped/)
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm sync fails when Linear is configured but node is unavailable", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-sync-no-node-"))
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const fakeBdPath = path.join(tmpBinDir, "bd")
    fs.writeFileSync(fakeBdPath, `#!${bashPath}\nif [[ \"$1\" == \"sync\" ]]; then exit 0; fi\nexit 0\n`)
    fs.chmodSync(fakeBdPath, 0o755)

    const result = spawnSync(bashPath, [tmPath, "sync"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        TM_BACKEND: "bd",
        PATH: tmpBinDir,
        LINEAR_API_KEY: "lin_api_test123",
        LINEAR_TEAM_KEY: "ENG",
      },
      timeout: 10000,
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /Linear sync is configured but Node\.js is unavailable/)
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm sync skips Linear when only team key is present and node is unavailable", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-sync-team-only-"))
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const fakeBdPath = path.join(tmpBinDir, "bd")
    fs.writeFileSync(fakeBdPath, `#!${bashPath}\nif [[ \"$1\" == \"sync\" ]]; then exit 0; fi\nexit 0\n`)
    fs.chmodSync(fakeBdPath, 0o755)

    const result = spawnSync(bashPath, [tmPath, "sync"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        TM_BACKEND: "bd",
        PATH: tmpBinDir,
        LINEAR_API_KEY: "",
        LINEAR_TEAM_KEY: "ENG",
      },
      timeout: 10000,
    })

    assert.equal(result.status, 0)
    assert.equal(result.stderr, "")
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm sync skips Linear when only api key is present and node is unavailable", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-sync-api-only-"))
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const fakeBdPath = path.join(tmpBinDir, "bd")
    fs.writeFileSync(fakeBdPath, `#!${bashPath}\nif [[ \"$1\" == \"sync\" ]]; then exit 0; fi\nexit 0\n`)
    fs.chmodSync(fakeBdPath, 0o755)

    const result = spawnSync(bashPath, [tmPath, "sync"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        TM_BACKEND: "bd",
        PATH: tmpBinDir,
        LINEAR_API_KEY: "lin_api_test123",
        LINEAR_TEAM_KEY: "",
      },
      timeout: 10000,
    })

    assert.equal(result.status, 0)
    assert.equal(result.stderr, "")
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm sync detects Linear config from backend config when env vars are unset", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-sync-backend-config-"))
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const fakeBdPath = path.join(tmpBinDir, "bd")
    fs.writeFileSync(
      fakeBdPath,
      `#!${bashPath}
if [[ "$1" == "sync" ]]; then exit 0; fi
if [[ "$1" == "config" && "$2" == "get" ]]; then
  if [[ "$3" == "linear.api-key" ]]; then echo "lin_api_cfg"; exit 0; fi
  if [[ "$3" == "linear.team-key" ]]; then echo "ENG"; exit 0; fi
  echo "$3 (not set)"
  exit 0
fi
exit 0
`,
    )
    fs.chmodSync(fakeBdPath, 0o755)

    const env = {
      ...process.env,
      TM_BACKEND: "bd",
      PATH: tmpBinDir,
    }
    delete env.LINEAR_API_KEY
    delete env.LINEAR_TEAM_KEY

    const result = spawnSync(bashPath, [tmPath, "sync"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      timeout: 10000,
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /Linear sync is configured but Node\.js is unavailable/)
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm sync ignores unsupported backend config stdout when checking Linear config", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-sync-unsupported-config-"))
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const fakeBdPath = path.join(tmpBinDir, "bd")
    fs.writeFileSync(
      fakeBdPath,
      `#!${bashPath}
if [[ "$1" == "sync" ]]; then exit 0; fi
if [[ "$1" == "config" && "$2" == "get" ]]; then
  echo "config get is not supported"
  exit 0
fi
exit 0
`,
    )
    fs.chmodSync(fakeBdPath, 0o755)

    const env = {
      ...process.env,
      TM_BACKEND: "bd",
      PATH: tmpBinDir,
    }
    delete env.LINEAR_API_KEY
    delete env.LINEAR_TEAM_KEY

    const result = spawnSync(bashPath, [tmPath, "sync"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      timeout: 10000,
    })

    assert.equal(result.status, 0)
    assert.equal(result.stderr, "")
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm sync ignores single-token bogus backend config output when checking Linear config", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-sync-bogus-config-"))
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const fakeBdPath = path.join(tmpBinDir, "bd")
    fs.writeFileSync(
      fakeBdPath,
      `#!${bashPath}
if [[ "$1" == "sync" ]]; then exit 0; fi
if [[ "$1" == "config" && "$2" == "get" ]]; then
  echo "unsupported"
  exit 0
fi
exit 0
`,
    )
    fs.chmodSync(fakeBdPath, 0o755)

    const env = {
      ...process.env,
      TM_BACKEND: "bd",
      PATH: tmpBinDir,
    }
    delete env.LINEAR_API_KEY
    delete env.LINEAR_TEAM_KEY

    const result = spawnSync(bashPath, [tmPath, "sync"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      timeout: 10000,
    })

    assert.equal(result.status, 0)
    assert.equal(result.stderr, "")
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm sync ignores similarly named config keys when checking linear.api-key", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-sync-literal-key-"))
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "tm-sync-literal-repo-"))
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    fs.mkdirSync(path.join(tmpRepo, ".beads"), { recursive: true })
    fs.writeFileSync(path.join(tmpRepo, ".beads", "config.yaml"), "linearXapi-key: wrong_key\n")

    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const fakeBdPath = path.join(tmpBinDir, "bd")
    fs.writeFileSync(
      fakeBdPath,
      `#!${bashPath}
if [[ "$1" == "sync" ]]; then exit 0; fi
if [[ "$1" == "config" && "$2" == "get" ]]; then
  echo "$3 (not set)"
  exit 0
fi
exit 0
`,
    )
    fs.chmodSync(fakeBdPath, 0o755)

    const env = {
      ...process.env,
      TM_BACKEND: "bd",
      PATH: tmpBinDir,
    }
    delete env.LINEAR_API_KEY
    delete env.LINEAR_TEAM_KEY

    const result = spawnSync(bashPath, [tmPath, "sync"], {
      cwd: tmpRepo,
      encoding: "utf8",
      env,
      timeout: 10000,
    })

    assert.equal(result.status, 0)
    assert.equal(result.stderr, "")
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
    fs.rmSync(tmpRepo, { recursive: true, force: true })
  }
})

test("tm passes arguments with spaces unchanged to bd", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-test-"))
  const tmpBeads = path.join(tmpDir, ".beads")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-test-bin-"))
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    fs.mkdirSync(tmpBeads)

    for (const commandName of ["awk", "bash", "cat", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const fakeBdPath = path.join(tmpBinDir, "bd")
    fs.writeFileSync(
      fakeBdPath,
      `#!${bashPath}
set -euo pipefail
store="${tmpDir}/issues.txt"
command="$1"
shift || true

case "$command" in
  create)
    title="$1"
    shift
    design=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --design)
          design="$2"
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    printf '%s\n%s\n' "$title" "$design" > "$store"
    printf '✓ Created issue: tmtest-1 — %s\n' "$title"
    ;;
  show)
    issue_id="$1"
    [[ "$issue_id" == "tmtest-1" ]] || exit 0
    cat "$store"
    ;;
  close)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
    )
    fs.chmodSync(fakeBdPath, 0o755)

    const env = { ...process.env, TM_BACKEND: "bd", PATH: tmpBinDir }
    const title = "TM test issue with spaces"
    const design = "Multi word design for testing"
    const createResult = runTm([
      "create", title,
      "--type", "task",
      "--priority", "4",
      "--design", design,
    ], { cwd: tmpDir, env })
    assert.equal(createResult.status, 0, `tm create failed: ${createResult.stderr}`)

    const idMatch = createResult.stdout.match(/(\S+-[0-9a-z]+)/)
    assert.ok(idMatch, `Could not find issue ID in output: ${createResult.stdout}`)
    const issueId = idMatch[1]

    const showResult = runTm(["show", issueId], { cwd: tmpDir, env })
    assert.equal(showResult.status, 0)
    assert.ok(showResult.stdout.includes(title), `Title not found in show output`)
    assert.ok(showResult.stdout.includes(design), `Design not found in show output`)

    runTm(["close", issueId, "--reason", "test cleanup"], { cwd: tmpDir, env })
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("tm when bd not in PATH gives helpful error message", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-no-bd-"))

  try {
    const bashPath = findCommandPath("bash") || "/bin/bash"
    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const result = spawnSync(bashPath, [tmPath, "ready"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, TM_BACKEND: "bd", PATH: tmpBinDir },
      timeout: 10000,
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /bd not found in PATH/)
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm when br not in PATH gives helpful error message", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-no-br-"))

  try {
    const bashPath = findCommandPath("bash") || "/bin/bash"
    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const result = spawnSync(bashPath, [tmPath, "ready"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, TM_BACKEND: "br", PATH: tmpBinDir },
      timeout: 10000,
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /br not found in PATH/)
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm when tk not in PATH gives helpful error message", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-no-tk-"))

  try {
    const bashPath = findCommandPath("bash") || "/bin/bash"
    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const result = spawnSync(bashPath, [tmPath, "ready"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, TM_BACKEND: "tk", PATH: tmpBinDir },
      timeout: 10000,
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /tk not found in PATH/)
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm sync under br performs local flush and reports unsupported follow-on sync", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-br-sync-"))
  const argsCapturePath = path.join(tmpBinDir, "br-args.txt")
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    for (const commandName of ["awk", "dirname", "grep", "head"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const fakeBrPath = path.join(tmpBinDir, "br")
    fs.writeFileSync(fakeBrPath, `#!${bashPath}\nprintf '%s\\n' \"$*\" > \"${argsCapturePath}\"\nif [[ \"$1\" == \"sync\" ]]; then exit 0; fi\nexit 0\n`)
    fs.chmodSync(fakeBrPath, 0o755)

    const result = spawnSync(bashPath, [tmPath, "sync"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        TM_BACKEND: "br",
        PATH: tmpBinDir,
        LINEAR_API_KEY: "lin_api_test123",
        LINEAR_TEAM_KEY: "ENG",
      },
      timeout: 10000,
    })

    assert.equal(result.status, 0)
    assert.equal(fs.existsSync(argsCapturePath), true)
    assert.match(fs.readFileSync(argsCapturePath, "utf8"), /^sync --flush-only/)
    assert.match(result.stderr, /not supported for backend 'br'/)
    assert.match(result.stderr, /follow-on sync was skipped/)
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm sync under br does not duplicate an explicit flush-only flag", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-br-sync-explicit-flush-"))
  const argsCapturePath = path.join(tmpBinDir, "br-args-explicit.txt")
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const fakeBrPath = path.join(tmpBinDir, "br")
    fs.writeFileSync(fakeBrPath, `#!${bashPath}\nif [[ "$1" == "sync" ]]; then\n  printf '%s\\n' "$*" > "${argsCapturePath}"\n  exit 0\nfi\nif [[ "$1" == "config" && "$2" == "get" ]]; then\n  echo "$3 (not set)"\n  exit 0\nfi\nexit 0\n`)
    fs.chmodSync(fakeBrPath, 0o755)

    const result = spawnSync(bashPath, [tmPath, "sync", "--flush-only"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, TM_BACKEND: "br", PATH: tmpBinDir },
      timeout: 10000,
    })

    assert.equal(result.status, 0)
    assert.equal(fs.readFileSync(argsCapturePath, "utf8").trim(), "sync --flush-only")
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm sync under br preserves surrounding args when flush-only is already present", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-br-sync-ordered-flush-"))
  const argsCapturePath = path.join(tmpBinDir, "br-args-ordered.txt")
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const fakeBrPath = path.join(tmpBinDir, "br")
    fs.writeFileSync(fakeBrPath, `#!${bashPath}\nif [[ "$1" == "sync" ]]; then\n  printf '%s\\n' "$*" > "${argsCapturePath}"\n  exit 0\nfi\nif [[ "$1" == "config" && "$2" == "get" ]]; then\n  echo "$3 (not set)"\n  exit 0\nfi\nexit 0\n`)
    fs.chmodSync(fakeBrPath, 0o755)

    const result = spawnSync(bashPath, [tmPath, "sync", "--dry-run", "--flush-only", "--verbose"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, TM_BACKEND: "br", PATH: tmpBinDir },
      timeout: 10000,
    })

    assert.equal(result.status, 0)
    assert.equal(fs.readFileSync(argsCapturePath, "utf8").trim(), "sync --dry-run --flush-only --verbose")
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm sync under br propagates local sync failure and skips follow-on sync", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-br-sync-fail-"))
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const fakeBrPath = path.join(tmpBinDir, "br")
    fs.writeFileSync(fakeBrPath, `#!${bashPath}\nif [[ "$1" == "sync" ]]; then exit 37; fi\nif [[ "$1" == "config" && "$2" == "get" ]]; then\n  echo "$3 (not set)"\n  exit 0\nfi\nexit 0\n`)
    fs.chmodSync(fakeBrPath, 0o755)

    const result = spawnSync(bashPath, [tmPath, "sync"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        TM_BACKEND: "br",
        PATH: tmpBinDir,
        LINEAR_API_KEY: "lin_api_test123",
        LINEAR_TEAM_KEY: "ENG",
      },
      timeout: 10000,
    })

    assert.equal(result.status, 37)
    assert.match(result.stderr, /br sync failed \(exit 37\), skipping follow-on sync/)
    assert.doesNotMatch(result.stderr, /follow-on sync was skipped/)
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm sync under tk performs direct local sync and reports unsupported follow-on sync", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-tk-sync-"))
  const argsCapturePath = path.join(tmpBinDir, "tk-args.txt")
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const fakeTkPath = path.join(tmpBinDir, "tk")
    fs.writeFileSync(fakeTkPath, `#!${bashPath}\nprintf '%s\\n' \"$*\" > \"${argsCapturePath}\"\nif [[ \"$1\" == \"sync\" ]]; then exit 0; fi\nexit 0\n`)
    fs.chmodSync(fakeTkPath, 0o755)

    const result = spawnSync(bashPath, [tmPath, "sync"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        TM_BACKEND: "tk",
        PATH: tmpBinDir,
        LINEAR_API_KEY: "lin_api_test123",
        LINEAR_TEAM_KEY: "ENG",
      },
      timeout: 10000,
    })

    assert.equal(result.status, 0)
    assert.equal(fs.existsSync(argsCapturePath), true)
    assert.equal(fs.readFileSync(argsCapturePath, "utf8").trim(), "sync")
    assert.match(result.stderr, /not supported for backend 'tk'/)
    assert.match(result.stderr, /follow-on sync was skipped/)
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm sync under tk propagates local sync failure and skips follow-on sync", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-tk-sync-fail-"))
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const fakeTkPath = path.join(tmpBinDir, "tk")
    fs.writeFileSync(fakeTkPath, `#!${bashPath}\nif [[ \"$1\" == \"sync\" ]]; then exit 23; fi\nexit 0\n`)
    fs.chmodSync(fakeTkPath, 0o755)

    const result = spawnSync(bashPath, [tmPath, "sync"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        TM_BACKEND: "tk",
        PATH: tmpBinDir,
        LINEAR_API_KEY: "lin_api_test123",
        LINEAR_TEAM_KEY: "ENG",
      },
      timeout: 10000,
    })

    assert.equal(result.status, 23)
    assert.match(result.stderr, /tk sync failed \(exit 23\), skipping follow-on sync/)
    assert.doesNotMatch(result.stderr, /follow-on sync was skipped/)
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
  }
})

test("tm sync honors explicitly empty Linear config values and skips backend-config fallback", () => {
  const os = require("node:os")
  const fs = require("node:fs")
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-sync-empty-config-"))
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "tm-sync-empty-config-repo-"))
  const bashPath = findCommandPath("bash") || "/bin/bash"

  try {
    fs.mkdirSync(path.join(tmpRepo, ".beads"), { recursive: true })
    fs.writeFileSync(path.join(tmpRepo, ".beads", "config.yaml"), "linear.api-key:\nlinear.team-key:\n")

    for (const commandName of ["awk", "dirname", "grep"]) {
      const commandPath = findCommandPath(commandName)
      assert.ok(commandPath, `Could not find ${commandName} on PATH`)
      fs.symlinkSync(commandPath, path.join(tmpBinDir, commandName))
    }

    const fakeBdPath = path.join(tmpBinDir, "bd")
    fs.writeFileSync(
      fakeBdPath,
      `#!${bashPath}
if [[ "$1" == "sync" ]]; then exit 0; fi
if [[ "$1" == "config" && "$2" == "get" ]]; then
  if [[ "$3" == "linear.api-key" ]]; then echo "lin_api_cfg"; exit 0; fi
  if [[ "$3" == "linear.team-key" ]]; then echo "ENG"; exit 0; fi
  echo "$3 (not set)"
  exit 0
fi
exit 0
`,
    )
    fs.chmodSync(fakeBdPath, 0o755)

    const env = {
      ...process.env,
      TM_BACKEND: "bd",
      PATH: tmpBinDir,
    }
    delete env.LINEAR_API_KEY
    delete env.LINEAR_TEAM_KEY

    const result = spawnSync(bashPath, [tmPath, "sync"], {
      cwd: tmpRepo,
      encoding: "utf8",
      env,
      timeout: 10000,
    })

    assert.equal(result.status, 0)
    assert.equal(result.stderr, "")
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true })
    fs.rmSync(tmpRepo, { recursive: true, force: true })
  }
})

function findCommandPath(commandName) {
  const fs = require("node:fs")
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue
    const fullPath = path.join(dir, commandName)
    try {
      fs.accessSync(fullPath, fs.constants.X_OK)
      return fullPath
    } catch {
      continue
    }
  }
  return null
}
