#!/usr/bin/env bash
# Dev-only wrapper around pipeline-score. Interactive picker by default.
# Usage:
#   tools/score-run.sh                      # pick from 5 most recent runs
#   tools/score-run.sh --run <run-id>
#   tools/score-run.sh --since <ISO-date>
#   tools/score-run.sh --versions v1,v2
#   tools/score-run.sh --format json|table
#   tools/score-run.sh --no-gh
#   tools/score-run.sh --no-log
#   tools/score-run.sh backfill <args>
#   tools/score-run.sh history
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$REPO_ROOT/bin:$PATH"

: "${CLAUDE_PLUGIN_DATA:=$HOME/.claude/plugins/data/factory-jfa94}"
export CLAUDE_PLUGIN_DATA

sub="${1:-pick}"
case "$sub" in
  backfill) shift; exec "$REPO_ROOT/tools/score-run-backfill.sh" "$@" ;;
  history)  shift; exec "$REPO_ROOT/tools/score-run-history.sh" "$@" ;;
esac

for arg in "$@"; do
  case "$arg" in
    --run|--since|--versions) exec pipeline-score "$@" ;;
  esac
done

runs_dir="${CLAUDE_PLUGIN_DATA}/runs"
archive_dir="${CLAUDE_PLUGIN_DATA}/archive"

_state_mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null
}

_find_state_file() {
  local r="$1"
  local f="$runs_dir/$r/state.json"
  [[ -f "$f" ]] || f="$archive_dir/$r/state.json"
  [[ -f "$f" ]] && echo "$f"
}

mapfile -t candidates < <(
  {
    for d in "$runs_dir"/*/state.json "$archive_dir"/*/state.json; do
      [[ -f "$d" ]] || continue
      printf '%s\t%s\n' "$(_state_mtime "$d")" "$(basename "$(dirname "$d")")"
    done
  } | sort -rn | awk '!seen[$2]++ { print $2 }' | head -5
)

if [[ ${#candidates[@]} -eq 0 ]]; then
  echo "No runs found under $runs_dir or $archive_dir" >&2
  exit 1
fi

echo "Recent runs:"
for i in "${!candidates[@]}"; do
  r="${candidates[$i]}"
  state_file=$(_find_state_file "$r")
  if [[ -n "$state_file" ]]; then
    status=$(jq -r '.status' "$state_file")
    mode=$(jq -r '.mode' "$state_file")
    version=$(jq -r '.version // "?"' "$state_file")
    [[ "$state_file" == "$archive_dir"* ]] && tag=" [archived]" || tag=""
    echo "  [$((i+1))] $r  (v$version, mode=$mode, status=$status$tag)"
  else
    echo "  [$((i+1))] $r  (no state.json)"
  fi
done

read -r -p "Select run [1-${#candidates[@]}]: " sel
if ! [[ "$sel" =~ ^[1-9][0-9]*$ ]] || (( sel < 1 || sel > ${#candidates[@]} )); then
  echo "invalid selection" >&2; exit 1
fi
run_id="${candidates[$((sel-1))]}"

pipeline-score --run "$run_id" --format table
