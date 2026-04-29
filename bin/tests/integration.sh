#!/usr/bin/env bash
# Integration tests — exercise multiple pipeline-* scripts together with only
# external systems (gh, claude, network) mocked. Plan 12 / tasks
# 12_01..12_04. Run: bash bin/tests/integration.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN_DIR="$REPO_ROOT/bin"
ROOT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/factory-integration.XXXXXX")"
trap '_cleanup' EXIT INT TERM

_cleanup() {
  rm -rf "$ROOT_TMP"
}

export PATH="$BIN_DIR:$PATH"

passed=0
failed=0
current_scenario=""

assert() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    passed=$((passed + 1))
    printf '  PASS  [%s] %s\n' "$current_scenario" "$desc"
  else
    failed=$((failed + 1))
    printf '  FAIL  [%s] %s\n' "$current_scenario" "$desc"
  fi
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    passed=$((passed + 1))
    printf '  PASS  [%s] %s\n' "$current_scenario" "$desc"
  else
    failed=$((failed + 1))
    printf '  FAIL  [%s] %s (expected=%q got=%q)\n' \
      "$current_scenario" "$desc" "$expected" "$actual"
  fi
}

new_scenario() {
  current_scenario="$1"
  local data_dir="$ROOT_TMP/$1-data"
  mkdir -p "$data_dir/runs"
  export CLAUDE_PLUGIN_DATA="$data_dir"
  printf '\n## Scenario: %s\n' "$1"
}

# ---------------------------------------------------------------------------
# task_12_01 — spec handoff end-to-end
# Spec generator writes spec.md + tasks.json into a fixture path, records
# .spec.path on state, then pipeline-build-prompt resolves the spec via state
# and embeds its content. validate-tasks succeeds against the generated file.
# ---------------------------------------------------------------------------
test_spec_handoff() {
  new_scenario "spec-handoff"

  local run_id="run-spec-01"
  pipeline-init "$run_id" --issue 7 --mode prd >/dev/null

  # Spec generator output (mocked claude). Writes a real spec dir under data.
  local spec_dir="$CLAUDE_PLUGIN_DATA/runs/$run_id/spec"
  mkdir -p "$spec_dir"
  cat > "$spec_dir/spec.md" <<'SPEC'
# Generated Spec

This document describes the generated work for run-spec-01.
SPEC
  cat > "$spec_dir/tasks.json" <<'TASKS'
[
  {
    "task_id": "T1",
    "title": "First task",
    "description": "do thing one",
    "files": ["src/a.ts"],
    "acceptance_criteria": ["thing one works"],
    "tests_to_write": ["a.test.ts: thing one"],
    "depends_on": []
  },
  {
    "task_id": "T2",
    "title": "Second task",
    "description": "do thing two",
    "files": ["src/b.ts"],
    "acceptance_criteria": ["thing two works"],
    "tests_to_write": ["b.test.ts: thing two"],
    "depends_on": ["T1"]
  }
]
TASKS

  # Orchestrator records spec path on state. Use string form so writer
  # rejects path-injection but accepts the legitimate filesystem path.
  pipeline-state write "$run_id" .spec.path "$spec_dir" >/dev/null
  pipeline-state write "$run_id" .spec.status ready >/dev/null

  # Round-trip: another script reads the path back via state.
  local resolved_path
  resolved_path=$(pipeline-state read "$run_id" .spec.path)
  assert_eq "spec.path round-trips through state" "$spec_dir" "$resolved_path"
  assert "spec.md exists at resolved spec.path" test -f "$resolved_path/spec.md"
  assert "tasks.json exists at resolved spec.path" test -f "$resolved_path/tasks.json"

  # validate-tasks runs against the file at .spec.path/tasks.json.
  local validate_out
  validate_out=$(pipeline-validate-tasks "$resolved_path/tasks.json")
  assert_eq "validate-tasks reports valid=true" "true" "$(printf '%s' "$validate_out" | jq -r '.valid')"
  assert_eq "validate-tasks reports task_count=2" "2" "$(printf '%s' "$validate_out" | jq -r '.task_count')"
  assert_eq "execution_order has T1 first" "T1" \
    "$(printf '%s' "$validate_out" | jq -r '.execution_order[0].task_id')"

  # task-executor prompt construction must surface the spec content. Pass the
  # spec dir explicitly via --spec-path so we don't rely on cwd-symlink magic.
  local task_json prompt
  task_json=$(jq -n '{
    task_id: "T1",
    title: "First task",
    description: "do thing one",
    files: ["src/a.ts"],
    acceptance_criteria: ["thing one works"],
    tests_to_write: ["a.test.ts: thing one"],
    depends_on: []
  }')
  prompt=$(pipeline-build-prompt "$task_json" --spec-path "$spec_dir" 2>/dev/null)
  assert "prompt references task_id T1" bash -c "printf '%s' \"\$1\" | grep -q 'T1'" _ "$prompt"
  assert "prompt embeds spec content" bash -c "printf '%s' \"\$1\" | grep -q 'Generated Spec'" _ "$prompt"
  # build-prompt resolves spec dir through `cd && pwd`, which on macOS rewrites
  # /var/folders/... → /private/var/folders/... — compare against realpath.
  local spec_dir_real
  spec_dir_real=$(cd "$spec_dir" && pwd)
  assert "prompt names spec location" bash -c "printf '%s' \"\$1\" | grep -qF \"\$2\"" _ "$prompt" "$spec_dir_real"
}

