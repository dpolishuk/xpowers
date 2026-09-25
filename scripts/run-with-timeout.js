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
  stdio: ["ignore", "inherit", "inherit"],
})
let timedOut = false
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
}, milliseconds)
child.on("error", (error) => {
  clearTimeout(timer)
  console.error(error.message)
  process.exitCode = 127
})
child.on("close", (code) => {
  clearTimeout(timer)
  process.exitCode = timedOut ? 124 : (code ?? 1)
})
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    kill()
    process.exit(code)
  })
}
