#!/usr/bin/env bash
# Repository-local Astra -> Terra -> Sol setup. macOS/Linux/WSL, Bash + Git + Python 3.9+.
# No model calls, no publishing, no sudo, no global config changes.
# Documentation verified 2026-09-15; installed client/model availability must be tested separately.
# Adapted for XPowers from https://gist.github.com/dpolishuk/b2f17580aa62c55dce99c92f58049d37
set -euo pipefail
PYTHON_BIN="${PYTHON_BIN:-python3}"
command -v "$PYTHON_BIN" >/dev/null 2>&1 || {
  printf 'ERROR: Python 3.9+ is required (set PYTHON_BIN to its executable).\n' >&2
  exit 1
}
# Isolated Python avoids importing modules from the repository being configured.
"$PYTHON_BIN" -I - "$@" <<'PY'
from __future__ import annotations
import argparse
import atexit
import contextlib
import datetime
import errno
import fcntl
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import secrets
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

VERSION = '1.2.0'
MANIFEST_FORMAT = 1
READ_LIMIT = 8_000_000
ROLE_NAMES = ('default', 'explorer', 'worker', 'verifier', 'senior', 'reviewer')
OWNER = '# Managed by setup-codex-routing.sh v1'
CONFIG_OWNER = '# Managed by setup-codex-routing.sh v1; config-format='
BEGIN = '<!-- BEGIN codex-astra-terra-sol v1 -->'
END = '<!-- END codex-astra-terra-sol v1 -->'
ROLE_BEGIN = '[BEGIN CODEX ROUTING ROLE v1]'
ROLE_END = '[END CODEX ROUTING ROLE v1]'
ALLOWED = {'.codex/config.toml', 'AGENTS.md', 'AGENTS.override.md',
           '.codex/ROUTING.md', '.codex/ROUTING-SMOKE-TEST.md'} | {
               f'.codex/agents/{name}.toml' for name in ROLE_NAMES}
TOMLKIT_HASH = 'c89c649d79ee40629a9fda55f8ace8c6a1b42deb912b2a8fd8d942ddadb606b0'
TOMLKIT_URL = ('https://files.pythonhosted.org/packages/bd/75/'
               '8539d011f6be8e29f339c42e633aae3cb73bffa95dd0f9adec09b9c58e85/'
               'tomlkit-0.13.3-py3-none-any.whl')

class SetupError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise SetupError(message)


def warn(message):
    print('WARNING: ' + message, file=sys.stderr)


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def git(directory, *args):
    # An agent or Git hook may export GIT_DIR/GIT_WORK_TREE. They must not
    # redirect an explicitly selected repository or its backup metadata.
    blocked = {'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
               'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
               'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG',
               'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'}
    env = {key: value for key, value in os.environ.items()
           if key not in blocked and not key.startswith(('GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_'))}
    result = subprocess.run(['git', '-C', str(directory), *args], env=env,
                            text=True, capture_output=True, timeout=30)
    require(result.returncode == 0, 'Git command failed: ' + result.stderr.strip())
    # Do not strip legitimate spaces in a repository's name.
    return result.stdout.rstrip('\r\n')


def load_tomlkit(offline):
    """Use an installed parser, or import a hash-pinned pure-Python wheel from temp."""
    try:
        return importlib.import_module('tomlkit')
    except ModuleNotFoundError as error:
        if error.name != 'tomlkit':
            raise
    require(not offline, 'tomlkit is not installed; --offline forbids downloading it. '
            'Use a Python environment with tomlkit already installed.')
    print('Fetching hash-pinned tomlkit 0.13.3 into a temporary directory; '
          'no system or repository package installation.')
    temp = tempfile.TemporaryDirectory(prefix='codex-routing-parser-')
    atexit.register(temp.cleanup)
    with urllib.request.urlopen(TOMLKIT_URL, timeout=30) as response:
        require(urllib.parse.urlparse(response.geturl()).hostname == 'files.pythonhosted.org',
                'Unexpected wheel download host.')
        data = response.read(1_000_001)
    require(len(data) <= 1_000_000 and digest(data) == TOMLKIT_HASH,
            'tomlkit wheel checksum/size mismatch. Nothing installed.')
    wheel = Path(temp.name) / 'tomlkit-0.13.3-py3-none-any.whl'
    wheel.write_bytes(data)
    # Wheels are ZIP files; this pure-Python wheel supports zipimport.
    sys.path.insert(0, str(wheel))
    return importlib.import_module('tomlkit')


def safe_path(root, relative):
    rel = Path(relative)
    require(not rel.is_absolute() and '..' not in rel.parts,
            f'Unsafe relative path: {relative}')
    current = root
    for index, part in enumerate(rel.parts):
        current = current / part
        require(not current.is_symlink(), f'Refusing symlink: {current}')
        if current.exists() and index < len(rel.parts) - 1:
            require(current.is_dir(), f'Not a directory: {current}')
    return current


def checked_stat(info, path):
    require(stat.S_ISREG(info.st_mode), f'Not a regular file: {path}')
    require(info.st_nlink == 1, f'Refusing hard-linked file: {path}')
    require(info.st_size <= READ_LIMIT, f'Unexpectedly large config/document: {path}')
    require(not stat.S_IMODE(info.st_mode) & 0o7000,
            f'Refusing special permission bits: {path}')


@contextlib.contextmanager
def parent_fd(path, create=False):
    """Walk absolute parent components without following symlinks (POSIX)."""
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts, f'Unsafe absolute path: {path}')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(path.anchor, flags)
    try:
        for part in path.parent.parts[1:]:
            if create:
                try:
                    os.mkdir(part, 0o755, dir_fd=fd)
                except FileExistsError:
                    pass
            next_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd, path.name
    finally:
        os.close(fd)


def read_regular(path):
    try:
        with parent_fd(path) as (directory, name):
            # NONBLOCK prevents a malicious FIFO from hanging before fstat.
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=directory)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, 'rb') as stream:
        checked_stat(os.fstat(stream.fileno()), path)
        data = stream.read(READ_LIMIT + 1)
        require(len(data) <= READ_LIMIT, f'File grew while being read: {path}')
        checked_stat(os.fstat(stream.fileno()), path)
        return data


