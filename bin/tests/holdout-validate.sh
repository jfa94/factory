#!/usr/bin/env bash
# holdout-validate.sh — pipeline-holdout-validate prompt + check contracts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN_DIR="$REPO_ROOT/bin"
ROOT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/factory-holdout-validate.XXXXXX")"
trap 'rm -rf "$ROOT_TMP"' EXIT INT TERM

export CLAUDE_PLUGIN_DATA="$ROOT_TMP/plugin-data"
RUN_ID="run-test"
HD="$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/holdouts"
mkdir -p "$HD"

pass=0; fail_count=0
ok()   { pass=$((pass+1)); printf '  PASS: %s\n' "$1"; }
fail() { fail_count=$((fail_count+1)); printf '  FAIL: %s\n' "$1"; }

# Seed a holdout file with one withheld criterion.
jq -n '{task_id:"t1", withheld_criteria:["criterion A"], total_criteria:3, withheld_count:1}' \
  > "$HD/t1.json"

run_check() {
  # $1 = reviewer output text; prints summary JSON, sets global RC
  local out_file="$ROOT_TMP/review.md"
  printf '%s' "$1" > "$out_file"
  set +e
  SUMMARY=$("$BIN_DIR/pipeline-holdout-validate" check "$RUN_ID" t1 "$out_file" 2>/dev/null)
  RC=$?
  set -e
}

printf '\n=== check: prose-wrapped unfenced JSON (root cause #3) ===\n'
run_check 'Here is my verification of the withheld criterion.

The implementation looks correct.

{ "criteria": [ { "criterion": "criterion A", "satisfied": true, "evidence": "types.ts:24" } ] }

VERDICT: APPROVE'
[[ "$RC" -eq 0 ]] && ok "prose+unfenced JSON parses (exit 0)" \
  || fail "prose+unfenced JSON parses (got exit $RC, summary=$SUMMARY)"
[[ "$(printf '%s' "$SUMMARY" | jq -r '.status')" == "pass" ]] \
  && ok "prose+unfenced JSON → status pass" \
  || fail "prose+unfenced JSON → status pass (got $(printf '%s' "$SUMMARY" | jq -r '.status'))"

printf '\n=== check: fenced JSON still works ===\n'
run_check 'Some prose.
```json
{ "criteria": [ { "criterion": "criterion A", "satisfied": true, "evidence": "x:1" } ] }
```'
[[ "$RC" -eq 0 ]] && ok "fenced JSON parses (exit 0)" || fail "fenced JSON parses (got $RC)"

printf '\n=== check: pure bare JSON still works ===\n'
run_check '{ "criteria": [ { "criterion": "criterion A", "satisfied": true, "evidence": "x:1" } ] }'
[[ "$RC" -eq 0 ]] && ok "pure bare JSON parses (exit 0)" || fail "pure bare JSON parses (got $RC)"

printf '\n=== check: genuinely missing JSON fails closed ===\n'
run_check 'I could not find the file. No JSON here.'
[[ "$RC" -eq 2 ]] && ok "no-JSON output → exit 2 (fail-closed)" \
  || fail "no-JSON output → exit 2 (got $RC)"
[[ "$(printf '%s' "$SUMMARY" | jq -r '.status' 2>/dev/null)" == "error" ]] \
  && ok "no-JSON output → status error" \
  || fail "no-JSON output → status error (got $(printf '%s' "$SUMMARY" | jq -r '.status' 2>/dev/null))"
[[ "$(printf '%s' "$SUMMARY" | jq -r '.reason' 2>/dev/null)" == "invalid_reviewer_output" ]] \
  && ok "no-JSON output → reason invalid_reviewer_output" \
  || fail "no-JSON output → reason invalid_reviewer_output (got $(printf '%s' "$SUMMARY" | jq -r '.reason' 2>/dev/null))"

printf '\n=== prompt: embeds worktree path + diff instruction (#2) ===\n'
PROMPT_OUT=$("$BIN_DIR/pipeline-holdout-validate" prompt "$RUN_ID" t1 --worktree /tmp/wt-xyz 2>/dev/null)
printf '%s' "$PROMPT_OUT" | grep -qF '/tmp/wt-xyz' \
  && ok "prompt includes worktree path" \
  || fail "prompt includes worktree path"
printf '%s' "$PROMPT_OUT" | grep -qE 'git -C /tmp/wt-xyz diff' \
  && ok "prompt includes git -C <wt> diff instruction" \
  || fail "prompt includes git -C <wt> diff instruction"

printf '\n=== prompt: still works without --worktree (back-compat) ===\n'
set +e
"$BIN_DIR/pipeline-holdout-validate" prompt "$RUN_ID" t1 >/dev/null 2>&1
PRC=$?
set -e
[[ "$PRC" -eq 0 ]] && ok "prompt without --worktree exits 0" || fail "prompt without --worktree exits 0 (got $PRC)"

printf '\n=== B5: threshold=0 does not vacuously pass an unsatisfied holdout ===\n'
mkdir -p "$CLAUDE_PLUGIN_DATA"
printf '{"quality":{"holdoutPassRate":0}}\n' > "$CLAUDE_PLUGIN_DATA/config.json"
run_check '{ "criteria": [ { "criterion": "criterion A", "satisfied": false, "evidence": "" } ] }'
[[ "$(printf '%s' "$SUMMARY" | jq -r '.status')" == "fail" ]] \
  && ok "B5: threshold=0 + unsatisfied → fail" \
  || fail "B5: threshold=0 vacuously passed (status=$(printf '%s' "$SUMMARY" | jq -r '.status'))"
rm -f "$CLAUDE_PLUGIN_DATA/config.json"

printf '\n=== F1: holdout gate fails when criterion unsatisfied ===\n'
run_check '{ "criteria": [ { "criterion": "criterion A", "satisfied": false, "evidence": "x" } ] }'
[[ "$(printf '%s' "$SUMMARY" | jq -r '.status')" == "fail" ]] \
  && ok "F1: unsatisfied → status fail" || fail "F1: unsatisfied not failed"
[[ "$RC" -eq 1 ]] && ok "F1: unsatisfied → exit 1" || fail "F1: unsatisfied exit=$RC"

printf '\n=== F1: empty evidence counts as unsatisfied ===\n'
run_check '{ "criteria": [ { "criterion": "criterion A", "satisfied": true, "evidence": "" } ] }'
[[ "$(printf '%s' "$SUMMARY" | jq -r '.status')" == "fail" ]] \
  && ok "F1: empty-evidence → fail" || fail "F1: empty-evidence passed"

printf '\n=== F1: missing entry counts as failure ===\n'
run_check '{ "criteria": [] }'
[[ "$(printf '%s' "$SUMMARY" | jq -r '.status')" == "fail" ]] \
  && ok "F1: missing-entry → fail" || fail "F1: missing-entry passed"

printf '\n=== Results ===\n'
printf '  Passed: %d  Failed: %d\n' "$pass" "$fail_count"
[[ "$fail_count" -eq 0 ]] || exit 1
