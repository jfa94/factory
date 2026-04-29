#!/usr/bin/env bash
# Shared library sourced by all pipeline-* scripts. Not executable directly.
# Usage: source "$(dirname "$0")/pipeline-lib.sh"

set -euo pipefail

# --- Plugin data dir canonicalization ---
#
# Claude Code sets CLAUDE_PLUGIN_DATA per the active plugin context. When a
# factory script is invoked from a bash block inside another plugin's command
# or hook chain, the inherited CLAUDE_PLUGIN_DATA can point at the wrong
# plugin's data dir (e.g. codex-openai-codex/), which leaks factory state
# (merged-settings.json, runs/, state/) into foreign directories.
#
# Detect the marketplace-cache install layout (~/.claude/plugins/cache/
# <marketplace>/<plugin>/<version>/) and rewrite CLAUDE_PLUGIN_DATA to
# <plugin>-<marketplace> whenever it does not already match. Dev checkouts
# (plugin not under the cache root) are left untouched so local runs keep
# whatever CLAUDE_PLUGIN_DATA the session was launched with.
_factory_expected_data_dir() {
  local lib_dir plugin_root plugin_name marketplace_name cache_anchor
  lib_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd) || return 1
  plugin_root=$(cd "$lib_dir/.." 2>/dev/null && pwd) || return 1
  plugin_name=$(basename "$(dirname "$plugin_root")")
  marketplace_name=$(basename "$(dirname "$(dirname "$plugin_root")")")
  cache_anchor=$(cd "$plugin_root/../../.." 2>/dev/null && pwd) || return 1
  case "$cache_anchor" in
    "$HOME/.claude/plugins/cache") ;;
    *) return 1 ;;
  esac
  [[ -n "$plugin_name" && -n "$marketplace_name" ]] || return 1
  printf '%s' "$HOME/.claude/plugins/data/${plugin_name}-${marketplace_name}"
}

if _factory_expected=$(_factory_expected_data_dir 2>/dev/null); then
  if [[ "${CLAUDE_PLUGIN_DATA:-}" != "$_factory_expected" ]]; then
    export CLAUDE_PLUGIN_DATA="$_factory_expected"
  fi
fi
unset _factory_expected

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
  tmp=$(mktemp "${target}.XXXXXX") || return 1
  printf '%s' "$content" > "$tmp" || { rm -f "$tmp"; return 1; }
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY)
os.fsync(fd); os.close(fd)
" "$tmp" 2>/dev/null || true
  fi
  if ! mv -f "$tmp" "$target"; then
    rm -f "$tmp"
    log_error "atomic_write: mv failed for $target"
    return 1
  fi
  # fsync parent dir so the rename is durable.
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
import os, sys
d = os.open(os.path.dirname(sys.argv[1]) or '.', os.O_RDONLY)
os.fsync(d); os.close(d)
" "$target" 2>/dev/null || true
  fi
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

# --- Observability ---

# Append a structured JSONL metric line to the current run's metrics.jsonl.
# No-op when observability.auditLog is false or the current run dir is missing.
# Usage: log_metric <event> [key1=val1 key2=val2 ...]
# Values that parse as JSON (numbers, booleans, arrays) pass through verbatim;
# anything else is embedded as a JSON string.
log_metric() {
  local event="$1"; shift || true
  [[ -z "$event" ]] && return 0

  # Read the boolean directly. jq's `//` coalescing would swallow a configured
  # `false` (false // true → true), so handle null separately via `if`.
  local audit_enabled="true"
  local config_file="${CLAUDE_PLUGIN_DATA}/config.json"
  if [[ -f "$config_file" ]]; then
    audit_enabled=$(jq -r '.observability.auditLog | if . == null then "true" else tostring end' "$config_file" 2>/dev/null || printf 'true')
  fi
  [[ "$audit_enabled" != "true" ]] && return 0

  local run_dir
  run_dir=$(current_run_dir 2>/dev/null) || return 0
  local metrics_file="$run_dir/metrics.jsonl"
  [[ -f "$metrics_file" ]] || return 0

  local run_id
  run_id=$(basename "$run_dir")

  local jq_args=(-n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                    --arg run_id "$run_id" \
                    --arg event "$event")
  local filter='{ts:$ts, run_id:$run_id, event:$event}'
  local pair key val parsed
  for pair in "$@"; do
    key="${pair%%=*}"
    val="${pair#*=}"
    [[ -z "$key" || "$key" == "$pair" ]] && continue
    if parsed=$(printf '%s' "$val" | jq -e . 2>/dev/null); then
      jq_args+=(--argjson "$key" "$parsed")
    else
      jq_args+=(--arg "$key" "$val")
    fi
    filter+=" + {$key: \$$key}"
  done

  jq -c "${jq_args[@]}" "$filter" >> "$metrics_file" 2>/dev/null || true
}