def file_mode(path):
    with parent_fd(path) as (directory, name):
        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
        checked_stat(info, path)
        return stat.S_IMODE(info.st_mode)


def sync_directory(fd):
    try:
        os.fsync(fd)
    except OSError as error:
        # Some supported POSIX filesystems do not implement directory fsync.
        if error.errno not in (errno.EINVAL, errno.ENOTSUP, errno.EBADF):
            raise


def remove_regular(path):
    with parent_fd(path) as (directory, name):
        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
        checked_stat(info, path)
        os.unlink(name, dir_fd=directory)
        sync_directory(directory)


def decode(data, label):
    try:
        return (data or b'').decode('utf-8')
    except UnicodeDecodeError:
        raise SetupError(f'{label} is not UTF-8; no changes applied.')


def parse_toml(data, label, tk):
    try:
        return tk.parse(decode(data, label))
    except Exception as error:
        # Avoid printing secret-bearing TOML content from parser diagnostics.
        raise SetupError(f'Cannot parse TOML: {label} ({type(error).__name__}).')


def replace_block(text, block, begin, end, label):
    """Replace only our one delimited block; preserve all text outside it."""
    starts, ends = text.count(begin), text.count(end)
    require(starts == ends and starts <= 1, f'Malformed/duplicate managed block: {label}')
    if starts:
        start, stop = text.index(begin), text.index(end)
        require(start < stop, f'Reversed managed block markers: {label}')
        return text[:start] + block + text[stop + len(end):]
    return text + ('\n\n' if text and not text.endswith('\n') else '\n' if text else '') + block + '\n'


def table(doc, name, tk):
    if name not in doc:
        doc[name] = tk.table()
    require(hasattr(doc[name], 'keys'), f'{name} must be a TOML table.')
    return doc[name]


def managed_config_format(data):
    text = decode(data, '.codex/config.toml')
    marker_lines = re.findall(
        r'^# Managed by setup-codex-routing\.sh v1; config-format=.*$',
        text, re.MULTILINE)
    matches = re.findall(r'^# Managed by setup-codex-routing\.sh v1; '
                         r'config-format=(modern|legacy)$', text, re.MULTILINE)
    require(len(marker_lines) <= 1 and len(marker_lines) == len(matches),
            'Malformed/duplicate managed config-format marker.')
    return matches[0] if matches else None


def mark_config(content, config_format):
    marker = CONFIG_OWNER + config_format
    pattern = (r'^# Managed by setup-codex-routing\.sh v1; '
               r'config-format=(?:modern|legacy)$')
    if re.search(pattern, content, re.MULTILINE):
        return re.sub(pattern, marker, content, count=1, flags=re.MULTILINE)
    return marker + '\n' + content


ROOT_BODY = '''## Codex model routing
Scope: Codex sessions using this repository's custom roles. Other coding tools
keep their existing workflow. Root-only rules apply to the primary thread only;
spawned agents follow their assigned role and may perform its authorized work.
Preserve existing repository/Xpowers quality gates; do not create a competing loop.

PRIMARY THREAD ONLY
Act as architect, planner, orchestrator and final reviewer. Do not edit repository
files (including tests/docs/configs), generate patches or bypass this via shell.
Delegate implementation, build/test runs and every fix, including one-line fixes.
Read relevant source/diffs/evidence, define invariants and acceptance criteria,
then route work using the explicit custom roles below. Do not override their models.
- explorer: optional bounded discovery, no edits.
- worker: default bounded implementation on Terra.
- verifier: fresh, independent verification, not the implementer.
- senior: Sol for materially high-risk work or Terra escalation.
- reviewer: fresh Sol semantic review for high-risk or escalated changes.
- default: routing guard only, never an implementation worker.
Unavailable role/model/tool: report BLOCKED; no silent model substitution or root coding.

DELEGATION AND BUDGET
Only the primary delegates. Workers must not launch subagents or external agent loops.
One writer per worktree by default. At most two only with disjoint owned paths,
compatible interfaces and independently executable tasks. Treat worktrees as shared
unless isolation is verified. Serialize shared configs, lockfiles and generated files.
Each task includes goal, owned_paths, read_dependencies, invariants, acceptance_criteria,
validation_commands, risk, baseline (HEAD + existing dirty/untracked files), attempts_used.
Terra: at most two unsuccessful implement/verify iterations per task TOTAL across
restarts. Then stop that writer and escalate evidence/current diff to senior.
Sol: at most two additional unsuccessful iterations, then stop with diagnosis.
Security/money/data-loss/migration/concurrency risks go directly to senior when material.
Missing permissions, dependencies or infrastructure are BLOCKED, not model-escalation reasons.
These budgets are procedural rules, not a hard runtime token counter.

ACCEPTANCE AND CONTEXT
Normal code: worker -> fresh verifier -> primary review.
High-risk/escalated code: senior -> fresh verifier -> fresh reviewer -> primary review.
Do not run all roles for every task. Docs-only edits may use primary diff review.
Pause writers before final checks; verify/review the same stable diff. After changes,
rerun affected checks. Inspect actual code and evidence, not only worker summaries.
Reuse a worker for related fixes; close completed threads after recording evidence.
Request concise reports with changed paths, exact commands/results, attempts and risks.
Do not dump full files/logs; do not omit critical evidence to meet a length target.
Do not weaken tests, suppress failures, modify routing rules to bypass restrictions,
or claim completion while required checks are missing or unexplained failures remain.
Do not commit, push, merge or deploy unless explicitly authorized.
'''

COMMON = '''You are a spawned role, not the primary orchestrator. Follow applicable
repository instructions and your assigned work packet. The root-only no-edit rule
in AGENTS.md does not prohibit an implementation role's assigned edits.
Preserve existing user/other-agent changes. Stay within owned_paths and scope.
Do not launch subagents, external coding agents, recursive CLI/API loops or paid
services. Do not change authorization, routing rules, quality gates or security
settings to make progress. Do not weaken tests or hide failures.
Missing permissions/infrastructure or unclear required invariants: return BLOCKED.
Do not commit, push, merge or deploy without explicit user authorization.
Return concise evidence: status; changed paths; exact checks/results; attempts_used;
remaining risks and required decisions. No full logs/patches unless requested.
'''

