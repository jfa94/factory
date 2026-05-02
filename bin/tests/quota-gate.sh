#!/usr/bin/env bash
# quota-gate.sh — pipeline_quota_gate (pipeline-lib.sh) behavior across
# proceed / wait_retry / end_gracefully outcomes, stuck-cache guard, and
# pause_minutes accounting.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$PLUGIN_ROOT/bin:$PATH"

# Isolated plugin data dir (real pipeline-state will use this).
TEST_ROOT=$(mktemp -d)
trap '[[ "$TEST_ROOT" == /tmp/* ]] && rm -rf "$TEST_ROOT"' EXIT
export CLAUDE_PLUGIN_DATA="$TEST_ROOT/plugin-data"
mkdir -p "$CLAUDE_PLUGIN_DATA"

# Fast-path sleep cap (1s) so wait-branch tests don't block.
export FACTORY_QUOTA_GATE_SLEEP_CAP_SEC=1

source "$PLUGIN_ROOT/bin/pipeline-lib.sh"

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

# Per-test scratch: fresh mocks dir on PATH, fresh run dir.
_reset_scratch() {
  local run_id="$1"
  MOCKS=$(mktemp -d)
  export PATH="$MOCKS:$PLUGIN_ROOT/bin:$(echo "$PATH" | sed "s|$MOCKS:||g")"
  rm -rf "$CLAUDE_PLUGIN_DATA/runs/$run_id"
  mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$run_id"
  printf '{"circuit_breaker":{}}' > "$CLAUDE_PLUGIN_DATA/runs/$run_id/state.json"
}

# Stub quota-check: returns pre-canned fixture for N calls. Args: <fixture-json>...
_stub_quota_check_sequence() {
  local i=1
  for fixture in "$@"; do
    printf '%s\n' "$fixture" > "$MOCKS/_quota_fixture_$i"
    i=$(( i + 1 ))
  done
  cat > "$MOCKS/pipeline-quota-check" <<'STUB'
#!/usr/bin/env bash
mocks_dir="$(dirname "$0")"
counter_file="$mocks_dir/_quota_counter"
n=$(cat "$counter_file" 2>/dev/null || echo 0)
n=$(( n + 1 ))
echo "$n" > "$counter_file"
cat "$mocks_dir/_quota_fixture_$n"
STUB
  chmod +x "$MOCKS/pipeline-quota-check"
  : > "$MOCKS/_quota_counter"
}

# Stub model-router: returns pre-canned fixture for N calls.
_stub_router_sequence() {
  local i=1
  for fixture in "$@"; do
    printf '%s\n' "$fixture" > "$MOCKS/_router_fixture_$i"
    i=$(( i + 1 ))
  done
  cat > "$MOCKS/pipeline-model-router" <<'STUB'
#!/usr/bin/env bash
mocks_dir="$(dirname "$0")"
counter_file="$mocks_dir/_router_counter"
n=$(cat "$counter_file" 2>/dev/null || echo 0)
n=$(( n + 1 ))
echo "$n" > "$counter_file"
cat "$mocks_dir/_router_fixture_$n"
STUB
  chmod +x "$MOCKS/pipeline-model-router"
  : > "$MOCKS/_router_counter"
}

# ============================================================
echo "=== pipeline_quota_gate: proceed ==="

_reset_scratch run-1
_stub_quota_check_sequence '{"detection_method":"statusline"}'
_stub_router_sequence '{"action":"proceed","provider":"anthropic"}'
# Pre-set wait cycles to verify reset-on-proceed.
pipeline-state write run-1 '.circuit_breaker.quota_wait_cycles' '5' >/dev/null
set +e; pipeline_quota_gate run-1 feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "proceed → exit 0" "0" "$rc"
cycles=$(pipeline-state read run-1 '.circuit_breaker.quota_wait_cycles' 2>/dev/null)
assert_eq "proceed resets quota_wait_cycles to 0" "0" "$cycles"

# ============================================================
echo ""
echo "=== pipeline_quota_gate: unavailable cache yields stale (exit 3) on first hit ==="

