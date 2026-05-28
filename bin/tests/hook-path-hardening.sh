#!/usr/bin/env bash
# hook-path-hardening.sh — every hook that invokes pipeline-* binaries must
# still resolve them when Claude Code fires with a sanitized PATH.
set -euo pipefail

export CLAUDE_PLUGIN_DATA=$(mktemp -d)
HOOKS_DIR="$(cd "$(dirname "$0")/../../hooks" && pwd)"
BIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$BIN_DIR/.." && pwd)"
export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"

# Sanitized PATH: keep only system paths, drop plugin bin. This mimics how
# Claude Code invokes hooks in production.
SAFE_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

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

_seed_run() {
  local rid="$1" state="$2"
  mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$rid"
  printf '%s' "$state" > "$CLAUDE_PLUGIN_DATA/runs/$rid/state.json"
  ln -sfn "$CLAUDE_PLUGIN_DATA/runs/$rid" "$CLAUDE_PLUGIN_DATA/runs/current"
}

echo "=== subagent-stop-transcript writes worktree under sanitized PATH ==="

_seed_run "run-path-hard" '{"status":"running","tasks":{"task-aa":{"status":"executing"}}}'
# Provide a transcript with [task:task-aa] header and cwd entry so the hook
# can derive task_id and worktree without .active-spawn.json (parallel-safe path).
_ht_ts="$CLAUDE_PLUGIN_DATA/runs/run-path-hard/transcript.jsonl"
printf '[task:task-aa]\n' > "$_ht_ts"
printf '{"cwd":"/tmp/fake/.claude/worktrees/agent-aa","content":"work done"}\n' >> "$_ht_ts"
# Keep .active-spawn.json as a task_id fallback (without worktree — worktree
# now comes exclusively from the transcript cwd).
jq -n --arg t "task-aa" \
  '{run_id:"run-path-hard", task_id:$t, written_at:"2026-05-27T00:00:00Z"}' \
  > "$CLAUDE_PLUGIN_DATA/runs/run-path-hard/.active-spawn.json"

input=$(jq -cn --arg ts "$_ht_ts" --arg msg "Done.
STATUS: DONE" '{agent_type:"task-executor", last_assistant_message:$msg, agent_transcript_path:$ts}')

set +e
printf '%s' "$input" \
  | env -i HOME="$HOME" PATH="$SAFE_PATH" CLAUDE_PLUGIN_DATA="$CLAUDE_PLUGIN_DATA" CLAUDE_PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT" \
      bash "$HOOKS_DIR/subagent-stop-transcript.sh" >/dev/null 2>/tmp/path-hard.err
rc=$?
set -e

assert_eq "subagent-stop-transcript exits 0 with sanitized PATH" "0" "$rc"
exec_status=$(jq -r '.tasks."task-aa".executor_status // empty' "$CLAUDE_PLUGIN_DATA/runs/run-path-hard/state.json")
assert_eq "executor_status persisted under sanitized PATH" "DONE" "$exec_status"
wt=$(jq -r '.tasks."task-aa".worktree // empty' "$CLAUDE_PLUGIN_DATA/runs/run-path-hard/state.json")
assert_eq "worktree persisted under sanitized PATH" "/tmp/fake/.claude/worktrees/agent-aa" "$wt"

echo ""
echo "=== Results: $pass passed, $fail failed ==="
exit $(( fail > 0 ? 1 : 0 ))
