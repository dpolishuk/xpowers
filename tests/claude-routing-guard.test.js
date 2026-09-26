const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const runtime = path.join(__dirname, "../scripts/claude-routing")
const invoke = String.raw`
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import common, guard
request = json.load(sys.stdin)
project = Path(request["project"])
config_path = project / ".claude" / "routing.json"
config_path.parent.mkdir(parents=True, exist_ok=True)
if request.get("config", "default") == "default":
    default_config = json.dumps(common.preset_config("opus"))
    config_path.write_text(default_config)
elif request.get("config") is not None:
    config_path.write_text(request["config"])
generated = project / ".claude" / "xpowers-routing" / "generated-config.json"
generated.parent.mkdir(parents=True, exist_ok=True)
generated.write_text(request.get("generated", json.dumps(common.preset_config("opus"))))
state_path = common.session_path(project, "test-session")
state_path.parent.mkdir(parents=True, exist_ok=True)
if request.get("state") is not None:
    state_path.write_text(request["state"])
print(json.dumps(guard.handle(request["payload"], project)))
`

function fixture(t) {
  assert.ok(fs.existsSync(path.join(runtime, "guard.py")), "routing guard implementation is missing")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xpowers-routing-guard-"))
  const project = path.join(root, "project")
  const home = path.join(root, "home")
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return {
    root, project, home,
    run(tool, input = {}, overrides = {}, settings = {}) {
      const payload = { session_id: "test-session", cwd: project, tool_name: tool, tool_input: input, ...overrides }
      const result = spawnSync("python3", ["-B", "-c", invoke, runtime], {
        input: JSON.stringify({ project, state: '{"enabled":true}', payload, ...settings }),
        env: { ...process.env, HOME: home, ...settings.env }, encoding: "utf8", timeout: 10000,
      })
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(result.stdout)
    },
  }
}

function denied(result, message = "") {
  assert.equal(result.hookSpecificOutput?.hookEventName, "PreToolUse", message)
  assert.equal(result.hookSpecificOutput?.permissionDecision, "deny", message)
  assert.ok(result.hookSpecificOutput.permissionDecisionReason.length > 0)
}

function allowed(result, message = "") {
  assert.deepEqual(result, {}, message)
}

test("routing guard is inactive for an absent or disabled session", (t) => {
  const f = fixture(t)
  allowed(f.run("Write", { file_path: "source.js" }, {}, { state: null, config: null }))
  allowed(f.run("Write", { file_path: "source.js" }, {}, { state: '{"enabled":false}', config: "invalid" }))
})

test("active routing fails closed for corrupt state, config and malformed tool input", (t) => {
  const f = fixture(t)
  denied(f.run("Read", {}, {}, { state: "not-json" }))
  denied(f.run("Read", {}, {}, { state: "{}" }))
  denied(f.run("Read", {}, {}, { state: '{"enabled":"yes"}' }))
  denied(f.run("Read", {}, {}, { config: "not-json" }))
  denied(f.run("Read", {}, {}, { config: "{}" }))
  denied(f.run("Edit", null))
  denied(f.run("Write", {}))
  denied(f.run("Read", {}, { session_id: null }))
  denied(f.run("Read", {}, { tool_name: null }))
})

test("coordinator cannot edit source with native tools or spoof a worker agent_type", (t) => {
  const f = fixture(t)
  for (const tool of ["Write", "Edit", "NotebookEdit"]) {
    const input = { file_path: "src/main.js", notebook_path: "analysis.ipynb" }
    denied(f.run(tool, input), tool)
    denied(f.run(tool, input, { agent_type: "xpowers-routing-worker" }), `${tool} main --agent`)
    denied(f.run(tool, input, { agent_id: "", agent_type: "xpowers-routing-worker" }), `${tool} empty agent_id`)
  }
})

