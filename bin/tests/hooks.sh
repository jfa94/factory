#!/usr/bin/env bash
# hooks.sh — hooks.json wiring, branch-protection hook, run-tracker hook,
# stop-gate / subagent-stop-gate hooks, pipeline-quality-gate,
# pipeline-coverage-gate tolerance, log_metric retention.
set -euo pipefail

export CLAUDE_PLUGIN_DATA=$(mktemp -d)
HOOKS_DIR="$(cd "$(dirname "$0")/../../hooks" && pwd)"
BIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$BIN_DIR:$PATH"

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

assert_exit() {
  local label="$1" expected="$2"
  shift 2
  local actual
  set +e
  "$@" >/dev/null 2>&1
  actual=$?
  set -e
  assert_eq "$label" "$expected" "$actual"
}

# ============================================================
echo "=== hooks.json structure ==="

hooks_json="$HOOKS_DIR/hooks.json"
assert_eq "hooks.json exists" "true" "$([[ -f "$hooks_json" ]] && echo true || echo false)"
assert_eq "hooks.json valid JSON" "0" "$(jq empty "$hooks_json" 2>/dev/null; echo $?)"
assert_eq "has PreToolUse (Bash + Edit/Write/MultiEdit groups)" "2" "$(jq '.hooks.PreToolUse | length' "$hooks_json")"
assert_eq "has PostToolUse" "1" "$(jq '.hooks.PostToolUse | length' "$hooks_json")"
assert_eq "has Stop" "1" "$(jq '.hooks.Stop | length' "$hooks_json")"
assert_eq "has SubagentStop" "1" "$(jq '.hooks.SubagentStop | length' "$hooks_json")"
assert_eq "PreToolUse matches Bash" "^Bash\$" "$(jq -r '.hooks.PreToolUse[0].matcher' "$hooks_json")"
assert_eq "PostToolUse matches multi" "^(Bash|Write|Edit)$" "$(jq -r '.hooks.PostToolUse[0].matcher' "$hooks_json")"
assert_eq "hooks.json Bash fires pipeline-guards" "1" "$(jq '[.hooks.PreToolUse[] | select(.matcher == "^Bash$") | .hooks[] | select(.command | test("pretooluse-pipeline-guards"))] | length' "$hooks_json")"

# ============================================================
echo ""
echo "=== branch-protection: blocks force-push to main ==="

output=$(printf '{"tool_input":{"command":"git push --force origin main"}}' | "$HOOKS_DIR/branch-protection.sh" 2>&1; echo "EXIT:$?")
assert_eq "force-push main blocked" "EXIT:2" "$(printf '%s' "$output" | grep -o 'EXIT:[0-9]*')"

# ============================================================
echo ""
echo "=== branch-protection: blocks force-push to master ==="

output=$(printf '{"tool_input":{"command":"git push -f origin master"}}' | "$HOOKS_DIR/branch-protection.sh" 2>&1; echo "EXIT:$?")
assert_eq "force-push master blocked" "EXIT:2" "$(printf '%s' "$output" | grep -o 'EXIT:[0-9]*')"

# ============================================================
echo ""
echo "=== branch-protection: blocks force-push to develop ==="

output=$(printf '{"tool_input":{"command":"git push --force origin develop"}}' | "$HOOKS_DIR/branch-protection.sh" 2>&1; echo "EXIT:$?")
assert_eq "force-push develop blocked" "EXIT:2" "$(printf '%s' "$output" | grep -o 'EXIT:[0-9]*')"

# ============================================================
echo ""
echo "=== branch-protection: blocks push to staging (now protected) ==="

output=$(printf '{"tool_input":{"command":"git push origin staging"}}' | "$HOOKS_DIR/branch-protection.sh" 2>&1; echo "EXIT:$?")
assert_eq "push staging blocked (interactive)" "EXIT:2" "$(printf '%s' "$output" | grep -o 'EXIT:[0-9]*')"

# ============================================================
echo ""
echo "=== branch-protection: allows force-push to feature branch ==="

assert_exit "force-push feature allowed" 0 bash -c 'printf "{\"tool_input\":{\"command\":\"git push --force-with-lease origin factory/42/task-1\"}}" | '"$HOOKS_DIR/branch-protection.sh"

# ============================================================
echo ""
echo "=== branch-protection: blocks +refspec force-push ==="

output=$(printf '{"tool_input":{"command":"git push origin +main"}}' | "$HOOKS_DIR/branch-protection.sh" 2>&1; echo "EXIT:$?")
assert_eq "+refspec main blocked" "EXIT:2" "$(printf '%s' "$output" | grep -o 'EXIT:[0-9]*')"

output=$(printf '{"tool_input":{"command":"git push origin +HEAD:develop"}}' | "$HOOKS_DIR/branch-protection.sh" 2>&1; echo "EXIT:$?")
assert_eq "+refspec HEAD:develop blocked" "EXIT:2" "$(printf '%s' "$output" | grep -o 'EXIT:[0-9]*')"

assert_exit "+refspec feature allowed" 0 bash -c 'printf "{\"tool_input\":{\"command\":\"git push origin +feature-branch\"}}" | '"$HOOKS_DIR/branch-protection.sh"

# ============================================================
echo ""
echo "=== S2: branch-protection blocks --force-if-includes ==="

# These assert the Check 2 reason (force_push_protected). Run from a repo on a
# NON-protected branch: otherwise Check 1 (on_protected_branch) pre-empts and
# the push is blocked with a different reason. Hermetic — independent of the
# branch the suite runner happens to be on.
fp_repo=$(mktemp -d "${TMPDIR:-/tmp}/branch-protect-fp-XXXXXX")
git -C "$fp_repo" init -q -b feature-x
git -C "$fp_repo" -c user.email=t@test -c user.name=t commit -q --allow-empty -m "init"

output=$( cd "$fp_repo" && printf '{"tool_input":{"command":"git push --force-if-includes origin main"}}' \
  | "$HOOKS_DIR/branch-protection.sh" 2>&1; echo "EXIT:$?")
assert_eq "--force-if-includes main blocked" "EXIT:2" "$(printf '%s' "$output" | grep -o 'EXIT:[0-9]*')"
assert_eq "--force-if-includes detected as force" "true" \
  "$(printf '%s' "$output" | grep -q 'force_push_protected' && echo true || echo false)"

# ============================================================
echo ""
echo "=== S2: branch-protection blocks --force-with-lease=<ref> ==="

output=$( cd "$fp_repo" && printf '{"tool_input":{"command":"git push --force-with-lease=main origin main"}}' \
  | "$HOOKS_DIR/branch-protection.sh" 2>&1; echo "EXIT:$?")
assert_eq "--force-with-lease=<ref> main blocked" "EXIT:2" "$(printf '%s' "$output" | grep -o 'EXIT:[0-9]*')"
assert_eq "--force-with-lease=<ref> detected as force" "true" \
  "$(printf '%s' "$output" | grep -q 'force_push_protected' && echo true || echo false)"
rm -rf "$fp_repo"

# ============================================================
echo ""
echo "=== branch-protection: blocks hard reset on a protected branch ==="

# Check 6 gates on the CURRENT branch, so run the hook from a repo that is
# checked out on a protected branch (main) and confirm a hard reset is blocked.
hr_repo=$(mktemp -d "${TMPDIR:-/tmp}/branch-protect-hr-XXXXXX")
git -C "$hr_repo" init -q -b main
git -C "$hr_repo" -c user.email=t@test -c user.name=t commit -q --allow-empty -m "init"
output=$( cd "$hr_repo" && printf '{"tool_input":{"command":"git reset --hard HEAD~1"}}' \
  | "$HOOKS_DIR/branch-protection.sh" 2>&1; echo "EXIT:$?")
assert_eq "hard reset on protected branch blocked" "EXIT:2" "$(printf '%s' "$output" | grep -o 'EXIT:[0-9]*')"
rm -rf "$hr_repo"

# ============================================================
echo ""
echo "=== branch-protection: blocks branch -D main ==="

output=$(printf '{"tool_input":{"command":"git branch -D main"}}' | "$HOOKS_DIR/branch-protection.sh" 2>&1; echo "EXIT:$?")
assert_eq "branch -D main blocked" "EXIT:2" "$(printf '%s' "$output" | grep -o 'EXIT:[0-9]*')"

# ============================================================
echo ""
echo "=== branch-protection: blocks remote delete of develop ==="

output=$(printf '{"tool_input":{"command":"git push origin --delete develop"}}' | "$HOOKS_DIR/branch-protection.sh" 2>&1; echo "EXIT:$?")
assert_eq "remote delete develop blocked" "EXIT:2" "$(printf '%s' "$output" | grep -o 'EXIT:[0-9]*')"

# ============================================================
echo ""
echo "=== branch-protection: allows non-git commands ==="

assert_exit "ls allowed" 0 bash -c 'printf "{\"tool_input\":{\"command\":\"ls -la\"}}" | '"$HOOKS_DIR/branch-protection.sh"

# ============================================================
echo ""
echo "=== branch-protection: allows empty command ==="

assert_exit "empty command allowed" 0 bash -c 'printf "{\"tool_input\":{}}" | '"$HOOKS_DIR/branch-protection.sh"

# ============================================================
echo ""
echo "=== run-tracker: no-op without active run ==="

# No active run, should exit 0 silently
assert_exit "no run exits 0" 0 bash -c 'printf "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}" | '"$HOOKS_DIR/run-tracker.sh"

# ============================================================
echo ""
echo "=== run-tracker: logs during active run ==="

# Set up active run
run_dir="$CLAUDE_PLUGIN_DATA/runs/test-tracker"
mkdir -p "$run_dir"
touch "$run_dir/audit.jsonl"
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
ln -s "$run_dir" "$CLAUDE_PLUGIN_DATA/runs/current"

printf '{"tool_name":"Bash","tool_input":{"command":"pnpm test"}}' | "$HOOKS_DIR/run-tracker.sh" 2>/dev/null

assert_eq "audit entry written" "1" "$(wc -l < "$run_dir/audit.jsonl" | tr -d ' ')"
assert_eq "audit tool" "Bash" "$(head -1 "$run_dir/audit.jsonl" | jq -r '.tool')"
assert_eq "audit run_id" "test-tracker" "$(head -1 "$run_dir/audit.jsonl" | jq -r '.run_id')"
assert_eq "audit seq" "1" "$(head -1 "$run_dir/audit.jsonl" | jq -r '.seq')"
assert_eq "audit has hash" "true" "$(head -1 "$run_dir/audit.jsonl" | jq -r 'if .params_hash != "" then "true" else "false" end')"
assert_eq "audit has timestamp" "true" "$(head -1 "$run_dir/audit.jsonl" | jq -r 'if .timestamp != "" then "true" else "false" end')"

# Second entry should have seq=2
printf '{"tool_name":"Write","tool_input":{"file_path":"/tmp/test.txt"}}' | "$HOOKS_DIR/run-tracker.sh" 2>/dev/null
assert_eq "second entry seq" "2" "$(tail -1 "$run_dir/audit.jsonl" | jq -r '.seq')"
assert_eq "second entry tool" "Write" "$(tail -1 "$run_dir/audit.jsonl" | jq -r '.tool')"

# ============================================================
echo ""
echo "=== stop-gate: marks running run as interrupted ==="

run_dir="$CLAUDE_PLUGIN_DATA/runs/test-stop-1"
mkdir -p "$run_dir"
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
ln -s "$run_dir" "$CLAUDE_PLUGIN_DATA/runs/current"

printf '%s' '{
  "run_id": "test-stop-1",
  "status": "running",
  "started_at": "2026-01-01T00:00:00Z",
  "updated_at": "2026-01-01T00:00:00Z",
  "ended_at": null,
  "tasks": {
    "T1": {"status": "done"},
    "T2": {"status": "executing"},
    "T3": {"status": "pending"}
  }
}' > "$run_dir/state.json"

printf '{"session_id":"test"}' | "$HOOKS_DIR/stop-gate.sh" 2>/dev/null

state=$(cat "$run_dir/state.json")
assert_eq "run status interrupted" "interrupted" "$(printf '%s' "$state" | jq -r '.status')"
assert_eq "T2 marked interrupted" "interrupted" "$(printf '%s' "$state" | jq -r '.tasks.T2.status')"
assert_eq "T1 still done" "done" "$(printf '%s' "$state" | jq -r '.tasks.T1.status')"
assert_eq "T3 still pending" "pending" "$(printf '%s' "$state" | jq -r '.tasks.T3.status')"
assert_eq "ended_at set" "true" "$(printf '%s' "$state" | jq -r 'if .ended_at != null then "true" else "false" end')"
assert_eq "resume_point set" "T2" "$(printf '%s' "$state" | jq -r '.resume_point')"
assert_eq "current symlink removed" "false" "$([[ -L "$CLAUDE_PLUGIN_DATA/runs/current" ]] && echo true || echo false)"

# ============================================================
echo ""
echo "=== stop-gate: marks all-done run as completed ==="

run_dir="$CLAUDE_PLUGIN_DATA/runs/test-stop-2"
mkdir -p "$run_dir"
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
ln -s "$run_dir" "$CLAUDE_PLUGIN_DATA/runs/current"

printf '%s' '{
  "run_id": "test-stop-2",
  "status": "running",
  "started_at": "2026-01-01T00:00:00Z",
  "updated_at": "2026-01-01T00:00:00Z",
  "ended_at": null,
  "tasks": {
    "T1": {"status": "done"},
    "T2": {"status": "done"}
  }
}' > "$run_dir/state.json"

printf '{"session_id":"test"}' | "$HOOKS_DIR/stop-gate.sh" 2>/dev/null

assert_eq "all-done → completed" "completed" "$(jq -r '.status' "$run_dir/state.json")"

# ============================================================
echo ""
echo "=== stop-gate: marks partial run ==="

run_dir="$CLAUDE_PLUGIN_DATA/runs/test-stop-3"
mkdir -p "$run_dir"
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
ln -s "$run_dir" "$CLAUDE_PLUGIN_DATA/runs/current"

printf '%s' '{
  "run_id": "test-stop-3",
  "status": "running",
  "started_at": "2026-01-01T00:00:00Z",
  "updated_at": "2026-01-01T00:00:00Z",
  "ended_at": null,
  "tasks": {
    "T1": {"status": "done"},
    "T2": {"status": "failed"}
  }
}' > "$run_dir/state.json"

printf '{"session_id":"test"}' | "$HOOKS_DIR/stop-gate.sh" 2>/dev/null

assert_eq "partial → partial" "partial" "$(jq -r '.status' "$run_dir/state.json")"

# ============================================================
echo ""
echo "=== stop-gate: no-op for non-running status ==="

run_dir="$CLAUDE_PLUGIN_DATA/runs/test-stop-4"
mkdir -p "$run_dir"
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
ln -s "$run_dir" "$CLAUDE_PLUGIN_DATA/runs/current"

printf '%s' '{
  "run_id": "test-stop-4",
  "status": "completed",
  "started_at": "2026-01-01T00:00:00Z",
  "updated_at": "2026-01-01T00:00:00Z",
  "ended_at": "2026-01-01T01:00:00Z",
  "tasks": {"T1": {"status": "done"}}
}' > "$run_dir/state.json"

printf '{"session_id":"test"}' | "$HOOKS_DIR/stop-gate.sh" 2>/dev/null

assert_eq "completed unchanged" "completed" "$(jq -r '.status' "$run_dir/state.json")"

# ============================================================
echo ""
echo "=== stop-gate: no-op without active run ==="

rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
assert_exit "no run exits 0" 0 bash -c 'printf "{\"session_id\":\"test\"}" | '"$HOOKS_DIR/stop-gate.sh"

# ============================================================
echo ""
echo "=== subagent-stop-gate: no-op without active run ==="

assert_exit "subagent no run exits 0" 0 bash -c 'printf "{\"agent_type\":\"implementation-reviewer\"}" | '"$HOOKS_DIR/subagent-stop-gate.sh"

# ============================================================
echo ""
echo "=== subagent-stop-gate: fail-closed on broken current symlink ==="

rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
ln -sfn "$CLAUDE_PLUGIN_DATA/runs/does-not-exist" "$CLAUDE_PLUGIN_DATA/runs/current"
set +e
printf '{"agent_type":"implementation-reviewer"}' \
  | bash "$HOOKS_DIR/subagent-stop-gate.sh" >/dev/null 2>/tmp/subagent-broken.err
rc=$?
set -e
assert_eq "subagent broken-symlink exit nonzero" "1" "$rc"
assert_eq "subagent broken-symlink logs diagnostic" "true" \
  "$(grep -q 'runs/current symlink is broken' /tmp/subagent-broken.err && echo true || echo false)"
rm -f /tmp/subagent-broken.err
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"

# ============================================================
echo ""
echo "=== subagent-stop-gate: no-op for unknown agent type ==="

run_dir="$CLAUDE_PLUGIN_DATA/runs/test-subagent"
mkdir -p "$run_dir/reviews"
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
ln -s "$run_dir" "$CLAUDE_PLUGIN_DATA/runs/current"
printf '{"run_id":"test-subagent","status":"running","tasks":{}}' > "$run_dir/state.json"

assert_exit "unknown agent exits 0" 0 bash -c 'printf "{\"agent_type\":\"unknown-agent\"}" | '"$HOOKS_DIR/subagent-stop-gate.sh"

# ============================================================
echo ""
echo "=== subagent-stop-gate: warns on missing review files ==="

# implementation-reviewer with no review files
output=$(printf '{"agent_type":"implementation-reviewer"}' | "$HOOKS_DIR/subagent-stop-gate.sh" 2>&1)
assert_eq "warns no reviews" "true" "$(printf '%s' "$output" | grep -q 'no review files' && echo true || echo false)"

# ============================================================
echo ""
echo "=== subagent-stop-gate: no warning with review files present ==="

# H6 regression: previously the warning checked $run_dir/reviews/*.json — a
# path the pipeline never writes to. The actual canonical location is
# $run_dir/.state/<run_id>/<task>.review.codex.json, and the state pointer is
# .tasks[].review_files. Both must satisfy the absent-warning case.
mkdir -p "$run_dir/.state/test-subagent"
echo '{"verdict":"APPROVE"}' > "$run_dir/.state/test-subagent/T1.review.codex.json"
output=$(printf '{"agent_type":"implementation-reviewer"}' | "$HOOKS_DIR/subagent-stop-gate.sh" 2>&1)
assert_eq "no warning with canonical review file" "false" "$(printf '%s' "$output" | grep -q 'WARNING' && echo true || echo false)"

# Also verify the state-pointer path: review_files non-empty silences warning.
rm -f "$run_dir/.state/test-subagent/T1.review.codex.json"
printf '{"run_id":"test-subagent","status":"running","tasks":{"T1":{"review_files":["x.json"]}}}' > "$run_dir/state.json"
output=$(printf '{"agent_type":"implementation-reviewer"}' | "$HOOKS_DIR/subagent-stop-gate.sh" 2>&1)
assert_eq "no warning with state review_files" "false" "$(printf '%s' "$output" | grep -q 'WARNING' && echo true || echo false)"
# Restore state for following tests.
printf '{"run_id":"test-subagent","status":"running","tasks":{}}' > "$run_dir/state.json"

# ============================================================
echo ""
echo "=== task_07_02: pipeline-parse-review verdict anchor ==="

# Review with anti-verdict prose in body but APPROVE in the anchored block.
# The parser must extract APPROVE from the block, not REQUEST_CHANGES from prose.
prose_input='## Findings

I do not approve of this naming choice — but it is non-blocking so I am letting
it through. The author would say "REQUEST_CHANGES is too harsh here" and I agree.

## Acceptance Criteria Check

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Logs in | PASS | src/auth.ts:42 |

## Summary
Looks fine despite the naming nit.

## Verdict

VERDICT: APPROVE
CONFIDENCE: HIGH
BLOCKERS: 0
ROUND: 1'

output=$(printf '%s' "$prose_input" | "$BIN_DIR/pipeline-parse-review" 2>/dev/null)
assert_eq "verdict anchored APPROVE (not prose REQUEST_CHANGES)" "APPROVE" "$(echo "$output" | jq -r '.verdict')"
assert_eq "confidence from block" "HIGH" "$(echo "$output" | jq -r '.confidence')"
assert_eq "declared_blockers from block" "0" "$(echo "$output" | jq -r '.declared_blockers')"

