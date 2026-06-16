# Model Configuration

> Back to [README](../README.md)

XPowers agents support per-agent model configuration using the `providerID/modelID` format. This allows you to:
- Use different models for different agents (e.g., fast models for test-running, capable models for code review)
- Configure multiple API providers simultaneously
- Optimize costs by matching task complexity to model capability

**Recommended model choices by agent:**

| Agent | Recommended Model | Reason |
|-------|------------------|--------|
| planner | Most capable (opus) | Deep architectural reasoning and task decomposition |
| autonomous-reviewer | Most capable (opus) | Final validation and comprehensive review |
| code-reviewer | Capable (sonnet, glm-4.7) | Requires reasoning and analysis |
| security-scanner | Capable (sonnet) | Vulnerability pattern matching and CVE analysis |
| devops | Capable (sonnet) | CI/CD pipeline analysis and diagnosis |
| knowledge-aggregator | Capable (sonnet) | Synthesis across multiple knowledge sources |
| review-quality | Capable (sonnet) | Bug detection and error handling analysis |
| review-implementation | Capable (sonnet) | Requirements alignment verification |
| review-testing | Capable (sonnet) | Test coverage and quality evaluation |
| review-simplification | Capable (sonnet) | Complexity detection |
| review-documentation | Capable (sonnet) | Documentation completeness |
| test-effectiveness-analyst | Capable (sonnet, glm-4.7) | Complex analysis of test quality |
| test-runner | Fast (haiku, glm-4.5) | High-volume, low-complexity tasks |
| codebase-investigator | Fast (haiku) | Scanning and searching operations |
| internet-researcher | Fast (haiku) | External API lookups and summarization |
| ralph | Inherit | Orchestrates other agents, uses parent model |

---

## Understanding the `providerID/modelID` Format

OpenCode uses a `providerID/modelID` format to specify exactly which provider and model to use:

```
anthropic/claude-sonnet-4-5
├───┬───┘ └───┬───────────┘
│   │         └── Model ID
│   └── Provider ID
└── Separator (forward slash)
```

This format eliminates ambiguity when multiple providers offer models with similar names.

---

## Configuration Methods

This guide covers four common model-configuration patterns across XPowers hosts and OpenCode usage.

1. **Agent Frontmatter** - Set default model in the agent definition
2. **OpenCode Config** - Override per-agent models in `opencode.json`
3. **Multiple Providers with Same Models** - Route different concrete agents across providers
4. **Claude Code Configuration** - Host-specific model configuration

---

## OpenCode XPowers Direct Agent Routing Contract

For XPowers on OpenCode, **direct agent→model mapping** is the canonical routing model.

- Global defaults use OpenCode’s native `agent.<agent>.model` shape.
- XPowers-specific workflow overrides are resolved at runtime for XPowers task-tool dispatch paths.
- Any plugin/options UX should edit the same underlying map, not a separate plugin-only state store.
- The first plugin/options editing surface is the `xpowers_agent_routing_config` tool, which reads/writes project-root `opencode.json` directly.
- The primary settings-like UX on top of that backend is the `/routing-settings` slash-command wizard.

In short: plugin/options edit the same underlying map.

### Canonical global mapping

Use `agent.<agent>.model` as the canonical global map for direct agent routing.

Examples of concrete agents you may route directly:
- `planner`
- `ralph`
- `test-runner`
- `codebase-investigator`
- `internet-researcher`
- `knowledge-aggregator`
- `security-scanner`
- `devops`
- `review-quality`
- `review-implementation`
- `review-testing`
- `review-simplification`
- `review-documentation`
- `test-effectiveness-analyst`
- `autonomous-reviewer`
- `code-reviewer`

### XPowers workflow overrides

Workflow-specific overrides are active for XPowers task-tool dispatch paths in OpenCode.

The active XPowers-injected precedence is:

1. Explicit workflow override for the concrete agent
2. Global `agent.<agent>.model` mapping
3. Agent frontmatter `model`
4. Otherwise leave `model` unset so native OpenCode session inheritance, top-level `model`, and provider defaults continue to apply

Plugin/options edit the same underlying map as config.

If a plugin exposes agent-routing controls, those controls should write back into the same routing model rather than maintaining separate hidden state.

Today, the practical plugin/options surface is `/routing-settings`, a plugin-owned settings-like UX layered over the `xpowers_agent_routing_config` tool from `.opencode/plugins/agent-routing-config.ts`. The tool supports five actions:

- `get` — returns current routing state with `availableModels` (auto-detected from config), `agentGroups`, and available `presets`
- `set` — update a single agent's model (global or workflow override)
- `set-group` — batch-set a model for an entire agent group
- `apply-preset` — apply a named profile (`cost-optimized` or `quality-first`) that maps model tiers to agent groups
- `bootstrap` — create a recommended full multi-agent routing config from the merged available model set

**Agent Groups:**

| Group | Agents | Typical Role |
|-------|--------|-------------|
| orchestrator | ralph | Primary executor |
| planners | planner | Deep architectural reasoning (opus recommended) |
| workers | test-runner, codebase-investigator, internet-researcher | High-volume, low-complexity |
| researchers | knowledge-aggregator | Synthesis across sources (sonnet recommended) |
| guards | security-scanner, devops | Security and CI/CD analysis (sonnet) |
| reviewers | autonomous-reviewer, code-reviewer, review-*, test-effectiveness-analyst | Require reasoning |

> The OpenCode routing wizard plugin (`.opencode/plugins/routing-wizard-core.ts`) supports all 6 groups and 16 agents.

**Presets:**

- **cost-optimized**: Workers use `small_model`, orchestrator and reviewers use `model`
- **quality-first**: All agents use `model`

Presets read the user's top-level `model` and `small_model` values. If `small_model` is not set, all agents use `model`.

See `docs/opencode.example.agent-routing.json` for the agent mapping example and `docs/opencode.example.xpowers-routing.json` for the workflow overrides example.

For a terminal-first bootstrap flow that discovers live model names from `opencode models` and writes the same split-file routing contract, run:

```bash
bun scripts/opencode-routing-wizard.ts --yes
```

---

### Method 1: Agent Frontmatter (Default Configuration)

Each agent file has a YAML frontmatter section where you can specify the default model:

**File locations:**
- Claude Code: `agents/<agent-name>.md`
- OpenCode: `.opencode/agents/<agent-name>.md`

**Format:**

```yaml
---
name: test-runner
description: Runs tests without polluting context
model: anthropic/claude-haiku-4-5  # Full providerID/modelID format
---
```

**Supported model values:**

| Value | Description | Example | Host |
|-------|-------------|---------|------|
| *(omit `model`)* | Inherit the parent's/current model (native fallback) | _(no `model` field)_ | OpenCode |
| `inherit` | Use the parent's/current model | `model: inherit` | Claude Code only |
| `providerID/modelID` | Explicit provider and model | `model: anthropic/claude-sonnet-4-5` | Both |

> **⚠️ OpenCode:** Do NOT use `model: inherit` — it resolves to `undefined` and causes `ProviderModelNotFoundError`.
> To inherit the parent model on OpenCode, simply omit the `model` field from frontmatter entirely.

**Example agent configurations:**

```yaml
# agents/test-runner.md - Use fast, cheap model
---
name: test-runner
model: anthropic/claude-haiku-4-5
---
```

```yaml
# agents/code-reviewer.md - Use capable model
---
name: code-reviewer
model: anthropic/claude-sonnet-4-5
---
```

```yaml
# agents/autonomous-reviewer.md - Use most capable model
---
name: autonomous-reviewer
model: anthropic/claude-opus-4-5
---
```

---

### Method 2: OpenCode Configuration (Per-Agent Override)