_reset_scratch run-2
_stub_quota_check_sequence '{"detection_method":"unavailable","reason":"usage-cache-missing"}'
# Router should NOT be called when detection_method=unavailable; gate yields earlier.
_stub_router_sequence '{"action":"never_called"}'
set +e; pipeline_quota_gate run-2 feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "stale yield → exit 3" "3" "$rc"
stale=$(pipeline-state read run-2 '.circuit_breaker.quota_stale_cycles' 2>/dev/null)
assert_eq "quota_stale_cycles incremented" "1" "$stale"

# ============================================================
echo ""
echo "=== pipeline_quota_gate: end_gracefully direct (router-emitted) ==="

_reset_scratch run-2b
_stub_quota_check_sequence '{"detection_method":"statusline","five_hour":{"utilization":99,"over_threshold":true},"seven_day":{"utilization":99,"over_threshold":true}}'
_stub_router_sequence '{"action":"end_gracefully","trigger":"7d_over"}'
set +e; pipeline_quota_gate run-2b feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "router end_gracefully → exit 2" "2" "$rc"

# ============================================================
echo ""
echo "=== pipeline_quota_gate: stale-cycle cap ==="

_reset_scratch run-2c
export FACTORY_QUOTA_GATE_MAX_STALE_CYCLES=2
pipeline-state write run-2c '.circuit_breaker.quota_stale_cycles' '2' >/dev/null
_stub_quota_check_sequence '{"never":"called"}'
_stub_router_sequence '{"action":"never"}'
set +e; pipeline_quota_gate run-2c feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "stale_cycles==cap → exit 2" "2" "$rc"
unset FACTORY_QUOTA_GATE_MAX_STALE_CYCLES

# ============================================================
# Real-script regressions (F1): exercise the gate against the actual
# pipeline-quota-check / pipeline-model-router on PATH so stderr-side
# log_warn is exercised alongside the stdout JSON contract. Stub-only
# tests above can't catch a 2>&1 contamination of the cmdsubst capture.
# ============================================================
echo ""
echo "=== pipeline_quota_gate: real script + missing cache → wait_retry ==="

_reset_scratch run-real-unavailable
# Do NOT install a pipeline-quota-check stub; PATH falls through to the
# real bin/pipeline-quota-check which emits a sentinel + log_warn.
rm -f "$CLAUDE_PLUGIN_DATA/usage-cache.json"
# Capture-style router stub: touches a sentinel file iff invoked, returns
# proceed (so a buggy gate that falls through to the router would log a
# false-secure success rather than crash).
cat > "$MOCKS/pipeline-model-router" <<'STUB'
#!/usr/bin/env bash
mocks_dir="$(dirname "$0")"
touch "$mocks_dir/_router_called"
printf '{"action":"proceed","provider":"anthropic"}'
STUB
chmod +x "$MOCKS/pipeline-model-router"

set +e; pipeline_quota_gate run-real-unavailable feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "real-script unavailable → exit 3 (wait_retry)" "3" "$rc"
router_called="false"; [[ -f "$MOCKS/_router_called" ]] && router_called="true"
assert_eq "real-script unavailable → router NOT called" "false" "$router_called"
stale=$(pipeline-state read run-real-unavailable '.circuit_breaker.quota_stale_cycles' 2>/dev/null)
assert_eq "real-script unavailable → quota_stale_cycles=1" "1" "$stale"

# ============================================================
echo ""
echo "=== pipeline_quota_gate: real script + 121s-stale-but-valid → router gets clean JSON ==="

_reset_scratch run-real-stale-warn
# 121s-stale fixture: triggers the >120s log_warn in pipeline-quota-check
# while still emitting a valid statusline JSON on stdout. With the F1 bug,
# 2>&1 capture taints the cmdsubst result and the router receives garbage.
now=$(date +%s)
jq -n --argjson n "$now" \
  '{five_hour:{used_percentage:30,resets_at:($n + 1800)},
    seven_day:{used_percentage:5,resets_at:($n + 86400)},
    captured_at:($n - 121)}' \
  > "$CLAUDE_PLUGIN_DATA/usage-cache.json"

