#!/usr/bin/env bash
# Shared helpers for pipeline-rescue-scan and pipeline-rescue-apply.
# Source (do not execute): source "$(dirname "$0")/pipeline-rescue-lib.sh"

# shellcheck disable=SC2034

rescue_now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# Return the parent PRD issue number for a run id, empty string if unknown.
rescue_issue_for_run() {
  local run_id="$1" state
  state="$CLAUDE_PLUGIN_DATA/runs/$run_id/state.json"
  [[ -f "$state" ]] || { printf ''; return; }
  jq -r '.input.issue_numbers[0] // empty' "$state" 2>/dev/null
}

# Return 0 if a PR title belongs to the given issue, 1 otherwise.
rescue_pr_belongs_to_run() {
  local title="$1" issue="$2"
  local prefix="[$issue] task("
  [[ "$title" == "$prefix"* ]]
}

# Parse task_id out of a standardized PR title; empty on no match.
rescue_task_id_from_title() {
  local title="$1"
  local pat="^\[[0-9]+\] task\(([^)]+)\):"
  if [[ "$title" =~ $pat ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

# Write a structured audit entry to .rescue.applied_actions[].
rescue_audit() {
  local run_id="$1" phase="$2" issue_id="$3" task_id="$4" action="$5" result="$6" error="${7:-}"
  local entry
  entry=$(jq -n \
    --arg ts "$(rescue_now_iso)" \
    --arg phase "$phase" \
    --arg issue_id "$issue_id" \
    --arg task_id "$task_id" \
    --arg action "$action" \
    --arg result "$result" \
    --arg error "$error" \
    '{ts: $ts, phase: $phase, issue_id: $issue_id, task_id: $task_id, action: $action, result: $result, error: (if $error == "" then null else $error end)}')
  local current new
  current=$(pipeline-state read "$run_id" '.rescue.applied_actions // []' 2>/dev/null || echo '[]')
  new=$(jq --argjson entry "$entry" '. + [$entry]' <<<"$current")
  pipeline-state write "$run_id" '.rescue.applied_actions' "$new" >/dev/null
}
