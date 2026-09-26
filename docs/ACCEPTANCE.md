# Acceptance gate

The acceptance gate is an opt-in, local verification step for projects using the `br` task backend. It prevents `tm close` from reaching `br` unless the named task has a current successful acceptance run for the exact Git worktree state. It is a technical verification gate; it does not establish semantic correctness, independent review, or who performed the work.

## Requirements and setup

Use a Git worktree with Node.js 20 or later and Git available, with `tm.backend: br` selected in `.beads/config.yaml`. The acceptance runtime is installed with XPowers. Other `tm` backends are refused while a policy is enabled. Repositories without `.xpowers/acceptance.json` keep their existing `tm` behavior. `.xpowers` must be a real directory and the policy must be a regular file, never a symlink.

Create `.xpowers/acceptance.json` at the worktree root. Version 1 requires at least one check, unique check IDs, a literal argv array for each command, and a bounded timeout in milliseconds:

```json
{
  "version": 1,
  "checks": [
    {
      "id": "tests",
      "command": ["node", "--test"],
      "timeoutMs": 120000
    }
  ]
}
```

`command` is executed as literal argv from the Git worktree root. It does not use a shell, so it has no shell interpolation, pipes, redirects, or glob expansion. If a command needs shell syntax, make that choice explicit by invoking a shell yourself; prefer commands that do not require one. Invalid policy files, an unavailable Node runtime, or an unavailable Git runtime fail closed.

## Run and close a task

Finish, stage, and commit the work first. Then run acceptance, inspect it, and close the task without changing Git state in between:

```bash
git add <changed-files>
git commit -m "Describe the completed work"
tm acceptance run TASK
tm acceptance check TASK
tm close TASK
```

Run every configured check for a specific task:

```bash
tm acceptance run TASK
```

The command succeeds only after every check succeeds within its timeout and produces a fresh receipt. Failure, timeout, interruption, or an internal error records an ineligible latest attempt; an older success cannot be reused. Successful `run` and `check` exit 0; an ineligible task, malformed policy, or runtime/check failure exits 1; invalid command usage exits 2. On success, the command prints `tm acceptance: TASK is eligible (FINGERPRINT)`; failure reasons are written to standard error with the `tm acceptance:` prefix.

Inspect eligibility without starting project commands:

```bash
tm acceptance check TASK
```

Close only after `check` reports eligibility:

```bash
tm close TASK
# or, for several explicit task IDs:
tm close TASK_A TASK_B
```

With a policy enabled, `tm close` accepts only explicit task IDs and no flags. It checks every target before dispatching to `br`; `--force` does not override this. On successful eligibility, it prints an eligibility line per ID, holds the acceptance lock through `br` completion, and preserves `br`'s standard I/O and exit status. The runtime handles `SIGHUP`, `SIGINT`, and `SIGTERM` through the same locked cleanup path, returning 129, 130, and 143 respectively. If a runtime output stream closes, errors, or cannot complete a write within five seconds, the operation fails: a run cannot retain a passed receipt and a guarded close is not dispatched. Ambiguous or bulk terminal forms, including close-eligible epic helpers and imported terminal task states, are refused instead of being treated as accepted. Compact or clustered short-option tokens on `create` and `update` are also refused; use separate short options and values or long options. Unsupported root/database overrides and backend-bypass forms are refused. A failed command exits nonzero and explains why the task is not eligible.

## What a receipt covers

Acceptance snapshots are taken before and after the checks. A receipt is eligible only when those snapshots match and the current worktree still matches them. The fingerprint includes the resolved Git worktree identity, commit, full symbolic `HEAD` ref or explicit detached state, tracked files, and nonignored untracked files, including their paths, contents, full relevant POSIX permissions, and file types, as well as the policy itself. For each proof-covered index entry, it binds the mode, object ID, stage, assume-unchanged flag, skip-worktree flag, and intent-to-add flag. Git's stat cache, fsmonitor-valid bit, and similar cache bookkeeping are intentionally not proof inputs. It also includes the POSIX modes of the canonical worktree root and the ancestor directories of proof-covered files, links, policy, and tracker selector paths. It does not walk or cover unrelated empty or ignored directories. Source files are hashed in bounded chunks.

Internal file and directory symlinks are proof-covered through the link path, raw link text, link mode, final canonical target path and type, and target contents. A directory target is traversed recursively, including ignored descendants and empty directories; descendant paths, file bytes, node types, and file and directory modes enter the fingerprint. Canonical nodes are flattened and stored once even when several aliases reach the same subtree. Nested links encountered inside a covered directory are recorded and followed under the same rules. Symlink components used only while resolving a link are not separately listed unless they are themselves proof-covered nodes; the manifest still binds the recorded link text and final canonical target. Links to the worktree root are refused. Cycles, dangling or external targets, Git metadata, `.beads` metadata, submodules, special files, unsafe parents, and invalid UTF-8 names fail closed.

The tracker selector files `.beads/config.yaml` and `.beads/metadata.json` are also fingerprinted, so changing, creating, or removing either invalidates evidence. Mutable task records and data under `.beads` remain excluded; the gate does not read `.beads/issues.jsonl`.

