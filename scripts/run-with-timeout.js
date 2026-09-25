#!/usr/bin/env node

// Shared by the Bash and Bun installers; no GNU timeout dependency on macOS.
const { spawn } = require("node:child_process")

const [duration, command, ...args] = process.argv.slice(2)
const milliseconds = Number(duration)
if (!command || !Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
  console.error("Usage: run-with-timeout.js <positive milliseconds> <command> [args...]")
  process.exit(2)
}

const child = spawn(command, args, {
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
})
// Own the pipes: "close" must wait for descendants that inherited either stream,
// even when the direct CLI process already exited. Detached daemons that close
// their output streams can keep running; only a deadline kills the process group.
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
let timedOut = false
let spawnFailed = false
const kill = () => {
  if (!child.pid) return
  try {
    // Kill the process group too, so subprocesses cannot keep pipes or locks open.
    if (process.platform === "win32") child.kill("SIGKILL")
    else process.kill(-child.pid, "SIGKILL")
  } catch { /* process already exited */ }
}
const timer = setTimeout(() => {
  timedOut = true
  console.error(`${command} ${args.join(" ")} timed out after ${milliseconds}ms`)
  kill()
  // A detached descendant may have escaped the original process group. Closing
  // our pipe ends still releases the installer at the deadline in that case.
  child.stdout.destroy()
  child.stderr.destroy()
}, milliseconds)
child.on("error", (error) => {
  spawnFailed = true
  clearTimeout(timer)
  console.error(error.message)
  process.exitCode = 127
})
child.on("close", (code) => {
  clearTimeout(timer)
  if (!spawnFailed) process.exitCode = timedOut ? 124 : (code ?? 1)
})
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    kill()
    process.exit(code)
  })
}
