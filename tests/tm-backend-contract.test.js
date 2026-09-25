const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")

const repoRoot = path.resolve(__dirname, "..")
const tmPath = path.join(repoRoot, "scripts", "tm")
const backendRegistryPath = path.join(repoRoot, "scripts", "tm-backends.sh")

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8")
}

function readBackendsFromRegistry() {
  const result = spawnSync("bash", ["-lc", `source "${backendRegistryPath}" && tm_backend_ids`], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10000,
  })

  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim().split("\n").filter(Boolean)
}

test("tm backend registry is shell-readable and lists peer backends", () => {
  assert.equal(fs.existsSync(backendRegistryPath), true)
  assert.deepEqual(readBackendsFromRegistry(), ["bd", "br", "tk", "linear"])
})

test("tm help backend list stays aligned with backend registry", () => {
  const help = spawnSync(tmPath, ["--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10000,
  })

  assert.equal(help.status, 0, help.stderr)
  const availableBackendsSection = help.stdout.split("Available backends:\n")[1]?.split("\n\nExamples:")[0] || ""
  const actualLines = availableBackendsSection.split("\n").filter(Boolean)
  const expectedHelpLines = [
    "  bd      Local beads task manager (default)",
    "  br      Local beads_rust task manager",
    "  tk      Ticket git-backed markdown task manager",
    "  linear  Linear-native backend preview (core commands only)",
  ]

  assert.deepEqual(actualLines, expectedHelpLines)
})

test("tm backend sync contract is explicit in the shell registry", () => {
  const result = spawnSync("bash", ["-lc", `source "${backendRegistryPath}" && printf '%s,%s,%s,%s,%s,%s,%s,%s' "$(tm_backend_sync_mode bd)" "$(tm_backend_sync_mode br)" "$(tm_backend_sync_mode tk)" "$(tm_backend_sync_mode linear)" "$(tm_backend_supports_follow_on_linear_sync bd && echo yes || echo no)" "$(tm_backend_supports_follow_on_linear_sync br && echo yes || echo no)" "$(tm_backend_supports_follow_on_linear_sync tk && echo yes || echo no)" "$(tm_backend_supports_follow_on_linear_sync linear && echo yes || echo no)"`], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10000,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), "direct,flush-only,direct,direct,yes,no,no,no")
})

test("README and QUICKSTART describe the same peer backend set and per-project backend model", () => {
  const readme = read("README.md")
  const quickstart = read("docs/QUICKSTART.md")
  const readmeModelSection = readme.split("## Task Management Model")[1]?.split("## Features")[0] || ""
  const quickstartModelSection = quickstart.split("## Core Model")[1]?.split("## Daily Workflow")[0] || ""
  const readmeBackendLines = readmeModelSection.split("\n").filter(line => /^- `(?:tm|bd|br|tk|linear)`/.test(line.trim()))
  const quickstartBackendLines = quickstartModelSection.split("\n").filter(line => /^- `(?:tm|bd|br|tk|linear)`/.test(line.trim()))
  const expectedReadmeBackendLines = [
    "- `tm` = canonical user-facing task-management interface",
    "- `br` = Beads Rust, the current local tracker backend in this repo (SQLite+JSONL)",
    "- `bd` = legacy Beads backend, retained in migration guides",
    "- `tk` = Ticket, a git-backed markdown ticket workflow alternative",
    "- `linear` = Linear-native backend preview (core commands only on this repo branch)",
  ]
  const expectedQuickstartBackendLines = [
    "- `tm` = canonical user-facing interface",
    "- `br` = current backend in this repo (Beads Rust)",
    "- `bd` = legacy Beads backend, retained in migration guides",
    "- `tk` = Ticket / git-backed markdown alternative",
    "- `linear` = Linear-native backend preview (core commands only on this repo branch)",
  ]

  assert.match(readmeModelSection, /one backend selected per project/)
  assert.match(quickstartModelSection, /one backend per project/)
  assert.match(readmeModelSection, /bd` \/ `br` \/ `tk` \/ `linear/)
  assert.match(readmeModelSection, /`br` remains the active backend/)
  assert.match(quickstartModelSection, /`br` is the active backend/)
  assert.match(readmeModelSection, /not interchangeable day-to-day commands/)
  assert.match(quickstartModelSection, /not interchangeable day-to-day commands/)
  assert.doesNotMatch(quickstartModelSection, /fully supported backend/)
  assert.doesNotMatch(readmeModelSection, /are interchangeable day-to-day commands/)
  assert.deepEqual(readmeBackendLines, expectedReadmeBackendLines)
  assert.deepEqual(quickstartBackendLines, expectedQuickstartBackendLines)
})

test("README version badge matches the Claude plugin version", () => {
  const readme = read("README.md")
  const plugin = JSON.parse(read(".claude-plugin/plugin.json"))
  const badgeMatches = [...readme.matchAll(/version-([0-9]+\.[0-9]+\.[0-9]+)-green/g)].map(match => match[1])

  assert.deepEqual(badgeMatches, [plugin.version])
})
