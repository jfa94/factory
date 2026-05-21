#!/usr/bin/env bash
# quota-gate-cli.sh — direct CLI surface tests for bin/pipeline-quota-gate-cli.
# The lib-level function pipeline_quota_gate already has wide coverage in
# quota-gate.sh; this suite exercises the CLI wrapper itself: arg parsing,
# JSON envelope shape, --help, and the three exit-code paths
# (0=proceed, 2=end_gracefully, 3=wait_retry).
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

TEST_ROOT=$(mktemp -d)
trap '[[ "$TEST_ROOT" == /tmp/* ]] && rm -rf "$TEST_ROOT"' EXIT
export CLAUDE_PLUGIN_DATA="$TEST_ROOT/plugin-data"
mkdir -p "$CLAUDE_PLUGIN_DATA"

# Fast-path sleep cap so wait branches don't block the suite.
export FACTORY_QUOTA_GATE_SLEEP_CAP_SEC=1

pass=0
fail=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"; pass=$((pass + 1))
  else
    echo "  FAIL: $label (expected '$expected', got '$actual')"; fail=$((fail + 1))
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -q -- "$needle"; then
    echo "  PASS: $label"; pass=$((pass + 1))
  else
    echo "  FAIL: $label (expected '$needle' in output)"; fail=$((fail + 1))
  fi
}

# Per-test scratch: fresh mocks dir on PATH, fresh run state.
_reset_scratch() {
  local run_id="$1"
  MOCKS=$(mktemp -d)
  # Note: PLUGIN_ROOT/bin must come AFTER MOCKS so stubs win, but BEFORE
  # system PATH so we don't pick up stale system binaries.
  export PATH="$MOCKS:$PLUGIN_ROOT/bin:$(echo "$PATH" | sed "s|$MOCKS:||g")"
  rm -rf "$CLAUDE_PLUGIN_DATA/runs/$run_id"
  mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$run_id"
  printf '{"circuit_breaker":{}}' > "$CLAUDE_PLUGIN_DATA/runs/$run_id/state.json"
}

# Stub quota-check + router for the proceed/wait/end paths.
_stub_quota_check() {
  cat > "$MOCKS/pipeline-quota-check" <<STUB
#!/usr/bin/env bash
printf '%s\n' '$1'
STUB
  chmod +x "$MOCKS/pipeline-quota-check"
}

_stub_router() {
  cat > "$MOCKS/pipeline-model-router" <<STUB
#!/usr/bin/env bash
printf '%s\n' '$1'
STUB
  chmod +x "$MOCKS/pipeline-model-router"
}

# ============================================================
echo "=== pipeline-quota-gate-cli: --help ==="

set +e
help_out=$("$PLUGIN_ROOT/bin/pipeline-quota-gate-cli" --help 2>&1)
help_rc=$?
set -e
assert_eq "--help exit 0" "0" "$help_rc"
assert_contains "--help shows Usage section" "Usage:" "$help_out"
assert_contains "--help mentions --run-id" "--run-id" "$help_out"
assert_contains "--help mentions --boundary" "--boundary" "$help_out"
assert_contains "--help lists exit code 0=proceed" "0 = proceed" "$help_out"
assert_contains "--help lists exit code 2=end_gracefully" "2 = end_gracefully" "$help_out"
assert_contains "--help lists exit code 3=wait_retry" "3 = wait_retry" "$help_out"

# ============================================================
echo ""
echo "=== pipeline-quota-gate-cli: required-arg validation ==="

# Missing --run-id should exit 1 with an error.
set +e
out=$("$PLUGIN_ROOT/bin/pipeline-quota-gate-cli" --boundary gate-A 2>&1)
rc=$?
set -e
assert_eq "missing --run-id exit 1" "1" "$rc"
assert_contains "missing --run-id error mentions required" "required" "$out"

# Missing --boundary should exit 1.
set +e
out=$("$PLUGIN_ROOT/bin/pipeline-quota-gate-cli" --run-id run-x 2>&1)
rc=$?
set -e
assert_eq "missing --boundary exit 1" "1" "$rc"

