# tm-First Quickstart

Use this guide when you want the shortest path to the repo’s canonical task-management workflow.

## Core Model

- `tm` = canonical user-facing interface
- `br` = current backend in this repo (Beads Rust)
- `bd` = legacy Beads backend, retained in migration guides
- `tk` = Ticket / git-backed markdown alternative
- `linear` = Linear-native backend preview (core commands only on this repo branch)

These tools are related, but they are **not interchangeable day-to-day commands**. `tm` selects **one backend per project**.

Current backend note for this repo: `br` is the active backend, while `linear` is available as a preview backend on this branch.

## Daily Workflow

```bash
# Find work
tm ready

# Inspect a task
tm show <id>

# Claim work
tm update <id> --status in_progress

# Complete work
tm close <id>

# Sync local work and integrations
tm sync
```

## When to Use Backend-Specific Commands

Use direct `bd`, `br`, or `tk` commands only when a backend-specific setup, maintenance, or migration guide explicitly requires them.

## Next Guides

- [../README.md](../README.md) — front door and installation
- [linear-mcp-setup.md](linear-mcp-setup.md) — Linear and MCP setup
- [README.md](README.md) — docs index and deeper guide map
