#!/usr/bin/env bash
set -euo pipefail

# XPowers Unified Multi-Agent Installer
# Detects installed AI coding agents and installs xpowers to all of them.
# Supports: Claude Code, OpenCode, Kimi Code CLI, Kimi CLI (legacy), Codex CLI, Gemini CLI, Pi Agent

# ---------------------------------------------------------------------------
# Common infrastructure
# ---------------------------------------------------------------------------

SCRIPT_SOURCE="${BASH_SOURCE[0]-}"
SCRIPT_DIR=""
REPO_ROOT=""

if [[ -n "$SCRIPT_SOURCE" && -f "$SCRIPT_SOURCE" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi

bootstrap_error() { printf 'xpowers installer: %s\n' "$*" >&2; }

is_xpowers_checkout() {
  [[ -n "$REPO_ROOT" ]] \
    && [[ -f "${REPO_ROOT}/.claude-plugin/plugin.json" ]] \
    && [[ -f "${REPO_ROOT}/scripts/install.sh" ]] \
    && [[ -f "${REPO_ROOT}/scripts/install.ts" ]]
}

clone_xpowers_checkout() {
  local repo_url="$1"
  local ref="$2"
  local clone_dir="$3"

  if git clone --quiet --depth 1 --branch "$ref" "$repo_url" "$clone_dir" 2>/dev/null; then
    return 0
  fi

  rm -rf "$clone_dir"
  if ! git clone --quiet "$repo_url" "$clone_dir"; then
    return 1
  fi

  git -C "$clone_dir" checkout --quiet "$ref"
}

bootstrap_from_checkout() {
  if is_xpowers_checkout; then
    return 0
  fi

  if ! command -v git >/dev/null 2>&1; then
    bootstrap_error "git is required when running install.sh from curl/stdin."
    exit 1
  fi

  local repo_url="${XPOWERS_REPO_URL:-https://github.com/dpolishuk/xpowers.git}"
  local ref="${XPOWERS_REF:-main}"
  local temp_root
  temp_root="$(mktemp -d "${TMPDIR:-/tmp}/xpowers-install.XXXXXX")"
  local clone_dir="${temp_root}/xpowers"

  cleanup_bootstrap() {
    local status=$?
    rm -rf "$temp_root"
    exit "$status"
  }
  trap cleanup_bootstrap EXIT INT TERM

  if ! clone_xpowers_checkout "$repo_url" "$ref" "$clone_dir"; then
    bootstrap_error "failed to clone XPowers from ${repo_url} at ref ${ref}."
    exit 1
  fi

  if [[ ! -f "${clone_dir}/scripts/install.sh" ]]; then
    bootstrap_error "cloned repository does not contain scripts/install.sh."
    exit 1
  fi

  set +e
  bash "${clone_dir}/scripts/install.sh" "$@"
  local delegated_status=$?
  set -e
  exit "$delegated_status"
}

bootstrap_from_checkout "$@"

VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' \
  "$REPO_ROOT/.claude-plugin/plugin.json" | grep -o '"[^"]*"$' | tr -d '"')

# Colors (respect NO_COLOR and non-tty)
if [[ -n "${NO_COLOR:-}" ]] || ! [[ -t 1 ]]; then
  RED='' GREEN='' YELLOW='' BLUE='' BOLD='' DIM='' CYAN='' RESET=''
else
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  BOLD='\033[1m'
  DIM='\033[2m'
  CYAN='\033[0;36m'
  RESET='\033[0m'
fi

info()    { echo -e "${BLUE}i${RESET} $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET} $*" >&2; }
error()   { echo -e "${RED}✗${RESET} $*" >&2; }

header() {
  echo -e "${BOLD}╭─────────────────────────────────────────╮${RESET}"
  printf  "${BOLD}│${RESET}  XPowers Installer ${CYAN}v%-16s${RESET} ${BOLD}│${RESET}\n" "$VERSION"
  echo -e "${BOLD}╰─────────────────────────────────────────╯${RESET}"
  echo
}

# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

XDG_CFG="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFLICT_NAMES=(hyperpowers myhyperpowers superpowers)

ensure_dir() { mkdir -p "$1" 2>/dev/null || { error "Cannot create $1"; return 1; }; }

count_items() {
  # count_items <glob_pattern>  — returns count on stdout
  local pattern="$1"
  # shellcheck disable=SC2012,SC2086
  set +e; local n; n=$(ls -1d $pattern 2>/dev/null | wc -l); set -e
  echo "${n// /}"
}

conflict_candidates_for() {
  local name="$1"
  printf '%s\n' \
    "${HOME}/.claude/plugins/${name}@${name}" \
    "${HOME}/.claude/plugins/${name}" \
    "${XDG_CFG}/opencode/plugins/${name}" \
    "${XDG_CFG}/opencode/skills/${name}" \
    "${XDG_CFG}/agents/skills/${name}" \
    "${HOME}/.codex/skills/${name}" \
    "${HOME}/.agents/skills/${name}" \
    "${HOME}/.pi/agent/extensions/${name}"
}

detect_conflicts() {
  local found=false
  for name in "${CONFLICT_NAMES[@]}"; do
    while IFS= read -r candidate; do
      if [[ -e "$candidate" ]]; then
        printf '%s|%s\n' "$name" "$candidate"
        found=true
      fi
    done < <(conflict_candidates_for "$name")
  done
  [[ "$found" == true ]]
}

print_conflict_warning() {
  local conflicts="$1"
  error "Conflicting install(s) detected. Remove these before installing XPowers, or rerun with --allow-conflicts if you intentionally want both systems active:"
  while IFS='|' read -r name candidate; do
    [[ -n "$name" ]] || continue
    warn "- ${name}: ${candidate}"
    if [[ "$candidate" == *"${name}@${name}"* ]]; then
      warn "  Claude Code: /plugin uninstall ${name}@${name} --scope user"
    else
      warn "  Remove or uninstall ${name} from this host before installing XPowers."
    fi
  done <<< "$conflicts"
}

backup_dir() {
  local target="$1" backup_root="$2"
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  local dest="${backup_root}/backup-${stamp}"
  ensure_dir "$dest"
  cp -R "$target"/* "$dest/" 2>/dev/null || true
  # Keep last 3 backups
  if [[ -d "$backup_root" ]]; then
    # shellcheck disable=SC2012
    ls -1t "$backup_root" 2>/dev/null | tail -n +4 | while read -r old; do
      rm -rf "${backup_root:?}/${old}"
    done
  fi
  echo "$dest"
}

LEGACY_QUARANTINE_DIR="${HOME}/.xpowers-quarantine"

quarantine_item() {
  local target="$1"
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  local seq=0
  local dest="${LEGACY_QUARANTINE_DIR}/${stamp}-$(basename "$target")"
  while [[ -e "$dest" ]]; do
    seq=$((seq + 1))
    dest="${LEGACY_QUARANTINE_DIR}/${stamp}-${seq}-$(basename "$target")"
  done
  ensure_dir "$LEGACY_QUARANTINE_DIR"
  if [[ -d "$target" ]]; then
    if ! cp -R "$target" "$dest" 2>/dev/null; then
      return 1
    fi
  else
    if ! cp "$target" "$dest" 2>/dev/null; then
      return 1
    fi
  fi
  echo "$dest"
}

remove_legacy_from_manifest() {
  local home="$1"
  local manifest="$2"
  local count=0

  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    [[ "$entry" == \#* ]] && continue
    [[ "$entry" == /* ]] && continue
    [[ "$entry" == *..* ]] && continue
    [[ "$entry" == "." ]] && continue
    local target="${home}/${entry}"
    if [[ "$DRY_RUN" == true ]]; then
      echo "  Would remove (legacy manifest): ${target}" >&2
      count=$((count + 1))
      continue
    fi
    if [[ "$entry" == */ ]]; then
      local normalized_target="${target%/}"
      if [[ -L "$normalized_target" ]]; then
        rm -f "$normalized_target" && count=$((count + 1))
      elif [[ -d "$normalized_target" ]]; then
        rm -rf "$normalized_target" && count=$((count + 1))
      fi
    else
      [[ -f "$target" ]] && rm -f "$target" && count=$((count + 1))
    fi
  done < "$manifest"

  if [[ "$DRY_RUN" != true ]]; then
    # Clean up empty parent dirs
    for dir in "${home}/skills" "${home}/agents" "${home}/commands" "${home}/hooks" "${home}/plugins"; do
      [[ -d "$dir" ]] && rmdir "$dir" 2>/dev/null || true
    done
    # Remove the processed manifest and its corresponding version file
    rm -f "$manifest"
    local manifest_basename; manifest_basename="$(basename "$manifest")"
    local version_file="${home}/${manifest_basename//-manifest/-version}"
    rm -f "$version_file"
  fi

  echo "$count"
}