test("native path checks cover cwd, traversal, symlinks and outside scratchpad", (t) => {
  const f = fixture(t)
  const outside = path.join(f.root, "scratch")
  fs.mkdirSync(outside)
  fs.mkdirSync(path.join(f.project, "subdir"))
  fs.symlinkSync(f.project, path.join(outside, "project-link"), "dir")
  fs.symlinkSync(outside, path.join(f.project, "outside-link"), "dir")
  denied(f.run("Edit", { file_path: "../src.js" }, { cwd: path.join(f.project, "subdir") }))
  denied(f.run("Write", { file_path: "project-link/src.js" }, { cwd: outside }))
  denied(f.run("Write", { file_path: "outside-link/memory.md" }))
  denied(f.run("Write", { file_path: `${outside}/../project/source.js` }))
  allowed(f.run("Write", { file_path: path.join(outside, "memory.md") }))
  allowed(f.run("Edit", { file_path: "memory.md" }, { cwd: outside }))
  denied(f.run("Write", { file_path: path.join(f.home, ".claude/xpowers-routing/memory.json") }))
})

test("known delegated workers may edit, while review and exploration remain readonly", (t) => {
  const f = fixture(t)
  for (const role of ["worker", "senior"]) {
    allowed(f.run("Edit", { file_path: "src.js" }, { agent_id: "agent-123", agent_type: `xpowers-routing-${role}` }))
  }
  for (const role of ["explorer", "reviewer", "verifier"]) {
    denied(f.run("Edit", { file_path: "src.js" }, { agent_id: "agent-123", agent_type: `xpowers-routing-${role}` }), role)
  }
  denied(f.run("Edit", { file_path: "src.js" }, { agent_id: "agent-123", agent_type: "worker" }))
  denied(f.run("Edit", { file_path: "src.js" }, { agent_id: "agent-123" }))
  denied(f.run("Edit", { file_path: "src.js" }, { agent_id: { id: "agent-123" }, agent_type: "xpowers-routing-worker" }))
})

test("native tools cannot rewrite routing controls even from delegated workers", (t) => {
  const f = fixture(t)
  for (const target of [".claude/routing.json", ".claude/xpowers-routing/guard.py"]) {
    denied(f.run("Edit", { file_path: target }, { agent_id: "agent-123", agent_type: "xpowers-routing-worker" }))
  }
})

test("routing settings and generated agent definitions are protected from native edits", (t) => {
  const f = fixture(t)
  for (const target of [".claude/settings.json", ".claude/settings.local.json", ".claude/agents/xpowers-routing-worker.md"]) {
    denied(f.run("Edit", { file_path: target }, { agent_id: "agent-123", agent_type: "xpowers-routing-worker" }), target)
  }
  for (const target of ["settings.json", "settings.local.json"]) {
    denied(f.run("Write", { file_path: path.join(f.home, ".claude", target) }), target)
  }
})

test("generated routing commands are protected from worker and senior native edits", (t) => {
  const f = fixture(t)
  const commandDirectory = path.join(f.project, ".claude", "commands")
  fs.mkdirSync(commandDirectory, { recursive: true })
  const commandAlias = path.join(f.project, "routing-command-alias")
  fs.symlinkSync(commandDirectory, commandAlias, "dir")
  const targets = [
    ".claude/commands/routing-on.md",
    path.join(f.project, ".claude", "commands", "routing-off.md"),
    path.join(commandAlias, "routing-smoke-test.md"),
  ]
  for (const role of ["worker", "senior"]) {
    const identity = { agent_id: "agent-123", agent_type: `xpowers-routing-${role}` }
    for (const tool of ["Write", "Edit", "NotebookEdit"]) {
      const key = tool === "NotebookEdit" ? "notebook_path" : "file_path"
      for (const target of targets) denied(f.run(tool, { [key]: target }, identity), `${role} ${tool} ${target}`)
      allowed(f.run(tool, { [key]: ".claude/commands/project-command.md" }, identity), `${role} ${tool} unrelated command`)
    }
  }
})