# ---------------------------------------------------------------------------
# task_12_02 — resume after interruption
# Multi-task pipeline: T1 done, T2 interrupted, T3 pending. resume-point must
# return T2 (not T3 — T3 has unmet deps). After T2 completes, resume-point
# returns T3. Final state mirrors a clean run.
# ---------------------------------------------------------------------------
test_resume_after_crash() {
  new_scenario "resume-after-crash"

  local run_id="run-20260102-000002"
  pipeline-init "$run_id" --mode prd >/dev/null

  # Seed a 3-task execution order with the validated topo-sort shape.
  pipeline-state write "$run_id" .execution_order '[
    {"task_id":"T1","parallel_group":0},
    {"task_id":"T2","parallel_group":1},
    {"task_id":"T3","parallel_group":2}
  ]' >/dev/null
  pipeline-state write "$run_id" .tasks '{
    "T1":{"status":"done","depends_on":[]},
    "T2":{"status":"executing","depends_on":["T1"]},
    "T3":{"status":"pending","depends_on":["T2"]}
  }' >/dev/null

  # Simulate crash mid-T2: stop-gate marks task interrupted and run interrupted.
  pipeline-state write "$run_id" .tasks.T2.status interrupted >/dev/null
  pipeline-state write "$run_id" .status interrupted >/dev/null

  assert "run is marked interrupted" pipeline-state interrupted "$run_id"
  assert_eq "T1 status=done after crash" "done" \
    "$(pipeline-state read "$run_id" .tasks.T1.status)"
  assert_eq "T2 status=interrupted after crash" "interrupted" \
    "$(pipeline-state read "$run_id" .tasks.T2.status)"

  local resume
  resume=$(pipeline-state resume-point "$run_id")
  assert_eq "resume-point returns T2 (interrupted task with met deps)" "T2" "$resume"

  # Resume: T2 completes, run continues.
  pipeline-state write "$run_id" .tasks.T2.status done >/dev/null
  pipeline-state write "$run_id" .status running >/dev/null

  resume=$(pipeline-state resume-point "$run_id")
  assert_eq "after T2 done, resume-point is T3" "T3" "$resume"

  # Final clean-run state: all done, no incomplete tasks.
  pipeline-state write "$run_id" .tasks.T3.status done >/dev/null
  set +e
  pipeline-state resume-point "$run_id" >/dev/null 2>&1
  local rc=$?
  set -e
  assert_eq "resume-point exits non-zero when no incomplete tasks remain" "1" "$rc"

  local final_done
  # pipeline-state read enforces an allowlist on the key (task_16_05 / OBS-1),
  # so we fetch full state and pipe through jq for the aggregate query.
  final_done=$(pipeline-state read "$run_id" | jq '[.tasks | to_entries[] | select(.value.status == "done")] | length')
  assert_eq "final state has 3 done tasks" "3" "$final_done"
}

