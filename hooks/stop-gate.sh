#!/usr/bin/env bash
# Stop hook: validate state consistency on session end.
# Marks interrupted runs and updates final status.
#
# Stdin: JSON with session_id
# Exit: always 0 (never blocks session end)
set -euo pipefail

# Check for active run
current_link="${CLAUDE_PLUGIN_DATA:-}/runs/current"
if [[ -z "${CLAUDE_PLUGIN_DATA:-}" ]] || [[ ! -L "$current_link" ]]; then
  exit 0
fi

run_dir=$(readlink "$current_link" 2>/dev/null) || exit 0
state_file="$run_dir/state.json"

if [[ ! -f "$state_file" ]]; then
  exit 0
fi

state=$(cat "$state_file")

# Validate JSON — corrupt state should not leave dangling symlink
if ! printf '%s' "$state" | jq -e . >/dev/null 2>&1; then
  echo "[stop-gate] ERROR: corrupt state.json, cleaning up symlink" >&2
  rm -f "$current_link"
  exit 0
fi

run_status=$(printf '%s' "$state" | jq -r '.status')

# Only act on running/executing runs
if [[ "$run_status" != "running" ]]; then
  exit 0
fi

# Autonomous-mode block: refuse to finish while run is live. Orchestrator
# must advance the stage machine (pipeline-run-task) or explicitly mark the
# run terminal. Escape hatch: FACTORY_ALLOW_STOP=1 lets the session end even
# with non-terminal tasks (for emergency recovery or debugging).
if [[ "${FACTORY_AUTONOMOUS_MODE:-0}" == "1" && "${FACTORY_ALLOW_STOP:-0}" != "1" ]]; then
  nonterm=$(printf '%s' "$state" | jq -r '
    [.tasks[]? | select(.status != "done" and .status != "failed" and .status != "needs_human_review")]
    | length
  ')
  if (( nonterm > 0 )); then
    run_id=$(basename "$run_dir")
    next_task=$(printf '%s' "$state" | jq -r '
      [.tasks | to_entries[] |
       select(.value.status != "done" and .value.status != "failed" and .value.status != "needs_human_review") |
       .key] | first // "RUN"
    ')
    reason="run $run_id has $nonterm non-terminal task(s); call pipeline-run-task \"$run_id\" $next_task --stage <stage> to advance (or finalize-run if all tasks are terminal). Set FACTORY_ALLOW_STOP=1 to bypass."
    jq -cn --arg reason "$reason" '{decision:"block", reason:$reason}'
    exit 0
  fi
fi

# Delegate all state mutation (task-status transition, run-level status
# derivation, atomic write, symlink removal) to pipeline-state finalize-on-stop.
# This ensures the write goes through the run-level lock, preventing races
# with any concurrent pipeline-state write call.
run_id=$(basename "$run_dir")
pipeline-state finalize-on-stop "$run_id" >&2

echo "[stop-gate] run $run_id finalized via pipeline-state" >&2

exit 0
