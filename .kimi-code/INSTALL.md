# Installing XPowers for Kimi Code CLI

## Prerequisites

- [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) installed (`kimi --version`)
- Python 3.11+ (for TOML config validation; hooks still install without it)
- Git (for cloning the repository)
- Optional: `kimi` binary on PATH so the installer can run `kimi plugin install`

## Quick Install

### Using the Install Script (Recommended)

```bash
# Clone the repository
git clone https://github.com/dpolishuk/xpowers.git ~/xpowers
cd ~/xpowers

# Run the unified installer
./scripts/install.sh --kimi-code

# Or install to all detected agents at once
./scripts/install.sh --all
```

For development (symlinks for live reload):

```bash
./scripts/install.sh --kimi-code --symlink
```

### What Gets Installed

| Location | Contents |
|----------|----------|
| `~/.kimi-code/skills/` | 20+ XPowers skills (brainstorming, TDD, refactoring, etc.) |
| `~/.kimi-code/hooks/` | Guard hooks (dangerous bash, env writes, beads truncation, etc.) |
| `~/.kimi-code/config.toml` | `[[hooks]]` entries for PreToolUse / PostToolUse |
| `~/.local/bin/tm` | Shared `tm` task-management runtime |

The installer also tries `kimi plugin install` to register `kimi.plugin.json` from the repo root. If your `kimi` binary does not yet have a `plugin` subcommand, the skills and hooks still work; register the plugin later via the Kimi Code TUI (`/plugins install`) or copy `kimi.plugin.json` to `~/.kimi-code/plugins/xpowers/kimi.plugin.json` manually.

### Using the TypeScript Installer

```bash
bun scripts/install.ts --yes --hosts kimi-code
```

### Manual Install

```bash
# 1. Create config directories
mkdir -p ~/.kimi-code/skills
mkdir -p ~/.kimi-code/hooks

# 2. Copy skills (exclude codex-* wrappers and common-patterns)
cp -r .kimi-code/skills/* ~/.kimi-code/skills/

# 3. Install guard hooks
bash scripts/install-kimi-code-hooks.sh

# 4. Optionally register plugin metadata if plugin install is unavailable
mkdir -p ~/.kimi-code/plugins/xpowers
cp kimi.plugin.json ~/.kimi-code/plugins/xpowers/kimi.plugin.json

# 5. Verify the shared tm runtime
~/.local/bin/tm --help
```

## Verification

```bash
# Show installed hosts and versions
./scripts/install.sh --status

# Expected output includes a line like:
# ✓ Kimi Code CLI  v2.14.1  (22 skills)
```

After installation, restart Kimi Code or run `kimi /reload` so the new skills and hooks are picked up.

## Uninstall

```bash
./scripts/install.sh --uninstall --kimi-code --yes
```

This removes the copied skills, plugin metadata, version marker, and the XPowers hooks block from `~/.kimi-code/config.toml`.
