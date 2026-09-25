# Agent Instructions

This document provides essential information for AI coding agents working with the XPowers project.

## Project Overview

**XPowers** supports multiple developer hosts (Claude Code, OpenCode, Gemini CLI, Kimi Code CLI, Kimi CLI, Codex CLI, and Pi), providing structured workflows, best practices, and specialized agents for software development. Think of it as a pair programming partner that ensures proven development patterns are followed.

### Key Components

1. **Skills** (`skills/*/SKILL.md`) - Reusable workflow definitions for common development tasks
2. **Agents** (`agents/*.md`) - Specialized subagent prompts for domain-specific tasks
3. **Commands** (`commands/*.md`) - Slash command definitions for quick workflow access
4. **Hooks** (`hooks/`) - Automatic behaviors triggered by IDE events
5. **Plugins** (`.gemini-extension/`, `.opencode/plugins/`, `.claude-plugin/`) - Platform-specific plugin implementations

### Technology Stack

- **Runtime**: Node.js/Bun for OpenCode plugins and the Gemini extension MCP servers (TypeScript)
- **Hooks**: Bash, Python, JavaScript
- **Tests**: Node.js built-in test runner
- **Task Management**: **tm** as the canonical interface, currently backed by **bd** in this repo
- **Package Manager**: Bun (for OpenCode), npm (for published plugin), npm/pip (for Gemini tools)
- **Configuration**: JSON, YAML

## Quick Start

### Prerequisites

- Install **tm** support via this repo’s setup flow; note that the current backend in this repo is `bd`
- Install **Bun** for OpenCode plugin development
- Node.js for running tests

### Available Commands

```bash
# Task management (tm-first)
tm ready                    # Find available work
tm show <id>                # View issue details
tm update <id> --status in_progress   # Claim work
tm close <id>               # Complete work
tm sync                     # Sync local work and optional integrations

# Testing
node --test tests/*.test.js # Run Node.js tests

# Codex skill wrapper sync
node scripts/sync-codex-skills.js --write  # Regenerate codex-* wrappers
node scripts/sync-codex-skills.js --check  # Verify wrappers are in sync

# OpenCode plugin (in .opencode/ directory)
cd .opencode               # from repo root
bun install                # Install dependencies
bun run build             # Build TypeScript
bun run typecheck         # Type-check without emitting

# Gemini extension (in .gemini-extension/ directory)
cd ../.gemini-extension
python3 -m pip --version >/dev/null 2>&1 || true  # Optional: ensure CLI deps are present

```

## Project Structure

```
.
├── agents/                 # 16 specialized subagent prompts
│   ├── planner.md          # Architecture decomposition + task graphs (opus)
│   ├── security-scanner.md # OWASP, secrets, CVE scanning (read-only)
│   ├── devops.md           # CI/CD pipeline analysis and diagnosis
│   ├── knowledge-aggregator.md  # MCP-aware context aggregation
│   ├── ralph.md            # YOLO mode autonomous executor
│   ├── test-runner.md      # Runs tests without context pollution
│   ├── code-reviewer.md    # Human-facing reviews against plans
│   ├── codebase-investigator.md  # Understands codebase state
│   ├── internet-researcher.md    # Researches APIs and libraries
│   └── review-*.md         # 5 parallel review agents + autonomous-reviewer
├── commands/              # Slash command definitions
│   ├── brainstorm.md
│   ├── write-plan.md
│   ├── execute-plan.md
│   └── *.md
├── skills/                # Reusable workflow definitions
│   ├── using-hyper/       # Meta-skill loaded at session start
│   ├── brainstorming/     # Interactive design refinement
│   ├── test-driven-development/   # RED-GREEN-REFACTOR cycle
│   ├── writing-plans/     # Create detailed implementation plans
│   ├── executing-plans/   # Execute tasks iteratively
│   ├── fixing-bugs/       # Complete bug fix workflow
│   ├── refactoring-safely/# Test-preserving transformations
│   └── */SKILL.md         # 24+ skills total
├── hooks/                 # Automatic behaviors
│   ├── session-start.sh   # Runs at session start
│   ├── user-prompt-submit/# Skill activation on prompts
│   ├── pre-tool-use/      # Blocks dangerous operations
│   ├── post-tool-use/     # Tracks edits, blocks truncation
│   └── stop/              # Gentle reminders at session end
├── .opencode/             # OpenCode-specific files
│   ├── plugins/           # TypeScript plugins
│   ├── agents/            # OpenCode agent definitions
│   ├── commands/          # OpenCode command definitions
│   ├── skills/            # Symlinked to ../skills
│   └── package.json       # Bun dependencies
├── .gemini-extension/      # Gemini CLI extension files
│   ├── agents/            # Gemini agent definitions
│   ├── commands/          # Gemini command definitions
│   ├── mcp/               # MCP servers for Gemini tools
│   └── tests/             # Extension-focused tests
├── .kimi-code/            # Kimi Code CLI-specific files
│   ├── skills/            # Kimi Code skill definitions
│   ├── AGENTS.md          # Kimi Code guidance
│   └── INSTALL.md         # Kimi Code install instructions
├── .agents/               # Codex-compatible generated wrappers (skills)
│   └── skills/            # Generated codex-* SKILL.md directories
├── .claude-plugin/        # Claude Code plugin metadata
│   └── plugin.json
├── tests/                 # Test files
├── docs/                  # Documentation and example configs
├── scripts/               # Installation scripts
└── .beads/               # beads issue tracking config
```

