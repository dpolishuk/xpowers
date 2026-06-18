# Changelog

All notable changes to XPowers are documented in this file.

## [Unreleased]

## [2.14.2] - 2026-06-18

### Added
- **Kimi Code CLI support** (`kimi.plugin.json`, `.kimi-code/skills/`, `.kimi-code/AGENTS.md`, `.kimi-code/INSTALL.md`) with 22 adapted skills, guard hooks, and installer integration.

### Fixed
- Removed invalid `model: inherit` from all OpenCode agent files; OpenCode now omits the `model` field to inherit natively.
- Updated `readAgentFrontmatterModel` so the first existing project-local agent file is authoritative and no longer falls through to global `~/.config/opencode/agents` files when `model` is missing.
- Updated OpenCode-facing documentation to stop recommending `model: inherit` and warn that it causes `ProviderModelNotFoundError`.
- Kimi Code installer: bash 3.2 compatibility, user-skill preservation, and legacy XDG/uninstall path handling.

## [2.13.1] - 2026-05-05

### Added
- Third-party installer support for Beads Rust (`br`), Beads Viewer (`bv`), Graphify, and Claude-Mem across supported hosts.
- **`tm` flag translation**: `tm create` now automatically maps `--design` and `--design-file` to `--description` when using the `br` backend, ensuring compatibility with standard XPowers skills (hyper-miy).
- **Safety hooks** with mandatory fail-closed behavior on parse errors (hyper-c8d).
- **Hook integration tests** covering stdin/stdout JSON contracts for all blocking hooks (hyper-c8d).
- **CI quality gates** expanded to include `sync-codex-skills.js --check`, Gemini extension tests, security audit, and weekly scheduled runs (hyper-d8f).
- **Architecture documentation** (`docs/ARCHITECTURE.md`) explaining the five host platforms and shared resource model (hyper-d8f).
- **Testing guide** (`docs/TESTING.md`) covering Node.js built-in runner, Bun tests, Gemini extension tests, and hook testing methodology (hyper-d8f).
- **Standard project files**: MIT license, changelog, code owners, issue templates, and pull request template (hyper-d8f).

### Fixed
- Third-party uninstall now tracks installed tool ownership, cleans up manifest-only installs, and uses `claude-mem uninstall --all`.
- Pi delegation preserves conflict overrides and keeps default third-party installs behind explicit `--yes` behavior.
- Installer manifest parsing falls back across available runtimes when a preferred runtime fails.

### Security
- Beads Rust and Beads Viewer bootstrap installers are pinned to immutable upstream refs and use `pipefail` for `curl | bash` pipelines.
- Pre-tool-use hooks block direct reads of `.beads/issues.jsonl` and edits to `.git/hooks/pre-commit`.
- Post-tool-use hooks block truncation markers in `bd` output and Bash modifications to pre-commit hooks.
- Dangerous Bash and env-write hooks block destructive commands and sensitive file writes.

## [2.13.0] - 2024-03

### Added
- Linear backend preview for `tm` task management (hyper-7s5).
- OpenCode routing settings command and plugin (hyper-gau).
- Pi extension support with installer and agent routing (hyper-lum).

### Changed
- `tm` is now the canonical user-facing task-management interface.
- Documentation updated to reflect `tm`-first backend guidance.

## [2.0.0] - 2024-02

### Added
- Multi-host support for Claude Code, OpenCode, Gemini CLI, Kimi CLI, and Codex CLI.
- Skills system with YAML-frontmattered `SKILL.md` files.
- Agents system with 16 specialized subagent prompts.
- Hooks system for automatic, context-aware assistance.
- Codex wrapper sync tool (`scripts/sync-codex-skills.js`).
