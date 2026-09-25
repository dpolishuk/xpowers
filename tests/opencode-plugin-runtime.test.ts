import { test, expect } from "bun:test"
import { $ } from "bun"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import slowMode from "../.opencode/plugins/xpowers-slow-mode"
import gitGuard from "../.opencode/plugins/xpowers-git-guard"
import notify from "../.opencode/plugins/xpowers-notify"
import lintGate from "../.opencode/plugins/xpowers-lint-gate"
import contextGauge from "../.opencode/plugins/xpowers-context-gauge"
import taskMonitor from "../.opencode/plugins/xpowers-task-monitor"

// Payloads follow @opencode-ai/plugin 1.14.20 Hooks: before args live in
// output; after args live in input; bash results expose metadata.exit.
const result = (metadata: Record<string, unknown> = {}) => ({ title: "tool", output: "", metadata })
const fixture = async (plugin: any, configName?: string, config: object = {}, shell: any = $) => {
  const directory = await mkdtemp(join(tmpdir(), "xpowers-plugin-test-"))
  await mkdir(join(directory, ".opencode"))
  if (configName) await writeFile(join(directory, ".opencode", configName), JSON.stringify(config))
  const toasts: any[] = []
  const prompts: any[] = []
  const hooks = await plugin({ directory, $: shell, client: {
    tui: { showToast: async ({ body }: any) => { toasts.push(body) } },
    session: { prompt: async (input: any) => { prompts.push(input) } },
  } })
  const sessionID = directory.split("/").pop()!
  let call = 0
  return {
    directory, hooks, toasts, prompts, sessionID,
    async edit(before: string, after: string, filePath = join(directory, "sample.ts")) {
      const input = { tool: "edit", sessionID, callID: String(++call) }
      await writeFile(join(directory, "sample.ts"), before)
      await hooks["tool.execute.before"]?.(input, { args: { filePath } })
      await writeFile(join(directory, "sample.ts"), after)
      await hooks["tool.execute.after"]({ ...input, args: { filePath } }, result())
    },
    async event(type: "session.idle" | "session.deleted") {
      await hooks.event({ event: { type, properties: type === "session.idle" ? { sessionID } : { info: { id: sessionID } } } })
    },
    async cleanup() { await rm(directory, { recursive: true, force: true }) },
  }
}

for (const [name, before, after, added, removed] of [
  ["append", "a", "a\nb", 1, 0],
  ["remove", "a\nb", "a", 0, 1],
  ["duplicate insertion", "a\nb", "a\na\nb", 1, 0],
  ["duplicate deletion", "a\na\nb", "a\nb", 0, 1],
  ["reorder", "a\nb", "b\na", 1, 1],
  ["mixed edit", "a\nb\nc\na", "b\nx\na\nc", 2, 2],
  ["blank line insertion", "a\nb", "a\n\nb", 1, 0],
] as const) {
  test(`slow mode reports ${name} through actual tool hooks`, async () => {
    const f = await fixture(slowMode)
    try {
      await f.edit(before, after)
      expect(f.toasts).toHaveLength(1)
      expect(f.toasts[0].message).toContain(`+${added} / -${removed} lines`)
      const log = await readFile(join(f.directory, ".opencode/cache/slow-mode", f.sessionID, "review.log"), "utf8")
      expect(log).toContain(`lines: +${added} / -${removed}`)
      // Preview and counters must describe the same paired edit script.
      expect(f.toasts[0].message.split("\n").filter((line: string) => line.startsWith("+ "))).toHaveLength(added)
      expect(f.toasts[0].message.split("\n").filter((line: string) => line.startsWith("- "))).toHaveLength(removed)
      const counts = new Map<string, number>()
      for (const line of before.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1)
      for (const line of f.toasts[0].message.split("\n").slice(2)) {
        if (line.startsWith("+ ") || line.startsWith("- ")) {
          const value = line.slice(2)
          counts.set(value, (counts.get(value) ?? 0) + (line[0] === "+" ? 1 : -1))
        }
      }
      for (const line of after.split("\n")) counts.set(line, (counts.get(line) ?? 0) - 1)
      expect([...counts.values()].every(count => count === 0)).toBe(true)
    } finally { await f.cleanup() }
  })
}

test("slow mode resolves relative paths against the project directory", async () => {
  const f = await fixture(slowMode)
  try {
    await f.edit("a", "a\nb", "sample.ts")
    expect(f.toasts[0]?.message).toContain("+1 / -0 lines")
  } finally { await f.cleanup() }
})

