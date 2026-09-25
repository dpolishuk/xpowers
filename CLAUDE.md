# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

XPowers is a multi-host plugin for Claude Code, OpenCode, and Gemini CLI that provides structured workflows, best practices, and specialized agents for software development. It's a plugin system that adds skills (reusable workflows), slash commands (quick access to workflows), specialized agents (domain-specific task handlers), and hooks (automatic behaviors).

Inspired by [obra/superpowers](https://github.com/obra/superpowers).

## CRITICAL: Understanding User Requests in This Repository

**This is a plugin development project.** Your task is to improve the plugin (skills, hooks, agents, commands), NOT to debug the user's other projects.

### Common Pattern: Examples from Other Sessions

The user will frequently describe issues like:
- "Claude did X in another session and it was wrong"
- "I got this error: [some error from another project]"
- "Claude truncated the bd task and that caused problems"
- "Claude edited .git/hooks/pre-commit with sed"

**CRITICAL - These are NOT problems for you to investigate or debug.**

### What These Examples Actually Mean

When the user describes an issue from another session, they are:
1. **Providing evidence** of a pattern where Claude behaves incorrectly
2. **Requesting plugin improvements** to prevent that pattern
3. **NOT asking you** to fix those specific historical errors

### The Correct Response Pattern

**Bad response (trying to fix the other session):**
```
Let me investigate that error. Can you show me the file where the truncation occurred?
Let me check the bd task that was created. What was the full command?
```

**Good response (improving the plugin):**
```
This is a pattern we can prevent with a hook. Let me create a PostToolUse hook
that blocks bd commands containing truncation markers.
```

### Translation Guide

| What user says | What they actually want |
|----------------|------------------------|
| "Claude truncated the bd task" | Create hook to block bd truncation |
| "Claude edited pre-commit with sed" | Create hook to block pre-commit modifications |
| "The test-runner agent didn't activate" | Improve skill-rules.json triggers |
| "Claude ignored the skill" | Improve skill description or add hook |
| "This caused incomplete implementation" | Add blocking hook to prevent pattern |

### Your Goal in This Repository

**Always:** Improve the plugin to prevent bad patterns
**Never:** Try to investigate or fix issues from other sessions

You cannot access other sessions. You cannot fix past problems. You CAN prevent those problems from happening again by improving skills, hooks, agents, and commands in THIS repository.

### Examples of Correct Responses

**User:** "Claude edited .git/hooks/pre-commit with `sed -i` to work around an error"

**Correct response:**
- Create PreToolUse hook blocking Edit/Write to pre-commit
- Create PostToolUse hook blocking Bash commands modifying pre-commit
- Update HOOKS.md with documentation

**User:** "The bd task had '[Remaining steps truncated]' which caused incomplete implementation"

**Correct response:**
- Create PostToolUse hook blocking tm create/update with truncation markers
- Add regex patterns for all truncation variations
- Test hook with sample commands

**User:** "Claude ran `./scripts/docker-test.sh` with 700+ lines of output and didn't suggest test-runner agent"

**Correct response:**
- Add test script patterns to skill-rules.json
- Add keywords like "npm test", "pytest", test runner names
- Test activation with sample prompts

## Plugin Structure

The repository is organized as follows:

- **skills/** - Reusable workflow definitions (each in its own directory with SKILL.md)
- **commands/** - Slash command definitions that invoke skills
- **agents/** - Specialized subagent prompts (16 agents across 6 categories: research, plan, execute, guard, review, worker)
- **hooks/** - Automatic behaviors triggered by events
- **.claude-plugin/** - Plugin metadata (plugin.json)

## Key Architecture Concepts

### Skills System

Skills are detailed workflow instructions stored in `skills/*/SKILL.md`. Each skill follows a specific pattern:

1. **Frontmatter** - YAML metadata (name, description)
2. **Overview** - Core principle and context
3. **The Process** - Step-by-step workflow with exact commands
4. **Common Rationalizations** - Mistakes to avoid
5. **Red Flags** - Anti-patterns to prevent
6. **Integration** - How this skill calls/is called by others

**Critical distinction:**
- Some skills are **rigid processes** (TDD, verification) - follow exactly, no adaptation
- Some skills are **flexible patterns** (architecture, naming) - adapt principles to context
- The skill itself tells you which type it is

### Skill Invocation Pattern

Skills are invoked through slash commands that expand to prompts. The flow is:

1. User types `/xpowers:write-plan`
2. Command file (`commands/write-plan.md`) expands with instruction: "Use the writing-plans skill exactly as written"
3. Claude uses the Skill tool to load `skills/writing-plans/SKILL.md`
4. Claude follows the skill's detailed instructions

### tm Integration

Many skills integrate with `tm` (a task management tool). The workflows expect:

- **Epics** - High-level features/initiatives (created by writing-plans)
- **Tasks** - Specific implementation steps (created by writing-plans, executed by executing-plans)
- **Dependencies** - Task relationships (blocking, parent-child)
- **Status tracking** - Open, in-progress, done, ready

Common tm commands:
```bash
tm list --type epic --status open       # Find open epics
tm ready                                 # Show ready tasks
tm show bd-1                            # Show task details
tm dep tree bd-1                        # Show task tree
tm update bd-3 --status in_progress      # Update task status
```

### Agent System

16 specialized agents organized in 6 categories, each running in separate contexts:

**Research (3):**
1. **codebase-investigator** (haiku) - Explores codebase state and patterns when planning/designing
2. **internet-researcher** (haiku) - Researches APIs, libraries, docs when planning/designing
3. **knowledge-aggregator** (sonnet) - Aggregates context from docs, issue trackers, and team communications via MCP

**Plan (1):**
4. **planner** (inherit) - Decomposes goals into architecture diagrams, file change maps, and task dependency graphs

**Execute (1):**
5. **ralph** (inherit) - YOLO mode autonomous executor using smart triage for task selection

**Guard (2):**
6. **security-scanner** (sonnet) - OWASP Top 10 scanning, secrets detection, dependency vulnerability checks (read-only)
7. **devops** (sonnet) - CI/CD pipeline analysis, pre-commit hook review, build config diagnostics

**Review (7):**
8. **code-reviewer** (sonnet) - Human-facing reviews with detailed explanations
9. **autonomous-reviewer** (inherit) - Machine-facing verdict-only reviews for automated pipelines
10. **review-implementation** (sonnet) - Spec-focused requirements alignment verification
11. **review-testing** (sonnet) - Test coverage and quality evaluation
12. **review-quality** (sonnet) - Bug detection, race conditions, error handling gaps
13. **review-simplification** (sonnet) - Over-engineering and unnecessary complexity detection
14. **review-documentation** (haiku) - Documentation completeness checks

**Worker (2):**
15. **test-runner** (haiku) - Runs tests/hooks/commits, returns only summary + failures to keep context clean
16. **test-effectiveness-analyst** (inherit) - Audits test quality with SRE scrutiny

**Critical pattern:** Agents keep verbose output (test results, formatting diffs) in their own context, returning only essential info to the main conversation.

### Common Patterns Location

To avoid duplication, common elements are centralized in `skills/common-patterns/`:

- `bd-commands.md` - Standard bd command examples
- `common-anti-patterns.md` - Anti-patterns to avoid
- `common-rationalizations.md` - Excuses that signal failure

Skills reference these rather than duplicating content.

## Core Workflows

### Feature Development (Greenfield)

Complete workflow from idea to PR:

1. **Brainstorming** (`/xpowers:brainstorm`) - Socratic questioning to refine requirements
2. **SRE Task Refinement** (optional) - Uses Opus 4.1 to identify corner cases
3. **Writing Plans** (`/xpowers:write-plan`) - Creates detailed bd epic with tasks
4. **Executing Plans** (`/xpowers:execute-plan`) - Implements tasks continuously, updating bd
5. **Review Implementation** (`/xpowers:review-implementation`) - Verifies against spec
6. **Finishing Branch** - Creates PR, handles cleanup

### Test-Driven Development

Required for most implementation work:

1. Write test first (RED phase)
2. Watch test fail (verifies test actually tests something)
3. Write minimal code to pass (GREEN phase)
4. Refactor while keeping tests green
5. Commit

The `test-driven-development` skill enforces this rigorously.

### Bug Fixing & Debugging

Complete workflow for fixing bugs systematically:

1. **Create bd Bug Issue** - Track the bug with reproduction steps
2. **Debugging with Tools** - Use debuggers, internet-researcher, codebase-investigator to find root cause
3. **Write Failing Test** (RED phase) - Reproduce the bug in a test
4. **Implement Fix** (GREEN phase) - Minimal fix addressing root cause
5. **Verify** - Run full test suite via test-runner agent, check for regressions
6. **Close bd Issue** - Document fix and close

**Key Skills:**
- `debugging-with-tools` - Systematic investigation using debuggers, internet research, and agents
- `root-cause-tracing` - Trace backward through call stack to find original trigger
- `fixing-bugs` - Complete workflow from bug discovery to closure

**Critical:** Always use debugger and internet-researcher BEFORE attempting fixes. Never fix symptoms.

### Verification Pattern

Before claiming any work is complete:

1. Run verification commands (tests, lints, builds)
2. Capture output as evidence
3. Only claim success if verification passes
4. Use test-runner agent to avoid context pollution

The `verification-before-completion` skill makes this mandatory.

## Development Commands

This repository includes scripts and tests. Use these commands for Codex parity verification:

```bash
# Codex sync and parity tests
node --test tests/codex-*.test.js

# Full test suite
node --test tests/*.test.js

# Ensure generated wrappers are in sync
node scripts/sync-codex-skills.js --check

# Installer behavior tests
node --test tests/codex-installer.test.js
```

### Testing Skills

When creating or modifying skills, use the `writing-skills` skill which applies TDD to documentation:

1. Test skill with subagents BEFORE writing final version
2. Iterate until the skill is bulletproof against rationalization
3. Document what failure modes you tested

### Publishing

The plugin is published to the Claude Code marketplace:

```text
/plugin marketplace add dpolishuk/xpowers
/plugin install xpowers@xpowers --scope user
```

If you have a legacy install, migrate to the current name:

```text
/plugin uninstall withzombies-hyper@xpowers --scope user
/plugin uninstall xpowers@xpowers --scope user
/plugin install xpowers@xpowers --scope user
```

Version is tracked in `.claude-plugin/plugin.json`.

## Philosophy and Principles

From the using-hyper skill and README:

1. **Incremental progress over big bangs** - Small changes that compile and pass tests
2. **Learning from existing code** - Study patterns before implementing
3. **Explicit workflows over implicit assumptions** - Make the process visible
4. **Verification before completion** - Evidence over assertions
5. **Test-driven when possible** - Red, green, refactor

### Mandatory Workflows

The `using-hyper` skill establishes these non-negotiable rules:

- **Check for relevant skills before ANY task** - If a skill exists for it, use it
- **Use Skill tool before announcing** - Load the actual skill file, don't rely on memory
- **Create TodoWrite todos for checklists** - Track progress explicitly
- **Follow brainstorming before coding** - Design first, code second
- **Use verification-before-completion** - Never claim success without evidence

## Common Pitfalls

From `using-hyper` - watch for these rationalizations:

- "This is just a simple question" → Wrong. Check for skills.
- "I can check git/files quickly" → Wrong. Files lack context. Check for skills.
- "Let me gather information first" → Wrong. Skills tell you HOW to gather.
- "This doesn't need a formal skill" → Wrong. If skill exists, use it.
- "I remember this skill" → Wrong. Skills evolve. Run current version.
- "The skill is overkill" → Wrong. Skills exist because simple things become complex.

## Current Limitations

From RECOMMENDATIONS.md:

**Currently covered:**
- ✅ Greenfield feature development (idea → design → implementation → PR)
- ✅ Bug fixing and debugging workflows (systematic investigation, root cause tracing)
- ✅ Refactoring workflows (test-preserving transformations)
- ✅ Advanced task management (splitting, merging, dependencies, metrics)
- ✅ Quality culture (TDD, verification, SRE review)
- ✅ Clean bd integration

**Missing (see RECOMMENDATIONS.md for details):**
- ❌ Incident response
- ❌ Code review response (receiving reviews)
- ❌ Merge conflict resolution
- ❌ Documentation workflows

Priority: Continue adding collaboration workflows (code review response, incidents).

## File Naming Conventions

- Skills: `skills/<skill-name>/SKILL.md` (frontmatter + content)
- Commands: `commands/<command-name>.md` (frontmatter + brief invocation)
- Agents: `agents/<agent-name>.md` (frontmatter + detailed prompt)
- Common patterns: `skills/common-patterns/<pattern-name>.md`

## Important Notes

- This plugin is loaded automatically when installed; there's no runtime execution
- Skills are documentation that Claude reads at runtime, not executable code
- Changes to skill files take effect immediately in new conversations
- The test-runner agent uses Haiku model for cost efficiency
- The sre-task-refinement skill uses Opus 4.1 for deep analysis
- Most other operations use the default model (Sonnet)

## Contributing Guidelines

From writing-skills skill:

1. Test skills with subagents before finalizing
2. Iterate until bulletproof against rationalization
3. Follow the skill structure pattern (Overview, Process, Rationalizations, Red Flags, Integration)
4. Reference common-patterns instead of duplicating content
5. Be explicit about whether skill is rigid (must follow exactly) or flexible (adapt principles)

<!-- bv-agent-instructions-v1 -->

---

## Beads Workflow Integration

This project uses [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) for issue tracking. Issues are stored in `.beads/` and tracked in git.

### Essential Commands

```bash
# View issues (launches TUI - avoid in automated sessions)
bv

# CLI commands for agents (use these instead)
tm ready              # Show issues ready to work (no blockers)
tm list --status=open # All open issues
tm show <id>          # Full issue details with dependencies
tm create --title="..." --type=task --priority=2
tm update <id> --status=in_progress
tm close <id> --reason="Completed"
tm close <id1> <id2>  # Close multiple issues at once
tm sync               # Commit and push changes
```

### Workflow Pattern

1. **Start**: Run `tm ready` to find actionable work
2. **Claim**: Use `tm update <id> --status=in_progress`
3. **Work**: Implement the task
4. **Complete**: Use `tm close <id>`
5. **Sync**: Always run `tm sync` at session end

### Key Concepts

- **Dependencies**: Issues can block other issues. `tm ready` shows only unblocked work.
- **Priority**: P0=critical, P1=high, P2=medium, P3=low, P4=backlog (use numbers, not words)
- **Types**: task, bug, feature, epic, question, docs
- **Blocking**: `tm dep add <issue> <depends-on>` to add dependencies

### Session Protocol

**Before ending any session, run this checklist:**

```bash
git status              # Check what changed
git add <files>         # Stage code changes
tm sync                 # Commit beads changes
git commit -m "..."     # Commit code
tm sync                 # Commit any new beads changes
git push                # Push to remote
```

### Best Practices

- Check `tm ready` at session start to find available work
- Update status as you work (in_progress → closed)
- Create new issues with `tm create` when you discover tasks
- Use descriptive titles and set appropriate priority/type
- Always `tm sync` before ending session

<!-- end-bv-agent-instructions -->