Redirected task stores are unsupported in this MVP. If any filesystem node exists at `.beads/redirect` while a policy is enabled, `tm` refuses the operation without reading or following that node. Use a worktree connected directly to its own task store before running acceptance or guarded close.

The runtime stores one latest receipt per task as a private, atomically written file under `$(git rev-parse --absolute-git-dir)/xpowers/acceptance-v1`: the directory has mode `0700`, each SHA-256(task)-named receipt has mode `0600`, and lock ownership is recorded at `lock/owner.json`. It is not an append-only audit journal. The runtime locks this location while it validates evidence and dispatches the guarded close. These implementation files are evidence, not an interface for manually approving a task.

If the current source, policy, tracker selector, index, commit, symbolic branch ref, or attached/detached `HEAD` state differs from the receipt snapshot, the receipt is stale. Because the fingerprint includes `HEAD` and the index, `git add`, index-flag changes, a same-tip branch switch, or `git commit` after a run also makes it stale even if the working-tree bytes did not change. This does not mean separately staged blobs were tested; the checks ran against the worktree snapshot. Even a commit that only changes excluded task records changes `HEAD` and therefore requires a new run. Fix the change, then run `tm acceptance run TASK` again. A transient check failure, timeout, or interrupted run also requires a new successful run.

Do not delete an individual receipt or only the lock to recover. Missing, malformed, and corrupt state is ineligible, but a new successful `tm acceptance run TASK` replaces it with fresh evidence. If a pending, failed, or interrupted receipt cannot be persisted reliably, the runtime intentionally retains the lock so an older receipt cannot become eligible again. If a stale lock is reported, first stop every concurrent `tm acceptance` and guarded `tm close` process for that worktree. After confirming none remains, remove the entire resolved `acceptance-v1` directory (not just `lock`); this intentionally clears the receipts with the lock. Then run `tm acceptance run TASK` again. Recovery never revives an earlier success; `tm acceptance check` only reports eligibility and cannot create evidence.

## Limits

The gate verifies the configured commands against one snapshot of the current Git worktree. It does not prove that those commands are sufficient, that a change is semantically correct, or that an independent reviewer or agent approved it. It provides no sandbox, remote-model selector, deployment, merge, or author-attestation feature.

Ignored files are not proof-covered unless they are descendants or final file targets of a covered internal symlink. Installed dependencies, environment variables, network services, and other external inputs are not proof-covered. Ordinary filesystem writers are not locked: a file can be edited and restored between snapshots, or edited after the final snapshot and before a later eligibility check. During guarded close, source files or tracker selector files can change after the final eligibility snapshot, including while eligibility output is being written or while `br close` is running. The acceptance lock serializes receipt operations and guarded dispatch; it does not lock worktree files or external writers, so snapshot validation and task closure are not atomic. Avoid mutating the worktree while checks or close are running. Writer ownership and coordination beyond this boundary are tracked in `bd-dle`. The snapshot also cannot protect work performed outside the controlled `tm` path: direct `br` invocation, external imports, policy removal, and same-user tampering are outside this MVP. The gate refuses Git, root/database, and concrete `br` storage environment overrides, including `BEADS_DB`, `BEADS_JSONL`, and `BD_NO_DB`, while policy is enabled. The policy must resolve at the canonical Git worktree root; malformed policy filesystem entries are refused rather than disabling the gate.

The runtime caps the policy at 256 KiB, receipts at 512 KiB, Git listings at 16 MiB, checks at 32, argv entries at 64 per check, arguments at 4096 bytes, timeouts at 1 through 600000 ms, check output at 64 KiB, and stored stdout/stderr at 4 KiB each. Across canonical directory-symlink targets, traversal is also capped at 4096 unique nodes, depth 32, and 256 KiB of aggregate UTF-8 path bytes. These bounds are enforced while directory entries are listed, before an oversized manifest can accumulate.

## XPowers repository policy

XPowers commits [`.xpowers/acceptance.json`](../.xpowers/acceptance.json) as a repository-specific pilot. Install its test dependencies with `npm ci` and `bun install --frozen-lockfile --cwd .opencode`. The policy runs the root Node `.test.js` suite with concurrency 4 and the dot reporter, verifies generated Codex skill wrappers, and runs ESLint. The Node check canonicalizes `TMPDIR` so temporary-repository paths compare consistently on macOS. Because the Node suite includes an OpenCode runtime test that invokes Bun and resolves `.opencode` dependencies, these checks require Node.js 20 or later, npm dependencies, Bun with `.opencode` dependencies installed, Git, and Bash. They do not replace the remaining Bun, Gemini, package typecheck, security-audit, or other jobs in full CI.

Use the runtime from the checkout so the command and companion match this branch:

```bash
git add <changed-files>
git commit -m "Describe the completed work"
./scripts/tm acceptance run TASK
./scripts/tm acceptance check TASK
./scripts/tm close TASK
```

The pilot proves only the configured local checks against the recorded snapshot. It does not attest to full CI, independent review, or who ran the checks.