test("slow mode refreshes summaries after later edits without duplicate idle summaries", async () => {
  const f = await fixture(slowMode)
  try {
    await f.edit("a", "a\nb")
    await f.event("session.idle")
    await f.event("session.idle")
    await f.edit("a\nb", "a\nb\nc")
    await f.event("session.idle")
    await f.event("session.deleted")
    expect(f.toasts.filter(t => t.title === "Session Changes").map(t => t.message)).toEqual([
      "1 file(s) modified\n+1 / -0 lines", "1 file(s) modified\n+2 / -0 lines",
    ])
    const log = await readFile(join(f.directory, ".opencode/cache/slow-mode", f.sessionID, "review.log"), "utf8")
    expect(log.match(/=== SESSION SUMMARY ===/g)).toHaveLength(2)
  } finally { await f.cleanup() }
})

test("slow mode bounds large rewrites and does not silently approve them", async () => {
  const f = await fixture(slowMode, "slow-mode-config.json", { autoApproveThreshold: 10, notifyOnSmallChanges: false })
  try {
    const before = Array.from({ length: 30000 }, (_, i) => `old ${i}`).join("\n")
    const after = Array.from({ length: 30000 }, (_, i) => `new ${i}`).join("\n")
    const start = performance.now()
    await f.edit(before, after)
    expect(performance.now() - start).toBeLessThan(2000)
    expect(f.toasts[0]?.message).toContain("+30000 / -30000 lines")
  } finally { await f.cleanup() }
}, 5000)

const gitFixture = async () => {
  const f = await fixture(gitGuard, "git-guard-config.json", { autoCommitOnSessionEnd: true, showDiffOnWarning: false })
  await $`git -C ${f.directory} init -q`.quiet()
  await $`git -C ${f.directory} config user.name PluginTest`.quiet()
  await $`git -C ${f.directory} config user.email plugin@example.invalid`.quiet()
  await writeFile(join(f.directory, ".gitignore"), ".opencode/\n")
  await writeFile(join(f.directory, "sample.ts"), "before")
  await $`git -C ${f.directory} add .`.quiet()
  await $`git -C ${f.directory} -c core.hooksPath=/dev/null commit -qm initial`.quiet()
  return f
}

for (const exit of [1, null, undefined, 0]) {
  test(`git guard preserves changes after failed or unknown commit result (${exit})`, async () => {
    const f = await gitFixture()
    try {
      await f.edit("before", "after")
      await $`git -C ${f.directory} add sample.ts`.quiet()
      const input = { tool: "bash", sessionID: f.sessionID, callID: "commit" }
      const args = { command: "git commit --invalid-option" }
      await f.hooks["tool.execute.before"](input, { args })
      const failed = await $`git -C ${f.directory} commit --invalid-option`.quiet().nothrow()
      expect(failed.exitCode).not.toBe(0)
      await f.hooks["tool.execute.after"]({ ...input, args }, result({ exit }))
      expect(f.toasts.some(t => t.title === "Git Commit")).toBe(false)
      // A failure must not mark commitMade or clear filesModified: deletion
      // still performs the explicitly enabled auto-commit on those files.
      await f.event("session.deleted")
      const count = await $`git -C ${f.directory} rev-list --count HEAD`.quiet().text()
      expect(count.trim()).toBe("2")
    } finally { await f.cleanup() }
  })
}

test("git guard consumes successful bash metadata and normalizes edited paths", async () => {
  const f = await gitFixture()
  try {
    await f.edit("before", "after")
    await $`git -C ${f.directory} add sample.ts`.quiet()
    const input = { tool: "bash", sessionID: f.sessionID, callID: "commit" }
    const args = { command: "git commit -m changes" }
    await f.hooks["tool.execute.before"](input, { args })
    await $`git -C ${f.directory} -c core.hooksPath=/dev/null commit -qm changes`.quiet()
    await f.hooks["tool.execute.after"]({ ...input, args }, result({ exit: 0 }))
    expect(f.toasts.filter(t => t.title === "Git Commit")).toHaveLength(1)
    // External edits must not be auto-committed because of a stale absolute
    // path left behind when git reported the committed file's relative path.
    await writeFile(join(f.directory, "sample.ts"), "external edit")
    await f.event("session.deleted")
    const count = await $`git -C ${f.directory} rev-list --count HEAD`.quiet().text()
    expect(count.trim()).toBe("2")
    expect(await $`git -C ${f.directory} diff -- sample.ts`.quiet().text()).toContain("external edit")
  } finally { await f.cleanup() }
})

