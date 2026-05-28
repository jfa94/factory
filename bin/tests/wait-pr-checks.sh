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

# Mock gh: pr view returns MERGEABLE with statusCheckRollup spliced in from
# $CHECKS_FILE (which now contains just the rollup array). The pr-checks branch
# is gone — the new impl uses a single gh pr view call.
cat > "$MOCK/gh" <<'MOCK'
#!/usr/bin/env bash
# Mock matches the new single-call shape: gh pr view <pr> --json
# state,mergedAt,mergeable,headRefName,statusCheckRollup. CHECKS_FILE now
# contains just the statusCheckRollup array; the wrapper emits the full
# pr-view object with the rollup spliced in.
case "$*" in
  "pr view "*" --json state,mergedAt,mergeable,headRefName,statusCheckRollup")
    rollup=$(cat "$CHECKS_FILE")
    printf '{"state":"OPEN","mergedAt":null,"mergeable":"MERGEABLE","headRefName":"feature","statusCheckRollup":%s}' "$rollup"
    ;;
  *) exit 0 ;;
esac
MOCK
chmod +x "$MOCK/gh"

# --- Case A: CANCELLED conclusion → exit 3 ---
checks_a=$(mktemp)
cat > "$checks_a" <<'JSON'
[{"__typename":"CheckRun","name":"build","status":"COMPLETED","conclusion":"CANCELLED"}]
JSON
set +e
out_a=$(PATH="$MOCK:$PATH" CHECKS_FILE="$checks_a" \
  pipeline-wait-pr 999 --timeout 1 --interval 1 2>&1)
rc_a=$?
set -e
assert_eq "CANCELLED → exit 3" "3" "$rc_a"
assert_contains "CANCELLED reported as build=CANCELLED" "build=CANCELLED" "$out_a"

# --- Case B: TIMED_OUT → exit 3 ---
checks_b=$(mktemp)
cat > "$checks_b" <<'JSON'
[{"__typename":"CheckRun","name":"e2e","status":"COMPLETED","conclusion":"TIMED_OUT"}]
JSON
set +e
out_b=$(PATH="$MOCK:$PATH" CHECKS_FILE="$checks_b" \
  pipeline-wait-pr 999 --timeout 1 --interval 1 2>&1)
rc_b=$?
set -e
assert_eq "TIMED_OUT → exit 3" "3" "$rc_b"
assert_contains "TIMED_OUT reported as e2e=TIMED_OUT" "e2e=TIMED_OUT" "$out_b"

# --- Case C: STARTUP_FAILURE → exit 3 ---
checks_c=$(mktemp)
cat > "$checks_c" <<'JSON'
[{"__typename":"CheckRun","name":"lint","status":"COMPLETED","conclusion":"STARTUP_FAILURE"}]
JSON
set +e
out_c=$(PATH="$MOCK:$PATH" CHECKS_FILE="$checks_c" \
  pipeline-wait-pr 999 --timeout 1 --interval 1 2>&1)
rc_c=$?
set -e
assert_eq "STARTUP_FAILURE → exit 3" "3" "$rc_c"
assert_contains "STARTUP_FAILURE reported as lint=STARTUP_FAILURE" "lint=STARTUP_FAILURE" "$out_c"

# --- Case D: ACTION_REQUIRED → exit 3 ---
checks_d=$(mktemp)
cat > "$checks_d" <<'JSON'
[{"__typename":"CheckRun","name":"deploy","status":"COMPLETED","conclusion":"ACTION_REQUIRED"}]
JSON
set +e
out_d=$(PATH="$MOCK:$PATH" CHECKS_FILE="$checks_d" \
  pipeline-wait-pr 999 --timeout 1 --interval 1 2>&1)
rc_d=$?
set -e
assert_eq "ACTION_REQUIRED → exit 3" "3" "$rc_d"
assert_contains "ACTION_REQUIRED reported as deploy=ACTION_REQUIRED" "deploy=ACTION_REQUIRED" "$out_d"

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
[{"__typename":"CheckRun","name":"unit","status":"COMPLETED","conclusion":"SUCCESS"},{"__typename":"CheckRun","name":"build","status":"COMPLETED","conclusion":"FAILURE"}]
JSON
set +e
out_f=$(PATH="$MOCK:$PATH" CHECKS_FILE="$checks_f" \
  pipeline-wait-pr 999 --timeout 1 --interval 1 2>&1)
rc_f=$?
set -e
assert_eq "FAILURE among mixed → exit 3" "3" "$rc_f"
assert_contains "FAILURE reported as build=FAILURE" "build=FAILURE" "$out_f"

# --- Case G: STALE conclusion → exit 3 ---
checks_g=$(mktemp)
cat > "$checks_g" <<'JSON'
[{"__typename":"CheckRun","name":"required","status":"COMPLETED","conclusion":"STALE"}]
JSON
set +e
out_g=$(PATH="$MOCK:$PATH" CHECKS_FILE="$checks_g" \
  pipeline-wait-pr 999 --timeout 1 --interval 1 2>&1)
rc_g=$?
set -e
assert_eq "STALE → exit 3" "3" "$rc_g"
assert_contains "STALE reported as required=STALE" "required=STALE" "$out_g"

# --- Case H: unrecognized conclusion → exit 3 (fails closed) ---
checks_h=$(mktemp)
cat > "$checks_h" <<'JSON'
[{"__typename":"CheckRun","name":"future","status":"COMPLETED","conclusion":"NEWLY_INVENTED_CONCLUSION"}]
JSON
set +e
out_h=$(PATH="$MOCK:$PATH" CHECKS_FILE="$checks_h" \
  pipeline-wait-pr 999 --timeout 1 --interval 1 2>&1)
rc_h=$?
set -e
assert_eq "unrecognized conclusion → exit 3 (fails closed)" "3" "$rc_h"
assert_contains "unrecognized conclusion reported as future=NEWLY_INVENTED_CONCLUSION" \
  "future=NEWLY_INVENTED_CONCLUSION" "$out_h"
assert_contains "unrecognized conclusion log mentions unrecognized" \
  "unrecognized conclusions" "$out_h"

# ============================================================
echo ""
echo "=== ship-stage ci-fix spawn uses classified per-task model (not reviewer model) ==="
# Locate the executor-ci-fix prompt-file declaration line, then inspect the
# ~25 lines that follow it (which contain the spawn manifest jq block).
BIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
prt_file="$BIN_DIR/pipeline-run-task"
fix_line=$(grep -n '_prompt_path executor-ci-fix' "$prt_file" | head -1 | cut -d: -f1)
if [[ -z "$fix_line" ]]; then
  echo "  FAIL: ship-ci-fix: could not locate executor-ci-fix prompt declaration"
  fail=$((fail + 1))
else
  end_line=$(( fix_line + 25 ))
  block=$(sed -n "${fix_line},${end_line}p" "$prt_file")
  if printf '%s\n' "$block" | grep -q '_reviewer_model'; then
    has_reviewer_model="yes"
  else
    has_reviewer_model="no"
  fi
  if printf '%s\n' "$block" | grep -Eq '_ci_classify|_task_field classify'; then
    has_per_task_model="yes"
  else
    has_per_task_model="no"
  fi
  assert_eq "ship-ci-fix: spawn block does NOT reference _reviewer_model" "no" "$has_reviewer_model"
  assert_eq "ship-ci-fix: spawn block derives per-task model from classify" "yes" "$has_per_task_model"
fi

# ============================================================
echo ""
echo "=== Results ==="
echo "Passed: $pass"
echo "Failed: $fail"
[[ $fail -eq 0 ]]
