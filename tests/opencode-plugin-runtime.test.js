const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

test("OpenCode plugins execute against SDK-shaped runtime hooks", { timeout: 60000 }, () => {
  const result = spawnSync("bun", ["test", "tests/opencode-plugin-runtime.test.ts"], {
    cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 55000,
  })
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`)
})
