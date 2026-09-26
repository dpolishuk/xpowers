import { readFileSync, existsSync, mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { test, expect } from "bun:test"

const repoRoot = path.resolve(__dirname, "..")

function loadExtensionWithNodeJiti(extDir: string, indexPath: string) {
  const jitiPath = path.join(extDir, "node_modules", "@mariozechner", "jiti", "lib", "jiti.mjs")
  const script = `import createJiti from ${JSON.stringify(pathToFileURL(jitiPath).href)};
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {} });
const factory = await jiti.import(${JSON.stringify(indexPath)}, { default: true });
console.log(\`loaded \${typeof factory}\`);`

  return spawnSync("node", ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 120000,
  })
}

function createFakePiShim(binDir: string): void {
  const piPath = path.join(binDir, "pi")
  writeFileSync(piPath, "#!/bin/sh\nexit 0\n", "utf8")
  chmodSync(piPath, 0o755)
}

function newTempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `${prefix}-XXXXXX`))
}

test("pi install writes extension and registers commands/tools at runtime", async () => {
  const home = newTempDir("pi-smoke")
  const binDir = newTempDir("pi-smoke-bin")

  // Fake pi binary used by installer detection.
  createFakePiShim(binDir)
  const bunPath = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()

  const env = {
    ...process.env,
    HOME: home,
    NO_COLOR: "1",
    PATH: `${binDir}:${process.env.PATH}`,
  }

  const result = spawnSync(bunPath, ["scripts/install.ts", "--hosts", "pi", "--yes", "--features", "__none__"], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 180000,
  })

  expect(result.status).toBe(0)
  const extDir = path.join(home, ".pi", "agent", "extensions", "xpowers")
  const indexPath = path.join(extDir, "dist", "index.js")

  expect(existsSync(extDir)).toBe(true)
  expect(existsSync(indexPath)).toBe(true)

  const jitiLoadResult = loadExtensionWithNodeJiti(extDir, indexPath)
  if (jitiLoadResult.status !== 0) {
    console.error("jitiLoadResult error:", jitiLoadResult.stderr)
    console.error("jitiLoadResult output:", jitiLoadResult.stdout)
  }
  expect(jitiLoadResult.status).toBe(0)
  expect(jitiLoadResult.stdout.trim()).toBe("loaded function")

  const extensionUrl = pathToFileURL(indexPath).href
  const extensionModule = await import(extensionUrl)

  const registeredCommands = new Set<string>()
  const registeredTools = new Map<string, any>()
  const observedEvents = new Set<string>()

  const mockPi: any = {
    registerCommand: (name: string) => {
      registeredCommands.add(name)
    },
    registerTool: (tool: { name: string }) => {
      registeredTools.set(tool.name, tool)
    },
    on: (event: string) => {
      observedEvents.add(event)
    },
  }

  extensionModule.default(mockPi)

  expect(registeredCommands.has("brainstorm")).toBe(true)
  expect(registeredCommands.has("write-plan")).toBe(true)
  expect(registeredCommands.has("execute-plan")).toBe(true)
  expect(registeredCommands.has("execute-ralph")).toBe(true)
  expect(registeredCommands.has("review-impl")).toBe(true)
  expect(registeredCommands.has("recall")).toBe(true)
  expect(registeredCommands.has("review-parallel")).toBe(true)
  expect(registeredCommands.has("routing-settings")).toBe(true)
  expect(registeredCommands.has("configure-routing")).toBe(true)
  expect(registeredCommands.has("tm")).toBe(true)
  expect(registeredTools.has("xpowers_subagent")).toBe(true)
  expect(registeredTools.has("AskUserQuestion")).toBe(true)
  expect(registeredTools.get("xpowers_subagent")?.parameters?.properties?.format).toBeTruthy()
  expect(observedEvents.has("session_start")).toBe(true)

  rmSync(home, { recursive: true, force: true })
  rmSync(binDir, { recursive: true, force: true })
}, { timeout: 120000 })

// Keep installer side-effect visible: AGENTS section should be injected safely.
test("pi AGENTS section is injected with install smoke run", () => {
  const home = newTempDir("pi-smoke-agents")
  const binDir = newTempDir("pi-smoke-agents-bin")
  const piHome = path.join(home, ".pi", "agent")

  createFakePiShim(binDir)
  const bunPath = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim()
  mkdirSync(piHome, { recursive: true })
  writeFileSync(path.join(piHome, "AGENTS.md"), "# existing notes\n", "utf8")

  const env = {
    ...process.env,
    HOME: home,
    NO_COLOR: "1",
    PATH: `${binDir}:${process.env.PATH}`,
  }

  const result = spawnSync(bunPath, ["scripts/install.ts", "--hosts", "pi", "--yes", "--features", "__none__"], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 120000,
  })

  expect(result.status).toBe(0)

  const agents = readFileSync(path.join(piHome, "AGENTS.md"), "utf8")
  expect(agents.includes("BEGIN XPOWERS PI")).toBe(true)
  expect(agents.includes("END XPOWERS PI")).toBe(true)

  rmSync(home, { recursive: true, force: true })
  rmSync(binDir, { recursive: true, force: true })
}, { timeout: 60000 })