ROLE_DATA = {
    'default': ('terra', 'low', 'Read-only routing guard for unspecified tasks.', '''
Do not implement, modify files or run mutating commands. Return BLOCKED and ask
the primary to select worker, explorer, verifier, senior or reviewer explicitly.
'''),
    'explorer': ('terra', 'low', 'Targeted read-only exploration of unfamiliar code.', '''
Read only the assigned scope. Do not modify files or run builds/tests.
Return exact paths/symbols, callers and existing tests as directly observed facts.
Do not infer deep invariants or claim a complete dependency/security analysis.
Return NEEDS_ANALYSIS for ambiguous behavior; the primary owns deeper analysis.
Do not dump whole files. Status: COMPLETE, NEEDS_ANALYSIS or BLOCKED.
'''),
    'worker': ('terra', 'medium', 'Default bounded implementation and local fixes.', '''
Implement the smallest correct change in owned_paths, including relevant tests.
Run focused checks, inspect your diff, preserve unrelated work. Return BLOCKED
before expanding scope/interfaces/dependencies without authorization.
After at most two unsuccessful task-level implement/verify iterations TOTAL,
including attempts_used passed by the primary, return ESCALATE with evidence.
Do not reset the count when resumed/replaced. Stop earlier for blocked prerequisites.
Status: READY_FOR_VERIFICATION, ESCALATE or BLOCKED. Passing your own checks is
not independent verification.
'''),
    'verifier': ('terra', 'medium', 'Independent test execution without fixing the implementation.', '''
Verify the stable assigned diff against acceptance criteria. Run appropriate checks
using existing source/tests; report exact commands, exit codes, skipped checks and
relevant failure evidence. Builds/caches/temp artifacts may be produced within
permissions. Do not edit production code, tests, snapshots or configuration.
Do not invoke formatters/snapshot-update modes that rewrite tracked files.
Never fix what you are verifying. Return CHECKS_PASSED, FAIL or BLOCKED.
CHECKS_PASSED means the reported checks passed, not proof of correctness.
Explicitly list uncovered acceptance criteria and test coverage limitations.
Distinguish newly introduced regressions from pre-existing failures.
'''),
    'senior': ('sol', 'high', 'High-risk implementation and evidence-driven escalation.', '''
Handle materially high-risk tasks or escalations using the provided current diff,
failed attempts and reproduction evidence. Trace root cause before another fix.
Implement only owned_paths, retain invariants, add/regain regression coverage and
run targeted validation. At most two unsuccessful senior implement/verify iterations
per task including senior_attempts_used; then STOPPED with diagnosis and next decision.
Other statuses: READY_FOR_VERIFICATION or BLOCKED. Do not restart indefinite loops.
'''),
    'reviewer': ('sol', 'high', 'Independent read-only review of high-risk or escalated changes.', '''
Review code/invariants, not just the author's summary. Do not modify files or run
builds/tests; the verifier owns execution. Seek concrete correctness/security/data
integrity/concurrency defects, regressions and missing tests. Avoid style-only rewrites.
For each finding return severity, location, trigger, violated invariant and suggested
minimal correction. Return FINDINGS, NO_FINDINGS or BLOCKED; no findings is not a
claim that unexecuted tests passed.
''')}


def select_effort(doc, key, target, default, args):
    overrides = getattr(args, 'effort_overrides', {})
    value = overrides.get(target, doc.get(key, default))
    require(isinstance(value, str) and re.fullmatch(r'[a-z][a-z0-9_-]{0,31}', value),
            f'Invalid reasoning effort for {target}; pass --effort {target}=LEVEL.')
    doc[key] = str(value)
    args.resolved_efforts[target] = str(value)
    return str(value)