test("custom CLAUDE_CONFIG_DIR settings are protected while outside scratch remains writable", (t) => {
  const f = fixture(t)
  const configDirectory = path.join(f.root, "custom-claude")
  const settings = { env: { CLAUDE_CONFIG_DIR: configDirectory } }
  for (const role of ["coordinator", "worker"]) {
    const identity = role === "coordinator" ? {} : { agent_id: "agent-123", agent_type: "xpowers-routing-worker" }
    for (const tool of ["Write", "Edit"]) {
      for (const name of ["settings.json", "settings.local.json"]) {
        denied(f.run(tool, { file_path: path.join(configDirectory, name), content: '{"disableAllHooks":true}' }, identity, settings), `${role} ${tool} ${name}`)
      }
    }
  }
  allowed(f.run("Write", { file_path: path.join(f.root, "memory.md") }, {}, settings))
})

test("active sessions reject an agent snapshot that no longer matches routing configuration", (t) => {
  const f = fixture(t)
  denied(f.run("Agent", { subagent_type: "xpowers-routing-worker" }, {}, { generated: "{}" }))
})

test("readonly delegates cannot launch a worker to bypass source protection", (t) => {
  const f = fixture(t)
  for (const role of ["explorer", "reviewer", "verifier"]) {
    denied(f.run("Agent", { subagent_type: "xpowers-routing-worker" }, { agent_id: "agent-123", agent_type: `xpowers-routing-${role}` }), role)
  }
})

test("source protection recognizes filesystem case aliases on case insensitive volumes", (t) => {
  const f = fixture(t)
  const alias = path.join(f.root, "PROJECT")
  if (!fs.existsSync(alias)) return t.skip("Case sensitive filesystem")
  denied(f.run("Write", { file_path: path.join(alias, "new-source.js") }))
})

test("coordinator can read and only delegate to configured routing roles", (t) => {
  const f = fixture(t)
  for (const tool of ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "AskUserQuestion"]) allowed(f.run(tool), tool)
  for (const role of ["explorer", "worker", "verifier", "senior", "reviewer"]) {
    allowed(f.run("Agent", { subagent_type: `xpowers-routing-${role}`, prompt: "Task card" }), role)
  }
  allowed(f.run("Task", { subagent_type: "xpowers-routing-worker", prompt: "Task card" }))
  denied(f.run("Agent", { subagent_type: "general-purpose" }))
  denied(f.run("Task", { subagent_type: "xpowers-routing-coordinator" }))
  denied(f.run("UnknownEditingTool"))
  denied(f.run("mcp__filesystem__write_file", { path: "source.js" }))
})

test("coordinator can collect results from a background delegated task", (t) => {
  const f = fixture(t)
  allowed(f.run("TaskOutput", { task_id: "worker-background", block: true, timeout: 1000 }))
})

test("independent verifier and reviewer cannot resume, fork or override configured model", (t) => {
  const f = fixture(t)
  for (const role of ["reviewer", "verifier"]) {
    const input = { subagent_type: `xpowers-routing-${role}` }
    for (const extra of [{ resume: "agent-old" }, { fork: true }, { fork_context: true }, { model: "haiku" }]) {
      denied(f.run("Agent", { ...input, ...extra }), JSON.stringify({ role, extra }))
    }
  }
  allowed(f.run("Agent", { subagent_type: "xpowers-routing-worker", resume: "worker-previous" }))
  allowed(f.run("Agent", { subagent_type: "xpowers-routing-verifier", model: "claude-sonnet-5" }))
  denied(f.run("Agent", { subagent_type: "xpowers-routing-worker", model: "haiku" }))
})

test("readonly shell commands and the bounded Git query subset are allowed", (t) => {
  const f = fixture(t)
  for (const command of [
    "pwd", "ls -la", "cat README.md", "rg --no-config --files", "rg --no-config -n pattern src | head -20", "grep -R pattern src", "tail -30 file.log",
    "git --no-pager --no-lazy-fetch rev-parse --show-toplevel", "git --no-pager --no-lazy-fetch merge-base HEAD main",
    "git --no-pager --no-lazy-fetch ls-tree HEAD", "git --no-pager --no-lazy-fetch branch --show-current",
    "git --no-optional-locks --no-pager -C subdir --no-lazy-fetch rev-parse --show-toplevel",
  ]) allowed(f.run("Bash", { command }), command)
})

