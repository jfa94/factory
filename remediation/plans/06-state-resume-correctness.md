# Plan 06 — State & Resume Correctness

**Priority:** P1 (major — resume is load-bearing for long runs; current behavior silently corrupts state)
**Tasks:** `task_06_01` through `task_06_06`
**Findings:** M8, M9, M10, M11, M12, M13

## Problem

Six correctness bugs in state, lock, circuit-breaker, and resume logic. Each one is individually subtle; collectively they mean a run that is interrupted (crash, Ctrl-C, rate limit) cannot be safely resumed.

1. **M8 — resume-point ordering wrong.** `pipeline-state resume-point` returns the first task with status `pending`, ignoring `execution_order`. If tasks are listed `[A, B, C]` in `tasks.json` but `execution_order` says `[C, A, B]` (because of `depends_on`), resume incorrectly restarts from A even when C is the genuine next task.

2. **M9 — stop-gate misses `ci_fixing` and `needs_human_review` statuses.** `hooks/stop-gate.sh` only checks `running`/`failed`. Tasks in `ci_fixing` (waiting for CI) or `needs_human_review` (blocked) are treated as idle, so the session is allowed to stop.

3. **M10 — subagent-stop-gate looks at one task only.** The gate is called once per subagent return and checks only that subagent's task, not the overall run. It misses the case where one task is done but the run has 5 more pending tasks.

4. **M11 — state symlink races between runs.** `.state/current` is a symlink updated with `ln -sfn`. Two concurrent runs (orchestrator + cleanup) can race and leave `current` pointing at a deleted run directory.

5. **M12 — pipeline-lock acquire is not atomic with recovery.** The lock file is written then the PID is checked. If the process holding the lock dies between write and check, the recovery path can both (a) acquire the lock and (b) leave the previous lock file's contents, producing "lock owned by PID X" output after acquiring.

6. **M13 — circuit-breaker counts pause time as runtime.** `pipeline-circuit-breaker` reads `.started_at` and compares to `now()`. If the run was paused overnight for a rate limit (18 hours in `.paused_until`), the 18 hours count against `maxRuntimeMinutes` and the breaker trips on the next check.

## Scope

In: fix all 6 bugs. Out: MCP metrics schema (plan 13), telemetry writes (plan 13).

## Tasks

| task_id    | Title                                                  |
| ---------- | ------------------------------------------------------ |
| task_06_01 | Order `resume-point` by `execution_order` (M8)         |
| task_06_02 | Add `ci_fixing`/`needs_human_review` to stop-gate (M9) |
| task_06_03 | Make subagent-stop-gate consider the whole run (M10)   |
| task_06_04 | Make `.state/current` symlink update atomic (M11)      |
| task_06_05 | Atomic lock acquire with PID recovery (M12)            |
| task_06_06 | Subtract pause time from circuit-breaker runtime (M13) |

See `remediation/tasks.json` for `acceptance_criteria` and `tests_to_write`.

## Execution Guidance

### task_06_01 — resume-point respects execution_order

File: `bin/pipeline-state`

Current `resume-point` action reads `.tasks` keys in jq-object order (which is not the execution order). Replace with a lookup driven by `execution_order`:

```bash
# Before
jq -r '.tasks | to_entries | map(select(.value.status == "pending")) | .[0].key' "$state_file"

# After
jq -r '
  .execution_order
  | map(.task_id) as $order
  | $order
  | map(. as $tid | select(.tasks[$tid].status == "pending"))
  | .[0] // empty
' "$state_file" 2>/dev/null || jq -r '...old fallback...'
```

Wait — the above has a jq scoping issue (`$order` then `.tasks[$tid]` loses outer context). Cleaner:

```bash
jq -r '
  . as $root
  | ($root.execution_order // [] | map(.task_id))
  | map(. as $tid | select($root.tasks[$tid].status == "pending"))
  | .[0] // empty
' "$state_file"
```

Fallback when `.execution_order` is missing (old runs): fall back to the current behavior (`.tasks | to_entries`).

Also respect `depends_on`: a pending task whose dependencies are not all done should NOT be the resume point. Filter:

```bash
jq -r '
  . as $root
  | ($root.execution_order // [] | map(.task_id))
  | map(. as $tid
        | select($root.tasks[$tid].status == "pending")
        | select(
            ($root.tasks[$tid].depends_on // [])
            | all($root.tasks[.].status == "done")
          ))
  | .[0] // empty
' "$state_file"
```

Test in `bin/test-phase1.sh`:

1. State with `execution_order=[C,A,B]`, tasks A/B pending, C done → returns `A`.
2. State with `execution_order=[A,B,C]`, A done, B pending with `depends_on=[C]`, C pending → returns `C` (not `B`, because `B` has unmet deps).
3. Empty `execution_order` → falls back to jq-object iteration order.

