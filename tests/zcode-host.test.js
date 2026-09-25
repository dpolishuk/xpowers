const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const repoRoot = path.resolve(__dirname, "..")
const bun = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "xpowers-zcode-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, ".zcode"))
  fs.mkdirSync(path.join(home, "bin"))
  fs.symlinkSync(bun, path.join(home, "bin", "bun"))
  fs.symlinkSync(process.execPath, path.join(home, "bin", "node"))
  return home
}

function run(home, installer, uninstall = false, extraEnv = {}, options = {}) {
  const hostArgs = options.allHosts ? [] : ["--hosts", "zcode"]
  const args = installer === "bash"
    ? ["scripts/install.sh", ...hostArgs, "--yes"]
    : ["scripts/install.ts", ...hostArgs, "--yes", "--json", "--features", "__none__"]
  if (uninstall) args.push("--uninstall")
  return spawnSync(installer === "bash" ? "bash" : bun, args, {
    cwd: options.sourceRoot ?? repoRoot,
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      NO_COLOR: "1",
      XPOWERS_SKIP_THIRD_PARTY_FEATURES: "1",
      // Exclude npm to keep host-only tests offline.
      PATH: `${path.join(home, "bin")}:/usr/bin:/bin`,
      ...extraEnv,
    },
  })
}

function success(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}

