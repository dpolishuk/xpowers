const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const repoRoot = path.resolve(__dirname, "..")
const agentsDir = path.join(repoRoot, "agents")

// Canonical tier mapping for all 16 Claude Code agents.
// This map is the single source of truth enforced by this guard test.
const AGENT_MODEL_TIERS = {
  // inherit: complex reasoning follows the parent session model
  planner: "inherit",
  "autonomous-reviewer": "inherit",
  "test-effectiveness-analyst": "inherit",
  ralph: "inherit",
  // sonnet: mid-complexity analysis at lower cost/latency than parent
  "code-reviewer": "sonnet",
  "security-scanner": "sonnet",
  devops: "sonnet",
  "knowledge-aggregator": "sonnet",
  "review-quality": "sonnet",
  "review-implementation": "sonnet",
  "review-testing": "sonnet",
  "review-simplification": "sonnet",
  // haiku: mechanical scanning/execution tasks
  "test-runner": "haiku",
  "codebase-investigator": "haiku",
  "internet-researcher": "haiku",
  "review-documentation": "haiku",
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null
  return match[1]
}

test("every agents/*.md has the expected canonical model tier in frontmatter", () => {
  const mismatches = []

  for (const [name, expectedTier] of Object.entries(AGENT_MODEL_TIERS)) {
    const fullPath = path.join(agentsDir, `${name}.md`)
    assert.ok(fs.existsSync(fullPath), `expected agents/${name}.md to exist`)

    const text = fs.readFileSync(fullPath, "utf8")
    const frontmatter = parseFrontmatter(text)
    assert.ok(frontmatter, `agents/${name}.md is missing frontmatter delimiters`)

    const match = frontmatter.match(/^model:\s*(sonnet|haiku|inherit)\s*$/m)
    if (!match) {
      mismatches.push(`${name}: no model: line matching /^(model:\\s*(sonnet|haiku|inherit)\\s*)$/ in frontmatter`)
      continue
    }

    const actualTier = match[1]
    if (actualTier !== expectedTier) {
      mismatches.push(`${name}: expected model: ${expectedTier}, found model: ${actualTier}`)
    }
  }

  assert.deepEqual(
    mismatches,
    [],
    `Agent model tier violations (fix agents/*.md frontmatter to match the canonical map in this test): ${mismatches.join("; ")}`,
  )
})

test("agents/ directory contains exactly the 16 agents in the canonical map", () => {
  const subdirs = fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  assert.deepEqual(subdirs, [], `unexpected subdirectory in agents/ (escapes the tier guard): ${subdirs.join(", ")}`)

  const files = fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md") && f !== "CLAUDE.md")
    .map((f) => f.replace(/\.md$/, ""))

  const expected = Object.keys(AGENT_MODEL_TIERS).sort()
  const actual = files.sort()

  const missing = expected.filter((name) => !actual.includes(name))
  const extra = actual.filter((name) => !expected.includes(name))

  assert.deepEqual(
    actual,
    expected,
    `agents/ file set does not match the canonical map. Missing: ${missing.join(", ") || "none"}. Unexpected: ${extra.join(", ") || "none"}.`,
  )
})

test("agents/*.md frontmatter uses only canonical tier aliases (no versioned IDs)", () => {
  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"))
  assert.ok(files.length > 0, "expected agent .md files in agents/")

  const violators = []
  for (const file of files) {
    const fullPath = path.join(agentsDir, file)
    const text = fs.readFileSync(fullPath, "utf8")
    const frontmatter = parseFrontmatter(text)
    if (!frontmatter) continue

    const modelLines = frontmatter.match(/^model:.*$/gm) ?? []
    if (modelLines.length > 1) {
      violators.push(`${file}: ${modelLines.length} model: lines (YAML last-wins would bypass the guard)`)
      continue
    }

    const match = frontmatter.match(/^model:\s*(\S+)\s*$/m)
    if (!match) continue

    const value = match[1]
    if (!/^(sonnet|haiku|inherit)$/.test(value)) {
      violators.push(`${file}: ${value}`)
    }
  }

  assert.deepEqual(
    violators,
    [],
    `These agent files use non-canonical model values in frontmatter (only tier aliases sonnet/haiku/inherit are allowed): ${violators.join(", ")}`,
  )
})