def routing_readme(args):
    role_models = chr(10).join(
        '- ' + name + ': `' + args.resolved_models[name] + '` / ' +
        args.resolved_efforts[name] for name in ROLE_NAMES)
    return f'''<!-- Managed by setup-codex-routing.sh v1 -->
# Astra -> Terra -> Sol: repository setup

Root: `{args.root_model}` / {args.resolved_efforts['root']}.
Concurrent child cap: {args.max_agents}. Config format: `{args.config_format}`.

Role model and effort settings:
{role_models}

Effort loaded from the generated configuration:
{chr(10).join('- ' + name + ': `' + effort + '`' for name, effort in args.resolved_efforts.items())}

Existing effort values are retained unless explicitly overridden, for example
`--effort root=high --effort worker=medium`. No automatic mid-session effort switch.
The installer validates token syntax, NOT the model's support for an effort level.
On managed reinstalls, model IDs, efforts, concurrency and config format are
preserved unless their corresponding CLI flags explicitly override them.

Roles are registered through `[agents.<role>]` and load TOML from `.codex/agents/`.
The `modern` format targets current Codex and uses the current agent scalar keys.
The `legacy` format targets older V1 clients (including Codex 0.140), uses
`max_threads`/`max_depth`, and disables both multi-agent feature backends in children.
Do not select legacy for a V2 runtime; V2 does not enforce the V1 `max_depth` field.

Normal change: worker -> independent verifier -> root review.
High-risk change: senior -> independent verifier -> independent reviewer -> root review.
Root never writes repository files by instruction. This is NOT an OS-enforced
root read-only / child-write boundary. Writers/verifier inherit current permissions;
read-only role defaults may also be overridden by the parent session's runtime settings.
Retries are instruction-level budgets, not hard runtime counters.

## Activation
Stop existing writers before installing. Open a NEW Codex session for this trusted
repository (CLI or Codex mode in Desktop). Select the configured root model/effort and verify role/model
metadata using ROUTING-SMOKE-TEST.md. Do not change ordinary Chat/Work settings.
Project trust and model access are NOT changed by this script. CLI/UI/runtime flags,
nested project configs, global roles, inherited provider and admin policy can affect
runtime behavior. No model is called and no runtime verification is performed by setup.

## Installation and recovery
The installer preserves unrelated TOML keys/comments and text outside managed blocks.
`--dry-run` writes no repository/backup files; temporary parser download may occur.
`--offline` forbids that download. Python 3.9+, Git and Bash are required.
If tomlkit is absent, its fixed 0.13.3 wheel is downloaded to a temporary directory,
verified by SHA-256 and imported without pip/system installation. An already
installed tomlkit is used as a trusted local dependency and is not hash-verified.
Isolated Python does not read user-site packages; PYTHON_BIN may select a venv.

Existing unowned role files are rejected by default. `--adopt-roles` explicitly merges
routing models/instructions into canonical existing role files while preserving unrelated
keys. Legacy registrations or duplicate names require manual integration first.
Existing developer instructions are preserved, not semantically rewritten. Review
instruction conflicts, especially with a previously installed orchestration workflow.

Backups: Git metadata directory / `codex-routing-backups/<timestamp>/` (not tracked).
Restore using this or a compatible newer script: `bash setup-codex-routing.sh --repo PATH --restore latest`.
Restore refuses content OR permission changes since setup; it does not overwrite
subsequent user work. Both installation and restore attempt rollback after a caught
write failure. This is not a database transaction across multiple files. SIGKILL,
power loss or a persistent disk error can require manual recovery from the retained
backup. Inspect transaction.json; --restore TIMESTAMP can resume an interrupted restore.
`--restore latest` selects the newest committed/uncertain/restored transaction;
rolled-back installs are excluded. Repeating it does not undo earlier installations;
use an explicit older timestamp for an older restore. Empty directories may remain after rollback.
POSIX permission bits are preserved; ACLs, xattrs and ownership are not backed up.
Use only in a trusted, quiescent worktree; the installer lock does not stop Codex,
editors or malicious processes from changing the same files.
Keep backups private: original configs/instructions may contain sensitive information.
No commits, pushes, package changes in the project, credentials or global config edits.

## Validation status
Config syntax and intended routing settings: checked by the installer.
Compatibility with your installed client and models: RUNTIME_UNVERIFIED until smoke test.
Never report token savings as measured without a controlled before/after comparison.

This installer is adapted from the user-owned source at
https://gist.github.com/dpolishuk/b2f17580aa62c55dce99c92f58049d37

## References (reviewed 2026-09-15)
https://learn.chatgpt.com/docs/agent-configuration/subagents
https://learn.chatgpt.com/docs/config-file/config-reference
https://learn.chatgpt.com/docs/config-schema.json
https://learn.chatgpt.com/docs/config-file/config-basic
https://developers.openai.com/api/docs/models
'''.encode()

SMOKE = b'''<!-- Managed by setup-codex-routing.sh v1 -->
# Run in a NEW Codex session after reviewing the local git diff

Paste this request into Codex for this repository:

You are the primary architect; do not edit files. Read repository instructions.
Confirm the six custom roles are available. Sequentially spawn worker and senior
with a tiny READ-ONLY task: identify one existing test and what it checks; no edits,
no test/build execution, no more than 100 words per report. Close each thread.
Inspect actual runtime model/effort metadata if exposed. Do not accept the model's
self-identification as evidence. Read expected model/effort values from .codex/config.toml and role TOMLs;
compare them with the runtime metadata instead of assuming default effort. Check child delegation tools
are disabled if tool metadata is visible. If model/tool metadata is not exposed,
report that part UNVERIFIED. Do not substitute a different model silently.
Report CONFIG_LOADED, MODELS_VERIFIED/UNVERIFIED, TOOLS_VERIFIED/UNVERIFIED.
Report MODELS_VERIFIED only when runtime metadata confirms every configured model;
missing metadata or self-identification alone requires MODELS_UNVERIFIED.
CLI-only evidence does not verify Desktop behavior. Do not modify user permissions.

A separate small implementation test can then exercise writer -> verifier -> root.
Do not claim that passing this smoke test proves quality or economic savings.
'''


