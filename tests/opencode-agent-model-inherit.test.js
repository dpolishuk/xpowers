const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const repoRoot = path.resolve(__dirname, "..")
const opencodeAgentsDir = path.join(repoRoot, ".opencode", "agents")

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null
  return match[1]
}

test("no .opencode/agents/*.md contains model: inherit in frontmatter", () => {
  const files = fs.readdirSync(opencodeAgentsDir).filter((f) => f.endsWith(".md"))
  assert.ok(files.length > 0, "expected agent .md files in .opencode/agents/")

  const violators = []
  for (const file of files) {
    const fullPath = path.join(opencodeAgentsDir, file)
    const text = fs.readFileSync(fullPath, "utf8")
    const frontmatter = parseFrontmatter(text)
    if (!frontmatter) continue

    for (const line of frontmatter.split("\n")) {
      if (/^model:\s*inherit\s*$/.test(line)) {
        violators.push(file)
        break
      }
    }
  }

  assert.deepEqual(
    violators,
    [],
    `These OpenCode agent files have model: inherit (invalid on OpenCode — omit the model field instead): ${violators.join(", ")}`,
  )
})

test("no .opencode/agents/*.md frontmatter documents inherit as a valid option", () => {
  const files = fs.readdirSync(opencodeAgentsDir).filter((f) => f.endsWith(".md"))
  const violators = []

  for (const file of files) {
    const fullPath = path.join(opencodeAgentsDir, file)
    const text = fs.readFileSync(fullPath, "utf8")
    const frontmatter = parseFrontmatter(text)
    if (!frontmatter) continue

    for (const line of frontmatter.split("\n")) {
      if (/^#.*inherit/i.test(line)) {
        violators.push(file)
        break
      }
    }
  }

  assert.deepEqual(
    violators,
    [],
    `These files have frontmatter comments referencing inherit (misleading on OpenCode): ${violators.join(", ")}`,
  )
})