test("coordinator shell rejects mutation, evaluation, write flags and command injection", (t) => {
  const f = fixture(t)
  for (const command of [
    "git merge main", "git apply changes.patch", "git checkout main", "git reset --hard", "git config user.name alice",
    "git status --short", "git --no-pager diff HEAD", "git --no-pager log -1", "git --no-pager show HEAD",
    "git --no-pager rev-list HEAD", "git --no-pager ls-files", "git --no-pager merge-tree base ours theirs",
    "git --no-pager --no-lazy-fetch status --short", "git --no-pager --no-lazy-fetch diff HEAD",
    "git --no-pager --no-lazy-fetch show '--format=%G?' HEAD", "git --no-pager --no-lazy-fetch log '--format=%G?' -1",
    "git --no-pager --no-lazy-fetch rev-list '--format=%G?' HEAD", "git --no-pager --no-lazy-fetch rev-list --objects --indexed-objects HEAD",
    "git --no-pager --no-lazy-fetch ls-files", "git --no-pager --no-lazy-fetch for-each-ref refs/heads",
    "git --no-pager --no-lazy-fetch describe --always", "git --no-pager --no-lazy-fetch shortlog HEAD",
    "git --no-pager --no-lazy-fetch merge-tree HEAD~1 HEAD", "git --no-pager --no-lazy-fetch merge-tree base ours theirs",
    "git rev-parse --show-toplevel", "git merge-base HEAD main", "git ls-tree HEAD", "git branch --show-current",
    "git --no-pager rev-parse HEAD", "git --no-lazy-fetch rev-parse HEAD",
    "git -C --no-pager --no-lazy-fetch rev-parse HEAD", "git --no-pager -C --no-lazy-fetch rev-parse HEAD",
    "git --no-pager --no-lazy-fetch branch --list", "git --no-pager --no-lazy-fetch branch -a",
    "git --no-pager --no-lazy-fetch --help", "git --no-pager --no-lazy-fetch -h",
    "git --no-pager --no-lazy-fetch rev-parse --help", "git --no-pager --no-lazy-fetch rev-parse --hel",
    "git --no-pager --no-lazy-fetch rev-parse -c alias.bad=value", "git --no-pager --no-lazy-fetch rev-parse --config-env=alias.bad=BAD",
    "git --no-pager --no-lazy-fetch rev-parse --git-dir=other", "git --no-pager --no-lazy-fetch ls-tree --work-tree=other HEAD",
    "git branch new-branch", "git branch -D stale", "git diff --output=source.js", "git diff --output source.js",
    "git branch -l new-branch", "git diff --out=source.js", "git diff --ext", "git show --textc",
    "git -c alias.safe='!touch src.js' safe", "git --config-env=alias.safe=BAD safe", "git diff --ext-diff", "git show --textconv",
    "cat README.md > src.js", "cat README.md >> src.js", "cat README.md | tee src.js", "git status && touch src.js",
    "git status; touch src.js", "git status\ntouch src.js", "git show $(touch src.js)", "cat `touch src.js`", "cat <(touch src.js)",
    "python3 -c 'open(\"src.js\",\"w\").write(\"bad\")'", "node -e 'require(\"fs\").writeFileSync(\"src.js\",\"bad\")'",
    "bash -c 'git status'", "env git status", "GIT_EXTERNAL_DIFF=bad git diff", "rg --files", "rg pattern .",
    "rg -e --no-config .", "rg -g --no-config pattern .", "rg -- --no-config", "rg -n --no-config pattern .",
    "rg --no-config --pre=bad pattern", "rg --no-config --pre-glob='*.pdf' pattern", "rg --no-config --hostname-bin bad pattern",
    "rg --no-config --pr=bad pattern", "rg --no-config --pre-g='*.pdf' pattern", "rg --no-config --hostname-b=bad pattern",
    "find . -exec touch src.js \\;", "sed -i '' s/a/b/ src.js", "npm test", "echo harmless", "git diff | sh",
  ]) denied(f.run("Bash", { command }), command)
})

