#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")

const normalizeNewlines = (input) => input.replace(/\r\n/g, "\n")

const ensureTrailingNewline = (input) => (input.endsWith("\n") ? input : `${input}\n`)

const toPosixPath = (input) => input.replace(/\\/g, "/")

const quoteYamlScalar = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`

const DESCRIPTION_MIN_LENGTH = 20
const DESCRIPTION_MIN_WORDS = 5
const DESCRIPTION_TRIGGER_RE = /\b(use when|use to|use for|when|if|before|after|during|matches|only|avoid|do not|not for)\b/i
const VAGUE_DESCRIPTION_RE = /\b(helper|generic|general|misc|various|things|stuff|whatever)\b/i

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/

const validateDescriptionQuality = ({ description, contextLabel, requireTrigger = true }) => {
  const normalized = String(description || "").trim().replace(/\s+/g, " ")
  const qualityErrors = []

  if (normalized.length < DESCRIPTION_MIN_LENGTH) {
    qualityErrors.push(
      `${contextLabel} description too short (${normalized.length} chars, min ${DESCRIPTION_MIN_LENGTH})`,
    )
  }

  const wordCount = normalized.length === 0 ? 0 : normalized.split(" ").length
  if (wordCount < DESCRIPTION_MIN_WORDS) {
    qualityErrors.push(`${contextLabel} description too short (${wordCount} words, min ${DESCRIPTION_MIN_WORDS})`)
  }

  if (requireTrigger && !DESCRIPTION_TRIGGER_RE.test(normalized)) {
    qualityErrors.push(
      `${contextLabel} description missing trigger/boundary language (include phrases like 'use when', 'use to', or explicit boundaries)`,
    )
  }

  if (VAGUE_DESCRIPTION_RE.test(normalized)) {
    qualityErrors.push(`${contextLabel} description is too vague (avoid helper/generic wording)`)
  }

  return qualityErrors
}

const parseFrontmatter = (rawContent, filePath, options = {}) => {
  const requireName = options.requireName !== false
  const requireDescription = options.requireDescription !== false

  const content = normalizeNewlines(rawContent)
  const match = content.match(FRONTMATTER_RE)

  if (!match) {
    throw new Error(`missing frontmatter: ${filePath} (add YAML frontmatter with 'name' and 'description')`)
  }

  // We need to parse block scalars like description: > and object maps like tools:
  const jsYaml = require("js-yaml")
  let frontmatter
  try {
    frontmatter = jsYaml.load(match[1]) || {}
  } catch (err) {
    // If YAML fails (e.g. because of "!!!" which fails as a tag), fallback or report
    // For this sync script we want to be permissive with raw values if strict YAML fails
    throw new Error(`invalid YAML frontmatter: ${err.message}`)
  }

  if (requireName && !frontmatter.name) {
    throw new Error(`missing frontmatter.name: ${filePath} (add 'name: ...' in frontmatter)`)
  }
  if (requireDescription && !frontmatter.description) {
    throw new Error(`missing frontmatter.description: ${filePath} (add 'description: ...' in frontmatter)`)
  }

  return {
    frontmatter,
    body: content.slice(match[0].length),
    fullContent: ensureTrailingNewline(content),
  }
}

const slugifyName = (name) => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/-{2,}/g, "-")

  if (!slug) {
    throw new Error(`unable to slugify empty name: ${name}`)
  }
  return slug
}

const listDirectories = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    return []
  }

  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

const listFiles = (dirPath, extension) => {
  if (!fs.existsSync(dirPath)) {
    return []
  }

  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

const resolvePathWithSymlinkAwareAncestor = (absolutePath) => {
  let current = absolutePath
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  const currentReal = fs.existsSync(current) ? fs.realpathSync(current) : current
  const remainder = path.relative(current, absolutePath)
  return path.resolve(currentReal, remainder)
}

const isWithinRoot = (absolutePath, rootAbsolutePath) => {
  const resolved = resolvePathWithSymlinkAwareAncestor(absolutePath)
  return resolved === rootAbsolutePath || resolved.startsWith(`${rootAbsolutePath}${path.sep}`)
}

const isSymlink = (absolutePath) => {
  if (!fs.existsSync(absolutePath)) {
    return false
  }
  return fs.lstatSync(absolutePath).isSymbolicLink()
}

const CODEX_COMPAT_INJECTED = `<codex_compat>
Note: The AskUserQuestion tool is not available on this platform.
Instead, format your questions using the structured text blocks: "Question:", "Options:", "Priority:".
Verification of Phase 1 requires at least 3 such properly formatted question blocks in your message history.
</codex_compat>
`
const CODEX_COMPAT_CANONICAL_MARKER = "In Codex/Kimi platforms where AskUserQuestion is not a registered tool"

const createWrapperContent = ({ wrapperName, wrapperDescription, sourcePath, originalContent, wrapperType }) => {
  return ensureTrailingNewline(`---
