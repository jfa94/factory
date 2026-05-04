#!/usr/bin/env bash
# mutation-gate.sh — pipeline-mutation-gate scope computation, stryker
# invocation, score evaluation, and state write across pass/fail/skip paths.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$PLUGIN_ROOT/bin:$PATH"

TEST_ROOT=$(mktemp -d)
trap '[[ "$TEST_ROOT" == /tmp/* ]] && rm -rf "$TEST_ROOT"' EXIT
export CLAUDE_PLUGIN_DATA="$TEST_ROOT/plugin-data"
mkdir -p "$CLAUDE_PLUGIN_DATA"

pass=0
fail=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"; pass=$((pass+1))
  else
    echo "  FAIL: $label (expected '$expected', got '$actual')"; fail=$((fail+1))
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  PASS: $label"; pass=$((pass+1))
  else
    echo "  FAIL: $label (missing '$needle' in '$haystack')"; fail=$((fail+1))
  fi
}

echo "=== T1: missing args exits non-zero ==="
set +e
out=$(pipeline-mutation-gate 2>&1)
rc=$?
set -e
assert_eq "no args → exit non-zero" "1" "$([[ $rc -ne 0 ]] && echo 1 || echo 0)"
assert_contains "no args → usage message" "missing" "$out"

echo "=== T2a: no package.json → skip pass ==="
WT=$(mktemp -d)
RUN_ID="run-t2a"; TASK_ID="t2a"
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID"
printf '{"tasks":{"%s":{}}}' "$TASK_ID" > "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json"
out=$(pipeline-mutation-gate "$RUN_ID" "$TASK_ID" "$WT")
rc=$?
assert_eq "no package.json → exit 0" "0" "$rc"
assert_eq "no package.json → ok=true" "true" "$(jq -r .ok <<<"$out")"
assert_eq "no package.json → reason" "no-package-json" "$(jq -r .reason <<<"$out")"

echo "=== T2b: package.json without test:mutation → skip pass ==="
WT=$(mktemp -d)
printf '{"scripts":{"test":"vitest"}}' > "$WT/package.json"
RUN_ID="run-t2b"; TASK_ID="t2b"
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID"
printf '{"tasks":{"%s":{}}}' "$TASK_ID" > "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json"
out=$(pipeline-mutation-gate "$RUN_ID" "$TASK_ID" "$WT")
rc=$?
assert_eq "no test:mutation → exit 0" "0" "$rc"
assert_eq "no test:mutation → ok=true" "true" "$(jq -r .ok <<<"$out")"
assert_eq "no test:mutation → reason" "no-script" "$(jq -r .reason <<<"$out")"
state_reason=$(jq -r --arg t "$TASK_ID" '.tasks[$t].mutation_gate.reason' "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json")
assert_eq "no test:mutation → state.mutation_gate.reason" "no-script" "$state_reason"

echo ""
echo "Total: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