def plan(root, args, tk):
    originals, desired = {}, {}
    args.resolved_efforts = {}
    args.resolved_models = {}
    def get(rel):
        data = read_regular(safe_path(root, rel))
        originals[rel] = data
        return data
    def emit(rel, data):
        if rel not in originals:
            get(rel)
        desired[rel] = data

    old_config = get('.codex/config.toml')
    previous_format = managed_config_format(old_config)
    args.config_format = args.config_format or previous_format or 'modern'
    cfg = parse_toml(old_config, '.codex/config.toml', tk)
    agents = table(cfg, 'agents', tk)
    format_keys = {'enabled', 'max_concurrent_threads_per_session',
                   'default_subagent_model', 'default_subagent_reasoning_effort',
                   'max_threads', 'max_depth'}
    if previous_format is None:
        require(not any(name in agents for name in ROLE_NAMES),
                'Existing [agents.<role>] registration collides with managed routing roles; '
                'integrate or remove it manually before setup.')
        require(not any(key in agents for key in format_keys),
                'Existing agent routing scalar keys are not managed by this installer; '
                'refusing broad adoption. Integrate them manually before setup.')
    args.root_model = args.root_model or (
        cfg.get('model') if previous_format is not None else None) or 'gpt-6-astra'
    require(isinstance(args.root_model, str), 'Managed root model must be a string.')
    cfg['model'] = args.root_model
    select_effort(cfg, 'model_reasoning_effort', 'root', 'medium', args)
    # Deliberately do not set provider/auth/approval/sandbox or replace root instructions.
    if 'model_verbosity' not in cfg:
        cfg['model_verbosity'] = 'low'
    if 'tool_output_token_limit' not in cfg:
        cfg['tool_output_token_limit'] = 6000
    features = table(cfg, 'features', tk)
    features['multi_agent'] = True
    existing_v2 = features.get('multi_agent_v2')
    require(previous_format is not None or not hasattr(existing_v2, 'keys'),
            'Existing [features.multi_agent_v2] table cannot be safely replaced; '
            'integrate it manually before setup.')
    if args.max_agents is None:
        old_cap_key = ('max_concurrent_threads_per_session'
                       if previous_format == 'modern' else 'max_threads')
        old_cap = agents.get(old_cap_key, 3) if previous_format else 3
        require(isinstance(old_cap, int) and not isinstance(old_cap, bool),
                'Managed child thread cap must be an integer.')
        args.max_agents = int(old_cap)
    require(1 <= args.max_agents <= 3, '--max-agents must be 1..3.')
    for key in format_keys:
        if key in agents:
            del agents[key]
    if args.config_format == 'modern':
        if hasattr(existing_v2, 'keys'):
            if 'max_concurrent_threads_per_session' in existing_v2:
                existing_v2['max_concurrent_threads_per_session'] = args.max_agents
        else:
            features['multi_agent_v2'] = False
        agents['enabled'] = True
        agents['max_concurrent_threads_per_session'] = args.max_agents
        default_subagent = args.terra_model
        if default_subagent is None and previous_format == 'modern':
            # Read the value from the original parse because managed keys were removed above.
            original_doc = parse_toml(old_config, '.codex/config.toml', tk)
            default_subagent = original_doc.get('agents', {}).get('default_subagent_model')
        agents['default_subagent_model'] = default_subagent or 'gpt-5.6-terra'
        original_doc = parse_toml(old_config, '.codex/config.toml', tk)
        original_agents = original_doc.get('agents', {})
        subagent_effort = args.effort_overrides.get(
            'subagent', original_agents.get('default_subagent_reasoning_effort', 'medium'))
        require(isinstance(subagent_effort, str) and
                re.fullmatch(r'[a-z][a-z0-9_-]{0,31}', subagent_effort),
                'Invalid reasoning effort for subagent.')
        agents['default_subagent_reasoning_effort'] = subagent_effort
        args.resolved_efforts['subagent'] = subagent_effort
    else:
        require(not hasattr(existing_v2, 'keys'),
                'Legacy format cannot safely represent [features.multi_agent_v2]; '
                'remove/integrate that table before switching formats.')
        features['multi_agent_v2'] = False
        require('subagent' not in args.effort_overrides,
                '--effort subagent=... is only supported by --config-format modern.')
        agents['max_threads'] = args.max_agents
        agents['max_depth'] = 1
    for name, (_, _, description, _) in ROLE_DATA.items():
        registration = agents.get(name)
        if registration is None:
            registration = tk.table()
            agents[name] = registration
        require(hasattr(registration, 'keys'), f'agents.{name} must be a TOML table.')
        registration['description'] = description
        registration['config_file'] = f'agents/{name}.toml'
    if 'developer_instructions' in cfg:
        warn('Existing developer_instructions preserved; review conflicts with routing rules.')
    if cfg.get('model_provider', 'openai') != 'openai':
        warn('Project uses a non-OpenAI provider; provider unchanged. Verify model IDs yourself.')
    if cfg.get('sandbox_mode') == 'read-only':
        warn('Existing root read-only sandbox preserved; writers may require approval/permissions.')

    role_dir = safe_path(root, '.codex/agents')
    if role_dir.exists():
        require(role_dir.is_dir(), '.codex/agents is not a directory.')
        for path in role_dir.glob('*.toml'):
            content = get(str(path.relative_to(root)))
            existing = parse_toml(content, str(path.relative_to(root)), tk)
            name = existing.get('name')
            require(name not in ROLE_NAMES or path.name == f'{name}.toml',
                    f'Duplicate custom name {name!r} in {path.name}; integrate manually.')

    for name, (family, effort, description, instruction) in ROLE_DATA.items():
        rel = f'.codex/agents/{name}.toml'
        old = get(rel)
        text = decode(old, rel)
        managed = text.startswith(OWNER + '\n')
        doc = parse_toml(old, rel, tk)
        explicit_model = args.terra_model if family == 'terra' else args.sol_model
        default_model = 'gpt-5.6-terra' if family == 'terra' else 'gpt-5.6-sol'
        expected_model = explicit_model or doc.get('model', default_model)
        require(isinstance(expected_model, str), f'model must be a string: {rel}')
        args.resolved_models[name] = expected_model
        require(not old or managed or args.adopt_roles,
                f'{rel} is not owned by this installer. Review it, then use --adopt-roles '
                'to merge explicitly; nothing was written.')
        require(doc.get('name', name) == name, f'Conflicting role name in {rel}.')
        doc['name'] = name
        doc['description'] = description
        doc['model'] = expected_model
        select_effort(doc, 'model_reasoning_effort', name, effort, args)
        if 'model_verbosity' not in doc:
            doc['model_verbosity'] = 'low'
        if 'tool_output_token_limit' not in doc:
            doc['tool_output_token_limit'] = 6000
        # A read-only default restricts discovery/review. Never broaden existing permissions.
        if name in ('default', 'explorer', 'reviewer'):
            doc['sandbox_mode'] = 'read-only'
        block = ROLE_BEGIN + '\n' + COMMON + instruction.strip() + '\n' + ROLE_END
        previous = doc.get('developer_instructions', '')
        require(isinstance(previous, str), f'developer_instructions must be a string: {rel}')
        merged = replace_block(str(previous), block, ROLE_BEGIN, ROLE_END, rel)
        doc['developer_instructions'] = tk.string(merged, multiline=True)
        role_agents = table(doc, 'agents', tk)
        if args.config_format == 'modern':
            role_agents['enabled'] = False
        elif 'enabled' in role_agents:
            del role_agents['enabled']
        child_features = table(doc, 'features', tk)
        child_features['multi_agent'] = False
        child_v2 = child_features.get('multi_agent_v2')
        if args.config_format == 'modern' and hasattr(child_v2, 'keys'):
            child_v2['enabled'] = False
        else:
            require(args.config_format == 'modern' or not hasattr(child_v2, 'keys'),
                    f'Legacy format cannot safely represent [features.multi_agent_v2]: {rel}')
            child_features['multi_agent_v2'] = False
        content = tk.dumps(doc)
        if not managed:
            content = OWNER + '\n' + content
        emit(rel, content.encode())

    # Write root config after role models are resolved, then preserve its marker.
    config_content = mark_config(tk.dumps(cfg), args.config_format)
    emit('.codex/config.toml', config_content.encode('utf-8'))

    # Codex prefers a non-empty root AGENTS.override.md over AGENTS.md.
    override = get('AGENTS.override.md')
    instruction_path = 'AGENTS.override.md' if override and override.strip() else 'AGENTS.md'
    text = decode(get(instruction_path), instruction_path)
    block = BEGIN + '\n' + ROOT_BODY.rstrip() + '\n' + END
    emit(instruction_path, replace_block(text, block, BEGIN, END, instruction_path).encode())
    if instruction_path != 'AGENTS.md':
        warn('Using existing non-empty AGENTS.override.md; AGENTS.md remains untouched.')

    for rel, content in {'.codex/ROUTING.md': routing_readme(args),
                         '.codex/ROUTING-SMOKE-TEST.md': SMOKE}.items():
        old = get(rel)
        require(not old or old.startswith(b'<!-- Managed by setup-codex-routing.sh v1 -->'),
                f'{rel} already exists and is not managed by this installer.')
        emit(rel, content)

    # A block appended beyond Codex's document budget would silently disappear.
    budget = cfg.get('project_doc_max_bytes', 32768)
    require(isinstance(budget, int) and not isinstance(budget, bool) and budget > 0,
            'project_doc_max_bytes must be a positive integer for these instructions.')
    require(len(desired[instruction_path]) <= budget,
            f'{instruction_path} exceeds project_doc_max_bytes ({budget}). '
            'Shorten/split instructions or explicitly adjust that budget before setup.')
    if cfg.get('profile') or cfg.get('profiles') or cfg.get('model_instructions_file'):
        warn('Profiles/custom model instructions preserved; they may override routing/effort.')
    for rel, data in desired.items():
        require(len(data) <= READ_LIMIT, f'Generated file exceeds safety limit: {rel}')
        # Prevent producing a backup that restore would reject for mode bits.
        if originals[rel] is not None:
            file_mode(safe_path(root, rel))

    # Round-trip all generated TOML, then verify routing invariants in parsed output.
    parsed = {rel: parse_toml(data, rel, tk) for rel, data in desired.items()
              if rel.endswith('.toml')}
    actual = parsed['.codex/config.toml']
    require(actual['model'] == args.root_model, 'Root model validation failed.')
    cap_key = ('max_concurrent_threads_per_session'
               if args.config_format == 'modern' else 'max_threads')
    require(actual['agents'][cap_key] == args.max_agents,
            'Concurrency validation failed.')
    for name, (family, effort, _, _) in ROLE_DATA.items():
        doc = parsed[f'.codex/agents/{name}.toml']
        require(doc['name'] == name and doc['model_reasoning_effort'] == args.resolved_efforts[name] and
                doc['model'] == args.resolved_models[name],
                f'Role validation failed: {name}')
        v2 = doc['features']['multi_agent_v2']
        disabled_v2 = not v2.get('enabled', True) if hasattr(v2, 'keys') else not v2
        modern_disabled = (args.config_format != 'modern' or not doc['agents']['enabled'])
        require(modern_disabled and not doc['features']['multi_agent'] and
                disabled_v2,
                f'Child delegation must be disabled: {name}')
    changes = {rel: data for rel, data in desired.items() if originals[rel] != data}
    return originals, changes


