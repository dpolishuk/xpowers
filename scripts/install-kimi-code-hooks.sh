#!/usr/bin/env bash
set -euo pipefail

# Install XPowers guard hooks into the Kimi Code CLI config.
# Kimi Code hooks are declared as an array of [[hooks]] tables in
# ~/.kimi-code/config.toml. Each hook runs a local command and receives
# lifecycle context on stdin.

SCRIPT_SOURCE="${BASH_SOURCE[0]-}"
SCRIPT_DIR=""
REPO_ROOT=""
if [[ -n "$SCRIPT_SOURCE" && -f "$SCRIPT_SOURCE" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi

KIMI_CODE_HOME="${KIMI_CODE_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/kimi-code}"
CONFIG_FILE="${KIMI_CODE_HOME}/config.toml"
HOOKS_DIR="${KIMI_CODE_HOME}/hooks"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

info()  { echo "[kimi-code-hooks] $*"; }
warn()  { echo "[kimi-code-hooks] warning: $*" >&2; }
error() { echo "[kimi-code-hooks] error: $*" >&2; }

ensure_dir() { mkdir -p "$1" 2>/dev/null || { error "cannot create $1"; return 1; }; }

# ---------------------------------------------------------------------------
# Config backup
# ---------------------------------------------------------------------------
backup_config() {
  [[ -f "$CONFIG_FILE" ]] || return 0
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  local backup="${CONFIG_FILE}.xpowers-backup-${stamp}"
  cp "$CONFIG_FILE" "$backup"
  info "backed up ${CONFIG_FILE} to ${backup}"
}

# ---------------------------------------------------------------------------
# Hook list: each entry is "destination_subpath|source_path"
# ---------------------------------------------------------------------------
HOOK_LIST=(
  "pre-tool-use/block-beads-direct-read.py|${REPO_ROOT}/hooks/block-beads-direct-read.py"
  "pre-tool-use/01-block-pre-commit-edits.py|${REPO_ROOT}/hooks/pre-tool-use/01-block-pre-commit-edits.py"
  "pre-tool-use/block-dangerous-bash.py|${REPO_ROOT}/hooks/pre-tool-use/block-dangerous-bash.py"
  "pre-tool-use/block-env-writes.py|${REPO_ROOT}/hooks/pre-tool-use/block-env-writes.py"
  "post-tool-use/02-block-bd-truncation.py|${REPO_ROOT}/hooks/post-tool-use/02-block-bd-truncation.py"
  "post-tool-use/03-block-pre-commit-bash.py|${REPO_ROOT}/hooks/post-tool-use/03-block-pre-commit-bash.py"
  "post-tool-use/04-block-pre-existing-checks.py|${REPO_ROOT}/hooks/post-tool-use/04-block-pre-existing-checks.py"
)

if [[ ${#HOOK_LIST[@]} -eq 0 ]]; then
  error "no XPowers hooks configured"
  exit 1
fi

# Verify sources exist
for entry in "${HOOK_LIST[@]}"; do
  src="${entry#*|}"
  [[ -f "$src" ]] || { error "missing hook source: ${src}"; exit 1; }
done

# ---------------------------------------------------------------------------
# Install hook scripts
# ---------------------------------------------------------------------------
install_hook_scripts() {
  ensure_dir "${HOOKS_DIR}/pre-tool-use"
  ensure_dir "${HOOKS_DIR}/post-tool-use"

  for entry in "${HOOK_LIST[@]}"; do
    local dest="${entry%%|*}"
    local src="${entry#*|}"
    local target="${HOOKS_DIR}/${dest}"
    if [[ "$DRY_RUN" == true ]]; then
      info "would copy ${src} -> ${target}"
    else
      cp "$src" "$target"
      chmod +x "$target"
      info "installed ${target}"
    fi
  done
}

# ---------------------------------------------------------------------------
# Config snippet
# ---------------------------------------------------------------------------
XPOWERS_HOOKS_MARKER="# BEGIN XPOWERS KIMI-CODE HOOKS"
XPOWERS_HOOKS_END="# END XPOWERS KIMI-CODE HOOKS"

build_hook_config() {
  cat <<'TOML'

# BEGIN XPOWERS KIMI-CODE HOOKS
# Installed by xpowers. These guard hooks block risky operations and beads
# truncation markers. Keep this block intact so updates can replace it.

# Pre-tool hooks: inspect every tool call before execution.
[[hooks]]
event = "PreToolUse"
command = "python3 ~/.kimi-code/hooks/pre-tool-use/block-beads-direct-read.py"
timeout = 5

[[hooks]]
event = "PreToolUse"
command = "python3 ~/.kimi-code/hooks/pre-tool-use/01-block-pre-commit-edits.py"
timeout = 5

[[hooks]]
event = "PreToolUse"
command = "python3 ~/.kimi-code/hooks/pre-tool-use/block-dangerous-bash.py"
timeout = 5

[[hooks]]
event = "PreToolUse"
command = "python3 ~/.kimi-code/hooks/pre-tool-use/block-env-writes.py"
timeout = 5

# Post-tool hooks: inspect tool results after execution.
[[hooks]]
event = "PostToolUse"
matcher = "Bash"
command = "python3 ~/.kimi-code/hooks/post-tool-use/02-block-bd-truncation.py"
timeout = 5

[[hooks]]
event = "PostToolUse"
matcher = "Bash"
command = "python3 ~/.kimi-code/hooks/post-tool-use/03-block-pre-commit-bash.py"
timeout = 5

[[hooks]]
event = "PostToolUse"
matcher = "Bash"
command = "python3 ~/.kimi-code/hooks/post-tool-use/04-block-pre-existing-checks.py"
timeout = 5
# END XPOWERS KIMI-CODE HOOKS
TOML
}

update_config() {
  if [[ "$DRY_RUN" == true ]]; then
    info "would update ${CONFIG_FILE} with XPowers hooks"
    return 0
  fi

  ensure_dir "$(dirname "$CONFIG_FILE")"

  local snippet; snippet="$(build_hook_config)"

  if [[ ! -f "$CONFIG_FILE" ]]; then
    # Create a minimal config file with only the hooks section
    printf '%s\n' "$snippet" > "$CONFIG_FILE"
    info "created ${CONFIG_FILE} with XPowers hooks"
    return 0
  fi

  backup_config

  local tmp; tmp="$(mktemp)"
  # Remove any existing XPowers hooks block, then append the fresh one
  awk '
    /# BEGIN XPOWERS KIMI-CODE HOOKS/ { in_block = 1; next }
    /# END XPOWERS KIMI-CODE HOOKS/   { in_block = 0; next }
    !in_block { print }
  ' "$CONFIG_FILE" > "$tmp"

  # Append the new block
  printf '%s\n' "$snippet" >> "$tmp"

  if command -v python3 >/dev/null 2>&1; then
    # Validate that the result is parseable TOML when a parser is available.
    if ! python3 - "$tmp" <<'PY'
import sys
try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        sys.exit(0)  # No TOML parser available; skip validation
path = sys.argv[1]
try:
    with open(path, 'rb') as f:
        tomllib.load(f)
except Exception as e:
    print(e, file=sys.stderr)
    sys.exit(1)
sys.exit(0)
PY
    then
      warn "generated TOML failed parse check; restoring original config"
      mv "$CONFIG_FILE" "${CONFIG_FILE}.invalid"
      mv "$tmp" "$CONFIG_FILE"
      warn "original config saved to ${CONFIG_FILE}.invalid"
      return 1
    fi
  fi

  mv "$tmp" "$CONFIG_FILE"
  info "updated ${CONFIG_FILE} with XPowers hooks"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
install_hook_scripts
update_config

info "Kimi Code guard hooks installed. Run 'kimi /reload' or restart Kimi Code to apply."