test("git guard warns on SDK idle events after edits", async () => {
  const f = await gitFixture()
  try {
    await f.edit("before", "after")
    await f.event("session.idle")
    expect(f.toasts.some(t => t.title.includes("Uncommitted"))).toBe(true)
  } finally { await f.cleanup() }
})

test("notify reads build command from after input and reports failure", async () => {
  const f = await fixture(notify, "notify-config.json", { backends: [] })
  try {
    await f.hooks["tool.execute.after"]({ tool: "bash", sessionID: f.sessionID, callID: "test", args: { command: "bun test" } }, result({ exit: 1 }))
    expect(f.toasts).toHaveLength(1)
    expect(f.toasts[0].variant).toBe("error")
    expect(f.toasts[0].message).toContain("bun test")
  } finally { await f.cleanup() }
})

test("lint gate uses the post hook edit arguments to run a configured linter", async () => {
  const f = await fixture(lintGate, "lint-gate-config.json", { linters: { ".ts": "true" } })
  try {
    await f.edit("a", "b")
    expect(f.toasts).toHaveLength(1)
    expect(f.toasts[0].variant).toBe("success")
  } finally { await f.cleanup() }
})


test("git guard retains the unstaged part of a successfully committed file", async () => {
  const f = await gitFixture()
  try {
    await f.edit("before", "staged")
    await $`git -C ${f.directory} add sample.ts`.quiet()
    await f.edit("staged", "unstaged")
    const input = { tool: "bash", sessionID: f.sessionID, callID: "partial" }
    const args = { command: "git commit -m partial" }
    await f.hooks["tool.execute.before"](input, { args })
    await $`git -C ${f.directory} -c core.hooksPath=/dev/null commit -qm partial`.quiet()
    await f.hooks["tool.execute.after"]({ ...input, args }, result({ exit: 0 }))
    await f.event("session.deleted")
    expect((await $`git -C ${f.directory} show HEAD:sample.ts`.quiet().text()).trim()).toBe("unstaged")
  } finally { await f.cleanup() }
})

test("context gauge counts streamed SDK text parts once and isolates sessions", async () => {
  const f = await fixture(contextGauge, "context-gauge-config.json", { modelLimits: { fixture: 100 } })
  try {
    const event = async (type: string, properties: object) => f.hooks.event({ event: { type, properties } })
    await event("session.created", { info: { id: f.sessionID } })
    const info = { id: "message1", sessionID: f.sessionID, role: "user", model: { providerID: "local", modelID: "fixture" } }
    await event("message.updated", { info })
    const part = { id: "part1", sessionID: f.sessionID, messageID: info.id, type: "text", text: "a".repeat(160) }
    await event("message.part.updated", { part })
    part.text = "a".repeat(280)
    await event("message.part.updated", { part })
    await event("message.part.updated", { part })
    await event("message.updated", { info })
    await event("message.part.updated", { part: { ...part, id: "part2", text: "a".repeat(40) } })
    await f.event("session.idle")
    expect(f.toasts.filter(t => t.title === "⚠️ Context Warning")).toHaveLength(1)
    expect(f.toasts.at(-1)?.message).toBe("1 messages\n80 / 100")
    const count = f.toasts.length
    await event("session.idle", { sessionID: "unrelated" })
    expect(f.toasts).toHaveLength(count)
    await f.event("session.deleted")
    await f.event("session.idle")
    expect(f.toasts).toHaveLength(count)
  } finally { await f.cleanup() }
})

test("context gauge reads successful model switch commands from after input", async () => {
  const f = await fixture(contextGauge, "context-gauge-config.json", { defaultLimit: 100, modelLimits: { fixture: 50 } })
  try {
    await f.hooks.event({ event: { type: "session.created", properties: { info: { id: f.sessionID } } } })
    const part = { id: "part", sessionID: f.sessionID, messageID: "message", type: "text", text: "a".repeat(160) }
    await f.hooks.event({ event: { type: "message.part.updated", properties: { part } } })
    const input = { tool: "bash", sessionID: f.sessionID, callID: "switch", args: { command: "model:fixture" } }
    await f.hooks["tool.execute.after"](input, result({ exit: 1 }))
    await f.event("session.idle")
    expect(f.toasts).toHaveLength(0)
    await f.hooks["tool.execute.after"](input, result({ exit: 0 }))
    await f.event("session.idle")
    expect(f.toasts.at(-1)?.message).toBe("1 messages\n40 / 50")
  } finally { await f.cleanup() }
})


