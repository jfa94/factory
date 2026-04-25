#!/usr/bin/env bash
# Statusline wrapper: captures Claude Code rate limit data for pipeline quota checks.
#
# Usage: set statusLine.command in ~/.claude/settings.json to this script:
#   "statusLine": {"type": "command", "command": "/path/to/bin/statusline-wrapper.sh"}
#
# To chain to your existing statusline, set FACTORY_ORIGINAL_STATUSLINE in
# your environment (e.g. via settings.json "env" field):
#   "env": {"FACTORY_ORIGINAL_STATUSLINE": "~/.claude/statusline.sh"}
#
# Rate limit data is written to ${CLAUDE_PLUGIN_DATA}/usage-cache.json on every
# statusline update. pipeline-quota-check reads this file before each task spawn.

set -euo pipefail

input=$(cat)

# Determine plugin data directory. CLAUDE_PLUGIN_DATA is set by the plugin
# system when the pipeline runs; for the statusline (which runs in user env)
# we fall back to a standard location. Set CLAUDE_PLUGIN_DATA in settings.json
# "env" to override.
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-${HOME}/.claude/plugin-data/factory}"

# Write rate limit data to usage-cache.json if rate_limits are present.
# Fail silently so a broken jq or missing dir never breaks the statusline output.
if command -v jq >/dev/null 2>&1; then
  if printf '%s' "$input" | jq -e '.rate_limits' >/dev/null 2>&1; then
    mkdir -p "$PLUGIN_DATA" 2>/dev/null || true
    cache_file="${PLUGIN_DATA}/usage-cache.json"
    now=$(date +%s)
    printf '%s' "$input" \
      | jq --argjson now "$now" '.rate_limits + {captured_at: $now}' \
      > "${cache_file}.tmp" 2>/dev/null \
      && mv -f "${cache_file}.tmp" "$cache_file" 2>/dev/null || true
  fi
fi

_emit_default() {
  local MODEL DIR RESETS
  MODEL=$(printf '%s' "$input" | jq -r '.model.display_name // "Claude"' 2>/dev/null \
    | sed 's/ [0-9][0-9.]*$//' || printf 'Claude')
  DIR=$(printf '%s' "$input" | jq -r '.workspace.current_dir // ""' 2>/dev/null \
    | sed 's|.*/||' || printf '')
  RESETS=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.resets_at // empty' 2>/dev/null || true)
  if [[ -n "$RESETS" ]]; then
    local NOW REMAINING HOURS MINS USAGE REMAINING_PCT
    NOW=$(date +%s)
    REMAINING=$((RESETS - NOW))
    HOURS=$((REMAINING / 3600))
    MINS=$(((REMAINING % 3600) / 60))
    USAGE=$(printf '%s' "$input" \
      | jq -r '.rate_limits.five_hour.used_percentage // 0' 2>/dev/null \
      | cut -d. -f1 || printf '0')
    REMAINING_PCT=$((100 - USAGE))
    printf '%s in %s | %s%% left for %dh %dm\n' "$MODEL" "$DIR" "$REMAINING_PCT" "$HOURS" "$MINS"
  else
    printf '%s in %s\n' "$MODEL" "$DIR"
  fi
}

# Chain to original statusline or emit default output.
if [[ -n "${FACTORY_ORIGINAL_STATUSLINE:-}" ]]; then
  # Expand ~ and split into argv. Refuse values containing shell metacharacters
  # (;, |, &, backticks, $() ) to prevent arbitrary code execution.
  _chain_raw="${FACTORY_ORIGINAL_STATUSLINE/#\~/$HOME}"
  if printf '%s' "$_chain_raw" | grep -qE '[;|&`]|\$\('; then
    printf '%s\n' "statusline-wrapper: FACTORY_ORIGINAL_STATUSLINE contains shell metacharacters — ignored" >&2
    _emit_default
  else
    # Split on whitespace into an argv array.
    read -ra _chain_argv <<< "$_chain_raw"
    _chain_path="${_chain_argv[0]}"
    # Path-with-spaces vs path-with-args disambiguation:
    # If the whole raw string is a readable file, treat it as the sole arg (no args).
    if [[ -f "$_chain_raw" ]]; then
      _chain_argv=("$_chain_raw")
      _chain_path="$_chain_raw"
    fi
    if [[ -f "$_chain_path" ]]; then
      # Pipe input to the chained command via direct exec (no eval).
      # Non-zero exit falls back to the default statusline output.
      set +e
      printf '%s' "$input" | "${_chain_argv[@]}"
      _chain_rc=$?
      set -e
      if (( _chain_rc != 0 )); then _emit_default; fi
    else
      _emit_default
    fi
  fi
else
  _emit_default
fi