for (const [name, flag] of [
  ["brace-expanded", "--out{put,put}=victim.txt"],
  ["glob-expanded", "--out*"],
]) {
  test(`coordinator prevents an actual write from a ${name} Git output flag`, (t) => {
    const f = fixture(t)
    const victim = path.join(f.project, "victim.txt")
    const original = "Do not overwrite this source file.\n"
    fs.writeFileSync(victim, original)
    fs.writeFileSync(path.join(f.project, "input.txt"), "changed content\n")
    fs.writeFileSync(path.join(f.project, "--output=victim.txt"), "glob expansion target\n")
    const command = `git diff --no-index ${flag} /dev/null input.txt`
    const decision = f.run("Bash", { command })
    if (!decision.hookSpecificOutput) {
      const execution = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
        cwd: f.project,
        env: { ...process.env, HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        encoding: "utf8", timeout: 10000,
      })
      assert.equal(execution.status, 1, execution.stderr)
    }
    assert.equal(fs.readFileSync(victim, "utf8"), original, "Guard allowed Git to overwrite the protected source")
    denied(decision)
  })
}

test("shell expansion screening preserves quoted literal search patterns", (t) => {
  const f = fixture(t)
  for (const command of [
    "rg --no-config 'foo.*bar' src", "rg --no-config \"[a-z]?\" src", "rg --no-config 'config{value}' src",
    "rg --no-config 'it'\\''s.*quoted' src",
  ]) allowed(f.run("Bash", { command }), command)
  for (const command of [
    "git diff --out\"p\"* /dev/null input.txt", "git diff --out[pu]* /dev/null input.txt",
    "git diff --out?ut=victim.txt /dev/null input.txt", "git diff --out{put,put}=victim.txt /dev/null input.txt",
  ]) denied(f.run("Bash", { command }), command)
})

test("shell queries preserve literal dollars and backticks without allowing substitution", (t) => {
  const f = fixture(t)
  for (const command of [
    "rg --no-config '^foo$' src", "rg --no-config '`literal`' src", "rg --no-config '$(literal)' src",
    "rg --no-config \\$literal src", "rg --no-config \\`literal\\` src", "rg --no-config \"\\$literal\" src", "rg --no-config \"\\`literal\\`\" src",
  ]) allowed(f.run("Bash", { command }), command)
  for (const command of [
    "rg $(touch victim.txt) src", "rg \"$(touch victim.txt)\" src",
    "rg `touch victim.txt` src", "rg \"`touch victim.txt`\" src",
    "rg $PATTERN src", "rg \"$PATTERN\" src", "rg \"\\\\$PATTERN\" src",
  ]) denied(f.run("Bash", { command }), command)
})

