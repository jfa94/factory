#!/usr/bin/env bash
# PreToolUse hook: block Edit|Write|MultiEdit to paths matched by
# safety.writeBlockedPaths (bash globstar + extglob). Opt-in; blocklist is
# empty by default.
#
# Stdin: hook input JSON with .tool_name and .tool_input
# Exit 0 = allow, Exit 2 = block (JSON reason on stderr)
set -euo pipefail
shopt -s globstar extglob nullglob

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)
[[ -z "$tool_name" ]] && exit 0

case "$tool_name" in
  Edit|Write|MultiEdit) ;;
  *) exit 0 ;;
esac

config_file="${CLAUDE_PLUGIN_DATA:-}/config.json"
[[ -f "$config_file" ]] || exit 0

# Pull blocklist as a newline-separated list; short-circuit if empty.
mapfile -t blocked < <(jq -r '.["safety.writeBlockedPaths"] // [] | .[]' "$config_file" 2>/dev/null || true)
if (( ${#blocked[@]} == 0 )); then
  exit 0
fi

# Collect candidate target paths from tool_input.
# - Edit/Write: .tool_input.file_path
# - MultiEdit:  .tool_input.file_path (single file per MultiEdit call)
mapfile -t targets < <(printf '%s' "$input" \
  | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)

# If MultiEdit ever grows a multi-file shape, enumerate edits[].file_path.
mapfile -t extra_targets < <(printf '%s' "$input" \
  | jq -r '.tool_input.edits[]?.file_path // empty' 2>/dev/null || true)
targets+=("${extra_targets[@]}")

[[ ${#targets[@]} -eq 0 ]] && exit 0

_block() {
  local path="$1" glob="$2"
  jq -cn --arg path "$path" --arg glob "$glob" \
    '{decision:"block", reason:"write_blocked", path:$path, matched:$glob}' >&2
  exit 2
}

# Resolve target for matching. Use realpath when the file exists, otherwise
# best-effort path normalisation so `./x` and `../x` collapse.
_resolve() {
  local p="$1"
  if [[ -e "$p" ]]; then
    realpath "$p" 2>/dev/null || printf '%s' "$p"
  else
    # Parent may exist even if file doesn't.
    local dir base
    dir=$(dirname "$p")
    base=$(basename "$p")
    if [[ -d "$dir" ]]; then
      printf '%s/%s' "$(cd "$dir" && pwd -P)" "$base"
    else
      printf '%s' "$p"
    fi
  fi
}

for raw in "${targets[@]}"; do
  [[ -z "$raw" ]] && continue
  resolved=$(_resolve "$raw")
  for glob in "${blocked[@]}"; do
    # Match against both the raw path (for patterns like ".env*" relative to
    # the cwd) and the resolved absolute path.
    # shellcheck disable=SC2053
    if [[ "$raw" == $glob || "$resolved" == $glob ]]; then
      _block "$resolved" "$glob"
    fi
    # Also match basename for patterns that target a file name only.
    base=$(basename "$resolved")
    if [[ "$base" == $glob ]]; then
      _block "$resolved" "$glob"
    fi
  done
done

exit 0