function put(home, relative, content) {
  const target = path.join(home, ".zcode", relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  return target
}

function assertInstalled(home) {
  for (const relative of [
    "skills/brainstorming/SKILL.md",
    "skills/common-patterns/bd-commands.md",
    "skills/codex-agent-ralph/SKILL.md",
    "commands/brainstorm.md",
    ".xpowers-version",
    ".xpowers-manifest",
  ]) {
    assert.ok(fs.existsSync(path.join(home, ".zcode", relative)), `missing ${relative}`)
  }
}

function assertRemoved(home) {
  for (const relative of ["skills/brainstorming", "skills/common-patterns", "skills/codex-agent-ralph", "commands/brainstorm.md", ".xpowers-version", ".xpowers-manifest"]) {
    assert.equal(fs.existsSync(path.join(home, ".zcode", relative)), false, `left behind ${relative}`)
  }
}

for (const installer of ["bash", "bun"]) {
  test(`${installer} ZCode install includes reference material and transactional agent wrappers`, { timeout: 120000 }, (t) => {
    const home = fixture(t)
    success(run(home, installer))
    assertInstalled(home)
    success(run(home, installer))
    assert.equal(fs.existsSync(path.join(home, ".zcode/skills/brainstorming/brainstorming")), false, "reinstall must replace instead of nest skills")
    success(run(home, installer, true))
    assertRemoved(home)
  })

  for (const failedMarker of [".xpowers-version", ".xpowers-manifest"]) {
    test(`${installer} ZCode rolls back skills, wrappers, and metadata when ${failedMarker} cannot be written`, { timeout: 120000 }, (t) => {
      const home = fixture(t)
      const skill = put(home, "skills/brainstorming/SKILL.md", "user skill\n")
      const wrapper = put(home, "skills/codex-agent-ralph/SKILL.md", "user wrapper\n")
      const otherMarker = failedMarker === ".xpowers-version" ? ".xpowers-manifest" : ".xpowers-version"
      const marker = put(home, otherMarker, "previous metadata\n")
      fs.mkdirSync(path.join(home, ".zcode", failedMarker))
      const result = run(home, installer)
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
      assert.equal(fs.readFileSync(skill, "utf8"), "user skill\n")
      assert.equal(fs.readFileSync(wrapper, "utf8"), "user wrapper\n")
      assert.equal(fs.readFileSync(marker, "utf8"), "previous metadata\n")
      assert.equal(fs.existsSync(path.join(home, ".zcode/skills/codex-agent-planner")), false, "new wrappers must be rolled back")
      assert.equal(fs.existsSync(path.join(home, ".zcode/skills/test-driven-development")), false, "new skills must be rolled back")
    })
  }
}

for (const [first, second] of [["bash", "bun"], ["bun", "bash"]]) {
  test(`ZCode ${first} → ${second} reinstall and uninstall clears ownership in both installers`, { timeout: 120000 }, (t) => {
    const home = fixture(t)
    const unrelated = put(home, "skills/my-own-skill/SKILL.md", "mine\n")
    success(run(home, first))
    success(run(home, second))
    success(run(home, second, true))
    assertRemoved(home)
    const recreated = put(home, "skills/brainstorming/SKILL.md", "recreated user skill\n")
    const recreatedWrapper = put(home, "skills/codex-agent-ralph/SKILL.md", "recreated user wrapper\n")
    success(run(home, first, true))
    assert.equal(fs.readFileSync(recreated, "utf8"), "recreated user skill\n")
    assert.equal(fs.readFileSync(recreatedWrapper, "utf8"), "recreated user wrapper\n")
    assert.equal(fs.readFileSync(unrelated, "utf8"), "mine\n")
  })

  test(`ZCode ${second} can directly uninstall a ${first} install`, { timeout: 120000 }, (t) => {
    const home = fixture(t)
    success(run(home, first))
    success(run(home, second, true))
    assertRemoved(home)
  })
}

for (const installer of ["bash", "bun"]) {
  test(`${installer} ZCode restores prior content after a late commands-directory failure`, { timeout: 120000 }, (t) => {
    const home = fixture(t)
    const skill = put(home, "skills/brainstorming/SKILL.md", "previous skill\n")
    const wrapper = put(home, "skills/codex-agent-ralph/SKILL.md", "previous wrapper\n")
    const marker = put(home, ".xpowers-version", "previous version\n")
    const manifest = put(home, ".xpowers-manifest", "# previous manifest\n")
    const commands = put(home, "commands", "user file blocks commands directory\n")
    const result = run(home, installer)
    assert.notEqual(result.status, 0)
    assert.equal(fs.readFileSync(skill, "utf8"), "previous skill\n")
    assert.equal(fs.readFileSync(wrapper, "utf8"), "previous wrapper\n")
    assert.equal(fs.readFileSync(marker, "utf8"), "previous version\n")
    assert.equal(fs.readFileSync(manifest, "utf8"), "# previous manifest\n")
    assert.equal(fs.readFileSync(commands, "utf8"), "user file blocks commands directory\n")
    assert.equal(fs.existsSync(path.join(home, ".zcode/skills/codex-agent-planner")), false)
    assert.equal(fs.existsSync(path.join(home, ".zcode/skills/test-driven-development")), false)
  })
}

test("Bun ZCode restores user content when the global manifest cannot be committed", { timeout: 120000 }, (t) => {
  const home = fixture(t)
  const skill = put(home, "skills/brainstorming/SKILL.md", "previous skill\n")
  const wrapper = put(home, "skills/codex-agent-ralph/SKILL.md", "previous wrapper\n")
  const version = put(home, ".xpowers-version", "previous version\n")
  const manifest = put(home, ".xpowers-manifest", "# previous manifest\n")
  fs.mkdirSync(path.join(home, ".xpowers/manifest.json"), { recursive: true })
  const result = run(home, "bun")
  assert.notEqual(result.status, 0)
  assert.equal(fs.readFileSync(skill, "utf8"), "previous skill\n")
  assert.equal(fs.readFileSync(wrapper, "utf8"), "previous wrapper\n")
  assert.equal(fs.readFileSync(version, "utf8"), "previous version\n")
  assert.equal(fs.readFileSync(manifest, "utf8"), "# previous manifest\n")
  assert.equal(fs.existsSync(path.join(home, ".zcode/skills/codex-agent-planner")), false)
})

test("Bash ZCode retires its Bun manifest entry without changing other hosts or features", { timeout: 120000 }, (t) => {
  const home = fixture(t)
  success(run(home, "bun"))
  const manifestPath = path.join(home, ".xpowers/manifest.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  const otherHost = { targetDir: path.join(home, ".other"), files: ["mine"] }
  const features = { existing: { installed: true } }
  manifest.hosts.other = otherHost
  manifest.features = features
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  success(run(home, "bash"))
  const after = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  assert.deepEqual(after.hosts, { other: otherHost })
  assert.deepEqual(after.features, features)
})

test("Bash ZCode fails without deleting files when a legacy JSON manifest is invalid", { timeout: 120000 }, (t) => {
  const home = fixture(t)
  const skill = put(home, "skills/brainstorming/SKILL.md", "user content\n")
  fs.mkdirSync(path.join(home, ".xpowers"))
  fs.writeFileSync(path.join(home, ".xpowers/manifest.json"), "{ invalid JSON\n")
  const result = run(home, "bash")
  assert.notEqual(result.status, 0, "must not report success while leaving an unreadable ownership record")
  assert.equal(fs.readFileSync(skill, "utf8"), "user content\n")
})

test("Bash ZCode removes an older Bun JSON-only install and preserves unrelated records", { timeout: 120000 }, (t) => {
  const home = fixture(t)
  const owned = put(home, "skills/brainstorming/SKILL.md", "old XPowers skill\n")
  const user = put(home, "skills/my-own-skill/SKILL.md", "mine\n")
  const global = path.join(home, ".xpowers/manifest.json")
  const other = { targetDir: path.join(home, ".other"), files: ["user-file"] }
  fs.mkdirSync(path.dirname(global))
  fs.writeFileSync(global, JSON.stringify({ hosts: {
    zcode: { targetDir: path.join(home, ".zcode"), files: ["skills/brainstorming/"] },
    other,
  }, features: {} }))
  success(run(home, "bash", true))
  assert.equal(fs.existsSync(owned), false)
  assert.equal(fs.readFileSync(user, "utf8"), "mine\n")
  assert.deepEqual(JSON.parse(fs.readFileSync(global, "utf8")).hosts, { other })
})

for (const installer of ["bash", "bun"]) {
  test(`${installer} ZCode uses the shared manifest instead of stale global ownership`, { timeout: 120000 }, (t) => {
    const home = fixture(t)
    success(run(home, "bun"))
    const user = put(home, "skills/my-own-skill/SKILL.md", "mine\n")
    const global = path.join(home, ".xpowers/manifest.json")
    const manifest = JSON.parse(fs.readFileSync(global, "utf8"))
    manifest.hosts.zcode.files.push("skills/my-own-skill/")
    fs.writeFileSync(global, JSON.stringify(manifest))
    success(run(home, installer, true))
    assertRemoved(home)
    assert.equal(fs.readFileSync(user, "utf8"), "mine\n")
  })
}

test("Bash ZCode removes staging files when the first destination is blocked", { timeout: 120000 }, (t) => {
  const home = fixture(t)
  const blocker = put(home, "skills", "user file\n")
  const result = run(home, "bash")
  assert.notEqual(result.status, 0)
  assert.equal(fs.readFileSync(blocker, "utf8"), "user file\n")
  assert.deepEqual(fs.readdirSync(path.join(home, ".zcode")), ["skills"])
})

for (const installer of ["bash", "bun"]) {
  test(`${installer} ZCode stops before deleting files when global ownership cannot be retired`, {
    timeout: 120000,
    skip: process.getuid?.() === 0 && "root bypasses directory permissions",
  }, (t) => {
    const home = fixture(t)
    success(run(home, "bun"))
    const globalDir = path.join(home, ".xpowers")
    const global = path.join(globalDir, "manifest.json")
    const before = fs.readFileSync(global, "utf8")
    fs.chmodSync(globalDir, 0o555)
    try {
      const result = run(home, installer, true)
      assert.notEqual(result.status, 0, "uninstall must report the ownership write failure")
      assertInstalled(home)
      assert.equal(fs.readFileSync(global, "utf8"), before)
    } finally {
      fs.chmodSync(globalDir, 0o755)
    }
    success(run(home, installer, true))
    assertRemoved(home)
    const recreated = put(home, "skills/brainstorming/SKILL.md", "recreated user skill\n")
    success(run(home, installer, true))
    assert.equal(fs.readFileSync(recreated, "utf8"), "recreated user skill\n")
  })

  test(`${installer} ZCode preserves retry tracking after partial removal of a JSON-only install`, {
    timeout: 120000,
    skip: process.getuid?.() === 0 && "root bypasses directory permissions",
  }, (t) => {
    const home = fixture(t)
    put(home, "skills/brainstorming/SKILL.md", "owned skill\n")
    const command = put(home, "commands/brainstorm.md", "owned command\n")
    const global = path.join(home, ".xpowers/manifest.json")
    fs.mkdirSync(path.dirname(global))
    fs.writeFileSync(global, JSON.stringify({ version: "legacy", installedAt: "earlier", features: {}, hosts: {
      zcode: { targetDir: path.join(home, ".zcode"), files: ["commands/brainstorm.md", "skills/brainstorming/"] },
    } }))
    const skills = path.join(home, ".zcode/skills")
    fs.chmodSync(skills, 0o555)
    try {
      const result = run(home, installer, true)
      assert.notEqual(result.status, 0, "a removal error must not be reported as success")
      assert.equal(fs.existsSync(command), false)
      const pending = fs.readFileSync(path.join(home, ".zcode/.xpowers-manifest"), "utf8")
      assert.match(pending, /skills\/brainstorming\//)
      assert.doesNotMatch(pending, /commands\/brainstorm.md/)
      fs.writeFileSync(command, "recreated user command\n")
    } finally {
      fs.chmodSync(skills, 0o755)
    }
    success(run(home, installer, true))
    assert.equal(fs.existsSync(path.join(skills, "brainstorming")), false)
    assert.equal(fs.readFileSync(command, "utf8"), "recreated user command\n")
  })
}

for (const installer of ["bash", "bun"]) {
  test(`${installer} ZCode uninstall removes skill symlinks without deleting their source`, { timeout: 120000 }, (t) => {
    const home = fixture(t)
    const source = path.join(home, "source-skill")
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, "SKILL.md"), "source must survive\n")
    const link = path.join(home, ".zcode/skills/brainstorming")
    fs.mkdirSync(path.dirname(link))
    fs.symlinkSync(source, link)
    put(home, ".xpowers-manifest", "skills/brainstorming/\n")
    success(run(home, installer, true))
    assert.equal(fs.readFileSync(path.join(source, "SKILL.md"), "utf8"), "source must survive\n")
    assert.throws(() => fs.lstatSync(link), { code: "ENOENT" })
  })
}

function otherInstallation(home) {
  const otherHome = path.join(home, ".claude")
  fs.mkdirSync(otherHome)
  const file = path.join(otherHome, "owned.md")
  const settings = path.join(otherHome, "settings.json")
  fs.writeFileSync(file, "other host content\n")
  fs.writeFileSync(settings, JSON.stringify({ statusline: "xpowers statusline", theme: "dark" }))
  const global = path.join(home, ".xpowers/manifest.json")
  const manifest = JSON.parse(fs.readFileSync(global, "utf8"))
  const record = { targetDir: otherHome, files: ["owned.md"] }
  const feature = { installed: true, metadata: { owner: "claude" } }
  manifest.hosts.claude = record
  manifest.features.statusline = feature
  fs.writeFileSync(global, JSON.stringify(manifest))
  return { file, settings, global, record, feature }
}

for (const installer of ["bash", "bun"]) {
  for (const legacy of [false, true]) {
    test(`${installer} explicit ZCode uninstall preserves unrelated hosts and features (${legacy ? "JSON-only" : "shared"})`, { timeout: 120000 }, (t) => {
      const home = fixture(t)
      success(run(home, "bun"))
      if (legacy) fs.unlinkSync(path.join(home, ".zcode/.xpowers-manifest"))
      const other = otherInstallation(home)
      success(run(home, installer, true))
      assertRemoved(home)
      success(run(home, installer, true))
      assert.equal(fs.readFileSync(other.file, "utf8"), "other host content\n")
      assert.equal(JSON.parse(fs.readFileSync(other.settings, "utf8")).statusline, "xpowers statusline")
      const remaining = JSON.parse(fs.readFileSync(other.global, "utf8"))
      assert.deepEqual(remaining.hosts, { claude: other.record })
      assert.deepEqual(remaining.features, { statusline: other.feature })
    })
  }
}

test("unqualified Bun uninstall still removes all installed hosts and features", { timeout: 120000 }, (t) => {
  const home = fixture(t)
  success(run(home, "bun"))
  const other = otherInstallation(home)
  success(run(home, "bun", true, {}, { allHosts: true }))
  assertRemoved(home)
  assert.equal(fs.existsSync(other.file), false)
  assert.equal(JSON.parse(fs.readFileSync(other.settings, "utf8")).statusline, undefined)
  assert.equal(fs.existsSync(other.global), false)
})

function sourceFixture(t) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "xpowers-zcode-source-"))
  t.after(() => fs.rmSync(source, { recursive: true, force: true }))
  fs.cpSync(path.join(repoRoot, "scripts"), path.join(source, "scripts"), { recursive: true })
  fs.mkdirSync(path.join(source, ".claude-plugin"))
  fs.copyFileSync(path.join(repoRoot, ".claude-plugin/plugin.json"), path.join(source, ".claude-plugin/plugin.json"))
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(source, "node_modules"))
  for (const relative of ["skills/retired-skill/SKILL.md", ".agents/skills/codex-agent-retired/SKILL.md", "commands/retired.md"]) {
    const file = path.join(source, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `original ${relative}\n`)
  }
  return source
}