# ---------------------------------------------------------------------------
# task_12_03 — parallel agent spawn
# Two assertions:
#  (a) prompt-build emits N distinct prompts when an orchestrator iterates a
#      parallel group, each carrying its own task_id and content.
#  (b) the underlying spawn primitive (background processes) actually runs
#      concurrently — a 3x parallel sleep finishes in ~one sleep, not 3x.
# Note: a bash test cannot exercise the Claude Code Agent tool directly. OS-
# level parallelism is verified here; full Agent-tool concurrency must still be
# probed inside a real Claude Code session.
# ---------------------------------------------------------------------------
test_parallel_spawn() {
  new_scenario "parallel-spawn"

  local run_id="run-parallel-03"
  pipeline-init "$run_id" --mode prd >/dev/null

  local spec_dir="$CLAUDE_PLUGIN_DATA/runs/$run_id/spec"
  mkdir -p "$spec_dir"
  echo "# Spec for parallel run" > "$spec_dir/spec.md"
  pipeline-state write "$run_id" .spec.path "$spec_dir" >/dev/null

  local p1 p2 p3
  p1=$(pipeline-build-prompt '{
    "task_id":"PT1","title":"alpha","description":"first parallel task",
    "files":["a.ts"],"acceptance_criteria":["a"],"tests_to_write":["t1"],
    "depends_on":[]
  }' --spec-path "$spec_dir" 2>/dev/null)
  p2=$(pipeline-build-prompt '{
    "task_id":"PT2","title":"beta","description":"second parallel task",
    "files":["b.ts"],"acceptance_criteria":["b"],"tests_to_write":["t2"],
    "depends_on":[]
  }' --spec-path "$spec_dir" 2>/dev/null)
  p3=$(pipeline-build-prompt '{
    "task_id":"PT3","title":"gamma","description":"third parallel task",
    "files":["c.ts"],"acceptance_criteria":["c"],"tests_to_write":["t3"],
    "depends_on":[]
  }' --spec-path "$spec_dir" 2>/dev/null)

  assert "prompt 1 mentions PT1" bash -c "printf '%s' \"\$1\" | grep -q 'PT1'" _ "$p1"
  assert "prompt 2 mentions PT2" bash -c "printf '%s' \"\$1\" | grep -q 'PT2'" _ "$p2"
  assert "prompt 3 mentions PT3" bash -c "printf '%s' \"\$1\" | grep -q 'PT3'" _ "$p3"
  assert "prompt 1 differs from prompt 2" test "$p1" != "$p2"
  assert "prompt 2 differs from prompt 3" test "$p2" != "$p3"
  assert "prompt 1 differs from prompt 3" test "$p1" != "$p3"

  # OS-level parallelism check. Spawn three background mocks that each sleep
  # for SLEEP seconds and write a sentinel with start+end timestamps. If they
  # ran sequentially, total wall clock would be ~3*SLEEP; in parallel ~SLEEP.
  local sentinel_dir="$ROOT_TMP/parallel-sentinels"
  mkdir -p "$sentinel_dir"
  local sleep_s=2

  _mock_executor() {
    local id="$1"
    local out="$sentinel_dir/$id.json"
    local started ended
    started=$(date +%s.%N)
    sleep "$sleep_s"
    ended=$(date +%s.%N)
    printf '{"task_id":"%s","started":%s,"ended":%s}\n' "$id" "$started" "$ended" > "$out"
  }
  export -f _mock_executor
  export sleep_s sentinel_dir

  local t0 t1 elapsed_int
  t0=$(date +%s)
  bash -c '_mock_executor PT1' &
  local p_a=$!
  bash -c '_mock_executor PT2' &
  local p_b=$!
  bash -c '_mock_executor PT3' &
  local p_c=$!
  wait "$p_a" "$p_b" "$p_c"
  t1=$(date +%s)
  elapsed_int=$(( t1 - t0 ))

  assert "PT1 sentinel exists" test -f "$sentinel_dir/PT1.json"
  assert "PT2 sentinel exists" test -f "$sentinel_dir/PT2.json"
  assert "PT3 sentinel exists" test -f "$sentinel_dir/PT3.json"

  # 3 * sleep_s = 6s sequential, 1 * sleep_s = 2s parallel. Allow 4s ceiling
  # for filesystem + fork overhead while still failing loudly on a sequential
  # regression.
  if [[ "$elapsed_int" -le 4 ]]; then
    passed=$((passed + 1))
    printf '  PASS  [%s] 3 mock executors finished in %ds (parallel)\n' \
      "$current_scenario" "$elapsed_int"
  else
    failed=$((failed + 1))
    printf '  FAIL  [%s] 3 mock executors took %ds (expected <=4s; sleep=%ds)\n' \
      "$current_scenario" "$elapsed_int" "$sleep_s"
  fi

  # Start-time overlap: every executor's start should be within 1s of the
  # earliest start, i.e. they were dispatched concurrently rather than serialised.
  local min_start max_start spread
  min_start=$(jq -s 'map(.started) | min' "$sentinel_dir"/PT*.json)
  max_start=$(jq -s 'map(.started) | max' "$sentinel_dir"/PT*.json)
  spread=$(awk -v a="$max_start" -v b="$min_start" 'BEGIN { printf "%d", (a - b) }')
  if [[ "$spread" -le 1 ]]; then
    passed=$((passed + 1))
    printf '  PASS  [%s] start-time spread is %ss (within 1s)\n' \
      "$current_scenario" "$spread"
  else
    failed=$((failed + 1))
    printf '  FAIL  [%s] start-time spread is %ss (expected <=1s)\n' \
      "$current_scenario" "$spread"
  fi
}

