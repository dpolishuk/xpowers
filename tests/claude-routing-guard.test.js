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

test("readonly shell commands and genuine git queries are allowed", (t) => {
  const f = fixture(t)
  for (const command of [
    "pwd", "ls -la", "cat README.md", "rg --files", "rg -n pattern src | head -20", "grep -R pattern src", "tail -30 file.log",
    "git status --short", "git --no-pager diff HEAD", "git diff --stat", "git diff --no-ext-diff --no-textconv",
    "git log -5 --oneline", "git show HEAD:README.md", "git branch --show-current", "git branch --list 'feature/*'",
    "git rev-parse --show-toplevel", "git merge-base HEAD main", "git merge-tree base ours theirs", "git ls-files", "git -C subdir status",
  ]) allowed(f.run("Bash", { command }), command)
})

test("coordinator shell rejects mutation, evaluation, write flags and command injection", (t) => {
  const f = fixture(t)
  for (const command of [
    "git merge main", "git apply changes.patch", "git checkout main", "git reset --hard", "git config user.name alice",
    "git branch new-branch", "git branch -D stale", "git diff --output=source.js", "git diff --output source.js",
    "git branch -l new-branch", "git diff --out=source.js", "git diff --ext", "git show --textc",
    "git -c alias.safe='!touch src.js' safe", "git --config-env=alias.safe=BAD safe", "git diff --ext-diff", "git show --textconv",
    "cat README.md > src.js", "cat README.md >> src.js", "cat README.md | tee src.js", "git status && touch src.js",
    "git status; touch src.js", "git status\ntouch src.js", "git show $(touch src.js)", "cat `touch src.js`", "cat <(touch src.js)",
    "python3 -c 'open(\"src.js\",\"w\").write(\"bad\")'", "node -e 'require(\"fs\").writeFileSync(\"src.js\",\"bad\")'",
    "bash -c 'git status'", "env git status", "GIT_EXTERNAL_DIFF=bad git diff", "rg --pre=bad pattern", "rg --hostname-bin bad pattern",
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
    "rg 'foo.*bar' src", "rg \"[a-z]?\" src", "rg 'config{value}' src",
    "git branch --list 'feature/*'", "git diff -- 'src/[name].js'", "rg 'it'\\''s.*quoted' src",
  ]) allowed(f.run("Bash", { command }), command)
  for (const command of [
    "git diff --out\"p\"* /dev/null input.txt", "git diff --out[pu]* /dev/null input.txt",
    "git diff --out?ut=victim.txt /dev/null input.txt", "git diff --out{put,put}=victim.txt /dev/null input.txt",
  ]) denied(f.run("Bash", { command }), command)
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
    allowed(f.run("Bash", { command: "git diff" }, { agent_id: "agent-123", agent_type: `xpowers-routing-${role}` }))
  }
})