In OpenCode, you can override agent models in your `opencode.json` file without modifying agent files. This is useful for:
- Project-specific model choices
- Testing different models
- User preferences that shouldn't be committed

**Configuration precedence (highest to lowest):**

```
1. opencode.json → agent.<agent-name>.model
2. opencode.json → model (top-level default)
3. Agent frontmatter → model setting
4. Provider default
```

**Basic configuration:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "comment": "All agents use Sonnet by default",
  "model": "anthropic/claude-sonnet-4-5"
}
```

**Per-agent override:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "comment": "Optimize costs: fast models for simple tasks, capable for complex",
  "model": "anthropic/claude-sonnet-4-5",
  "agent": {
    "test-runner": {
      "model": "anthropic/claude-haiku-4-5"
    },
    "codebase-investigator": {
      "model": "anthropic/claude-haiku-4-5"
    },
    "autonomous-reviewer": {
      "model": "anthropic/claude-opus-4-5"
    }
  }
}
```

---

### Method 3: Multiple Providers with Same Models

When using multiple providers (e.g., multiple API proxies or aggregation services), use the full `providerID/modelID` format to disambiguate:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "comment": "Configure multiple providers with same model names",

  "model": "proxy1/claude-sonnet-4-5",
  "small_model": "proxy1/claude-haiku-4-5",

  "provider": {
    "proxy1": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "API Proxy 1",
      "options": {
        "baseURL": "https://api.proxy1.com/v1",
        "apiKey": "{env:PROXY1_API_KEY}"
      },
      "models": {
        "claude-sonnet-4-5": {
          "name": "Claude Sonnet 4.5 (via Proxy 1)",
          "limit": { "context": 200000, "output": 64000 }
        },
        "claude-haiku-4-5": {
          "name": "Claude Haiku 4.5 (via Proxy 1)",
          "limit": { "context": 200000, "output": 8192 }
        }
      }
    },
    "proxy2": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "API Proxy 2",
      "options": {
        "baseURL": "https://api.proxy2.com/v1",
        "apiKey": "{env:PROXY2_API_KEY}"
      },
      "models": {
        "claude-sonnet-4-5": {
          "name": "Claude Sonnet 4.5 (via Proxy 2)",
          "limit": { "context": 200000, "output": 64000 }
        }
      }
    },
    "anthropic": {
      "comment": "Official Anthropic provider",
      "options": {
        "apiKey": "{env:ANTHROPIC_API_KEY}"
      }
    }
  },

  "agent": {
    "test-runner": {
      "model": "proxy2/claude-haiku-4-5"
    },
    "code-reviewer": {
      "model": "anthropic/claude-opus-4-5"
    }
  },

  "disabled_providers": ["openai", "google"]
}
```

**Key points for multi-provider setup:**

1. **Provider ID** must be unique (e.g., `proxy1`, `proxy2`, `anthropic`)
2. **Model IDs** are scoped to each provider - same name can exist in multiple providers
3. **Reference format** is always `providerID/modelID`
4. **Disable unused providers** to avoid confusion in model selection

---

### Method 4: Claude Code Configuration

Claude Code uses a different configuration approach. Models are resolved through settings files:

**Global settings:** `~/.claude/settings.json`
**Project settings:** `.claude/settings.json`

**Configuration format:**

```json
{
  "env": {
    "ANTHROPIC_DEFAULT_MODEL": "claude-sonnet-4-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-5"
  }
}
```

**Using third-party providers (e.g., GLM, OpenRouter):**

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.glm.ai/v1",
    "ANTHROPIC_AUTH_TOKEN": "{env:GLM_API_KEY}",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-4.7",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-4.7"
  }
}
```

**Note:** Claude Code's agent system doesn't support per-agent model overrides in configuration files. To set per-agent models in Claude Code, modify the agent file's frontmatter directly.

---

## Complete Configuration Examples

**Example 1: Minimal Setup (Inherit Current Model)**

```json
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5"
}
```