# Capture-style router stub: persists --quota argument for inspection.
cat > "$MOCKS/pipeline-model-router" <<'STUB'
#!/usr/bin/env bash
mocks_dir="$(dirname "$0")"
quota=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quota) quota="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$quota" > "$mocks_dir/_router_quota_arg"
printf '{"action":"proceed","provider":"anthropic"}'
STUB
chmod +x "$MOCKS/pipeline-model-router"

set +e; pipeline_quota_gate run-real-stale-warn feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "real-script 121s-stale → exit 0" "0" "$rc"
router_quota=$(cat "$MOCKS/_router_quota_arg" 2>/dev/null || printf '')
det=$(printf '%s' "$router_quota" | jq -r '.detection_method' 2>/dev/null || printf '')
assert_eq "router received clean JSON (detection_method=statusline)" "statusline" "$det"

# ============================================================
echo ""
echo "=== pipeline-quota-check: missing resets_at → unavailable sentinel (Task 4.5) ==="

_reset_scratch run-resets-missing
now=$(date +%s)
# Cache with valid percents but resets_at fields absent.
jq -n --argjson n "$now" \
  '{five_hour:{used_percentage:30},
    seven_day:{used_percentage:5},
    captured_at:$n}' \
  > "$CLAUDE_PLUGIN_DATA/usage-cache.json"
out=$(pipeline-quota-check 2>/dev/null)
det=$(printf '%s' "$out" | jq -r '.detection_method // ""')
reason=$(printf '%s' "$out" | jq -r '.reason // ""')
assert_eq "missing resets_at: detection_method=unavailable" "unavailable" "$det"
assert_eq "missing resets_at: reason=resets-at-missing" "resets-at-missing" "$reason"

# Non-numeric resets_at (e.g., string) hits the same sentinel path.
_reset_scratch run-resets-nonnumeric
jq -n --argjson n "$now" \
  '{five_hour:{used_percentage:30,resets_at:"not-a-number"},
    seven_day:{used_percentage:5,resets_at:($n + 86400)},
    captured_at:$n}' \
  > "$CLAUDE_PLUGIN_DATA/usage-cache.json"
out=$(pipeline-quota-check 2>/dev/null)
det=$(printf '%s' "$out" | jq -r '.detection_method // ""')
assert_eq "non-numeric resets_at: detection_method=unavailable" "unavailable" "$det"

# ============================================================
echo ""
echo "=== pipeline_quota_gate: proceed resets stale_cycles ==="

_reset_scratch run-2d
pipeline-state write run-2d '.circuit_breaker.quota_stale_cycles' '3' >/dev/null
_stub_quota_check_sequence '{"detection_method":"statusline"}'
_stub_router_sequence '{"action":"proceed","provider":"anthropic"}'
set +e; pipeline_quota_gate run-2d feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "proceed-after-stale → exit 0" "0" "$rc"
stale=$(pipeline-state read run-2d '.circuit_breaker.quota_stale_cycles' 2>/dev/null)
assert_eq "proceed resets quota_stale_cycles" "0" "$stale"

# ============================================================
echo ""
echo "=== pipeline_quota_gate: wait then proceed ==="

_reset_scratch run-3
_stub_quota_check_sequence '{"first":1}' '{"second":1}'
_stub_router_sequence \
  '{"action":"wait","wait_minutes":1,"trigger":"5h_over"}' \
  '{"action":"proceed"}'
set +e; pipeline_quota_gate run-3 feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "wait→proceed → exit 0" "0" "$rc"
# Sleep cap is 1s; slept_min = ceil(1/60) = 1
pause=$(pipeline-state read run-3 '.circuit_breaker.pause_minutes_total' 2>/dev/null)
assert_eq "pause_minutes_total recorded" "1" "$pause"
cycles=$(pipeline-state read run-3 '.circuit_breaker.quota_wait_cycles' 2>/dev/null)
assert_eq "proceed-after-wait resets quota_wait_cycles" "0" "$cycles"