test("read-only roles require rg --no-config before every search", (t) => {
  const f = fixture(t)
  const input = path.join(f.project, "input.txt")
  const helper = path.join(f.root, "rg-preprocessor.sh")
  const config = path.join(f.root, "ripgreprc")
  const sentinel = path.join(f.root, "rg-helper-ran")
  fs.writeFileSync(input, "needle\n")
  fs.writeFileSync(helper, "#!/bin/sh\nprintf invoked > \"$RG_HELPER_SENTINEL\"\ncat \"$1\"\n", { mode: 0o700 })
  fs.writeFileSync(config, `--pre=${helper}\n`)
  const environment = { RIPGREP_CONFIG_PATH: config, RG_HELPER_SENTINEL: sentinel }

  const probe = spawnSync("rg", ["needle", f.project], {
    env: { ...process.env, ...environment }, encoding: "utf8", timeout: 10000,
  })
  assert.equal(probe.status, 0, probe.stderr)
  assert.equal(fs.readFileSync(sentinel, "utf8"), "invoked", "fixture did not execute the configured rg preprocessor")
  fs.rmSync(sentinel)
  const safeProbe = spawnSync("rg", ["--no-config", "needle", f.project], {
    env: { ...process.env, ...environment }, encoding: "utf8", timeout: 10000,
  })
  assert.equal(safeProbe.status, 0, safeProbe.stderr)
  assert.match(safeProbe.stdout, /needle/)
  assert.equal(fs.existsSync(sentinel), false, "--no-config still executed the configured rg preprocessor")

  for (const role of ["coordinator", "explorer", "reviewer"]) {
    const identity = role === "coordinator" ? {} : { agent_id: "agent-123", agent_type: `xpowers-routing-${role}` }
    denied(f.run("Bash", { command: "rg needle ." }, identity, { env: environment }), `${role} raw rg`)
    allowed(f.run("Bash", { command: "rg --no-config needle ." }, identity, { env: environment }), `${role} safe rg`)
  }
  assert.equal(fs.existsSync(sentinel), false, "guard evaluation executed the configured rg helper")

  for (const role of ["worker", "senior", "verifier"]) {
    allowed(f.run("Bash", { command: "rg needle ." }, {
      agent_id: "agent-123", agent_type: `xpowers-routing-${role}`,
    }, { env: environment }), role)
  }
})

test("only exact session control commands bypass coordinator shell restrictions", (t) => {
  const f = fixture(t)
  const control = `python3 ${f.project}/.claude/xpowers-routing/cli.py`
  for (const action of ["on", "off", "smoke", "status"]) {
    allowed(f.run("Bash", { command: `${control} ${action} --project ${f.project} --session test-session` }), action)
  }
  allowed(f.run("Bash", { command: `${control} off --project ${f.project} --session test-session` }, {}, { config: "not-json" }))
  for (const command of [
    `${control} off --project ${f.project} --session other-session`,
    `${control} off --project ${f.root} --session test-session`,
    `${control} off --project ${f.project} --session test-session --anything`,
    `${control} off --project ${f.project} --session test-session; touch src.js`,
    `python3 ${f.root}/other.py off --project ${f.project} --session test-session`,
  ]) denied(f.run("Bash", { command }), command)
})

test("verifier can run independent tests while explorer and reviewer shell stay readonly", (t) => {
  const f = fixture(t)
  for (const role of ["worker", "senior", "verifier"]) {
    allowed(f.run("Bash", { command: "docker compose run --rm integration npm test" }, { agent_id: "agent-123", agent_type: `xpowers-routing-${role}` }))
  }
  for (const role of ["explorer", "reviewer"]) {
    denied(f.run("Bash", { command: "touch src.js" }, { agent_id: "agent-123", agent_type: `xpowers-routing-${role}` }))
    denied(f.run("Bash", { command: "git diff" }, { agent_id: "agent-123", agent_type: `xpowers-routing-${role}` }))
    allowed(f.run("Bash", { command: "git --no-pager --no-lazy-fetch rev-parse --show-toplevel" }, { agent_id: "agent-123", agent_type: `xpowers-routing-${role}` }))
  }
})