test("slow mode keeps a small insertion exact inside a large file", async () => {
  const f = await fixture(slowMode)
  try {
    const lines = Array.from({ length: 30000 }, (_, i) => `line ${i}`)
    const after = [...lines.slice(0, 15000), "inserted", ...lines.slice(15000)].join("\n")
    await f.edit(lines.join("\n"), after)
    expect(f.toasts[0].message).toBe("sample.ts\n+1 / -0 lines\n+ inserted")
  } finally { await f.cleanup() }
})

test("slow mode matches an exhaustive subsequence oracle for repeated lines", async () => {
  const f = await fixture(slowMode)
  try {
    const sequences = Array.from({ length: 16 }, (_, mask) => Array.from({ length: 4 }, (_, i) => mask & (1 << i) ? "a" : "b"))
    for (const before of sequences) {
      for (const after of sequences) {
        let longest = 0
        for (let mask = 0; mask < 16; mask++) {
          const candidate = before.filter((_, i) => mask & (1 << i))
          let next = 0
          for (const line of after) if (candidate[next] === line) next++
          if (next === candidate.length) longest = Math.max(longest, next)
        }
        await f.edit(before.join("\n"), after.join("\n"))
        expect(f.toasts.at(-1).message).toContain(`+${4 - longest} / -${4 - longest} lines`)
      }
    }
  } finally { await f.cleanup() }
})

for (const kind of ["modified", "new", "deleted"] as const) {
  test(`git guard auto-commits only the session ${kind} file and preserves unrelated staging`, async () => {
    const f = await gitFixture()
    try {
      await writeFile(join(f.directory, "unrelated.txt"), "pre-staged by the user")
      await $`git -C ${f.directory} add unrelated.txt`.quiet()
      const name = kind === "new" ? "created.ts" : "sample.ts"
      const filePath = join(f.directory, name)
      if (kind === "deleted") {
        await rm(filePath)
      } else {
        await writeFile(filePath, "session change")
      }
      await f.hooks["tool.execute.after"]({
        tool: "write", sessionID: f.sessionID, callID: "session-edit", args: { filePath },
      }, result())
      await f.event("session.deleted")
      const committed = await $`git -C ${f.directory} diff-tree --no-commit-id --name-only -r HEAD`.quiet().text()
      expect(committed.trim()).toBe(name)
      const staged = await $`git -C ${f.directory} diff --cached --name-only`.quiet().text()
      expect(staged.trim()).toBe("unrelated.txt")
      expect(await $`git -C ${f.directory} show :unrelated.txt`.quiet().text()).toBe("pre-staged by the user")
      expect(f.toasts.some(t => t.title === "Auto-Commit" && t.variant === "success")).toBe(true)
      if (kind === "deleted") {
        const file = await $`git -C ${f.directory} cat-file -e HEAD:sample.ts`.quiet().nothrow()
        expect(file.exitCode).not.toBe(0)
      } else {
        expect(await $`git -C ${f.directory} show ${`HEAD:${name}`}`.quiet().text()).toBe("session change")
      }
    } finally { await f.cleanup() }
  })
}

test("git guard does not commit unrelated staging when a new session file disappears", async () => {
  const f = await gitFixture()
  try {
    await writeFile(join(f.directory, "unrelated.txt"), "pre-staged by the user")
    await $`git -C ${f.directory} add unrelated.txt`.quiet()
    const filePath = join(f.directory, "temporary.ts")
    await writeFile(filePath, "temporary")
    await f.hooks["tool.execute.after"]({
      tool: "write", sessionID: f.sessionID, callID: "temporary-edit", args: { filePath },
    }, result())
    await rm(filePath)
    await f.event("session.deleted")
    expect((await $`git -C ${f.directory} rev-list --count HEAD`.quiet().text()).trim()).toBe("1")
    expect((await $`git -C ${f.directory} diff --cached --name-only`.quiet().text()).trim()).toBe("unrelated.txt")
    expect(f.toasts.some(t => t.title === "Auto-Commit Failed")).toBe(true)
    expect(f.toasts.some(t => t.title === "Auto-Commit")).toBe(false)
  } finally { await f.cleanup() }
})