# ============================================================
echo ""
echo "=== pipeline_quota_gate: wait then still wait → yield (exit 3) ==="

_reset_scratch run-4
_stub_quota_check_sequence '{"first":1}' '{"second":1}'
_stub_router_sequence \
  '{"action":"wait","wait_minutes":1,"trigger":"5h_over"}' \
  '{"action":"wait","wait_minutes":60,"trigger":"5h_over"}'
set +e; pipeline_quota_gate run-4 feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "wait→wait → exit 3 (wait_retry)" "3" "$rc"
cycles=$(pipeline-state read run-4 '.circuit_breaker.quota_wait_cycles' 2>/dev/null)
assert_eq "quota_wait_cycles incremented on yield" "1" "$cycles"

# ============================================================
echo ""
echo "=== pipeline_quota_gate: stuck-cache cap ==="

_reset_scratch run-5
export FACTORY_QUOTA_GATE_MAX_CYCLES=3
pipeline-state write run-5 '.circuit_breaker.quota_wait_cycles' '3' >/dev/null
# Stubs shouldn't even get called — cap checked first.
_stub_quota_check_sequence '{"never":"called"}'
_stub_router_sequence '{"action":"proceed"}'
set +e; pipeline_quota_gate run-5 feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "cycles==cap → exit 2" "2" "$rc"
unset FACTORY_QUOTA_GATE_MAX_CYCLES

# ============================================================
echo ""
echo "=== pipeline_quota_gate: wait with no wait_minutes ==="

_reset_scratch run-6
_stub_quota_check_sequence '{"first":1}'
_stub_router_sequence '{"action":"wait","trigger":"5h_over"}'
set +e; pipeline_quota_gate run-6 feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "wait with no wait_minutes → exit 2" "2" "$rc"

# ============================================================
echo ""
echo "=== pipeline_quota_gate: empty run_id ==="

_reset_scratch run-7
set +e; pipeline_quota_gate "" feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "empty run_id → exit 2" "2" "$rc"

# ============================================================
echo ""
echo "=== compute_hourly_threshold / compute_daily_threshold: config override ==="

mkdir -p "$CLAUDE_PLUGIN_DATA"
cat > "$CLAUDE_PLUGIN_DATA/config.json" <<'JSON'
{ "quota": {
    "hourlyThresholds": [10, 20, 30, 40, 50],
    "dailyThresholds":  [5, 10, 20, 30, 40, 60, 80]
} }
JSON
assert_eq "hourly override h1=10" "10" "$(compute_hourly_threshold 1)"
assert_eq "hourly override h5=50" "50" "$(compute_hourly_threshold 5)"
assert_eq "daily override d1=5"   "5"  "$(compute_daily_threshold 1)"
assert_eq "daily override d7=80"  "80" "$(compute_daily_threshold 7)"
rm -f "$CLAUDE_PLUGIN_DATA/config.json"
# Defaults restored when config absent
assert_eq "hourly default h1=20"  "20" "$(compute_hourly_threshold 1)"
assert_eq "daily default d4=57"   "57" "$(compute_daily_threshold 4)"

# ============================================================
echo ""
echo "=== pipeline_quota_gate: unknown router action ==="

_reset_scratch run-8
_stub_quota_check_sequence '{"detection_method":"statusline"}'
_stub_router_sequence '{"action":"whatever"}'
set +e; pipeline_quota_gate run-8 feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "unknown action → exit 2" "2" "$rc"

# ============================================================
echo ""
echo "=== pipeline_quota_gate: pause_minutes_total audit + consecutive budget split ==="

# wait→proceed: total accumulates, consecutive resets
_reset_scratch run-split-1
_stub_quota_check_sequence '{"detection_method":"statusline","one":1}' '{"detection_method":"statusline","two":2}'
_stub_router_sequence \
  '{"action":"wait","wait_minutes":1,"trigger":"5h_over","milestone":"hour_2"}' \
  '{"action":"proceed","provider":"anthropic"}'