remove_legacy() {
  local total_removed=0
  declare -A processed_manifests

  for name in "${CONFLICT_NAMES[@]}"; do
    while IFS= read -r candidate; do
      # Determine agent home for manifest lookup (regardless of candidate existence)
      local agent_home=""
      case "$candidate" in
        "${HOME}/.claude"*) agent_home="${HOME}/.claude" ;;
        "${XDG_CFG}/opencode"*) agent_home="${XDG_CFG}/opencode" ;;
        "${XDG_CFG}/agents"*) agent_home="${XDG_CFG}/agents" ;;
        "${HOME}/.codex"*) agent_home="${HOME}/.codex" ;;
        "${HOME}/.agents"*) agent_home="${HOME}/.agents" ;;
        "${HOME}/.pi"*) agent_home="${HOME}/.pi/agent" ;;
      esac

      # Manifest-driven removal for this agent home (process every manifest found)
      if [[ -n "$agent_home" ]]; then
        for legacy_name in hyperpowers myhyperpowers superpowers; do
          local legacy_manifest="${agent_home}/.${legacy_name}-manifest"
          if [[ -f "$legacy_manifest" && -z "${processed_manifests[$legacy_manifest]:-}" ]]; then
            if [[ "$DRY_RUN" != true ]] && [[ "$PURGE" != true ]]; then
              while IFS= read -r entry; do
                [[ -z "$entry" ]] && continue
                [[ "$entry" == \#* ]] && continue
                [[ "$entry" == /* ]] && continue
                [[ "$entry" == *..* ]] && continue
                [[ "$entry" == "." ]] && continue
                local entry_path="${agent_home}/${entry}"
                if [[ -e "$entry_path" ]]; then
                  if ! quarantine_item "$entry_path" >/dev/null; then
                    error "Failed to quarantine ${entry_path}. Aborting to prevent data loss."
                    exit 1
                  fi
                fi
              done < "$legacy_manifest"
            fi
            local count
            count=$(remove_legacy_from_manifest "$agent_home" "$legacy_manifest")
            total_removed=$((total_removed + count))
            processed_manifests[$legacy_manifest]=1
          fi
        done
      fi

      # Exact-path removal for the candidate itself
      if [[ -e "$candidate" ]]; then
        if [[ "$DRY_RUN" == true ]]; then
          echo "  Would remove (legacy): ${candidate}"
        else
          if [[ "$PURGE" != true ]]; then
            if ! quarantine_item "$candidate" >/dev/null; then
              error "Failed to quarantine ${candidate}. Aborting to prevent data loss."
              exit 1
            fi
          fi
          rm -rf "$candidate"
        fi
        total_removed=$((total_removed + 1))
      fi
    done < <(conflict_candidates_for "$name")
  done

  if [[ "$DRY_RUN" == true ]]; then
    info "Dry run: would remove ${total_removed} legacy item(s)"
  else
    info "Removed ${total_removed} legacy item(s)"
  fi
}

# ---------------------------------------------------------------------------
# Agent detection
# ---------------------------------------------------------------------------

declare -A AGENT_PATHS=()
declare -A AGENT_LABELS=(
  [claude]="Claude Code"
  [opencode]="OpenCode"
  [kimi_code]="Kimi Code CLI"
  [kimi]="Kimi CLI (legacy)"
  [codex]="Codex CLI"
  [gemini]="Gemini CLI"
  [pi]="Pi Agent"
)
AGENT_ORDER=(claude opencode kimi_code kimi codex gemini pi)

detect_claude()  { [[ -d "${HOME}/.claude" ]] && AGENT_PATHS[claude]="${HOME}/.claude" || true; }
detect_opencode(){ [[ -d "${XDG_CFG}/opencode" ]] && AGENT_PATHS[opencode]="${XDG_CFG}/opencode" || true; }
detect_kimi()    {
  if [[ -d "${XDG_CFG}/agents" ]]; then
    AGENT_PATHS[kimi]="${XDG_CFG}/agents"
  elif [[ -d "${HOME}/.kimi" ]]; then
    AGENT_PATHS[kimi]="${HOME}/.kimi"
  fi
}
detect_kimi_code() {
  if command -v kimi &>/dev/null; then
    AGENT_PATHS[kimi_code]="$(command -v kimi)"
  elif [[ -d "${XDG_CFG}/kimi-code" ]]; then
    AGENT_PATHS[kimi_code]="${XDG_CFG}/kimi-code"
  elif [[ -d "${HOME}/.kimi-code" ]]; then
    AGENT_PATHS[kimi_code]="${HOME}/.kimi-code"
  fi
}
detect_codex()   {
  if [[ -d "${HOME}/.codex" ]]; then
    AGENT_PATHS[codex]="${HOME}/.codex"
  elif [[ -d "${HOME}/.agents" ]]; then
    AGENT_PATHS[codex]="${HOME}/.agents"
  elif command -v codex &>/dev/null; then
    AGENT_PATHS[codex]="${HOME}/.codex"
  fi
}
detect_gemini()  { command -v gemini &>/dev/null && AGENT_PATHS[gemini]="$(command -v gemini)" || true; }
detect_pi()      {
  if [[ -d "${HOME}/.pi" ]]; then
    AGENT_PATHS[pi]="${HOME}/.pi/agent"
  elif command -v pi &>/dev/null; then
    AGENT_PATHS[pi]="${HOME}/.pi/agent"
  fi
}

detect_all() {
  detect_claude
  detect_opencode
  detect_kimi_code
  detect_kimi
  detect_codex
  detect_gemini
  detect_pi
}

show_detection() {
  echo -e "  ${BOLD}Detecting agents...${RESET}"
  echo
  for agent in "${AGENT_ORDER[@]}"; do
    local label="${AGENT_LABELS[$agent]}"
    if [[ -n "${AGENT_PATHS[$agent]:-}" ]]; then
      printf "  ${GREEN}✓${RESET} %-16s %s\n" "$label" "${AGENT_PATHS[$agent]}"
    else
      printf "  ${DIM}✗ %-16s not found${RESET}\n" "$label"
    fi
  done
  echo
}

# ---------------------------------------------------------------------------
# Copy/symlink helper — respects USE_SYMLINKS
# ---------------------------------------------------------------------------

copy_item() {
  # copy_item <src> <dest>  — copies or symlinks based on USE_SYMLINKS
  local src="$1" dest="$2"
  if [[ "$USE_SYMLINKS" == true ]]; then
    ln -sfn "$src" "$dest"
  else
    cp -R "$src" "$dest"
  fi
}

copy_files() {
  # copy_files <src_glob> <dest_dir>  — copy matching files (nullglob-safe)
  local src_pattern="$1" dest_dir="$2"
  local had_files=false
  local saved_nullglob
  saved_nullglob=$(shopt -p nullglob 2>/dev/null || true)
  shopt -s nullglob
  for f in $src_pattern; do
    if [[ -f "$f" ]]; then
      copy_item "$f" "${dest_dir}/$(basename "$f")"
      had_files=true
    fi
  done
  eval "$saved_nullglob" 2>/dev/null || true
  $had_files
}

copy_dirs() {
  # copy_dirs <src_glob> <dest_dir> [--exclude <pattern>]
  local src_pattern="$1" dest_dir="$2"
  local exclude_pattern="${4:-}"
  local had_dirs=false
  local saved_nullglob
  saved_nullglob=$(shopt -p nullglob 2>/dev/null || true)
  shopt -s nullglob
  for d in $src_pattern; do
    [[ -d "$d" ]] || continue
    local name; name="$(basename "$d")"
    # shellcheck disable=SC2053  # Intentional glob matching
    if [[ -n "$exclude_pattern" ]] && [[ "$name" == $exclude_pattern ]]; then
      continue
    fi
    copy_item "$d" "${dest_dir}/${name}"
    had_dirs=true
  done
  eval "$saved_nullglob" 2>/dev/null || true
  $had_dirs
}

maybe_backup() {
  # maybe_backup <target_dir> <backup_root>  — backup if .xpowers-version exists
  local target="$1" backup_root="$2"
  if [[ -f "${target}/.xpowers-version" ]]; then
    local old_ver; old_ver=$(cat "${target}/.xpowers-version")
    info "Upgrading ${old_ver} → ${VERSION}"
    backup_dir "$target" "$backup_root" >/dev/null
  fi
}

# ---------------------------------------------------------------------------
# Manifest tracking — records what we install so uninstall is safe
# ---------------------------------------------------------------------------

MANIFEST_ENTRIES=()

manifest_add() {
  # manifest_add <relative_path>  — track a file or dir (dirs end with /)
  MANIFEST_ENTRIES+=("$1")
}

write_manifest() {
  # write_manifest <agent_home>  — write .xpowers-manifest (overwrites)
  local home="$1"
  local manifest="${home}/.xpowers-manifest"
  if [[ "$DRY_RUN" == true ]]; then
    return 0
  fi
  {
    echo "# .xpowers-manifest - installed by xpowers v${VERSION}"
    echo "# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '%s\n' "${MANIFEST_ENTRIES[@]}"
  } > "$manifest"
}

uninstall_from_manifest() {
  # uninstall_from_manifest <agent_home>  — remove only manifest-listed entries
  local home="$1"
  local manifest="${home}/.xpowers-manifest"
  local old_ns="hyper""powers"
  local legacy_manifest="${home}/.${old_ns}-manifest"

  if [[ ! -f "$manifest" && -f "$legacy_manifest" ]]; then
    manifest="$legacy_manifest"
  fi

  if [[ ! -f "$manifest" ]]; then
    if [[ "$PURGE" == true ]]; then
      # Marker-driven purge: only remove exact files and backups; never delete
      # broad directories without a manifest.
      local count=0
      for f in .xpowers-version .xpowers-manifest ".${old_ns}-version" ".${old_ns}-manifest"; do
        if [[ -f "${home}/${f}" ]]; then
          if [[ "$DRY_RUN" == true ]]; then
            echo "  Would remove (marker-driven): ${home}/${f}" >&2
          else
            rm -f "${home}/${f}"
          fi
          count=$((count + 1))
        fi
      done
      if [[ -d "${home}/.xpowers-backups" ]]; then
        if [[ "$DRY_RUN" == true ]]; then
          echo "  Would remove (marker-driven): ${home}/.xpowers-backups/" >&2
        else
          rm -rf "${home}/.xpowers-backups"
        fi
        count=$((count + 1))
      fi
      if [[ "$DRY_RUN" == true ]]; then
        info "Dry run (marker-driven purge): would remove ${count} items from ${home}"
      else
        info "Marker-driven purge: removed ${count} items from ${home}"
      fi
      return 0
    fi
    warn "No manifest found for ${home}. Reinstall to generate manifest, or use --purge for marker-driven cleanup."
    return 1
  fi

  local count=0
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    [[ "$entry" == \#* ]] && continue
    [[ "$entry" == /* ]] && continue
    [[ "$entry" == *..* ]] && continue
    [[ "$entry" == "." ]] && continue
    local target="${home}/${entry}"
    if [[ "$DRY_RUN" == true ]]; then
      echo "  Would remove: ${target}"
      count=$((count + 1))
      continue
    fi
    if [[ "$entry" == */ ]]; then
      # Directory entry — guard against symlink traversal
      local normalized_target="${target%/}"
      if [[ -L "$normalized_target" ]]; then
        rm -f "$normalized_target" && count=$((count + 1))
      elif [[ -d "$normalized_target" ]]; then
        rm -rf "$normalized_target" && count=$((count + 1))
      fi
    else
      # File entry
      [[ -f "$target" ]] && rm -f "$target" && count=$((count + 1))
    fi
  done < "$manifest"

  if [[ "$DRY_RUN" == true ]]; then
    info "Dry run: would remove ${count} items from ${home}"
    return 0
  fi

  # Clean up empty parent dirs (skills/, agents/, etc.)
  for dir in "${home}/skills" "${home}/agents" "${home}/commands" "${home}/hooks" "${home}/plugins"; do
    [[ -d "$dir" ]] && rmdir "$dir" 2>/dev/null || true
  done

  # Remove manifest and version (including legacy names when present)
  rm -f "$manifest"
  rm -f "${home}/.xpowers-manifest" "${home}/.${old_ns}-manifest"
  rm -f "${home}/.xpowers-version" "${home}/.${old_ns}-version"

  # Purge: also remove backups
  if [[ "$PURGE" == true ]]; then
    rm -rf "${home}/.xpowers-backups"
  fi

  info "Removed ${count} items from ${home}"
}

# ---------------------------------------------------------------------------
# Install functions
# ---------------------------------------------------------------------------

install_claude() {
  local home="${AGENT_PATHS[claude]:-${HOME}/.claude}"
  MANIFEST_ENTRIES=()
  ensure_dir "${home}/skills"
  ensure_dir "${home}/agents"
  ensure_dir "${home}/commands"
  ensure_dir "${home}/hooks"
  maybe_backup "$home" "${home}/.xpowers-backups"

  # Skills (recursive copy of each skill dir)
  for d in "${REPO_ROOT}"/skills/*/; do
    [[ -d "$d" ]] || continue
    local name; name="$(basename "$d")"
    [[ "$name" == "common-patterns" ]] && continue
    copy_item "$d" "${home}/skills/${name}"
    manifest_add "skills/${name}/"
  done

  # Agents (.md files, excluding CLAUDE.md)
  for f in "${REPO_ROOT}"/agents/*.md; do
    [[ -f "$f" ]] || continue
    local name; name="$(basename "$f")"
    [[ "$name" == "CLAUDE.md" ]] && continue
    copy_item "$f" "${home}/agents/${name}"
    manifest_add "agents/${name}"
  done

  # Commands
  for f in "${REPO_ROOT}"/commands/*.md; do
    [[ -f "$f" ]] || continue
    local name; name="$(basename "$f")"
    copy_item "$f" "${home}/commands/${name}"
    manifest_add "commands/${name}"
  done

  # Hooks — RECURSIVE copy (fixes bug: old installer only copied files)
  cp -R "${REPO_ROOT}/hooks/"* "${home}/hooks/" 2>/dev/null || true
  if [[ "$USE_SYMLINKS" == true ]]; then
    rm -rf "${home}/hooks/"*
    for item in "${REPO_ROOT}"/hooks/*; do
      [[ -e "$item" ]] || continue
      ln -sfn "$item" "${home}/hooks/$(basename "$item")"
    done
  fi
  # Track each top-level hooks item
  for item in "${REPO_ROOT}"/hooks/*; do
    [[ -e "$item" ]] || continue
    local name; name="$(basename "$item")"
    if [[ -d "$item" ]]; then
      manifest_add "hooks/${name}/"
    else
      manifest_add "hooks/${name}"
    fi
  done

  # Status line script
  copy_item "${REPO_ROOT}/scripts/xpowers-statusline.sh" "${home}/xpowers-statusline.sh"
  chmod +x "${home}/xpowers-statusline.sh"
  manifest_add "xpowers-statusline.sh"

  # Configure status line in settings.json if not already set
  local settings="${home}/settings.json"
  local statusline_cmd="${home}/xpowers-statusline.sh"
  if [[ -f "$settings" ]]; then
    if ! python3 -c "import json; d=json.load(open('$settings')); assert d.get('statusline')" 2>/dev/null; then
      local tmp; tmp=$(mktemp)
      if python3 -c "
import json
with open('$settings') as f:
    d = json.load(f)
d['statusline'] = '$statusline_cmd'
with open('$tmp', 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')
" 2>/dev/null && mv "$tmp" "$settings"; then
        echo "  Configured status line in settings.json"
      else
        rm -f "$tmp"
      fi
    fi
  else
    if command -v python3 >/dev/null 2>&1; then
      echo '{"statusline":"'"$statusline_cmd"'"}' | python3 -m json.tool > "$settings" 2>/dev/null || true
      echo "  Created settings.json with status line"
    else
      echo "  Warning: python3 not found, skipping settings.json creation"
    fi
  fi

  manifest_add ".xpowers-version"
  echo "${VERSION}" > "${home}/.xpowers-version"
  write_manifest "$home"

  # Offer to install memsearch for long-term memory
  if [[ "$FORCE" != true ]] && [[ -t 0 ]]; then
    echo ""
    echo "  Would you like to install memsearch for long-term cross-session memory?"
    echo "  Uses local ONNX embeddings (no API key needed for embeddings)."
    echo "  Memories stored as plain markdown files in ~/.memsearch/memory/"
    echo ""
    echo -n "  Install memsearch? [y/N] "
    read -r answer </dev/tty
    if [[ "${answer,,}" == "y" || "${answer,,}" == "yes" ]]; then
      if command -v python3 >/dev/null 2>&1; then
        echo "  Installing memsearch[onnx]..."
        python3 -m pip install --user "memsearch[onnx]" --quiet && echo "  memsearch installed." || warn "memsearch install failed — try: python3 -m pip install --user memsearch[onnx]"
        if command -v memsearch >/dev/null 2>&1; then
          echo "  Initializing memsearch config..."
          memsearch config init --non-interactive 2>/dev/null || memsearch config init 2>/dev/null || true
        fi
      else
        warn "python3 not found — install memsearch manually: python3 -m pip install --user memsearch[onnx]"
      fi
    fi
  fi
}

install_opencode() {
  local home="${AGENT_PATHS[opencode]:-${XDG_CFG}/opencode}"
  MANIFEST_ENTRIES=()
  ensure_dir "${home}/skills"
  ensure_dir "${home}/agents"
  ensure_dir "${home}/commands"
  ensure_dir "${home}/plugins"
  maybe_backup "$home" "${home}/.xpowers-backups"

  # Skills (only xpowers-* prefixed — already curated in .opencode/skills/)
  for d in "${REPO_ROOT}"/.opencode/skills/xpowers-*/; do
    [[ -d "$d" ]] || continue
    local name; name="$(basename "$d")"
    copy_item "$d" "${home}/skills/${name}"
    manifest_add "skills/${name}/"
  done
  if [[ -d "${REPO_ROOT}/.opencode/skills/beads-triage" ]]; then
    copy_item "${REPO_ROOT}/.opencode/skills/beads-triage" "${home}/skills/beads-triage"
    manifest_add "skills/beads-triage/"
  fi

  # Agents
  for f in "${REPO_ROOT}"/.opencode/agents/*.md; do
    [[ -f "$f" ]] || continue
    local name; name="$(basename "$f")"
    copy_item "$f" "${home}/agents/${name}"
    manifest_add "agents/${name}"
  done

  # Commands
  for f in "${REPO_ROOT}"/.opencode/commands/*.md; do
    [[ -f "$f" ]] || continue
    local name; name="$(basename "$f")"
    copy_item "$f" "${home}/commands/${name}"
    manifest_add "commands/${name}"
  done

  # Plugins
  for f in "${REPO_ROOT}"/.opencode/plugins/*.ts; do
    [[ -f "$f" ]] || continue
    local name; name="$(basename "$f")"
    copy_item "$f" "${home}/plugins/${name}"
    manifest_add "plugins/${name}"
  done

  # Package.json + bun install
  if [[ -f "${REPO_ROOT}/.opencode/package.json" ]]; then
    copy_item "${REPO_ROOT}/.opencode/package.json" "${home}/package.json"
    manifest_add "package.json"
    if command -v bun &>/dev/null; then
      (cd "$home" && bun install --silent 2>/dev/null) || warn "bun install failed in ${home}"
    else
      warn "bun not found — run 'bun install' in ${home} manually"
    fi
  fi

  # Extra config files
  for f in task-context.json cass-memory.json; do
    if [[ -f "${REPO_ROOT}/.opencode/${f}" ]]; then
      copy_item "${REPO_ROOT}/.opencode/${f}" "${home}/${f}"
      manifest_add "${f}"
    fi
  done

  manifest_add ".xpowers-version"
  echo "${VERSION}" > "${home}/.xpowers-version"
  write_manifest "$home"

  # Offer to run routing wizard for agent model + effort setup
  if [[ "$FORCE" != true ]] && [[ -t 0 ]] && command -v bun &>/dev/null; then
    echo ""
    echo "  Would you like to configure agent models and effort levels now?"
    echo "  This runs the interactive routing wizard (you can also run it later"
    echo "  with: bun scripts/opencode-routing-wizard.ts)"
    echo ""
    echo -n "  Run routing wizard? [y/N] "
    read -r answer </dev/tty
    if [[ "${answer,,}" == "y" || "${answer,,}" == "yes" ]]; then
      bun "${REPO_ROOT}/scripts/opencode-routing-wizard.ts" || warn "Routing wizard failed"
    fi
  fi

  # Offer to install memsearch for long-term memory (same as Claude Code)
  if [[ "$FORCE" != true ]] && [[ -t 0 ]]; then
    echo ""
    echo "  Would you like to install memsearch for long-term cross-session memory?"
    echo "  Uses local ONNX embeddings (no API key needed for embeddings)."
    echo "  Memories stored as plain markdown files in ~/.memsearch/memory/"
    echo ""
    echo -n "  Install memsearch? [y/N] "
    read -r answer </dev/tty
    if [[ "${answer,,}" == "y" || "${answer,,}" == "yes" ]]; then
      if command -v python3 >/dev/null 2>&1; then
        echo "  Installing memsearch[onnx]..."
        python3 -m pip install --user "memsearch[onnx]" --quiet && echo "  memsearch installed." || warn "memsearch install failed"
        if command -v memsearch >/dev/null 2>&1; then
          echo "  Initializing memsearch config..."
          memsearch config init --non-interactive 2>/dev/null || memsearch config init 2>/dev/null || true
        fi
      else
        warn "python3 not found — install memsearch manually: python3 -m pip install --user memsearch[onnx]"
      fi
    fi
  fi
}

install_kimi() {
  local home="${AGENT_PATHS[kimi]:-${XDG_CFG}/agents}"
  MANIFEST_ENTRIES=()
  ensure_dir "${home}/skills"
  maybe_backup "$home" "${home}/.xpowers-backups"

  # Clean up old codex-* pollution from previous installs
  for old_codex in "${home}"/skills/codex-*/; do
    [[ -d "$old_codex" ]] && rm -rf "$old_codex"
  done

  # Skills — FILTERED: exclude codex-* and common-patterns
  for skill_dir in "${REPO_ROOT}"/.kimi/skills/*/; do
    [[ -d "$skill_dir" ]] || continue
    local dirname; dirname="$(basename "$skill_dir")"
    [[ "$dirname" == codex-* ]] && continue
    [[ "$dirname" == common-patterns ]] && continue
    copy_item "$skill_dir" "${home}/skills/${dirname}"
    manifest_add "skills/${dirname}/"
  done

  # Agent YAML + system prompts
  for f in "${REPO_ROOT}"/.kimi/agents/*.yaml "${REPO_ROOT}"/.kimi/agents/*-system.md; do
    [[ -f "$f" ]] || continue
    local name; name="$(basename "$f")"
    copy_item "$f" "${home}/${name}"
    manifest_add "${name}"
  done

  # Main agent config
  for f in xpowers.yaml xpowers-system.md; do
    if [[ -f "${REPO_ROOT}/.kimi/${f}" ]]; then
      copy_item "${REPO_ROOT}/.kimi/${f}" "${home}/${f}"
      manifest_add "${f}"
    fi
  done

  # MCP config merge (requires jq) — NOT tracked in manifest (can't un-merge)
  if command -v jq &>/dev/null && [[ -f "${REPO_ROOT}/.kimi/mcp.json" ]]; then
    local kimi_mcp="${XDG_CFG}/kimi/mcp.json"
    if [[ -f "$kimi_mcp" ]]; then
      jq -s '.[0] * .[1]' "$kimi_mcp" "${REPO_ROOT}/.kimi/mcp.json" > "${kimi_mcp}.tmp" \
        && mv "${kimi_mcp}.tmp" "$kimi_mcp"
    else
      ensure_dir "$(dirname "$kimi_mcp")"
      cp "${REPO_ROOT}/.kimi/mcp.json" "$kimi_mcp"
    fi
  elif [[ -f "${REPO_ROOT}/.kimi/mcp.json" ]]; then
    warn "jq not found — MCP config not merged. Install jq and re-run."
  fi

  manifest_add ".xpowers-version"
  echo "${VERSION}" > "${home}/.xpowers-version"
  write_manifest "$home"
}

install_kimi_code() {
  local home="${XDG_CFG}/kimi-code"
  MANIFEST_ENTRIES=()
  ensure_dir "${home}/skills"

  # Canonical user-level skill path for Kimi Code CLI. Kimi Code discovers
  # skills under ~/.kimi-code/skills/ automatically, so this works even when
  # the native `kimi plugin` command is unavailable.
  local source_skills="${REPO_ROOT}/.kimi-code/skills"
  for skill_dir in "${source_skills}"/*/; do
    [[ -d "$skill_dir" ]] || continue
    local dirname; dirname="$(basename "$skill_dir")"
    [[ "$dirname" == codex-* ]] && continue
    [[ "$dirname" == common-patterns ]] && continue
    copy_item "$skill_dir" "${home}/skills/${dirname}"
    manifest_add "skills/${dirname}/"
  done

  # Plugin registration: when the `kimi` binary is available, register the
  # repository as a plugin so MCP servers and plugin metadata are loaded.
  if command -v kimi &>/dev/null; then
    if [[ "$DRY_RUN" == true ]]; then
      info "Would run: kimi plugin install ${REPO_ROOT}"
    else
      local install_stderr
      install_stderr=$(kimi plugin install "$REPO_ROOT" 2>&1) || {
        warn "kimi plugin install failed: ${install_stderr}"
      }
    fi
  fi

  # Also copy plugin metadata to a local plugin directory so the repo can be
  # loaded as a plugin even when the plugin manager did not run.
  if [[ -f "${REPO_ROOT}/kimi.plugin.json" ]]; then
    local plugin_dir="${home}/plugins/xpowers"
    ensure_dir "$plugin_dir"
    if command -v python3 >/dev/null 2>&1; then
      python3 -c "
import json, sys
src = sys.argv[1]
dst = sys.argv[2]
with open(src) as f:
    data = json.load(f)
# Local copy keeps skills in the canonical user-level skills directory.
data['skills'] = '../../skills/'
with open(dst, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" "${REPO_ROOT}/kimi.plugin.json" "${plugin_dir}/kimi.plugin.json"
    else
      cp "${REPO_ROOT}/kimi.plugin.json" "${plugin_dir}/kimi.plugin.json"
      warn "python3 not found — ${plugin_dir}/kimi.plugin.json skills path may need manual adjustment"
    fi
    manifest_add "plugins/xpowers/kimi.plugin.json"
  fi

  # Install guard hooks into ~/.kimi-code/config.toml
  local hook_script="${REPO_ROOT}/scripts/install-kimi-code-hooks.sh"
  if [[ -x "$hook_script" ]]; then
    if [[ "$DRY_RUN" == true ]]; then
      info "Would run: ${hook_script}"
    else
      bash "$hook_script" || warn "Kimi Code hook installation failed"
    fi
  fi

  manifest_add ".xpowers-version"
  echo "${VERSION}" > "${home}/.xpowers-version"
  write_manifest "$home"
}

install_codex() {
  MANIFEST_ENTRIES=()

  # Prerequisite: sync-codex-skills generates wrappers
  if command -v node &>/dev/null; then
    if ! node "${REPO_ROOT}/scripts/sync-codex-skills.js" --check 2>/dev/null; then
      node "${REPO_ROOT}/scripts/sync-codex-skills.js" 2>/dev/null \
        || warn "sync-codex-skills.js failed — Codex wrappers may be stale"
    fi
  else
    warn "node not found — cannot sync Codex wrappers"
  fi

  # Determine target directory
  local home
  if [[ "$CODEX_SCOPE" == "local" ]]; then
    home=".codex"
  else
    home="${AGENT_PATHS[codex]:-${HOME}/.codex}"
  fi
  ensure_dir "${home}/skills"
  maybe_backup "$home" "${home}/.xpowers-backups"

  # Source: read from canonical .kimi/skills/codex-* (NOT through .agents symlink)
  local source_base="${REPO_ROOT}/.kimi/skills"
  local copied=0
  for skill_dir in "${source_base}"/codex-*/; do
    [[ -d "$skill_dir" ]] || continue
    local dirname; dirname="$(basename "$skill_dir")"
    copy_item "$skill_dir" "${home}/skills/${dirname}"
    manifest_add "skills/${dirname}/"
    copied=$((copied + 1))
  done

  # Also copy from .opencode codex-* dirs (commands/agents wrappers)
  for skill_dir in "${REPO_ROOT}"/.opencode/codex-*/; do
    [[ -d "$skill_dir" ]] || continue
    local dirname; dirname="$(basename "$skill_dir")"
    copy_item "$skill_dir" "${home}/skills/${dirname}"
    manifest_add "skills/${dirname}/"
    copied=$((copied + 1))
  done

  if [[ $copied -eq 0 ]]; then
    warn "No codex-* skill directories found in source"
    return 1
  fi

  manifest_add ".xpowers-version"
  echo "${VERSION}" > "${home}/.xpowers-version"
  write_manifest "$home"
}

install_gemini() {
  if ! command -v gemini &>/dev/null; then
    error "gemini CLI not found in PATH"
    return 1
  fi

  local ext_dir="${REPO_ROOT}/.gemini-extension"
  if [[ ! -d "$ext_dir" ]]; then
    error "Gemini extension directory not found: ${ext_dir}"
    return 1
  fi

  # Remove legacy hyperpowers extension if present
  local gemini_ext_home="${HOME}/.gemini/extensions"
  if [[ -d "${gemini_ext_home}/hyperpowers" ]]; then
    rm -rf "${gemini_ext_home}/hyperpowers"
  fi

  # Gemini CLI manages its own directory structure
  local gemini_stderr
  if [[ "$USE_SYMLINKS" == true ]]; then
    gemini_stderr=$(gemini extensions link "$ext_dir" 2>&1) || {
      error "gemini extensions link failed: ${gemini_stderr}"
      return 1
    }
  else
    gemini_stderr=$(gemini extensions install "$ext_dir" 2>&1) || {
      error "gemini extensions install failed: ${gemini_stderr}"
      return 1
    }
  fi
}

# ---------------------------------------------------------------------------
# Validation functions
# ---------------------------------------------------------------------------

validate_claude() {
  local home="${AGENT_PATHS[claude]:-${HOME}/.claude}"
  local ok=true
  [[ -d "${home}/hooks/post-tool-use" ]] || { warn "Claude: hooks/post-tool-use/ missing (recursive copy failed?)"; ok=false; }
  [[ -d "${home}/hooks/pre-tool-use" ]] || { warn "Claude: hooks/pre-tool-use/ missing"; ok=false; }
  local sk; sk=$(count_items "${home}/skills/*/")
  [[ "$sk" -ge 15 ]] || { warn "Claude: only ${sk} skills (expected 15+)"; ok=false; }
  local vf="${home}/.xpowers-version"
  [[ -f "$vf" ]] && [[ "$(cat "$vf")" == "$VERSION" ]] || { warn "Claude: version mismatch"; ok=false; }
  $ok
}

validate_opencode() {
  local home="${AGENT_PATHS[opencode]:-${XDG_CFG}/opencode}"
  local ok=true
  local sk; sk=$(count_items "${home}/skills/*/")
  [[ "$sk" -ge 15 ]] || { warn "OpenCode: only ${sk} skills (expected 15+)"; ok=false; }
  # shellcheck disable=SC2012,SC2086
  local pl; pl=$(ls -1 ${home}/plugins/*.ts 2>/dev/null | wc -l)
  [[ "$pl" -ge 1 ]] || { warn "OpenCode: no plugins found"; ok=false; }
  local vf="${home}/.xpowers-version"
  [[ -f "$vf" ]] && [[ "$(cat "$vf")" == "$VERSION" ]] || { warn "OpenCode: version mismatch"; ok=false; }
  $ok
}

validate_kimi() {
  local home="${AGENT_PATHS[kimi]:-${XDG_CFG}/agents}"
  local ok=true
  local sk; sk=$(count_items "${home}/skills/*/")
  [[ "$sk" -ge 15 ]] || { warn "Kimi: only ${sk} skills (expected 15+)"; ok=false; }
  # Check NO codex-* pollution
  # shellcheck disable=SC2012,SC2086
  local codex_count; codex_count=$(ls -1d ${home}/skills/codex-*/ 2>/dev/null | wc -l)
  [[ "$codex_count" -eq 0 ]] || { warn "Kimi: found ${codex_count} codex-* dirs (should be 0)"; ok=false; }
  [[ -f "${home}/xpowers.yaml" ]] || { warn "Kimi: xpowers.yaml missing"; ok=false; }
  local vf="${home}/.xpowers-version"
  [[ -f "$vf" ]] && [[ "$(cat "$vf")" == "$VERSION" ]] || { warn "Kimi: version mismatch"; ok=false; }
  $ok
}

validate_kimi_code() {
  local home="${XDG_CFG}/kimi-code"
  local plugin_dir="${home}/plugins/xpowers"
  local ok=true
  local sk; sk=$(count_items "${home}/skills/*/")
  [[ "$sk" -ge 15 ]] || { warn "Kimi Code: only ${sk} skills (expected 15+)"; ok=false; }
  # shellcheck disable=SC2012,SC2086
  local codex_count; codex_count=$(ls -1d ${home}/skills/codex-*/ 2>/dev/null | wc -l)
  [[ "$codex_count" -eq 0 ]] || { warn "Kimi Code: found ${codex_count} codex-* dirs (should be 0)"; ok=false; }
  if [[ -f "${plugin_dir}/kimi.plugin.json" ]] && command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys; json.load(open(sys.argv[1]))" "${plugin_dir}/kimi.plugin.json" >/dev/null 2>&1 \
      || { warn "Kimi Code: plugin manifest is invalid JSON"; ok=false; }
  fi
  local vf="${home}/.xpowers-version"
  [[ -f "$vf" ]] && [[ "$(cat "$vf")" == "$VERSION" ]] || { warn "Kimi Code: version mismatch"; ok=false; }
  $ok
}

validate_codex() {
  local home
  if [[ "$CODEX_SCOPE" == "local" ]]; then
    home=".codex"
  else
    home="${AGENT_PATHS[codex]:-${HOME}/.codex}"
  fi
  local ok=true
  local sk; sk=$(count_items "${home}/skills/codex-*/")
  [[ "$sk" -ge 5 ]] || { warn "Codex: only ${sk} codex skills (expected 5+)"; ok=false; }
  local vf="${home}/.xpowers-version"
  [[ -f "$vf" ]] && [[ "$(cat "$vf")" == "$VERSION" ]] || { warn "Codex: version mismatch"; ok=false; }
  $ok
}

validate_gemini() {
  if command -v gemini &>/dev/null; then
    gemini extensions list 2>/dev/null | grep -q xpowers || {
      warn "Gemini: extension not found in 'gemini extensions list'"
      return 1
    }
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Uninstall functions
# ---------------------------------------------------------------------------

uninstall_claude() {
  uninstall_from_manifest "${AGENT_PATHS[claude]:-${HOME}/.claude}"
}

uninstall_opencode() {
  local home="${AGENT_PATHS[opencode]:-${XDG_CFG}/opencode}"
  uninstall_from_manifest "$home"
  # Also clean bun artifacts (not in manifest but generated by bun install)
  if [[ "$DRY_RUN" != true ]]; then
    rm -f "${home}/bun.lock" 2>/dev/null || true
    rm -rf "${home}/node_modules" 2>/dev/null || true
  fi
}

uninstall_kimi() {
  uninstall_from_manifest "${AGENT_PATHS[kimi]:-${XDG_CFG}/agents}"
}

uninstall_kimi_code() {
  local home="${XDG_CFG}/kimi-code"
  local plugin_dir="${home}/plugins/xpowers"

  if command -v kimi &>/dev/null; then
    if [[ "$DRY_RUN" == true ]]; then
      info "Would run: kimi plugin uninstall xpowers"
    else
      kimi plugin uninstall xpowers 2>/dev/null || true
    fi
  fi

  # Remove manually-copied plugin files tracked by manifest (if any)
  if [[ -f "${home}/.xpowers-manifest" ]]; then
    uninstall_from_manifest "$home"
  elif [[ -d "$plugin_dir" ]]; then
    if [[ "$DRY_RUN" == true ]]; then
      echo "  Would remove: ${plugin_dir}/"
    else
      rm -rf "$plugin_dir"
    fi
  fi

  # Remove XPowers hooks block from config.toml
  local config_file="${home}/config.toml"
  if [[ -f "$config_file" ]]; then
    if [[ "$DRY_RUN" == true ]]; then
      echo "  Would remove XPowers hooks block from: ${config_file}"
    else
      local tmp; tmp="$(mktemp)"
      awk '
        /# BEGIN XPOWERS KIMI-CODE HOOKS/ { in_block = 1; next }
        /# END XPOWERS KIMI-CODE HOOKS/   { in_block = 0; next }
        !in_block { print }
      ' "$config_file" > "$tmp"
      mv "$tmp" "$config_file"
    fi
  fi

  # Remove version marker if manifest removal missed it
  if [[ "$DRY_RUN" != true ]]; then
    rm -f "${home}/.xpowers-version"
  fi
}

uninstall_codex() {
  local home
  if [[ "$CODEX_SCOPE" == "local" ]]; then
    home=".codex"
  else
    home="${AGENT_PATHS[codex]:-${HOME}/.codex}"
  fi
  uninstall_from_manifest "$home"
}

uninstall_gemini() {
  if command -v gemini &>/dev/null; then
    if [[ "$DRY_RUN" == true ]]; then
      info "Would run: gemini extensions uninstall xpowers"
    else
      gemini extensions uninstall xpowers 2>/dev/null || true
    fi
  fi
}

uninstall_pi() {
  local home="${AGENT_PATHS[pi]:-${HOME}/.pi/agent}"
  local ext_dir="${home}/extensions/xpowers"

  # Remove extension directory (includes skills, commands, node_modules, dist)
  if [[ -d "$ext_dir" ]]; then
    if [[ "$DRY_RUN" == true ]]; then
      echo "  Would remove: ${ext_dir}/"
    else
      rm -rf "$ext_dir"
    fi
  fi

  # Remove XPowers section from AGENTS.md (preserve user content)
  local agents_md="${home}/AGENTS.md"
  if [[ -f "$agents_md" ]]; then
    local has_xpowers_section=false
    grep -q "BEGIN XPOWERS PI" "$agents_md" && has_xpowers_section=true
    grep -q "BEGIN HYPERPOWERS PI" "$agents_md" && has_xpowers_section=true
    if [[ "$has_xpowers_section" == true ]]; then
      if [[ "$DRY_RUN" == true ]]; then
        echo "  Would clean XPowers section from: ${agents_md}"
      else
        local tmp_md="${agents_md}.tmp"
        sed \
          -e '/<!-- BEGIN XPOWERS PI -->/,/<!-- END XPOWERS PI -->/d' \
          -e '/<!-- BEGIN HYPERPOWERS PI -->/,/<!-- END HYPERPOWERS PI -->/d' \
          "$agents_md" > "$tmp_md"
        # If file is now empty or only whitespace, remove it; otherwise replace
        if [[ ! -s "$tmp_md" ]] || ! grep -q '[^[:space:]]' "$tmp_md"; then
          rm -f "$agents_md" "$tmp_md"
        else
          mv "$tmp_md" "$agents_md"
        fi
      fi
    fi
  fi

  # Remove version and manifest markers
  for marker in .xpowers-version .xpowers-manifest; do
    if [[ -f "${home}/${marker}" ]]; then
      if [[ "$DRY_RUN" == true ]]; then
        echo "  Would remove: ${home}/${marker}"
      else
        rm -f "${home}/${marker}"
      fi
    fi
  done
}

# ---------------------------------------------------------------------------
# Status functions
# ---------------------------------------------------------------------------

status_claude() {
  local vf="${HOME}/.claude/.xpowers-version"
  if [[ -f "$vf" ]]; then
    local iv; iv=$(cat "$vf")
    local sk; sk=$(count_items "${HOME}/.claude/skills/*/")
    local ag; ag=$(count_items "${HOME}/.claude/agents/*.md")
    local cm; cm=$(count_items "${HOME}/.claude/commands/*.md")
    local hk; hk=$(count_items "${HOME}/.claude/hooks/*/")
    echo -e "  ${GREEN}✓${RESET} Claude Code    ${BOLD}v${iv}${RESET}  (${sk} skills, ${ag} agents, ${cm} commands, ${hk} hook dirs)"
  else
    echo -e "  ${DIM}✗ Claude Code    not installed${RESET}"
  fi
}

status_opencode() {
  local vf="${XDG_CFG}/opencode/.xpowers-version"
  if [[ -f "$vf" ]]; then
    local iv; iv=$(cat "$vf")
    local sk; sk=$(count_items "${XDG_CFG}/opencode/skills/*/")
    local ag; ag=$(count_items "${XDG_CFG}/opencode/agents/*.md")
    echo -e "  ${GREEN}✓${RESET} OpenCode       ${BOLD}v${iv}${RESET}  (${sk} skills, ${ag} agents)"
  else
    echo -e "  ${DIM}✗ OpenCode       not installed${RESET}"
  fi
}

status_kimi() {
  local home="${AGENT_PATHS[kimi]:-${XDG_CFG}/agents}"
  local vf="${home}/.xpowers-version"
  if [[ -f "$vf" ]]; then
    local iv; iv=$(cat "$vf")
    local sk; sk=$(count_items "${home}/skills/*/")
    echo -e "  ${GREEN}✓${RESET} Kimi CLI       ${BOLD}v${iv}${RESET}  (${sk} skills)"
  else
    echo -e "  ${DIM}✗ Kimi CLI       not installed${RESET}"
  fi
}

status_kimi_code() {
  local home="${XDG_CFG}/kimi-code"
  local vf="${home}/.xpowers-version"
  if [[ -f "$vf" ]]; then
    local iv; iv=$(cat "$vf")
    local sk; sk=$(count_items "${home}/skills/*/")
    echo -e "  ${GREEN}✓${RESET} Kimi Code CLI  ${BOLD}v${iv}${RESET}  (${sk} skills)"
  else
    echo -e "  ${DIM}✗ Kimi Code CLI  not installed${RESET}"
  fi
}

status_codex() {
  local home="${AGENT_PATHS[codex]:-${HOME}/.codex}"
  local vf="${home}/.xpowers-version"
  if [[ -f "$vf" ]]; then
    local iv; iv=$(cat "$vf")
    local sk; sk=$(count_items "${home}/skills/codex-*/")
    echo -e "  ${GREEN}✓${RESET} Codex CLI      ${BOLD}v${iv}${RESET}  (${sk} skills)"
  else
    echo -e "  ${DIM}✗ Codex CLI      not installed${RESET}"
  fi
}

status_gemini() {
  if command -v gemini &>/dev/null && gemini extensions list 2>/dev/null | grep -q xpowers; then
    echo -e "  ${GREEN}✓${RESET} Gemini CLI     ${BOLD}installed${RESET}"
  else
    echo -e "  ${DIM}✗ Gemini CLI     not installed${RESET}"
  fi
}

status_pi() {
  local home="${AGENT_PATHS[pi]:-${HOME}/.pi/agent}"
  local vf="${home}/.xpowers-version"
  if [[ -f "$vf" ]]; then
    local iv; iv=$(cat "$vf")
    echo -e "  ${GREEN}✓${RESET} Pi Agent       ${BOLD}v${iv}${RESET}"
  else
    echo -e "  ${DIM}✗ Pi Agent       not installed${RESET}"
  fi
}

# ---------------------------------------------------------------------------
# tm CLI tool installation
# ---------------------------------------------------------------------------

TM_BIN_DIR="${HOME}/.local/bin"
TM_LIB_DIR="${HOME}/.local/lib/tm"

install_tm_cli() {
  if [[ "$DRY_RUN" == true ]]; then
    info "Would install tm CLI to ${TM_BIN_DIR}/tm"
    return 0
  fi

  ensure_dir "$TM_BIN_DIR"
  ensure_dir "$TM_LIB_DIR"

  # Copy tm script and supporting files
  cp "${REPO_ROOT}/scripts/tm" "${TM_BIN_DIR}/tm"
  chmod +x "${TM_BIN_DIR}/tm"

  cp "${REPO_ROOT}/scripts/tm-backends.sh" "${TM_LIB_DIR}/tm-backends.sh"
  cp "${REPO_ROOT}/scripts/tm-linear-backend.js" "${TM_LIB_DIR}/tm-linear-backend.js"
  cp "${REPO_ROOT}/scripts/tm-linear-sync.js" "${TM_LIB_DIR}/tm-linear-sync.js"
  cp "${REPO_ROOT}/scripts/tm-linear-sync-config.js" "${TM_LIB_DIR}/tm-linear-sync-config.js"

  # Create symlinks so tm can find its companion scripts
  ln -sfn "${TM_LIB_DIR}/tm-backends.sh" "${TM_BIN_DIR}/tm-backends.sh"
  ln -sfn "${TM_LIB_DIR}/tm-linear-backend.js" "${TM_BIN_DIR}/tm-linear-backend.js"
  ln -sfn "${TM_LIB_DIR}/tm-linear-sync.js" "${TM_BIN_DIR}/tm-linear-sync.js"
  ln -sfn "${TM_LIB_DIR}/tm-linear-sync-config.js" "${TM_BIN_DIR}/tm-linear-sync-config.js"

  # Install @linear/sdk if node/npm available and package.json exists
  if command -v npm &>/dev/null && [[ -f "${REPO_ROOT}/package.json" ]]; then
    # Always copy and install so upgrades pick up new dependency versions
    cp "${REPO_ROOT}/package.json" "${TM_LIB_DIR}/package.json"
    (cd "$TM_LIB_DIR" && npm install --silent --omit=dev 2>/dev/null) \
      || warn "npm install for @linear/sdk failed — Linear sync will be unavailable"
    # Symlink node_modules so the sync script can find @linear/sdk
    # If a real directory already exists here, move it aside instead of deleting it.
    if [[ -d "${TM_BIN_DIR}/node_modules" ]] && [[ ! -L "${TM_BIN_DIR}/node_modules" ]]; then
      local backup_path="${TM_BIN_DIR}/node_modules.xpowers-backup"
      if [[ -e "$backup_path" ]]; then
        backup_path="${backup_path}-$(date +%s)"
      fi
      mv "${TM_BIN_DIR}/node_modules" "$backup_path"
      warn "Moved existing ${TM_BIN_DIR}/node_modules to ${backup_path} before installing tm runtime symlink"
    fi
    ln -sfn "${TM_LIB_DIR}/node_modules" "${TM_BIN_DIR}/node_modules"
  fi

  # Check if ~/.local/bin is in PATH
  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$TM_BIN_DIR"; then
    warn "${TM_BIN_DIR} is not in your PATH. Add this to your shell profile:"
    warn "  export PATH=\"${TM_BIN_DIR}:\$PATH\""
  else
    success "tm CLI installed to ${TM_BIN_DIR}/tm"
  fi
}

uninstall_tm_cli() {
  if [[ "$DRY_RUN" == true ]]; then
    info "Would remove tm CLI from ${TM_BIN_DIR}/tm"
    return 0
  fi

  rm -f "${TM_BIN_DIR}/tm"
  rm -f "${TM_BIN_DIR}/tm-backends.sh"
  rm -f "${TM_BIN_DIR}/tm-linear-backend.js"
  rm -f "${TM_BIN_DIR}/tm-linear-sync.js"
  rm -f "${TM_BIN_DIR}/tm-linear-sync-config.js"

  local managed_node_modules_target="${TM_LIB_DIR}/node_modules"
  if [[ -L "${TM_BIN_DIR}/node_modules" ]]; then
    local linked_target
    linked_target="$(readlink "${TM_BIN_DIR}/node_modules")"
    if [[ "$linked_target" == "$managed_node_modules_target" ]]; then
      rm -f "${TM_BIN_DIR}/node_modules"
    fi
  fi

  rm -rf "${TM_LIB_DIR}"

  info "tm CLI removed from ${TM_BIN_DIR}"
}

# ---------------------------------------------------------------------------
# Third-party tool bundle
# ---------------------------------------------------------------------------

THIRD_PARTY_SKIP_ENV="XPOWERS_SKIP_THIRD_PARTY_FEATURES"
BEADS_RUST_INSTALL_REF="${XPOWERS_BEADS_RUST_INSTALL_REF:-f4687e51a5aa155fe27cb8ea6d7fdae942b0154f}"
BEADS_VIEWER_INSTALL_REF="${XPOWERS_BEADS_VIEWER_INSTALL_REF:-bb977f5b812b2987d77544872287b502b5b3a444}"

third_party_state_file() {
  printf "%s\n" "${HOME}/.xpowers/third-party-tools"
}

beads_rust_install_url() {
  printf "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/%s/install.sh" "$BEADS_RUST_INSTALL_REF"
}

beads_viewer_install_url() {
  printf "https://raw.githubusercontent.com/Dicklesworthstone/beads_viewer/%s/install.sh" "$BEADS_VIEWER_INSTALL_REF"
}

third_party_manifest_file() {
  printf "%s\n" "${HOME}/.xpowers/manifest.json"
}

third_party_manifest_has_installed() {
  local tool="$1"
  local manifest_file
  manifest_file="$(third_party_manifest_file)"
  [[ -f "$manifest_file" ]] || return 1

  if command -v node >/dev/null 2>&1; then
    node -e 'var fs = require("fs"); var manifestPath = process.argv[1]; var tool = process.argv[2]; var manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); var features = manifest.features || {}; process.exit(features[tool] && features[tool].installed === true ? 0 : 1)' "$manifest_file" "$tool" >/dev/null 2>&1 && return 0
  fi
  if command -v bun >/dev/null 2>&1; then
    bun -e 'var fs = require("fs"); var manifestPath = process.argv[1]; var tool = process.argv[2]; var manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); var features = manifest.features || {}; process.exit(features[tool] && features[tool].installed === true ? 0 : 1)' "$manifest_file" "$tool" >/dev/null 2>&1 && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json, sys; data = json.load(open(sys.argv[1])); sys.exit(0 if data.get("features", {}).get(sys.argv[2], {}).get("installed") is True else 1)' "$manifest_file" "$tool" >/dev/null 2>&1 && return 0
  fi
  if command -v awk >/dev/null 2>&1; then
    awk -v tool="$tool" '
      index($0, "\"" tool "\"") && $0 ~ /:[[:space:]]*[{]/ { in_tool = 1 }
      in_tool && $0 ~ /"installed"[[:space:]]*:[[:space:]]*true/ { found = 1 }
      in_tool && $0 ~ /^[[:space:]]*[}][,]?[[:space:]]*$/ { exit }
      END { exit(found ? 0 : 1) }
    ' "$manifest_file" && return 0
  fi
  return 1
}

third_party_clear_manifest_features() {
  local manifest_file
  manifest_file="$(third_party_manifest_file)"
  [[ -f "$manifest_file" ]] || return 0

  if command -v node >/dev/null 2>&1; then
    node -e 'var fs = require("fs"); var manifestPath = process.argv[1]; var manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); var features = manifest.features || {}; ["br", "bv", "graphify", "claude-mem"].forEach(function (tool) { if (features[tool]) features[tool].installed = false }); fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")' "$manifest_file" >/dev/null 2>&1 && return 0
  fi
  if command -v bun >/dev/null 2>&1; then
    bun -e 'var fs = require("fs"); var manifestPath = process.argv[1]; var manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); var features = manifest.features || {}; ["br", "bv", "graphify", "claude-mem"].forEach(function (tool) { if (features[tool]) features[tool].installed = false }); fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")' "$manifest_file" >/dev/null 2>&1 && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json, sys; path = sys.argv[1]; data = json.load(open(path)); [data.get("features", {}).get(tool, {}).update({"installed": False}) for tool in ("br", "bv", "graphify", "claude-mem") if tool in data.get("features", {})]; open(path, "w").write(json.dumps(data, indent=2) + "\n")' "$manifest_file" >/dev/null 2>&1 && return 0
  fi
  return 1
}

third_party_mark_installed() {
  local tool="$1"
  local state_file
  state_file="$(third_party_state_file)"
  mkdir -p "$(dirname "$state_file")"
  if [[ ! -f "$state_file" ]] || ! grep -qxF "$tool" "$state_file"; then
    printf "%s\n" "$tool" >> "$state_file"
  fi
}

third_party_was_installed() {
  local tool="$1"
  local state_file
  state_file="$(third_party_state_file)"
  if [[ -f "$state_file" ]] && grep -qxF "$tool" "$state_file"; then
    return 0
  fi
  third_party_manifest_has_installed "$tool"
}

third_party_has_tracked_install() {
  local tool
  for tool in br bv graphify claude-mem; do
    if third_party_was_installed "$tool"; then
      return 0
    fi
  done
  return 1
}

selected_agents_cover_detected_agents() {
  local detected_count=0
  local detected_agent
  local selected_agent

  for detected_agent in "${AGENT_ORDER[@]}"; do
    [[ -n "${AGENT_PATHS[$detected_agent]:-}" ]] || continue
    detected_count=$((detected_count + 1))
    local selected=false
    for selected_agent in "${SELECTED_AGENTS[@]}"; do
      if [[ "$selected_agent" == "$detected_agent" ]]; then
        selected=true
        break
      fi
    done
    [[ "$selected" == true ]] || return 1
  done

  if [[ $detected_count -eq 0 ]]; then
    [[ ${#SELECTED_AGENTS[@]} -gt 0 ]]
  else
    return 0
  fi
}

pi_feature_succeeded_this_run() {
  local pi_output="$1"
  local tool="$2"
  local marker='"featureResults":{'
  local feature_results="${pi_output#*${marker}}"
  [[ "$feature_results" != "$pi_output" ]] || return 1
  feature_results="${feature_results%%\}*}"
  [[ "$feature_results" == *"\"${tool}\":true"* ]]
}

record_pi_host_independent_third_party_state() {
  local pi_output="$1"
  local all_succeeded=true
  if pi_feature_succeeded_this_run "$pi_output" "br"; then
    third_party_mark_installed "br"
  else
    all_succeeded=false
  fi
  if pi_feature_succeeded_this_run "$pi_output" "bv"; then
    third_party_mark_installed "bv"
  else
    all_succeeded=false
  fi
  if pi_feature_succeeded_this_run "$pi_output" "graphify"; then
    third_party_mark_installed "graphify"
  else
    all_succeeded=false
  fi
  [[ "$all_succeeded" == true ]]
}

third_party_features_skipped() {
  local value="${XPOWERS_SKIP_THIRD_PARTY_FEATURES:-}"
  case "${value,,}" in
    1|true|yes) return 0 ;;
    *) return 1 ;;
  esac
}

join_labels() {
  local joined=""
  local item
  for item in "$@"; do
    [[ -n "$joined" ]] && joined+=", "
    joined+="$item"
  done
  printf "%s" "$joined"
}

install_graphify_for_agents() {
  local skip_delegated_pi="$1"
  shift

  local -a targets=()
  local skipped_delegated_pi=false
  local agent
  for agent in "$@"; do
    if [[ "$skip_delegated_pi" == true && "$agent" == "pi" ]]; then
      skipped_delegated_pi=true
      continue
    fi
    case "$agent" in
      claude|codex|opencode|gemini|pi) targets+=("$agent") ;;
    esac
  done

  if [[ ${#targets[@]} -eq 0 ]]; then
    if [[ "$skipped_delegated_pi" == true ]]; then
      info "Skipping Pi graphify; Pi delegation already handled it"
    else
      warn "graphify skipped — Claude Code, Codex, OpenCode, Gemini CLI, or Pi Agent not selected"
    fi
    return 0
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 not found — skipping graphify"
    return 0
  fi

  if ! python3 -m pip install --user graphifyy --quiet >/dev/null 2>&1; then
    warn "graphify package install failed — try: python3 -m pip install --user graphifyy"
    return 0
  fi

  local -a installed_graphify=()
  for agent in "${targets[@]}"; do
    local label=""
    local try_command=""
    local -a graphify_args=()
    case "$agent" in
      claude)
        label="Claude Code"
        try_command="graphify install"
        graphify_args=(install)
        ;;
      codex)
        label="Codex"
        try_command="graphify install --platform codex"
        graphify_args=(install --platform codex)
        ;;
      opencode)
        label="OpenCode"
        try_command="graphify install --platform opencode"
        graphify_args=(install --platform opencode)
        ;;
      gemini)
        label="Gemini CLI"
        try_command="graphify install --platform gemini"
        graphify_args=(install --platform gemini)
        ;;
      pi)
        label="Pi Agent"
        try_command="graphify install --platform pi"
        graphify_args=(install --platform pi)
        ;;
    esac

    if PATH="${HOME}/.local/bin:${PATH}" graphify "${graphify_args[@]}" >/dev/null 2>&1; then
      installed_graphify+=("$label")
    else
      warn "graphify install failed for ${label} — try: ${try_command}"
    fi
  done

  if [[ ${#installed_graphify[@]} -gt 0 ]]; then
    success "graphify installed for $(join_labels "${installed_graphify[@]}")"
    third_party_mark_installed "graphify"
  fi
}

install_third_party_tools() {
  local skip_host_independent=false
  if [[ "${1:-}" == "--skip-host-independent" ]]; then
    skip_host_independent=true
    shift
  fi

  if [[ "$DRY_RUN" == true ]]; then
    if [[ "$skip_host_independent" == true ]]; then
      info "Would install third-party tool bundle: graphify for non-Pi supported hosts, claude-mem"
    else
      info "Would install third-party tool bundle: br, bv, graphify, claude-mem"
    fi
    return 0
  fi

  if third_party_features_skipped; then
    info "Skipping third-party tool bundle (${THIRD_PARTY_SKIP_ENV}=1)"
    return 0
  fi

  if [[ "$skip_host_independent" == true ]]; then
    info "Installing third-party tool bundle: graphify, claude-mem"
    info "Skipping br, bv, and delegated Pi graphify; Pi delegation already handled them"
  else
    info "Installing third-party tool bundle: br, bv, graphify, claude-mem"
  fi
  warn "Third-party tool bundle runs upstream installers/packages. Set ${THIRD_PARTY_SKIP_ENV}=1 to skip."

  if [[ "$skip_host_independent" != true ]]; then
    if command -v curl >/dev/null 2>&1; then
      local br_install_url
      br_install_url="$(beads_rust_install_url)"
      if curl -fsSL "$br_install_url" | bash -s -- --skip-skills --quiet --no-gum >/dev/null 2>&1; then
        success "br installed"
        third_party_mark_installed "br"
      else
        warn "br install failed — try: curl -fsSL ${br_install_url} | bash -s -- --skip-skills"
      fi

      local bv_install_url
      bv_install_url="$(beads_viewer_install_url)"
      if curl -fsSL "$bv_install_url" | bash >/dev/null 2>&1; then
        success "bv installed"
        third_party_mark_installed "bv"
      else
        warn "bv install failed — try: curl -fsSL ${bv_install_url} | bash"
      fi
    else
      warn "curl not found — skipping br and bv installers"
    fi
  fi

  install_graphify_for_agents "$skip_host_independent" "$@"

  if ! command -v npx >/dev/null 2>&1; then
    warn "npx not found — skipping claude-mem"
    return 0
  fi

  local installed_cmem=()
  local agent
  for agent in "$@"; do
    case "$agent" in
      claude)
        if npx --yes claude-mem install >/dev/null 2>&1; then
          installed_cmem+=("Claude Code")
          third_party_mark_installed "claude-mem"
        else
          warn "claude-mem install failed for Claude Code — try: npx --yes claude-mem install"
        fi
        ;;
      opencode)
        if npx --yes claude-mem install --ide opencode >/dev/null 2>&1; then
          installed_cmem+=("OpenCode")
          third_party_mark_installed "claude-mem"
        else
          warn "claude-mem install failed for OpenCode — try: npx --yes claude-mem install --ide opencode"
        fi
        ;;
      gemini)
        if npx --yes claude-mem install --ide gemini-cli >/dev/null 2>&1; then
          installed_cmem+=("Gemini CLI")
          third_party_mark_installed "claude-mem"
        else
          warn "claude-mem install failed for Gemini CLI — try: npx --yes claude-mem install --ide gemini-cli"
        fi
        ;;
    esac
  done

  if [[ ${#installed_cmem[@]} -gt 0 ]]; then
    success "claude-mem installed for $(join_labels "${installed_cmem[@]}")"
  fi
}

uninstall_third_party_tools() {
  local state_file
  state_file="$(third_party_state_file)"
  third_party_has_tracked_install || return 0

  if [[ "$DRY_RUN" == true ]]; then
    info "Would remove tracked third-party tool bundle"
    if third_party_was_installed "br"; then
      echo "  Would remove: ${HOME}/.local/bin/br"
      echo "  Would remove: ${HOME}/.local/bin/br.exe"
    fi
    if third_party_was_installed "bv"; then
      echo "  Would remove: ${HOME}/.local/bin/bv"
      echo "  Would remove: ${HOME}/.local/bin/bv.exe"
    fi
    if third_party_was_installed "graphify"; then
      echo "  Would run: python3 -m pip uninstall -y graphifyy"
    fi
    if third_party_was_installed "claude-mem"; then
      echo "  Would run: npx --yes claude-mem uninstall --all"
    fi
    return 0
  fi

  info "Removing tracked third-party tool bundle"
  local failed=false

  if third_party_was_installed "br"; then
    rm -f "${HOME}/.local/bin/br" "${HOME}/.local/bin/br.exe"
    success "br removed"
  fi

  if third_party_was_installed "bv"; then
    rm -f "${HOME}/.local/bin/bv" "${HOME}/.local/bin/bv.exe"
    success "bv removed"
  fi

  if third_party_was_installed "graphify"; then
    if command -v python3 >/dev/null 2>&1; then
      if python3 -m pip uninstall -y graphifyy >/dev/null 2>&1; then
        success "graphify removed"
      else
        warn "graphify uninstall failed — try: python3 -m pip uninstall -y graphifyy"
        failed=true
      fi
    else
      warn "python3 not found — skipping graphify uninstall"
      failed=true
    fi
  fi

  if third_party_was_installed "claude-mem"; then
    if command -v npx >/dev/null 2>&1; then
      if npx --yes claude-mem uninstall --all >/dev/null 2>&1; then
        success "claude-mem removed"
      else
        warn "claude-mem uninstall failed — try: npx --yes claude-mem uninstall --all"
        failed=true
      fi
    else
      warn "npx not found — skipping claude-mem uninstall"
      failed=true
    fi
  fi

  if [[ "$failed" == true ]]; then
    warn "Keeping third-party tracking for retry: ${state_file} / $(third_party_manifest_file)"
  else
    if ! third_party_clear_manifest_features; then
      warn "Could not update third-party entries in $(third_party_manifest_file)"
    fi
    rm -f "$state_file"
    rmdir "$(dirname "$state_file")" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# CLI usage
# ---------------------------------------------------------------------------

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Unified installer for XPowers across all AI coding agents.

AGENTS:
    --claude            Install to Claude Code (~/.claude)
    --opencode          Install to OpenCode (~/.config/opencode)
    --kimi-code         Install to Kimi Code CLI (~/.config/kimi-code)
    --kimi              Install to Kimi CLI (legacy, ~/.config/agents)
    --codex             Install to Codex CLI (~/.codex)
    --gemini            Install to Gemini CLI (native extension)
    --hosts <list>      Comma-separated agents: claude,opencode,kimi-code,kimi,codex,gemini,pi,all
    --all               Install to all detected agents

MODES:
    --uninstall         Remove xpowers from selected agents
    --status            Show installation status for all agents
    --symlink           Use symlinks instead of copies (dev mode)
    --local             Install Codex skills to project (not global)
    --dry-run           Show what would be installed/removed without doing it
    --purge             With --uninstall: also remove backups and metadata
    --force, --yes      Skip confirmation prompt
    --allow-conflicts   Advanced: continue despite detected hyperpowers/myhyperpowers/superpowers installs
    --remove-legacy     Detect and remove legacy installs (hyperpowers, myhyperpowers, superpowers)
    --replace-legacy    Remove legacy installs, then proceed with XPowers install

FEATURES:
    --yes installs third-party tools: br, bv, graphify, claude-mem
    Set XPOWERS_SKIP_THIRD_PARTY_FEATURES=1 to skip external tool installers

GENERAL:
    -h, --help          Show this help
    -v, --version       Show version

EXAMPLES:
    $(basename "$0")                    # Interactive: detect + confirm
    $(basename "$0") --all              # Install to all detected agents
    $(basename "$0") --claude --kimi-code  # Install to specific agents
    $(basename "$0") --kimi           # Install to legacy Kimi CLI
    $(basename "$0") --status           # Show what's installed
    $(basename "$0") --uninstall --all  # Remove from all agents
    $(basename "$0") --uninstall --claude --dry-run  # Preview removal
    $(basename "$0") --uninstall --all --purge --yes # Complete removal
    $(basename "$0") --remove-legacy --yes            # Remove legacy installs only
    $(basename "$0") --replace-legacy --all --yes     # Replace legacy with XPowers

VERSION: $VERSION
EOF
}

# ---------------------------------------------------------------------------
# Main orchestration
# ---------------------------------------------------------------------------

# Module-level defaults for options shared with install/uninstall functions
USE_SYMLINKS=false
CODEX_SCOPE="global"
DRY_RUN=false
PURGE=false

main() {
  local MODE="install"
  local FORCE=false
  local INTERACTIVE=true
  local ALLOW_CONFLICTS=false
  local REMOVE_LEGACY=false
  local REPLACE_LEGACY=false
  local SELECT_ALL=false
  local -a SELECTED_AGENTS=()
  local -a ORIGINAL_ARGS=("$@")

  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)    usage; exit 0 ;;
      -v|--version) echo "xpowers $VERSION"; exit 0 ;;
      --claude)     SELECTED_AGENTS+=(claude);    INTERACTIVE=false; shift ;;
      --opencode)   SELECTED_AGENTS+=(opencode);  INTERACTIVE=false; shift ;;
      --kimi-code)  SELECTED_AGENTS+=(kimi_code); INTERACTIVE=false; shift ;;
      --kimi)       SELECTED_AGENTS+=(kimi);      INTERACTIVE=false; shift ;;
      --codex)      SELECTED_AGENTS+=(codex);     INTERACTIVE=false; shift ;;
      --gemini)     SELECTED_AGENTS+=(gemini);    INTERACTIVE=false; shift ;;
      --hosts)
        shift
        if [[ $# -eq 0 ]]; then
          error "--hosts requires a comma-separated list"
          usage >&2
          exit 1
        fi
        IFS=',' read -ra HOST_LIST <<< "$1"
        for h in "${HOST_LIST[@]}"; do
          case "$h" in
            claude)    SELECTED_AGENTS+=(claude);    INTERACTIVE=false ;;
            opencode)  SELECTED_AGENTS+=(opencode);  INTERACTIVE=false ;;
            kimi-code) SELECTED_AGENTS+=(kimi_code); INTERACTIVE=false ;;
            kimi)      SELECTED_AGENTS+=(kimi);      INTERACTIVE=false ;;
            codex)     SELECTED_AGENTS+=(codex);     INTERACTIVE=false ;;
            gemini)    SELECTED_AGENTS+=(gemini);    INTERACTIVE=false ;;
            pi)        SELECTED_AGENTS+=(pi);        INTERACTIVE=false ;;
            all)       SELECT_ALL=true; INTERACTIVE=false ;;
            *)         error "Unknown host: $h"; usage >&2; exit 1 ;;
          esac
        done
        shift
        ;;
      --all)        SELECT_ALL=true; INTERACTIVE=false; shift ;;  # handled after detection
      --uninstall)  MODE="uninstall"; shift ;;
      --status)     MODE="status"; shift ;;
      --symlink)    USE_SYMLINKS=true; shift ;;
      --local)      CODEX_SCOPE="local"; shift ;;
      --dry-run)    DRY_RUN=true; shift ;;
      --purge)      PURGE=true; shift ;;
      --force|--yes) FORCE=true; shift ;;
      --allow-conflicts) ALLOW_CONFLICTS=true; shift ;;
      --remove-legacy) REMOVE_LEGACY=true; shift ;;
      --replace-legacy) REPLACE_LEGACY=true; shift ;;
      *)            error "Unknown option: $1"; echo; usage >&2; exit 1 ;;
    esac
  done

  # No tty → force non-interactive
  if ! [[ -t 0 ]]; then
    INTERACTIVE=false
    if [[ ${#SELECTED_AGENTS[@]} -eq 0 ]] && [[ "$MODE" == "install" ]]; then
      # Check if --all was passed (SELECTED_AGENTS empty + non-interactive + not --all)
      # --all sets INTERACTIVE=false but leaves SELECTED_AGENTS empty
      # We differentiate by checking if any agent flag was given
      :  # handled below after detection
    fi
  fi

  # Conflict detection runs for all install paths, including Pi delegation
  if [[ "$MODE" == "install" && "$ALLOW_CONFLICTS" != true && "$REMOVE_LEGACY" != true && "$REPLACE_LEGACY" != true ]]; then
    local conflicts=""
    if conflicts="$(detect_conflicts)"; then
      if [[ -n "$conflicts" ]]; then
        if [[ "$INTERACTIVE" == true && "$FORCE" != true ]]; then
          header
          print_conflict_warning "$conflicts"
          local conflict_answer=""
          read -r -p "  Continue installing XPowers despite these conflicting installs? [y/N] " conflict_answer </dev/tty
          case "${conflict_answer:-N}" in
            [Yy]) ;;
            *) info "Cancelled. Remove the conflicting installs and rerun the installer."; exit 1 ;;
          esac
          echo
        else
          print_conflict_warning "$conflicts"
          exit 1
        fi
      fi
    fi
  fi

  # --- Legacy removal (before any installation) ---
  if [[ "$MODE" != "install" ]] && { [[ "$REMOVE_LEGACY" == true ]] || [[ "$REPLACE_LEGACY" == true ]]; }; then
    error "--remove-legacy and --replace-legacy can only be used with install mode"
    exit 1
  fi
  if [[ "$REMOVE_LEGACY" == true ]] || [[ "$REPLACE_LEGACY" == true ]]; then
    if [[ "$PURGE" == true ]]; then
      error "--purge cannot be used with --remove-legacy or --replace-legacy"
      exit 1
    fi
    if ! [[ -t 0 ]] && [[ "$FORCE" != true ]] && [[ "$DRY_RUN" != true ]]; then
      error "No terminal detected. Use --yes to confirm legacy removal."
      exit 1
    fi
    remove_legacy
    if [[ "$REMOVE_LEGACY" == true ]]; then
      exit 0
    fi
    if [[ "$DRY_RUN" == true ]]; then
      info "Dry run: legacy removal preview complete. Exiting before install."
      exit 0
    fi
  fi

  # Detect agents
  detect_all

  # --- Status mode ---
  if [[ "$MODE" == "status" ]]; then
    header
    echo -e "  ${BOLD}Installation Status${RESET}"
    echo
    status_claude
    status_opencode
    status_kimi_code
    status_kimi
    status_codex
    status_gemini
    status_pi
    echo
    exit 0
  fi

  # --- Resolve selected agents ---
  if [[ ${#SELECTED_AGENTS[@]} -eq 0 ]] || [[ "$SELECT_ALL" == true ]]; then
    # --all or interactive: select all detected
    local -a resolved_agents=()
    for agent in "${AGENT_ORDER[@]}"; do
      if [[ -n "${AGENT_PATHS[$agent]:-}" ]]; then
        resolved_agents+=("$agent")
      fi
    done
    # Merge explicitly-selected agents (e.g. --hosts all,pi) without duplicates
    for agent in "${SELECTED_AGENTS[@]}"; do
      local already_in=false
      for r in "${resolved_agents[@]}"; do
        [[ "$r" == "$agent" ]] && already_in=true && break
      done
      [[ "$already_in" != true ]] && resolved_agents+=("$agent")
    done
    SELECTED_AGENTS=("${resolved_agents[@]}")
  fi

  # Deduplicate SELECTED_AGENTS to prevent double execution
  if [[ ${#SELECTED_AGENTS[@]} -gt 0 ]]; then
    local -a deduped=()
    for agent in "${SELECTED_AGENTS[@]}"; do
      local already=false
      for d in "${deduped[@]}"; do
        [[ "$d" == "$agent" ]] && already=true && break
      done
      [[ "$already" != true ]] && deduped+=("$agent")
    done
    SELECTED_AGENTS=("${deduped[@]}")
  fi

  local -a FAILED_AGENTS=()
  local -a SUCCESSFUL_AGENTS=()

  # Pi delegation: TypeScript installer handles Pi install only
  # (run AFTER resolution so --all auto-detected Pi is included)
  local has_pi=false
  local pi_delegated=false
  local pi_host_independent_features_succeeded=false
  for agent in "${SELECTED_AGENTS[@]}"; do
    [[ "$agent" == "pi" ]] && has_pi=true
  done

  if [[ "$has_pi" == true && "$MODE" == "install" ]]; then
    pi_delegated=true
    local pi_skip_reason=""
    if [[ "$DRY_RUN" == true ]]; then
      pi_skip_reason="--dry-run is not supported for Pi installation. Install Pi separately without --dry-run."
    elif ! command -v bun &>/dev/null; then
      pi_skip_reason="Pi installation requires Bun. Install Bun first: https://bun.sh"
    fi

    if [[ -n "$pi_skip_reason" ]]; then
      error "$pi_skip_reason"
      if [[ ${#SELECTED_AGENTS[@]} -eq 1 ]]; then
        exit 1
      fi
      FAILED_AGENTS+=("pi")
    else
      # Build filtered args for install.ts (only flags it understands)
      local -a PI_ARGS=("--hosts" "pi")
      if [[ "$FORCE" == true ]]; then
        PI_ARGS+=("--yes")
      else
        PI_ARGS+=("--features" "tm-cli")
      fi
      [[ "$ALLOW_CONFLICTS" == true ]] && PI_ARGS+=("--allow-conflicts")
      if [[ ${#SELECTED_AGENTS[@]} -eq 1 ]]; then
        if [[ "$FORCE" == true ]]; then
          # Pi is the only host in non-interactive mode — capture JSON so the
          # shell wrapper can keep third-party uninstall ownership in sync.
          local pi_output=""
          if pi_output="$(cd "${REPO_ROOT}" && bun scripts/install.ts "${PI_ARGS[@]}" --json)"; then
            SUCCESSFUL_AGENTS+=("pi")
            if record_pi_host_independent_third_party_state "$pi_output"; then
              pi_host_independent_features_succeeded=true
            fi
          else
            FAILED_AGENTS+=("pi")
          fi
        else
          # Pi is the only interactive host — exec for efficiency.
          cd "${REPO_ROOT}" && exec bun scripts/install.ts "${PI_ARGS[@]}"
        fi
      else
        # Pi is one of multiple — run without exec, capture exit code, then continue
        local pi_output=""
        if pi_output="$(cd "${REPO_ROOT}" && bun scripts/install.ts "${PI_ARGS[@]}" --json)"; then
          SUCCESSFUL_AGENTS+=("pi")
          if record_pi_host_independent_third_party_state "$pi_output"; then
            pi_host_independent_features_succeeded=true
          fi
        else
          FAILED_AGENTS+=("pi")
        fi
      fi
    fi
  fi

  # No agents at all?
  if [[ ${#SELECTED_AGENTS[@]} -eq 0 ]]; then
    header
    show_detection
    if [[ "$INTERACTIVE" == true ]]; then
      warn "No agents detected. Install an agent first, or specify one with --claude, --opencode, etc."
    else
      warn "No agents detected."
    fi
    exit 0
  fi

  # Build display list
  local agent_list=""
  for agent in "${SELECTED_AGENTS[@]}"; do
    [[ -n "$agent_list" ]] && agent_list+=", "
    agent_list+="${AGENT_LABELS[$agent]}"
  done

  # --- Uninstall safety: require --force/--yes in non-tty (dry-run exempt) ---
  if [[ "$MODE" == "uninstall" ]] && ! [[ -t 0 ]] && [[ "$FORCE" != true ]] && [[ "$DRY_RUN" != true ]]; then
    error "No terminal detected. Use --yes to confirm uninstall."
    exit 1
  fi

  # --- Purge requires uninstall ---
  if [[ "$PURGE" == true ]] && [[ "$MODE" != "uninstall" ]]; then
    error "--purge requires --uninstall"
    exit 1
  fi

  # --- Interactive confirmation ---
  if [[ "$INTERACTIVE" == true ]] && [[ "$FORCE" != true ]]; then
    header
    show_detection

    local action_verb="Install to"
    local default_answer="Y"
    local prompt_hint="Y/n"
    if [[ "$MODE" == "uninstall" ]]; then
      action_verb="Uninstall from"
      default_answer="N"
      prompt_hint="y/N"
    fi

    local attempts=0
    while true; do
      read -r -p "  ${action_verb}: ${agent_list}? [${prompt_hint}] " answer </dev/tty
      case "${answer:-$default_answer}" in
        [Yy]) break ;;
        [Nn]|"")
          if [[ "$MODE" == "uninstall" ]] && [[ -z "${answer:-}" ]]; then
            info "Cancelled."; exit 0
          elif [[ "${answer:-}" =~ ^[Nn]$ ]]; then
            info "Cancelled."; exit 0
          else
            break  # Empty answer with default Y for install
          fi
          ;;
        *)
          attempts=$((attempts + 1))
          if [[ $attempts -ge 3 ]]; then
            error "Too many invalid responses. Exiting."; exit 1
          fi
          warn "Please enter Y or N."
          ;;
      esac
    done
    echo
  elif [[ "$INTERACTIVE" == false ]] && [[ "$FORCE" != true ]]; then
    header
  fi

  # No tty check for install mode without explicit agents
  if ! [[ -t 0 ]] && [[ ${#SELECTED_AGENTS[@]} -eq 0 ]]; then
    error "No terminal detected. Use --all or specify agents (--claude, --opencode, etc.)"
    exit 1
  fi

  # --- Install tm CLI tool (shared across all agents) ---
  if [[ "$MODE" == "install" ]]; then
    install_tm_cli
  fi

  # --- Execute ---
  # FAILED_AGENTS declared earlier during Pi delegation

  for agent in "${SELECTED_AGENTS[@]}"; do
    # Pi install is handled by TypeScript delegation above (only if it was actually delegated)
    if [[ "$agent" == "pi" && "$MODE" == "install" && "$pi_delegated" == true ]]; then
      continue
    fi
    local label="${AGENT_LABELS[$agent]}"
    if [[ "$MODE" == "uninstall" ]]; then
      printf "  Uninstalling from ${BOLD}%-16s${RESET} " "$label..."
      if "uninstall_${agent}"; then
        echo -e "${GREEN}✓${RESET}"
      else
        echo -e "${RED}✗${RESET}"
        FAILED_AGENTS+=("$agent")
      fi
    elif [[ "$DRY_RUN" == true ]]; then
      echo -e "  ${DIM}Would install to ${BOLD}${label}${RESET}${DIM} (dry-run)${RESET}"
      SUCCESSFUL_AGENTS+=("$agent")
    else
      printf "  Installing to ${BOLD}%-16s${RESET} " "$label..."
      if "install_${agent}" 2>/dev/null; then
        SUCCESSFUL_AGENTS+=("$agent")
        if "validate_${agent}" 2>/dev/null; then
          echo -e "${GREEN}✓${RESET}"
        else
          echo -e "${YELLOW}⚠${RESET} (validation warning)"
        fi
      else
        echo -e "${RED}✗${RESET}"
        FAILED_AGENTS+=("$agent")
      fi
    fi
  done

  if [[ "$MODE" == "install" && "$FORCE" == true ]]; then
    if [[ ${#SUCCESSFUL_AGENTS[@]} -eq 0 ]]; then
      warn "Skipping third-party tool bundle because no selected agents installed successfully."
    elif [[ "$pi_host_independent_features_succeeded" == true ]]; then
      install_third_party_tools --skip-host-independent "${SUCCESSFUL_AGENTS[@]}"
    else
      install_third_party_tools "${SUCCESSFUL_AGENTS[@]}"
    fi
  fi

  echo

  # --- Summary ---
  local ok_count=$(( ${#SELECTED_AGENTS[@]} - ${#FAILED_AGENTS[@]} ))
  local action_past="Installed"
  [[ "$MODE" == "uninstall" ]] && action_past="Uninstalled"

  if [[ ${#FAILED_AGENTS[@]} -eq 0 ]]; then
    if [[ "$MODE" == "uninstall" ]]; then
      if selected_agents_cover_detected_agents; then
        uninstall_third_party_tools
        uninstall_tm_cli
      fi
    fi
    success "${action_past} to ${ok_count} agent(s): ${agent_list}"
  else
    local failed_list=""
    for f in "${FAILED_AGENTS[@]}"; do
      [[ -n "$failed_list" ]] && failed_list+=", "
      failed_list+="${AGENT_LABELS[$f]}"
    done
    warn "${action_past} to ${ok_count} agent(s). Failed: ${failed_list}"
    exit 1
  fi
}

main "$@"