function renameSourceEntries(source) {
  for (const [before, after] of [
    ["skills/retired-skill", "skills/replacement-skill"],
    [".agents/skills/codex-agent-retired", ".agents/skills/codex-agent-replacement"],
    ["commands/retired.md", "commands/replacement.md"],
  ]) fs.renameSync(path.join(source, before), path.join(source, after))
}

for (const installer of ["bash", "bun"]) {
  for (const legacy of [false, true]) {
    test(`${installer} ZCode upgrade removes retired entries from ${legacy ? "legacy JSON" : "shared"} ownership`, { timeout: 120000 }, (t) => {
      const home = fixture(t)
      const sourceRoot = sourceFixture(t)
      success(run(home, "bun", false, {}, { sourceRoot }))
      if (legacy) fs.unlinkSync(path.join(home, ".zcode/.xpowers-manifest"))
      const user = put(home, "skills/user-skill/SKILL.md", "user skill\n")
      renameSourceEntries(sourceRoot)
      success(run(home, installer, false, {}, { sourceRoot }))
      for (const relative of ["skills/retired-skill", "skills/codex-agent-retired", "commands/retired.md"]) {
        assert.equal(fs.existsSync(path.join(home, ".zcode", relative)), false, `retired entry remains active: ${relative}`)
      }
      for (const relative of ["skills/replacement-skill/SKILL.md", "skills/codex-agent-replacement/SKILL.md", "commands/replacement.md"]) {
        assert.equal(fs.existsSync(path.join(home, ".zcode", relative)), true)
      }
      assert.equal(fs.readFileSync(user, "utf8"), "user skill\n")
      assert.doesNotMatch(fs.readFileSync(path.join(home, ".zcode/.xpowers-manifest"), "utf8"), /retired/)
    })
  }

  test(`${installer} failed ZCode upgrade restores retired files and previous ownership`, {
    timeout: 120000,
    skip: process.getuid?.() === 0 && "root bypasses directory permissions",
  }, (t) => {
    const home = fixture(t)
    const sourceRoot = sourceFixture(t)
    success(run(home, "bun", false, {}, { sourceRoot }))
    const shared = path.join(home, ".zcode/.xpowers-manifest")
    const before = fs.readFileSync(shared, "utf8")
    renameSourceEntries(sourceRoot)
    const globalDir = path.join(home, ".xpowers")
    fs.chmodSync(globalDir, 0o555)
    try {
      assert.notEqual(run(home, installer, false, {}, { sourceRoot }).status, 0)
    } finally {
      fs.chmodSync(globalDir, 0o755)
    }
    for (const [relative, original] of [
      ["skills/retired-skill/SKILL.md", "skills/retired-skill/SKILL.md"],
      ["skills/codex-agent-retired/SKILL.md", ".agents/skills/codex-agent-retired/SKILL.md"],
      ["commands/retired.md", "commands/retired.md"],
    ]) assert.equal(fs.readFileSync(path.join(home, ".zcode", relative), "utf8"), `original ${original}\n`)
    assert.equal(fs.readFileSync(shared, "utf8"), before)
    for (const relative of ["skills/replacement-skill", "skills/codex-agent-replacement", "commands/replacement.md"]) {
      assert.equal(fs.existsSync(path.join(home, ".zcode", relative)), false)
    }
  })
}