## Skills System

### Skill Structure

Each skill is a directory containing `SKILL.md` with YAML frontmatter:

```yaml
---
name: skill-name
description: Use when... - clear trigger condition
---

<skill_overview>Brief description</skill_overview>
<rigidity_level>HIGH/LOW FREEDOM</rigidity_level>
<when_to_use>Conditions for using this skill</when_to_use>
<the_process>Step-by-step instructions</the_process>
<examples>Real-world scenarios</examples>
<critical_rules>Non-negotiable rules</critical_rules>
<verification_checklist>Before completing</verification_checklist>
```

### Mandatory Skills

These skills are **mandatory** when applicable:

1. **using-hyper** - Check before EVERY task
2. **brainstorming** - Before writing code
3. **writing-plans** - Create detailed implementation plans
4. **test-driven-development** - RED-GREEN-REFACTOR cycle
5. **verification-before-completion** - Evidence before claims

### Skill Usage Protocol

```
1. List available skills mentally
2. Ask: "Does ANY skill match this request?"
3. If yes → Use Skill tool to load the skill file
4. Announce: "I'm using [skill-name] to [action]"
5. Follow the skill exactly
```

## Agents System

16 specialized agents organized in 6 categories, invoked via `Task` tool:

| Agent | Category | Purpose | Recommended Model |
|-------|----------|---------|-------------------|
| `planner` | Plan | Architecture decomposition + task graphs | Most capable (opus) |
| `codebase-investigator` | Research | Understand codebase state | Fast (haiku) |
| `internet-researcher` | Research | Research APIs/libraries | Fast (haiku) |
| `knowledge-aggregator` | Research | Aggregate docs, issues, team comms via MCP | Capable (sonnet) |
| `ralph` | Execute | YOLO mode autonomous executor | Inherit |
| `security-scanner` | Guard | OWASP, secrets, CVE scanning (read-only) | Capable (sonnet) |
| `devops` | Guard | CI/CD pipeline analysis and diagnosis | Capable (sonnet) |
| `code-reviewer` | Review | Human-facing reviews with detailed explanations | Capable (sonnet) |
| `autonomous-reviewer` | Review | Machine-facing verdict-only reviews | Most capable (opus) |
| `review-implementation` | Review | Spec-focused requirements alignment | Capable (sonnet) |
| `review-quality` | Review | Bugs, race conditions, error handling | Capable (sonnet) |
| `review-testing` | Review | Test coverage and quality | Capable (sonnet) |
| `review-simplification` | Review | Over-engineering detection | Capable (sonnet) |
| `review-documentation` | Review | Documentation completeness | Capable (sonnet) |
| `test-runner` | Worker | Run tests without context pollution | Fast (haiku) |
| `test-effectiveness-analyst` | Worker | Audit test quality with SRE scrutiny | Capable (sonnet) |

## Hooks System

Hooks provide automatic, context-aware assistance:

### SessionStart
- Loads `using-hyper` skill automatically
- Initializes context tracking

