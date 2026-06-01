#!/usr/bin/env bash
# PostToolUse asyncRewake hook (matcher: ^Bash$, async: true, asyncRewake: true).
# After `gh pr create` fires for a pipeline task, poll the PR's CI status in
# the background until terminal. Write the outcome to state, emit task.ci,
# and exit 2 with a stderr reminder to wake Claude — the wake payload tells
# the orchestrator to re-invoke pipeline-run-task --stage ship --ci-status.
#
# Compatibility: asyncRewake was introduced in a recent Claude Code release.
# bin/pipeline-scaffold omits this hook entry from merged-settings.json when
# the installed Claude Code version is below the supported minimum; this
# script is a defensive second layer — if CLAUDE_VERSION is absent or too
# low, warn once and exit 0 (no-op).
#
# Stdin: PostToolUse JSON with tool_input.command + tool_response.
# Env:   CLAUDE_PLUGIN_DATA, CLAUDE_VERSION (optional).
set -euo pipefail

# Canonicalize CLAUDE_PLUGIN_DATA before reading from it. When a foreign plugin
# (e.g. codex) leaks its CLAUDE_PLUGIN_DATA into this session, pipeline-lib.sh's
# top-level redirect rewrites the env var to factory's data dir. Without this,
# the hook reads from the wrong runs/current and silent-exits, losing CI tracking
# for the run.
_lib="${CLAUDE_PLUGIN_ROOT:-}/bin/pipeline-lib.sh"
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -f "$_lib" ]]; then
  # shellcheck disable=SC1090
  source "$_lib" 2>/dev/null || true
fi

if command -v _factory_ensure_plugin_bin_path >/dev/null 2>&1; then
  _factory_ensure_plugin_bin_path
fi

min_major=2
min_minor=1
min_patch=116