for (const helperCase of [
  {
    name: "diff.external",
    command: "git --no-pager --no-lazy-fetch diff",
    probeCommand: "git --no-pager diff",
    prepare(f, helper, git) {
      fs.writeFileSync(path.join(f.project, "tracked.txt"), "one\n")
      assert.equal(git(["init", "-q"]).status, 0)
      assert.equal(git(["add", "tracked.txt"]).status, 0)
      assert.equal(git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"]).status, 0)
      fs.writeFileSync(path.join(f.project, "tracked.txt"), "two\n")
      assert.equal(git(["config", "diff.external", helper]).status, 0)
    },
  },
  {
    name: "core.fsmonitor",
    command: "git --no-pager --no-lazy-fetch status --short",
    probeCommand: "git --no-pager status --short",
    prepare(f, helper, git) {
      assert.equal(git(["init", "-q"]).status, 0)
      assert.equal(git(["config", "core.fsmonitor", helper]).status, 0)
    },
  },
]) {
  test(`coordinator refuses a Git query that can execute ${helperCase.name}`, (t) => {
    const f = fixture(t)
    const sentinel = path.join(f.root, "helper-ran")
    const helper = path.join(f.root, "git-helper.sh")
    fs.writeFileSync(helper, "#!/bin/sh\nprintf invoked > \"$GIT_HELPER_SENTINEL\"\nexit 0\n", { mode: 0o700 })
    const cleanEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    )
    const gitEnvironment = {
      ...cleanEnvironment,
      HOME: f.home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    }
    const git = args => spawnSync("git", args, {
      cwd: f.project, env: gitEnvironment, encoding: "utf8", timeout: 10000,
    })
    helperCase.prepare(f, helper, git)
    spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", helperCase.probeCommand], {
      cwd: f.project,
      env: {
        ...gitEnvironment,
        GIT_HELPER_SENTINEL: sentinel,
      },
      encoding: "utf8",
      timeout: 10000,
    })
    assert.equal(fs.readFileSync(sentinel, "utf8"), "invoked", "fixture did not reproduce configured helper execution")
    fs.rmSync(sentinel)
    const decision = f.run("Bash", { command: helperCase.command })
    denied(decision)
    assert.equal(fs.existsSync(sentinel), false, "denied Git query still executed its configured helper")
  })
}

test("guarded Git queries disable partial-clone lazy fetches", (t) => {
  const f = fixture(t)
  const home = path.join(f.root, "git-home")
  const bin = path.join(f.root, "bin")
  const sentinel = path.join(f.root, "remote-helper-ran")
  fs.mkdirSync(home)
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(f.project, "tracked.txt"), "content\n")
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  )
  const gitEnvironment = {
    ...cleanEnvironment,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  }
  const git = args => spawnSync("git", args, { cwd: f.project, env: gitEnvironment, encoding: "utf8", timeout: 10000 })
  assert.equal(git(["init", "-q"]).status, 0)
  assert.equal(git(["add", "tracked.txt"]).status, 0)
  assert.equal(git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"]).status, 0)
  const tree = git(["rev-parse", "HEAD^{tree}"])
  assert.equal(tree.status, 0, tree.stderr)
  const treeId = tree.stdout.trim()
  for (const [name, value] of [
    ["core.repositoryformatversion", "1"],
    ["extensions.partialClone", "origin"],
    ["remote.origin.url", "probe::unused"],
    ["remote.origin.promisor", "true"],
    ["remote.origin.partialclonefilter", "blob:none"],
  ]) assert.equal(git(["config", name, value]).status, 0)
  fs.rmSync(path.join(f.project, ".git", "objects", treeId.slice(0, 2), treeId.slice(2)))
  const helper = path.join(bin, "git-remote-probe")
  fs.writeFileSync(helper, `#!/bin/sh\nprintf 'hit\\n' >> '${sentinel}'\nexit 1\n`, { mode: 0o700 })

  const unsafe = "git --no-pager ls-tree HEAD"
  git(["--no-pager", "ls-tree", "HEAD"])
  assert.match(fs.readFileSync(sentinel, "utf8"), /hit/, "fixture did not reproduce a lazy remote helper")
  fs.rmSync(sentinel)
  denied(f.run("Bash", { command: unsafe }))

  const safe = "git --no-pager --no-lazy-fetch ls-tree HEAD"
  allowed(f.run("Bash", { command: safe }))
  git(["--no-pager", "--no-lazy-fetch", "ls-tree", "HEAD"])
  assert.equal(fs.existsSync(sentinel), false, "--no-lazy-fetch still invoked the remote helper")
})
