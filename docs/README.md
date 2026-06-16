# Documentation Index

This directory contains deeper guides and example configuration for XPowers.

XPowers is **tm-first** on this branch: use `tm` as the day-to-day task-management interface, then consult the docs below for setup, backend detail, and integrations.

## Core Setup & Workflow Guides

- [../README.md](../README.md) — canonical front door for installation, usage, and the tm-first model
- [QUICKSTART.md](QUICKSTART.md) — shortest path to the tm-first workflow in this repo
- [linear-mcp-setup.md](linear-mcp-setup.md) — canonical Linear setup and `tm sync` guide
- [model-configuration.md](model-configuration.md) — model/provider configuration guide for supported hosts

## Host-Specific Install Guides

- [../.opencode/INSTALL.md](../.opencode/INSTALL.md) — OpenCode install and tm runtime setup
- [../.gemini-extension/README.md](../.gemini-extension/README.md) — Gemini extension install and tm/Linear support
- [../.kimi-code/INSTALL.md](../.kimi-code/INSTALL.md) — Kimi Code CLI install and workflow guide
- [../.kimi/INSTALL.md](../.kimi/INSTALL.md) — Kimi CLI (legacy) install and workflow guide
- [../.codex/INSTALL.md](../.codex/INSTALL.md) — Codex wrapper install guide

## Backend / Tracker Context

- `tm` — canonical user-facing interface
- `bd` — current backend in this repo
- `br` — Beads Rust / classic beads-compatible backend alternative
- `tk` — Ticket / git-backed markdown tracker alternative
- `linear` — Linear-native backend preview (core commands only on this repo branch)

These backends and alternatives are related, but they are **not interchangeable day-to-day commands**. `tm` uses **one backend per project**.

## Configuration Examples

Example configuration files for **OpenCode** and **Claude Code** with different model providers.

## Table of Contents