# Review missing the entire `## Verdict` block — must fail with non-zero exit
no_block_input='## Findings

### [BLOCKING] Something
- **File:** a.ts:1
- **Severity:** critical
- **Category:** correctness
- **Description:** broken

## Summary
no anchor block here'

set +e
printf '%s' "$no_block_input" | "$BIN_DIR/pipeline-parse-review" >/dev/null 2>&1
exit_code=$?
set -e
assert_eq "missing verdict block exits 1" "1" "$exit_code"

# Review with VERDICT: MAYBE inside the block — invalid value, must exit 1
invalid_verdict_input='## Findings

## Summary
asdf

## Verdict

VERDICT: MAYBE
CONFIDENCE: HIGH
BLOCKERS: 0
ROUND: 1'

set +e
printf '%s' "$invalid_verdict_input" | "$BIN_DIR/pipeline-parse-review" >/dev/null 2>&1
exit_code=$?
set -e
assert_eq "invalid VERDICT exits 1" "1" "$exit_code"

# Review with valid block, BLOCKERS: 3 — declared_blockers must be 3
blockers_input='## Findings

### [BLOCKING] One
- **File:** a.ts:1
- **Severity:** critical
- **Category:** security
- **Description:** sql injection

### [BLOCKING] Two
- **File:** b.ts:2
- **Severity:** major
- **Category:** correctness
- **Description:** missing null check

### [BLOCKING] Three
- **File:** c.ts:3
- **Severity:** critical
- **Category:** security
- **Description:** xss

## Summary
multiple issues

## Verdict

VERDICT: REQUEST_CHANGES
CONFIDENCE: HIGH
BLOCKERS: 3
ROUND: 1'

output=$(printf '%s' "$blockers_input" | "$BIN_DIR/pipeline-parse-review" 2>/dev/null)
assert_eq "BLOCKERS: 3 parsed" "3" "$(echo "$output" | jq -r '.declared_blockers')"
assert_eq "REQUEST_CHANGES verdict" "REQUEST_CHANGES" "$(echo "$output" | jq -r '.verdict')"
assert_eq "blocking_count tally agrees" "3" "$(echo "$output" | jq -r '.blocking_count')"