ver="${CLAUDE_VERSION:-}"
if [[ -n "$ver" ]]; then
  # Parse "x.y.z" (or "claude-code/x.y.z"); tolerate extra suffixes.
  clean=$(printf '%s' "$ver" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [[ -n "$clean" ]]; then
    IFS=. read -r v1 v2 v3 <<< "$clean"
    if (( v1 < min_major )) \
       || (( v1 == min_major && v2 < min_minor )) \
       || (( v1 == min_major && v2 == min_minor && v3 < min_patch )); then
      echo "[asyncrewake-ci] warn: Claude Code $ver below $min_major.$min_minor.$min_patch; asyncRewake may not fire" >&2
      exit 0
    fi
  fi
fi

input=$(cat 2>/dev/null || printf '{}')
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
# Fire on a direct `gh pr create` OR on a pipeline-run-task ship invocation
# (the wrapper creates the PR internally, so PostToolUse sees the wrapper
# command, not the nested gh call).
_is_pr_create=false
_is_wrapper_ship=false
[[ "$cmd" =~ ^[[:space:]]*gh[[:space:]]+pr[[:space:]]+create ]] && _is_pr_create=true
[[ "$cmd" =~ pipeline-run-task.*--stage[[:space:]]+ship([[:space:]]|$) ]] && _is_wrapper_ship=true
[[ "$_is_pr_create" == "true" || "$_is_wrapper_ship" == "true" ]] || exit 0

current_link="${CLAUDE_PLUGIN_DATA:-}/runs/current"
if [[ -z "${CLAUDE_PLUGIN_DATA:-}" || ! -L "$current_link" ]]; then
  exit 0
fi
run_dir=$(readlink "$current_link" 2>/dev/null) || exit 0
state_file="$run_dir/state.json"
[[ -f "$state_file" ]] || exit 0
run_id=$(basename "$run_dir")

# Find the most recently created PR for this run. The tool_response usually
# contains the URL (e.g., https://github.com/org/repo/pull/1234).
resp=$(printf '%s' "$input" | jq -r '.tool_response.stdout // .tool_response // ""' 2>/dev/null)
pr_url=$(printf '%s' "$resp" | grep -oE 'https://github\.com/[^[:space:]]+/pull/[0-9]+' | head -1 || printf '')
pr_number=$(printf '%s' "$pr_url" | grep -oE '[0-9]+$' || printf '')

# Wrapper invocations do not print the PR URL to stdout. The wrapper command
# carries the task id (`pipeline-run-task <run_id> <task_id> --stage ship`), so
# resolve that task's PR directly. Under parallel tasks multiple tasks can be
# `reviewing` at once, so picking "the last reviewing task" would mis-resolve
# the PR; the task_id from the command is the unambiguous key.
wrapper_task_id=""
if [[ -z "$pr_number" && "$_is_wrapper_ship" == "true" ]]; then
  # Tokenise; the 2nd non-flag token after `pipeline-run-task` is the task id.
  read -r -a _ct <<< "$cmd"
  for ((i=0; i<${#_ct[@]}; i++)); do
    if [[ "${_ct[i]}" == *pipeline-run-task ]]; then
      _seen_pos=0
      for ((j=i+1; j<${#_ct[@]}; j++)); do
        [[ "${_ct[j]}" == -* ]] && continue
        _seen_pos=$((_seen_pos+1))
        if (( _seen_pos == 2 )); then wrapper_task_id="${_ct[j]}"; break; fi
      done
      break
    fi
  done
  if [[ -n "$wrapper_task_id" ]]; then
    pr_number=$(jq -r --arg t "$wrapper_task_id" '
      .tasks[$t]
      | select(. != null)
      | select(.status == "reviewing")
      | select((.pr_number // "") != "")
      | select((.ci_status // "") | (. == "" or . == "pending"))
      | .pr_number // empty
    ' "$state_file" 2>/dev/null)
  fi
fi
[[ -z "$pr_number" ]] && exit 0

# Derive task_id. For the wrapper path we already have it from the command;
# otherwise (direct `gh pr create`) look up the task whose pr_number matches.
if [[ -n "$wrapper_task_id" ]]; then
  task_id="$wrapper_task_id"
else
  task_id=$(jq -r --arg n "$pr_number" '
    [.tasks | to_entries[]
     | select((.value.pr_number // "" | tostring) == $n)
     | .key] | first // empty
  ' "$state_file")
fi
[[ -z "$task_id" ]] && exit 0

# Phase 1: Poll CI checks. max 60m total @ 30s interval = 120 iterations.
max_iter=${ASYNCREWAKE_CI_MAX:-120}
sleep_s=${ASYNCREWAKE_CI_SLEEP:-30}
max_consecutive_gh_failures=${ASYNCREWAKE_GH_FAIL_BUDGET:-3}
ci_conclusion="timeout"
gh_fail_count=0
for _ in $(seq 1 $max_iter); do
  sleep "$sleep_s"
  _gh_err=$(mktemp)
  if ! rollup=$(gh pr view "$pr_number" --json statusCheckRollup 2>"$_gh_err"); then
    gh_fail_count=$((gh_fail_count + 1))
    printf '[asyncrewake-ci] WARN: gh pr view failed (attempt %d/%d) for PR %s: %s\n' \
      "$gh_fail_count" "$max_consecutive_gh_failures" "$pr_number" "$(tr -d '\n' < "$_gh_err")" >&2
    rm -f "$_gh_err"
    if (( gh_fail_count >= max_consecutive_gh_failures )); then
      ci_conclusion="gh_error"
      break
    fi
    continue
  fi
  rm -f "$_gh_err"
  gh_fail_count=0
  decision=$(printf '%s' "$rollup" | jq -r '
    .statusCheckRollup // []
    | map(.conclusion)
    | if length == 0 then "pending"
      elif any(. == null or . == "") then "pending"
      elif any(. == "FAILURE" or . == "CANCELLED" or . == "TIMED_OUT"
               or . == "STALE" or . == "ACTION_REQUIRED" or . == "STARTUP_FAILURE") then "red"
      elif all(. == "SUCCESS" or . == "NEUTRAL" or . == "SKIPPED") then "green"
      else "red" end
  ')
  case "$decision" in
    green|red) ci_conclusion="$decision"; break ;;
    pending)   continue ;;
  esac
done

# Phase 2: If CI passed, wait for auto-merge to land. max 5m @ 10s = 30 polls.
# ci_status always reflects the check outcome (green/red/timeout/gh_error).
# merge_status is separate: merged|stalled|gh_error|n/a (n/a when ci not green).
merge_status="n/a"
if [[ "$ci_conclusion" == "green" ]]; then
  merge_max=${ASYNCREWAKE_MERGE_MAX:-30}
  merge_sleep=${ASYNCREWAKE_MERGE_SLEEP:-10}
  merged=false
  gh_fail_count=0
  for _ in $(seq 1 $merge_max); do
    sleep "$merge_sleep"
    _gh_err=$(mktemp)
    if ! pr_state_raw=$(gh pr view "$pr_number" --json state,mergedAt 2>"$_gh_err"); then
      gh_fail_count=$((gh_fail_count + 1))
      printf '[asyncrewake-ci] WARN: gh pr view merge-poll failed (attempt %d/%d) for PR %s: %s\n' \
        "$gh_fail_count" "$max_consecutive_gh_failures" "$pr_number" "$(tr -d '\n' < "$_gh_err")" >&2
      rm -f "$_gh_err"
      if (( gh_fail_count >= max_consecutive_gh_failures )); then
        merge_status="gh_error"
        break
      fi
      continue
    fi
    rm -f "$_gh_err"
    gh_fail_count=0
    pr_state=$(printf '%s' "$pr_state_raw" \
      | jq -r 'if .state == "MERGED" or (.mergedAt != null and .mergedAt != "") then "merged" else "open" end')
    if [[ "$pr_state" == "merged" ]]; then
      merged=true
      break
    fi
  done
  if [[ "$merge_status" != "gh_error" ]]; then
    if [[ "$merged" == "true" ]]; then
      merge_status="merged"
    else
      merge_status="stalled"
      printf '[asyncrewake-ci] CI green but auto-merge stalled on PR %s after %ss\n' \
        "$pr_number" "$((merge_max * merge_sleep))" >&2
    fi
  fi
fi

# Write to state + emit metric.
# H10: do NOT silently swallow state-write failure — wake payload would tell the
# orchestrator "green" while state.json keeps the old value (drift class:
# f1f5264 / 2158366). Capture stderr, log on failure, but proceed with the wake
# so the operator at least sees the stderr reminder (exit 2 below).
_state_err=$(pipeline-state task-write "$run_id" "$task_id" ci_status "\"$ci_conclusion\"" 2>&1 >/dev/null) \
  || printf '[asyncrewake-ci] WARN: ci_status state write failed: %s\n' "$_state_err" >&2
_state_err=$(pipeline-state task-write "$run_id" "$task_id" merge_status "\"$merge_status\"" 2>&1 >/dev/null) \
  || printf '[asyncrewake-ci] WARN: merge_status state write failed: %s\n' "$_state_err" >&2
unset _state_err
# pipeline-lib.sh was sourced near the top (for CLAUDE_PLUGIN_DATA canonicalization);
# emit_ci_metric is exported from that source.
if command -v emit_ci_metric >/dev/null 2>&1; then
  emit_ci_metric task "$pr_number" "$ci_conclusion" 2>/dev/null || true
fi

# Wake Claude via exit 2 + stderr reminder.
printf 'CI terminal for task %s (pr %s): ci=%s merge=%s — call pipeline-run-task %s %s --stage ship --ci-status %s --merge-status %s to finalize.\n' \
  "$task_id" "$pr_number" "$ci_conclusion" "$merge_status" "$run_id" "$task_id" "$ci_conclusion" "$merge_status" >&2
exit 2