- [Core Setup & Workflow Guides](#core-setup--workflow-guides)
- [Backend / Tracker Context](#backend--tracker-context)
- [OpenCode Configuration](#opencode-configuration)
- [Claude Code Configuration](#claude-code-configuration)
- [Provider Setup Guide](#provider-setup-guide)
- [Model Selection Strategy](#model-selection-strategy)

---

## OpenCode Configuration

### Available Examples

#### `opencode.example.inherit.json`
**Recommended starting point.** All agents inherit your chosen model.

- Simplest configuration
- Just set the `model` field at the top level
- All agents use `model: inherit` by default
- Add agent-specific overrides only if needed

#### `opencode.example.anthropic.json`
Anthropic Claude models with optimized agent assignments:

- **Main model:** Sonnet 4.5 (balanced speed/capability)
- **Fast agents** (test-runner, investigator, researcher): Haiku 4.5
- **Capable agents** (code-reviewer, test-analyst): Sonnet 4.5

#### `opencode.example.glm.json`
GLM models with optimized agent assignments:

- **Main model:** GLM-4.7 (capable)
- **Fast agents** (test-runner, investigator, researcher): GLM-4.5
- **Capable agents** (code-reviewer, test-analyst): GLM-4.7

#### `opencode.example.multi-provider.json`
**Advanced:** Multiple providers with same model names. Shows how to:

- Configure multiple API proxies simultaneously
- Use `providerID/modelID` format to disambiguate
- Assign different providers to different agents
- Mix official and third-party providers

#### `opencode.example.agent-routing.json` + `opencode.example.xpowers-routing.json`
**XPowers direct-routing contract example.** Shows how to:

- Map models directly to concrete XPowers agents with the canonical `agent` key in `opencode.json`
- Keep plugin/options editing aligned to the same underlying routing map
- Store workflow overrides in `.opencode/xpowers-routing.json` (see the active `workflowOverrides` shape for XPowers task-tool dispatch paths)
- Use the `xpowers_agent_routing_config` plugin tool to read/write the routing map
- Use `/routing-settings` as the primary settings-like UX for managing those routing values

### How to Use (OpenCode)

1. **Copy** the example that matches your provider:

```bash
cp docs/opencode.example.inherit.json opencode.json
# or
cp docs/opencode.example.anthropic.json opencode.json
# or
cp docs/opencode.example.glm.json opencode.json
# or for multi-provider
cp docs/opencode.example.multi-provider.json opencode.json
# or for the direct XPowers routing contract example
cp docs/opencode.example.agent-routing.json opencode.json
```

2. **Edit** the `model` field and provider configuration

3. **Restart** OpenCode to apply changes

For plugin/options-driven edits, use `/routing-settings` as the primary settings-like UX. It is a plugin-owned workflow over the shared routing backend. That command uses the `xpowers_agent_routing_config` tool under the hood, so it reads/updates the same routing map (`opencode.json` for agent mappings, `.opencode/xpowers-routing.json` for workflow overrides) instead of storing separate plugin state.

### Agent Frontmatter Configuration

You can also set the default model directly in agent files:

**File location:** `.opencode/agents/<agent-name>.md` (project-local) or `~/.config/opencode/agents/<agent-name>.md` (global)

**Format:**

```yaml
---
name: test-runner
description: Runs tests without polluting context
model: anthropic/claude-haiku-4-5  # Full providerID/modelID
---
```

**Supported formats:**

| Format | Example | Use Case |
|--------|---------|----------|
| `inherit` | `model: inherit` | Use parent's/current model (default) |
| `providerID/modelID` | `model: proxy1/claude-haiku-4-5` | Explicit provider and model |
| `modelID` (OpenCode only) | `model: claude-haiku-4-5` | Shorthand for built-in providers |

**Precedence order:**

For XPowers task-tool dispatch paths:

1. `.opencode/xpowers-routing.json` → `workflowOverrides.<workflow>.<name>.model` (highest)
2. `opencode.json` → `agent.<name>.model`
3. Agent frontmatter → `model` field
4. Otherwise leave `model` unset so native OpenCode inheritance, top-level `model`, and provider defaults can apply

### Understanding `providerID/modelID` Format

OpenCode uses `providerID/modelID` format to uniquely identify models, especially when multiple providers have models with the same name:

```
anthropic/claude-sonnet-4-5
├───┬───┘ └───┬───────────┘
│   │         └── Model ID (specific to provider)
│   └── Provider ID (defined in opencode.json)
└── Separator (forward slash)
```

**Why this matters:**
- You might have `claude-sonnet-4-5` from official Anthropic AND from a proxy service
- The format eliminates ambiguity: `anthropic/claude-sonnet-4-5` vs `myproxy/claude-sonnet-4-5`
- Always use full format when configuring multiple providers

### OpenCode Provider Configuration

For custom providers (GLM, API proxies, local models via Ollama/llama.cpp), add a `provider` section:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "glm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "GLM-4",
      "options": {
        "baseURL": "https://your-glm-endpoint.com/v1",
        "apiKey": "{env:GLM_API_KEY}"
      },
      "models": {
        "glm-4.5": { "name": "GLM-4.5 Fast" },
        "glm-4.7": { "name": "GLM-4.7 Capable" }
      }
    }
  },
  "model": "glm/glm-4.7"
}
```

See [OpenCode Providers Documentation](https://opencode.ai/docs/providers/).

---

## Claude Code Configuration

### Available Examples

#### `claude-code.example.anthropic.json`
Default Anthropic Claude configuration. No special setup needed.

#### `claude-code.example.glm.json`
GLM models using environment variable mapping:

```json
{
  "env": {
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-4.7",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-4.7"
  }
}
```

#### `claude-code.example.mixed.json`
Mixed providers - different models for different purposes.

### How to Use (Claude Code)

1. **Global settings** (affects all projects):

```bash
# Edit global settings
nano ~/.claude/settings.json

# Paste the example config
```

2. **Project settings** (affects only this project):

```bash
# Create project settings
mkdir -p .claude
nano .claude/settings.json

# Paste the example config
```

3. **Restart** Claude Code for changes to take effect

### Claude Code Model Inheritance

Agents in Claude Code inherit models through environment variable mappings:

| Agent model field | Mapped to env var | Example value |
|------------------|-------------------|---------------|
| `model: haiku` | `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `glm-4.5-air` |
| `model: sonnet` | `ANTHROPIC_DEFAULT_SONNET_MODEL` | `glm-4.7` |
| `model: opus` | `ANTHROPIC_DEFAULT_OPUS_MODEL` | `glm-4.7` |
| `model: inherit` | User's current model selection | Your choice |

**Important:** XPowers agents use `model: inherit`, so they follow your current model selection. To customize, either:
- Change your current model in Claude Code settings
- Set env mappings to redirect haiku/sonnet/opus to your preferred models

---

## Provider Setup Guide

### Anthropic (Default)

No setup required. Just install and run.

### GLM Models

**Via OpenCode:**
1. Configure the provider in `opencode.json` (see examples above)
2. Set `GLM_API_KEY` environment variable if needed
3. Run `/models` in OpenCode to verify

**Via Claude Code:**
1. Add env mappings to `settings.json` (see `claude-code.example.glm.json`)
2. Restart Claude Code
3. Models are now available via haiku/sonnet/opus aliases

### Local Models (Ollama, llama.cpp)

**OpenCode:**
```json
{
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama Local",
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": {
        "qwen2.5": { "name": "Qwen 2.5 Coder" }
      }
    }
  }
}
```

**Claude Code:**
```json
{
  "env": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "ollama/qwen2.5"
  }
}
```

---

## Model Selection Strategy

### By Agent Type

| Agent Type | Recommended Models | Why |
|------------|-------------------|-----|
| **Fast agents** (test-runner, codebase-investigator, internet-researcher) | Haiku 4.5, GLM-4.5, local models | High-volume, low-complexity tasks benefit from speed |
| **Capable agents** (code-reviewer, test-effectiveness-analyst) | Sonnet 4.5, GLM-4.7, Opus 4 | Complex reasoning requires capable models |

### By Cost Optimization

| Strategy | Configuration |
|----------|---------------|
| **All same model** | Use `opencode.example.inherit.json` - set one model, all agents use it |
| **Fast + capable split** | Use agent overrides in `opencode.json` or env mappings in `settings.json` |
| **Local for speed, cloud for capability** | Configure local provider for fast agents, Anthropic/GLM for capable ones |

### Environment Variables

Both OpenCode and Claude Code examples reference these optional environment variables:

- `PERPLEXITY_API_KEY` - For Perplexity MCP server (research capabilities)
- `CONTEXT7_API_KEY` - For Context7 documentation server
- `GLM_API_KEY` - For GLM provider (if using GLM endpoint)
- `ANTHROPIC_API_KEY` - Standard Anthropic key (usually set separately)

Set these in your shell (`~/.zshrc`, `~/.bashrc`) or project `.env` file.

---

## See Also

- [OpenCode Models Documentation](https://opencode.ai/docs/models/)
- [OpenCode Providers Documentation](https://opencode.ai/docs/providers/)
- [OpenCode Configuration Reference](https://opencode.ai/docs/config/)
- [Claude Code Settings Documentation](https://code.claude.com/docs/en/settings)
