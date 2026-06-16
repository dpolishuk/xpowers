const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const repoRoot = path.resolve(__dirname, "..")
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8")

test("README presents tm as the canonical task-management interface", () => {
  const readme = read("README.md")
  const modelSection = readme.split("## Task Management Model")[1]?.split("## Features")[0] || ""
  const exampleSection = readme.split("### Example Workflow")[1]?.split("## Philosophy")[0] || ""
  const codexSection = readme.split("<summary><strong>Codex CLI</strong></summary>")[1]?.split("</details>")[0] || ""

  assert.equal(modelSection.includes("canonical user-facing task-management interface"), true)
  assert.equal(modelSection.includes("tm-first"), true)
  assert.equal(modelSection.includes("bd` / `br` / `tk` / `linear`"), true)
  assert.equal(modelSection.includes("one backend selected per project"), true)
  assert.equal(exampleSection.includes("tasks in bd"), false)
  assert.equal(exampleSection.includes("bd ready"), false)
  assert.equal(exampleSection.includes("tm ready"), true)
  assert.equal(codexSection.includes("bd ready"), false)
  assert.equal(codexSection.includes("tm ready"), true)
})

test("AGENTS guide does not claim a conflicting bd-first docs model", () => {
  const agentsGuide = read("AGENTS.md")
  const commandsSection = agentsGuide.split("### Available Commands")[1]?.split("## Project Structure")[0] || ""
  const trackingSection = agentsGuide.split("## Task Management")[1] || ""

  assert.equal(agentsGuide.includes("uses **bd (beads)** for ALL issue tracking"), false)
  assert.equal(agentsGuide.includes("tm is the canonical user-facing interface"), true)
  assert.equal(agentsGuide.includes("current backend in this repo is `bd`"), true)
  assert.equal(agentsGuide.includes("use `bd` CLI"), false)
  assert.equal(commandsSection.includes("tm ready"), true)
  assert.equal(commandsSection.includes("tm show <id>"), true)
  assert.equal(commandsSection.includes("tm update <id> --status in_progress"), true)
  assert.equal(commandsSection.includes("tm close <id>"), true)
  assert.equal(commandsSection.includes("tm sync"), true)
  assert.equal(trackingSection.includes("docs/QUICKSTART.md"), true)
})

test("Docs index surfaces the canonical tm setup and integration guides", () => {
  const docsReadme = read("docs/README.md")
  const quickstart = read("docs/QUICKSTART.md")

  assert.equal(docsReadme.includes("tm-first"), true)
  assert.equal(docsReadme.includes("linear-mcp-setup.md"), true)
  assert.equal(docsReadme.includes("QUICKSTART.md"), true)
  assert.equal(docsReadme.includes("backend"), true)
  assert.equal(quickstart.includes("tm ready"), true)
  assert.equal(quickstart.includes("tm show <id>"), true)
  assert.equal(quickstart.includes("tm update <id> --status in_progress"), true)
  assert.equal(quickstart.includes("tm close <id>"), true)
  assert.equal(quickstart.includes("tm sync"), true)
  assert.equal(quickstart.includes("bd ready"), false)
  assert.equal(quickstart.includes("backend-specific setup"), true)
  assert.equal(quickstart.includes("one backend per project"), true)
  assert.equal(quickstart.includes("one backend selected per project"), false)
})

test("README first-pass classifies bd br and tk with distinct roles", () => {
  const readme = read("README.md")

  assert.equal(readme.includes("`bd` = current local tracker backend in this repo"), true)
  assert.equal(readme.includes("`br` = Beads Rust"), true)
  assert.equal(readme.includes("`tk` = Ticket"), true)
  assert.equal(readme.includes("`linear` = Linear-native backend preview"), true)
  assert.equal(readme.includes("not interchangeable day-to-day commands"), true)
  assert.equal(readme.includes("`tm` = canonical user-facing task-management interface"), true)
})

test("docs distinguish tm-first project work from explicit ralph-tui beads-rust workflows", () => {
  const readme = read("README.md")
  const agentsGuide = read("AGENTS.md")

  for (const content of [readme, agentsGuide]) {
    assert.equal(content.includes("ralph-tui"), true)
    assert.equal(content.includes("beads-rust"), true)
    assert.equal(content.includes("use `tm`"), true)
    assert.equal(content.includes("unless the user explicitly asks"), true)
  }
})

test("README and AGENTS agree on Codex wrapper location and host support", () => {
  const readme = read("README.md")
  const agentsGuide = read("AGENTS.md")
  const codexSection = readme.split("<summary><strong>Codex CLI</strong></summary>")[1]?.split("</details>")[0] || ""

  assert.equal(readme.includes("Claude Code, OpenCode, Gemini CLI, Kimi Code CLI, Kimi CLI, and Codex CLI"), true)
  assert.equal(readme.includes("Generated output is written to `.agents/skills`"), true)
  assert.equal(readme.includes(".kimi/skills"), false)
  assert.equal(agentsGuide.includes(".agents/               # Codex-compatible generated wrappers"), true)
  assert.equal(agentsGuide.includes("supports multiple developer hosts (Claude Code, OpenCode, Gemini CLI, Kimi Code CLI, Kimi CLI, Codex CLI, and Pi)"), true)
  assert.equal(codexSection.includes("./scripts/install.sh --codex"), true)
  assert.equal(codexSection.includes("~/.codex/skills"), true)
})