# Unknown flag should exit 1.
set +e
out=$("$PLUGIN_ROOT/bin/pipeline-quota-gate-cli" --bogus 2>&1)
rc=$?
set -e
assert_eq "unknown flag exit 1" "1" "$rc"
assert_contains "unknown flag error message" "unknown flag" "$out"

# ============================================================
echo ""
echo "=== pipeline-quota-gate-cli: happy-path proceed (exit 0) ==="

_reset_scratch run-proceed
_stub_quota_check '{"detection_method":"statusline","five_hour":{"utilization":10,"over_threshold":false},"seven_day":{"utilization":5,"over_threshold":false}}'
_stub_router '{"action":"proceed","provider":"anthropic"}'

set +e
out=$(pipeline-quota-gate-cli --run-id run-proceed --tier feature --boundary gate-A --json 2>/dev/null)
rc=$?
set -e
assert_eq "proceed exit 0" "0" "$rc"
assert_eq "proceed JSON action=proceed" "proceed" "$(printf '%s' "$out" | jq -r '.action')"
assert_eq "proceed JSON rc=0" "0" "$(printf '%s' "$out" | jq -r '.rc')"
assert_eq "proceed JSON boundary echoed" "gate-A" "$(printf '%s' "$out" | jq -r '.boundary')"
assert_eq "proceed JSON tier echoed" "feature" "$(printf '%s' "$out" | jq -r '.tier')"

# ============================================================
echo ""
echo "=== pipeline-quota-gate-cli: wait_retry (exit 3) — stale cache ==="

_reset_scratch run-wait
# unavailable detection_method triggers the stale-yield path in
# pipeline_quota_gate, returning rc=3 without ever calling the router.
_stub_quota_check '{"detection_method":"unavailable","reason":"usage-cache-missing"}'
_stub_router '{"action":"never_called"}'

set +e
out=$(pipeline-quota-gate-cli --run-id run-wait --tier feature --boundary gate-A --json 2>/dev/null)
rc=$?
set -e
assert_eq "wait_retry exit 3" "3" "$rc"
assert_eq "wait_retry JSON action=wait_retry" "wait_retry" "$(printf '%s' "$out" | jq -r '.action')"
assert_eq "wait_retry JSON rc=3" "3" "$(printf '%s' "$out" | jq -r '.rc')"

# ============================================================
echo ""
echo "=== pipeline-quota-gate-cli: end_gracefully (exit 2) — 7d over ==="

_reset_scratch run-end
_stub_quota_check '{"detection_method":"statusline","five_hour":{"utilization":99,"over_threshold":true},"seven_day":{"utilization":99,"over_threshold":true}}'
_stub_router '{"action":"end_gracefully","trigger":"7d_over"}'

set +e
out=$(pipeline-quota-gate-cli --run-id run-end --tier feature --boundary gate-A --json 2>/dev/null)
rc=$?
set -e
assert_eq "end_gracefully exit 2" "2" "$rc"
assert_eq "end_gracefully JSON action=end_gracefully" "end_gracefully" "$(printf '%s' "$out" | jq -r '.action')"
assert_eq "end_gracefully JSON rc=2" "2" "$(printf '%s' "$out" | jq -r '.rc')"

# ============================================================
echo ""
echo "=== pipeline-quota-gate-cli: --task-id propagates to envelope ==="

_reset_scratch run-task
_stub_quota_check '{"detection_method":"statusline","five_hour":{"utilization":10,"over_threshold":false},"seven_day":{"utilization":5,"over_threshold":false}}'
_stub_router '{"action":"proceed","provider":"anthropic"}'

set +e
out=$(pipeline-quota-gate-cli --run-id run-task --tier feature --boundary task-alpha-001 --task-id alpha-001 --json 2>/dev/null)
rc=$?
set -e
assert_eq "task-id exit 0" "0" "$rc"
assert_eq "task-id echoed in JSON" "alpha-001" "$(printf '%s' "$out" | jq -r '.task_id')"
assert_eq "task-id boundary echoed" "task-alpha-001" "$(printf '%s' "$out" | jq -r '.boundary')"

# ============================================================
echo ""
echo "=== Results ==="
echo "  Passed: $pass"
echo "  Failed: $fail"
echo "  Total:  $((pass + fail))"

[[ $fail -eq 0 ]] && exit 0 || exit 1
