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

# Atomic write: write to temp file, fsync, then mv (prevents partial reads)
# Usage: atomic_write <target-path> <content>
atomic_write() {
  local target="$1" content="$2"
  local tmp
  tmp=$(mktemp "${target}.XXXXXX")
  printf '%s' "$content" > "$tmp"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
import os, sys
f = open(sys.argv[1], 'rb')
os.fsync(f.fileno())
f.close()
" "$tmp" 2>/dev/null || true
  fi
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

# --- Rate-limit window math ---

# Parse an ISO 8601 UTC timestamp to epoch seconds. Portable across GNU
# (`date -d`), macOS Homebrew (`gdate -d`), and BSD (`date -j -f`).
# Usage: parse_iso8601_to_epoch <iso_string>
# Returns: epoch seconds on stdout, exit 1 on parse failure.
parse_iso8601_to_epoch() {
  local iso="$1"
  local out
  if command -v gdate &>/dev/null; then
    if out=$(gdate -d "$iso" +%s 2>/dev/null); then
      printf '%s' "$out"; return 0
    fi
  fi
  if out=$(date -d "$iso" +%s 2>/dev/null); then
    printf '%s' "$out"; return 0
  fi
  if out=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%s 2>/dev/null); then
    printf '%s' "$out"; return 0
  fi
  return 1
}

# Compute the position (1-5) within Anthropic's 5-hour rate-limit window.
# Windows are session-anchored, not wall-clock-anchored — callers must pass
# `resets_at` from the API response (e.g. anthropic-ratelimit-unified-5h-reset).
# Formula: floor((now - (resets_at - 5h)) / 3600) + 1, clamped to [1,5].
# Usage: compute_window_hour <resets_at_epoch> <now_epoch>
compute_window_hour() {
  local resets_at="$1" now="$2"
  local window_start=$((resets_at - 18000))
  local elapsed=$((now - window_start))
  local hour=$((elapsed / 3600 + 1))
  if (( hour < 1 )); then hour=1; fi
  if (( hour > 5 )); then hour=5; fi
  printf '%s' "$hour"
}

# Compute the day (1-7) within Anthropic's 7-day rolling window.
# Usage: compute_window_day <resets_at_epoch> <now_epoch>
compute_window_day() {
  local resets_at="$1" now="$2"
  local window_start=$((resets_at - 604800))
  local elapsed=$((now - window_start))
  local day=$((elapsed / 86400 + 1))
  if (( day < 1 )); then day=1; fi
  if (( day > 7 )); then day=7; fi
  printf '%s' "$day"
}

# Hourly utilization threshold for a given window_hour. Linear 20/40/60/80
# with a hard cap at 90% in the final hour (the extra headroom protects
# against burst pricing).
# Usage: compute_hourly_threshold <window_hour>
compute_hourly_threshold() {
  local hour="$1"
  local t=$((hour * 20))
  if (( t > 90 )); then t=90; fi
  printf '%s' "$t"
}

# Daily utilization threshold for a given window_day. Non-linear curve
# [14, 29, 43, 57, 71, 86, 95] — day 7 is 95% (not 100%) so we never burn
# the very last reserve.
# Usage: compute_daily_threshold <window_day>
compute_daily_threshold() {
  local day="$1"
  local thresholds=(14 29 43 57 71 86 95)
  local idx=$((day - 1))
  if (( idx < 0 )); then idx=0; fi
  if (( idx > 6 )); then idx=6; fi
  printf '%s' "${thresholds[$idx]}"
}