@contextlib.contextmanager
def repo_lock(gitdir):
    path = gitdir / 'codex-routing-setup.lock'
    require(not path.is_symlink(), f'Refusing symlink: {path}')
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode) and os.fstat(fd).st_nlink == 1,
                'Unsafe installer lock file.')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SetupError('Another routing installer is active in this repository.')
        yield
    finally:
        os.close(fd)


def atomic_write(path, data, mode):
    require(type(mode) is int and 0 <= mode <= 0o777, f'Unsafe file mode: {path}')
    with parent_fd(path, create=True) as (directory, name):
        temporary = '.' + name + '.' + secrets.token_hex(10)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        fd = os.open(temporary, flags, 0o600, dir_fd=directory)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fchmod(stream.fileno(), mode)
                os.fsync(stream.fileno())
            # Reject newly introduced non-regular/hard-linked targets too.
            try:
                checked_stat(os.stat(name, dir_fd=directory, follow_symlinks=False), path)
            except FileNotFoundError:
                pass
            os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
            sync_directory(directory)
        finally:
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass


def write_state(backup, state):
    require(state in ('PREPARED', 'COMMITTED', 'ROLLED_BACK', 'RECOVERY_REQUIRED',
                      'RESTORING', 'RESTORED'), 'Invalid transaction state.')
    atomic_write(backup / 'transaction.json',
                 (json.dumps({'state': state}) + '\n').encode(), 0o600)


def get_state(backup):
    raw = read_regular(safe_path(backup, 'transaction.json'))
    if raw is None:
        return 'LEGACY'  # v1.0 backups did not record transaction outcome.
    info = json.loads(raw)
    require(isinstance(info, dict) and info.get('state') in
            ('PREPARED', 'COMMITTED', 'ROLLED_BACK', 'RECOVERY_REQUIRED',
             'RESTORING', 'RESTORED'), 'Malformed backup transaction state.')
    return info['state']


def attempt_state(backup, state):
    try:
        write_state(backup, state)
    except Exception:
        warn('Could not persist transaction state; inspect backup: ' + str(backup))


def ensure_unchanged(path, expected, mode=None):
    require(read_regular(path) == expected, f'Concurrent edit detected: {path.name}')
    if expected is not None and mode is not None:
        require(file_mode(path) == mode, f'Concurrent permission change: {path.name}')


def rollback(root, attempted):
    """Restore attempted writes without clobbering a later editor's changes."""
    complete = True
    for rel, before, after, mode in reversed(attempted):
        try:
            path = safe_path(root, rel)
            current = read_regular(path)
            if current == before:
                if before is not None:
                    require(file_mode(path) == mode, f'Concurrent permission change: {rel}')
                continue
            ensure_unchanged(path, after, mode if after is not None else None)
            if before is None:
                remove_regular(path)
            else:
                atomic_write(path, before, mode)
        except Exception:
            complete = False
            warn(f'Rollback could not safely restore {rel}; inspect the retained backup.')
    return complete