# Emit a structured pipeline.step.begin metric.
# Usage: log_step_begin <step> [key=val ...]
# Typical: log_step_begin "preflight" "task_id=\"$task_id\"" "stage=\"$stage\""
# Pair with log_step_end once the step completes. Caller is responsible for
# timing — pass duration_ms to log_step_end.
log_step_begin() {
  local step="$1"; shift || true
  [[ -z "$step" ]] && return 0
  log_metric "pipeline.step.begin" "step=\"$step\"" "$@"
}

# Emit a structured pipeline.step.end metric.
# Usage: log_step_end <step> <status> <duration_ms> [key=val ...]
# <status> is typically one of: ok|failed|skipped|spawn|wait_retry|end_gracefully.
log_step_end() {
  local step="$1" status="$2" duration_ms="$3"
  shift 3 || true
  [[ -z "$step" ]] && return 0
  log_metric "pipeline.step.end" \
    "step=\"$step\"" \
    "status=\"$status\"" \
    "duration_ms=$duration_ms" \
    "$@"
}

# Emit a structured CI-outcome metric.
# Usage: emit_ci_metric <kind: task|run> <pr_number> <status: green|red|timeout> [<checks_json>]
emit_ci_metric() {
  local kind="$1" pr="$2" status="$3" checks="${4:-[]}"
  local event
  case "$kind" in
    task) event="task.ci" ;;
    run)  event="run.ci" ;;
    *) log_error "emit_ci_metric: invalid kind: $kind"; return 1 ;;
  esac
  log_metric "$event" "pr_number=$pr" "status=\"$status\"" "checks=$checks"
}

# --- Safety guards ---

