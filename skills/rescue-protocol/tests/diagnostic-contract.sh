#!/usr/bin/env bash
# Contract test: canned diagnostic outputs → pipeline-rescue-apply → expected state transitions.
# Does not invoke a real LLM.
set -euo pipefail

export CLAUDE_PLUGIN_DATA=$(mktemp -d)
export PATH="$(cd "$(dirname "$0")/../../../bin" && pwd):$PATH"

pass=0
fail=0
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then echo "  PASS: $label"; pass=$((pass + 1));
  else echo "  FAIL: $label (expected '$expected', got '$actual')"; fail=$((fail + 1)); fi
}

seed() {
  mkdir -p "$CLAUDE_PLUGIN_DATA/runs/R1"
  cat > "$CLAUDE_PLUGIN_DATA/runs/R1/state.json" <<'JSON'
{
  "run_id": "R1",
  "status": "running",
  "input": {"issue_numbers": [112]},
  "tasks": {"T1": {"task_id": "T1", "status": "failed", "failure_reason": "flaky ci"}}
}
JSON
  ln -sfn "$CLAUDE_PLUGIN_DATA/runs/R1" "$CLAUDE_PLUGIN_DATA/runs/current"
}

for dec in reset_pending mark_failed reset_postreview no_action; do
  seed
  plan="$CLAUDE_PLUGIN_DATA/plan_$dec.json"
  cat > "$plan" <<JSON
{"run_id":"R1","plans":[{"task_id":"T1","decision":"$dec","reason":"canned","evidence":[],"state_updates":{},"confidence":"high"}]}
JSON
  pipeline-rescue-apply --plans="$plan" >/dev/null
  status=$(pipeline-state read R1 '.tasks.T1.status')
  case "$dec" in
    reset_pending)    assert_eq "$dec sets pending" "pending" "$status" ;;
    mark_failed)      assert_eq "$dec sets failed" "failed" "$status" ;;
    reset_postreview) assert_eq "$dec leaves status" "failed" "$status" ;;
    no_action)        assert_eq "$dec leaves status" "failed" "$status" ;;
  esac
done

echo "Passed: $pass | Failed: $fail"
[[ $fail -eq 0 ]]