### UserPromptSubmit
- Analyzes prompts against `hooks/skill-rules.json`
- Suggests relevant skills and agents

### PreToolUse (Blocking)
- **block-beads-direct-read.py** - Blocks direct Read/Grep of `.beads/issues.jsonl`
- **01-block-pre-commit-edits.py** - Blocks edits to `.git/hooks/pre-commit`
- **block-dangerous-bash.py** - Blocks destructive Bash commands (rm -rf, sudo, curl | bash, etc.)
- **block-env-writes.py** - Blocks writes to secret files (.env, .pem, id_rsa, .key)

### PostToolUse (Blocking)
- **01-track-edits.sh** - Tracks file edits for context awareness
- **02-block-bd-truncation.py** - Blocks bd commands with truncation markers
- **03-block-pre-commit-bash.py** - Blocks Bash modifications to pre-commit hooks
- **04-block-pre-existing-checks.py** - Blocks git checkout for error investigation

### Stop
- **10-gentle-reminders.sh** - TDD, verification, and commit reminders

## Testing

### Running Tests

```bash
# Run all tests
node --test tests/*.test.js

# Run specific test file
node --test tests/cass-memory.test.js
```

### Test Structure

Tests use Node.js built-in test runner:

```javascript
const test = require("node:test")
const assert = require("node:assert/strict")

test("description", () => {
  assert.equal(actual, expected)
})
```

## Code Style Guidelines

### General

- Follow existing patterns in the codebase
- Use clear, descriptive names
- Keep functions focused and small
- Add comments for complex logic

### Skills (SKILL.md files)

- Use YAML frontmatter with `name` and `description`
- Description must be at least 20 characters
- Name must match directory name
- Use lowercase with hyphens for skill names
- Include all standard sections (overview, rigidity, process, examples, rules)

### Agents (*.md files)

- Use YAML frontmatter with `name`, `description`, and `model`
- Description should include usage examples in `<example>` tags
- Omit `model` to inherit natively (OpenCode); use `model: inherit` only in Claude Code agent files

### Hooks

- Python hooks: Check for truncation patterns, return blocking decisions
- Bash hooks: Log to `hooks/context/`, handle errors silently
- JavaScript hooks: Parse stdin JSON, output JSON to stdout

## Task Management

tm is the canonical user-facing interface in this repo. The current backend in this repo is `bd`, so some backend-specific maintenance and migration details still reference beads directly.

### Workflow

1. **Find work**: `tm ready`
2. **Claim work**: `tm update <id> --status in_progress`
3. **Complete work**: `tm close <id>`
4. **Sync**: `tm sync`

### Backend Notes

- `bd` = current backend in this repo
- `br` = Beads Rust / classic beads-compatible alternative
- `tk` = Ticket / git-backed markdown ticket workflow alternative
- `linear` = Linear-native backend preview (core commands only on this repo branch)

These tools are related, but they are **not interchangeable day-to-day commands**. Use `tm` for the canonical workflow with **one backend selected per project** unless a guide explicitly calls for backend-specific behavior.

### Backend Configuration

Located in `.beads/config.yaml`. Key settings:
- `sync-branch`: Git branch for beads commits
- `no-db`: Use JSONL instead of SQLite
- `auto-start-daemon`: Start daemon automatically

**NEVER** read `.beads/issues.jsonl` directly - always use `tm` (or a backend CLI only when a backend-specific guide explicitly requires it).

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   tm sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

## Platform-Specific Notes

### Claude Code

- Plugin defined in `.claude-plugin/plugin.json`
- Skills loaded from `skills/` directory
- Agents loaded from `agents/` directory
- Commands registered via slash commands
- Hooks defined in `hooks/hooks.json`

### OpenCode

- Plugin files in `.opencode/` directory
- TypeScript plugins in `.opencode/plugins/`
- Skills symlinked from `.opencode/skills/` to `../skills/`
- Agents in `.opencode/agents/`
- Config in `opencode.json`

## Development Workflow

### Adding a New Skill

1. Create directory: `mkdir skills/my-skill`
2. Add `SKILL.md` with proper frontmatter
3. Test with subagent before deployment
4. Update skill-rules.json if needed
5. Run tests to verify

### Adding a New Hook

