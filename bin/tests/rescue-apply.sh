#!/usr/bin/env bash
set -euo pipefail

export CLAUDE_PLUGIN_DATA=$(mktemp -d)
trap 'rm -rf "$CLAUDE_PLUGIN_DATA"' EXIT
export PATH="$(cd "$(dirname "$0")/.." && pwd):$PATH"

pass=0
fail=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"
    pass=$((pass + 1))
  else
    echo "  FAIL: $label (expected '$expected', got '$actual')"
    fail=$((fail + 1))
  fi
}

seed_run() {
  local run_id=R1
  mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$run_id"
  cat > "$CLAUDE_PLUGIN_DATA/runs/$run_id/state.json" <<'JSON'
{
  "run_id": "R1",
  "status": "running",
  "input": {"issue_numbers": [112]},
  "tasks": {
    "T1": {"task_id": "T1", "status": "executing", "stage": "postreview_done", "pr_number": 42, "pr_url": "https://x/42"}
  }
}
JSON
  ln -sfn "$CLAUDE_PLUGIN_DATA/runs/$run_id" "$CLAUDE_PLUGIN_DATA/runs/current"
}

echo "=== tier-1 I-03: applies mark-pr-merged ==="
seed_run
report="$CLAUDE_PLUGIN_DATA/report.json"
cat > "$report" <<'JSON'
{"run_id":"R1","mechanical_issues":[{"id":"I-03","tier":1,"task_id":"T1","description":"pr merged"}]}
JSON
pipeline-rescue-apply --tier=safe --plan="$report" >/dev/null
status=$(pipeline-state read R1 '.tasks.T1.status')
assert_eq "I-03 sets status=done" 'done' "$status"
stage=$(pipeline-state read R1 '.tasks.T1.stage')
assert_eq "I-03 sets stage=ship_done" 'ship_done' "$stage"

echo "=== idempotency: second apply is no-op ==="
pipeline-rescue-apply --tier=safe --plan="$report" >/dev/null
status2=$(pipeline-state read R1 '.tasks.T1.status')
assert_eq "status unchanged" 'done' "$status2"

echo "=== audit trail ==="
count=$(pipeline-state read R1 '.rescue' | jq '.applied_actions | length')
if (( count >= 1 )); then
  echo "  PASS: audit trail has $count entries"
  pass=$((pass + 1))
else
  echo "  FAIL: audit trail empty"
  fail=$((fail + 1))
fi

echo "=== I-08: mark task failed when PR closed unmerged ==="
seed_run
report2="$CLAUDE_PLUGIN_DATA/report2.json"
cat > "$report2" <<'JSON'
{"run_id":"R1","mechanical_issues":[{"id":"I-08","tier":2,"task_id":"T1","description":"pr closed unmerged"}]}
JSON
pipeline-rescue-apply --tier=risky --plan="$report2" >/dev/null
status=$(pipeline-state read R1 '.tasks.T1.status' | tr -d '"')
assert_eq "I-08 marks failed" "failed" "$status"

echo "=== I-06: reset ship stage to ci_fixing ==="
seed_run
pipeline-state task-write R1 T1 stage '"ship"' >/dev/null
report3="$CLAUDE_PLUGIN_DATA/report3.json"
cat > "$report3" <<'JSON'
{"run_id":"R1","mechanical_issues":[{"id":"I-06","tier":2,"task_id":"T1","description":"ci red"}]}
JSON
pipeline-rescue-apply --tier=risky --plan="$report3" >/dev/null
stage=$(pipeline-state read R1 '.tasks.T1.stage' | tr -d '"')
assert_eq "I-06 resets stage" "postreview_done" "$stage"
status=$(pipeline-state read R1 '.tasks.T1.status' | tr -d '"')
assert_eq "I-06 sets ci_fixing" "ci_fixing" "$status"

echo
echo "Passed: $pass | Failed: $fail"
[[ $fail -eq 0 ]]