# ---------------------------------------------------------------------------
# task_12_04 — Statusline wait flow
# Seed usage-cache.json with a 5h-over-threshold value, run pipeline-quota-check,
# then pipeline-model-router. Exercises the full quota-check → router integration
# using the statusline data source.
# ---------------------------------------------------------------------------
test_statusline_wait_flow() {
  new_scenario "statusline-wait-flow"

  # Seed usage-cache.json with utilization 95% and a reset 10 minutes out.
  local now resets_5h_epoch resets_7d_epoch
  now=$(date +%s)
  resets_5h_epoch=$(( now + 600 ))
  resets_7d_epoch=$(( now + 86400 ))

  jq -n \
    --argjson resets_5h "$resets_5h_epoch" \
    --argjson resets_7d "$resets_7d_epoch" \
    --argjson now "$now" \
    '{
      "five_hour": {"used_percentage": 95, "resets_at": $resets_5h},
      "seven_day": {"used_percentage": 10, "resets_at": $resets_7d},
      "captured_at": $now
    }' > "$CLAUDE_PLUGIN_DATA/usage-cache.json"

  local quota
  quota=$(pipeline-quota-check)
  assert_eq "quota detection_method=statusline" "statusline" \
    "$(printf '%s' "$quota" | jq -r '.detection_method')"
  assert_eq "five_hour utilization=95" "95" \
    "$(printf '%s' "$quota" | jq -r '.five_hour.utilization')"
  assert_eq "five_hour over_threshold true" "true" \
    "$(printf '%s' "$quota" | jq -r '.five_hour.over_threshold')"
  assert_eq "seven_day under_threshold" "false" \
    "$(printf '%s' "$quota" | jq -r '.seven_day.over_threshold')"
  assert_eq "resets_at_epoch present" "true" \
    "$(printf '%s' "$quota" | jq -e '.five_hour.resets_at_epoch > 0' >/dev/null 2>&1 && echo true || echo false)"

  # 5h over → router emits action=wait with session-anchored wait_minutes.
  local route_5h_over
  route_5h_over=$(pipeline-model-router --quota "$quota" --tier routine 2>/dev/null)
  assert_eq "5h over → action=wait" "wait" \
    "$(printf '%s' "$route_5h_over" | jq -r '.action')"
  assert_eq "5h over → trigger=5h_over" "5h_over" \
    "$(printf '%s' "$route_5h_over" | jq -r '.trigger')"
  assert_eq "wait_minutes positive" "true" \
    "$(printf '%s' "$route_5h_over" | jq -e '.wait_minutes > 0' >/dev/null 2>&1 && echo true || echo false)"

  # 7d over → router emits action=end_gracefully.
  local quota_7d_over
  quota_7d_over=$(printf '%s' "$quota" | jq '.seven_day.over_threshold = true | .seven_day.utilization = 100')
  local route_7d_over
  route_7d_over=$(pipeline-model-router --quota "$quota_7d_over" --tier feature 2>/dev/null)
  assert_eq "7d over → action=end_gracefully" "end_gracefully" \
    "$(printf '%s' "$route_7d_over" | jq -r '.action')"
  assert_eq "7d over → trigger=7d_over" "7d_over" \
    "$(printf '%s' "$route_7d_over" | jq -r '.trigger')"
}