test("README points Kimi users to the correct install guide", () => {
  const readme = read("README.md")

  assert.equal(readme.includes("See [Installation](#installation) for OpenCode, Gemini CLI, Kimi CLI, and Codex CLI."), false)
  assert.equal(readme.includes(".kimi/INSTALL.md"), true)
})

test("Docs index surfaces model configuration guide", () => {
  const docsReadme = read("docs/README.md")
  const guidesSection = docsReadme.split("## Core Setup & Workflow Guides")[1]?.split("## Backend / Tracker Context")[0] || ""
  const hostGuidesSection = docsReadme.split("## Host-Specific Install Guides")[1]?.split("## Backend / Tracker Context")[0] || ""

  assert.equal(guidesSection.includes("model-configuration.md"), true)
  assert.equal(hostGuidesSection.includes(".kimi-code/INSTALL.md"), true)
  assert.equal(hostGuidesSection.includes(".kimi/INSTALL.md"), true)
  assert.equal(hostGuidesSection.includes(".codex/INSTALL.md"), true)
  assert.equal(docsReadme.includes("one backend per project"), true)
  assert.equal(docsReadme.includes("one backend selected per project"), false)
})

test("Kimi and Codex host docs stay tm-first", () => {
  const kimiInstall = read(".kimi/INSTALL.md")
  const kimiSystem = read(".kimi/xpowers-system.md")
  const codexInstall = read(".codex/INSTALL.md")

  assert.equal(kimiInstall.includes("bd ready"), false)
  assert.equal(kimiInstall.includes("tm ready"), true)
  assert.equal(kimiInstall.includes("tm close"), true)
  assert.equal(kimiInstall.includes("tm sync"), true)

  assert.equal(kimiSystem.includes("bd ready"), false)
  assert.equal(kimiSystem.includes("bd sync"), false)
  assert.equal(kimiSystem.includes("bd epics"), false)
  assert.equal(kimiSystem.includes("bd tasks"), false)
  assert.equal(kimiSystem.includes("tm ready"), true)
  assert.equal(kimiSystem.includes("tm sync"), true)
  assert.equal(kimiSystem.includes("tm update <id> --status in_progress"), true)
  assert.equal(kimiSystem.includes("--status=in_progress"), false)

  assert.equal(codexInstall.includes("bd ready"), false)
  assert.equal(codexInstall.includes("tm ready"), true)
})

test("Agent workflow docs use backend-portable tm design updates", () => {
  const checkedPaths = [
    "skills/fixing-bugs/SKILL.md",
    "skills/refactoring-safely/SKILL.md",
    "skills/managing-bd-tasks/SKILL.md",
    ".kimi/skills/fixing-bugs/SKILL.md",
    ".kimi/skills/refactoring-safely/SKILL.md",
    ".kimi/skills/managing-bd-tasks/SKILL.md",
    ".opencode/skills/xpowers-fixing-bugs/SKILL.md",
    ".opencode/skills/xpowers-refactoring-safely/SKILL.md",
    ".opencode/skills/xpowers-managing-bd-tasks/SKILL.md",
    ".agents/skills/fixing-bugs/SKILL.md",
    ".agents/skills/refactoring-safely/SKILL.md",
    ".agents/skills/managing-bd-tasks/SKILL.md",
  ]

  for (const relativePath of checkedPaths) {
    const content = read(relativePath)
    assert.equal(content.includes("tm edit "), false, `${relativePath} must not use backend-specific tm edit`)
    assert.equal(content.includes("bd edit "), false, `${relativePath} must not use direct bd edit`)
  }

  assert.match(read("skills/fixing-bugs/SKILL.md"), /tm update \S+ --design/)
})

test("Kimi install docs describe the linear preview contract and agent paths consistently", () => {
  const readme = read("README.md")
  const kimiInstall = read(".kimi/INSTALL.md")
  const kimiHostSection = readme.split("<summary><strong>Kimi CLI</strong></summary>")[1]?.split("</details>")[0] || ""

  assert.equal(kimiHostSection.includes(".kimi/INSTALL.md"), true)
  assert.equal(kimiInstall.includes("TM_BACKEND=linear"), true)
  assert.equal(kimiInstall.includes("preview backend command surface"), true)
  assert.equal(kimiInstall.includes("separate integration-oriented workflow"), true)
  assert.equal(kimiInstall.includes("not yet implemented on this repo branch"), false)
  assert.equal(kimiInstall.includes("Located in `~/.config/agents/agents/`"), true)
})

test("AGENTS and linear MCP docs reflect tm-first backend guidance", () => {
  const agentsGuide = read("AGENTS.md")
  const linearMcpSetup = read("docs/linear-mcp-setup.md")

  assert.equal(agentsGuide.includes("backend-specific guide explicitly calls for `bd`, `br`, `tk`, or `linear`"), true)
  assert.equal(linearMcpSetup.includes("Writes to bd locally"), false)
  assert.equal(linearMcpSetup.includes("Reads from bd (fast, offline)"), false)
  assert.equal(linearMcpSetup.includes("selected tm backend"), true)
})
