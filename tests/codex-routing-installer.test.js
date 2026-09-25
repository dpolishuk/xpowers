const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = path.resolve(__dirname, '..')
const INSTALLER = path.join(ROOT, 'scripts', 'setup-codex-routing.sh')
const PYTHON = process.env.PYTHON_BIN || 'python3'
const ROLES = ['default', 'explorer', 'worker', 'verifier', 'senior', 'reviewer']

const FAULT_HARNESS = String.raw`
import errno
import json
from pathlib import Path
import sys

installer = Path(sys.argv[1])
root = Path(sys.argv[2]).resolve()
scenario = sys.argv[3]
source = installer.read_text()
payload = source[source.index('from __future__'):source.rindex('\nPY\n')]
namespace = {'__name__': 'codex_routing_fault_test'}
exec(compile(payload, str(installer), 'exec'), namespace)

gitdir = Path(namespace['git'](root, 'rev-parse', '--absolute-git-dir')).resolve()
originals = {
    '.codex/config.toml': b'config-before\n',
    'AGENTS.md': b'agents-before\n',
}
installed = {
    '.codex/config.toml': b'config-installed\n',
    'AGENTS.md': b'agents-installed\n',
}
modes = {'.codex/config.toml': 0o600, 'AGENTS.md': 0o640}
for relative, data in originals.items():
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    target.chmod(modes[relative])

real_atomic_write = namespace['atomic_write']

def backup_dir():
    backups = sorted((gitdir / 'codex-routing-backups').iterdir())
    assert len(backups) == 1, backups
    return backups[0]

def transaction_state():
    return json.loads((backup_dir() / 'transaction.json').read_text())['state']

if scenario == 'apply-rollback':
    def fail_second_target(path, data, mode):
        if Path(path) == root / 'AGENTS.md':
            raise OSError(errno.ENOSPC, 'injected apply failure')
        return real_atomic_write(path, data, mode)
    namespace['atomic_write'] = fail_second_target
    try:
        namespace['apply_changes'](root, gitdir, originals, installed)
        raise AssertionError('apply unexpectedly succeeded')
    except OSError as error:
        assert error.errno == errno.ENOSPC
    for relative, data in originals.items():
        target = root / relative
        assert target.read_bytes() == data
        assert target.stat().st_mode & 0o777 == modes[relative]
    assert transaction_state() == 'ROLLED_BACK'

elif scenario in ('restore-rollback', 'restore-concurrent-edit'):
    namespace['apply_changes'](root, gitdir, originals, installed)
    before_restore = {
        relative: ((root / relative).read_bytes(),
                   (root / relative).stat().st_mode & 0o777)
        for relative in installed
    }

    def fail_second_restore(path, data, mode):
        if Path(path) == root / 'AGENTS.md':
            if scenario == 'restore-concurrent-edit':
                real_atomic_write(path, b'later-user-edit\n', 0o600)
            raise OSError(errno.ENOSPC, 'injected restore failure')
        return real_atomic_write(path, data, mode)
    namespace['atomic_write'] = fail_second_restore
    try:
        namespace['restore'](root, gitdir, backup_dir().name, False)
        raise AssertionError('restore unexpectedly succeeded')
    except OSError as error:
        assert error.errno == errno.ENOSPC

    config_data, config_mode = before_restore['.codex/config.toml']
    assert (root / '.codex/config.toml').read_bytes() == config_data
    assert (root / '.codex/config.toml').stat().st_mode & 0o777 == config_mode
    if scenario == 'restore-rollback':
        for relative, (data, mode) in before_restore.items():
            target = root / relative
            assert target.read_bytes() == data
            assert target.stat().st_mode & 0o777 == mode
        assert transaction_state() == 'COMMITTED'
    else:
        assert (root / 'AGENTS.md').read_bytes() == b'later-user-edit\n'
        assert (root / 'AGENTS.md').stat().st_mode & 0o777 == 0o600
        assert transaction_state() == 'RECOVERY_REQUIRED'
else:
    raise AssertionError(f'unknown scenario: {scenario}')
`