// Keep lifecycle tests deterministic: these timers never touch the real clock,
// and only the shell boundary is fake. Production polling and SDK hooks run.
const controlledTimers = () => {
  const original = { setTimeout, setInterval, clearTimeout, clearInterval }
  let nextId = 0
  const scheduled = new Map<number, { callback: () => Promise<void>; repeat: boolean }>()
  globalThis.setTimeout = ((callback: () => Promise<void>) => {
    scheduled.set(++nextId, { callback, repeat: false })
    return nextId
  }) as any
  globalThis.setInterval = ((callback: () => Promise<void>) => {
    scheduled.set(++nextId, { callback, repeat: true })
    return nextId
  }) as any
  globalThis.clearTimeout = globalThis.clearInterval = ((id: number) => { scheduled.delete(id) }) as any
  return {
    scheduled,
    async fire(id: number) {
      const entry = scheduled.get(id)
      if (!entry) return
      if (!entry.repeat) scheduled.delete(id)
      await entry.callback()
    },
    restore() { Object.assign(globalThis, original) },
  }
}

const shellResult = (output: string) => ({ exitCode: 0, text: async () => output })
const fakeTaskShell = (fetch: () => Promise<ReturnType<typeof shellResult>>) => () => ({
  quiet() { return this },
  nothrow: fetch,
})

test("task monitor keeps polling after a session is deleted", async () => {
  const timers = controlledTimers()
  let calls = 0
  let f: Awaited<ReturnType<typeof fixture>> | undefined
  try {
    f = await fixture(taskMonitor, "task-monitor-config.json", { pollIntervalMs: 5000 }, fakeTaskShell(async () => {
      calls++
      return shellResult(`○ test-${calls} ● P1 Task ${calls}`)
    }))
    const initial = [...timers.scheduled].find(([, entry]) => !entry.repeat)![0]
    const interval = [...timers.scheduled].find(([, entry]) => entry.repeat)![0]
    await timers.fire(initial)
    await f.event("session.deleted")
    expect(timers.scheduled.has(interval)).toBe(true)
    await timers.fire(interval)
    expect(calls).toBe(2)
    expect(f.toasts.filter(t => t.title === "New Task Ready")).toHaveLength(2)
  } finally {
    if (f) {
      await f.hooks.event({ event: { type: "server.instance.disposed", properties: { directory: f.directory } } })
      await f.cleanup()
    }
    timers.restore()
  }
})

test("task monitor cancels both timers only when its own instance is disposed", async () => {
  const timers = controlledTimers()
  let calls = 0
  let f: Awaited<ReturnType<typeof fixture>> | undefined
  try {
    f = await fixture(taskMonitor, "task-monitor-config.json", { pollIntervalMs: 5000 }, fakeTaskShell(async () => {
      calls++
      return shellResult("○ test-1 ● P1 Task")
    }))
    const queuedCallbacks = [...timers.scheduled.values()].map(entry => entry.callback)
    expect(timers.scheduled.size).toBe(2)
    await f.hooks.event({ event: { type: "server.instance.disposed", properties: { directory: "/another/project" } } })
    expect(timers.scheduled.size).toBe(2)
    await f.hooks.event({ event: { type: "server.instance.disposed", properties: { directory: f.directory } } })
    expect(timers.scheduled.size).toBe(0)
    // Already-queued callbacks and later session events must also be harmless.
    for (const callback of queuedCallbacks) await callback()
    await f.event("session.idle")
    await f.hooks.tool.xpowers_task_status.execute({}, {})
    expect(calls).toBe(0)
    expect(f.toasts).toHaveLength(0)
  } finally {
    if (f) await f.cleanup()
    timers.restore()
  }
})

test("task monitor discards an in-flight poll result after disposal", async () => {
  const timers = controlledTimers()
  let calls = 0
  let complete!: (result: ReturnType<typeof shellResult>) => void
  const pending = new Promise<ReturnType<typeof shellResult>>(resolve => { complete = resolve })
  let f: Awaited<ReturnType<typeof fixture>> | undefined
  try {
    f = await fixture(taskMonitor, "task-monitor-config.json", { pollIntervalMs: 5000 }, fakeTaskShell(() => {
      calls++
      return pending
    }))
    const initial = [...timers.scheduled].find(([, entry]) => !entry.repeat)![0]
    const poll = timers.fire(initial)
    expect(calls).toBe(1)
    await f.hooks.event({ event: { type: "server.instance.disposed", properties: { directory: f.directory } } })
    complete(shellResult("○ test-1 ● P1 Late task"))
    await poll
    expect(f.toasts).toHaveLength(0)
    expect(timers.scheduled.size).toBe(0)
    await f.event("session.idle")
    expect(calls).toBe(1)
    expect(await readFile(join(f.directory, ".opencode/cache/task-monitor/seen-tasks.json"), "utf8").catch(() => null)).toBeNull()
  } finally {
    if (f) await f.cleanup()
    timers.restore()
  }
})