# Refuse a path if it is empty, a known system root, outside CLAUDE_PLUGIN_DATA,
# or resolves via realpath to a location outside CLAUDE_PLUGIN_DATA (symlink
# escape). Used before every destructive `rm -rf` in pipeline scripts.
# Usage: assert_in_plugin_data "$path" || exit 1
assert_in_plugin_data() {
  local path="$1"
  if [[ -z "$path" ]]; then
    log_error "refuse: empty path"
    return 1
  fi
  case "$path" in
    /|/bin|/etc|/home|/root|/tmp|/usr|/var|"$HOME") log_error "refuse: system path: $path"; return 1 ;;
  esac
  local base
  base=$(_realpath_m "${CLAUDE_PLUGIN_DATA:-}") || {
    log_error "refuse: cannot resolve CLAUDE_PLUGIN_DATA"
    return 1
  }
  local resolved
  resolved=$(_realpath_m "$path") || {
    log_error "refuse: cannot resolve path: $path"
    return 1
  }
  if [[ "$resolved" != "$base" && "$resolved" != "$base"/* ]]; then
    log_error "refuse: $resolved is outside $base"
    return 1
  fi
  return 0
}

# Portable `realpath -m` shim. GNU coreutils supports `-m` (resolve even when
# components don't exist); macOS realpath does not. Fall back to Python.
_realpath_m() {
  local p="$1"
  [[ -z "$p" ]] && return 1
  if realpath -m "$p" 2>/dev/null; then return 0; fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$p" 2>/dev/null && return 0
  fi
  return 1
}

# --- Quota gate ---

# Run a quota gate at a named pipeline boundary.
#
# Constraint: Claude Code bash tool hard-caps at 10 min per invocation, so this
# function does AT MOST one sleep chunk per call (default 540s / 9min). On wait
# it sleeps once, re-checks, and either proceeds or yields (exit 3) back to the
# orchestrator, which re-invokes the gate — preserving full autonomy across
# arbitrarily long waits (e.g. a 5h window reset) without exceeding the tool cap.
#
# Stuck-cache protection: two separate counters in run state:
#   .circuit_breaker.quota_wait_cycles  — consecutive "still over" yields
#   .circuit_breaker.quota_stale_cycles — consecutive yields where the cache
#                                         did not advance (statusline silent)
# Both reset on `proceed`. wait_cycles caps at MAX_CYCLES (~9h); stale_cycles
# caps separately at MAX_STALE_CYCLES (~1h). Splitting them lets a quiet
# statusline yield gracefully (orchestrator turn refreshes cache) instead of
# end_gracefully on the first stale read.
#
# Config / env overrides (env wins):
#   FACTORY_QUOTA_GATE_SLEEP_CAP_SEC    / .quota.sleepCapSec       (default 540)
#   FACTORY_QUOTA_GATE_MAX_CYCLES       / .quota.maxWaitCycles     (default 60)
#   FACTORY_QUOTA_GATE_MAX_STALE_CYCLES / .quota.maxStaleCycles    (default 6)
#
# Usage: pipeline_quota_gate <run_id> <tier> <boundary_label> [task_id]
# When invoked in per-task context, pass <task_id> (4th arg) so emitted
# quota.check / quota.wait events include it — enabling the scorer to
# evaluate T1_quota_checked per task. If omitted and <boundary_label>
# matches "task-<id>", the id is auto-derived.
# Returns: 0=proceed, 2=end_gracefully (halt), 3=wait_retry (orchestrator re-invoke)
pipeline_quota_gate() {
  # Self-heal env alignment: the statusline wrapper writes usage-cache.json to
  # whichever CLAUDE_PLUGIN_DATA the wrapper sees, and pipeline_quota_gate reads
  # from the lib's. If merged-settings.json has a different (or missing) value
  # in env.CLAUDE_PLUGIN_DATA, the wrapper is silently writing to a different
  # path and our reads will look stale forever. Warn loudly so an operator can
  # relaunch with --settings; we cannot regenerate mid-session because the
  # active Claude Code session owns its env block.
  _quota_gate_check_env_alignment
  local run_id="$1" tier="$2" boundary_label="$3" task_id="${4:-}"
  local quota route action wait_min prior trigger
  local sleep_cap_sec max_cycles max_stale_cycles
  sleep_cap_sec="${FACTORY_QUOTA_GATE_SLEEP_CAP_SEC:-$(read_config '.quota.sleepCapSec' '540')}"
  max_cycles="${FACTORY_QUOTA_GATE_MAX_CYCLES:-$(read_config '.quota.maxWaitCycles' '60')}"
  max_stale_cycles="${FACTORY_QUOTA_GATE_MAX_STALE_CYCLES:-$(read_config '.quota.maxStaleCycles' '6')}"

  # Auto-derive task_id from boundary_label like "task-<id>" when not given.
  if [[ -z "$task_id" && "$boundary_label" == task-* ]]; then
    task_id="${boundary_label#task-}"
  fi

  # Build the optional task_id kv for log_metric calls (empty when run-level).
  local task_id_kv=()
  [[ -n "$task_id" ]] && task_id_kv=("task_id=\"$task_id\"")

  if [[ -z "$run_id" ]]; then
    log_error "quota gate [$boundary_label]: run_id required"
    return 2
  fi

  # Stuck-cache guard: count consecutive wait yields across orchestrator re-invocations.
  local cycles stale_cycles
  cycles=$(pipeline-state read "$run_id" '.circuit_breaker.quota_wait_cycles // 0' 2>/dev/null || printf '0')
  stale_cycles=$(pipeline-state read "$run_id" '.circuit_breaker.quota_stale_cycles // 0' 2>/dev/null || printf '0')
  if (( cycles >= max_cycles )); then
    log_warn "quota gate [$boundary_label]: ${cycles} consecutive wait cycles (cap=${max_cycles}) — ending gracefully"
    return 2
  fi
  if (( stale_cycles >= max_stale_cycles )); then
    log_warn "quota gate [$boundary_label]: ${stale_cycles} consecutive stale-cache cycles (cap=${max_stale_cycles}) — ending gracefully"
    return 2
  fi

  local _qrc=0 _qerr
  _qerr=$(mktemp)
  quota=$(pipeline-quota-check 2>"$_qerr") || _qrc=$?
  if (( _qrc != 0 )); then
    log_warn "quota gate [$boundary_label]: pipeline-quota-check crashed (rc=$_qrc) — ending gracefully. stderr: $(cat "$_qerr")"
    rm -f "$_qerr"
    log_metric "quota.check" \
      "gate=\"$boundary_label\"" \
      "action=\"error\"" \
      "tier=\"$tier\"" \
      "reason=\"quota-check-crashed\"" \
      ${task_id_kv[@]+"${task_id_kv[@]}"}
    return 2
  fi
  rm -f "$_qerr"
  local detection_method reason
  detection_method=$(printf '%s' "$quota" | jq -r '.detection_method // "statusline"')
  reason=$(printf '%s' "$quota" | jq -r '.reason // ""')

  # Stale-cache yield: telemetry is broken (statusline silent / cache missing /
  # cache too old). Yield exit 3 so the next orchestrator turn fires a fresh
  # statusline tick before we end_gracefully. The stale_cycles cap (above)
  # still bounds total time spent waiting on a permanently-broken statusline.
  if [[ "$detection_method" == "unavailable" ]]; then
    log_metric "quota.check" \
      "gate=\"$boundary_label\"" \
      "action=\"stale_yield\"" \
      "tier=\"$tier\"" \
      "reason=\"$reason\"" \
      "stale_cycle=$((stale_cycles + 1))" \
      ${task_id_kv[@]+"${task_id_kv[@]}"}
    if ! pipeline-state write "$run_id" '.circuit_breaker.quota_stale_cycles' "$(( stale_cycles + 1 ))" 2>/dev/null; then
      log_warn "quota gate [$boundary_label]: failed to increment quota_stale_cycles"
    fi
    log_info "quota gate [$boundary_label]: cache unavailable ($reason) — yielding to refresh statusline (cycle $((stale_cycles + 1))/${max_stale_cycles})"
    return 3
  fi

  local _rrc=0 _rerr
  _rerr=$(mktemp)
  route=$(pipeline-model-router --quota "$quota" --tier "$tier" 2>"$_rerr") || _rrc=$?
  if (( _rrc != 0 )); then
    log_warn "quota gate [$boundary_label]: pipeline-model-router crashed (rc=$_rrc) — ending gracefully. stderr: $(cat "$_rerr")"
    rm -f "$_rerr"
    log_metric "quota.check" \
      "gate=\"$boundary_label\"" \
      "action=\"error\"" \
      "tier=\"$tier\"" \
      "reason=\"model-router-crashed\"" \
      ${task_id_kv[@]+"${task_id_kv[@]}"}
    return 2
  fi
  rm -f "$_rerr"
  action=$(printf '%s' "$route" | jq -r '.action')

  local util5 util7
  util5=$(printf '%s' "$quota" | jq -r '.five_hour.utilization // null')
  util7=$(printf '%s' "$quota" | jq -r '.seven_day.utilization // null')
  log_metric "quota.check" \
    "gate=\"$boundary_label\"" \
    "action=\"$action\"" \
    "tier=\"$tier\"" \
    "over_5h=$util5" \
    "over_7d=$util7" \
    ${task_id_kv[@]+"${task_id_kv[@]}"}

  case "$action" in
    proceed)
      # Reset both counters on any successful proceed.
      pipeline-state write "$run_id" '.circuit_breaker.quota_wait_cycles' '0' 2>/dev/null \
        || log_warn "quota gate [$boundary_label]: failed to reset quota_wait_cycles"
      pipeline-state write "$run_id" '.circuit_breaker.quota_stale_cycles' '0' 2>/dev/null \
        || log_warn "quota gate [$boundary_label]: failed to reset quota_stale_cycles"
      return 0
      ;;
    end_gracefully)
      trigger=$(printf '%s' "$route" | jq -r '.trigger // "unknown"')
      log_warn "quota gate [$boundary_label]: end_gracefully (trigger=$trigger)"
      return 2
      ;;
    wait)
      wait_min=$(printf '%s' "$route" | jq -r '.wait_minutes // empty')
      if [[ -z "$wait_min" ]]; then
        log_warn "quota gate [$boundary_label]: router returned wait with no wait_minutes — ending gracefully"
        return 2
      fi
      local want_sleep_sec=$(( wait_min * 60 ))
      local do_sleep_sec=$(( want_sleep_sec < sleep_cap_sec ? want_sleep_sec : sleep_cap_sec ))
      local slept_min=$(( (do_sleep_sec + 59) / 60 ))
      log_info "quota gate [$boundary_label]: over threshold — sleeping ${slept_min}m of ${wait_min}m (cycle $((cycles + 1))/${max_cycles})"
      sleep "$do_sleep_sec"

      # Record pause time so circuit breaker excludes it from runtime.
      prior=$(pipeline-state read "$run_id" '.circuit_breaker.pause_minutes // 0' 2>/dev/null || printf '0')
      if ! pipeline-state write "$run_id" '.circuit_breaker.pause_minutes' "$(( prior + slept_min ))" 2>/dev/null; then
        log_warn "quota gate [$boundary_label]: failed to write pause_minutes for run_id=$run_id"
      fi

      log_metric "quota.wait" \
        "gate=\"$boundary_label\"" \
        "tier=\"$tier\"" \
        "minutes_slept=$slept_min" \
        "cumulative_pause_minutes=$(( prior + slept_min ))" \
        "cycle=$((cycles + 1))" \
        ${task_id_kv[@]+"${task_id_kv[@]}"}

      # Re-check after the chunk. If clear, proceed; if stale, yield separately;
      # else yield via wait_cycles counter.
      _qrc=0
      _qerr=$(mktemp)
      quota=$(pipeline-quota-check 2>"$_qerr") || _qrc=$?
      if (( _qrc != 0 )); then
        log_warn "quota gate [$boundary_label]: post-wait pipeline-quota-check crashed (rc=$_qrc) — ending gracefully. stderr: $(cat "$_qerr")"
        rm -f "$_qerr"
        log_metric "quota.check" \
          "gate=\"$boundary_label\"" \
          "action=\"error\"" \
          "tier=\"$tier\"" \
          "reason=\"quota-check-crashed\"" \
          "phase=\"post-wait\"" \
          ${task_id_kv[@]+"${task_id_kv[@]}"}
        return 2
      fi
      rm -f "$_qerr"
      detection_method=$(printf '%s' "$quota" | jq -r '.detection_method // "statusline"')
      reason=$(printf '%s' "$quota" | jq -r '.reason // ""')

      if [[ "$detection_method" == "unavailable" ]]; then
        log_metric "quota.check" \
          "gate=\"$boundary_label\"" \
          "action=\"stale_yield\"" \
          "tier=\"$tier\"" \
          "reason=\"$reason\"" \
          "phase=\"post-wait\"" \
          "stale_cycle=$((stale_cycles + 1))" \
          ${task_id_kv[@]+"${task_id_kv[@]}"}
        if ! pipeline-state write "$run_id" '.circuit_breaker.quota_stale_cycles' "$(( stale_cycles + 1 ))" 2>/dev/null; then
          log_warn "quota gate [$boundary_label]: failed to increment quota_stale_cycles"
        fi
        log_info "quota gate [$boundary_label]: post-wait cache unavailable ($reason) — yielding to refresh statusline (cycle $((stale_cycles + 1))/${max_stale_cycles})"
        return 3
      fi

      _rrc=0
      _rerr=$(mktemp)
      route=$(pipeline-model-router --quota "$quota" --tier "$tier" 2>"$_rerr") || _rrc=$?
      if (( _rrc != 0 )); then
        log_warn "quota gate [$boundary_label]: post-wait pipeline-model-router crashed (rc=$_rrc) — ending gracefully. stderr: $(cat "$_rerr")"
        rm -f "$_rerr"
        log_metric "quota.check" \
          "gate=\"$boundary_label\"" \
          "action=\"error\"" \
          "tier=\"$tier\"" \
          "reason=\"model-router-crashed\"" \
          "phase=\"post-wait\"" \
          ${task_id_kv[@]+"${task_id_kv[@]}"}
        return 2
      fi
      rm -f "$_rerr"
      action=$(printf '%s' "$route" | jq -r '.action')

      log_metric "quota.check" \
        "gate=\"$boundary_label\"" \
        "action=\"$action\"" \
        "tier=\"$tier\"" \
        "over_5h=$(printf '%s' "$quota" | jq -r '.five_hour.utilization // null')" \
        "over_7d=$(printf '%s' "$quota" | jq -r '.seven_day.utilization // null')" \
        "phase=\"post-wait\"" \
        ${task_id_kv[@]+"${task_id_kv[@]}"}

      # Telemetry working again — reset stale counter regardless of action.
      pipeline-state write "$run_id" '.circuit_breaker.quota_stale_cycles' '0' 2>/dev/null \
        || log_warn "quota gate [$boundary_label]: failed to reset quota_stale_cycles"

      if [[ "$action" == "proceed" ]]; then
        pipeline-state write "$run_id" '.circuit_breaker.quota_wait_cycles' '0' 2>/dev/null \
          || log_warn "quota gate [$boundary_label]: failed to reset quota_wait_cycles"
        return 0
      fi
      if [[ "$action" == "end_gracefully" ]]; then
        trigger=$(printf '%s' "$route" | jq -r '.trigger // "unknown"')
        log_warn "quota gate [$boundary_label]: end_gracefully after wait (trigger=$trigger)"
        return 2
      fi
      # Still waiting — increment cycle counter and yield.
      if ! pipeline-state write "$run_id" '.circuit_breaker.quota_wait_cycles' "$(( cycles + 1 ))" 2>/dev/null; then
        log_warn "quota gate [$boundary_label]: failed to increment quota_wait_cycles"
      fi
      log_info "quota gate [$boundary_label]: yielding to orchestrator for re-invocation"
      return 3
      ;;
    *)
      log_warn "quota gate [$boundary_label]: unexpected action=$action — ending gracefully"
      return 2
      ;;
  esac
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

# Verify merged-settings.json env.CLAUDE_PLUGIN_DATA matches the runtime
# CLAUDE_PLUGIN_DATA. Logs a warning + emits a one-shot metric on mismatch.
# Idempotent and cheap (one jq + one comparison). No-op when the file is
# absent (FACTORY_AUTONOMOUS_MODE bypass / dev shell).
_quota_gate_check_env_alignment() {
  local merged="${CLAUDE_PLUGIN_DATA:-}/merged-settings.json"
  [[ -f "$merged" ]] || return 0
  local pinned
  pinned=$(jq -r '.env.CLAUDE_PLUGIN_DATA // empty' "$merged" 2>/dev/null) || return 0
  if [[ -z "$pinned" ]]; then
    log_warn "merged-settings.json missing env.CLAUDE_PLUGIN_DATA — statusline cache may write to a different path. Relaunch with: claude --settings $merged"
    log_metric "quota.env_misalignment" "kind=\"pinned-missing\""
    return 0
  fi
  if [[ "$pinned" != "${CLAUDE_PLUGIN_DATA:-}" ]]; then
    log_warn "merged-settings.json env.CLAUDE_PLUGIN_DATA=$pinned does not match runtime CLAUDE_PLUGIN_DATA=${CLAUDE_PLUGIN_DATA:-}; statusline cache likely stale. Relaunch with: claude --settings $merged"
    log_metric "quota.env_misalignment" "kind=\"pinned-mismatch\"" "pinned=\"$pinned\"" "runtime=\"${CLAUDE_PLUGIN_DATA:-}\""
  fi
}

# Read a single index from a JSON-array config key, falling back to a default.
# Usage: _quota_curve_value <jq-path-to-array> <idx> <default>
# Returns the array element at idx, or default if config is missing/short.
_quota_curve_value() {
  local jq_key="$1" idx="$2" default="$3"
  local config_file="${CLAUDE_PLUGIN_DATA:-}/config.json"
  if [[ -f "$config_file" ]]; then
    local val
    val=$(jq -r --argjson i "$idx" "${jq_key}[\$i] // empty" "$config_file" 2>/dev/null) || val=""
    if [[ -n "$val" && "$val" != "null" ]]; then
      printf '%s' "$val"
      return
    fi
  fi
  printf '%s' "$default"
}

# Hourly utilization threshold for a given window_hour. Default curve
# [20, 40, 60, 80, 90] — linear with a 90% cap in the final hour to protect
# the burst-pricing reserve. Override via .quota.hourlyThresholds in config.
# Usage: compute_hourly_threshold <window_hour>
compute_hourly_threshold() {
  local hour="$1"
  local idx=$((hour - 1))
  if (( idx < 0 )); then idx=0; fi
  if (( idx > 4 )); then idx=4; fi
  local defaults=(20 40 60 80 90)
  _quota_curve_value '.quota.hourlyThresholds' "$idx" "${defaults[$idx]}"
}

# Daily utilization threshold for a given window_day. Default curve
# [14, 29, 43, 57, 71, 86, 95] — front-loaded conservatism; day 7 caps at
# 95% so we never burn the final reserve. Override via .quota.dailyThresholds.
# Usage: compute_daily_threshold <window_day>
compute_daily_threshold() {
  local day="$1"
  local idx=$((day - 1))
  if (( idx < 0 )); then idx=0; fi
  if (( idx > 6 )); then idx=6; fi
  local defaults=(14 29 43 57 71 86 95)
  _quota_curve_value '.quota.dailyThresholds' "$idx" "${defaults[$idx]}"
}

# ============================================================
# BD-scope helpers — added by Subagent BD [code-review]
# ============================================================

# Classify a file path as a test file (return 0) or not (return 1).
# Covers: *.test.*, *.spec.*, *_test.*, *Test.*, *Tests.*, *_spec.rb,
# and directory-based patterns: tests/**, test/**, spec/**, **/__tests__/**
# Usage: is_test_path <path>
is_test_path() {
  local f="$1"
  case "$f" in
    # Suffix-based: .test.<ext> and .spec.<ext>
    *.test.ts|*.test.tsx|*.test.js|*.test.jsx|*.test.mjs|*.test.cjs) return 0 ;;
    *.test.py|*.test.rb|*.test.go|*.test.rs)                          return 0 ;;
    *.spec.ts|*.spec.tsx|*.spec.js|*.spec.jsx|*.spec.mjs|*.spec.cjs) return 0 ;;
    *.spec.py|*.spec.rb|*.spec.go|*.spec.rs)                          return 0 ;;
    # Suffix-based: _test.<ext> (Go, Python, Ruby, Elixir)
    *_test.go|*_test.py|*_test.rb|*_test.exs)                        return 0 ;;
    # Suffix-based: *Test.<ext> (Java, Kotlin, PHP)
    *Test.java|*Test.kt|*Test.php)                                    return 0 ;;
    # Suffix-based: *Tests.<ext> (Swift, C#)
    *Tests.swift|*Tests.cs)                                           return 0 ;;
    # Suffix-based: *_spec.rb (RSpec)
    *_spec.rb)                                                        return 0 ;;
    # Directory-based — root and per-package (monorepo) layouts
    tests/*|test/*|spec/*|__tests__/*)                                return 0 ;;
    */tests/*|*/test/*|*/spec/*|*/__tests__/*)                        return 0 ;;
    *) return 1 ;;
  esac
}

# Return 0 if the given task is tdd_exempt per tasks.json or package.json.
# Args: <task_id> [<spec_dir>]
# Reads tasks.json from <spec_dir>/tasks.json and specs/current/tasks.json.
task_tdd_exempt() {
  local task_id="$1" spec_dir="${2:-}"
  local tfile flag
  for tfile in "${spec_dir:+$spec_dir/tasks.json}" specs/current/tasks.json; do
    [[ -z "$tfile" || ! -f "$tfile" ]] && continue
    flag=$(jq -r --arg id "$task_id" '.tasks[]? | select(.task_id==$id) | .tdd_exempt // false' "$tfile" 2>/dev/null || true)
    [[ "$flag" == "true" ]] && return 0
  done
  if [[ -f package.json ]]; then
    local g
    g=$(jq -r '.["factory"].tddExempt // false' package.json 2>/dev/null || true)
    [[ "$g" == "true" ]] && return 0
  fi
  return 1
}

# Stage ordering constant — single source of truth used by _already_past and
# any future callers that need to compare pipeline stage ranks.
# shellcheck disable=SC2034  # used by sourcing scripts (pipeline-run-task)
PIPELINE_STAGE_ORDER=(
  preflight_done
  preexec_tests_done
  postexec_spawn_pending
  postexec_done
  postreview_pending_human
  postreview_exhausted
  postreview_done
  ship_done
)

# Strip exactly one leading and one trailing double-quote from a JSON-encoded
# string value. Semantically equivalent to `jq -r` for simple string values.
# Usage: _unquote_json_string <value>
_unquote_json_string() {
  local s="$1"
  s="${s#\"}"
  s="${s%\"}"
  printf '%s' "$s"
}

# Load and render a prompt template from
# skills/pipeline-orchestrator/prompts/<stage>.tmpl.
# Variables in the template are expanded using ${VAR} syntax (envsubst-style).
# If envsubst is not available, a pure-bash fallback substituter is used.
# Usage: load_prompt <stage>
# Exports must be set by caller before invoking this function.
load_prompt() {
  local stage="$1" tmpl_dir tmpl_file
  local lib_dir
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  tmpl_dir="$lib_dir/../skills/pipeline-orchestrator/prompts"
  tmpl_file="$tmpl_dir/$stage.tmpl"
  if [[ ! -f "$tmpl_file" ]]; then
    log_error "missing prompt template: $stage (looked in $tmpl_dir)"
    return 1
  fi
  # Always use the bash substituter — it enforces an allowlist of variables
  # that templates may reference. The system `envsubst` would expand any
  # exported variable (PATH, HOME, secrets, etc.) and bypass the allowlist.
  _envsubst_bash < "$tmpl_file"
}

# Allowed variables that prompt templates may reference. Anything else is
# refused (log_warn) and replaced with a [BLOCKED:VAR] sentinel — prevents
# templates from leaking arbitrary env (PATH, HOME, secrets, etc.).
_ENVSUBST_ALLOWED=(run_id task_id spec_path stage role base_ref)

# Pure-bash envsubst substitute. Reads stdin; expands ${VAR} and $VAR
# using the caller's environment via ${!var} indirection. Only variables
# present in _ENVSUBST_ALLOWED are substituted; all others are replaced
# with a [BLOCKED:VAR] sentinel and a log_warn is emitted.
_envsubst_bash() {
  local line var val
  while IFS= read -r line || [[ -n "$line" ]]; do
    # ${VAR} form
    while [[ "$line" =~ \$\{([A-Za-z_][A-Za-z0-9_]*)\} ]]; do
      var="${BASH_REMATCH[1]}"
      local allowed=0 v
      for v in "${_ENVSUBST_ALLOWED[@]}"; do [[ "$v" == "$var" ]] && allowed=1; done
      if (( allowed == 0 )); then
        log_warn "_envsubst_bash: refusing non-allowlisted var: $var"
        line="${line/\$\{$var\}/[BLOCKED:$var]}"
        continue
      fi
      val="${!var:-}"
      line="${line/\$\{$var\}/$val}"
    done
    # $VAR form (not followed by `{` — handled above)
    while [[ "$line" =~ \$([A-Za-z_][A-Za-z0-9_]*)([^A-Za-z0-9_]|$) ]]; do
      var="${BASH_REMATCH[1]}"
      local allowed=0 v
      for v in "${_ENVSUBST_ALLOWED[@]}"; do [[ "$v" == "$var" ]] && allowed=1; done
      if (( allowed == 0 )); then
        log_warn "_envsubst_bash: refusing non-allowlisted var: $var"
        line="${line/\$$var/[BLOCKED:$var]}"
        continue
      fi
      val="${!var:-}"
      line="${line/\$$var/$val}"
    done
    printf '%s\n' "$line"
  done
}

# ============================================================
# E-scope helpers — added by Subagent E [code-review]
# ============================================================

# Validate that a string is a safe identifier for run-id / task-id use.
# Charset: [a-zA-Z0-9_-], length 1-64.
# Returns 0 (valid) or 1 (invalid). On invalid, logs to stderr.
# Usage: _validate_id <id> [<label>]
_validate_id() {
  local id="$1" label="${2:-id}"
  if [[ -z "$id" ]]; then
    log_error "$label: empty"
    return 1
  fi
  if ! [[ "$id" =~ ^[a-zA-Z0-9_-]{1,64}$ ]]; then
    log_error "$label: invalid (must match ^[a-zA-Z0-9_-]{1,64}$): $id"
    return 1
  fi
  return 0
}

# Drop reviewer findings whose verbatim_line is not a substring of the diff.
# Stdin: normalized review JSON (with .findings[].verbatim_line set).
# Args:  $1 = path to a file containing the diff text to grep against.
# Stdout: filtered review JSON. Recomputes blocking_count / non_blocking_count /
# declared_blockers; appends a marker to .summary if any findings were dropped
# so the orchestrator can audit. NEVER mutates verdict — if all blockers were
# unverifiable, verdict stays REQUEST_CHANGES and the orchestrator's retry
# budget handles eventual termination.
#
# Findings missing a verbatim_line, or with one shorter than 10 chars, are
# treated as unverifiable and dropped.
validate_findings() {
  local diff_file="$1" json n i q kept dropped
  json=$(cat)
  if [[ ! -s "$diff_file" ]]; then
    log_warn "validate_findings: empty diff — keeping all findings, refusing auto-approve"
    printf '%s' "$json" | jq '.summary = ((.summary // "") + " [validator: diff empty; findings unverifiable]")'
    return 0
  fi
  n=$(printf '%s' "$json" | jq '.findings | length')
  kept='[]'
  dropped=0
  for ((i=0; i<n; i++)); do
    q=$(printf '%s' "$json" | jq -r ".findings[$i].verbatim_line // \"\"")
    if [[ ${#q} -ge 10 ]] && grep -qF -- "$q" "$diff_file"; then
      kept=$(printf '%s' "$json" | jq --argjson k "$kept" --argjson i "$i" '$k + [.findings[$i]]')
    else
      dropped=$((dropped + 1))
    fi
  done
  printf '%s' "$json" | jq --argjson k "$kept" --argjson d "$dropped" '
    .findings = ($k | map(
      .blocking = (
        if (.blocking == true or .blocking == false) then .blocking
        else (.severity == "critical" or .severity == "high")
        end)))
    | .blocking_count = ([.findings[] | select(.blocking == true)] | length)
    | .non_blocking_count = ((.findings | length) - .blocking_count)
    | .declared_blockers = .blocking_count
    | if $d > 0 then
        .summary = ((.summary // "") + " [validator: dropped " + ($d|tostring) + " unverifiable finding(s)]")
      else . end
  '
}