### task_06_02 — stop-gate recognizes in-flight statuses

File: `hooks/stop-gate.sh`

Read the current stop-gate logic. It currently counts statuses in state and allows stop when no tasks are `running`. Extend the "blocking" status set:

```bash
blocking_count=$(jq -r '
  [.tasks[] | select(.status | IN("running","ci_fixing","needs_human_review","pending"))] | length
' "$state_file")

if [[ "$blocking_count" -gt 0 ]]; then
  # Do not allow stop
  echo '{"decision":"block","reason":"tasks_in_flight","count":'"$blocking_count"'}'
  exit 2  # PreToolUse/Stop block exit code
fi
```

The set is `{running, ci_fixing, needs_human_review, pending}` — any of these means "the run isn't finished". `failed` is terminal (already handled elsewhere); `done` and `skipped` are terminal; everything else is in-flight.

Test in `bin/test-phase1.sh`:

1. All tasks `done` → stop-gate allows (exit 0).
2. One task `ci_fixing` → stop-gate blocks (exit 2), output contains `"reason":"tasks_in_flight"`.
3. One task `needs_human_review` → blocks.
4. One task `pending` → blocks.

### task_06_03 — subagent-stop-gate uses whole-run state

File: `hooks/subagent-stop-gate.sh`

Currently the gate loads only the returning subagent's task. Replace with a whole-run check:

```bash
# Read the run state (not per-task state)
run_id="$(pipeline-state current-run-id)"
state_file=".state/$run_id/state.json"

pending_or_running=$(jq -r '
  [.tasks[] | select(.status | IN("pending","running","ci_fixing","needs_human_review"))] | length
' "$state_file")

if [[ "$pending_or_running" -gt 0 ]]; then
  # Orchestrator has more work — allow this subagent to stop but keep session alive
  echo '{"decision":"allow_subagent_stop","reason":"more_tasks","remaining":'"$pending_or_running"'}'
  exit 0
fi

# All tasks terminal — allow session stop
echo '{"decision":"allow_session_stop","reason":"all_terminal"}'
exit 0
```

The semantic fix: a subagent returning successfully with 0 pending tasks is terminal for the whole run; a subagent returning with 5+ pending tasks means the orchestrator should spawn more subagents.

Test in `bin/test-phase1.sh`:

- State with 3 `done`, 2 `pending` → output `decision=allow_subagent_stop`, `remaining=2`.
- State with 5 `done` → output `decision=allow_session_stop`.

### task_06_04 — Atomic `.state/current` symlink

File: `bin/pipeline-state`

Replace `ln -sfn "$run_id" .state/current` with atomic rename:

```bash
# Before
ln -sfn "$run_id" .state/current

# After
tmp_link=$(mktemp -u ".state/.current.XXXXXX")
ln -s "$run_id" "$tmp_link"
mv -T "$tmp_link" ".state/current"
```

