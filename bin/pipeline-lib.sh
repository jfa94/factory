#!/usr/bin/env bash
# Shared library sourced by all pipeline-* scripts. Not executable directly.
# Usage: source "$(dirname "$0")/pipeline-lib.sh"

set -euo pipefail

# --- Logging ---

_SCRIPT_NAME="${0##*/}"

log_info() { printf '[%s] [INFO] %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$_SCRIPT_NAME" "$*" >&2; }
log_warn() { printf '[%s] [WARN] %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$_SCRIPT_NAME" "$*" >&2; }
log_error() { printf '[%s] [ERROR] %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$_SCRIPT_NAME" "$*" >&2; }

# --- Config ---

# Read a value from the plugin config file.
# Usage: read_config <jq-key> [default]
read_config() {
  local key="$1" default="${2:-}"
  local config_file="${CLAUDE_PLUGIN_DATA}/config.json"
  if [[ ! -f "$config_file" ]]; then
    printf '%s' "$default"
    return
  fi
  local val
  val=$(jq -r "$key // empty" "$config_file" 2>/dev/null) || true
  printf '%s' "${val:-$default}"
}

# --- State shortcuts ---

# Read state (delegates to pipeline-state)
# Usage: read_state <run_id> [key]
read_state() { pipeline-state read "$@"; }

# Write state (delegates to pipeline-state)
# Usage: write_state <run_id> <key> <value>
write_state() { pipeline-state write "$@"; }

# --- Utilities ---

# Convert string to branch-safe slug: lowercase, hyphens, max 50 chars
slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9]/-/g' \
    | sed 's/--*/-/g' \
    | sed 's/^-//;s/-$//' \
    | head -c 50
}

# Create a temp file in plugin data dir
# Usage: temp_file [suffix]
temp_file() {
  local suffix="${1:-.tmp}"
  local tmp_dir="${CLAUDE_PLUGIN_DATA}/tmp"
  mkdir -p "$tmp_dir"
  mktemp "${tmp_dir}/pipeline-XXXXXX${suffix}"
}

# Assert a command exists, exit 1 if not
require_command() {
  local cmd="$1"
  if ! command -v "$cmd" &>/dev/null; then
    log_error "required command not found: $cmd"
    exit 1
  fi
}

# Build a JSON object from key-value pairs and write to stdout
# Usage: json_output key1 value1 key2 value2 ...
json_output() {
  local args=()
  while [[ $# -ge 2 ]]; do
    args+=("--arg" "$1" "$2")
    shift 2
  done
  jq -n "${args[@]}" '
    reduce ($ARGS.named | to_entries[]) as $e ({}; . + {($e.key): ($e.value)})
  '
}

# Detect package manager from lockfile in current directory (or given path)
# Usage: detect_pkg_manager [project-root]
detect_pkg_manager() {
  local root="${1:-.}"
  if [[ -f "$root/pnpm-lock.yaml" ]]; then
    printf 'pnpm'
  elif [[ -f "$root/bun.lockb" ]] || [[ -f "$root/bun.lock" ]]; then
    printf 'bun'
  elif [[ -f "$root/yarn.lock" ]]; then
    printf 'yarn'
  elif [[ -f "$root/package-lock.json" ]]; then
    printf 'npm'
  else
    printf 'pnpm'
  fi
}

# Atomic write: write to temp file then mv (prevents partial reads)
# Usage: atomic_write <target-path> <content>
atomic_write() {
  local target="$1" content="$2"
  local tmp
  tmp=$(mktemp "${target}.XXXXXX")
  printf '%s' "$content" > "$tmp"
  mv -f "$tmp" "$target"
}

# Get the current run directory (via 'current' symlink)
current_run_dir() {
  local current="${CLAUDE_PLUGIN_DATA}/runs/current"
  if [[ -L "$current" ]]; then
    readlink "$current"
  else
    return 1
  fi
}

# Get the current run ID from the symlink target
current_run_id() {
  local dir
  dir=$(current_run_dir) || return 1
  basename "$dir"
}
