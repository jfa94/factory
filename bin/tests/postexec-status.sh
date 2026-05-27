#!/usr/bin/env bash
# postexec-status.sh — every terminal `return 30` in _stage_postexec and
# _stage_postreview must write task-status=failed before returning, otherwise
# finalize-run group-completion blocks forever.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN_DIR="$REPO_ROOT/bin"
ROOT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/factory-postexec-status.XXXXXX")"
STUB_DIR="$ROOT_TMP/stubs"
mkdir -p "$STUB_DIR"
trap 'rm -rf "$ROOT_TMP"' EXIT INT TERM

export PATH="$STUB_DIR:$BIN_DIR:$PATH"

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

write_stub() {
  local name="$1"; shift
  printf '#!/usr/bin/env bash\n%s\n' "$*" > "$STUB_DIR/$name"
  chmod +x "$STUB_DIR/$name"
}

# Quota-check stub: usage well below threshold so quota gates always proceed.
write_stub pipeline-quota-check 'cat <<EOF
{"detection_method":"stub",
 "five_hour":{"utilization":10,"over_threshold":false,"resets_at_epoch":0},
 "seven_day":{"utilization":5,"over_threshold":false,"resets_at_epoch":0}}
EOF'

# Default gate stubs: pass. Individual cases override below.
write_stub pipeline-security-gate 'exit 0'
write_stub pipeline-tdd-gate      'exit 0'
write_stub pipeline-coverage-gate 'exit 0'
write_stub pipeline-holdout-validate 'exit 0'

new_run() {
  local label="$1"
  local data="$ROOT_TMP/$label"
  mkdir -p "$data/runs"
  export CLAUDE_PLUGIN_DATA="$data"
  RUN_ID="run-postexec-$label"
  pipeline-init "$RUN_ID" --issue 99 --mode prd >/dev/null
  pipeline-state write "$RUN_ID" .tasks '{
    "alpha-001":{"task_id":"alpha-001","title":"t","description":"d",
      "files":["src/a.ts"],"acceptance_criteria":["ok"],
      "tests_to_write":["t"],"depends_on":[],"status":"pending"}
  }' >/dev/null
  local wt="$ROOT_TMP/$label-wt"
  mkdir -p "$wt"
  pipeline-state task-write "$RUN_ID" alpha-001 worktree "\"$wt\"" >/dev/null
  pipeline-state task-write "$RUN_ID" alpha-001 stage '"preexec_tests_done"' >/dev/null
  pipeline-state task-status "$RUN_ID" alpha-001 executing >/dev/null
  printf '%s' "$wt"
}

status_of() { pipeline-state read "$RUN_ID" .tasks.alpha-001.status 2>/dev/null; }

# ----------------------------------------------------------------------------
echo "=== postexec quality-gate fail writes status=failed ==="
new_run quality-fail >/dev/null
write_stub pipeline-quality-gate 'exit 1'

set +e
pipeline-run-task "$RUN_ID" alpha-001 --stage postexec >/dev/null 2>&1
rc=$?
set -e

assert_eq "quality-gate fail: rc=30" "30" "$rc"
assert_eq "quality-gate fail: status=failed" "failed" "$(status_of)"

# ----------------------------------------------------------------------------
echo ""
echo "=== postexec tdd-gate fail writes status=failed ==="
new_run tdd-fail >/dev/null
write_stub pipeline-quality-gate 'exit 0'
write_stub pipeline-tdd-gate     'exit 1'

set +e
pipeline-run-task "$RUN_ID" alpha-001 --stage postexec >/dev/null 2>&1
rc=$?
set -e

assert_eq "tdd-gate fail: rc=30" "30" "$rc"
assert_eq "tdd-gate fail: status=failed" "failed" "$(status_of)"

# ----------------------------------------------------------------------------
echo ""
echo "=== postexec missing-worktree writes status=failed ==="
new_run no-wt >/dev/null
pipeline-state task-write "$RUN_ID" alpha-001 worktree 'null' >/dev/null
write_stub pipeline-quality-gate 'exit 0'
write_stub pipeline-tdd-gate     'exit 0'

set +e
pipeline-run-task "$RUN_ID" alpha-001 --stage postexec >/dev/null 2>&1
rc=$?
set -e

assert_eq "missing-worktree: rc=30" "30" "$rc"
assert_eq "missing-worktree: status=failed" "failed" "$(status_of)"

# ----------------------------------------------------------------------------
echo ""
echo "=== postreview-fix spawn uses classified per-task model (not reviewer model) ==="
# Locate the executor-fix prompt-file declaration line, then inspect the
# ~20 lines that follow it (which contain the spawn manifest jq block).
prt_file="$BIN_DIR/pipeline-run-task"
fix_line=$(grep -n '_prompt_path executor-fix' "$prt_file" | head -1 | cut -d: -f1)
if [[ -z "$fix_line" ]]; then
  echo "  FAIL: postreview-fix: could not locate executor-fix prompt declaration"
  fail=$((fail + 1))
else
  end_line=$(( fix_line + 25 ))
  block=$(sed -n "${fix_line},${end_line}p" "$prt_file")
  if printf '%s\n' "$block" | grep -q '_reviewer_model'; then
    has_reviewer_model="yes"
  else
    has_reviewer_model="no"
  fi
  if printf '%s\n' "$block" | grep -Eq '_pr_classify|_task_field classify'; then
    has_per_task_model="yes"
  else
    has_per_task_model="no"
  fi
  assert_eq "postreview-fix: spawn block does NOT reference _reviewer_model" "no" "$has_reviewer_model"
  assert_eq "postreview-fix: spawn block derives per-task model from classify" "yes" "$has_per_task_model"
fi

echo ""
echo "=== red-test verification: _verify_red_tests does NOT swallow git errors with || true ==="
PIPELINE_RUN_TASK="$BIN_DIR/pipeline-run-task"
# Locate the _verify_red_tests function and inspect a window for the git diff call.
verify_line=$(grep -n '^_verify_red_tests()' "$PIPELINE_RUN_TASK" | head -1 | cut -d: -f1)
if [[ -z "$verify_line" ]]; then
  echo "  FAIL: _verify_red_tests function not found"; fail=$((fail + 1))
else
  end_line=$(( verify_line + 40 ))
  block=$(sed -n "${verify_line},${end_line}p" "$PIPELINE_RUN_TASK")
  # Negative assertion: the git diff line must not end with '|| true'.
  if printf '%s' "$block" | grep -qE 'git diff[^|]*\|\| true'; then
    echo "  FAIL: _verify_red_tests still swallows git diff with '|| true'"; fail=$((fail + 1))
  else
    echo "  PASS: _verify_red_tests does not swallow git diff errors with || true"; pass=$((pass + 1))
  fi
  # Positive assertion: the function must explicitly check git's rc and write a git_diff_failed reason.
  if ! printf '%s' "$block" | grep -q 'git_diff_failed'; then
    echo "  FAIL: _verify_red_tests does not surface git_diff_failed reason"; fail=$((fail + 1))
  else
    echo "  PASS: _verify_red_tests surfaces git_diff_failed reason"; pass=$((pass + 1))
  fi
fi

echo ""
echo "=== Results: $pass passed, $fail failed ==="
exit $(( fail > 0 ? 1 : 0 ))
