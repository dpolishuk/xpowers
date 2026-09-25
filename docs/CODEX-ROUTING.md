# Optional native Codex routing

This guide configures an opt-in, repository-local routing policy for native Codex
subagents. It is separate from XPowers skill installation: `scripts/install.sh
--codex` installs wrappers only and does not activate routing. It is also separate
from the Claude-only `routing-settings` workflow.

The setup script is adapted from the [routing source gist](https://gist.github.com/dpolishuk/b2f17580aa62c55dce99c92f58049d37).

## Requirements and first run

Use Bash, Git, and Python 3.9+ on macOS, Linux, or WSL. `PYTHON_BIN` may select a
specific compatible interpreter. The target must be a non-bare Git working tree;
`--repo` may name it or any directory within it.

From an XPowers checkout, always preview first:

```bash
bash scripts/setup-codex-routing.sh --repo /path/to/project --dry-run
```

Apply only after reviewing the preview and the target worktree:

```bash
bash scripts/setup-codex-routing.sh --repo /path/to/project
```

The script is standalone, so it may be copied or downloaded before it is run. It
uses isolated Python (`-I`). If `tomlkit` is already available to the selected
interpreter, it uses that parser. Otherwise it downloads only a hash-pinned
`tomlkit` 0.13.3 wheel into a temporary directory and does not run pip or install
anything in the system or repository. `--offline` forbids that temporary download,
so it requires a parser already available to `PYTHON_BIN`.

`--dry-run` changes neither the repository nor its backup metadata. It may still
perform the temporary parser download unless `--offline` is supplied.

## What the routing config does

The generated root configuration registers six roles explicitly through
`[agents.<role>]` entries that load `.codex/agents/*.toml`:

| Scope / role | Model | Effort | Use |
|---|---|---|---|
| Root coordinator | `gpt-6-astra` | `medium` | Architecture, task routing, and final review. Its instructions prohibit repository edits, including tiny fixes. |
| `default` | `gpt-5.6-terra` | `low` | Guard role that requests an explicit role selection. |
| `explorer` | `gpt-5.6-terra` | `low` | Bounded read-only discovery. |
| `worker` | `gpt-5.6-terra` | `medium` | Normal implementation. |
| `verifier` | `gpt-5.6-terra` | `medium` | Fresh verification without fixing. |
| `senior` | `gpt-5.6-sol` | `high` | Material risk or escalation after two Terra failures. |
| `reviewer` | `gpt-5.6-sol` | `high` | Fresh semantic review of risky or escalated work. |

Normal work follows worker → fresh verifier → coordinator. Material security,
money, data-loss, migration, concurrency, complex-algorithm work, and tasks after
two unsuccessful Terra iterations go to senior. Those paths then use fresh
verification and independent reviewer input before the coordinator concludes. The
role instructions prefer one writer and allow two only for disjoint owned paths;
they cap child work at three roles. They are policy text, not a hard sandbox: file
permissions still control what a running process can do.

The root starts at `medium`. Use an explicit root `high` override only for
architectural complexity; it does not authorize the coordinator to make project
edits.

No claim about benchmark gains, token savings, or model inference follows from the
configuration. Cost per accepted change is a future measurement, not a result of
this setup.

## Configuration formats

Fresh setup defaults to `modern`, the format for current Codex Desktop. It enables
agents at the root, sets the root child limit to three, and sets the default child
model and effort. Each child role disables `agents.enabled` and both
`multi_agent_v2` and multi-agent feature flags.

`legacy` is for older V1 Codex CLI clients, including 0.140, and must be selected
explicitly:

```bash
bash scripts/setup-codex-routing.sh --repo /path/to/project --config-format legacy
```

Legacy uses `max_threads = 3` and `max_depth = 1`; child roles disable both feature
flags. On a newer V2 client, legacy depth settings alone do not guarantee that a
child cannot delegate, so use modern there. Do not infer Codex Desktop capability
from the version of a separately installed Codex CLI.

The modern schema was strict-parsed against the Codex Desktop app-server in
ChatGPT Desktop 0.155.0-alpha.16.3. A parse check and model catalog metadata only
show configuration acceptance and advertised availability; neither proves actual
runtime model inference.

Managed reruns preserve the selected format, model IDs, efforts, and child limit
when their flags are omitted. To make an intentional change, pass one or more of:

```bash
bash scripts/setup-codex-routing.sh --repo /path/to/project \
  --root-model gpt-6-astra --terra-model gpt-5.6-terra --sol-model gpt-5.6-sol \
  --max-agents 3 --effort root=high --effort worker=medium
```

`--effort ROLE=LEVEL` is repeatable and accepts `root`, `subagent`, or a named
role. The installer checks effort syntax; it cannot prove a selected model accepts
that effort. `--max-agents` accepts 1 through 3.

## Preserving an existing project

The script preserves unrelated TOML keys and comments, existing `AGENTS.md`, and
text outside its managed blocks. If `AGENTS.override.md` exists and is nonempty, it
is the preferred instruction source. The setup appends bounded managed instructions
and rejects over-budget content.

It refuses symlinks, hard links, ambiguous role-name collisions, malformed managed
blocks, and existing unowned role files. Do not bypass a rejection by overwriting
those role files. If you have reviewed the conflict and intentionally want routing
blocks merged into existing role files, use `--adopt-roles`:

```bash
bash scripts/setup-codex-routing.sh --repo /path/to/project --adopt-roles
```

Adoption preserves unrelated TOML keys and existing developer instructions, but it
cannot resolve arbitrary semantic conflicts between instruction systems. Review the
combined policy before activating it.

## Backups and restore

Before a changed apply, originals and a manifest are stored privately in the
resolved Git metadata directory under `codex-routing-backups/`. In a linked
worktree, this is worktree-specific Git metadata. Backups are not tracked and may
contain private existing instructions or configuration; keep them private.

Restore the most recent compatible backup with:

```bash
bash scripts/setup-codex-routing.sh --repo /path/to/project --restore latest
```

Or replace `latest` with a backup timestamp. Restore refuses corrupt backups and
files whose content or permission mode changed after setup, so it cannot silently
overwrite later user work. There is no force flag. Use a quiet worktree because the
lock cannot prevent an editor or another process from changing these files.

## Required runtime smoke test

The installer writes `.codex/ROUTING-SMOKE-TEST.md`. After reviewing the local Git
diff, open a fresh trusted Codex session for the target repository and follow that
file. It uses small read-only role tasks and asks you to inspect real runtime
metadata for the root and child model/effort when the client exposes it.

Do not trust a model that says it is Astra, Terra, or Sol. If metadata is not
available, record that field as `UNVERIFIED`. The setup makes no automatic paid
model calls, does not change project trust, authentication, provider policy, or
global configuration, and does not verify runtime execution for you.

If configuration parsing fails, resolve the reported local configuration issue and
rerun the dry-run. If model access or metadata is unavailable in the fresh session,
leave the result unverified and check the applicable Codex runtime or account
configuration; do not silently substitute another model.