function makeRepo(t) {
  const repo = mkdtempSync(path.join(tmpdir(), 'xpowers-codex-routing-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', repo])
  return repo
}

function run(repo, args = [], extraEnv = {}) {
  return spawnSync('bash', [INSTALLER, '--repo', repo, '--offline', ...args], {
    encoding: 'utf8', env: { ...process.env, PYTHON_BIN: PYTHON, ...extraEnv },
  })
}

function runFaultHarness(t, scenario) {
  const repo = makeRepo(t)
  return spawnSync(PYTHON, ['-I', '-c', FAULT_HARNESS, INSTALLER, repo, scenario], {
    encoding: 'utf8',
  })
}

function write(repo, relative, contents, mode) {
  const target = path.join(repo, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, contents)
  if (mode !== undefined) chmodSync(target, mode)
  return target
}

function parseToml(repo, relative) {
  const code = [
    'import json, pathlib, sys, tomlkit',
    'doc = tomlkit.parse(pathlib.Path(sys.argv[1]).read_text())',
    'print(json.dumps(doc.unwrap()))',
  ].join('; ')
  return JSON.parse(execFileSync(PYTHON, ['-I', '-c', code, path.join(repo, relative)], {
    encoding: 'utf8',
  }))
}

function snapshot(directory) {
  if (!existsSync(directory)) return null
  const result = {}
  function visit(current, relative) {
    for (const entry of readdirSync(current).sort()) {
      const absolute = path.join(current, entry)
      const name = relative ? `${relative}/${entry}` : entry
      const info = lstatSync(absolute)
      if (info.isDirectory()) {
        result[`${name}/`] = info.mode & 0o777
        visit(absolute, name)
      } else if (info.isSymbolicLink()) {
        result[name] = `symlink:${require('node:fs').readlinkSync(absolute)}`
      } else {
        result[name] = crypto.createHash('sha256').update(readFileSync(absolute)).digest('hex')
      }
    }
  }
  visit(directory, '')
  return result
}

function gitDir(repo) {
  return execFileSync('git', ['-C', repo, 'rev-parse', '--absolute-git-dir'], {
    encoding: 'utf8',
  }).trim()
}

function backups(repo) {
  const directory = path.join(gitDir(repo), 'codex-routing-backups')
  return existsSync(directory) ? readdirSync(directory).sort() : []
}

function assertRoleConfig(repo, format) {
  const expected = {
    default: ['gpt-5.6-terra', 'low'], explorer: ['gpt-5.6-terra', 'low'],
    worker: ['gpt-5.6-terra', 'medium'], verifier: ['gpt-5.6-terra', 'medium'],
    senior: ['gpt-5.6-sol', 'high'], reviewer: ['gpt-5.6-sol', 'high'],
  }
  for (const role of ROLES) {
    const doc = parseToml(repo, `.codex/agents/${role}.toml`)
    assert.equal(doc.model, expected[role][0], role)
    assert.equal(doc.model_reasoning_effort, expected[role][1], role)
    assert.equal(doc.features.multi_agent, false, role)
    assert.equal(doc.features.multi_agent_v2, false, role)
    assert.match(doc.developer_instructions, /Do not launch subagents/)
    if (format === 'modern') assert.equal(doc.agents.enabled, false, role)
    else assert.equal(doc.agents?.enabled, undefined, role)
  }
}

test.before(() => {
  execFileSync(PYTHON, ['-I', '-c', 'import tomlkit'], { stdio: 'pipe' })
})

test('fresh install creates the modern six-role routing configuration', (t) => {
  const repo = makeRepo(t)
  const result = run(repo)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /CONFIG_FORMAT: modern/)
  const config = parseToml(repo, '.codex/config.toml')
  assert.equal(config.model, 'gpt-6-astra')
  assert.equal(config.model_reasoning_effort, 'medium')
  assert.equal(config.features.multi_agent, true)
  assert.equal(config.features.multi_agent_v2, false)
  assert.equal(config.agents.enabled, true)
  assert.equal(config.agents.max_concurrent_threads_per_session, 3)
  assert.equal(config.agents.default_subagent_model, 'gpt-5.6-terra')
  assert.equal(config.agents.default_subagent_reasoning_effort, 'medium')
  for (const role of ROLES) {
    assert.equal(config.agents[role].config_file, `agents/${role}.toml`)
    assert.equal(typeof config.agents[role].description, 'string')
  }
  assertRoleConfig(repo, 'modern')
})