set +e; pipeline_quota_gate run-split-1 feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "split: wait→proceed → exit 0" "0" "$rc"
total=$(pipeline-state read run-split-1 '.circuit_breaker.pause_minutes_total' 2>/dev/null)
assert_eq "split: pause_minutes_total accumulated" "1" "$total"
consec=$(pipeline-state read run-split-1 '.circuit_breaker.pause_minutes_consecutive' 2>/dev/null)
assert_eq "split: pause_minutes_consecutive reset to 0 on proceed" "0" "$consec"
# Legacy field absent after migration
legacy=$(pipeline-state read run-split-1 '.circuit_breaker.pause_minutes' 2>/dev/null || printf 'null')
assert_eq "split: legacy pause_minutes absent" "null" "$legacy"

# wall-budget uses consecutive, not total
_reset_scratch run-split-budget
# Pre-seed total=120 (way over old 30-min budget) but consecutive=5 (well under 75)
printf '{"circuit_breaker":{"pause_minutes_total":120,"pause_minutes_consecutive":5}}' \
  > "$CLAUDE_PLUGIN_DATA/runs/run-split-budget/state.json"
export FACTORY_QUOTA_WALL_BUDGET_MIN=75
_stub_quota_check_sequence '{"detection_method":"statusline"}' '{"detection_method":"statusline"}'
_stub_router_sequence \
  '{"action":"wait","wait_minutes":1,"trigger":"5h_over","milestone":"hour_2"}' \
  '{"action":"proceed","provider":"anthropic"}'
set +e; pipeline_quota_gate run-split-budget feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "split: large total but small consec → proceeds (not halted)" "0" "$rc"
unset FACTORY_QUOTA_WALL_BUDGET_MIN

# wall-budget fires on consecutive when it exceeds budget
_reset_scratch run-split-consec-cap
printf '{"circuit_breaker":{"pause_minutes_total":80,"pause_minutes_consecutive":80}}' \
  > "$CLAUDE_PLUGIN_DATA/runs/run-split-consec-cap/state.json"
export FACTORY_QUOTA_WALL_BUDGET_MIN=75
_stub_quota_check_sequence '{"detection_method":"statusline"}'
_stub_router_sequence '{"action":"wait","wait_minutes":1,"trigger":"5h_over","milestone":"hour_2"}'
set +e; pipeline_quota_gate run-split-consec-cap feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "split: consecutive≥budget → halt (exit 2)" "2" "$rc"
unset FACTORY_QUOTA_WALL_BUDGET_MIN

# ============================================================
echo ""
echo "=== pipeline_quota_gate: state migration (legacy pause_minutes → split) ==="

_reset_scratch run-migrate
# Old-schema state: pause_minutes present, no total/consecutive fields.
printf '{"circuit_breaker":{"pause_minutes":42}}' \
  > "$CLAUDE_PLUGIN_DATA/runs/run-migrate/state.json"
_stub_quota_check_sequence '{"detection_method":"statusline"}'
_stub_router_sequence '{"action":"proceed","provider":"anthropic"}'
set +e; pipeline_quota_gate run-migrate feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "migrate: gate proceeds with legacy state" "0" "$rc"
total=$(pipeline-state read run-migrate '.circuit_breaker.pause_minutes_total' 2>/dev/null)
assert_eq "migrate: pause_minutes_total=42 (from legacy)" "42" "$total"
consec=$(pipeline-state read run-migrate '.circuit_breaker.pause_minutes_consecutive' 2>/dev/null)
assert_eq "migrate: pause_minutes_consecutive=0 (fresh)" "0" "$consec"
legacy=$(pipeline-state read run-migrate '.circuit_breaker.pause_minutes' 2>/dev/null || printf 'null')
assert_eq "migrate: legacy pause_minutes removed" "null" "$legacy"

# ============================================================
echo ""
echo "=== pipeline-model-router: milestone-based wait_minutes ==="
_reset_scratch run-router-milestone

now=$(date +%s)