`mv -T` is atomic when both paths are on the same filesystem. On macOS, `mv -T` isn't supported; use the `rename(2)` wrapper via python/node, or accept the tiny race and use `ln -sfn` with a comment explaining why it's acceptable on macOS (the race window is ~microseconds and we don't run concurrent orchestrators).

Pragmatic approach for a cross-platform shell script:

```bash
update_current_symlink() {
  local target="$1"
  local dir=".state"
  local tmp="$dir/.current.$$.$RANDOM"
  ln -s "$target" "$tmp" || return 1
  if ! mv -f "$tmp" "$dir/current" 2>/dev/null; then
    rm -f "$tmp"
    return 1
  fi
}
```

`mv -f` on the symlink is atomic on both Linux and macOS (both use `rename(2)` semantics when source and target are on the same FS). The `$$` PID in the tmp name guarantees no collision between concurrent processes.

Test in `bin/test-phase1.sh`:

- Create run `abc`, call `update_current_symlink abc` → readlink `.state/current` == `abc`.
- Call `update_current_symlink def` → readlink == `def`, no leftover `.current.*` tmp files.
- Race test: call in a subshell with `&` 10 times with different targets → exactly one value wins, no tmp leftovers.

### task_06_05 — Atomic lock acquire

File: `bin/pipeline-lock`

Current structure:

```bash
# Check file
# Parse PID
# If stale, rewrite
# Write our PID
```

The race: between "parse PID" and "write our PID", another process can ALSO pass the stale check and write its PID, producing two holders.

Replace with `mkdir` or `ln -s` atomicity (both are atomic in POSIX):

```bash
acquire_lock() {
  local lock_file="$1"
  local our_pid="${2:-$$}"
  local timeout="${3:-30}"
  local elapsed=0

  while (( elapsed < timeout )); do
    # Atomic: mkdir succeeds only if dir does not exist
    if mkdir "$lock_file.d" 2>/dev/null; then
      # We own the lock — write our PID for diagnostics
      echo "$our_pid" > "$lock_file.d/pid"
      echo "$(date -u +%FT%TZ)" > "$lock_file.d/acquired_at"
      jq -n --arg pid "$our_pid" '{action:"acquired", pid:$pid}'
      return 0
    fi

    # Lock held — check if holder is alive
    if [[ -f "$lock_file.d/pid" ]]; then
      local holder_pid
      holder_pid=$(cat "$lock_file.d/pid" 2>/dev/null || echo "")
      if [[ -n "$holder_pid" ]] && ! kill -0 "$holder_pid" 2>/dev/null; then
        # Holder is dead — try to recover by removing and retrying
        rm -rf "$lock_file.d" 2>/dev/null
        continue  # retry the mkdir
      fi
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  jq -n --arg holder "$(cat $lock_file.d/pid 2>/dev/null || echo unknown)" \
    '{action:"timeout", holder_pid:$holder}'
  return 1
}

release_lock() {
  local lock_file="$1"
  rm -rf "$lock_file.d"
}
```

Key property: `mkdir` either creates the directory or fails. If it creates, we exclusively own it. No PID-write race.

Test in `bin/test-phase1.sh`:

- Acquire lock, try to acquire again in same process → second call returns `timeout` after short wait.
- Acquire lock, kill the PID file's holder PID reference, try acquire → recovers, second call returns `acquired`.
- Live-PID test: write `pid=$$` (current shell PID), call `acquire --timeout 2 --pid 99998` → returns `timeout` since our own PID is alive.

### task_06_06 — Circuit breaker subtracts pause time

File: `bin/pipeline-circuit-breaker`

Current:

```bash
started_at=$(jq -r .started_at state.json)
now=$(date +%s)
started_epoch=$(date -j -f %FT%TZ "$started_at" +%s)
elapsed_min=$(( (now - started_epoch) / 60 ))
if (( elapsed_min > max_runtime_min )); then fail; fi
```

Bug: `elapsed_min` includes wall-clock time spent in `paused_until` windows. Track cumulative pause time instead:

```bash
# state.json fields we need
#   .started_at         — epoch ISO timestamp
#   .pause_history      — [{paused_at, resumed_at}, ...]
#   .pause_current      — {paused_at} or null while paused

cumulative_pause_seconds=$(jq -r '
  (.pause_history // []) as $h
  | ($h | map(
      (.resumed_at | fromdateiso8601)
      - (.paused_at | fromdateiso8601)
    ) | add) // 0
' "$state_file")

active_seconds=$(( (now - started_epoch) - cumulative_pause_seconds ))
active_minutes=$(( active_seconds / 60 ))

if (( active_minutes > max_runtime_min )); then
  jq -n --arg reason runtime --argjson active $active_minutes \
    '{tripped:true, reason:$reason, active_minutes:$active}'
  exit 1
fi
```

`pipeline-quota-check` (plan 02) already writes pause history when it pauses for rate limits. Callers of `pipeline-circuit-breaker` should record pauses via:

```bash
pipeline-state append "$run_id" .pause_history '{"paused_at":"NOW","resumed_at":null}'
# ... pause ...
pipeline-state patch-last "$run_id" .pause_history '{"resumed_at":"NOW"}'
```

Add `append` and `patch-last` actions to `pipeline-state` if they don't exist — both are one-liners with jq.

Test in `bin/test-phase1.sh`:

- State with `started_at` 2 hours ago, `pause_history` showing a 90-minute pause → `active_minutes ≈ 30`, circuit breaker not tripped (assuming `maxRuntimeMinutes=60`).
- Same setup but no pause history → `active_minutes ≈ 120`, breaker tripped with `reason="runtime"`.
- Live pause: `pause_current` set 30 minutes ago, no resumed yet → active time should exclude the currently-running pause as well.

## Verification

1. `bash bin/test-phase1.sh` — all state/lock/breaker tests pass (~12 new tests)
2. `jq -r '.[] | .name' .state/current/state.json` — no error, symlink intact
3. Resume test: manually write state with `execution_order=[C,A,B]` where A is done, verify `pipeline-state resume-point` returns `B` or `C` based on `depends_on`, never `A`.
4. Lock stress test: 10 concurrent `acquire` calls → exactly one succeeds at a time, all others either wait or time out cleanly.
5. Grep `bin/pipeline-lock` for `mkdir "$lock_file.d"` — present, confirming atomic acquire.
