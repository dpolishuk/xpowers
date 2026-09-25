#!/usr/bin/env bash
# Install the opt-in project profile; no flags preserves an existing routing.json.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  echo "XPowers Claude routing requires Python 3." >&2
  exit 1
fi
exec python3 -B "$SCRIPT_DIR/claude-routing/cli.py" install "$@"