test('legacy format uses V1 fields, persists, and converts explicitly', (t) => {
  const repo = makeRepo(t)
  let result = run(repo, ['--config-format', 'legacy'])
  assert.equal(result.status, 0, result.stderr)
  let config = parseToml(repo, '.codex/config.toml')
  assert.equal(config.agents.max_threads, 3)
  assert.equal(config.agents.max_depth, 1)
  assert.equal(config.agents.enabled, undefined)
  assert.equal(config.agents.max_concurrent_threads_per_session, undefined)
  assertRoleConfig(repo, 'legacy')

  const before = readFileSync(path.join(repo, '.codex/config.toml'))
  const count = backups(repo).length
  result = run(repo)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /CONFIG_FORMAT: legacy/)
  assert.deepEqual(readFileSync(path.join(repo, '.codex/config.toml')), before)
  assert.equal(backups(repo).length, count)

  result = run(repo, ['--config-format', 'modern'])
  assert.equal(result.status, 0, result.stderr)
  config = parseToml(repo, '.codex/config.toml')
  assert.equal(config.agents.max_threads, undefined)
  assert.equal(config.agents.max_depth, undefined)
  assert.equal(config.agents.max_concurrent_threads_per_session, 3)
  assertRoleConfig(repo, 'modern')
})

test('reinstall preserves explicitly configured models, efforts, cap, and format', (t) => {
  const repo = makeRepo(t)
  let result = run(repo, ['--config-format', 'legacy'])
  assert.equal(result.status, 0, result.stderr)
  const configPath = path.join(repo, '.codex/config.toml')
  let configText = readFileSync(configPath, 'utf8')
    .replace('model = "gpt-6-astra"', 'model = "custom/astra"')
    .replace('model_reasoning_effort = "medium"', 'model_reasoning_effort = "high"')
    .replace('max_threads = 3', 'max_threads = 2')
  writeFileSync(configPath, configText)
  const workerPath = path.join(repo, '.codex/agents/worker.toml')
  writeFileSync(workerPath, readFileSync(workerPath, 'utf8')
    .replace('model = "gpt-5.6-terra"', 'model = "custom/terra"')
    .replace('model_reasoning_effort = "medium"', 'model_reasoning_effort = "low"'))
  const seniorPath = path.join(repo, '.codex/agents/senior.toml')
  writeFileSync(seniorPath, readFileSync(seniorPath, 'utf8')
    .replace('model = "gpt-5.6-sol"', 'model = "custom/sol"'))
  result = run(repo)
  assert.equal(result.status, 0, result.stderr)
  const config = parseToml(repo, '.codex/config.toml')
  assert.equal(config.model, 'custom/astra')
  assert.equal(config.model_reasoning_effort, 'high')
  assert.equal(config.agents.max_threads, 2)
  assert.equal(parseToml(repo, '.codex/agents/worker.toml').model, 'custom/terra')
  assert.equal(parseToml(repo, '.codex/agents/worker.toml').model_reasoning_effort, 'low')
  assert.equal(parseToml(repo, '.codex/agents/senior.toml').model, 'custom/sol')
})

