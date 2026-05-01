#!/usr/bin/env bash
# wait-pr-checks.sh — pipeline-wait-pr CI red-conditions and empty-check-list
# behaviour. Regression coverage for Task 4.6 of the factory-run-remediation plan.
set -euo pipefail

export CLAUDE_PLUGIN_DATA=$(mktemp -d)
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

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "  PASS: $label"
    pass=$((pass + 1))
  else
    echo "  FAIL: $label (expected to contain '$needle')"
    echo "    haystack: $haystack"
    fail=$((fail + 1))
  fi
}

# ============================================================
echo "=== task_04_06: pipeline-wait-pr broadens CI red conditions ==="

MOCK=$(mktemp -d)
trap 'rm -rf "$MOCK"' EXIT

# Mock gh: pr view always returns MERGEABLE so the loop reaches checks; pr checks
# returns whatever the test wrote to $CHECKS_FILE.
cat > "$MOCK/gh" <<'MOCK'
#!/usr/bin/env bash
case "$*" in
  "pr view "*" --json state,mergedAt,mergeable,headRefName")
    printf '{"state":"OPEN","mergedAt":null,"mergeable":"MERGEABLE","headRefName":"feature"}'
    ;;
  "pr checks "*)
    cat "$CHECKS_FILE"
    ;;
  *) exit 0 ;;
esac
MOCK
chmod +x "$MOCK/gh"

# --- Case A: CANCELLED conclusion → exit 3 (was previously ignored) ---
checks_a=$(mktemp)
cat > "$checks_a" <<'JSON'
[{"name":"build","state":"COMPLETED","conclusion":"CANCELLED"}]
JSON
set +e
out_a=$(PATH="$MOCK:$PATH" CHECKS_FILE="$checks_a" \
  pipeline-wait-pr 999 --timeout 1 --interval 1 2>&1)
rc_a=$?
set -e
assert_eq "CANCELLED conclusion → exit 3" "3" "$rc_a"
assert_contains "CANCELLED reported with name=conclusion" "build=CANCELLED" "$out_a"

# --- Case B: TIMED_OUT → exit 3 ---
checks_b=$(mktemp)
cat > "$checks_b" <<'JSON'
[{"name":"e2e","state":"COMPLETED","conclusion":"TIMED_OUT"}]
JSON
set +e
out_b=$(PATH="$MOCK:$PATH" CHECKS_FILE="$checks_b" \
  pipeline-wait-pr 999 --timeout 1 --interval 1 2>&1)
rc_b=$?
set -e
assert_eq "TIMED_OUT conclusion → exit 3" "3" "$rc_b"
assert_contains "TIMED_OUT reported with name=conclusion" "e2e=TIMED_OUT" "$out_b"

# --- Case C: STARTUP_FAILURE → exit 3 ---
checks_c=$(mktemp)
cat > "$checks_c" <<'JSON'
[{"name":"lint","state":"COMPLETED","conclusion":"STARTUP_FAILURE"}]
JSON
set +e
out_c=$(PATH="$MOCK:$PATH" CHECKS_FILE="$checks_c" \
  pipeline-wait-pr 999 --timeout 1 --interval 1 2>&1)
rc_c=$?
set -e
assert_eq "STARTUP_FAILURE conclusion → exit 3" "3" "$rc_c"

# --- Case D: ACTION_REQUIRED → exit 3 ---
checks_d=$(mktemp)
cat > "$checks_d" <<'JSON'
[{"name":"deploy","state":"COMPLETED","conclusion":"ACTION_REQUIRED"}]
JSON
set +e
out_d=$(PATH="$MOCK:$PATH" CHECKS_FILE="$checks_d" \
  pipeline-wait-pr 999 --timeout 1 --interval 1 2>&1)
rc_d=$?
set -e
assert_eq "ACTION_REQUIRED conclusion → exit 3" "3" "$rc_d"

# --- Case E: empty checks list → no "all checks passed" log; defer to merge ---
checks_e=$(mktemp)
printf '[]\n' > "$checks_e"
set +e
out_e=$(PATH="$MOCK:$PATH" CHECKS_FILE="$checks_e" \
  pipeline-wait-pr 999 --timeout 1 --interval 1 2>&1)
rc_e=$?
set -e
# Times out (exit 1) because PR never merges in mock; we want the empty-check log.
assert_eq "empty checks list does not exit 3" "1" "$rc_e"
assert_contains "empty checks logs deferral" "no checks defined" "$out_e"

# --- Case F: mixed checks with at least one SUCCESS and one FAILURE → exit 3 ---
checks_f=$(mktemp)
cat > "$checks_f" <<'JSON'
[{"name":"unit","state":"COMPLETED","conclusion":"SUCCESS"},{"name":"build","state":"COMPLETED","conclusion":"FAILURE"}]
JSON
set +e
out_f=$(PATH="$MOCK:$PATH" CHECKS_FILE="$checks_f" \
  pipeline-wait-pr 999 --timeout 1 --interval 1 2>&1)
rc_f=$?
set -e
assert_eq "FAILURE among mixed → exit 3" "3" "$rc_f"
assert_contains "FAILURE reported with name=conclusion" "build=FAILURE" "$out_f"

# ============================================================
echo ""
echo "=== Results ==="
echo "Passed: $pass"
echo "Failed: $fail"
[[ $fail -eq 0 ]]
