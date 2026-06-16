const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const repoRoot = path.resolve(__dirname, "..")

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"))

const listSkillDirs = (skillsRoot) => {
  if (!fs.existsSync(skillsRoot)) return []
  return fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

test("kimi.plugin.json exists and is valid", () => {
  const manifestPath = path.join(repoRoot, "kimi.plugin.json")
  assert.equal(fs.existsSync(manifestPath), true, "kimi.plugin.json should exist")
  const manifest = readJson(manifestPath)
  assert.equal(manifest.name, "xpowers")
  assert.ok(manifest.version, "version should be present")
  assert.ok(manifest.description, "description should be present")
  assert.ok(manifest.skills, "skills path should be present")
})

test("kimi.plugin.json skills path resolves inside repo", () => {
  const manifest = readJson(path.join(repoRoot, "kimi.plugin.json"))
  const skillsPath = manifest.skills
  assert.ok(skillsPath.startsWith("./"), "skills path should be relative")
  const resolved = path.resolve(repoRoot, skillsPath)
  assert.ok(
    resolved === repoRoot || resolved.startsWith(`${repoRoot}${path.sep}`),
    "skills path should be inside repo root",
  )
  assert.ok(fs.existsSync(resolved), `skills directory should exist: ${resolved}`)
})

test(".kimi-code/skills/ contains expected skills with SKILL.md", () => {
  const skillsRoot = path.join(repoRoot, ".kimi-code", "skills")
  assert.ok(fs.existsSync(skillsRoot), ".kimi-code/skills/ should exist")
  const dirs = listSkillDirs(skillsRoot)
  assert.ok(dirs.length >= 20, `expected at least 20 skills, found ${dirs.length}`)
  for (const dir of dirs) {
    const skillFile = path.join(skillsRoot, dir, "SKILL.md")
    assert.ok(fs.existsSync(skillFile), `SKILL.md missing for ${dir}`)
  }
})

test(".kimi-code/skills/ contains no codex-* directories", () => {
  const skillsRoot = path.join(repoRoot, ".kimi-code", "skills")
  const dirs = listSkillDirs(skillsRoot)
  const codexDirs = dirs.filter((name) => name.startsWith("codex-"))
  assert.deepEqual(codexDirs, [], `found codex-* directories: ${codexDirs.join(", ")}`)
})

test("kimi.plugin.json mcpServers.context7 matches .kimi/mcp.json", () => {
  const manifest = readJson(path.join(repoRoot, "kimi.plugin.json"))
  const legacyMcp = readJson(path.join(repoRoot, ".kimi", "mcp.json"))
  assert.deepEqual(
    manifest.mcpServers?.context7,
    legacyMcp.mcpServers?.context7,
    "context7 MCP server config should match .kimi/mcp.json",
  )
})

test(".kimi-code/AGENTS.md exists and mentions XPowers", () => {
  const agentsMd = path.join(repoRoot, ".kimi-code", "AGENTS.md")
  assert.ok(fs.existsSync(agentsMd), ".kimi-code/AGENTS.md should exist")
  const content = fs.readFileSync(agentsMd, "utf8")
  assert.ok(content.includes("XPowers"), "AGENTS.md should mention XPowers")
  assert.ok(content.includes("tm-first"), "AGENTS.md should mention tm-first workflow")
})