test('dry-run leaves repository and Git metadata byte-for-byte unchanged', (t) => {
  const repo = makeRepo(t)
  write(repo, 'tracked.txt', 'unchanged\n')
  const repoBefore = snapshot(repo)
  const gitBefore = snapshot(path.join(repo, '.git'))
  const result = run(repo, ['--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /DRY_RUN:/)
  assert.deepEqual(snapshot(repo), repoBefore)
  assert.deepEqual(snapshot(path.join(repo, '.git')), gitBefore)
})

test('preserves TOML comments, user text, role keys, and prefers nonempty override', (t) => {
  const repo = makeRepo(t)
  write(repo, '.codex/config.toml', '# keep this comment\napproval_policy = "on-request"\n[custom]\nanswer = 42\n')
  write(repo, '.codex/agents/worker.toml', [
    'custom_key = "keep"',
    'developer_instructions = "user worker text"',
    '[features.multi_agent_v2]',
    'max_concurrent_threads_per_session = 2',
    '',
  ].join('\n'))
  write(repo, 'AGENTS.md', 'base instructions\n')
  write(repo, 'AGENTS.override.md', 'override instructions\n')
  let result = run(repo)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--adopt-roles/)
  assert.match(readFileSync(path.join(repo, '.codex/agents/worker.toml'), 'utf8'),
    /max_concurrent_threads_per_session = 2/)

  result = run(repo, ['--adopt-roles'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(path.join(repo, '.codex/config.toml'), 'utf8'), /# keep this comment/)
  assert.equal(parseToml(repo, '.codex/config.toml').custom.answer, 42)
  const worker = parseToml(repo, '.codex/agents/worker.toml')
  assert.equal(worker.custom_key, 'keep')
  assert.match(worker.developer_instructions, /^user worker text/)
  assert.equal(worker.features.multi_agent_v2.max_concurrent_threads_per_session, 2)
  assert.equal(worker.features.multi_agent_v2.enabled, false)
  assert.equal(readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), 'base instructions\n')
  assert.match(readFileSync(path.join(repo, 'AGENTS.override.md'), 'utf8'), /^override instructions/)
  const count = backups(repo).length
  result = run(repo)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /ALREADY_CONFIGURED/)
  assert.equal(backups(repo).length, count)
})

test('malformed TOML and managed markers fail without persistent writes', (t) => {
  for (const setup of [
    (repo) => write(repo, '.codex/config.toml', '[broken\n'),
    (repo) => write(repo, '.codex/config.toml',
      '# Managed by setup-codex-routing.sh v1; config-format=future\n'),
    (repo) => write(repo, 'AGENTS.md', '<!-- BEGIN codex-astra-terra-sol v1 -->\nmissing end\n'),
  ]) {
    const repo = makeRepo(t)
    setup(repo)
    const before = snapshot(repo)
    const result = run(repo)
    assert.notEqual(result.status, 0)
    assert.deepEqual(snapshot(repo), before)
  }
})

test('backup restore recovers exact bytes and modes and refuses later edits', (t) => {
  const repo = makeRepo(t)
  const originalConfig = '# original\napproval_policy = "never"\n'
  const originalAgents = 'original agent instructions\n'
  write(repo, '.codex/config.toml', originalConfig, 0o600)
  write(repo, 'AGENTS.md', originalAgents, 0o640)
  let result = run(repo)
  assert.equal(result.status, 0, result.stderr)
  result = run(repo, ['--restore', 'latest'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(path.join(repo, '.codex/config.toml'), 'utf8'), originalConfig)
  assert.equal(readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), originalAgents)
  assert.equal(statSync(path.join(repo, '.codex/config.toml')).mode & 0o777, 0o600)
  assert.equal(statSync(path.join(repo, 'AGENTS.md')).mode & 0o777, 0o640)
  assert.equal(existsSync(path.join(repo, '.codex/agents/worker.toml')), false)

  result = run(repo)
  assert.equal(result.status, 0, result.stderr)
  chmodSync(path.join(repo, '.codex/agents/worker.toml'), 0o600)
  let refused = run(repo, ['--restore', 'latest'])
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /permissions changed after installation/)
  chmodSync(path.join(repo, '.codex/agents/worker.toml'), 0o644)
  writeFileSync(path.join(repo, '.codex/agents/worker.toml'), 'later user edit\n')
  result = run(repo, ['--restore', 'latest'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /changed after installation/)
  assert.equal(readFileSync(path.join(repo, '.codex/agents/worker.toml'), 'utf8'), 'later user edit\n')
})

test('mid-apply failure rolls back earlier writes and records a completed rollback', (t) => {
  const result = runFaultHarness(t, 'apply-rollback')
  assert.equal(result.status, 0, result.stderr)
})

test('mid-restore failure returns the full installed snapshot and committed state', (t) => {
  const result = runFaultHarness(t, 'restore-rollback')
  assert.equal(result.status, 0, result.stderr)
})

test('restore rollback preserves a concurrent edit and marks recovery required', (t) => {
  const result = runFaultHarness(t, 'restore-concurrent-edit')
  assert.equal(result.status, 0, result.stderr)
})

test('modern rerun preserves compatible V2 table settings and aligns its cap', (t) => {
  const repo = makeRepo(t)
  let result = run(repo)
  assert.equal(result.status, 0, result.stderr)
  const configPath = path.join(repo, '.codex/config.toml')
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(
    'multi_agent_v2 = false',
    '[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 99',
  ))
  result = run(repo, ['--max-agents', '2'])
  assert.equal(result.status, 0, result.stderr)
  const config = parseToml(repo, '.codex/config.toml')
  assert.equal(config.features.multi_agent_v2.enabled, true)
  assert.equal(config.features.multi_agent_v2.max_concurrent_threads_per_session, 2)

  const before = readFileSync(configPath)
  result = run(repo, ['--config-format', 'legacy'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /cannot safely represent/)
  assert.deepEqual(readFileSync(configPath), before)
})

test('refuses to adopt unmanaged routing scalar keys implicitly', (t) => {
  const repo = makeRepo(t)
  write(repo, '.codex/config.toml', '[agents]\nmax_threads = 2\n')
  const before = snapshot(repo)
  const result = run(repo, ['--config-format', 'modern'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /refusing broad adoption/)
  assert.deepEqual(snapshot(repo), before)
})

test('restore refuses corrupt backup content', (t) => {
  const repo = makeRepo(t)
  write(repo, 'AGENTS.md', 'original\n')
  const result = run(repo)
  assert.equal(result.status, 0, result.stderr)
  const backup = path.join(gitDir(repo), 'codex-routing-backups', backups(repo)[0])
  writeFileSync(path.join(backup, 'files', 'AGENTS.md'), 'corrupt\n')
  const restore = run(repo, ['--restore', 'latest'])
  assert.notEqual(restore.status, 0)
  assert.match(restore.stderr, /Corrupt\/missing backup content/)
})

test('rejects symlink traversal and ambiguous custom-role collisions', (t) => {
  const repo = makeRepo(t)
  const outside = mkdtempSync(path.join(tmpdir(), 'xpowers-routing-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  symlinkSync(outside, path.join(repo, '.codex'))
  let result = run(repo)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Refusing symlink/)
  assert.deepEqual(readdirSync(outside), [])

  rmSync(path.join(repo, '.codex'))
  write(repo, '.codex/agents/alias.toml', 'name = "worker"\n')
  result = run(repo)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Duplicate custom name/)
  assert.equal(existsSync(path.join(repo, '.codex/config.toml')), false)
})

test('supports Git worktrees and ignores redirected Git environment', (t) => {
  const main = makeRepo(t)
  write(main, 'tracked.txt', 'base\n')
  execFileSync('git', ['-C', main, 'add', 'tracked.txt'])
  execFileSync('git', ['-C', main, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    'commit', '-qm', 'base'])
  const worktree = mkdtempSync(path.join(tmpdir(), 'xpowers-routing-worktree-'))
  rmSync(worktree, { recursive: true, force: true })
  t.after(() => rmSync(worktree, { recursive: true, force: true }))
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'routing-test', worktree])
  const result = run(worktree, ['--config-format', 'legacy'], {
    GIT_DIR: path.join(main, 'does-not-exist'), GIT_WORK_TREE: main,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(parseToml(worktree, '.codex/config.toml').agents.max_depth, 1)
  assert.equal(existsSync(path.join(main, '.codex/config.toml')), false)
  assert.equal(backups(worktree).length, 1)
})

test('caps child threads at three and reports format compatibility in help', (t) => {
  const repo = makeRepo(t)
  const result = run(repo, ['--max-agents', '4'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /1\.\.3/)
  const help = spawnSync('bash', [INSTALLER, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /--config-format.*modern.*legacy/s)
  assert.match(help.stdout, /modern.*current/s)
  assert.match(help.stdout, /legacy.*V1/s)
})
