#!/usr/bin/env node

"use strict"

const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFileSync, spawn } = require("node:child_process")

const RUNTIME_VERSION = 1
const POLICY_RELATIVE_PATH = path.join(".xpowers", "acceptance.json")
const MAX_POLICY_BYTES = 256 * 1024
const MAX_RECEIPT_BYTES = 512 * 1024
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_CHECKS = 32
const MAX_COMMAND_PARTS = 64
const MAX_ARGUMENT_BYTES = 4096
const MAX_TIMEOUT_MS = 10 * 60 * 1000
const MAX_CHECK_OUTPUT_BYTES = 64 * 1024
const MAX_STORED_STREAM_BYTES = 4096
const TASK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CHECK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const FORBIDDEN_GIT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"]
const FORBIDDEN_BACKEND_ENV = ["BD_DB", "BD_DATABASE", "BEADS_DIR"]

class AcceptanceError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = "AcceptanceError"
    this.exitCode = exitCode
  }
}

function fail(message, exitCode = 1) {
  throw new AcceptanceError(message, exitCode)
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function assertTaskId(task) {
  if (typeof task !== "string" || !TASK_PATTERN.test(task)) {
    fail(`invalid task id ${JSON.stringify(task)}`, 2)
  }
}

function gitOutput(root, args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: options.encoding === null ? null : "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : String(error.stderr || "")
    fail(`Git inspection failed: ${stderr.trim() || error.message}`)
  }
}

function resolveGitContext(requestedRoot) {
  for (const name of FORBIDDEN_GIT_ENV) {
    if (process.env[name]) fail(`${name} is unsupported while acceptance policy is enabled`)
  }
  for (const name of FORBIDDEN_BACKEND_ENV) {
    if (process.env[name]) fail(`${name} is unsupported while acceptance policy is enabled`)
  }
  const candidate = path.resolve(requestedRoot || process.cwd())
  const root = fs.realpathSync(candidate)
  const gitRoot = fs.realpathSync(gitOutput(root, ["rev-parse", "--show-toplevel"]).trim())
  if (root !== gitRoot) fail(`acceptance root mismatch: expected ${root}, Git selected ${gitRoot}`)
  const gitDir = fs.realpathSync(gitOutput(root, ["rev-parse", "--absolute-git-dir"]).trim())
  const commonText = gitOutput(root, ["rev-parse", "--git-common-dir"]).trim()
  const commonDir = fs.realpathSync(path.resolve(root, commonText))
  const head = gitOutput(root, ["rev-parse", "--verify", "HEAD"]).trim()
  return { root, gitDir, commonDir, head }
}

function lstatSafe(file) {
  try {
    return fs.lstatSync(file)
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

function readRegularFileNoFollow(file, maxBytes, label, validateCanonical) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  let descriptor
  try {
    descriptor = fs.openSync(file, flags)
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) fail(`${label} must be a regular file`)
    if (stat.size > maxBytes) fail(`${label} exceeds size limit`)
    const canonical = fs.realpathSync(file)
    if (validateCanonical) validateCanonical(canonical)
    const current = fs.statSync(canonical)
    if (current.dev !== stat.dev || current.ino !== stat.ino) fail(`${label} changed while it was being inspected`)
    return { bytes: fs.readFileSync(descriptor), stat, canonical }
  } catch (error) {
    if (error instanceof AcceptanceError) throw error
    fail(`${label} could not be read safely: ${error.message}`)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function ensurePrivateDirectory(parent, name) {
  const target = path.join(parent, name)
  const stat = lstatSafe(target)
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`unsafe acceptance storage path: ${target}`)
  } else {
    fs.mkdirSync(target, { mode: 0o700 })
  }
  fs.chmodSync(target, 0o700)
  return target
}

function storageFor(context) {
  const xpowers = ensurePrivateDirectory(context.gitDir, "xpowers")
  const root = ensurePrivateDirectory(xpowers, "acceptance-v1")
  return {
    root,
    lock: path.join(root, "lock"),
  }
}

