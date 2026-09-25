# Claude Code coordinator routing

XPowers includes an optional project profile for Claude Code with a coordinator,
implementers, and independent verification. Install it alongside the usual
XPowers plugin; enable it separately in each Claude session.

## Install and activate

Requires macOS or Linux (including WSL), Python 3.9+ and Claude Code **2.1.280+**. The default preset uses exact
Anthropic model IDs. Your account or gateway must provide those models.

From a checkout of XPowers:

```bash
bash scripts/setup-claude-routing.sh --project /path/to/your/project --preset opus
```

Start a **new Claude Code session in that project**, then run:

```text
/model claude-opus-5-5
/effort high
/routing-on
/routing-smoke-test
```

The install creates `.claude/routing.json`, five `xpowers-routing-*` agents,
three project commands, and the runtime under `.claude/xpowers-routing/`.
It merges `PreToolUse` and `SessionStart` hooks into `.claude/settings.json`.
Existing XPowers agents and other host integrations keep their existing behavior.

`/routing-on` prints the configured coordinator model and effort; it does not
switch the running model. Use `/model` and `/effort` to match those values.
Activation is stored outside the repository and scoped to the current session.
Resuming or compacting that session restores its routing instructions; a new
session starts with routing off. `/routing-off` disables it for the current session.

Invoke these commands through Claude Code. Claude substitutes
`${CLAUDE_SESSION_ID}` in the local command content before calling Bash; this is
not a shell environment variable. The guard checks the resulting session ID
against the current hook event. Copying an unexpanded command template directly
into Bash is unsupported.

## Roles and presets

| Role | `opus` preset | Effort | Maximum turns |
| --- | --- | --- | --- |
| Coordinator (main session) | `claude-opus-5-5` | high | Session controlled |
| Explorer | `claude-haiku-4-5-20251001` | low intent only | 40 |
| Worker | `claude-opus-5-5` | medium | 80 |
| Verifier | `claude-sonnet-5` | medium | 80 |
| Senior | `claude-opus-5-5` | high | 80 |
| Reviewer | `claude-opus-5-5` | high | 60 |

Haiku 4.5 does not support effort. The configuration retains the requested `low`
intent, but the generated Haiku agent omits native `effort` frontmatter.

The `fable-review` preset changes the reviewer to `claude-fable-5-1`;
`fable-coordinator` changes the coordinator to that model. Other roles stay the same.

```bash
bash scripts/setup-claude-routing.sh --project /path/to/your/project --preset fable-review
```

Models, efforts, turn limits, risk categories and attempt budgets are all in
`.claude/routing.json`. This is **XPowers configuration**, compiled into Claude
Code's native agent frontmatter; Claude Code does not read this JSON directly.
For example, these policy fields control escalation:

```json
{
  "escalation": { "workerAttempts": 2, "seniorAttempts": 2 },
  "review": {
    "riskTags": ["money", "concurrency", "data-migration"],
    "afterSeniorExhaustion": true
  }
}
```

After editing the config, rerun without a preset to preserve it and regenerate:

```bash
bash scripts/setup-claude-routing.sh --project /path/to/your/project
```

Then start a new Claude session. Activation rejects a config that differs from
the generated snapshot. Supplying `--preset` explicitly replaces configuration
with that preset's defaults. A no-flag reinstall preserves the existing config.
Do not edit generated agent files; customize their models and limits in the JSON.

## Work and acceptance

The coordinator investigates the task, defines invariants and acceptance
criteria, assigns risk tags, and gives an implementer a concrete task card:

```text
Objective and scope:
Owned files/modules:
Invariants and acceptance criteria:
Risk tags:
Base revision and expected diff:
Required checks:
Attempt number / remaining budget:
```