# ---------------------------------------------------------------------------
# Post-reset stale guard: when Claude Code's last API response carried a
# resets_at that's now in the past (window reset, no new response yet), the
# wrapper writes a "fresh" captured_at over pre-reset rate_limits.
# pipeline-quota-check must treat this as unavailable instead of consuming
# the stale numbers as a valid budget reading.
# ---------------------------------------------------------------------------
test_post_reset_stale_yields_unavailable() {
  new_scenario "post-reset-stale"

  local now past_5h fut_7d
  now=$(date +%s)
  past_5h=$(( now - 120 ))            # 5h reset 2 min in the past
  fut_7d=$(( now + 86400 ))           # 7d still in the future

  # 5h post-reset, 7d in-window.
  jq -n --argjson p "$past_5h" --argjson f "$fut_7d" --argjson n "$now" \
    '{five_hour:{used_percentage:86,resets_at:$p},seven_day:{used_percentage:9,resets_at:$f},captured_at:($n - 30)}' \
    > "$CLAUDE_PLUGIN_DATA/usage-cache.json"

  local quota
  quota=$(pipeline-quota-check 2>/dev/null)
  assert_eq "5h post-reset → detection_method=unavailable" "unavailable" \
    "$(printf '%s' "$quota" | jq -r '.detection_method')"
  assert_eq "5h post-reset → reason=five-hour-window-reset" "five-hour-window-reset" \
    "$(printf '%s' "$quota" | jq -r '.reason')"

  # 7d post-reset, 5h in-window.
  local fut_5h past_7d
  fut_5h=$(( now + 1800 ))
  past_7d=$(( now - 60 ))
  jq -n --argjson f "$fut_5h" --argjson p "$past_7d" --argjson n "$now" \
    '{five_hour:{used_percentage:50,resets_at:$f},seven_day:{used_percentage:50,resets_at:$p},captured_at:($n - 30)}' \
    > "$CLAUDE_PLUGIN_DATA/usage-cache.json"

  quota=$(pipeline-quota-check 2>/dev/null)
  assert_eq "7d post-reset → detection_method=unavailable" "unavailable" \
    "$(printf '%s' "$quota" | jq -r '.detection_method')"
  assert_eq "7d post-reset → reason=seven-day-window-reset" "seven-day-window-reset" \
    "$(printf '%s' "$quota" | jq -r '.reason')"

  # Control: both windows in-window — should NOT trigger the new guard.
  jq -n --argjson f "$fut_5h" --argjson g "$fut_7d" --argjson n "$now" \
    '{five_hour:{used_percentage:50,resets_at:$f},seven_day:{used_percentage:50,resets_at:$g},captured_at:($n - 30)}' \
    > "$CLAUDE_PLUGIN_DATA/usage-cache.json"

  quota=$(pipeline-quota-check 2>/dev/null)
  assert_eq "in-window control → detection_method=statusline" "statusline" \
    "$(printf '%s' "$quota" | jq -r '.detection_method')"
}

# ---------------------------------------------------------------------------
# Statusline wrapper post-reset display: when the input's resets_at is in
# the past, the default emitter must NOT render negative time. Output the
# "window reset pending" sentinel instead.
# ---------------------------------------------------------------------------
test_statusline_wrapper_post_reset_display() {
  new_scenario "statusline-wrapper-post-reset"

  local now past fut out
  now=$(date +%s)
  past=$(( now - 120 ))
  fut=$(( now + 1800 ))

  # Disable user-statusline chain so we exercise _emit_default.
  out=$(FACTORY_ORIGINAL_STATUSLINE="" \
    printf '{"model":{"display_name":"Claude Opus 4.7"},"workspace":{"current_dir":"/tmp/foo"},"rate_limits":{"five_hour":{"used_percentage":86,"resets_at":%d}}}' "$past" \
    | "$BIN_DIR/statusline-wrapper.sh")
  assert_eq "post-reset → reset-pending sentinel" "Claude Opus in foo | window reset pending" "$out"

  out=$(FACTORY_ORIGINAL_STATUSLINE="" \
    printf '{"model":{"display_name":"Claude Opus 4.7"},"workspace":{"current_dir":"/tmp/foo"},"rate_limits":{"five_hour":{"used_percentage":50,"resets_at":%d}}}' "$fut" \
    | "$BIN_DIR/statusline-wrapper.sh")
  assert_eq "in-window → normal % + time output" "Claude Opus in foo | 50% left for 0h 30m" "$out"
}