# Hour 2 of window (≈200 min remaining, current_hour=2 since 1h elapsed)
# window_start = resets_at - 18000; elapsed = 1h + 1min = 3660s → hour=2
resets_at=$(( now + 18000 - 3660 ))   # window_start = now - 3660; resets_at = window_start + 18000
quota_h2=$(jq -n \
  --argjson five_over true \
  --argjson seven_over false \
  --argjson resets "$resets_at" \
  '{detection_method:"statusline",
    five_hour:{utilization:30,over_threshold:$five_over,window_hour:2,resets_at_epoch:$resets},
    seven_day:{utilization:10,over_threshold:$seven_over}}')
route=$(pipeline-model-router --quota "$quota_h2" --tier feature 2>/dev/null)
action=$(printf '%s' "$route" | jq -r '.action')
assert_eq "router h2: action=wait" "wait" "$action"
wait_min=$(printf '%s' "$route" | jq -r '.wait_minutes')
assert_eq "router h2: wait_minutes≤60" "1" "$(( wait_min <= 60 ? 1 : 0 ))"
assert_eq "router h2: wait_minutes≥1" "1" "$(( wait_min >= 1 ? 1 : 0 ))"
milestone=$(printf '%s' "$route" | jq -r '.milestone // ""')
assert_eq "router h2: milestone=hour_3" "hour_3" "$milestone"

# Hour 5 (last hour, no further curve step) → wait with milestone=window_reset
# elapsed = 4h + 1min = 14460s → hour=5
resets_at_h5=$(( now + 18000 - 14460 ))
quota_h5=$(jq -n \
  --argjson five_over true \
  --argjson seven_over false \
  --argjson resets "$resets_at_h5" \
  '{detection_method:"statusline",
    five_hour:{utilization:92,over_threshold:$five_over,window_hour:5,resets_at_epoch:$resets},
    seven_day:{utilization:10,over_threshold:$seven_over}}')
route_h5=$(pipeline-model-router --quota "$quota_h5" --tier feature 2>/dev/null)
action_h5=$(printf '%s' "$route_h5" | jq -r '.action')
assert_eq "router h5: action=wait" "wait" "$action_h5"
milestone_h5=$(printf '%s' "$route_h5" | jq -r '.milestone // ""')
assert_eq "router h5: milestone=window_reset" "window_reset" "$milestone_h5"

# ============================================================
echo ""
echo "=== pipeline_quota_gate: default wallBudgetMin = 75 ==="

_reset_scratch run-budget-default
# 74 consecutive minutes → should NOT halt (74 < 75)
printf '{"circuit_breaker":{"pause_minutes_total":74,"pause_minutes_consecutive":74}}' \
  > "$CLAUDE_PLUGIN_DATA/runs/run-budget-default/state.json"
_stub_quota_check_sequence '{"detection_method":"statusline"}' '{"detection_method":"statusline"}'
_stub_router_sequence \
  '{"action":"wait","wait_minutes":1,"trigger":"5h_over","milestone":"hour_2"}' \
  '{"action":"proceed","provider":"anthropic"}'
set +e; pipeline_quota_gate run-budget-default feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "default budget: 74 consec min → can still sleep" "0" "$rc"

# 75 consecutive minutes → HALT (75 >= 75)
_reset_scratch run-budget-default-over
printf '{"circuit_breaker":{"pause_minutes_total":75,"pause_minutes_consecutive":75}}' \
  > "$CLAUDE_PLUGIN_DATA/runs/run-budget-default-over/state.json"
_stub_quota_check_sequence '{"detection_method":"statusline"}'
_stub_router_sequence '{"action":"wait","wait_minutes":1,"trigger":"5h_over","milestone":"hour_2"}'
set +e; pipeline_quota_gate run-budget-default-over feature gate-A >/dev/null 2>&1; rc=$?; set -e
assert_eq "default budget: 75 consec min → halt (exit 2)" "2" "$rc"

# ============================================================
echo ""
echo "=== Results ==="
echo "  Passed: $pass"
echo "  Failed: $fail"
echo "  Total:  $((pass + fail))"

[[ $fail -eq 0 ]] && exit 0 || exit 1