All agents without an explicit `model` in frontmatter (or in `opencode.json` → `agent.<name>.model`) will use `claude-sonnet-4-5`.

---

**Example 2: Cost-Optimized Setup**

```json
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "agent": {
    "test-runner": { "model": "anthropic/claude-haiku-4-5" },
    "codebase-investigator": { "model": "anthropic/claude-haiku-4-5" },
    "internet-researcher": { "model": "anthropic/claude-haiku-4-5" },
    "code-reviewer": { "model": "anthropic/claude-sonnet-4-5" },
    "autonomous-reviewer": { "model": "anthropic/claude-opus-4-5" }
  }
}
```

| Agent | Model | Estimated Cost |
|-------|-------|----------------|
| test-runner | Haiku | $ |
| codebase-investigator | Haiku | $ |
| code-reviewer | Sonnet | $$ |
| autonomous-reviewer | Opus | $$$ |

---

**Example 3: Multi-Provider with API Proxy**

```json
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "myproxy/claude-sonnet-4-5",
  "provider": {
    "myproxy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My API Proxy",
      "options": {
        "baseURL": "https://api.myproxy.com/v1",
        "apiKey": "{env:MYPROXY_API_KEY}",
        "timeout": 300000
      },
      "models": {
        "claude-haiku-4-5": {
          "name": "Claude Haiku 4.5",
          "limit": { "context": 200000, "output": 8192 }
        },
        "claude-sonnet-4-5": {
          "name": "Claude Sonnet 4.5",
          "limit": { "context": 200000, "output": 64000 }
        },
        "claude-opus-4-5": {
          "name": "Claude Opus 4.5",
          "limit": { "context": 200000, "output": 32000 }
        }
      }
    }
  },
  "agent": {
    "test-runner": { "model": "myproxy/claude-haiku-4-5" }
  },
  "disabled_providers": ["anthropic", "openai", "google"]
}
```

---

**Example 4: Local + Cloud Mix (OpenCode)**

```json
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local Ollama",
      "options": {
        "baseURL": "http://localhost:11434/v1"
      },
      "models": {
        "qwen2.5-coder:32b": { "name": "Qwen 2.5 Coder 32B" }
      }
    }
  },
  "agent": {
    "codebase-investigator": { "model": "ollama/qwen2.5-coder:32b" }
  }
}
```

---

## Switching Models at Runtime (OpenCode)

In OpenCode's TUI, you can switch models dynamically:

```
/models
```

This shows all available `providerID/modelID` combinations. Select a different model to change the active model for the current session.

For quick switching between modes:
- Press `Tab` to toggle between Build and Plan agents (if configured)
- Use `/agent <name>` to switch to a specific agent with its configured model

---

## Troubleshooting Model Configuration

**Issue: Model not found**

```
Error: Model 'myproxy/gpt-4o' not found
```

**Solutions:**
1. Check that the provider is defined in `opencode.json`
2. Verify the model ID exists in the provider's `models` section
3. Ensure you're using the correct format: `providerID/modelID`

**Issue: Agent using wrong model**

**Solutions:**
1. Check configuration precedence (agent config > top-level model > frontmatter)
2. Verify the agent file's frontmatter doesn't have a hardcoded model
3. Restart OpenCode/Claude Code after configuration changes

**Issue: API key not recognized**

**Solutions:**
1. Use `{env:VARIABLE_NAME}` format in config, not hardcoded keys
2. Verify the environment variable is set: `echo $VARIABLE_NAME`
3. For OpenCode, use `/connect` command to authenticate

---

**Quick setup - copy example configs:**

```bash
# For Anthropic (official)
cp docs/opencode.example.anthropic.json opencode.json

# For GLM models
cp docs/opencode.example.glm.json opencode.json

# For multiple providers
cp docs/opencode.example.multi-provider.json opencode.json

# For Claude Code with third-party provider
cat docs/claude-code.example.glm.json >> ~/.claude/settings.json
```

See [docs/README.md](README.md) for more detailed examples.