1. Create hook file in appropriate subdirectory
2. Add entry to `hooks/hooks.json`
3. Test hook manually
4. Update HOOKS.md with documentation

### Adding a New Agent

1. Create `agents/my-agent.md` (Claude Code) or `.opencode/agents/my-agent.md` (OpenCode)
2. Add YAML frontmatter with name, description, model
3. Include detailed instructions in body
4. Test with Task tool

### Updating Codex Wrappers

When changing `skills/*/SKILL.md`, `commands/*.md`, or `agents/*.md`:

1. Regenerate wrappers: `node scripts/sync-codex-skills.js --write`
2. Verify no drift: `node scripts/sync-codex-skills.js --check`
3. Commit generated `codex-*` wrapper updates together with source changes

Description quality checks are enforced by the sync tool:
- At least 20 characters and 5 words
- Must include trigger/boundary language (for example: `use when`, `use to`, `if`, `before`, `after`, `do not`)
- Vague wording (`helper`, `generic`, `misc`, `stuff`, etc.) fails the sync

Do not hand-edit generated `codex-*` directories directly.

## Security Considerations

- **NEVER** expose API keys in code - use `{env:VAR_NAME}` pattern
- **NEVER** read `.beads/issues.jsonl` directly - use `tm` (or a backend CLI only when a backend-specific guide explicitly requires it)
- **NEVER** modify `.git/hooks/pre-commit` directly
- Hooks block dangerous operations automatically
- Sensitive files are protected by safety plugins

## Resources

- **README.md** - User-facing documentation
- **CLAUDE.md** - Claude Code-specific guidance
- **HOOKS.md** - Detailed hooks documentation
- **docs/** - Example configurations
- **.beads/config.yaml** - beads configuration reference

<!-- BEGIN BEADS INTEGRATION -->
## Task Tracking

**IMPORTANT**: tm is the canonical user-facing interface in this repo. The current backend in this repo is `bd`, so some backend-specific maintenance and migration details still reference beads directly. Do NOT create markdown TODO lists or alternate tracking systems.

### Why tm first?

- Stable day-to-day interface for users and agents
- Keeps backend details (`bd`, `br`, `tk`) from leaking into every workflow doc
- Supports integration-oriented workflows such as `tm sync`
- Prevents split-brain documentation across hosts and guides

### Quick Start

**Check for ready work:**

```bash
tm ready
```

**Create new issues:**

```bash
tm create "Issue title" --type task --priority 2 --design "Detailed context"
tm create "Issue title" --type feature --priority 1 --design "What this issue is about"
```

**Claim and update:**

```bash
tm update <id> --status in_progress
tm update bd-42 --priority 1
```

**Complete work:**

```bash
tm close bd-42
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Backend Notes

- `bd` = current backend in this repo
- `br` = Beads Rust / classic beads-compatible alternative
- `tk` = Ticket / git-backed markdown ticket workflow alternative
- `linear` = Linear-native backend preview (core commands only on this repo branch)

These tools are related, but they are **not interchangeable day-to-day commands**. Use `tm` for canonical workflow guidance with **one backend selected per project** unless a backend-specific guide explicitly calls for `bd`, `br`, `tk`, or `linear`.

Global ralph-tui skills may explicitly use beads-rust (`br`) to create `ralph-tui` task sources. That is a separate backend-specific workflow; inside this XPowers repo, use `tm` for project task tracking unless the user explicitly asks for `ralph-tui`, `beads-rust`, or `br` task-source generation.

### Workflow for AI Agents

1. **Check ready work**: `tm ready` shows unblocked issues
2. **Claim your task**: `tm update <id> --status in_progress`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue through `tm create ...`
5. **Complete**: `tm close <id>`

### Sync Notes

- `tm sync` is the canonical sync command in repo-facing docs
- backend-specific sync details should only appear in backend-specific guides
- use direct backend commands only when a maintenance or migration workflow explicitly requires them

### Important Rules

- ✅ Use `tm` for canonical task-tracking workflows
- ✅ Use backend-specific commands only when a backend-specific guide explicitly requires them
- ✅ Link discovered work with `discovered-from` dependencies where supported by the active backend
- ✅ Check `tm ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

<!-- END BEADS INTEGRATION -->