def apply_changes(root, gitdir, originals, changes):
    for rel, before in originals.items():
        require(read_regular(safe_path(root, rel)) == before,
                f'{rel} changed during planning. Stop writers and rerun.')
    if not changes:
        print('ALREADY_CONFIGURED: no file changes and no new backup.')
        return
    modes = {rel: file_mode(safe_path(root, rel)) if originals[rel] is not None
             else 0o644 for rel in changes}
    store = safe_path(gitdir, 'codex-routing-backups')
    store.mkdir(mode=0o700, exist_ok=True)
    os.chmod(store, 0o700)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    backup = store / stamp
    backup.mkdir(mode=0o700)
    entries = []
    for rel, after in changes.items():
        before = originals[rel]
        entries.append(dict(path=rel, before=digest(before), after=digest(after), mode=modes[rel]))
        if before is not None:
            atomic_write(backup / 'files' / rel, before, 0o600)
    manifest = dict(version=VERSION, manifest_format=MANIFEST_FORMAT,
                    repository=str(root), files=entries)
    atomic_write(backup / 'manifest.json',
                 (json.dumps(manifest, indent=2) + '\n').encode(), 0o600)
    write_state(backup, 'PREPARED')
    attempted = []
    try:
        for entry in entries:
            rel = entry['path']
            target = safe_path(root, rel)
            ensure_unchanged(target, originals[rel], entry['mode'])
            # Record before the write: an error after replace/fsync still needs rollback.
            attempted.append((rel, originals[rel], changes[rel], entry['mode']))
            atomic_write(target, changes[rel], entry['mode'])
        # Ensure no earlier written file changed before declaring success.
        for entry in entries:
            ensure_unchanged(safe_path(root, entry['path']), changes[entry['path']], entry['mode'])
        write_state(backup, 'COMMITTED')
    except BaseException:
        complete = rollback(root, attempted)
        attempt_state(backup, 'ROLLED_BACK' if complete else 'RECOVERY_REQUIRED')
        warn(f'Backup retained: {backup}')
        raise
    print('CONFIG_SYNTAX_VALIDATED: ' + str(len(changes)) + ' files written.')
    print('BACKUP: ' + str(backup))
    print('RESTORE: bash setup-codex-routing.sh --repo ' + shlex.quote(str(root)) +
          ' --restore ' + shlex.quote(stamp))
    print('RUNTIME_UNVERIFIED: open a NEW trusted Codex session, select the configured '
          'root model/effort and run .codex/ROUTING-SMOKE-TEST.md.')


def restore(root, gitdir, selected, dry_run):
    store = safe_path(gitdir, 'codex-routing-backups')
    require(store.is_dir(), 'No backup directory for this repository.')
    pattern = r'\d{8}T\d{6}\.\d{6}Z'
    if selected == 'latest':
        candidates = []
        for path in sorted(store.iterdir()):
            if not re.fullmatch(pattern, path.name):
                continue
            path = safe_path(store, path.name)
            require(path.is_dir(), f'Invalid backup directory: {path.name}')
            state = get_state(path)
            if state != 'ROLLED_BACK':
                # Missing/corrupt manifests are not silently skipped: an interrupted
                # preparation should be inspected, rather than undoing an older setup.
                candidates.append(path.name)
        if not candidates:
            print('ALREADY_RESTORED: no pending backups.')
            return
        selected = candidates[-1]
    require(bool(re.fullmatch(pattern, selected)),
            '--restore takes latest or the timestamp printed during installation.')
    backup = safe_path(gitdir, 'codex-routing-backups/' + selected)
    manifest = json.loads(read_regular(safe_path(backup, 'manifest.json')) or b'{}')
    require(isinstance(manifest, dict), 'Malformed backup manifest.')
    version = manifest.get('version')
    compatible = (version == '1.0.0' and 'manifest_format' not in manifest) or (
        isinstance(version, str) and version.startswith('1.') and
        type(manifest.get('manifest_format')) is int and
        manifest['manifest_format'] == MANIFEST_FORMAT)
    require(compatible and manifest.get('repository') == str(root),
            'Backup format/repository mismatch.')
    state = get_state(backup)
    jobs, seen = [], set()
    entries = manifest.get('files')
    require(isinstance(entries, list) and 0 < len(entries) <= len(ALLOWED),
            'Malformed backup file list.')
    for entry in entries:
        require(isinstance(entry, dict), 'Malformed backup entry.')
        rel = entry.get('path')
        require(isinstance(rel, str) and rel in ALLOWED and rel not in seen,
                'Unsafe/duplicate backup path.')
        seen.add(rel)
        before_hash, after_hash = entry.get('before'), entry.get('after')
        for value, nullable in ((before_hash, True), (after_hash, False)):
            require((nullable and value is None) or
                    (isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value)),
                    'Malformed backup hash.')
        mode = entry.get('mode')
        require(type(mode) is int and 0 <= mode <= 0o777, 'Unsafe backup file mode.')
        path = safe_path(root, rel)
        current = read_regular(path)
        require(digest(current) in (before_hash, after_hash),
                f'{rel} changed after installation; restore refuses to overwrite it.')
        if current is not None:
            require(file_mode(path) == mode,
                    f'{rel} permissions changed after installation; restore refuses to overwrite them.')
        old = None
        if before_hash is not None:
            old = read_regular(safe_path(backup, 'files/' + rel))
            require(old is not None and digest(old) == before_hash,
                    f'Corrupt/missing backup content: {rel}')
        if digest(current) != before_hash:
            jobs.append((rel, current, old, mode))
    for rel, _, old, _ in jobs:
        print(('REMOVE ' if old is None else 'RESTORE ') + rel)
    if dry_run:
        print('DRY_RUN: no repository or backup files changed.')
        return
    attempted = []
    if jobs:
        write_state(backup, 'RESTORING')
        try:
            for rel, current, old, mode in jobs:
                path = safe_path(root, rel)
                ensure_unchanged(path, current, mode)
                attempted.append((rel, current, old, mode))
                if old is None:
                    remove_regular(path)
                else:
                    atomic_write(path, old, mode)
            for rel, _, old, mode in jobs:
                ensure_unchanged(safe_path(root, rel), old, mode)
            write_state(backup, 'RESTORED')
        except BaseException:
            complete = rollback(root, attempted)
            # Restore the previous state, including uncertain/in-progress states.
            previous = 'COMMITTED' if state == 'LEGACY' else state
            attempt_state(backup, previous if complete else 'RECOVERY_REQUIRED')
            warn(f'Restore failed; backup retained: {backup}')
            raise
    elif state != 'RESTORED':
        write_state(backup, 'RESTORED')
    print('RESTORED: ' + str(len(jobs)) + ' files. Backup retained: ' + str(backup))