# ---------------------------------------------------------------------------
# Non-numeric cache fields (AUDIT-1): a malformed usage-cache.json with string
# values where numbers are expected must not crash pipeline-quota-check under
# set -u. The documented contract is fail-closed-with-sentinel (rc=0,
# detection_method=unavailable). Pre-fix, captured_at="abc" tripped
# `unbound variable` and exited 1.
# ---------------------------------------------------------------------------
test_non_numeric_cache_fields_yield_unavailable() {
  new_scenario "non-numeric-cache-fields"

  # captured_at as string: must coerce to 0 → too-stale sentinel, rc=0.
  local quota rc
  jq -n '{five_hour:{used_percentage:50,resets_at:9999999999},seven_day:{used_percentage:9,resets_at:9999999999},captured_at:"abc"}' \
    > "$CLAUDE_PLUGIN_DATA/usage-cache.json"
  set +e
  quota=$(pipeline-quota-check 2>/dev/null); rc=$?
  set -e
  assert_eq "captured_at=string → rc=0" "0" "$rc"
  assert_eq "captured_at=string → detection_method=unavailable" "unavailable" \
    "$(printf '%s' "$quota" | jq -r '.detection_method')"

  # used_percentage as string: must route to malformed sentinel, rc=0.
  local now fut
  now=$(date +%s); fut=$(( now + 1800 ))
  jq -n --argjson n "$now" --argjson f "$fut" \
    '{five_hour:{used_percentage:"oops",resets_at:$f},seven_day:{used_percentage:9,resets_at:$f},captured_at:$n}' \
    > "$CLAUDE_PLUGIN_DATA/usage-cache.json"
  set +e
  quota=$(pipeline-quota-check 2>/dev/null); rc=$?
  set -e
  assert_eq "used_percentage=string → rc=0" "0" "$rc"
  assert_eq "used_percentage=string → detection_method=unavailable" "unavailable" \
    "$(printf '%s' "$quota" | jq -r '.detection_method')"
  assert_eq "used_percentage=string → reason=usage-cache-malformed" "usage-cache-malformed" \
    "$(printf '%s' "$quota" | jq -r '.reason')"

  # resets_at as string: must coerce to default → still emits valid output.
  jq -n --argjson n "$now" \
    '{five_hour:{used_percentage:50,resets_at:"never"},seven_day:{used_percentage:9,resets_at:"never"},captured_at:$n}' \
    > "$CLAUDE_PLUGIN_DATA/usage-cache.json"
  set +e
  quota=$(pipeline-quota-check 2>/dev/null); rc=$?
  set -e
  assert_eq "resets_at=string → rc=0" "0" "$rc"
  # detection_method should be statusline (not crashed), since coerced fallback
  # gives a sensible future epoch.
  assert_eq "resets_at=string → detection_method=statusline" "statusline" \
    "$(printf '%s' "$quota" | jq -r '.detection_method')"
}

# ---------------------------------------------------------------------------
# AUDIT-2: pipeline_quota_gate must not die under set -e when
# pipeline-quota-check or pipeline-model-router crash. The gate must catch
# the failure, log a quota.check action="error" metric, and return rc=2
# (end_gracefully) so callers see a deterministic outcome.
# ---------------------------------------------------------------------------
test_quota_gate_catches_quota_check_crash() {
  new_scenario "quota-gate-crash-safe"

  local stub_dir run_state run_id rc
  stub_dir="$ROOT_TMP/quota-gate-crash-safe-stubs"
  mkdir -p "$stub_dir"

  # Stub pipeline-quota-check to crash unconditionally.
  cat > "$stub_dir/pipeline-quota-check" <<'EOF'
#!/bin/sh
echo "boom: simulated quota-check crash" >&2
exit 1
EOF
  chmod +x "$stub_dir/pipeline-quota-check"

  run_id="quota-crash-$$"
  run_state="$CLAUDE_PLUGIN_DATA/runs/$run_id"
  mkdir -p "$run_state"
  printf '{"circuit_breaker":{"quota_wait_cycles":0,"quota_stale_cycles":0}}' \
    > "$run_state/state.json"

  # Run the gate with the stub PATH-prefixed so it shadows the real script.
  set +e
  PATH="$stub_dir:$PATH" bash -c '
    source "'"$BIN_DIR"'/pipeline-lib.sh"
    pipeline_quota_gate "'"$run_id"'" "feature" "test-boundary" ""
    exit $?
  ' >"$ROOT_TMP/quota-gate-crash.log" 2>&1
  rc=$?
  set -e

  assert_eq "crash-safe gate returns end_gracefully" "2" "$rc"
  assert "log mentions quota-check crash" \
    grep -qE 'pipeline-quota-check crashed' "$ROOT_TMP/quota-gate-crash.log"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
test_spec_handoff
test_resume_after_crash
test_parallel_spawn
test_statusline_wait_flow
test_post_reset_stale_yields_unavailable
test_statusline_wrapper_post_reset_display
test_non_numeric_cache_fields_yield_unavailable
test_quota_gate_catches_quota_check_crash

printf '\n%d passed, %d failed\n' "$passed" "$failed"
exit $(( failed > 0 ? 1 : 0 ))
