# XPowers for Codex

This repo ships a Codex-adapted skill pack under `.agents/skills`.

## What changed vs Claude Code

- Claude-only features (hooks and slash commands) are not included.
- Skills include a short Codex compatibility note explaining how to interpret
  Claude-specific terms (e.g., “Skill tool”, “TodoWrite”, “Task()”).
- `dispatching-parallel-agents` now uses `spawn_agent` + `multi_tool_use.parallel`.
- A new skill, `xpowers-agents`, maps the specialized agent prompts into Codex subagents.

## Install locations (per Codex docs)

- Repo-level skills: `.agents/skills` (checked in)
- User-level skills: `~/.agents/skills`

Codex supports symlinked skills. This repo is set up so you can symlink into your user folder.

## Quick install (local)

```bash
mkdir -p ~/.agents/skills
for d in /Users/ryan/src/hyper/.agents/skills/*; do
  name=$(basename "$d")
  [ -e "$HOME/.agents/skills/$name" ] || ln -s "$d" "$HOME/.agents/skills/$name"
done
```

Optional backward-compat install (older Codex builds):

```bash
for d in /Users/ryan/src/hyper/.agents/skills/*; do
  name=$(basename "$d")
  [ -e "$HOME/.codex/skills/$name" ] || ln -s "$d" "$HOME/.codex/skills/$name"
done
```

## Usage

- Ask for a skill by name in your prompt (e.g., “Use `test-driven-development`”).
- Or rely on automatic skill matching using each SKILL’s description.
- Use `xpowers-agents` when you want to spawn specialized subagents.

### Refactor Workflow Wrappers

Codex also includes command wrappers that expose the refactor workflow entry points:

- `codex-command-refactor-design`
- `codex-command-refactor-diagnose`
- `codex-command-refactor-execute`

These wrappers map to the same canonical command semantics used by Claude and OpenCode:

- `refactor-design` → `refactoring-design`
- `refactor-diagnose` → `refactoring-diagnosis`
- `refactor-execute` → `refactoring-safely`

## Optional native repository routing

The normal XPowers installer installs skills and wrappers; it does **not** activate
native Codex agent routing. A separate, opt-in setup script can add managed,
repository-local Codex configuration for the six roles `default`, `explorer`,
`worker`, `verifier`, `senior`, and `reviewer`.

From a checked-out XPowers repository, preview and then apply it to a target Git
working tree:

```bash
bash scripts/setup-codex-routing.sh --repo /path/to/project --dry-run
bash scripts/setup-codex-routing.sh --repo /path/to/project
```

It requires Bash, Git, and Python 3.9+ on macOS, Linux, or WSL. It does not call
models, install packages into the repository or system, or change global Codex or
ordinary Desktop Chat/Work settings. The generated `.codex/ROUTING-SMOKE-TEST.md`
is the required runtime check in a new trusted session. Read
[docs/CODEX-ROUTING.md](docs/CODEX-ROUTING.md) for configuration formats, safety
behavior, adoption, restore, and validation limits.