# H7 regression: JSON-block path must tally blocking_count from .blocking, not
# from severity. A reviewer can mark a minor finding `blocking:true` (legitimate
# escalation) or a critical finding `blocking:false` (judgment call). The parser
# must honor the explicit field. Severity-only counting silently downgraded such
# reviews to REQUEST_CHANGES.
json_blocking_input='```json
{
  "verdict": "REQUEST_CHANGES",
  "summary": "review",
  "findings": [
    {"file":"a.ts","line":1,"verbatim_line":"const x = 1;","severity":"minor","blocking":true,"description":"reviewer-escalated minor"},
    {"file":"b.ts","line":2,"verbatim_line":"const y = 2;","severity":"critical","blocking":false,"description":"reviewer-deprioritized critical"}
  ]
}
```'
output=$(printf '%s' "$json_blocking_input" | "$BIN_DIR/pipeline-parse-review" 2>/dev/null)
assert_eq "JSON-block: blocking_count counts .blocking==true (minor escalated)" "1" \
  "$(echo "$output" | jq -r '.blocking_count')"
assert_eq "JSON-block: non_blocking_count counts the rest (critical deprioritized)" "1" \
  "$(echo "$output" | jq -r '.non_blocking_count')"
assert_eq "JSON-block: blocking field on minor finding preserved" "true" \
  "$(echo "$output" | jq -r '.findings[0].blocking')"
assert_eq "JSON-block: blocking field on critical finding preserved" "false" \
  "$(echo "$output" | jq -r '.findings[1].blocking')"

# JSON-block: when reviewer omits .blocking, derive from severity (critical|high|important → true).
json_default_input='```json
{
  "verdict": "REQUEST_CHANGES",
  "summary": "default-blocking",
  "findings": [
    {"file":"a.ts","line":1,"verbatim_line":"const x = 1;","severity":"critical","description":"no blocking field"},
    {"file":"b.ts","line":2,"verbatim_line":"const y = 2;","severity":"minor","description":"no blocking field"}
  ]
}
```'
output=$(printf '%s' "$json_default_input" | "$BIN_DIR/pipeline-parse-review" 2>/dev/null)
assert_eq "JSON-block: derived blocking from critical severity" "1" \
  "$(echo "$output" | jq -r '.blocking_count')"
assert_eq "JSON-block: derived blocking on critical finding" "true" \
  "$(echo "$output" | jq -r '.findings[0].blocking')"
assert_eq "JSON-block: derived blocking on minor finding" "false" \
  "$(echo "$output" | jq -r '.findings[1].blocking')"

# ============================================================
echo ""
echo "=== task_07_03: pipeline-quality-gate ==="

QG="$BIN_DIR/pipeline-quality-gate"
assert_eq "pipeline-quality-gate exists" "true" "$([[ -f "$QG" ]] && echo true || echo false)"
assert_eq "pipeline-quality-gate executable" "true" "$([[ -x "$QG" ]] && echo true || echo false)"

# Set up a fixture run so the script has somewhere to write logs/state.
qg_run="qg-test-run"
qg_run_dir="$CLAUDE_PLUGIN_DATA/runs/$qg_run"
mkdir -p "$qg_run_dir"
printf '{"run_id":"%s","status":"running","tasks":{"qt1":{"status":"executing"}}}' "$qg_run" > "$qg_run_dir/state.json"

# Fixture 1: all-pass project
qg_proj1=$(mktemp -d)
cat > "$qg_proj1/package.json" << 'PJSON'
{
  "name": "qg-pass",
  "scripts": {
    "lint": "true",
    "typecheck": "true",
    "test:coverage": "true"
  }
}
PJSON

set +e
output=$("$QG" "$qg_run" "qt1" "$qg_proj1" 2>/dev/null)
exit_code=$?
set -e
assert_eq "all-pass exit 0" "0" "$exit_code"
assert_eq "all-pass ok=true" "true" "$(echo "$output" | jq -r '.ok')"
assert_eq "all-pass 3 checks" "3" "$(echo "$output" | jq -r '.checks | length')"
assert_eq "state.quality_gate.ok=true" "true" \
  "$(jq -r '.tasks.qt1.quality_gate.ok' "$qg_run_dir/state.json")"

# Fixture 2: lint failing
qg_proj2=$(mktemp -d)
cat > "$qg_proj2/package.json" << 'PJSON'
{
  "name": "qg-fail",
  "scripts": {
    "lint": "false",
    "typecheck": "true",
    "test:coverage": "true"
  }
}
PJSON

set +e
output=$("$QG" "$qg_run" "qt1" "$qg_proj2" 2>/dev/null)
exit_code=$?
set -e
assert_eq "lint-fail exit 1" "1" "$exit_code"
assert_eq "lint-fail ok=false" "false" "$(echo "$output" | jq -r '.ok')"
lint_status=$(echo "$output" | jq -r '.checks[] | select(.command=="lint") | .status')
assert_eq "lint check failed" "failed" "$lint_status"

# Fixture 3: factory.quality override — only run lint
qg_proj3=$(mktemp -d)
cat > "$qg_proj3/package.json" << 'PJSON'
{
  "name": "qg-override",
  "scripts": {
    "lint": "true",
    "typecheck": "false",
    "test": "false"
  },
  "factory": {
    "quality": ["lint"]
  }
}
PJSON

set +e
output=$("$QG" "$qg_run" "qt1" "$qg_proj3" 2>/dev/null)
exit_code=$?
set -e
assert_eq "override exit 0" "0" "$exit_code"
assert_eq "override 1 check" "1" "$(echo "$output" | jq -r '.checks | length')"
assert_eq "override only lint" "lint" "$(echo "$output" | jq -r '.checks[0].command')"

# Fixture 4: missing package.json — non-JS repo, skipped cleanly (Task 4.9)
qg_proj4=$(mktemp -d)
set +e
output=$("$QG" "$qg_run" "qt1" "$qg_proj4" 2>/dev/null)
exit_code=$?
set -e
assert_eq "no package.json exit 2 (skipped)" "2" "$exit_code"
assert_eq "no package.json ok=true" "true" "$(echo "$output" | jq -r '.ok')"
assert_eq "no package.json skipped=true" "true" "$(echo "$output" | jq -r '.skipped')"
assert_eq "no package.json reason=no-package-json" "no-package-json" "$(echo "$output" | jq -r '.reason')"
assert_eq "state.quality_gate.skipped=true" "true" \
  "$(jq -r '.tasks.qt1.quality_gate.skipped' "$qg_run_dir/state.json")"

# Fixture 5: package.json without any quality scripts — skipped cleanly (Task 4.9)
qg_proj5=$(mktemp -d)
cat > "$qg_proj5/package.json" << 'PJSON'
{
  "name": "qg-no-scripts",
  "scripts": {
    "build": "true",
    "start": "true"
  }
}
PJSON
set +e
output=$("$QG" "$qg_run" "qt1" "$qg_proj5" 2>/dev/null)
exit_code=$?
set -e
assert_eq "no quality scripts exit 2" "2" "$exit_code"
assert_eq "no quality scripts ok=true" "true" "$(echo "$output" | jq -r '.ok')"
assert_eq "no quality scripts reason=no-quality-scripts" "no-quality-scripts" "$(echo "$output" | jq -r '.reason')"

# Fixture 6: package.json with only lint script — runs only that command (Task 4.9)
qg_proj6=$(mktemp -d)
cat > "$qg_proj6/package.json" << 'PJSON'
{
  "name": "qg-only-lint",
  "scripts": {
    "lint": "true"
  }
}
PJSON
set +e
output=$("$QG" "$qg_run" "qt1" "$qg_proj6" 2>/dev/null)
exit_code=$?
set -e
assert_eq "only-lint exit 0" "0" "$exit_code"
assert_eq "only-lint 1 check" "1" "$(echo "$output" | jq -r '.checks | length')"
assert_eq "only-lint ran lint" "lint" "$(echo "$output" | jq -r '.checks[0].command')"

# ============================================================
echo ""
echo "=== task_13_05: pipeline-coverage-gate tolerance ==="

cov_dir=$(mktemp -d)

# Helper to create coverage JSON
_cov_json() {
  local lines="$1" branches="$2" funcs="$3" stmts="$4"
  printf '{"total":{"lines":%s,"branches":%s,"functions":%s,"statements":%s}}' \
    "$lines" "$branches" "$funcs" "$stmts"
}

# Before: 80% across the board
echo "$(_cov_json 80 80 80 80)" > "$cov_dir/before.json"

# After: 0.3% decrease in lines → passes with default 0.5% tolerance
echo "$(_cov_json 79.7 80 80 80)" > "$cov_dir/after-small.json"
set +e
output=$("$BIN_DIR/pipeline-coverage-gate" "$cov_dir/before.json" "$cov_dir/after-small.json" 2>/dev/null)
exit_code=$?
set -e
assert_eq "0.3% decrease passes with default tolerance" "0" "$exit_code"
assert_eq "0.3% decrease passed=true" "true" "$(echo "$output" | jq -r '.passed')"
assert_eq "tolerance in output" "0.5" "$(echo "$output" | jq -r '.tolerance')"

# After: 1% decrease in lines → fails with default 0.5% tolerance
echo "$(_cov_json 79 80 80 80)" > "$cov_dir/after-big.json"
set +e
output=$("$BIN_DIR/pipeline-coverage-gate" "$cov_dir/before.json" "$cov_dir/after-big.json" 2>/dev/null)
exit_code=$?
set -e
assert_eq "1% decrease fails with default tolerance" "1" "$exit_code"
assert_eq "1% decrease passed=false" "false" "$(echo "$output" | jq -r '.passed')"

# --tolerance 2 allows 1.5% decrease
echo "$(_cov_json 78.5 80 80 80)" > "$cov_dir/after-med.json"
set +e
output=$("$BIN_DIR/pipeline-coverage-gate" "$cov_dir/before.json" "$cov_dir/after-med.json" --tolerance 2 2>/dev/null)
exit_code=$?
set -e
assert_eq "--tolerance 2 allows 1.5% decrease" "0" "$exit_code"
assert_eq "--tolerance 2 tolerance in output" "2" "$(echo "$output" | jq -r '.tolerance')"

rm -rf "$cov_dir"

# ============================================================
echo ""
echo "=== task_16_06: coverage-gate reads renamed config key ==="

cov_cfg_dir=$(mktemp -d)
echo "$(_cov_json 80 80 80 80)" > "$cov_cfg_dir/before.json"
# 0.2pp drop — passes at default tolerance 0.5, must fail at 0.1
echo "$(_cov_json 79.8 80 80 80)" > "$cov_cfg_dir/after.json"

# Write config in the canonical nested shape (configure.md uses setpath +
# split(".") so dotted keys become nested objects).
printf '{"quality":{"coverageRegressionTolerancePct":0.1}}' > "$CLAUDE_PLUGIN_DATA/config.json"
set +e
output=$("$BIN_DIR/pipeline-coverage-gate" "$cov_cfg_dir/before.json" "$cov_cfg_dir/after.json" 2>/dev/null)
exit_code=$?
set -e
assert_eq "coverage-gate reads coverageRegressionTolerancePct=0.1 and fails 0.2pp drop" "1" "$exit_code"
assert_eq "tolerance reported as 0.1" "0.1" "$(echo "$output" | jq -r '.tolerance')"

# Old key must NOT be recognized anymore — with only old key set, gate uses
# the 0.5 default and passes.
printf '{"quality":{"coverageTolerance":0.1}}' > "$CLAUDE_PLUGIN_DATA/config.json"
set +e
output=$("$BIN_DIR/pipeline-coverage-gate" "$cov_cfg_dir/before.json" "$cov_cfg_dir/after.json" 2>/dev/null)
exit_code=$?
set -e
assert_eq "old coverageTolerance key is ignored (gate uses default)" "0" "$exit_code"
assert_eq "default tolerance 0.5 used when new key absent" "0.5" "$(echo "$output" | jq -r '.tolerance')"

rm -f "$CLAUDE_PLUGIN_DATA/config.json"
rm -rf "$cov_cfg_dir"

# ============================================================
echo ""
echo "=== task_16_11: log_metric + retention trim ==="

# Build a minimal "current" run dir so log_metric can target it.
OBS_RUN_ID="obs-test-run"
obs_run_dir="$CLAUDE_PLUGIN_DATA/runs/$OBS_RUN_ID"
mkdir -p "$obs_run_dir"
touch "$obs_run_dir/metrics.jsonl"
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
ln -s "$obs_run_dir" "$CLAUDE_PLUGIN_DATA/runs/current"

# --- Case A: log_metric with auditLog=true writes a JSONL line ---
rm -f "$CLAUDE_PLUGIN_DATA/config.json"
( source "$(dirname "$0")/../pipeline-lib.sh"; log_metric "task.start" "task_id=\"t_01\"" "rank=2" )
line_count=$(wc -l < "$obs_run_dir/metrics.jsonl" | tr -d ' ')
assert_eq "log_metric writes 1 line when auditLog default (true)" "1" "$line_count"
event=$(head -1 "$obs_run_dir/metrics.jsonl" | jq -r '.event')
assert_eq "log_metric event captured" "task.start" "$event"
tid=$(head -1 "$obs_run_dir/metrics.jsonl" | jq -r '.task_id')
assert_eq "log_metric string k=v captured" "t_01" "$tid"
rank=$(head -1 "$obs_run_dir/metrics.jsonl" | jq -r '.rank')
assert_eq "log_metric numeric k=v parsed as JSON number" "2" "$rank"

# --- Case B: auditLog=false → no new lines ---
printf '{"observability":{"auditLog":false}}' > "$CLAUDE_PLUGIN_DATA/config.json"
before=$(wc -l < "$obs_run_dir/metrics.jsonl" | tr -d ' ')
( source "$(dirname "$0")/../pipeline-lib.sh"; log_metric "task.end" "status=\"done\"" )
after=$(wc -l < "$obs_run_dir/metrics.jsonl" | tr -d ' ')
assert_eq "auditLog=false disables log_metric" "$before" "$after"

# --- Case C: retention trim drops old lines ---
rm -f "$CLAUDE_PLUGIN_DATA/config.json"
# Write a metric dated 200 days ago and another dated now.
old_ts=$(date -u -v-200d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "200 days ago" +%Y-%m-%dT%H:%M:%SZ)
: > "$obs_run_dir/metrics.jsonl"
printf '{"ts":"%s","run_id":"obs-test-run","event":"old.event"}\n' "$old_ts" >> "$obs_run_dir/metrics.jsonl"
printf '{"ts":"%s","run_id":"obs-test-run","event":"new.event"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$obs_run_dir/metrics.jsonl"

# Configure retention to 90 days. Populate tasks so cleanup archives the run.
cat > "$obs_run_dir/state.json" <<EOF
{
  "run_id": "$OBS_RUN_ID",
  "status": "completed",
  "mode": "prd",
  "started_at": "2026-01-01T00:00:00Z",
  "ended_at": "2026-01-01T00:30:00Z",
  "tasks": {"t1": {"status": "done"}},
  "input": {"issue_numbers": [1]},
  "spec": {"path": null}
}
EOF

printf '{"observability":{"metricsRetentionDays":90}}' > "$CLAUDE_PLUGIN_DATA/config.json"

pipeline-cleanup "$OBS_RUN_ID" >/dev/null 2>&1 || true

# After cleanup, the run dir is archived. Retention trim runs on all
# audit/metrics files under CLAUDE_PLUGIN_DATA — the archive copy should
# have the old line removed.
archive_metrics="$CLAUDE_PLUGIN_DATA/archive/$OBS_RUN_ID/metrics.jsonl"
if [[ -f "$archive_metrics" ]]; then
  # Use awk to avoid grep -c's non-zero exit when count is zero.
  old_survived=$(awk '/old\.event/{c++} END{print c+0}' "$archive_metrics")
  new_survived=$(awk '/new\.event/{c++} END{print c+0}' "$archive_metrics")
  assert_eq "retention trim removes line older than 90 days" "0" "$old_survived"
  assert_eq "retention trim keeps recent line" "1" "$new_survived"
else
  echo "  FAIL: archive metrics file not found at $archive_metrics"
  fail=$((fail + 1))
fi

rm -f "$CLAUDE_PLUGIN_DATA/config.json"
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"

# ============================================================
# Layer-2 autonomous-mode hooks
# ============================================================

# Helper: seed a run dir with state.json + current symlink.
_seed_run() {
  local run_id="$1" state_json="$2"
  local dir="$CLAUDE_PLUGIN_DATA/runs/$run_id"
  mkdir -p "$dir"
  printf '%s' "$state_json" > "$dir/state.json"
  ln -sfn "$dir" "$CLAUDE_PLUGIN_DATA/runs/current"
}

# ============================================================
echo ""
echo "=== stop-gate: autonomous mode blocks on non-terminal tasks ==="

_seed_run "run-stop-block" '{"status":"running","tasks":{"alpha-001":{"status":"executing"}}}'
set +e
out=$(FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/stop-gate.sh" < /dev/null 2>/dev/null)
rc=$?
set -e
assert_eq "stop-gate block exit 0"      "0" "$rc"
assert_eq "stop-gate emits decision=block" "block" "$(printf '%s' "$out" | jq -r '.decision // empty')"
# state must NOT be auto-marked interrupted when blocked
state_after=$(jq -r '.tasks."alpha-001".status' "$CLAUDE_PLUGIN_DATA/runs/run-stop-block/state.json")
assert_eq "stop-gate preserves executing on block" "executing" "$state_after"
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"

echo ""
echo "=== stop-gate: FACTORY_ALLOW_STOP bypass marks interrupted ==="

_seed_run "run-stop-allow" '{"status":"running","tasks":{"beta-001":{"status":"executing"}}}'
set +e
FACTORY_AUTONOMOUS_MODE=1 FACTORY_ALLOW_STOP=1 bash "$HOOKS_DIR/stop-gate.sh" < /dev/null >/dev/null 2>&1
rc=$?
set -e
assert_eq "stop-gate allow-stop exit 0" "0" "$rc"
state_after=$(jq -r '.tasks."beta-001".status' "$CLAUDE_PLUGIN_DATA/runs/run-stop-allow/state.json")
assert_eq "stop-gate marks executing → interrupted" "interrupted" "$state_after"

echo ""
echo "=== stop-gate: non-autonomous session preserves legacy behavior ==="

_seed_run "run-stop-legacy" '{"status":"running","tasks":{"c-001":{"status":"executing"}}}'
set +e
bash "$HOOKS_DIR/stop-gate.sh" < /dev/null >/dev/null 2>&1
rc=$?
set -e
assert_eq "stop-gate legacy exit 0" "0" "$rc"
state_after=$(jq -r '.tasks."c-001".status' "$CLAUDE_PLUGIN_DATA/runs/run-stop-legacy/state.json")
assert_eq "stop-gate legacy marks interrupted" "interrupted" "$state_after"

echo ""
echo "=== stop-gate: status=done = no-op ==="

_seed_run "run-stop-done" '{"status":"done","tasks":{"d-001":{"status":"done"}}}'
set +e
bash "$HOOKS_DIR/stop-gate.sh" < /dev/null >/dev/null 2>&1
rc=$?
set -e
assert_eq "stop-gate done noop exit 0" "0" "$rc"

# ============================================================
echo ""
echo "=== pretooluse-pipeline-guards: denies gh pr create without quality_gate.ok ==="

_seed_run "run-guards" '{"status":"running","tasks":{"alpha-001":{"status":"reviewing","quality_gate":{"ok":false}}}}'
input='{"tool_input":{"command":"gh pr create --head task/alpha-001 --base staging"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_TASK_ID=alpha-001 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "guards pr-create-bad exit 0" "0" "$rc"
decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty')
assert_eq "guards pr-create-bad denies"   "deny" "$decision"

echo ""
echo "=== pretooluse-pipeline-guards: allows gh pr create when quality_gate.ok=true ==="

_seed_run "run-guards-ok" '{"status":"running","tasks":{"alpha-001":{"status":"reviewing","quality_gate":{"ok":true}}}}'
input='{"tool_input":{"command":"gh pr create --head task/alpha-001 --base staging"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_TASK_ID=alpha-001 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "guards pr-create-ok exit 0"    "0" "$rc"
assert_eq "guards pr-create-ok no output" "" "$out"

echo ""
echo "=== pretooluse-pipeline-guards: denies task-status done without preconditions ==="

_seed_run "run-guards-done" '{"status":"running","tasks":{"alpha-001":{"status":"executing"}}}'
input='{"tool_input":{"command":"pipeline-state task-status run-guards-done alpha-001 done"}}'
set +e
out=$(printf '%s' "$input" | bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "guards task-status-done exit 0" "0" "$rc"
assert_eq "guards task-status-done denies" "deny" "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty')"

echo ""
echo "=== pretooluse-pipeline-guards: cross-run task-status done in autonomous mode ==="

# Active run is run-guards-done (seeded above). A command targeting a
# DIFFERENT run-id must be denied when FACTORY_AUTONOMOUS_MODE=1.
input='{"tool_input":{"command":"pipeline-state task-status run-other alpha-001 done"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "guards cross-run autonomous exit 0" "0" "$rc"
decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty')
assert_eq "guards cross-run autonomous denies" "deny" "$decision"
reason=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty')
case "$reason" in
  *"cross-run"*) echo "  PASS: deny reason mentions cross-run"; pass=$((pass + 1)) ;;
  *) echo "  FAIL: deny reason does not mention cross-run (got: $reason)"; fail=$((fail + 1)) ;;
esac

# Same input WITHOUT autonomous mode → not denied (legacy scope-check passes).
set +e
out_loose=$(printf '%s' "$input" | bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "guards cross-run non-autonomous exit 0" "0" "$rc"
assert_eq "guards cross-run non-autonomous no output" "" "$out_loose"

echo ""
echo "=== pretooluse-pipeline-guards: no-op when no pipeline run ==="

rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
input='{"tool_input":{"command":"gh pr create --head feat --base main"}}'
set +e
out=$(printf '%s' "$input" | bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "guards no-run exit 0"    "0" "$rc"
assert_eq "guards no-run no output" "" "$out"

echo ""
echo "=== pretooluse-pipeline-guards: fail-closed on broken current symlink (Bash) ==="

# Symlink exists but points at a missing run dir — must fail closed, not no-op.
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
ln -sfn "$CLAUDE_PLUGIN_DATA/runs/does-not-exist" "$CLAUDE_PLUGIN_DATA/runs/current"
input='{"tool_name":"Bash","tool_input":{"command":"gh pr create --head feat --base main"}}'
set +e
out=$(printf '%s' "$input" | bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" 2>/tmp/guards-broken.err)
rc=$?
set -e
assert_eq "guards broken-symlink Bash exit nonzero" "1" "$rc"
assert_eq "guards broken-symlink Bash logs diagnostic" "true" \
  "$(grep -q 'runs/current symlink is broken' /tmp/guards-broken.err && echo true || echo false)"
rm -f /tmp/guards-broken.err

echo ""
echo "=== pretooluse-pipeline-guards: fail-closed on broken current symlink (non-Bash) ==="

rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
ln -sfn "$CLAUDE_PLUGIN_DATA/runs/does-not-exist" "$CLAUDE_PLUGIN_DATA/runs/current"
input='{"tool_name":"Write","tool_input":{"file_path":"src/foo.ts"}}'
set +e
printf '%s' "$input" | bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" >/dev/null 2>/tmp/guards-broken2.err
rc=$?
set -e
assert_eq "guards broken-symlink non-Bash exit nonzero" "1" "$rc"
assert_eq "guards broken-symlink non-Bash logs diagnostic" "true" \
  "$(grep -q 'runs/current symlink is broken' /tmp/guards-broken2.err && echo true || echo false)"
rm -f /tmp/guards-broken2.err
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"

# ============================================================
echo ""
echo "=== pretooluse-pipeline-guards: path-scope — blocks impl file during preexec_tests ==="

_seed_run "run-pathscope-block" '{"status":"running","tasks":{"t1":{"status":"executing","stage":"preexec_tests"}}}'
input='{"tool_name":"Write","tool_input":{"file_path":"src/foo.ts"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_AUTONOMOUS_MODE=1 FACTORY_TASK_ID=t1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "pathscope block src/foo.ts exit 0" "0" "$rc"
decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty')
assert_eq "pathscope block src/foo.ts denies" "deny" "$decision"
reason=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty')
assert_eq "pathscope block reason mentions path" "true" \
  "$(printf '%s' "$reason" | grep -q 'src/foo.ts' && echo true || echo false)"

echo ""
echo "=== pretooluse-pipeline-guards: path-scope — allows *.test.* during preexec_tests ==="

_seed_run "run-pathscope-test" '{"status":"running","tasks":{"t1":{"status":"executing","stage":"preexec_tests"}}}'
input='{"tool_name":"Write","tool_input":{"file_path":"src/foo.test.ts"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_AUTONOMOUS_MODE=1 FACTORY_TASK_ID=t1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "pathscope allow src/foo.test.ts exit 0" "0" "$rc"
assert_eq "pathscope allow src/foo.test.ts no deny" "" "$out"

echo ""
echo "=== pretooluse-pipeline-guards: path-scope — allows tests/ dir during preexec_tests ==="

_seed_run "run-pathscope-testsdir" '{"status":"running","tasks":{"t1":{"status":"executing","stage":"preexec_tests"}}}'
input='{"tool_name":"Write","tool_input":{"file_path":"tests/foo.ts"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_AUTONOMOUS_MODE=1 FACTORY_TASK_ID=t1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "pathscope allow tests/foo.ts exit 0" "0" "$rc"
assert_eq "pathscope allow tests/foo.ts no deny" "" "$out"

echo ""
echo "=== pretooluse-pipeline-guards: path-scope — allows fixtures/ during preexec_tests ==="

_seed_run "run-pathscope-fixtures" '{"status":"running","tasks":{"t1":{"status":"executing","stage":"preexec_tests"}}}'
input='{"tool_name":"Write","tool_input":{"file_path":"fixtures/data.json"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_AUTONOMOUS_MODE=1 FACTORY_TASK_ID=t1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "pathscope allow fixtures/data.json exit 0" "0" "$rc"
assert_eq "pathscope allow fixtures/data.json no deny" "" "$out"

echo ""
echo "=== pretooluse-pipeline-guards: path-scope — allows *.spec.* during preexec_tests ==="

_seed_run "run-pathscope-spec" '{"status":"running","tasks":{"t1":{"status":"executing","stage":"preexec_tests"}}}'
input='{"tool_name":"Write","tool_input":{"file_path":"src/foo.spec.ts"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_AUTONOMOUS_MODE=1 FACTORY_TASK_ID=t1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "pathscope allow src/foo.spec.ts exit 0" "0" "$rc"
assert_eq "pathscope allow src/foo.spec.ts no deny" "" "$out"

echo ""
echo "=== pretooluse-pipeline-guards: path-scope — allows __tests__/ dir during preexec_tests ==="

_seed_run "run-pathscope-dunder-tests" '{"status":"running","tasks":{"t1":{"status":"executing","stage":"preexec_tests"}}}'
input='{"tool_name":"Write","tool_input":{"file_path":"__tests__/foo.ts"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_AUTONOMOUS_MODE=1 FACTORY_TASK_ID=t1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "pathscope allow __tests__/foo.ts exit 0" "0" "$rc"
assert_eq "pathscope allow __tests__/foo.ts no deny" "" "$out"

echo ""
echo "=== pretooluse-pipeline-guards: path-scope — allows *.test-helpers.* during preexec_tests ==="

_seed_run "run-pathscope-test-helpers" '{"status":"running","tasks":{"t1":{"status":"executing","stage":"preexec_tests"}}}'
input='{"tool_name":"Write","tool_input":{"file_path":"src/foo.test-helpers.ts"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_AUTONOMOUS_MODE=1 FACTORY_TASK_ID=t1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "pathscope allow src/foo.test-helpers.ts exit 0" "0" "$rc"
assert_eq "pathscope allow src/foo.test-helpers.ts no deny" "" "$out"

echo ""
echo "=== pretooluse-pipeline-guards: path-scope — allows *.test-utils.* during preexec_tests ==="

_seed_run "run-pathscope-test-utils" '{"status":"running","tasks":{"t1":{"status":"executing","stage":"preexec_tests"}}}'
input='{"tool_name":"Write","tool_input":{"file_path":"src/foo.test-utils.ts"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_AUTONOMOUS_MODE=1 FACTORY_TASK_ID=t1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "pathscope allow src/foo.test-utils.ts exit 0" "0" "$rc"
assert_eq "pathscope allow src/foo.test-utils.ts no deny" "" "$out"

echo ""
echo "=== pretooluse-pipeline-guards: path-scope — not triggered in postexec stage ==="

_seed_run "run-pathscope-postexec" '{"status":"running","tasks":{"t1":{"status":"executing","stage":"postexec"}}}'
input='{"tool_name":"Write","tool_input":{"file_path":"src/foo.ts"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_AUTONOMOUS_MODE=1 FACTORY_TASK_ID=t1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "pathscope postexec src/foo.ts exit 0" "0" "$rc"
assert_eq "pathscope postexec src/foo.ts no deny" "" "$out"

echo ""
echo "=== pretooluse-pipeline-guards: path-scope — not triggered when no active run ==="

rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
input='{"tool_name":"Write","tool_input":{"file_path":"src/foo.ts"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_AUTONOMOUS_MODE=1 FACTORY_TASK_ID=t1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "pathscope no-run exit 0" "0" "$rc"
assert_eq "pathscope no-run no deny" "" "$out"

# ============================================================
echo ""
echo "=== subagent-stop-transcript: parses STATUS line + worktree ==="

_seed_run "run-sag" '{"status":"running","tasks":{"alpha-001":{"status":"executing"}}}'
transcript="$CLAUDE_PLUGIN_DATA/runs/run-sag/transcript.jsonl"
cat > "$transcript" <<EOF
{"role":"user","content":[{"type":"text","text":"see .state/run-sag/alpha-001.executor-prompt.md"}]}
{"tool_use":{"input":{"cwd":"/tmp/fake/.claude/worktrees/agent-zzz"}}}
EOF
input=$(jq -cn --arg t "$transcript" --arg msg "Done.
STATUS: DONE" '{agent_type:"task-executor", last_assistant_message:$msg, agent_transcript_path:$t}')
set +e
printf '%s' "$input" | bash "$HOOKS_DIR/subagent-stop-transcript.sh" >/dev/null 2>&1
rc=$?
set -e
assert_eq "subagent-stop exit 0" "0" "$rc"
exec_status=$(jq -r '.tasks."alpha-001".executor_status // empty' "$CLAUDE_PLUGIN_DATA/runs/run-sag/state.json")
assert_eq "subagent-stop writes executor_status" "DONE" "$exec_status"
wt=$(jq -r '.tasks."alpha-001".worktree // empty' "$CLAUDE_PLUGIN_DATA/runs/run-sag/state.json")
assert_eq "subagent-stop writes worktree" "/tmp/fake/.claude/worktrees/agent-zzz" "$wt"

echo ""
echo "=== subagent-stop-transcript: missing STATUS -> BLOCKED ==="

_seed_run "run-sag-missing" '{"status":"running","tasks":{"alpha-001":{"status":"executing"}}}'
transcript="$CLAUDE_PLUGIN_DATA/runs/run-sag-missing/transcript.jsonl"
printf '{"content":".state/run-sag-missing/alpha-001.executor-prompt.md"}\n' > "$transcript"
input=$(jq -cn --arg t "$transcript" '{agent_type:"task-executor", last_assistant_message:"No status marker", agent_transcript_path:$t}')
set +e
printf '%s' "$input" | bash "$HOOKS_DIR/subagent-stop-transcript.sh" >/dev/null 2>&1
set -e
exec_status=$(jq -r '.tasks."alpha-001".executor_status // empty' "$CLAUDE_PLUGIN_DATA/runs/run-sag-missing/state.json")
assert_eq "subagent-stop missing STATUS = BLOCKED" "BLOCKED" "$exec_status"

echo ""
echo "=== subagent-stop-transcript: STATUS regex accepts NO_WORK and SKIP ==="

# Regression (P2 from 2026-05-27 audit): hooks/subagent-stop-gate.sh accepts
# STATUS values NO_WORK and SKIP as legitimate no-op exits, but the transcript
# hook's STATUS regex omitted them — so a subagent that emitted STATUS: NO_WORK
# cleared the gate yet got recorded as BLOCKED in state, and the orchestrator
# treated the legitimate no-op as a stall. The two regexes must agree.

# (a) Static check: the regex line must list all 7 statuses.
_regex_line=$(grep -nE 'STATUS:\[\[:space:\]\]\+' "$HOOKS_DIR/subagent-stop-transcript.sh" | head -1)
assert_eq "transcript STATUS regex line found" "true" \
  "$([[ -n "$_regex_line" ]] && echo true || echo false)"
for _tok in DONE DONE_WITH_CONCERNS BLOCKED NEEDS_CONTEXT RED_READY NO_WORK SKIP; do
  assert_eq "transcript STATUS regex contains $_tok" "true" \
    "$(printf '%s' "$_regex_line" | grep -q "$_tok" && echo true || echo false)"
done

# (b) Behavioral check: STATUS: NO_WORK must be recorded as NO_WORK, not BLOCKED.
_seed_run "run-sag-nowork" '{"status":"running","tasks":{"alpha-001":{"status":"executing"}}}'
transcript="$CLAUDE_PLUGIN_DATA/runs/run-sag-nowork/transcript.jsonl"
printf '{"content":".state/run-sag-nowork/alpha-001.test-writer-prompt.md"}\n' > "$transcript"
input=$(jq -cn --arg t "$transcript" --arg msg "No missing tests.
STATUS: NO_WORK" '{agent_type:"test-writer", last_assistant_message:$msg, agent_transcript_path:$t}')
set +e
printf '%s' "$input" | bash "$HOOKS_DIR/subagent-stop-transcript.sh" >/dev/null 2>&1
set -e
tw_status=$(jq -r '.tasks."alpha-001".test_writer_status // empty' "$CLAUDE_PLUGIN_DATA/runs/run-sag-nowork/state.json")
assert_eq "transcript records NO_WORK (not BLOCKED)" "NO_WORK" "$tw_status"

# (c) Behavioral check: STATUS: SKIP must be recorded as SKIP, not BLOCKED.
_seed_run "run-sag-skip" '{"status":"running","tasks":{"alpha-001":{"status":"executing"}}}'
transcript="$CLAUDE_PLUGIN_DATA/runs/run-sag-skip/transcript.jsonl"
printf '{"content":".state/run-sag-skip/alpha-001.test-writer-prompt.md"}\n' > "$transcript"
input=$(jq -cn --arg t "$transcript" --arg msg "Skipping per spec.
STATUS: SKIP" '{agent_type:"test-writer", last_assistant_message:$msg, agent_transcript_path:$t}')
set +e
printf '%s' "$input" | bash "$HOOKS_DIR/subagent-stop-transcript.sh" >/dev/null 2>&1
set -e
tw_status=$(jq -r '.tasks."alpha-001".test_writer_status // empty' "$CLAUDE_PLUGIN_DATA/runs/run-sag-skip/state.json")
assert_eq "transcript records SKIP (not BLOCKED)" "SKIP" "$tw_status"

echo ""
echo "=== subagent-stop-transcript: reviewer writes review_files ==="

_seed_run "run-sag-rev" '{"status":"running","tasks":{"alpha-001":{"status":"reviewing"}}}'
transcript="$CLAUDE_PLUGIN_DATA/runs/run-sag-rev/transcript.jsonl"
printf '{"content":".state/run-sag-rev/alpha-001.reviewer-prompt.md"}\n' > "$transcript"
msg='{"decision":"APPROVE","blockers":[],"concerns":[]}
STATUS: DONE'
input=$(jq -cn --arg t "$transcript" --arg msg "$msg" '{agent_type:"implementation-reviewer", last_assistant_message:$msg, agent_transcript_path:$t}')
set +e
printf '%s' "$input" | bash "$HOOKS_DIR/subagent-stop-transcript.sh" >/dev/null 2>&1
set -e
rev_files=$(jq -r '.tasks."alpha-001".review_files // [] | length' "$CLAUDE_PLUGIN_DATA/runs/run-sag-rev/state.json")
assert_eq "subagent-stop writes 1 review_file" "1" "$rev_files"
first=$(jq -r '.tasks."alpha-001".review_files[0] // empty' "$CLAUDE_PLUGIN_DATA/runs/run-sag-rev/state.json")
assert_eq "review_file exists on disk" "true" "$([[ -f "$first" ]] && echo true || echo false)"

echo ""
echo "=== subagent-stop-transcript: holdout-reviewer routes output to holdout_review_file ==="

# Regression (Issue 2b): the holdout reviewer reuses subagent_type=
# implementation-reviewer; the hook must detect the role from the
# `<task>.holdout-reviewer-prompt.md` reference in the transcript and write
# the review file path to `.tasks.<id>.holdout_review_file` (single field),
# NOT to `.tasks.<id>.review_files[]` (which postreview consumes).
_seed_run "run-sag-holdout" '{"status":"running","tasks":{"alpha-001":{"status":"executing"}}}'
transcript="$CLAUDE_PLUGIN_DATA/runs/run-sag-holdout/transcript.jsonl"
printf '{"content":".state/run-sag-holdout/alpha-001.holdout-reviewer-prompt.md"}\n' > "$transcript"
msg='{"criteria":[{"criterion":"x","satisfied":true,"evidence":"src/a.ts:1"}]}
STATUS: DONE'
input=$(jq -cn --arg t "$transcript" --arg msg "$msg" '{agent_type:"implementation-reviewer", last_assistant_message:$msg, agent_transcript_path:$t}')
set +e
printf '%s' "$input" | bash "$HOOKS_DIR/subagent-stop-transcript.sh" >/dev/null 2>&1
rc=$?
set -e
assert_eq "holdout-reviewer: exit 0" "0" "$rc"
hf=$(jq -r '.tasks."alpha-001".holdout_review_file // empty' "$CLAUDE_PLUGIN_DATA/runs/run-sag-holdout/state.json")
assert_eq "holdout-reviewer: holdout_review_file populated" "true" \
  "$([[ -n "$hf" && -f "$hf" ]] && echo true || echo false)"
# File content should be the reviewer's JSON (last_assistant_message).
[[ -n "$hf" && -f "$hf" ]] && grep -q '"criterion":"x"' "$hf" \
  && { echo "  PASS: holdout-reviewer review body persisted"; pass=$((pass+1)); } \
  || { echo "  FAIL: holdout-reviewer review body missing"; fail=$((fail+1)); }
# review_files[] MUST stay empty — postreview consumes that array and should
# not see the holdout artifact.
rev_files_len=$(jq -r '(.tasks."alpha-001".review_files // []) | length' "$CLAUDE_PLUGIN_DATA/runs/run-sag-holdout/state.json")
assert_eq "holdout-reviewer: review_files[] empty" "0" "$rev_files_len"
# Distinct review-path filename so the holdout artifact never collides with
# a regular implementation-reviewer output written for the same task.
[[ "$hf" == *".holdout-reviewer.md" ]] \
  && { echo "  PASS: holdout-reviewer file named *.holdout-reviewer.md"; pass=$((pass+1)); } \
  || { echo "  FAIL: holdout-reviewer file misnamed ($hf)"; fail=$((fail+1)); }

echo ""
echo "=== subagent-stop-transcript: regular implementation-reviewer still uses review_files ==="

# Sanity: when the transcript references the regular reviewer-prompt.md (not
# the holdout-reviewer-prompt.md), the hook must continue writing to
# review_files[] and leave holdout_review_file unset.
_seed_run "run-sag-reg-impl" '{"status":"running","tasks":{"alpha-001":{"status":"reviewing"}}}'
transcript="$CLAUDE_PLUGIN_DATA/runs/run-sag-reg-impl/transcript.jsonl"
printf '{"content":".state/run-sag-reg-impl/alpha-001.reviewer-prompt.md"}\n' > "$transcript"
msg='{"decision":"APPROVE","blockers":[],"concerns":[]}
STATUS: DONE'
input=$(jq -cn --arg t "$transcript" --arg msg "$msg" '{agent_type:"implementation-reviewer", last_assistant_message:$msg, agent_transcript_path:$t}')
set +e
printf '%s' "$input" | bash "$HOOKS_DIR/subagent-stop-transcript.sh" >/dev/null 2>&1
set -e
hf_empty=$(jq -r '.tasks."alpha-001".holdout_review_file // empty' "$CLAUDE_PLUGIN_DATA/runs/run-sag-reg-impl/state.json")
assert_eq "regular impl-reviewer: holdout_review_file unset" "" "$hf_empty"
rev_files_len=$(jq -r '(.tasks."alpha-001".review_files // []) | length' "$CLAUDE_PLUGIN_DATA/runs/run-sag-reg-impl/state.json")
assert_eq "regular impl-reviewer: review_files[] has 1 entry" "1" "$rev_files_len"

echo ""
echo "=== subagent-stop-transcript: header-marker derivation (task_id + holdout + worktree from transcript) ==="

# Regression: when the orchestrator inlines prompt CONTENT into Agent(prompt=...),
# the [task:<id>] and [role:holdout-reviewer] headers land in the agent's transcript.
# The hook must derive task_id from [task:<id>], detect holdout from [role:holdout-reviewer],
# and derive worktree from the transcript cwd — with NO .active-spawn.json present.
HMRUN="run-hdr-$$"
HMDIR="$CLAUDE_PLUGIN_DATA/runs/$HMRUN"
mkdir -p "$HMDIR/.state/$HMRUN"
printf '{"status":"running","tasks":{"events-bus-factory":{"status":"reviewing"}}}' > "$HMDIR/state.json"
ln -sfn "$HMDIR" "$CLAUDE_PLUGIN_DATA/runs/current"

HM_TS="$HMDIR/transcript-hdr.jsonl"
cat > "$HM_TS" <<'JSONL'
{"type":"user","message":{"content":"[task:events-bus-factory]\n[role:holdout-reviewer]\nLayer 4 holdout validation..."}}
{"type":"assistant","cwd":"/Users/x/proj/.claude/worktrees/agent-deadbeef","message":{"content":"STATUS: DONE"}}
JSONL

input=$(jq -cn --arg t "$HM_TS" --arg msg "Review done.
STATUS: DONE" '{agent_type:"implementation-reviewer", last_assistant_message:$msg, agent_transcript_path:$t}')
set +e
printf '%s' "$input" | bash "$HOOKS_DIR/subagent-stop-transcript.sh" >/dev/null 2>&1
set -e

HR_FILE=$(jq -r '.tasks."events-bus-factory".holdout_review_file // empty' "$HMDIR/state.json" 2>/dev/null)
[[ -n "$HR_FILE" && "$HR_FILE" != "null" ]] \
  && { echo "  PASS: holdout_review_file wired from [role:holdout-reviewer] header"; pass=$((pass+1)); } \
  || { echo "  FAIL: holdout_review_file wired from header (got '$HR_FILE')"; fail=$((fail+1)); }

# implementation-reviewer writes worktree to reviewer_worktree_implementation_reviewer
# (not the bare .worktree field, which only task-executor/test-writer populate).
WT=$(jq -r '.tasks."events-bus-factory".reviewer_worktree_implementation_reviewer // empty' "$HMDIR/state.json" 2>/dev/null)
[[ "$WT" == *"/agent-deadbeef" ]] \
  && { echo "  PASS: worktree derived from transcript cwd"; pass=$((pass+1)); } \
  || { echo "  FAIL: worktree derived from transcript cwd (got '$WT')"; fail=$((fail+1)); }

rm -f "$CLAUDE_PLUGIN_DATA/runs/current"

echo ""
echo "=== subagent-stop-transcript: non-isolated executor keeps authoritative state worktree (retry path) ==="

# Regression (review critical finding): executor-fix / executor-ci-fix retries spawn
# task-executor WITHOUT isolation, so their transcript cwd is the orchestrator tree.
# The hook must NOT overwrite the authoritative .tasks.<id>.worktree already in state.
NIRUN="run-noiso-$$"
NIDIR="$CLAUDE_PLUGIN_DATA/runs/$NIRUN"
mkdir -p "$NIDIR/.state/$NIRUN"
printf '{"status":"running","tasks":{"beta-task":{"status":"executing","worktree":"/real/task/.claude/worktrees/agent-REAL"}}}' > "$NIDIR/state.json"
ln -sfn "$NIDIR" "$CLAUDE_PLUGIN_DATA/runs/current"

NI_TS="$NIDIR/transcript-noiso.jsonl"
cat > "$NI_TS" <<'JSONL'
{"type":"user","message":{"content":"[task:beta-task]\n[role:task-executor]\nFix reviewer-reported blockers..."}}
{"type":"assistant","cwd":"/orchestrator/.claude/worktrees/agent-ORCH","message":{"content":"STATUS: DONE"}}
JSONL

input=$(jq -cn --arg t "$NI_TS" --arg msg "Fixed.
STATUS: DONE" '{agent_type:"task-executor", last_assistant_message:$msg, agent_transcript_path:$t}')
set +e
printf '%s' "$input" | bash "$HOOKS_DIR/subagent-stop-transcript.sh" >/dev/null 2>&1
set -e

NI_WT=$(jq -r '.tasks."beta-task".worktree // empty' "$NIDIR/state.json" 2>/dev/null)
[[ "$NI_WT" == "/real/task/.claude/worktrees/agent-REAL" ]] \
  && { echo "  PASS: non-isolated executor keeps authoritative state worktree"; pass=$((pass+1)); } \
  || { echo "  FAIL: state worktree clobbered by orchestrator cwd (got '$NI_WT')"; fail=$((fail+1)); }

rm -f "$CLAUDE_PLUGIN_DATA/runs/current"

echo ""
echo "=== subagent-stop-transcript: isolated executor uses fresh transcript cwd ==="

# Counterpart: an isolated executor carries [isolation:worktree]; its fresh tree is
# only discoverable from the transcript cwd, so cwd must win over the stale state value.
ISORUN="run-iso-$$"
ISODIR="$CLAUDE_PLUGIN_DATA/runs/$ISORUN"
mkdir -p "$ISODIR/.state/$ISORUN"
printf '{"status":"running","tasks":{"gamma-iso":{"status":"executing","worktree":"/old/tw/.claude/worktrees/agent-OLD"}}}' > "$ISODIR/state.json"
ln -sfn "$ISODIR" "$CLAUDE_PLUGIN_DATA/runs/current"

ISO_TS="$ISODIR/transcript-iso.jsonl"
cat > "$ISO_TS" <<'JSONL'
{"type":"user","message":{"content":"[task:gamma-iso]\n[role:task-executor]\n[isolation:worktree]\nBootstrap: git fetch..."}}
{"type":"assistant","cwd":"/fresh/.claude/worktrees/agent-FRESH","message":{"content":"STATUS: DONE"}}
JSONL

input=$(jq -cn --arg t "$ISO_TS" --arg msg "Done.
STATUS: DONE" '{agent_type:"task-executor", last_assistant_message:$msg, agent_transcript_path:$t}')
set +e
printf '%s' "$input" | bash "$HOOKS_DIR/subagent-stop-transcript.sh" >/dev/null 2>&1
set -e

ISO_WT=$(jq -r '.tasks."gamma-iso".worktree // empty' "$ISODIR/state.json" 2>/dev/null)
[[ "$ISO_WT" == "/fresh/.claude/worktrees/agent-FRESH" ]] \
  && { echo "  PASS: isolated executor uses fresh transcript cwd"; pass=$((pass+1)); } \
  || { echo "  FAIL: isolated executor worktree (got '$ISO_WT')"; fail=$((fail+1)); }

rm -f "$CLAUDE_PLUGIN_DATA/runs/current"

echo ""
echo "=== subagent-stop-transcript: .active-spawn.json supplies task_id + worktree ==="

_seed_run "run-sag-active" '{"status":"running","tasks":{"gamma-001":{"status":"executing"}}}'
# .active-spawn.json supplies task_id (no [task:...] header in transcript).
# Worktree now comes from the transcript cwd (active-spawn worktree read is dropped
# in favor of the parallel-safe cwd grep). The transcript includes a cwd entry that
# matches the expected worktree so both sources are exercised.
transcript="$CLAUDE_PLUGIN_DATA/runs/run-sag-active/transcript.jsonl"
printf '{"role":"assistant","content":"work done","cwd":"/tmp/fake/.claude/worktrees/agent-active"}\n' > "$transcript"
jq -n --arg t "gamma-001" \
  '{run_id:"run-sag-active", task_id:$t, written_at:"2026-05-21T00:00:00Z"}' \
  > "$CLAUDE_PLUGIN_DATA/runs/run-sag-active/.active-spawn.json"
input=$(jq -cn --arg t "$transcript" --arg msg "Done.
STATUS: DONE" '{agent_type:"task-executor", last_assistant_message:$msg, agent_transcript_path:$t}')
set +e
printf '%s' "$input" | bash "$HOOKS_DIR/subagent-stop-transcript.sh" >/dev/null 2>&1
rc=$?
set -e
assert_eq "active-spawn: exit 0" "0" "$rc"
exec_status=$(jq -r '.tasks."gamma-001".executor_status // empty' "$CLAUDE_PLUGIN_DATA/runs/run-sag-active/state.json")
assert_eq "active-spawn: executor_status written" "DONE" "$exec_status"
wt=$(jq -r '.tasks."gamma-001".worktree // empty' "$CLAUDE_PLUGIN_DATA/runs/run-sag-active/state.json")
assert_eq "active-spawn: worktree written from transcript cwd" "/tmp/fake/.claude/worktrees/agent-active" "$wt"

echo ""
echo "=== subagent-stop-transcript: missing active-spawn + transcript markers -> warn but exit 0 ==="

_seed_run "run-sag-warn" '{"status":"running","tasks":{"delta-001":{"status":"executing"}}}'
# No .active-spawn.json; transcript has no prompt-file path and no cwd entry.
transcript="$CLAUDE_PLUGIN_DATA/runs/run-sag-warn/transcript.jsonl"
printf '{"role":"assistant","content":"opaque transcript"}\n' > "$transcript"
input=$(jq -cn --arg t "$transcript" --arg msg "Done.
STATUS: DONE" '{agent_type:"task-executor", last_assistant_message:$msg, agent_transcript_path:$t}')
set +e
stderr=$(printf '%s' "$input" | bash "$HOOKS_DIR/subagent-stop-transcript.sh" 2>&1 >/dev/null)
rc=$?
set -e
assert_eq "warn-path: exit 0 (advisory)" "0" "$rc"
[[ "$stderr" == *"could not derive task_id"* ]] && { echo "  PASS: warn-path stderr contains warning"; pass=$((pass+1)); } || { echo "  FAIL: warn-path stderr missing warning (got: $stderr)"; fail=$((fail+1)); }
log_file="$CLAUDE_PLUGIN_DATA/runs/run-sag-warn/transcript-errors.log"
[[ -f "$log_file" ]] && grep -q "could not derive task_id" "$log_file" \
  && { echo "  PASS: warn-path appended to transcript-errors.log"; pass=$((pass+1)); } \
  || { echo "  FAIL: warn-path transcript-errors.log missing entry"; fail=$((fail+1)); }

echo ""
echo "=== subagent-stop-transcript: scribe writes .scribe.status ==="

_seed_run "run-sag-scribe" '{"status":"running","tasks":{}}'
input=$(jq -cn '{agent_type:"scribe", last_assistant_message:"Updated 3 docs.\nSTATUS: DONE", agent_transcript_path:""}')
set +e
printf '%s' "$input" | bash "$HOOKS_DIR/subagent-stop-transcript.sh" >/dev/null 2>&1
set -e
scribe_status=$(jq -r '.scribe.status // empty' "$CLAUDE_PLUGIN_DATA/runs/run-sag-scribe/state.json")
assert_eq "subagent-stop sets .scribe.status=done" "done" "$scribe_status"

# ============================================================
echo ""
echo "=== Bug 1: hooks source pipeline-lib.sh in top 15 lines (canonicalization) ==="

# Static check: every hook that reads ${CLAUDE_PLUGIN_DATA} before guarding on
# the symlink must source pipeline-lib.sh near the top so a foreign-plugin
# leak (CLAUDE_PLUGIN_DATA pointing at e.g. codex-openai-codex/) is rewritten
# by the lib's _factory_expected_data_dir redirect before any state lookup.
# Threshold = 35 lines accommodates the docstring + set -euo prelude in each
# hook; the load-bearing requirement is "before the first CLAUDE_PLUGIN_DATA
# read", not a specific line number.
# subagent-stop-gate.sh is included — it already sourced the lib pre-fix.
# asyncrewake-ci.sh: lib is sourced early (right after `set -euo pipefail`) so
# the version-gate's reads under CLAUDE_PLUGIN_DATA are canonicalized first.
for _hook in subagent-stop-transcript.sh run-tracker.sh pretooluse-pipeline-guards.sh \
             session-start-resume.sh stop-gate.sh secret-commit-guard.sh \
             write-protection.sh subagent-stop-gate.sh asyncrewake-ci.sh \
             session-start; do
  top_lines=$(head -35 "$HOOKS_DIR/$_hook")
  matches=$(printf '%s\n' "$top_lines" | grep -c 'pipeline-lib.sh' || true)
  if [[ "$matches" -ge 1 ]]; then
    assert_eq "$_hook sources pipeline-lib.sh near top" "ok" "ok"
  else
    assert_eq "$_hook sources pipeline-lib.sh near top" "ok" "MISSING"
  fi
done

echo ""
echo "=== subagent-stop-transcript: canonicalizes foreign CLAUDE_PLUGIN_DATA ==="

# Integration check (option ii from the spec): drive the actual redirect path
# in pipeline-lib.sh. Requires CLAUDE_PLUGIN_DATA to start with
# $HOME/.claude/plugins/data/ and a manifest under $HOME/.claude/plugins/cache/
# whose name disagrees with the env-var basename.
#
# Strategy: hijack HOME for the duration of this single hook invocation.
_canon_home=$(mktemp -d)
mkdir -p "$_canon_home/.claude/plugins/data"
# Mock cache layout: cache/<marketplace>/<plugin>/<version>/.claude-plugin/plugin.json
_plugin_name=$(jq -r '.name' "$BIN_DIR/../.claude-plugin/plugin.json")
_mp_name="testmp"
_cache_plugin_root="$_canon_home/.claude/plugins/cache/$_mp_name/$_plugin_name/0.1.0"
mkdir -p "$_cache_plugin_root/.claude-plugin" "$_cache_plugin_root/bin" "$_cache_plugin_root/hooks"
printf '{"name":"%s","version":"0.1.0"}' "$_plugin_name" > "$_cache_plugin_root/.claude-plugin/plugin.json"
# Copy the real pipeline-lib so _factory_expected_data_dir resolves under the fake HOME.
cp "$BIN_DIR/pipeline-lib.sh" "$_cache_plugin_root/bin/pipeline-lib.sh"
# Copy the hook (since CLAUDE_PLUGIN_ROOT must be the cache root for the
# redirect to derive `<plugin>-<marketplace>`).
cp "$HOOKS_DIR/subagent-stop-transcript.sh" "$_cache_plugin_root/hooks/subagent-stop-transcript.sh"

# Set up correct (factory's) and foreign data dirs under the fake HOME.
_correct_data="$_canon_home/.claude/plugins/data/${_plugin_name}-${_mp_name}"
_foreign_data="$_canon_home/.claude/plugins/data/codex-openai-codex"
mkdir -p "$_correct_data/runs" "$_foreign_data/runs"

# Seed an active run in the CORRECT data dir.
_run_id="run-canon-x"
mkdir -p "$_correct_data/runs/$_run_id"
printf '{"status":"running","tasks":{"task_zz":{"status":"executing"}}}' \
  > "$_correct_data/runs/$_run_id/state.json"
ln -sfn "$_correct_data/runs/$_run_id" "$_correct_data/runs/current"
printf '{"task_id":"task_zz"}' > "$_correct_data/runs/$_run_id/.active-spawn.json"

# Invoke the hook with the FOREIGN data dir env-var. The lib's redirect must
# rewrite CLAUDE_PLUGIN_DATA inside the hook, so the state write lands in
# $_correct_data, not $_foreign_data.
input='{"agent_type":"task-executor","last_assistant_message":"STATUS: DONE"}'
set +e
HOME="$_canon_home" \
  CLAUDE_PLUGIN_DATA="$_foreign_data" \
  CLAUDE_PLUGIN_ROOT="$_cache_plugin_root" \
  PATH="$BIN_DIR:$PATH" \
  bash "$_cache_plugin_root/hooks/subagent-stop-transcript.sh" <<<"$input" >/dev/null 2>&1
_canon_rc=$?
set -e
assert_eq "canonicalize: hook exit 0" "0" "$_canon_rc"
_canon_status=$(jq -r '.tasks.task_zz.executor_status // empty' "$_correct_data/runs/$_run_id/state.json")
assert_eq "canonicalize: state landed in correct data dir" "DONE" "$_canon_status"
# Foreign data dir must remain untouched (no runs/<run-id> ever created there).
[[ ! -e "$_foreign_data/runs/$_run_id" ]] \
  && { echo "  PASS: canonicalize: foreign data dir untouched"; pass=$((pass+1)); } \
  || { echo "  FAIL: canonicalize: foreign data dir got written to"; fail=$((fail+1)); }

rm -rf "$_canon_home"

echo ""
echo "=== subagent-stop-transcript: loud-on-missing symlink ==="

# When CLAUDE_PLUGIN_DATA IS set but runs/current symlink is genuinely missing
# (post-canonicalization), the hook must log loudly to stderr + hook-errors.log
# and still exit 0 (best-effort).
_loud_data=$(mktemp -d)
mkdir -p "$_loud_data/runs"
# Intentionally NO symlink at $_loud_data/runs/current.
set +e
_loud_err=$(printf '%s' '{"agent_type":"task-executor","last_assistant_message":"STATUS: DONE"}' \
  | CLAUDE_PLUGIN_DATA="$_loud_data" \
    bash "$HOOKS_DIR/subagent-stop-transcript.sh" 2>&1 >/dev/null)
_loud_rc=$?
set -e
assert_eq "loud-on-missing: hook exit 0 (best-effort)" "0" "$_loud_rc"
if printf '%s' "$_loud_err" | grep -q 'symlink missing'; then
  echo "  PASS: loud-on-missing: stderr contains 'symlink missing'"; pass=$((pass+1))
else
  echo "  FAIL: loud-on-missing: stderr missing diagnostic (got: $_loud_err)"; fail=$((fail+1))
fi
if [[ -f "$_loud_data/hook-errors.log" ]] && grep -q 'symlink missing' "$_loud_data/hook-errors.log"; then
  echo "  PASS: loud-on-missing: hook-errors.log written"; pass=$((pass+1))
else
  echo "  FAIL: loud-on-missing: hook-errors.log missing or empty"; fail=$((fail+1))
fi
rm -rf "$_loud_data"

# ============================================================
echo ""
echo "=== session-start (Iron Laws): emits valid JSON with Iron Laws digest ==="

set +e
out=$(bash "$HOOKS_DIR/session-start" 2>/dev/null)
rc=$?
set -e
assert_eq "session-start Iron Laws exit 0" "0" "$rc"
event=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.hookEventName // empty')
assert_eq "session-start Iron Laws event name" "SessionStart" "$event"
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // empty')
[[ "$ctx" == *"FACTORY_HARNESS_REMINDER"* ]] && { echo "  PASS: session-start ctx has harness reminder tag"; pass=$((pass+1)); } || { echo "  FAIL: session-start ctx missing FACTORY_HARNESS_REMINDER tag"; fail=$((fail+1)); }
[[ "$ctx" == *"Iron Laws"* ]] && { echo "  PASS: session-start ctx contains Iron Laws"; pass=$((pass+1)); } || { echo "  FAIL: session-start ctx missing Iron Laws"; fail=$((fail+1)); }
[[ "$ctx" == *"Red Flags"* ]] && { echo "  PASS: session-start ctx contains Red Flags"; pass=$((pass+1)); } || { echo "  FAIL: session-start ctx missing Red Flags"; fail=$((fail+1)); }
[[ "$ctx" == *"pipeline-run-task"* ]] && { echo "  PASS: session-start ctx mentions wrapper"; pass=$((pass+1)); } || { echo "  FAIL: session-start ctx missing wrapper reference"; fail=$((fail+1)); }

echo ""
echo "=== session-start (Iron Laws): appends stage-state when active run exists ==="

_seed_run "run-laws-active" '{"status":"running","tasks":{"task-1":{"status":"executing","stage":"preflight_done"}}}'
set +e
out=$(bash "$HOOKS_DIR/session-start" 2>/dev/null)
rc=$?
set -e
assert_eq "session-start active run exit 0" "0" "$rc"
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // empty')
[[ "$ctx" == *"run-laws-active"* ]] && { echo "  PASS: session-start ctx contains run id"; pass=$((pass+1)); } || { echo "  FAIL: session-start ctx missing run id"; fail=$((fail+1)); }
[[ "$ctx" == *"pipeline-run-task"* ]] && { echo "  PASS: session-start ctx has resume command"; pass=$((pass+1)); } || { echo "  FAIL: session-start ctx missing resume command"; fail=$((fail+1)); }
[[ "$ctx" == *"--stage preexec_tests"* ]] && { echo "  PASS: session-start recommends --stage preexec_tests"; pass=$((pass+1)); } || { echo "  FAIL: session-start ctx missing --stage preexec_tests"; fail=$((fail+1)); }
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"

echo ""
echo "=== session-start (Iron Laws): interrupted run shows stage summary (resumable) ==="

_seed_run "run-laws-interrupted" '{"status":"interrupted","tasks":{"task-1":{"status":"interrupted","stage":"preexec_tests_done"}}}'
set +e
out=$(bash "$HOOKS_DIR/session-start" 2>/dev/null)
rc=$?
set -e
assert_eq "session-start interrupted run exit 0" "0" "$rc"
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // empty')
[[ "$ctx" == *"run-laws-interrupted"* ]] && { echo "  PASS: session-start interrupted run shows run id (resumable)"; pass=$((pass+1)); } || { echo "  FAIL: session-start interrupted run should show run id"; fail=$((fail+1)); }
[[ "$ctx" == *"--stage postexec"* ]] && { echo "  PASS: session-start interrupted maps preexec_tests_done → postexec"; pass=$((pass+1)); } || { echo "  FAIL: session-start interrupted stage transition wrong"; fail=$((fail+1)); }
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"

echo ""
echo "=== session-start (Iron Laws): no active run still emits digest ==="

set +e
out=$(bash "$HOOKS_DIR/session-start" 2>/dev/null)
rc=$?
set -e
assert_eq "session-start no run exit 0" "0" "$rc"
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // empty')
[[ "$ctx" == *"Iron Laws"* ]] && { echo "  PASS: session-start no-run ctx still has Iron Laws"; pass=$((pass+1)); } || { echo "  FAIL: session-start no-run ctx missing Iron Laws"; fail=$((fail+1)); }

echo ""
echo "=== session-start (Iron Laws): terminal run omits stage summary ==="

_seed_run "run-laws-done" '{"status":"done","tasks":{"t1":{"status":"done"}}}'
set +e
out=$(bash "$HOOKS_DIR/session-start" 2>/dev/null)
rc=$?
set -e
assert_eq "session-start terminal run exit 0" "0" "$rc"
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // empty')
[[ "$ctx" != *"run-laws-done"* ]] && { echo "  PASS: session-start terminal run omits run id from stage summary"; pass=$((pass+1)); } || { echo "  FAIL: session-start terminal run should not show run id"; fail=$((fail+1)); }
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"

# ============================================================
echo ""
echo "=== session-start-resume: injects additionalContext ==="

_seed_run "run-resume" '{"status":"running","tasks":{"alpha-001":{"status":"executing","stage":"preflight_done"},"alpha-002":{"status":"pending"}}}'
export CLAUDE_ENV_FILE=$(mktemp)
set +e
out=$(printf '{"source":"resume"}' | bash "$HOOKS_DIR/session-start-resume.sh")
rc=$?
set -e
assert_eq "session-start exit 0" "0" "$rc"
event=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.hookEventName // empty')
assert_eq "session-start event name" "SessionStart" "$event"
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // empty')
[[ "$ctx" == *"Resuming pipeline run"* ]] && { echo "  PASS: session-start ctx contains resume header"; pass=$((pass+1)); } || { echo "  FAIL: session-start ctx missing header"; fail=$((fail+1)); }
[[ "$ctx" == *"pipeline-run-task"* ]] && { echo "  PASS: session-start ctx names wrapper"; pass=$((pass+1)); } || { echo "  FAIL: session-start ctx missing wrapper reference"; fail=$((fail+1)); }
env_contents=$(cat "$CLAUDE_ENV_FILE" 2>/dev/null)
[[ "$env_contents" == *"FACTORY_CURRENT_RUN"* ]] && { echo "  PASS: session-start exports FACTORY_CURRENT_RUN"; pass=$((pass+1)); } || { echo "  FAIL: FACTORY_CURRENT_RUN not exported"; fail=$((fail+1)); }
rm -f "$CLAUDE_ENV_FILE"
unset CLAUDE_ENV_FILE

echo ""
echo "=== session-start-resume: non-resume source no-ops ==="

set +e
out=$(printf '{"source":"startup"}' | bash "$HOOKS_DIR/session-start-resume.sh")
rc=$?
set -e
assert_eq "session-start non-resume exit 0" "0" "$rc"
assert_eq "session-start non-resume no output" "" "$out"

echo ""
echo "=== session-start-resume: terminal run no-ops ==="

_seed_run "run-resume-done" '{"status":"done","tasks":{"x":{"status":"done"}}}'
set +e
out=$(printf '{"source":"resume"}' | bash "$HOOKS_DIR/session-start-resume.sh")
set -e
assert_eq "session-start terminal no output" "" "$out"

echo ""
echo "=== session-start-resume: complete stage map ==="

# Each case: stage in state.json → expected --stage in resume command.
_resume_stage_check() {
  local label="$1" stage_in="$2" expect="$3"
  local rid="run-resume-map-$(printf '%s' "$label" | tr -c '[:alnum:]' '-')"
  _seed_run "$rid" "$(jq -cn --arg s "$stage_in" '{status:"running",tasks:{"t-1":{status:"executing",stage:$s}}}')"
  export CLAUDE_ENV_FILE=$(mktemp)
  local out ctx
  out=$(printf '{"source":"resume"}' | bash "$HOOKS_DIR/session-start-resume.sh")
  ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // empty')
  if [[ "$ctx" == *"--stage $expect"* ]]; then
    echo "  PASS: stage map $stage_in → $expect"; pass=$((pass+1))
  else
    echo "  FAIL: stage map $stage_in expected '--stage $expect' in: $ctx"; fail=$((fail+1))
  fi
  rm -f "$CLAUDE_ENV_FILE"; unset CLAUDE_ENV_FILE
  rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
}

_resume_stage_check "preflight_done"            "preflight_done"            "preexec_tests"
_resume_stage_check "preexec_tests_done"        "preexec_tests_done"        "postexec"
_resume_stage_check "postexec_spawn_pending"    "postexec_spawn_pending"    "postexec"
_resume_stage_check "postexec_done"             "postexec_done"             "postreview"
_resume_stage_check "postreview_pending_human"  "postreview_pending_human"  "ship"
_resume_stage_check "postreview_exhausted"      "postreview_exhausted"      "ship"
_resume_stage_check "postreview_done"           "postreview_done"           "ship"
_resume_stage_check "ship_done"                 "ship_done"                 "finalize-run"
_resume_stage_check "unknown_stage_default"     "weird_state"               "preflight"

# ============================================================
echo ""
echo "=== asyncrewake-ci: no-op when Claude version below minimum ==="

set +e
out=$(printf '{"tool_input":{"command":"gh pr create"}}' | CLAUDE_VERSION=1.5.0 bash "$HOOKS_DIR/asyncrewake-ci.sh" 2>/dev/null)
rc=$?
set -e
assert_eq "asyncrewake old-version exit 0" "0" "$rc"
assert_eq "asyncrewake old-version no output" "" "$out"

echo ""
echo "=== asyncrewake-ci: no-op for non-pr-create commands ==="

set +e
printf '{"tool_input":{"command":"ls"}}' | bash "$HOOKS_DIR/asyncrewake-ci.sh" >/dev/null 2>&1
rc=$?
set -e
assert_eq "asyncrewake non-pr exit 0" "0" "$rc"

# ============================================================
echo ""
echo "=== settings.autonomous.json registers Layer-2 hooks ==="

autonom="$(cd "$(dirname "$0")/../../templates" && pwd)/settings.autonomous.json"
base_hooks="$(cd "$(dirname "$0")/../../hooks" && pwd)/hooks.json"
assert_eq "template has SubagentStop"        "1" "$(jq '.hooks.SubagentStop | length' "$autonom")"
assert_eq "SubagentStop matcher allows factory: prefix" "^(factory:)?(test-writer|task-executor|implementation-reviewer|quality-reviewer|security-reviewer|architecture-reviewer|scribe|spec-generator|spec-reviewer)$" "$(jq -r '.hooks.SubagentStop[0].matcher' "$autonom")"
assert_eq "template has SessionStart"        "2" "$(jq '.hooks.SessionStart | length' "$autonom")"
assert_eq "template PostToolUse has asyncRewake" "1" "$(jq '[.hooks.PostToolUse[].hooks[]? | select(.asyncRewake == true)] | length' "$autonom")"
# pipeline-guards lives in base hooks/hooks.json (autonomous overlay would
# double-register it). See d8ddaee.
assert_eq "autonomous overlay does NOT redundantly register pipeline-guards" "0" "$(jq '[.hooks.PreToolUse[].hooks[]? | select(.command | test("pretooluse-pipeline-guards"))] | length' "$autonom")"
assert_eq "base hooks.json registers pipeline-guards" "2" "$(jq '[.hooks.PreToolUse[].hooks[]? | select(.command | test("pretooluse-pipeline-guards"))] | length' "$base_hooks")"
assert_eq "template does NOT redundantly allow Bash(codex *) under Bash(*)" "false" "$(jq '[.permissions.allow[] | select(. == "Bash(codex *)")] | length > 0' "$autonom")"
assert_eq "template allows Read on plugin data dir" "1" "$(jq '[.permissions.allow[] | select(. == "Read(${CLAUDE_PLUGIN_DATA}/**)")] | length' "$autonom")"
assert_eq "template allows Write on plugin data dir" "1" "$(jq '[.permissions.allow[] | select(. == "Write(${CLAUDE_PLUGIN_DATA}/**)")] | length' "$autonom")"
assert_eq "template allows Edit on plugin data dir" "1" "$(jq '[.permissions.allow[] | select(. == "Edit(${CLAUDE_PLUGIN_DATA}/**)")] | length' "$autonom")"
assert_eq "template does NOT deny ~/.claude/** globally" "0" "$(jq '[.permissions.deny[] | select(. | test("~/.claude/\\*\\*"))] | length' "$autonom")"
assert_eq "template denies write on settings.json" "1" "$(jq '[.permissions.deny[] | select(. == "Write(~/.claude/settings.json)")] | length' "$autonom")"
assert_eq ".claude hook allows CLAUDE_PLUGIN_DATA escape" "true" "$(jq -r '[.hooks.PreToolUse[].hooks[]?.command // ""] | join(" ")' "$autonom" | grep -q 'CLAUDE_PLUGIN_DATA' && echo true || echo false)"

rm -f "$CLAUDE_PLUGIN_DATA/runs/current"

# ============================================================
echo ""
echo "=== asyncrewake-ci: merge polling — CI green + merged quickly → exit 2 ==="

ARW_DATA=$(mktemp -d)
ARW_STUBS=$(mktemp -d)
ARW_PR=9876

cat > "$ARW_STUBS/pipeline-state" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$ARW_STUBS/pipeline-state"

# gh: statusCheckRollup → green, state,mergedAt → MERGED
cat > "$ARW_STUBS/gh" <<'SH'
#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"statusCheckRollup"* ]]; then
  printf '{"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","state":null}]}'
elif [[ "$args" == *"state,mergedAt"* ]]; then
  printf '{"state":"MERGED","mergedAt":"2026-04-21T08:00:00Z"}'
fi
exit 0
SH
chmod +x "$ARW_STUBS/gh"

mkdir -p "$ARW_DATA/runs/run-mock-merge"
ln -sf "$ARW_DATA/runs/run-mock-merge" "$ARW_DATA/runs/current"
printf '{"tasks":{"task-1":{"task_id":"task-1","status":"executing","pr_number":%s}}}' \
  "$ARW_PR" > "$ARW_DATA/runs/run-mock-merge/state.json"

ARW_INPUT=$(jq -n --arg pr "https://github.com/acme/repo/pull/$ARW_PR" \
  '{"tool_input":{"command":"gh pr create"},"tool_response":{"stdout":$pr}}')

set +e
ASYNCREWAKE_CI_MAX=1 ASYNCREWAKE_CI_SLEEP=0 \
ASYNCREWAKE_MERGE_MAX=2 ASYNCREWAKE_MERGE_SLEEP=0 \
CLAUDE_PLUGIN_DATA="$ARW_DATA" CLAUDE_VERSION=99.0.0 \
PATH="$ARW_STUBS:$PATH" \
bash "$HOOKS_DIR/asyncrewake-ci.sh" <<< "$ARW_INPUT" >/dev/null 2>/dev/null
ARW_RC=$?
set -e
assert_eq "asyncrewake merge poll: exit 2 (wake orchestrator)" "2" "$ARW_RC"
rm -rf "$ARW_DATA" "$ARW_STUBS"

# ============================================================
echo ""
echo "=== asyncrewake-ci: merge polling — CI green + stalled → exit 2 + stderr ==="

ARW_DATA=$(mktemp -d)
ARW_STUBS=$(mktemp -d)
ARW_PR=9877

cat > "$ARW_STUBS/pipeline-state" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$ARW_STUBS/pipeline-state"

# gh: CI green, PR stays OPEN (stalled auto-merge)
cat > "$ARW_STUBS/gh" <<'SH'
#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"statusCheckRollup"* ]]; then
  printf '{"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","state":null}]}'
elif [[ "$args" == *"state,mergedAt"* ]]; then
  printf '{"state":"OPEN","mergedAt":null}'
fi
exit 0
SH
chmod +x "$ARW_STUBS/gh"

mkdir -p "$ARW_DATA/runs/run-mock-stall"
ln -sf "$ARW_DATA/runs/run-mock-stall" "$ARW_DATA/runs/current"
printf '{"tasks":{"task-1":{"task_id":"task-1","status":"executing","pr_number":%s}}}' \
  "$ARW_PR" > "$ARW_DATA/runs/run-mock-stall/state.json"

ARW_INPUT=$(jq -n --arg pr "https://github.com/acme/repo/pull/$ARW_PR" \
  '{"tool_input":{"command":"gh pr create"},"tool_response":{"stdout":$pr}}')

set +e
ARW_ERR=$(ASYNCREWAKE_CI_MAX=1 ASYNCREWAKE_CI_SLEEP=0 \
          ASYNCREWAKE_MERGE_MAX=2 ASYNCREWAKE_MERGE_SLEEP=0 \
          CLAUDE_PLUGIN_DATA="$ARW_DATA" CLAUDE_VERSION=99.0.0 \
          PATH="$ARW_STUBS:$PATH" \
          bash "$HOOKS_DIR/asyncrewake-ci.sh" <<< "$ARW_INPUT" 2>&1 >/dev/null)
ARW_RC=$?
set -e
assert_eq "asyncrewake stalled: exit 2" "2" "$ARW_RC"
ARW_STALL_COUNT=$(printf '%s' "$ARW_ERR" | grep -c "stalled" || true)
[[ "$ARW_STALL_COUNT" -ge 1 ]] \
  && { echo "  PASS: asyncrewake stalled: stderr mentions stalled"; pass=$((pass+1)); } \
  || { echo "  FAIL: asyncrewake stalled: stderr missing 'stalled' (got: $ARW_ERR)"; fail=$((fail+1)); }
rm -rf "$ARW_DATA" "$ARW_STUBS"

# ============================================================
echo ""
echo "=== asyncrewake-ci: persistent gh failure → ci_status=gh_error ==="

ARW_DATA=$(mktemp -d)
ARW_STUBS=$(mktemp -d)
ARW_LOG=$(mktemp)
ARW_PR=8888

# pipeline-state stub: log all invocations + args, succeed.
cat > "$ARW_STUBS/pipeline-state" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$ARW_LOG"
exit 0
SH
chmod +x "$ARW_STUBS/pipeline-state"

# gh stub: always fail with auth error.
cat > "$ARW_STUBS/gh" <<'SH'
#!/usr/bin/env bash
echo "gh: authentication required" >&2
exit 4
SH
chmod +x "$ARW_STUBS/gh"

mkdir -p "$ARW_DATA/runs/run-gh-fail"
ln -sf "$ARW_DATA/runs/run-gh-fail" "$ARW_DATA/runs/current"
printf '{"tasks":{"task-1":{"task_id":"task-1","status":"executing","pr_number":%s}}}' \
  "$ARW_PR" > "$ARW_DATA/runs/run-gh-fail/state.json"

ARW_INPUT=$(jq -n --arg pr "https://github.com/acme/repo/pull/$ARW_PR" \
  '{"tool_input":{"command":"gh pr create"},"tool_response":{"stdout":$pr}}')

set +e
ARW_STDERR=$(
  ASYNCREWAKE_CI_MAX=10 ASYNCREWAKE_CI_SLEEP=0 \
  ASYNCREWAKE_GH_FAIL_BUDGET=2 \
  CLAUDE_PLUGIN_DATA="$ARW_DATA" CLAUDE_VERSION=99.0.0 \
  PATH="$ARW_STUBS:$PATH" \
  bash "$HOOKS_DIR/asyncrewake-ci.sh" <<< "$ARW_INPUT" 2>&1 >/dev/null
)
ARW_RC=$?
set -e
assert_eq "asyncrewake gh-fail: exit 2 (wake)" "2" "$ARW_RC"
ARW_GHFAIL_COUNT=$(printf '%s' "$ARW_STDERR" | grep -c "gh pr view failed" || true)
[[ "$ARW_GHFAIL_COUNT" -ge 1 ]] \
  && { echo "  PASS: asyncrewake gh-fail: stderr surfaces gh failure"; pass=$((pass+1)); } \
  || { echo "  FAIL: asyncrewake gh-fail: stderr missing 'gh pr view failed' (got: $ARW_STDERR)"; fail=$((fail+1)); }
state_writes=$(cat "$ARW_LOG")
ARW_GHERR_WRITES=$(printf '%s' "$state_writes" | grep -c 'ci_status "gh_error"' || true)
[[ "$ARW_GHERR_WRITES" -ge 1 ]] \
  && { echo "  PASS: asyncrewake gh-fail: writes ci_status=gh_error"; pass=$((pass+1)); } \
  || { echo "  FAIL: asyncrewake gh-fail: missing ci_status=gh_error write (got: $state_writes)"; fail=$((fail+1)); }

rm -rf "$ARW_DATA" "$ARW_STUBS" "$ARW_LOG"

# ============================================================
# subagent-stop-gate: autonomous blocking tests
# ============================================================

echo ""
echo "=== subagent-stop-gate: non-autonomous mode passes even with missing STATUS ==="

_seed_run "run-ssg-noauto" '{"status":"running","tasks":{"t1":{"status":"executing","branch":"feat/t1"}}}'
set +e
out=$(printf '{"agent_type":"task-executor","last_assistant_message":"I did some work."}' \
  | bash "$HOOKS_DIR/subagent-stop-gate.sh" 2>/dev/null)
rc=$?
set -e
assert_eq "non-autonomous missing STATUS exit 0" "0" "$rc"
assert_eq "non-autonomous no block output" "" "$out"

echo ""
echo "=== subagent-stop-gate: autonomous mode blocks on missing STATUS ==="

_seed_run "run-ssg-block-status" '{"status":"running","tasks":{"t1":{"status":"executing","branch":"feat/t1"}}}'
set +e
out=$(printf '{"agent_type":"task-executor","last_assistant_message":"I finished the work but forgot the status line."}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/subagent-stop-gate.sh" 2>/dev/null)
rc=$?
set -e
assert_eq "autonomous missing STATUS exit 1" "1" "$rc"
assert_eq "autonomous missing STATUS decision=block" "block" "$(printf '%s' "$out" | jq -r '.decision // empty')"
assert_eq "autonomous missing STATUS reason mentions STATUS" "true" \
  "$(printf '%s' "$out" | jq -r '.reason' | grep -q 'STATUS' && echo true || echo false)"

echo ""
echo "=== subagent-stop-gate: autonomous mode passes on STATUS: DONE ==="

# Use implementation-reviewer which doesn't check commits, to isolate STATUS parsing
_seed_run "run-ssg-reviewer-done" '{"status":"running","tasks":{}}'
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/run-ssg-reviewer-done/reviews"
set +e
out=$(jq -cn '{agent_type:"implementation-reviewer", last_assistant_message:"Looks good.\nSTATUS: DONE"}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/subagent-stop-gate.sh" 2>/dev/null)
rc=$?
set -e
assert_eq "autonomous STATUS: DONE reviewer exit 0" "0" "$rc"
assert_eq "autonomous STATUS: DONE no block output" "" "$out"

echo ""
echo "=== subagent-stop-gate: autonomous mode passes on STATUS: NO_WORK ==="

_seed_run "run-ssg-nowork" '{"status":"running","tasks":{}}'
set +e
out=$(jq -cn '{agent_type:"task-executor", last_assistant_message:"Nothing to do.\nSTATUS: NO_WORK"}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/subagent-stop-gate.sh" 2>/dev/null)
rc=$?
set -e
assert_eq "autonomous STATUS: NO_WORK exit 0" "0" "$rc"
assert_eq "autonomous STATUS: NO_WORK no block" "" "$out"

echo ""
echo "=== subagent-stop-gate: autonomous mode passes on STATUS: SKIP ==="

_seed_run "run-ssg-skip" '{"status":"running","tasks":{}}'
set +e
out=$(jq -cn '{agent_type:"task-executor", last_assistant_message:"Skipping.\nSTATUS: SKIP"}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/subagent-stop-gate.sh" 2>/dev/null)
rc=$?
set -e
assert_eq "autonomous STATUS: SKIP exit 0" "0" "$rc"
assert_eq "autonomous STATUS: SKIP no block" "" "$out"

echo ""
echo "=== subagent-stop-gate: autonomous mode blocks on zero commits for executor ==="

# Seed a run with a task that has a branch, but no commits on it vs staging
# Use a branch name that won't exist so git log returns empty
_seed_run "run-ssg-nocommit" '{"status":"running","tasks":{"t2":{"status":"executing","branch":"factory/test-nonexistent-branch-xyz"}}}'
set +e
out=$(jq -cn '{agent_type:"task-executor", last_assistant_message:"Done!\nSTATUS: DONE"}' \
  | FACTORY_AUTONOMOUS_MODE=1 FACTORY_TASK_ID=t2 bash "$HOOKS_DIR/subagent-stop-gate.sh" 2>/dev/null)
rc=$?
set -e
assert_eq "autonomous zero-commits exit 1" "1" "$rc"
assert_eq "autonomous zero-commits decision=block" "block" "$(printf '%s' "$out" | jq -r '.decision // empty')"
assert_eq "autonomous zero-commits reason mentions commits" "true" \
  "$(printf '%s' "$out" | jq -r '.reason' | grep -qi 'commit' && echo true || echo false)"

echo ""
echo "=== subagent-stop-gate: blocks when no staging or origin/staging ref exists ==="

# Create a real temp git repo with a branch that has a commit but no staging ref at all.
# Previously this was a fail-open (skip); after F3 fix it must block.
_ssg_tmp=$(mktemp -d)
git -C "$_ssg_tmp" init -q
git -C "$_ssg_tmp" commit --allow-empty -m "init" -q
git -C "$_ssg_tmp" checkout -b "factory/test-has-commit" -q
git -C "$_ssg_tmp" commit --allow-empty -m "task commit" -q
# Neither local staging nor origin/staging exists.

_seed_run "run-ssg-nostaging" \
  "{\"status\":\"running\",\"tasks\":{\"t-ns\":{\"status\":\"executing\",\"branch\":\"factory/test-has-commit\",\"worktree\":\"$_ssg_tmp\"}}}"
set +e
out=$(jq -cn '{agent_type:"task-executor", last_assistant_message:"Done!\nSTATUS: DONE"}' \
  | FACTORY_AUTONOMOUS_MODE=1 FACTORY_TASK_ID=t-ns bash "$HOOKS_DIR/subagent-stop-gate.sh" 2>/dev/null)
rc=$?
set -e
assert_eq "no-staging ref: exit 1 (blocked fail-closed)" "1" "$rc"
block_reason=$(printf '%s' "$out" | jq -r '.reason // empty' 2>/dev/null)
assert_eq "no-staging ref: reason mentions staging" "true" \
  "$( [[ "$block_reason" == *"staging"* ]] && echo true || echo false )"
rm -rf "$_ssg_tmp"

echo ""
echo "=== subagent-stop-gate: retry counter increments and writes BLOCKED on 2nd block ==="

_seed_run "run-ssg-retry" '{"status":"running","tasks":{"t3":{"status":"executing","branch":"factory/test-nonexistent-branch-xyz"}}}'
retry_dir="$CLAUDE_PLUGIN_DATA/runs/run-ssg-retry"

# C3: retry counter now lives in state.json (.tasks.t3.subagent_retries),
# not in a sidecar file. The hook uses the real pipeline-state binary.

# First block attempt
set +e
jq -cn '{agent_type:"task-executor", last_assistant_message:"No status."}' \
  | FACTORY_AUTONOMOUS_MODE=1 FACTORY_TASK_ID=t3 bash "$HOOKS_DIR/subagent-stop-gate.sh" >/dev/null 2>/dev/null
set -e
retry_count=$(jq -r '.tasks.t3.subagent_retries // 0' "$retry_dir/state.json" 2>/dev/null || echo 0)
assert_eq "retry file = 1 after first block" "1" "$retry_count"

# Second block attempt — should write BLOCKED to state
set +e
jq -cn '{agent_type:"task-executor", last_assistant_message:"No status."}' \
  | FACTORY_AUTONOMOUS_MODE=1 FACTORY_TASK_ID=t3 bash "$HOOKS_DIR/subagent-stop-gate.sh" >/dev/null 2>/dev/null
set -e
retry_count=$(jq -r '.tasks.t3.subagent_retries // 0' "$retry_dir/state.json" 2>/dev/null || echo 0)
assert_eq "retry file = 2 after second block" "2" "$retry_count"

# Verify BLOCKED written to state.json after 2nd block
executor_status_after=$(jq -r '.tasks.t3.executor_status // empty' "$retry_dir/state.json" 2>/dev/null || true)
assert_eq "executor_status=BLOCKED written to state after 2nd block" "BLOCKED" "$executor_status_after"
# Verify test_writer_status was NOT poisoned by the executor retry
tw_status_after=$(jq -r '.tasks.t3.test_writer_status // empty' "$retry_dir/state.json" 2>/dev/null || true)
assert_eq "task-executor retry does NOT write test_writer_status" "" "$tw_status_after"

echo "=== subagent-stop-gate: test-writer retry exhaustion writes test_writer_status (not executor_status) ==="

_seed_run "run-ssg-tw-retry" '{"status":"running","tasks":{"tw1":{"status":"executing","branch":"factory/test-nonexistent-branch-xyz"}}}'
tw_retry_dir="$CLAUDE_PLUGIN_DATA/runs/run-ssg-tw-retry"

# First block attempt
set +e
jq -cn '{agent_type:"test-writer", last_assistant_message:"No status."}' \
  | FACTORY_AUTONOMOUS_MODE=1 FACTORY_TASK_ID=tw1 bash "$HOOKS_DIR/subagent-stop-gate.sh" >/dev/null 2>/dev/null
set -e
tw_retry_count=$(jq -r '.tasks.tw1.subagent_retries // 0' "$tw_retry_dir/state.json" 2>/dev/null || echo 0)
assert_eq "tw retry file = 1 after first block" "1" "$tw_retry_count"

# Second block attempt — should write test_writer_status=BLOCKED
set +e
jq -cn '{agent_type:"test-writer", last_assistant_message:"No status."}' \
  | FACTORY_AUTONOMOUS_MODE=1 FACTORY_TASK_ID=tw1 bash "$HOOKS_DIR/subagent-stop-gate.sh" >/dev/null 2>/dev/null
set -e
tw_retry_count=$(jq -r '.tasks.tw1.subagent_retries // 0' "$tw_retry_dir/state.json" 2>/dev/null || echo 0)
assert_eq "tw retry file = 2 after second block" "2" "$tw_retry_count"

tw_status_blocked=$(jq -r '.tasks.tw1.test_writer_status // empty' "$tw_retry_dir/state.json" 2>/dev/null || true)
assert_eq "test_writer_status=BLOCKED written after 2nd test-writer block" "BLOCKED" "$tw_status_blocked"
# Verify executor_status was NOT written
exec_status_clean=$(jq -r '.tasks.tw1.executor_status // empty' "$tw_retry_dir/state.json" 2>/dev/null || true)
assert_eq "test-writer retry does NOT write executor_status" "" "$exec_status_clean"

# ============================================================
# Scribe path-scope guard tests
# ============================================================

echo ""
echo "=== pretooluse-pipeline-guards: scribe — blocks write to src/foo.ts ==="

_seed_run "run-scribe-block" '{"status":"running","tasks":{}}'
printf 'run-scribe-block' > "$CLAUDE_PLUGIN_DATA/runs/run-scribe-block/.scribe_active"
input='{"tool_name":"Write","tool_input":{"file_path":"src/foo.ts"}}'
set +e
out=$(printf '%s' "$input" | bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "scribe block src/foo.ts exit 0" "0" "$rc"
decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty')
assert_eq "scribe block src/foo.ts denies" "deny" "$decision"
reason=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty')
assert_eq "scribe block src/foo.ts reason mentions path" "true" \
  "$(printf '%s' "$reason" | grep -q 'src/foo.ts' && echo true || echo false)"

echo ""
echo "=== pretooluse-pipeline-guards: scribe — allows write to docs/api.md ==="

_seed_run "run-scribe-allow-docs" '{"status":"running","tasks":{}}'
printf 'run-scribe-allow-docs' > "$CLAUDE_PLUGIN_DATA/runs/run-scribe-allow-docs/.scribe_active"
input='{"tool_name":"Write","tool_input":{"file_path":"docs/api.md"}}'
set +e
out=$(printf '%s' "$input" | bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "scribe allow docs/api.md exit 0" "0" "$rc"
assert_eq "scribe allow docs/api.md no deny" "" "$out"

echo ""
echo "=== pretooluse-pipeline-guards: scribe — allows write to docs/foo/bar.md ==="

_seed_run "run-scribe-allow-nested" '{"status":"running","tasks":{}}'
printf 'run-scribe-allow-nested' > "$CLAUDE_PLUGIN_DATA/runs/run-scribe-allow-nested/.scribe_active"
input='{"tool_name":"Write","tool_input":{"file_path":"docs/foo/bar.md"}}'
set +e
out=$(printf '%s' "$input" | bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "scribe allow docs/foo/bar.md exit 0" "0" "$rc"
assert_eq "scribe allow docs/foo/bar.md no deny" "" "$out"

echo ""
echo "=== pretooluse-pipeline-guards: scribe guard skipped for non-scribe role ==="

_seed_run "run-scribe-nonscribe" '{"status":"running","tasks":{"t1":{"status":"executing","stage":"postexec"}}}'
# No .scribe_active sentinel — guard must not trigger.
input='{"tool_name":"Write","tool_input":{"file_path":"src/foo.ts"}}'
set +e
out=$(printf '%s' "$input" | bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "non-scribe src/foo.ts exit 0" "0" "$rc"
assert_eq "non-scribe src/foo.ts no deny" "" "$out"

# ============================================================
# Scribe Bash interpreter guard (M2 — Task 34): deny write-capable
# interpreters whose write targets cannot be reliably parsed
# (python / python3, sed -i, perl -i, install, ln -s).
# ============================================================

# Helper: assert that running the given Bash command under .scribe_active
# yields exit 0 + permissionDecision=deny + reason mentioning the substring.
_scribe_bash_deny() {
  local label="$1" run_name="$2" cmd="$3" reason_substr="$4"
  _seed_run "$run_name" '{"status":"running","tasks":{}}'
  printf '%s' "$run_name" > "$CLAUDE_PLUGIN_DATA/runs/$run_name/.scribe_active"
  local input
  input=$(jq -cn --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}')
  set +e
  local out rc
  out=$(printf '%s' "$input" | bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
  rc=$?
  set -e
  assert_eq "$label exit 0" "0" "$rc"
  local decision
  decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty')
  assert_eq "$label denies" "deny" "$decision"
  local reason
  reason=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty')
  assert_eq "$label reason mentions $reason_substr" "true" \
    "$(printf '%s' "$reason" | grep -qF "$reason_substr" && echo true || echo false)"
}

# Helper: assert that running the given Bash command under .scribe_active
# yields exit 0 + no deny output.
_scribe_bash_allow() {
  local label="$1" run_name="$2" cmd="$3"
  _seed_run "$run_name" '{"status":"running","tasks":{}}'
  printf '%s' "$run_name" > "$CLAUDE_PLUGIN_DATA/runs/$run_name/.scribe_active"
  local input
  input=$(jq -cn --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}')
  set +e
  local out rc
  out=$(printf '%s' "$input" | bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
  rc=$?
  set -e
  assert_eq "$label exit 0" "0" "$rc"
  local decision
  decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty')
  assert_eq "$label no deny" "" "$decision"
}

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — python -c denied ==="
_scribe_bash_deny "scribe python -c" "run-scribe-py-c" \
  "python -c \"open('/etc/foo','w').write('x')\"" "python"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — python3 script.py denied ==="
_scribe_bash_deny "scribe python3 script" "run-scribe-py3-script" \
  "python3 script.py" "python"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — sed -i denied ==="
_scribe_bash_deny "scribe sed -i" "run-scribe-sed-i" \
  "sed -i 's/x/y/' /etc/foo" "sed -i"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — sed -i.bak denied ==="
_scribe_bash_deny "scribe sed -i.bak" "run-scribe-sed-i-bak" \
  "sed -i.bak -e 's/x/y/' file" "sed -i"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — perl -i denied ==="
_scribe_bash_deny "scribe perl -i" "run-scribe-perl-i" \
  "perl -i -pe 's/x/y/' /etc/foo" "perl -i"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — perl -i.bak denied ==="
_scribe_bash_deny "scribe perl -i.bak" "run-scribe-perl-i-bak" \
  "perl -i.bak -pe 's/x/y/' file" "perl -i"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — install denied ==="
_scribe_bash_deny "scribe install" "run-scribe-install" \
  "install -m 644 src /etc/dst" "install"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — ln -s denied ==="
_scribe_bash_deny "scribe ln -s" "run-scribe-ln-s" \
  "ln -s /etc/passwd /tmp/link" "ln -s"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — ln -sf denied ==="
_scribe_bash_deny "scribe ln -sf" "run-scribe-ln-sf" \
  "ln -sf /etc/passwd /tmp/link" "ln -s"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — sed (no -i) allowed into docs/ ==="
_scribe_bash_allow "scribe sed no -i" "run-scribe-sed-allow" \
  "sed 's/x/y/' docs/input.md > docs/out.md"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — perl -e (no -i) allowed ==="
_scribe_bash_allow "scribe perl -e" "run-scribe-perl-e" \
  "perl -e 'print \"x\"'"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — piped sed into docs/ allowed ==="
_scribe_bash_allow "scribe piped sed" "run-scribe-piped-sed" \
  "cat docs/README.md | sed 's/x/y/' > docs/README.new.md"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — substring 'perl' inside echo arg allowed ==="
_scribe_bash_allow "scribe echo perl-substring" "run-scribe-echo-perl-substr" \
  "echo perl-not-an-invocation > docs/note.md"

# Bypass-coverage additions (close I1/I2/I3 from quality review):
#   I1 absolute-path invocations (/usr/bin/python, /bin/sed, /bin/ln)
#   I2 versioned python binaries (python3.11)
#   I3 -i bundled with other short flags (-pi, -Ei) and split (-p -i)
echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — /usr/bin/python denied ==="
_scribe_bash_deny "scribe absolute python" "run-scribe-abs-py" \
  "/usr/bin/python -c \"open('/etc/foo','w').write('x')\"" "python"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — python3.11 denied ==="
_scribe_bash_deny "scribe versioned python" "run-scribe-py311" \
  "python3.11 script.py" "python"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — /bin/sed -i denied ==="
_scribe_bash_deny "scribe absolute sed -i" "run-scribe-abs-sedi" \
  "/bin/sed -i 's/x/y/' /etc/foo" "sed -i"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — sed -Ei (bundled) denied ==="
_scribe_bash_deny "scribe sed -Ei bundled" "run-scribe-sed-Ei" \
  "sed -Ei 's/x/y/' file" "sed -i"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — perl -p -i (split) denied ==="
_scribe_bash_deny "scribe perl -p -i split" "run-scribe-perl-p-i" \
  "perl -p -i -e 's/x/y/' file" "perl -i"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — perl -pi (bundled) denied ==="
_scribe_bash_deny "scribe perl -pi bundled" "run-scribe-perl-pi" \
  "perl -pi -e 's/x/y/' file" "perl -i"

echo ""
echo "=== pretooluse-pipeline-guards: scribe Bash — /bin/ln -s denied ==="
_scribe_bash_deny "scribe absolute ln -s" "run-scribe-abs-lns" \
  "/bin/ln -s /etc/passwd /tmp/link" "ln -s"

# ============================================================
# Ship checklist guard tests
# ============================================================

echo ""
echo "=== pretooluse-pipeline-guards: ship checklist — PR allowed when full checklist ok ==="

_seed_run "run-checklist-ok" '{"status":"running","tasks":{"task-sc":{"status":"reviewing","stage":"postreview_done","quality_gate":{"ok":true},"quality_gates":{"tdd":{"ok":true,"exempt":false},"coverage":"ok"}}}}'
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/run-checklist-ok/.tasks"
jq -n '{
  task_id:"task-sc", tdd_gate:"ok", coverage_gate:"ok",
  quality_gate:"ok", review_blockers_resolved:true,
  ci_status:"pending", generated_at:"2026-04-24T00:00:00Z"
}' > "$CLAUDE_PLUGIN_DATA/runs/run-checklist-ok/.tasks/task-sc.ship_checklist.json"
input='{"tool_input":{"command":"gh pr create --base staging --title foo"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_TASK_ID=task-sc bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "checklist-ok exit 0" "0" "$rc"
assert_eq "checklist-ok no deny" "" "$out"

echo ""
echo "=== pretooluse-pipeline-guards: ship checklist — PR blocked when tdd_gate=fail ==="

_seed_run "run-checklist-tdd-fail" '{"status":"running","tasks":{"task-sc":{"status":"reviewing","quality_gate":{"ok":true}}}}'
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/run-checklist-tdd-fail/.tasks"
jq -n '{
  task_id:"task-sc", tdd_gate:"fail", coverage_gate:"ok",
  quality_gate:"ok", review_blockers_resolved:true,
  ci_status:"pending", generated_at:"2026-04-24T00:00:00Z"
}' > "$CLAUDE_PLUGIN_DATA/runs/run-checklist-tdd-fail/.tasks/task-sc.ship_checklist.json"
input='{"tool_input":{"command":"gh pr create --base staging --title foo"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_TASK_ID=task-sc bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "checklist-tdd-fail exit 0" "0" "$rc"
decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty')
assert_eq "checklist-tdd-fail denies" "deny" "$decision"
reason=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty')
assert_eq "checklist-tdd-fail reason mentions tdd_gate" "true" \
  "$(printf '%s' "$reason" | grep -q 'tdd_gate' && echo true || echo false)"

echo ""
echo "=== pretooluse-pipeline-guards: ship checklist — PR blocked when security_gate=fail ==="

# H4 regression: a failed semgrep finding (state.security_gate.ok=false,
# allow_failures=false) must surface as security_gate=fail in the checklist
# and the PR-create guard must deny on it. Before this fix the field was not
# emitted by _write_ship_checklist nor checked by the guard.
_seed_run "run-checklist-sec-fail" '{"status":"running","tasks":{"task-sc":{"status":"reviewing","quality_gate":{"ok":true},"security_gate":{"ok":false,"allow_failures":false}}}}'
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/run-checklist-sec-fail/.tasks"
jq -n '{
  task_id:"task-sc", tdd_gate:"ok", coverage_gate:"ok",
  quality_gate:"ok", pregate_gate:"ok", security_gate:"fail",
  review_blockers_resolved:true,
  ci_status:"pending", generated_at:"2026-05-20T00:00:00Z"
}' > "$CLAUDE_PLUGIN_DATA/runs/run-checklist-sec-fail/.tasks/task-sc.ship_checklist.json"
input='{"tool_input":{"command":"gh pr create --base staging --title foo"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_TASK_ID=task-sc bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "checklist-sec-fail exit 0" "0" "$rc"
decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty')
assert_eq "checklist-sec-fail denies" "deny" "$decision"
reason=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty')
assert_eq "checklist-sec-fail reason mentions security_gate" "true" \
  "$(printf '%s' "$reason" | grep -q 'security_gate' && echo true || echo false)"

echo ""
echo "=== pretooluse-pipeline-guards: ship checklist — PR blocked when checklist missing + quality_gate not ok ==="

_seed_run "run-checklist-missing-bad" '{"status":"running","tasks":{"task-sc":{"status":"reviewing","quality_gate":{"ok":false}}}}'
# No checklist file — backwards compat path
input='{"tool_input":{"command":"gh pr create --base staging --title foo"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_TASK_ID=task-sc bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "checklist-missing-bad exit 0" "0" "$rc"
decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty')
assert_eq "checklist-missing-bad denies" "deny" "$decision"

echo ""
echo "=== pretooluse-pipeline-guards: ship checklist — PR allowed when checklist missing but quality_gate ok ==="

_seed_run "run-checklist-missing-ok" '{"status":"running","tasks":{"task-sc":{"status":"reviewing","quality_gate":{"ok":true}}}}'
# No checklist file — backwards compat: falls through to quality_gate check
input='{"tool_input":{"command":"gh pr create --base staging --title foo"}}'
set +e
out=$(printf '%s' "$input" | FACTORY_TASK_ID=task-sc bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh")
rc=$?
set -e
assert_eq "checklist-missing-ok exit 0" "0" "$rc"
assert_eq "checklist-missing-ok no deny" "" "$out"

# ============================================================
# Fix #3: subagent-stop-gate transcript-based task scoping
# ============================================================

echo ""
echo "=== subagent-stop-gate: transcript [task:id] marker scopes block to correct task ==="

# Two executing tasks; hook fires for task-A via transcript marker.
# task-A has no commits; task-B has no commits either but must NOT be poisoned.
_seed_run "run-ssg-scoped" '{"status":"running","tasks":{"task-A":{"status":"executing","branch":"factory/test-nonexistent-taskA"},"task-B":{"status":"executing","branch":"factory/test-nonexistent-taskB"}}}'
transcript_scoped=$(mktemp)
printf '[task:task-A]\nDoing work for task A.\nSTATUS: DONE\n' > "$transcript_scoped"
set +e
out=$(jq -cn --arg t "$transcript_scoped" \
  '{agent_type:"task-executor", last_assistant_message:"All done.\nSTATUS: DONE", agent_transcript_path:$t}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/subagent-stop-gate.sh" 2>/dev/null)
rc=$?
set -e
rm -f "$transcript_scoped"
# Should block task-A (no commits) and NOT write BLOCKED to task-B
assert_eq "transcript-scoped: exit 1 (block)" "1" "$rc"
assert_eq "transcript-scoped: decision=block" "block" "$(printf '%s' "$out" | jq -r '.decision // empty')"
task_b_executor_status=$(jq -r '.tasks["task-B"].executor_status // empty' "$CLAUDE_PLUGIN_DATA/runs/run-ssg-scoped/state.json" 2>/dev/null || true)
assert_eq "transcript-scoped: task-B executor_status NOT poisoned" "" "$task_b_executor_status"

echo ""
echo "=== subagent-stop-gate: no transcript marker + 2 executing tasks → skip block with warning ==="

_seed_run "run-ssg-nomarker-multi" '{"status":"running","tasks":{"tX":{"status":"executing","branch":"factory/test-nonexistent-X"},"tY":{"status":"executing","branch":"factory/test-nonexistent-Y"}}}'
transcript_nomarker=$(mktemp)
printf 'No task marker here.\nSTATUS: DONE\n' > "$transcript_nomarker"
set +e
out=$(jq -cn --arg t "$transcript_nomarker" \
  '{agent_type:"task-executor", last_assistant_message:"All done.\nSTATUS: DONE", agent_transcript_path:$t}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/subagent-stop-gate.sh" 2>/dev/null)
rc=$?
set -e
rm -f "$transcript_nomarker"
# Must pass (exit 0) — do not block when task_id unknown and >1 executing
assert_eq "nomarker-multi: exit 0 (no block)" "0" "$rc"
assert_eq "nomarker-multi: no block decision" "" "$(printf '%s' "$out" | jq -r '.decision // empty' 2>/dev/null || true)"

# ============================================================
# Fix #7: asyncrewake-ci merge_status separation
# ============================================================

echo ""
echo "=== asyncrewake-ci: ci_status and merge_status written independently ==="

# Validate the script sets merge_status to "stalled" when CI is green but PR not merged.
# We test by sourcing only the logic; actual polling is skipped (we check the variable
# assignments at the bottom of the script via a stub environment).

# The asyncrewake-ci.sh script polls gh — we only test the field-separation via
# the pipeline-state stub (same pattern as retry tests above).

rewake_stubs=$(mktemp -d)
cat > "$rewake_stubs/pipeline-state" <<'SH'
#!/usr/bin/env bash
# Stub: records calls to verify fields written
echo "$@" >> "${REWAKE_STUB_LOG:-/dev/null}"
SH
chmod +x "$rewake_stubs/pipeline-state"

REWAKE_STUB_LOG=$(mktemp)
export REWAKE_STUB_LOG

# Verify the asyncrewake-ci.sh script writes merge_status separately from ci_status.
# We grep the source for the dual-write pattern as a structural check.
assert_eq "asyncrewake-ci: writes ci_status field" "true" \
  "$(grep -q 'task-write.*ci_status' "$HOOKS_DIR/asyncrewake-ci.sh" && echo true || echo false)"
assert_eq "asyncrewake-ci: writes merge_status field" "true" \
  "$(grep -q 'task-write.*merge_status' "$HOOKS_DIR/asyncrewake-ci.sh" && echo true || echo false)"
assert_eq "asyncrewake-ci: ci_status not overwritten on merge stall" "false" \
  "$(grep -q 'ci_conclusion.*=.*"red".*stall\|state.*=.*red.*merge' "$HOOKS_DIR/asyncrewake-ci.sh" && echo true || echo false)"
assert_eq "asyncrewake-ci: merge_status=stalled defined" "true" \
  "$(grep -q 'merge_status.*stalled' "$HOOKS_DIR/asyncrewake-ci.sh" && echo true || echo false)"
assert_eq "asyncrewake-ci: wake message includes --merge-status flag" "true" \
  "$(grep -q '\-\-merge-status' "$HOOKS_DIR/asyncrewake-ci.sh" && echo true || echo false)"

rm -f "$REWAKE_STUB_LOG"
rm -rf "$rewake_stubs"
unset REWAKE_STUB_LOG

# ============================================================
echo ""
echo "=== branch-protection: staging allowlist (autonomous + orchestrator worktree) ==="

# Create fixture: a fake repo with an orchestrator worktree dir.
_staging_tmp=$(mktemp -d)
mkdir -p "$_staging_tmp/repo/.git"
mkdir -p "$_staging_tmp/repo/.claude/worktrees/orchestrator-test"

# staging push from autonomous mode inside orchestrator worktree → ALLOW
_rc=0
out=$(printf '{"tool_input":{"command":"git push origin staging"}}' \
  | (cd "$_staging_tmp/repo/.claude/worktrees/orchestrator-test" && \
     FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/branch-protection.sh" 2>&1)) || _rc=$?
assert_eq "staging push from orch worktree allowed" "0" "$_rc"

# staging push from interactive shell → DENY
_rc=0
out=$(printf '{"tool_input":{"command":"git push origin staging"}}' \
  | (cd /tmp && bash "$HOOKS_DIR/branch-protection.sh" 2>&1)) || _rc=$?
assert_eq "staging push from interactive denied" "2" "$_rc"
assert_eq "staging deny includes push_to_protected" "true" \
  "$(printf '%s' "$out" | grep -q 'push_to_protected' && echo true || echo false)"

# staging push autonomous BUT outside orchestrator worktree → DENY
_rc=0
out=$(printf '{"tool_input":{"command":"git push origin staging"}}' \
  | (cd /tmp && FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/branch-protection.sh" 2>&1)) || _rc=$?
assert_eq "staging push autonomous outside orch worktree denied" "2" "$_rc"

# staging force push from autonomous orch worktree → DENY (force never allowed)
_rc=0
out=$(printf '{"tool_input":{"command":"git push --force origin staging"}}' \
  | (cd "$_staging_tmp/repo/.claude/worktrees/orchestrator-test" && \
     FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/branch-protection.sh" 2>&1)) || _rc=$?
assert_eq "force push to staging denied even from orch" "2" "$_rc"
assert_eq "force deny includes force_push_protected" "true" \
  "$(printf '%s' "$out" | grep -q 'force_push_protected' && echo true || echo false)"

# develop push from autonomous orch worktree → DENY (only staging is PIPELINE_MANAGED)
_rc=0
out=$(printf '{"tool_input":{"command":"git push origin develop"}}' \
  | (cd "$_staging_tmp/repo/.claude/worktrees/orchestrator-test" && \
     FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/branch-protection.sh" 2>&1)) || _rc=$?
assert_eq "develop push from orch worktree denied" "2" "$_rc"

# single-quoted ref token strips correctly → DENY
_rc=0
out=$(printf '%s' '{"tool_input":{"command":"git push origin '"'"'staging'"'"'"}}' \
  | (cd /tmp && bash "$HOOKS_DIR/branch-protection.sh" 2>&1)) || _rc=$?
assert_eq "single-quoted staging ref denied" "2" "$_rc"

# single-quoted --delete <branch> must DENY (regression: re-scan must also strip single quotes)
_rc=0
out=$(printf '%s' '{"tool_input":{"command":"git push origin --delete '"'"'staging'"'"'"}}' \
  | (cd /tmp && bash "$HOOKS_DIR/branch-protection.sh" 2>&1)) || _rc=$?
assert_eq "single-quoted --delete staging denied" "2" "$_rc"
assert_eq "single-quoted --delete reason" "true" \
  "$(printf '%s' "$out" | grep -q 'remote_delete_protected' && echo true || echo false)"

rm -rf "$_staging_tmp"

# ============================================================
echo ""
echo "=== nested-shell denylist ==="

# bash -lc 'gh pr create' must DENY in autonomous mode (pretooluse-pipeline-guards)
_seed_run "run-nested-shell" '{"status":"running","tasks":{}}'
out=$(printf '%s' '{"tool_input":{"command":"bash -lc \"gh pr create --base staging\""}}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" 2>&1; echo "EXIT:$?")
assert_eq "bash -lc gh pr create denied (exit 0 with deny payload)" "EXIT:0" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"
assert_contains() { local label="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -q "$needle"; then echo "  PASS: $label"; pass=$((pass+1))
  else echo "  FAIL: $label (expected '$needle' in output)"; fail=$((fail+1)); fi; }
assert_contains "bash -lc deny has permissionDecision" "permissionDecision" "$out"
assert_contains "bash -lc deny decision=deny" "deny" "$out"

# git -c hooksPath=/dev/null commit must DENY via secret-commit-guard (exit 2)
out=$(printf '%s' '{"tool_input":{"command":"git -c hooksPath=/dev/null commit -m x"}}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/secret-commit-guard.sh" 2>&1; echo "EXIT:$?")
assert_eq "git -c hooksPath commit denied (exit 2)" "EXIT:2" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"
assert_contains "git -c hooksPath commit reason=nested_shell_denied" "nested_shell_denied" "$out"

# git -c core.hooksPath=/dev/null push must DENY by branch-protection (exit 2)
out=$(printf '%s' '{"tool_input":{"command":"git -c core.hooksPath=/dev/null push origin staging"}}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/branch-protection.sh" 2>&1; echo "EXIT:$?")
assert_eq "git -c core.hooksPath push denied (exit 2)" "EXIT:2" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"
assert_contains "git -c core.hooksPath push reason=nested_shell_denied" "nested_shell_denied" "$out"

# eval "rm -rf" must DENY in pretooluse-pipeline-guards
_seed_run "run-eval-deny" '{"status":"running","tasks":{}}'
out=$(printf '%s' '{"tool_input":{"command":"eval \"rm -rf /\""}}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" 2>&1; echo "EXIT:$?")
assert_eq "eval denied (exit 0 with deny payload)" "EXIT:0" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"
assert_contains "eval deny has deny decision" "deny" "$out"

# Interactive (no FACTORY_AUTONOMOUS_MODE) — bash -lc should pass through
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
out=$(printf '%s' '{"tool_input":{"command":"bash -lc \"ls\""}}' \
  | bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" 2>&1; echo "EXIT:$?")
assert_eq "bash -lc interactive allowed (no autonomous mode)" "EXIT:0" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"

# env wrapping bash -c (was the prior bypass)
_seed_run "run-env-bash" '{"status":"running","tasks":{}}'
out=$(printf '%s' '{"tool_input":{"command":"env bash -c \"gh pr create\""}}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" 2>&1; echo "EXIT:$?")
assert_contains "env bash -c denied" "deny" "$out"

# env with VAR=val prefix wrapping bash
_seed_run "run-env-var-bash" '{"status":"running","tasks":{}}'
out=$(printf '%s' '{"tool_input":{"command":"env PATH=/tmp bash -c \"gh pr merge 1\""}}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" 2>&1; echo "EXIT:$?")
assert_contains "env VAR=val bash -c denied" "deny" "$out"

# env -i sh -c
_seed_run "run-env-i-sh" '{"status":"running","tasks":{}}'
out=$(printf '%s' '{"tool_input":{"command":"env -i sh -c \"gh pr create\""}}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" 2>&1; echo "EXIT:$?")
assert_contains "env -i sh -c denied" "deny" "$out"

# Unquoted: bash myscript.sh
_seed_run "run-unquoted-bash" '{"status":"running","tasks":{}}'
out=$(printf '%s' '{"tool_input":{"command":"bash /tmp/some.sh"}}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" 2>&1; echo "EXIT:$?")
assert_contains "unquoted bash script denied" "deny" "$out"

# Interactive (no autonomous) — env bash -c passes through
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
out=$(printf '%s' '{"tool_input":{"command":"env bash -c \"ls\""}}' \
  | bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" 2>&1; echo "EXIT:$?")
assert_eq "env bash -c interactive allowed" "EXIT:0" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"

# ============================================================
echo ""
echo "=== S1: pipeline-guards nested-shell bypass fires on active run without FACTORY_AUTONOMOUS_MODE ==="

# Active run exists (resume / dev shell scenario), but FACTORY_AUTONOMOUS_MODE is
# NOT set. The nested-shell / hook-bypass guard must still fire — leaving it inert
# on resume is a defense-in-depth bypass (S1).
_seed_run "run-s1-bypass" '{"status":"running","tasks":{}}'
set +e
out=$(unset FACTORY_AUTONOMOUS_MODE; printf '%s' '{"tool_name":"Bash","tool_input":{"command":"bash -lc \"gh pr create\""}}' \
  | bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" 2>&1; echo "EXIT:$?")
set -e
assert_eq "S1: bypass on active run (no env) exit 0 with deny payload" "EXIT:0" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"
assert_contains "S1: bypass on active run has permissionDecision" "permissionDecision" "$out"
assert_contains "S1: bypass on active run decision=deny" "deny" "$out"
assert_contains "S1: bypass deny reason mentions nested-shell or hook-bypass" "nested-shell\|hook-bypass" "$out"

# Negative control: no active run AND no env var → guard MUST NOT fire.
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
set +e
out=$(unset FACTORY_AUTONOMOUS_MODE; printf '%s' '{"tool_name":"Bash","tool_input":{"command":"bash -lc \"gh pr create\""}}' \
  | bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" 2>&1; echo "EXIT:$?")
set -e
assert_eq "S1: no active run, no env -> bypass guard does not fire (exit 0)" "EXIT:0" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"
if printf '%s' "$out" | grep -q 'permissionDecision'; then
  echo "  FAIL: S1: no active run should produce no deny payload (got: $out)"; fail=$((fail + 1))
else
  echo "  PASS: S1: no active run produces no deny payload"; pass=$((pass + 1))
fi

echo ""
echo "=== S1: path-scope preexec_tests guard fires on active run without FACTORY_AUTONOMOUS_MODE ==="

_seed_run "run-s1-pathscope" '{"status":"running","tasks":{"task-1":{"task_id":"task-1","status":"executing","stage":"preexec_tests"}}}'

# Non-test write must be DENIED even with env var unset.
set +e
out=$(unset FACTORY_AUTONOMOUS_MODE; FACTORY_TASK_ID=task-1 printf '%s' '{"tool_name":"Write","tool_input":{"file_path":"src/main.ts","content":"x"}}' \
  | FACTORY_TASK_ID=task-1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" 2>&1; echo "EXIT:$?")
set -e
assert_eq "S1: path-scope denies src/ write on active preexec_tests (exit 0 with deny)" "EXIT:0" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"
assert_contains "S1: path-scope deny has permissionDecision" "permissionDecision" "$out"
assert_contains "S1: path-scope deny decision=deny" "deny" "$out"
assert_contains "S1: path-scope deny reason mentions src/main.ts" "src/main.ts" "$out"

# Positive control: Write to a test path passes.
set +e
out=$(unset FACTORY_AUTONOMOUS_MODE; FACTORY_TASK_ID=task-1 printf '%s' '{"tool_name":"Write","tool_input":{"file_path":"tests/main.test.ts","content":"x"}}' \
  | FACTORY_TASK_ID=task-1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" 2>&1; echo "EXIT:$?")
set -e
assert_eq "S1: path-scope allows test path on active preexec_tests" "EXIT:0" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"
if printf '%s' "$out" | grep -q 'permissionDecision'; then
  echo "  FAIL: S1: path-scope test path produced unexpected deny (got: $out)"; fail=$((fail + 1))
else
  echo "  PASS: S1: path-scope test path produced no deny"; pass=$((pass + 1))
fi

rm -f "$CLAUDE_PLUGIN_DATA/runs/current"

# ============================================================
echo ""
echo "=== gh pr create requires task_id in autonomous mode ==="

# In autonomous mode without a derivable task_id: DENY
_seed_run "run-pr-notaskid" '{"status":"running","tasks":{}}'
out=$(printf '%s' '{"tool_input":{"command":"gh pr create --base staging --title random"}}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" 2>&1; echo "EXIT:$?")
assert_eq "gh pr create no task_id autonomous denied (exit 0)" "EXIT:0" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"
assert_contains "gh pr create no task_id deny payload" "permissionDecision" "$out"
assert_contains "gh pr create no task_id deny reason mentions task_id" "task_id" "$out"

# In autonomous mode without task_id: gh pr merge DENY
_seed_run "run-merge-notaskid" '{"status":"running","tasks":{}}'
out=$(printf '%s' '{"tool_input":{"command":"gh pr merge 123 --merge"}}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" 2>&1; echo "EXIT:$?")
assert_eq "gh pr merge no task_id autonomous denied (exit 0)" "EXIT:0" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"
assert_contains "gh pr merge no task_id deny payload" "permissionDecision" "$out"

# Interactive with no task_id: let through (no deny)
_seed_run "run-pr-interactive" '{"status":"running","tasks":{}}'
out=$(printf '%s' '{"tool_input":{"command":"gh pr create --base main --title test"}}' \
  | bash "$HOOKS_DIR/pretooluse-pipeline-guards.sh" 2>&1; echo "EXIT:$?")
assert_eq "gh pr create no task_id interactive allowed" "EXIT:0" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"

# ============================================================
echo ""
echo "=== git push scan in secret-commit-guard ==="

# Construct fake AWS key at runtime to avoid triggering the secret guard when
# this test file itself is committed (the pattern must not appear literally here).
_fake_aws_key="AKIA""IOSFODNN7EXAMPLE"

# Build a tmp git repo with a fake AWS key committed but not pushed.
_push_tmp=$(mktemp -d)
git -C "$_push_tmp" init -q
git -C "$_push_tmp" commit --allow-empty -m "init" -q
git -C "$_push_tmp" checkout -b "feat/test-push-scan" -q
# Write a file with a fake AWS key pattern
printf '%s\n' "export AWS_KEY=$_fake_aws_key" > "$_push_tmp/secrets.txt"
git -C "$_push_tmp" add "$_push_tmp/secrets.txt"
git -C "$_push_tmp" commit -m "add secrets" -q

# First-push (no upstream) of a branch containing a secret → still blocked.
# The previous behavior skipped the scan when no upstream was configured, which
# meant the very first push of any branch was exempt. D10 closed that gap by
# scanning all commits reachable from HEAD when remote_ref is unknown.
_push_tmp2=$(mktemp -d)
git -C "$_push_tmp2" init -q
git -C "$_push_tmp2" commit --allow-empty -m "init" -q
git -C "$_push_tmp2" checkout -b "feat/no-upstream" -q
printf '%s\n' "export AWS_KEY=$_fake_aws_key" > "$_push_tmp2/secrets.txt"
git -C "$_push_tmp2" add "$_push_tmp2/secrets.txt"
git -C "$_push_tmp2" commit -m "add secrets" -q
out=$(printf '%s' "{\"tool_input\":{\"command\":\"git -C $_push_tmp2 push\"}}" \
  | bash "$HOOKS_DIR/secret-commit-guard.sh" 2>&1; echo "EXIT:$?")
assert_eq "push scan no upstream detects secret (exit 2)" "EXIT:2" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"
assert_contains "push scan no upstream block reason=secret_detected" "secret_detected" "$out"
rm -rf "$_push_tmp2"

# Add a fake remote so range resolves; commit with AKIA key; expect EXIT:2
git -C "$_push_tmp" remote add origin "file:///dev/null" 2>/dev/null || true
# Simulate origin/feat/test-push-scan existing at init commit (before the secret)
_init_sha=$(git -C "$_push_tmp" rev-list --max-parents=0 HEAD 2>/dev/null)
git -C "$_push_tmp" update-ref refs/remotes/origin/feat/test-push-scan "$_init_sha"

out=$(printf '%s' "{\"tool_input\":{\"command\":\"git -C $_push_tmp push origin feat/test-push-scan\"}}" \
  | bash "$HOOKS_DIR/secret-commit-guard.sh" 2>&1; echo "EXIT:$?")
assert_eq "push scan detects AKIA key in unpushed commit (exit 2)" "EXIT:2" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"
assert_contains "push scan block reason=secret_detected" "secret_detected" "$out"

rm -rf "$_push_tmp"

# ============================================================
echo ""
echo "=== M1: secret-commit-guard denies git-dir/work-tree override bypass ==="

# Task 33 (M1): commands using --git-dir, --work-tree, GIT_DIR=, or GIT_WORK_TREE=
# could redirect the staged-diff scan away from the real commit target. Detect
# and refuse rather than try to normalise. Exit 2, reason=git_dir_override_denied.
_m1_tmp=$(mktemp -d)
git -C "$_m1_tmp" init -q
git -C "$_m1_tmp" commit --allow-empty -m "init" -q

_m1_run() {
  local label="$1" cmd="$2"
  local out rc
  out=$(jq -cn --arg c "$cmd" '{tool_input:{command:$c}}' \
    | bash "$HOOKS_DIR/secret-commit-guard.sh" 2>&1; echo "EXIT:$?")
  rc=$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')
  assert_eq "$label exit 2" "EXIT:2" "$rc"
  assert_contains "$label reason=git_dir_override_denied" "git_dir_override_denied" "$out"
}

_m1_run "--git-dir= flag (fused)" "git --git-dir=/tmp/foo/.git commit -m wip"
_m1_run "--git-dir flag (space-separated)" "git --git-dir /tmp/foo/.git commit -m wip"
_m1_run "--work-tree= flag (fused)" "git --work-tree=/tmp/foo commit -m wip"
_m1_run "--git-dir + --work-tree combo" "git --git-dir=/tmp/foo/.git --work-tree=/tmp/foo commit -m wip"
_m1_run "GIT_DIR= env prefix" "GIT_DIR=/tmp/foo/.git git commit -m wip"
_m1_run "GIT_WORK_TREE= env prefix" "GIT_WORK_TREE=/tmp/foo git commit -m wip"
_m1_run "FOO=bar GIT_DIR= multi-env prefix" "FOO=bar GIT_DIR=/tmp/foo/.git git commit -m wip"
_m1_run "GIT_DIR= env prefix on push" "GIT_DIR=/tmp/foo/.git git push origin staging"

# Negative case: plain commit in a real repo with no secrets must still allow.
out=$(jq -cn --arg c "git -C $_m1_tmp commit --allow-empty -m wip" '{tool_input:{command:$c}}' \
  | bash "$HOOKS_DIR/secret-commit-guard.sh" 2>&1; echo "EXIT:$?")
assert_eq "plain commit (no override) still allowed" "EXIT:0" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"

# Negative case: unrelated command mentioning --git-dir as plain text — not a
# git commit/push, so the deny check must not fire (early-return at line 47).
out=$(printf '%s' '{"tool_input":{"command":"echo see git --git-dir docs"}}' \
  | bash "$HOOKS_DIR/secret-commit-guard.sh" 2>&1; echo "EXIT:$?")
assert_eq "unrelated echo mentioning --git-dir allowed" "EXIT:0" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"

# Negative case: `git config` with no commit/push — must not fire.
out=$(printf '%s' '{"tool_input":{"command":"git config user.email foo@bar"}}' \
  | bash "$HOOKS_DIR/secret-commit-guard.sh" 2>&1; echo "EXIT:$?")
assert_eq "git config (no commit/push) allowed" "EXIT:0" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"

# Known false positive — quoted-string check: a commit message mentioning
# `--git-dir` inside `-m "..."` will trip the deny. This is acceptable
# fail-closed behavior (the cost is one rejected commit; the cost of a missed
# override is a leaked secret). Documenting the behavior explicitly so a
# regression in the regex doesn't silently change semantics.
out=$(jq -cn --arg c 'git commit -m "use --git-dir to point at the bare repo"' '{tool_input:{command:$c}}' \
  | bash "$HOOKS_DIR/secret-commit-guard.sh" 2>&1; echo "EXIT:$?")
assert_eq "quoted --git-dir in commit message denied (known false positive — fail-closed)" \
  "EXIT:2" "$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')"

rm -rf "$_m1_tmp"

# ============================================================
echo ""
echo "=== T5: _is_nested_shell_or_hook_bypass adversarial matrix ==="

# Direct unit test of hooks/_security-common.sh helper. Source once; assert
# rc==0 (match) for each detection pattern and rc!=0 (no match) for benign
# commands. Per-case PASS/FAIL increments the suite counter.
source "$HOOKS_DIR/_security-common.sh"

_t5_match() {
  local label="$1" cmd="$2"
  if _is_nested_shell_or_hook_bypass "$cmd"; then
    echo "  PASS: $label (matched)"; pass=$((pass + 1))
  else
    echo "  FAIL: $label (expected MATCH for: $cmd)"; fail=$((fail + 1))
  fi
}
_t5_no_match() {
  local label="$1" cmd="$2"
  if _is_nested_shell_or_hook_bypass "$cmd"; then
    echo "  FAIL: $label (expected NO MATCH for: $cmd)"; fail=$((fail + 1))
  else
    echo "  PASS: $label (no match)"; pass=$((pass + 1))
  fi
}

# Pattern 1: bash/sh/zsh -[lic] 'cmd'
_t5_match "bash -c quoted"        'bash -c "gh pr create"'
_t5_match "sh -c quoted"          "sh -c 'rm -rf /tmp/x'"
_t5_match "zsh -lc quoted"        'zsh -lc "ls"'
_t5_match "bash -lc quoted"       'bash -lc "git push"'

# Pattern 2: env wrapping a shell binary
_t5_match "env bash"              'env bash -c "ls"'
_t5_match "env -i bash"           'env -i bash -c "ls"'
_t5_match "env VAR=val bash"      'env PATH=/tmp bash -c "ls"'
_t5_match "env multi-var sh"      'env FOO=bar BAZ=qux sh -c "ls"'

# Pattern 3: env -flag 'cmd' (env-as-shell-itself)
_t5_match "env -i quoted cmd"     "env -i 'echo hi'"

# Pattern 4: unquoted bash/sh/zsh script invocation
_t5_match "bash script.sh"        'bash /tmp/run.sh'
_t5_match "sh path/to/x.sh"       'sh some/path.sh arg1'

# Pattern 5: eval
_t5_match "eval rm"               'eval "rm -rf /"'
_t5_match "eval at start"         'eval foo'

# Pattern 6: git -c hooksPath= / -c core.hooksPath=
_t5_match "git -c hooksPath"      'git -c hooksPath=/dev/null commit -m x'
_t5_match "git -c core.hooksPath" 'git -c core.hooksPath=/tmp/h push'

# Pattern 7: absolute-path shell -c
_t5_match "/bin/bash -c"          '/bin/bash -c "ls"'
_t5_match "/usr/bin/env bash"     "/usr/bin/env bash -c 'ls'"

# Negative cases — benign commands that must NOT trip the helper.
_t5_no_match "plain git commit"   'git commit -m "feat: x"'
_t5_no_match "plain git push"     'git push origin staging'
_t5_no_match "gh pr create"       'gh pr create --base staging --title t'
_t5_no_match "ls"                 'ls -la'
_t5_no_match "pipeline-state read" 'pipeline-state read run-1 .status'
_t5_no_match "git config --global" 'git config --global user.email foo@bar'
_t5_no_match "git -c user.email"  'git -c user.email=foo@bar commit -m x'

# ============================================================
echo ""
echo "=== T3: secret-commit-guard content-regex coverage matrix ==="

# One positive + one negative case per regex in CONTENT_PATTERNS. Concatenate
# the fixture strings at runtime so the hook can't trigger on this file itself.
#
# Helper: stage $value in a fresh git repo, run secret-commit-guard for the
# implicit `git -C <repo> commit`, return EXIT:<code>. Negative variants pass
# a string that the regex must NOT match.
_t3_run() {
  local label="$1" value="$2" want_exit="$3"
  local repo; repo=$(mktemp -d)
  git -C "$repo" init -q
  git -C "$repo" commit --allow-empty -m "init" -q
  printf '%s\n' "$value" > "$repo/leak.txt"
  git -C "$repo" add leak.txt
  local out rc
  out=$(jq -cn --arg c "git -C $repo commit -m wip" '{tool_input:{command:$c}}' \
    | bash "$HOOKS_DIR/secret-commit-guard.sh" 2>&1; echo "EXIT:$?")
  rc=$(printf '%s' "$out" | grep -o 'EXIT:[0-9]*')
  assert_eq "$label exit=$want_exit" "EXIT:$want_exit" "$rc"
  if [[ "$want_exit" == "2" ]]; then
    assert_contains "$label reason=secret_detected" "secret_detected" "$out"
  fi
  rm -rf "$repo"
}

# 1. AWS access key id (AKIA…)
_t3_run "AKIA positive"  "AKIA""IOSFODNN7EXAMPLE" 2
_t3_run "AKIA negative"  "AKIA""IOSFODNN7EXAMPL"  0    # 15 chars after AKIA (need 16)

# 2. GitHub personal token (ghp_…36 alnum)
_t3_run "ghp_ positive" "ghp_""0123456789abcdefghijABCDEFGHIJ0123ZZ" 2
_t3_run "ghp_ negative" "ghp_""0123456789abcdefghijABCDEFGHIJ0123" 0   # 34 chars (need 36)

# 3. GitHub server-to-server (ghs_)
_t3_run "ghs_ positive" "ghs_""0123456789abcdefghijABCDEFGHIJ0123ZZ" 2
_t3_run "ghs_ negative" "ghs_""TOOSHORT" 0

# 4. GitHub OAuth (gho_)
_t3_run "gho_ positive" "gho_""0123456789abcdefghijABCDEFGHIJ0123ZZ" 2
_t3_run "gho_ negative" "gho_""TOOSHORT" 0

# 5. GitHub refresh (ghr_)
_t3_run "ghr_ positive" "ghr_""0123456789abcdefghijABCDEFGHIJ0123ZZ" 2
_t3_run "ghr_ negative" "ghr_""TOOSHORT" 0

# 6. Anthropic key (sk-ant-…)
_t3_run "sk-ant positive" "sk-""ant-api03-AAAAAAAAAAAAAAAAAAAA-ZZ" 2
_t3_run "sk-ant negative" "sk-""ant-tiny" 0

# 7. Generic OpenAI-style sk- (20+ alnum)
_t3_run "sk- positive" "sk-""0123456789abcdefghijklmnopqrstuv" 2
_t3_run "sk- negative" "sk-""shorttoken" 0

# 8. Slack xox[bpars]-
_t3_run "xoxb positive" "xoxb""-1234567890-abcdefghij" 2
_t3_run "xoxb negative" "xoxb""-short" 0

# 9. Google API key (AIza…35)
_t3_run "AIza positive" "AIza""0123456789abcdefghijABCDEFGHIJ01234" 2
_t3_run "AIza negative" "AIza""shorttoken" 0

# 10. Stripe live secret (sk_live_…20+)
_t3_run "sk_live positive" "sk_""live_0123456789abcdefghijZZ" 2
_t3_run "sk_live negative" "sk_""live_short" 0

# 11. Stripe restricted live (rk_live_…)
_t3_run "rk_live positive" "rk_""live_0123456789abcdefghijZZ" 2
_t3_run "rk_live negative" "rk_""live_short" 0

# 12. JWT eyJ…eyJ…tail
_t3_run "JWT positive" "eyJ""abcdefghij.eyJabcdefghij.signaturepart" 2
_t3_run "JWT negative" "eyJ""abcdefghij_no_dots_here" 0

# 13. aws_secret_access_key = <40 b64>
_t3_run "aws_secret positive" "aws_""secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEYY" 2
_t3_run "aws_secret negative" "aws_""secret_access_key=tooshort" 0

# 14. JSON service-account private-key + PEM-BEGIN block (JSON-embedded PEM)
_t3_run "json privkey positive" '"private_'"key"'":"-----'"BEGIN" 2
_t3_run "json privkey negative" '"public_'"key"'":"-----'"BEGIN" 0

# 15. PEM PRIVATE KEY block header
_t3_run "PEM positive" "-----""BEGIN RSA PRIVATE KEY-----" 2
_t3_run "PEM negative" "-----""BEGIN CERTIFICATE-----" 0

# 16. GitHub fine-grained PAT (github_pat_…60+)
_t3_run "github_pat positive" "github_""pat_$(printf 'X%.0s' {1..60})" 2
_t3_run "github_pat negative" "github_""pat_shortvalue" 0

# 17. OpenAI project key (sk-proj-…40+)
_t3_run "sk-proj positive" "sk-""proj-$(printf 'X%.0s' {1..40})" 2
_t3_run "sk-proj negative" "sk-""proj-short" 0

# 18. NVIDIA api key (nvapi-…40+)
_t3_run "nvapi positive" "nvapi""-$(printf 'X%.0s' {1..40})" 2
_t3_run "nvapi negative" "nvapi""-short" 0

# 19. xAI key (xai-…40+ alnum)
_t3_run "xai positive" "xai""-$(printf 'X%.0s' {1..40})" 2
_t3_run "xai negative" "xai""-short" 0

# ============================================================
echo ""
echo "=== All hook scripts are executable ==="

assert_eq "branch-protection executable" "true" "$([[ -x "$HOOKS_DIR/branch-protection.sh" ]] && echo true || echo false)"
assert_eq "run-tracker executable" "true" "$([[ -x "$HOOKS_DIR/run-tracker.sh" ]] && echo true || echo false)"
assert_eq "stop-gate executable" "true" "$([[ -x "$HOOKS_DIR/stop-gate.sh" ]] && echo true || echo false)"
assert_eq "subagent-stop-gate executable" "true" "$([[ -x "$HOOKS_DIR/subagent-stop-gate.sh" ]] && echo true || echo false)"
assert_eq "pretooluse-pipeline-guards executable" "true" "$([[ -x "$HOOKS_DIR/pretooluse-pipeline-guards.sh" ]] && echo true || echo false)"
assert_eq "subagent-stop-transcript executable" "true" "$([[ -x "$HOOKS_DIR/subagent-stop-transcript.sh" ]] && echo true || echo false)"
assert_eq "session-start-resume executable" "true" "$([[ -x "$HOOKS_DIR/session-start-resume.sh" ]] && echo true || echo false)"
assert_eq "session-start executable" "true" "$([[ -x "$HOOKS_DIR/session-start" ]] && echo true || echo false)"
assert_eq "asyncrewake-ci executable" "true" "$([[ -x "$HOOKS_DIR/asyncrewake-ci.sh" ]] && echo true || echo false)"

# ============================================================
echo ""
echo "=== Results ==="
echo "  Passed: $pass"
echo "  Failed: $fail"
echo "  Total:  $((pass + fail))"

rm -rf "$CLAUDE_PLUGIN_DATA"

[[ $fail -eq 0 ]] && exit 0 || exit 1
