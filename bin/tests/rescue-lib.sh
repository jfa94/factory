#!/usr/bin/env bash
# Tests for bin/pipeline-rescue-lib.sh helpers.
set -euo pipefail

export CLAUDE_PLUGIN_DATA=$(mktemp -d)
export PATH="$(cd "$(dirname "$0")/.." && pwd):$PATH"

# shellcheck source=../pipeline-rescue-lib.sh
source "$(cd "$(dirname "$0")/.." && pwd)/pipeline-rescue-lib.sh"

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

echo "=== rescue_now_iso ==="
ts=$(rescue_now_iso)
if [[ "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  echo "  PASS: rescue_now_iso produces ISO-8601 UTC"
  pass=$((pass + 1))
else
  echo "  FAIL: got '$ts'"
  fail=$((fail + 1))
fi

echo "=== rescue_issue_for_run ==="
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/R1"
cat > "$CLAUDE_PLUGIN_DATA/runs/R1/state.json" <<'JSON'
{"input": {"issue_numbers": [112]}}
JSON
issue=$(rescue_issue_for_run R1)
assert_eq "issue lookup" "112" "$issue"

echo "=== rescue_pr_belongs_to_run ==="
if rescue_pr_belongs_to_run "[112] task(T1): add login" "112"; then
  echo "  PASS: matching title classified as run PR"
  pass=$((pass + 1))
else
  echo "  FAIL: should have classified matching title"
  fail=$((fail + 1))
fi
if rescue_pr_belongs_to_run "[999] task(T1): something" "112"; then
  echo "  FAIL: non-matching title falsely classified"
  fail=$((fail + 1))
else
  echo "  PASS: non-matching title rejected"
  pass=$((pass + 1))
fi

echo "=== rescue_task_id_from_title ==="
tid=$(rescue_task_id_from_title "[112] task(auth-001): add login endpoint")
assert_eq "task_id extraction" "auth-001" "$tid"
tid_empty=$(rescue_task_id_from_title "not a standard title")
assert_eq "no match returns empty" "" "$tid_empty"

echo
echo "Passed: $pass | Failed: $fail"
[[ $fail -eq 0 ]]