Ordinary changes follow **worker → verifier → coordinator**. The verifier runs
checks independently against the author's exact diff and returns commands,
results and limitations. Money, concurrency and data migrations go to senior
and require **both verifier and reviewer**. Difficult work and exhausted worker
attempts also escalate to senior. By default there are two worker attempts and
two senior attempts. Exhausting senior's budget requires both reviews and a
report of remaining defects; failed checks are never acceptance.

Every verifier/reviewer invocation must be a new named agent with fresh context.
Pass the task card, invariants and diff, without the author's reasoning transcript.
Do not resume the author or use `fork`. Worker and reviewer may use the same model;
they remain different agents. Verifier must use a different configured model from
worker/senior. Any new source change invalidates previous verification and review.

Claude Code enforces generated `maxTurns` per invocation. The coordinator tracks
attempt counts, risk classification and acceptance evidence in an external
scratchpad; those semantic decisions are workflow rules, not inferred by the hook.

## Coordinator guard

When enabled, `PreToolUse` denies main-session source edits through `Write`,
`Edit`, `NotebookEdit`, shell mutations and unknown tools. It resolves relative
paths and symlinks, including a project path that points outside the repository.
Native file writes outside the project remain available for memory and scratch;
routing control files and session state are protected.

The coordinator's shell has a conservative read-only allowlist. Exact
`git merge-base` and `git merge-tree` queries are accepted; `git merge`,
redirections, arbitrary interpreters and executable read-command options are
rejected. `merge-tree` can create Git objects but does not update source, index
or commits. Delegate builds, Docker checks, Git mutations and unfamiliar shell
commands to the appropriate agent.

Subagents are identified by Claude's `agent_id`, not just `agent_type`. A main
session started with `--agent` therefore cannot acquire worker write access.
Workers and seniors can edit source; verifiers run checks and report defects;
explorers and reviewers remain read-only. A defect found by the coordinator or
reviewer goes back to the author for correction.

This enforces a cooperative development workflow, **not an OS security sandbox**.
Tests can create build artifacts, shell commands run with user permissions, and
Claude Code can continue after a hook timeout. Keep the local Python runtime
available, inspect hook failures and avoid disabling hooks while routing is on.

## Smoke checks and rollback

`/routing-smoke-test` checks the current session's guard with synthetic events:
source-edit denial, external scratch, main/subagent identity, safe Git queries,
and mutation rejection. It performs no attempted writes or shell commands.
It does not spend model tokens or prove provider availability. Check actual
subagent models in Claude Code `/tasks`; forced model environment settings,
organization restrictions and effort caps can override requested settings.

Restore the original installation from a terminal:

```bash
bash scripts/setup-claude-routing.sh --project /path/to/your/project --restore
```

Backups and session state live below `~/.claude/xpowers-routing/`, keyed by the
canonical project path. Restore removes the profile's hooks and files and
recovers files that existed before installation, retaining unrelated settings.
If managed files were edited later, restore reports the conflict before changing
project files. Preserve those edits and resolve the conflict before retrying.
Restart Claude Code after restoring. After moving or copying an installed
project on the same machine, rerun the installer before starting Claude Code.
The installer recovers the original ownership record, replaces its old absolute
hook paths, and preserves pre-install backups for restore at the new location.
A copied project's installation can then be restored independently of the source.
Existing sessions are not activated at the new location.
If you left a symlink at the old project path, remove that link before reinstalling;
the installer rejects an origin that now resolves to another directory.

Keep the external backup directory available: the project-local
`xpowers-routing/install-origin.json` records ownership, not backup contents.
If the original backup is missing or managed files have changed, reinstall stops
before replacing project files. Recover the backup or restore the profile before
transferring the project to a different machine.

## References

- [Claude Code models and effort](https://code.claude.com/docs/en/model-config)
- [Anthropic model capabilities](https://platform.claude.com/docs/en/models/overview)
- [Custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Hook events and agent identity](https://code.claude.com/docs/en/hooks)
- [Commands and session substitution](https://code.claude.com/docs/en/skills)
- [Git merge-tree behavior](https://git-scm.com/docs/git-merge-tree)