def main():
    parser = argparse.ArgumentParser(
        prog='setup-codex-routing.sh',
        description='Set up repository-local Astra -> Terra -> Sol routing. '
                    'Default action: apply. Stop active writers first.',
        epilog='No global configuration/auth changes or model calls. '
               'A hash-pinned parser may be fetched into temp unless --offline is set.')
    parser.add_argument('--repo', default='.', help='Any directory inside the target Git repository')
    parser.add_argument('--dry-run', action='store_true', help='Plan only; no repository/backup writes')
    parser.add_argument('--offline', action='store_true', help='Never download the TOML parser')
    parser.add_argument('--adopt-roles', action='store_true',
                        help='Explicitly merge into existing canonical role files (backup first)')
    parser.add_argument('--config-format', choices=('modern', 'legacy'),
                        help='modern (default/current Codex) or legacy (older V1 clients). '
                             'Managed reinstalls preserve their selected format.')
    parser.add_argument('--root-model',
                        help='Root model (fresh default: gpt-6-astra; managed value preserved)')
    parser.add_argument('--terra-model',
                        help='Terra role model (fresh default: gpt-5.6-terra; managed values preserved)')
    parser.add_argument('--sol-model',
                        help='Sol role model (fresh default: gpt-5.6-sol; managed values preserved)')
    parser.add_argument('--max-agents', type=int,
                        help='Maximum open child threads, 1..3 (fresh default: 3; managed value preserved)')
    parser.add_argument('--effort', action='append', default=[], metavar='ROLE=LEVEL',
                        help='Repeatable explicit effort override: root, subagent or a role. '
                             'Omitted efforts preserve existing values; new defaults are medium/low/high.')
    parser.add_argument('--version', action='version', version=VERSION)
    parser.add_argument('--restore', metavar='TIMESTAMP|latest', help='Restore a matching local backup')
    args = parser.parse_args()
    require(sys.version_info >= (3, 9), 'Python 3.9+ is required.')
    require(all(hasattr(os, name) for name in ('O_NOFOLLOW', 'O_DIRECTORY')),
            'A POSIX filesystem environment (macOS/Linux/WSL) is required.')
    args.effort_overrides = {}
    for setting in args.effort:
        target, separator, level = setting.partition('=')
        require(separator and target in ('root', 'subagent') + ROLE_NAMES and
                re.fullmatch(r'[a-z][a-z0-9_-]{0,31}', level),
                'Use --effort ROLE=LEVEL, e.g. --effort root=high.')
        require(target not in args.effort_overrides, f'Duplicate effort override: {target}')
        args.effort_overrides[target] = level
    require(not args.restore or not args.effort_overrides,
            '--effort cannot be combined with --restore.')
    require(not args.restore or args.config_format is None,
            '--config-format cannot be combined with --restore.')
    require(args.max_agents is None or 1 <= args.max_agents <= 3,
            '--max-agents must be 1..3.')
    for value in (args.root_model, args.terra_model, args.sol_model):
        require(value is None or bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}', value)),
                'Invalid model identifier.')
    given = Path(args.repo).expanduser().resolve(strict=True)
    require(given.is_dir(), '--repo must point to a directory.')
    require(git(given, 'rev-parse', '--is-inside-work-tree') == 'true',
            'Target must be a non-bare Git working tree.')
    root = Path(git(given, 'rev-parse', '--show-toplevel')).resolve()
    gitdir = Path(git(root, 'rev-parse', '--absolute-git-dir')).resolve()
    print('REPOSITORY: ' + str(root))
    if args.restore:
        with contextlib.nullcontext() if args.dry_run else repo_lock(gitdir):
            restore(root, gitdir, args.restore, args.dry_run)
        return
    tk = load_tomlkit(args.offline)
    # Planning is read-only. Invalid input therefore fails before the lock file or
    # backup metadata is created; apply_changes rechecks every planned original.
    originals, changes = plan(root, args, tk)
    with contextlib.nullcontext() if args.dry_run else repo_lock(gitdir):
        for rel in changes:
            print(('CREATE ' if originals[rel] is None else 'UPDATE ') + rel)
        terra_models = sorted({args.resolved_models[name]
                               for name in ('default', 'explorer', 'worker', 'verifier')})
        sol_models = sorted({args.resolved_models[name] for name in ('senior', 'reviewer')})
        print('CONFIG_FORMAT: ' + args.config_format +
              (' (current Codex schema)' if args.config_format == 'modern'
               else ' (older V1 Codex schema; not for V2 routing)'))
        print('ROUTING: ' + args.root_model + ' -> ' + '/'.join(terra_models) +
              ' -> ' + '/'.join(sol_models))
        print('EFFORT: ' + ', '.join(k + '=' + v for k, v in args.resolved_efforts.items()))
        print('Root permissions/provider/auth/global configuration remain unchanged. '
              'Review inherited settings and existing instructions.')
        if args.dry_run:
            print('DRY_RUN: no repository or backup files changed; '
                  f'{len(changes)} planned writes. Runtime/model access not tested.')
        else:
            apply_changes(root, gitdir, originals, changes)


def interrupted(signum, frame):
    raise KeyboardInterrupt

if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except KeyboardInterrupt:
        print('INTERRUPTED: inspect backup/status before restarting.', file=sys.stderr)
        sys.exit(130)
    except (SetupError, OSError, ValueError, subprocess.SubprocessError) as error:
        print('ERROR: ' + str(error), file=sys.stderr)
        sys.exit(1)
PY