name: ${wrapperName}
description: ${quoteYamlScalar(wrapperDescription)}
---

# Codex ${wrapperType} Wrapper

This skill wraps the source file \`${sourcePath}\` for Codex Skills compatibility.

## Usage

- Use this skill when the request matches the intent of \`${sourcePath}\`.
- Follow the source instructions exactly.
- Do not use this skill for unrelated tasks.

## Source Content

\`\`\`\`markdown
${originalContent.trimEnd()}
\`\`\`\`
`)
}

const collectCanonicalEntries = (projectRoot) => {
  const entries = []
  const errors = []

  // Load platform tool availability (e.g. from .kimi/xpowers.yaml)
  let availableTools = []
  const platformManifestPath = path.join(projectRoot, ".kimi", "xpowers.yaml")
  if (fs.existsSync(platformManifestPath)) {
    const manifest = fs.readFileSync(platformManifestPath, "utf8")
    const toolsMatch = manifest.match(/tools:\n([\s\S]*?)(?:\n\w+:|$)/)
    if (toolsMatch) {
      availableTools = toolsMatch[1]
        .split("\n")
        .map((line) => line.replace(/#.*$/, "").trim())
        .filter((line) => line.startsWith("-"))
        .map((line) => line.replace(/^-\s*/, "").split(":").pop().trim())
        .map((line) => line.replace(/^['"]/, "").replace(/['"]$/, ""))
        .filter(Boolean)
    }
  }

  const skillsRoot = path.join(projectRoot, "skills")
  for (const skillDir of listDirectories(skillsRoot)) {
    const sourcePath = path.join(skillsRoot, skillDir, "SKILL.md")
    if (!fs.existsSync(sourcePath)) {
      continue
    }

    let parsed
    try {
      parsed = parseFrontmatter(fs.readFileSync(sourcePath, "utf8"), sourcePath)
    } catch (error) {
      errors.push(String(error.message || error))
      continue
    }

    let canonicalSkillSlug
    try {
      canonicalSkillSlug = slugifyName(parsed.frontmatter.name)
    } catch {
      errors.push(`invalid canonical skill name: ${sourcePath} ('${parsed.frontmatter.name}')`)
      continue
    }

    errors.push(
      ...validateDescriptionQuality({
        description: parsed.frontmatter.description,
        contextLabel: `canonical skill ${path.relative(projectRoot, sourcePath)}`,
        requireTrigger: false,
      }),
    )

    const wrapperName = `codex-skill-${canonicalSkillSlug}`
    const wrapperDescription = `Use when the original skill '${parsed.frontmatter.name}' applies. ${parsed.frontmatter.description}`
    errors.push(
      ...validateDescriptionQuality({
        description: wrapperDescription,
        contextLabel: `generated wrapper ${wrapperName}`,
      }),
    )

    let body = parsed.body.trimStart()

    // Automatically inject compatibility note if AskUserQuestion is used but missing from platform.
    // Note: This injection only runs for the skills loop.
    if (body.includes("AskUserQuestion") && !availableTools.includes("AskUserQuestion")) {
      if (!body.includes("<codex_compat>") && !body.includes(CODEX_COMPAT_CANONICAL_MARKER)) {
        body = `${CODEX_COMPAT_INJECTED}\n${body}`
      }
    }

    entries.push({
      generatedName: wrapperName,
      generatedDescription: wrapperDescription,
      generatedContent: ensureTrailingNewline(`---
name: ${wrapperName}
description: ${quoteYamlScalar(wrapperDescription)}
---

<!-- Generated from ${path.relative(projectRoot, sourcePath)} -->

${body}`),
      sourcePath: path.relative(projectRoot, sourcePath),
      sourceType: "skill",
    })
  }

  const commandsRoot = path.join(projectRoot, "commands")
  for (const fileName of listFiles(commandsRoot, ".md")) {
    const sourcePath = path.join(commandsRoot, fileName)
    let parsed
    try {
      parsed = parseFrontmatter(fs.readFileSync(sourcePath, "utf8"), sourcePath, { requireName: false })
    } catch (error) {
      errors.push(String(error.message || error))
      continue
    }

    const commandName = parsed.frontmatter.name || path.basename(fileName, ".md")
    let commandSlug
    try {
      commandSlug = slugifyName(commandName)
    } catch {
      errors.push(`invalid canonical command name: ${sourcePath} ('${commandName}')`)
      continue
    }

    const wrapperName = `codex-command-${commandSlug}`
    const wrapperDescription = `Use when task intent matches command '${commandName}'. Do not use for unrelated workflows.`
    errors.push(
      ...validateDescriptionQuality({
        description: wrapperDescription,
        contextLabel: `generated wrapper ${wrapperName}`,
      }),
    )
    entries.push({
      generatedName: wrapperName,
      generatedDescription: wrapperDescription,
      generatedContent: createWrapperContent({
        wrapperName,
        wrapperDescription,
        sourcePath: path.relative(projectRoot, sourcePath),
        originalContent: parsed.fullContent,
        wrapperType: "Command",
      }),
      sourcePath: path.relative(projectRoot, sourcePath),
      sourceType: "command",
    })
  }

  const agentsRoot = path.join(projectRoot, "agents")
  for (const fileName of listFiles(agentsRoot, ".md")) {
    if (fileName === "CLAUDE.md") {
      continue
    }
    const sourcePath = path.join(agentsRoot, fileName)
    let parsed
    try {
      parsed = parseFrontmatter(fs.readFileSync(sourcePath, "utf8"), sourcePath)
    } catch (error) {
      errors.push(String(error.message || error))
      continue
    }

    let agentSlug
    try {
      agentSlug = slugifyName(parsed.frontmatter.name)
    } catch {
      errors.push(`invalid canonical agent name: ${sourcePath} ('${parsed.frontmatter.name}')`)
      continue
    }

    const wrapperName = `codex-agent-${agentSlug}`
    const wrapperDescription = `Use when delegating to agent '${parsed.frontmatter.name}' is needed. Avoid for direct implementation tasks.`
    errors.push(
      ...validateDescriptionQuality({
        description: wrapperDescription,
        contextLabel: `generated wrapper ${wrapperName}`,
      }),
    )
    entries.push({
      generatedName: wrapperName,
      generatedDescription: wrapperDescription,
      generatedContent: createWrapperContent({
        wrapperName,
        wrapperDescription,
        sourcePath: path.relative(projectRoot, sourcePath),
        originalContent: parsed.fullContent,
        wrapperType: "Agent",
      }),
      sourcePath: path.relative(projectRoot, sourcePath),
      sourceType: "agent",
    })
  }

  return {
    entries: entries.sort((a, b) => a.generatedName.localeCompare(b.generatedName)),
    errors,
  }
}

const buildPlan = (projectRoot) => {
  const collected = collectCanonicalEntries(projectRoot)
  const entries = collected.entries
  const errors = [...collected.errors]
  const bySlug = new Map()

  for (const entry of entries) {
    let slug
    try {
      slug = slugifyName(entry.generatedName)
    } catch (error) {
      errors.push(String(error.message || error))
      continue
    }

    if (!bySlug.has(slug)) {
      bySlug.set(slug, [])
    }
    bySlug.get(slug).push(entry)
  }

  for (const [slug, group] of bySlug.entries()) {
    if (group.length > 1) {
      const sources = group.map((entry) => `${entry.generatedName} (${entry.sourcePath})`).join(", ")
      errors.push(`slug collision for '${slug}': ${sources}`)
    }
  }

  if (errors.length > 0) {
    return { errors, expected: [] }
  }

  const expected = [...bySlug.entries()]
    .map(([slug, group]) => ({
      slug,
      entry: group[0],
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug))

  return { errors: [], expected }
}

const syncCodexSkills = ({ projectRoot = process.cwd(), mode = "write", outputRootRelative = ".agents/skills" } = {}) => {
  const projectRootResolved = path.resolve(projectRoot)
  const projectRootReal = fs.realpathSync(projectRootResolved)
  const outputRootDisplay = toPosixPath(path.normalize(outputRootRelative))

  if (path.isAbsolute(outputRootRelative)) {
    return {
      ok: false,
      errors: [`output root must be project-relative: ${outputRootRelative}`],
      updatedCount: 0,
    }
  }

  const outputRoot = path.resolve(projectRootResolved, outputRootRelative)
  if (!(outputRoot === projectRootResolved || outputRoot.startsWith(`${projectRootResolved}${path.sep}`))) {
    return {
      ok: false,
      errors: [`output root escapes project root: ${outputRootRelative}`],
      updatedCount: 0,
    }
  }

  if (!isWithinRoot(outputRoot, projectRootReal)) {
    return {
      ok: false,
      errors: [`output root resolves outside project root: ${outputRootRelative}`],
      updatedCount: 0,
    }
  }

  const plan = buildPlan(projectRootResolved)
  if (plan.errors.length > 0) {
    return { ok: false, errors: plan.errors, updatedCount: 0 }
  }

  const driftMessages = []
  const updates = []
  const expectedSlugs = new Set(plan.expected.map(({ slug }) => slug))
  const existingSlugs = fs.existsSync(outputRoot) ? listDirectories(outputRoot).filter((slug) => slug.startsWith("codex-")) : []

  for (const slug of existingSlugs) {
    if (!expectedSlugs.has(slug)) {
      driftMessages.push(`orphan generated directory: ${outputRootDisplay}/${slug}`)
      updates.push({ type: "remove", slug })
    }
  }

  for (const { slug, entry } of plan.expected) {
    const targetDir = path.join(outputRoot, slug)
    const targetFile = path.join(targetDir, "SKILL.md")
    const expectedContent = ensureTrailingNewline(normalizeNewlines(entry.generatedContent))

    if (fs.existsSync(targetFile) && !isWithinRoot(targetFile, projectRootReal)) {
      return {
        ok: false,
        errors: [`unsafe read path resolves outside project root: ${outputRootDisplay}/${slug}/SKILL.md`],
        updatedCount: 0,
      }
    }

    if (!fs.existsSync(targetFile)) {
      driftMessages.push(`missing generated skill file: ${outputRootDisplay}/${slug}/SKILL.md`)
      updates.push({ type: "write", slug, content: expectedContent })
      continue
    }

    const actual = ensureTrailingNewline(normalizeNewlines(fs.readFileSync(targetFile, "utf8")))
    if (actual !== expectedContent) {
      driftMessages.push(`stale generated content: ${outputRootDisplay}/${slug}/SKILL.md`)
      updates.push({ type: "write", slug, content: expectedContent })
    }
  }

  if (mode === "check") {
    return {
      ok: driftMessages.length === 0,
      errors: driftMessages,
      updatedCount: 0,
      expectedCount: plan.expected.length,
    }
  }

  fs.mkdirSync(outputRoot, { recursive: true })

  for (const update of updates) {
    if (update.type === "remove") {
      const removePath = path.join(outputRoot, update.slug)
      if (!isWithinRoot(removePath, projectRootReal)) {
        return {
          ok: false,
          errors: [`unsafe remove path resolves outside project root: ${outputRootDisplay}/${update.slug}`],
          updatedCount: 0,
        }
      }
      if (isSymlink(removePath)) {
        return {
          ok: false,
          errors: [`unsafe remove target is symlink: ${outputRootDisplay}/${update.slug}`],
          updatedCount: 0,
        }
      }
      fs.rmSync(removePath, { recursive: true, force: true })
      continue
    }

    const targetDir = path.join(outputRoot, update.slug)
    const targetFile = path.join(targetDir, "SKILL.md")
    if (isSymlink(targetDir)) {
      return {
        ok: false,
        errors: [`unsafe write target directory is symlink: ${outputRootDisplay}/${update.slug}`],
        updatedCount: 0,
      }
    }
    if (isSymlink(targetFile)) {
      return {
        ok: false,
        errors: [`unsafe write target file is symlink: ${outputRootDisplay}/${update.slug}/SKILL.md`],
        updatedCount: 0,
      }
    }
    if (!isWithinRoot(targetFile, projectRootReal)) {
      return {
        ok: false,
        errors: [`unsafe write path resolves outside project root: ${outputRootDisplay}/${update.slug}/SKILL.md`],
        updatedCount: 0,
      }
    }
    fs.mkdirSync(targetDir, { recursive: true })

    if (isSymlink(targetDir) || isSymlink(targetFile)) {
      return {
        ok: false,
        errors: [`unsafe write target changed to symlink during operation: ${outputRootDisplay}/${update.slug}/SKILL.md`],
        updatedCount: 0,
      }
    }

    const tempName = `.SKILL.md.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const tempFile = path.join(targetDir, tempName)
    if (!isWithinRoot(tempFile, projectRootReal)) {
      return {
        ok: false,
        errors: [`unsafe temp write path resolves outside project root: ${outputRootDisplay}/${update.slug}/${tempName}`],
        updatedCount: 0,
      }
    }

    try {
      fs.writeFileSync(tempFile, update.content)
      if (isSymlink(targetFile)) {
        return {
          ok: false,
          errors: [`unsafe write target changed to symlink during operation: ${outputRootDisplay}/${update.slug}/SKILL.md`],
          updatedCount: 0,
        }
      }
      fs.renameSync(tempFile, targetFile)
    } finally {
      if (fs.existsSync(tempFile)) {
        fs.rmSync(tempFile, { force: true })
      }
    }
  }

  return {
    ok: true,
    errors: [],
    updatedCount: updates.length,
    expectedCount: plan.expected.length,
  }
}

const parseCli = (argv) => {
  const options = {
    mode: "write",
    projectRoot: process.cwd(),
    outputRootRelative: ".agents/skills",
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--check") {
      options.mode = "check"
      continue
    }
    if (arg === "--write") {
      options.mode = "write"
      continue
    }
    if (arg === "--project-root") {
      const next = argv[index + 1]
      if (!next || next.startsWith("-") || next.trim().length === 0) {
        throw new Error("--project-root requires a value")
      }
      options.projectRoot = path.resolve(next)
      index += 1
      continue
    }
    if (arg === "--output-root") {
      const next = argv[index + 1]
      if (!next || next.startsWith("-") || next.trim().length === 0) {
        throw new Error("--output-root requires a value")
      }
      options.outputRootRelative = next
      index += 1
      continue
    }
    throw new Error(`unknown option: ${arg}`)
  }

  return options
}

const runCli = () => {
  let options
  try {
    options = parseCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`sync-codex-skills: ${error.message}\n`)
    process.exit(1)
  }

  let result
  try {
    result = syncCodexSkills(options)
  } catch (error) {
    process.stderr.write(`sync-codex-skills: ${error.message}\n`)
    process.exit(1)
  }
  if (!result.ok) {
    for (const message of result.errors) {
      process.stderr.write(`sync-codex-skills: ${message}\n`)
    }
    process.exit(1)
  }

  process.stdout.write(
    `sync-codex-skills: ok (${result.expectedCount} skills, ${result.updatedCount} updates, mode=${options.mode})\n`,
  )
}

module.exports = {
  parseFrontmatter,
  parseCli,
  slugifyName,
  buildPlan,
  syncCodexSkills,
}

if (require.main === module) {
  runCli()
}