function atomicWriteJson(target, value) {
  const existing = lstatSafe(target)
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail(`unsafe acceptance receipt path: ${target}`)
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(serialized) > MAX_RECEIPT_BYTES) fail("acceptance receipt exceeds size limit")
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`
  let descriptor
  let failure
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600)
    fs.writeFileSync(descriptor, serialized, "utf8")
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, target)
    fs.chmodSync(target, 0o600)
    const directory = fs.openSync(path.dirname(target), "r")
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  } catch (error) {
    failure = error
  }
  if (descriptor !== undefined) {
    try { fs.closeSync(descriptor) } catch (error) { if (!failure) failure = error }
  }
  try { fs.unlinkSync(temporary) } catch (error) {
    if (error.code !== "ENOENT" && !failure) failure = error
  }
  if (failure) throw failure
}

function acquireLock(storage, operation, tasks) {
  try {
    fs.mkdirSync(storage.lock, { mode: 0o700 })
  } catch (error) {
    if (error.code === "EEXIST") {
      fail(`acceptance state is locked at ${storage.lock}; if the owner was interrupted, remove the whole acceptance-v1 directory to clear both locks and receipts`)
    }
    throw error
  }
  try {
    atomicWriteJson(path.join(storage.lock, "owner.json"), {
      version: RUNTIME_VERSION,
      pid: process.pid,
      operation,
      tasks,
      startedAt: new Date().toISOString(),
    })
  } catch (error) {
    try { fs.rmdirSync(storage.lock) } catch { /* best effort */ }
    throw error
  }
  return () => {
    try { fs.unlinkSync(path.join(storage.lock, "owner.json")) } catch (error) { if (error.code !== "ENOENT") throw error }
    fs.rmdirSync(storage.lock)
  }
}

function receiptPath(storage, task) {
  return path.join(storage.root, `${sha256(Buffer.from(task, "utf8"))}.json`)
}

function writeReceipt(storage, task, record) {
  atomicWriteJson(receiptPath(storage, task), {
    receiptVersion: RUNTIME_VERSION,
    task,
    ...record,
  })
}

function readReceipt(storage, task) {
  const target = receiptPath(storage, task)
  const stat = lstatSafe(target)
  if (!stat) fail("acceptance receipt is missing")
  if (!stat.isFile() || stat.isSymbolicLink()) fail("acceptance receipt is not a regular private file")
  if (stat.size > MAX_RECEIPT_BYTES) fail("acceptance receipt exceeds size limit")
  let value
  try {
    value = JSON.parse(fs.readFileSync(target, "utf8"))
  } catch {
    fail("acceptance receipt is malformed or corrupt")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("acceptance receipt is malformed or corrupt")
  if (value.receiptVersion !== RUNTIME_VERSION || value.task !== task || typeof value.status !== "string") {
    fail("acceptance receipt has an unsupported format")
  }
  return value
}

function policyPath(context) {
  return path.join(context.root, POLICY_RELATIVE_PATH)
}

function loadPolicy(context) {
  const parent = path.join(context.root, ".xpowers")
  const parentStat = lstatSafe(parent)
  if (!parentStat || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    fail(".xpowers must be a real directory while acceptance is enabled")
  }
  const target = policyPath(context)
  const stat = lstatSafe(target)
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) fail("acceptance policy must be a regular file, not a symlink or directory")
  let policy
  let raw
  try {
    raw = readRegularFileNoFollow(target, MAX_POLICY_BYTES, "acceptance policy", (canonical) => {
      assertCanonicalTargetAllowed(context, canonical, "acceptance policy")
    }).bytes
    policy = JSON.parse(raw.toString("utf8"))
  } catch (error) {
    if (error instanceof AcceptanceError) throw error
    fail("acceptance policy is malformed JSON")
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) fail("acceptance policy must be an object")
  const keys = Object.keys(policy).sort()
  if (keys.length !== 2 || keys[0] !== "checks" || keys[1] !== "version") fail("acceptance policy supports only version and checks")
  if (policy.version !== RUNTIME_VERSION) fail(`unsupported acceptance policy version ${JSON.stringify(policy.version)}`)
  if (!Array.isArray(policy.checks) || policy.checks.length === 0 || policy.checks.length > MAX_CHECKS) {
    fail(`acceptance policy checks must contain 1-${MAX_CHECKS} entries`)
  }
  const ids = new Set()
  for (const check of policy.checks) {
    if (!check || typeof check !== "object" || Array.isArray(check)) fail("each acceptance check must be an object")
    const checkKeys = Object.keys(check).sort()
    if (checkKeys.length !== 3 || checkKeys[0] !== "command" || checkKeys[1] !== "id" || checkKeys[2] !== "timeoutMs") {
      fail("acceptance checks support only id, command, and timeoutMs")
    }
    if (typeof check.id !== "string" || !CHECK_ID_PATTERN.test(check.id)) fail(`invalid acceptance check id ${JSON.stringify(check.id)}`)
    if (ids.has(check.id)) fail(`duplicate acceptance check id ${check.id}`)
    ids.add(check.id)
    if (!Array.isArray(check.command) || check.command.length === 0 || check.command.length > MAX_COMMAND_PARTS) {
      fail(`acceptance check ${check.id} command must be a nonempty argv array`)
    }
    for (const argument of check.command) {
      if (typeof argument !== "string" || argument.includes("\0") || Buffer.byteLength(argument) > MAX_ARGUMENT_BYTES) {
        fail(`acceptance check ${check.id} has an invalid command argument`)
      }
    }
    if (!check.command[0]) fail(`acceptance check ${check.id} command executable is empty`)
    if (!Number.isSafeInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > MAX_TIMEOUT_MS) {
      fail(`acceptance check ${check.id} timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`)
    }
  }
  return { policy, fingerprint: sha256(raw) }
}

function parseNul(buffer) {
  const values = []
  let start = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue
    const raw = buffer.subarray(start, index)
    const value = raw.toString("utf8")
    if (!Buffer.from(value, "utf8").equals(raw)) fail("Git path is not valid UTF-8 and cannot be safely fingerprinted")
    values.push(value)
    start = index + 1
  }
  if (start !== buffer.length) fail("Git returned an unterminated path list")
  return values
}

function isExcluded(relative) {
  return relative === ".beads" || relative.startsWith(".beads/")
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function relativeFromRoot(root, target) {
  const relative = path.relative(root, target)
  if (!isInside(root, target)) fail(`path resolves outside the worktree: ${target}`)
  return relative.split(path.sep).join("/")
}

function assertNoSymlinkParents(root, relative) {
  const components = relative.split("/")
  let current = root
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component)
    const stat = lstatSafe(current)
    if (!stat) return
    if (stat.isSymbolicLink()) fail(`symlink parent directory is unsupported: ${relative}`)
    if (!stat.isDirectory()) fail(`non-directory path component is unsupported: ${relative}`)
  }
}

function assertCanonicalTargetAllowed(context, target, label) {
  if (!isInside(context.root, target)) fail(`${label} resolves outside the worktree`)
  if (isInside(context.gitDir, target) || isInside(context.commonDir, target)) fail(`${label} resolves into Git metadata`)
  const relative = relativeFromRoot(context.root, target)
  if (isExcluded(relative)) fail(`${label} resolves into excluded .beads metadata`)
  return relative
}

function fingerprintResolvedTarget(context, target, label) {
  const relative = assertCanonicalTargetAllowed(context, target, label)
  const stat = fs.lstatSync(target)
  if (stat.isFile()) {
    const opened = readRegularFileNoFollow(target, Number.MAX_SAFE_INTEGER, label, (canonical) => {
      assertCanonicalTargetAllowed(context, canonical, label)
    })
    return {
      path: relative,
      type: "file",
      executable: (opened.stat.mode & 0o111) !== 0,
      size: opened.stat.size,
      digest: sha256(opened.bytes),
    }
  }
  if (stat.isDirectory()) {
    fail(`${label} resolves to a directory; directory symlink targets are unsupported`)
  }
  fail(`${label} is a special file and unsupported`)
}

function createSnapshot(context, policyFingerprint) {
  const currentHead = gitOutput(context.root, ["rev-parse", "--verify", "HEAD"]).trim()
  const indexEntries = parseNul(gitOutput(context.root, ["ls-files", "-z", "--stage"], { encoding: null }))
  const index = []
  const paths = new Set()
  for (const entry of indexEntries) {
    const match = /^(\d+) ([0-9a-f]+) (\d+)\t([\s\S]+)$/.exec(entry)
    if (!match) fail("Git returned an unsupported index entry")
    const [, mode, object, stageText, relative] = match
    if (isExcluded(relative)) continue
    const stage = Number(stageText)
    if (stage !== 0) fail(`unresolved Git index entry is unsupported: ${relative}`)
    if (mode === "160000") fail(`Git submodules are unsupported by acceptance snapshots: ${relative}`)
    index.push({ mode, object, stage, path: relative })
    paths.add(relative)
  }

  for (const relative of parseNul(gitOutput(context.root, ["ls-tree", "-rz", "--name-only", "HEAD"], { encoding: null }))) {
    if (!isExcluded(relative)) paths.add(relative)
  }
  for (const relative of parseNul(gitOutput(context.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: null }))) {
    if (!isExcluded(relative)) paths.add(relative)
  }
  paths.add(POLICY_RELATIVE_PATH.split(path.sep).join("/"))

  const files = []
  for (const relative of [...paths].sort()) {
    if (relative.includes("\0") || path.isAbsolute(relative) || relative.split("/").includes("..")) fail(`unsafe Git path: ${relative}`)
    assertNoSymlinkParents(context.root, relative)
    const absolute = path.join(context.root, ...relative.split("/"))
    const stat = lstatSafe(absolute)
    if (!stat) {
      files.push({ path: relative, type: "missing" })
      continue
    }
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(absolute)
      const resolved = path.resolve(path.dirname(absolute), link)
      let realTarget
      try { realTarget = fs.realpathSync(resolved) } catch { fail(`dangling symlink is unsupported: ${relative}`) }
      const target = fingerprintResolvedTarget(context, realTarget, `symlink ${relative}`)
      files.push({ path: relative, type: "symlink", target: link, resolvedTarget: target })
      continue
    }
    if (!stat.isFile()) fail(`special file is unsupported by acceptance snapshots: ${relative}`)
    const opened = readRegularFileNoFollow(absolute, Number.MAX_SAFE_INTEGER, `file ${relative}`, (canonical) => {
      assertCanonicalTargetAllowed(context, canonical, `file ${relative}`)
    })
    files.push({
      path: relative,
      type: "file",
      executable: (opened.stat.mode & 0o111) !== 0,
      size: opened.stat.size,
      digest: sha256(opened.bytes),
    })
  }

  const identity = {
    root: context.root,
    gitDir: context.gitDir,
    commonDir: context.commonDir,
    head: currentHead,
  }
  const payload = { runtimeVersion: RUNTIME_VERSION, identity, policyFingerprint, index, files }
  return { ...payload, fingerprint: sha256(Buffer.from(JSON.stringify(payload), "utf8")) }
}

function boundedText(buffer) {
  const text = buffer.subarray(0, MAX_STORED_STREAM_BYTES).toString("utf8")
  return buffer.length > MAX_STORED_STREAM_BYTES ? `${text}\n[truncated]` : text
}

let activeChild = null
let interruptedSignal = null

function killChild(child) {
  if (!child?.pid) return
  try {
    if (process.platform === "win32") child.kill("SIGKILL")
    else process.kill(-child.pid, "SIGKILL")
  } catch { /* already exited */ }
}

function installSignalHandlers() {
  const handler = (signal) => {
    interruptedSignal = signal
    killChild(activeChild)
  }
  process.on("SIGINT", handler)
  process.on("SIGTERM", handler)
  return () => {
    process.off("SIGINT", handler)
    process.off("SIGTERM", handler)
  }
}

function runCheck(check, root) {
  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let total = 0
    let timedOut = false
    let outputExceeded = false
    let spawnError = null
    const child = spawn(check.command[0], check.command.slice(1), {
      cwd: root,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
    activeChild = child
    const capture = (stream) => (chunk) => {
      total += chunk.length
      if (stream === "stdout" && stdout.length < MAX_CHECK_OUTPUT_BYTES) stdout = Buffer.concat([stdout, chunk]).subarray(0, MAX_CHECK_OUTPUT_BYTES)
      if (stream === "stderr" && stderr.length < MAX_CHECK_OUTPUT_BYTES) stderr = Buffer.concat([stderr, chunk]).subarray(0, MAX_CHECK_OUTPUT_BYTES)
      if (total > MAX_CHECK_OUTPUT_BYTES && !outputExceeded) {
        outputExceeded = true
        killChild(child)
      }
    }
    child.stdout.on("data", capture("stdout"))
    child.stderr.on("data", capture("stderr"))
    child.on("error", (error) => { spawnError = error })
    const timer = setTimeout(() => {
      timedOut = true
      killChild(child)
      child.stdout.destroy()
      child.stderr.destroy()
    }, check.timeoutMs)
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      activeChild = null
      const outcome = interruptedSignal ? "interrupted"
        : timedOut ? "timed-out"
          : outputExceeded ? "output-limit"
            : spawnError ? "spawn-failed"
              : code === 0 ? "passed" : "failed"
      resolve({
        id: check.id,
        status: outcome,
        exitCode: code,
        signal,
        durationMs: Date.now() - started,
        stdout: boundedText(stdout),
        stderr: boundedText(stderr),
        error: spawnError?.message || null,
      })
    })
  })
}

function pendingRecord(context, operation) {
  return {
    status: "pending",
    operation,
    startedAt: new Date().toISOString(),
    gitIdentity: { root: context.root, gitDir: context.gitDir, commonDir: context.commonDir, head: context.head },
  }
}

function failedRecord(context, operation, reason, checks = []) {
  return {
    status: interruptedSignal ? "interrupted" : "failed",
    operation,
    finishedAt: new Date().toISOString(),
    reason,
    checks,
    gitIdentity: { root: context.root, gitDir: context.gitDir, commonDir: context.commonDir, head: context.head },
  }
}

async function runAcceptance(task, context, storage) {
  const pending = pendingRecord(context, "run")
  writeReceipt(storage, task, pending)
  let checks = []
  try {
    const loaded = loadPolicy(context)
    const before = createSnapshot(context, loaded.fingerprint)
    const removeSignals = installSignalHandlers()
    try {
      for (const check of loaded.policy.checks) {
        if (interruptedSignal) fail(`acceptance run interrupted by ${interruptedSignal}`)
        process.stdout.write(`tm acceptance: running ${check.id}\n`)
        const result = await runCheck(check, context.root)
        checks.push(result)
        if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`)
        if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`)
        if (result.status !== "passed") fail(`acceptance check ${check.id} ${result.status}`)
        process.stdout.write(`tm acceptance: ${check.id} passed\n`)
      }
    } finally {
      removeSignals()
    }
    const after = createSnapshot(context, loaded.fingerprint)
    if (before.fingerprint !== after.fingerprint) fail("worktree or policy changed while acceptance checks ran")
    writeReceipt(storage, task, {
      status: "passed",
      operation: "run",
      startedAt: pending.startedAt,
      finishedAt: new Date().toISOString(),
      policyFingerprint: loaded.fingerprint,
      snapshot: after,
      checks,
    })
    process.stdout.write(`tm acceptance: ${task} is eligible (${after.fingerprint})\n`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    writeReceipt(storage, task, failedRecord(context, "run", reason, checks))
    throw error
  }
}

function checkEligibility(task, context, storage) {
  const loaded = loadPolicy(context)
  const receipt = readReceipt(storage, task)
  if (receipt.status !== "passed") fail(`latest acceptance run is ${receipt.status}${receipt.reason ? `: ${receipt.reason}` : ""}`)
  if (receipt.operation !== "run" || typeof receipt.startedAt !== "string" || typeof receipt.finishedAt !== "string") {
    fail("acceptance receipt is malformed or corrupt")
  }
  if (!Array.isArray(receipt.checks) || receipt.checks.length !== loaded.policy.checks.length) {
    fail("acceptance receipt has incomplete check evidence")
  }
  for (let index = 0; index < loaded.policy.checks.length; index += 1) {
    const expected = loaded.policy.checks[index]
    const result = receipt.checks[index]
    if (!result || typeof result !== "object" || result.id !== expected.id || result.status !== "passed" || result.exitCode !== 0 ||
        !Number.isSafeInteger(result.durationMs) || result.durationMs < 0 || typeof result.stdout !== "string" ||
        typeof result.stderr !== "string" || result.error !== null || result.signal !== null) {
      fail(`acceptance receipt has invalid evidence for check ${expected.id}`)
    }
  }
  if (receipt.policyFingerprint !== loaded.fingerprint) fail("acceptance evidence is stale: policy changed")
  if (!receipt.snapshot || typeof receipt.snapshot !== "object" || receipt.snapshot.runtimeVersion !== RUNTIME_VERSION ||
      typeof receipt.snapshot.fingerprint !== "string" || receipt.snapshot.policyFingerprint !== loaded.fingerprint ||
      !receipt.snapshot.identity || !Array.isArray(receipt.snapshot.index) || !Array.isArray(receipt.snapshot.files)) {
    fail("acceptance receipt is malformed or corrupt")
  }
  const storedSnapshotPayload = {
    runtimeVersion: receipt.snapshot.runtimeVersion,
    identity: receipt.snapshot.identity,
    policyFingerprint: receipt.snapshot.policyFingerprint,
    index: receipt.snapshot.index,
    files: receipt.snapshot.files,
  }
  if (sha256(Buffer.from(JSON.stringify(storedSnapshotPayload), "utf8")) !== receipt.snapshot.fingerprint) {
    fail("acceptance receipt snapshot is internally inconsistent")
  }
  const current = createSnapshot(context, loaded.fingerprint)
  if (receipt.snapshot.fingerprint !== current.fingerprint) fail("acceptance evidence is stale: current worktree, index, HEAD, or policy differs")
  return current
}

function spawnBackendClose(tasks, context) {
  return new Promise((resolve, reject) => {
    const child = spawn("br", ["close", ...tasks], {
      cwd: context.root,
      shell: false,
      detached: process.platform !== "win32",
      stdio: "inherit",
    })
    activeChild = child
    child.on("error", reject)
    child.on("close", (code, signal) => {
      activeChild = null
      if (interruptedSignal === "SIGINT" || signal === "SIGINT") resolve(130)
      else if (interruptedSignal === "SIGTERM" || signal === "SIGTERM") resolve(143)
      else if (signal) resolve(1)
      else resolve(code ?? 1)
    })
  })
}

async function main() {
  const [operation, ...args] = process.argv.slice(2)
  const supported = operation === "run" || operation === "check" || operation === "guard-close"
  if (!supported) fail("usage: tm acceptance <run|check> TASK", 2)
  if ((operation === "run" || operation === "check") && args.length !== 1) fail(`usage: tm acceptance ${operation} TASK`, 2)
  if (operation === "guard-close" && args.length === 0) fail("guarded close requires at least one task", 2)
  for (const task of args) assertTaskId(task)

  const context = resolveGitContext(process.env.TM_REPO_ROOT || process.cwd())
  const storage = storageFor(context)
  const release = acquireLock(storage, operation, args)
  try {
    if (operation === "run") {
      await runAcceptance(args[0], context, storage)
      return 0
    }
    if (operation === "check") {
      const snapshot = checkEligibility(args[0], context, storage)
      process.stdout.write(`tm acceptance: ${args[0]} is eligible (${snapshot.fingerprint})\n`)
      return 0
    }
    for (const task of args) {
      const snapshot = checkEligibility(task, context, storage)
      process.stdout.write(`tm acceptance: ${task} is eligible (${snapshot.fingerprint})\n`)
    }
    const removeSignals = installSignalHandlers()
    try {
      return await spawnBackendClose(args, context)
    } finally {
      removeSignals()
    }
  } finally {
    release()
  }
}

main().then(
  (code) => { process.exitCode = code },
  (error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`tm acceptance: ${message}\n`)
    process.exitCode = error instanceof AcceptanceError ? error.exitCode : 1
  },
)
