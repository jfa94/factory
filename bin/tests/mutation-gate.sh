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

echo ""
echo "Total: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
