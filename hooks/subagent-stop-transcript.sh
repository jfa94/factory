#!/usr/bin/env bash
# SubagentStop hook: parse the subagent's STATUS line and transcript and
# write channelled artifacts (worktree, review files, four-status) into
# pipeline state. Complements hooks/subagent-stop-gate.sh (which emits
# warnings); this one owns the orchestrator-facing hand-off.
#
# Matcher (in templates/settings.autonomous.json):
#   "^(task-executor|implementation-reviewer|quality-reviewer|security-reviewer|architecture-reviewer|scribe|spec-generator|spec-reviewer)$"
#
# Stdin: JSON with agent_type, last_assistant_message, agent_transcript_path,
# session_id, and (optionally) agent task_id in tool/context.
#
# Writes:
#   .tasks.$t.executor_status   (task-executor)
#   .tasks.$t.reviewer_status   (reviewer roles)
#   .tasks.$t.worktree          (first executor worktree seen)
#   .tasks.$t.review_files      (array of per-reviewer output file paths)
#   .scribe.status              (scribe)
# Emits metric: pipeline.subagent.end agent_type=... status=...
#
# Exit: 0 normally; 1 if scribe state write fails (fatal).
set -euo pipefail

# Canonicalize CLAUDE_PLUGIN_DATA before reading from it. When a foreign plugin
# (e.g. codex) leaks its CLAUDE_PLUGIN_DATA into this session, pipeline-lib.sh's
# top-level redirect rewrites the env var to factory's data dir. Without this,
# the hook reads from the wrong runs/current and silent-exits, losing all state
# writes for the run.
_lib="${CLAUDE_PLUGIN_ROOT:-}/bin/pipeline-lib.sh"
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -f "$_lib" ]]; then
  # shellcheck disable=SC1090
  source "$_lib" 2>/dev/null || true
fi

# Hooks fire with sanitized PATH; the helper prepends ${CLAUDE_PLUGIN_ROOT}/bin
# so the pipeline-state writes below resolve. Without this, every state write
# silently fails with "command not found" and the orchestrator sees null fields.
if command -v _factory_ensure_plugin_bin_path >/dev/null 2>&1; then
  _factory_ensure_plugin_bin_path
fi

current_link="${CLAUDE_PLUGIN_DATA:-}/runs/current"
if [[ -z "${CLAUDE_PLUGIN_DATA:-}" ]]; then
  # No plugin data dir — hook not configured for this run. Silent exit is OK.
  exit 0
fi
if [[ ! -L "$current_link" ]]; then
  # Plugin data dir IS set AND has been canonicalized above, yet the symlink
  # is genuinely missing. This is the failure mode that hides all subagent
  # state writes. Log loudly so it surfaces in transcripts and stderr.
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '[%s] [WARN] subagent-stop-transcript: runs/current symlink missing under %s — state writes skipped\n' \
    "$ts" "$CLAUDE_PLUGIN_DATA" >&2
  err_log="$CLAUDE_PLUGIN_DATA/hook-errors.log"
  printf '[%s] subagent-stop-transcript: symlink missing\n' "$ts" >> "$err_log" 2>/dev/null || true
  exit 0
fi
run_dir=$(readlink "$current_link" 2>/dev/null) || exit 0
state_file="$run_dir/state.json"
[[ -f "$state_file" ]] || exit 0
run_id=$(basename "$run_dir")

input=$(cat 2>/dev/null || printf '{}')
agent_type=$(printf '%s' "$input" | jq -r '.agent_type // .subagent_type // empty')
agent_type="${agent_type#factory:}"
last_msg=$(printf '%s' "$input" | jq -r '.last_assistant_message // empty')
transcript=$(printf '%s' "$input" | jq -r '.agent_transcript_path // .transcript_path // empty')
[[ -z "$agent_type" ]] && exit 0

# --- 1. Parse STATUS line ---
# grep returns 1 on no-match; `set -euo pipefail` would abort the script, so
# swallow failures explicitly.
status=""
if [[ -n "$last_msg" ]]; then
  status=$(printf '%s' "$last_msg" \
    | { grep -oE 'STATUS:[[:space:]]+(DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT|RED_READY|NO_WORK|SKIP)' || true; } \
    | tail -1 | awk '{print $2}')
fi
[[ -z "$status" ]] && status="BLOCKED"  # missing STATUS line => treat as blocked

# --- 2. Derive task_id ---
# Priority order:
#   1. explicit FACTORY_TASK_ID env (legacy passthrough, rarely set)
#   2. inlined [task:<id>] prompt-header marker in the transcript (preferred —
#      parallel-safe; each agent has its own transcript)
#   3. orchestrator-written .active-spawn.json (legacy fallback — raced when
#      maxParallelTasks>1, retained only when no header is present)
#   4. transcript-grep for the prompt-file path (last resort, fragile because
#      some subagent tool patterns omit the prompt-file reference)
task_id="${FACTORY_TASK_ID:-}"

# Pre-declare worktree so the cwd grep below can populate it.
worktree=""

# Source #2 (preferred): inlined `[task:<id>]` prompt-header marker. The wrapper
# prepends this to every task prompt; the orchestrator inlines prompt CONTENT
# into Agent(prompt=...), so the header lands in this subagent's transcript.
# Parallel-safe: each agent has its own transcript (unlike .active-spawn.json).
if [[ -z "$task_id" && -f "$transcript" ]]; then
  task_id=$({ grep -oE '\[task:[a-zA-Z0-9_-]+\]' "$transcript" 2>/dev/null || true; } \
    | head -1 | sed -E 's/\[task:([a-zA-Z0-9_-]+)\]/\1/')
fi

# Source #3 (fallback): orchestrator-written active-spawn file (legacy; raced
# under parallel batches, retained only as a fallback when no header is present).
# NOTE: worktree is intentionally NOT read from active-spawn — it must come from
# the transcript cwd grep below so the executor's REAL tree is always captured.
active_file="$run_dir/.active-spawn.json"
if [[ -z "$task_id" && -f "$active_file" ]]; then
  task_id=$(jq -r '.task_id // empty' "$active_file" 2>/dev/null || printf '')
fi

# Source #4 (last resort): legacy prompt-file path grep.
if [[ -z "$task_id" && -f "$transcript" ]]; then
  # Look for `<run-id>/<task-id>.<role>-prompt.md` reference in transcript.
  task_id=$({ grep -oE "\.state/${run_id}/[a-zA-Z0-9_-]+\.(test-writer|executor-ci-fix|executor-fix|executor|holdout-reviewer|reviewer|holdout)-prompt\.md" "$transcript" 2>/dev/null || true; } \
    | head -1 \
    | sed -E "s|.*\.state/${run_id}/([a-zA-Z0-9_-]+)\..*|\1|")
fi

# --- Holdout-reviewer role detection ---
# The holdout reviewer reuses subagent_type=implementation-reviewer (no dedicated
# subagent exists), so agent_type alone cannot discriminate it from a regular
# postreview implementation-reviewer. Detect first by grepping the transcript for
# the inlined `[role:holdout-reviewer]` header (parallel-safe, inline-prompt-
# compatible), falling back to the legacy prompt-file path grep.
is_holdout_reviewer=false
if [[ "$agent_type" == "implementation-reviewer" && -f "$transcript" ]]; then
  if grep -qE '\[role:holdout-reviewer\]' "$transcript" 2>/dev/null; then
    is_holdout_reviewer=true
  elif grep -qE "\.state/${run_id}/[a-zA-Z0-9_-]+\.holdout-reviewer-prompt\.md" "$transcript" 2>/dev/null; then
    is_holdout_reviewer=true
  fi
fi

if [[ -z "$task_id" && "$agent_type" == "scribe" ]]; then
  task_id="RUN"
fi

# Fail-loud: when neither source yielded a task_id for an agent that needs one,
# log a warning and append to transcript-errors.log so the orchestrator can
# see why the worktree write was skipped. scribe legitimately resolves to RUN
# above so it is excluded.
if [[ -z "$task_id" && "$agent_type" != "scribe" ]]; then
  printf '[%s] [WARN] subagent-stop-transcript: could not derive task_id for agent=%s run=%s (active-spawn=%s, transcript=%s)\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$agent_type" "$run_id" \
    "$([[ -f "$active_file" ]] && echo present || echo absent)" \
    "$([[ -f "$transcript" ]] && echo present || echo absent)" \
    >> "$run_dir/transcript-errors.log" 2>/dev/null || true
  printf '[subagent-stop-transcript] WARN: could not derive task_id for agent=%s run=%s\n' \
    "$agent_type" "$run_id" >&2
fi

# --- 3. Extract worktree from transcript ---
# For task-executor: scan transcript for `cwd` entries under the plugin's
# ephemeral worktree root (.claude/worktrees/). First match wins. Skipped when
# the active-spawn file already provided a worktree above.
if [[ -z "$worktree" \
     && ( "$agent_type" == "task-executor" || "$agent_type" == "test-writer" \
     || "$agent_type" == "implementation-reviewer" || "$agent_type" == "quality-reviewer" \
     || "$agent_type" == "security-reviewer" || "$agent_type" == "architecture-reviewer" ) \
     && -f "$transcript" ]]; then
  worktree=$({ grep -oE '"cwd":[[:space:]]*"[^"]*\.claude/worktrees/[^"]+"' "$transcript" 2>/dev/null || true; } \
    | head -1 \
    | sed -E 's/.*"cwd":[[:space:]]*"([^"]+)".*/\1/')
fi

# --- 4. Write review file (reviewer roles) ---
review_path=""
case "$agent_type" in
  implementation-reviewer|quality-reviewer|security-reviewer|architecture-reviewer)
    if [[ -n "$task_id" && "$task_id" != "RUN" ]]; then
      mkdir -p "$run_dir/.state/$run_id"
      if $is_holdout_reviewer; then
        # Holdout reviewer output is consumed by `pipeline-holdout-validate
        # check`, NOT by postreview's `review_files[]` parser. Route it to a
        # distinct file so the two streams cannot collide.
        review_path="$run_dir/.state/$run_id/$task_id.review.holdout-reviewer.md"
      else
        review_path="$run_dir/.state/$run_id/$task_id.review.$agent_type.md"
      fi
      printf '%s' "$last_msg" > "$review_path"
    fi
    ;;
esac

# --- 5. State writes ---
if [[ -n "$task_id" && "$task_id" != "RUN" ]]; then
  case "$agent_type" in
    test-writer)
      pipeline-state task-write "$run_id" "$task_id" test_writer_status "\"$status\"" \
        >/dev/null 2>>"$run_dir/transcript-errors.log" \
        || printf '[subagent-stop-transcript] WARN: task-write test_writer_status failed for %s\n' "$task_id" >&2
      if [[ -n "$worktree" ]]; then
        pipeline-state task-write "$run_id" "$task_id" test_writer_worktree "\"$worktree\"" \
          >/dev/null 2>>"$run_dir/transcript-errors.log" \
          || printf '[subagent-stop-transcript] WARN: test_writer_worktree write failed for %s/%s\n' "$run_id" "$task_id" >&2
        # Bare .worktree preserved for downstream readers (ship/cleanup/score).
        # Test-writer writes first; executor will overwrite later (last-writer-wins
        # is expected — bare field semantically tracks the executor's worktree).
        pipeline-state task-write "$run_id" "$task_id" worktree "\"$worktree\"" \
          >/dev/null 2>>"$run_dir/transcript-errors.log" \
          || printf '[subagent-stop-transcript] WARN: worktree write failed for %s/%s (test-writer)\n' "$run_id" "$task_id" >&2
        _tw_branch=$(git -C "$worktree" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
        _tw_commit=$(git -C "$worktree" rev-parse HEAD 2>/dev/null || true)
        if [[ -n "$_tw_branch" && "$_tw_branch" != "HEAD" ]]; then
          pipeline-state task-write "$run_id" "$task_id" prior_work_dir "\"$worktree\"" \
            >/dev/null 2>>"$run_dir/transcript-errors.log" \
            || printf '[subagent-stop-transcript] WARN: task-write prior_work_dir failed for %s\n' "$task_id" >&2
          pipeline-state task-write "$run_id" "$task_id" prior_branch "\"$_tw_branch\"" \
            >/dev/null 2>>"$run_dir/transcript-errors.log" \
            || printf '[subagent-stop-transcript] WARN: task-write prior_branch failed for %s\n' "$task_id" >&2
        fi
        if [[ -n "$_tw_commit" ]]; then
          pipeline-state task-write "$run_id" "$task_id" prior_commit "\"$_tw_commit\"" \
            >/dev/null 2>>"$run_dir/transcript-errors.log" \
            || printf '[subagent-stop-transcript] WARN: task-write prior_commit failed for %s\n' "$task_id" >&2
        fi
      fi
      ;;
    task-executor)
      pipeline-state task-write "$run_id" "$task_id" executor_status "\"$status\"" \
        >/dev/null 2>>"$run_dir/transcript-errors.log" \
        || printf '[subagent-stop-transcript] WARN: task-write executor_status failed for %s\n' "$task_id" >&2
      if [[ -n "$worktree" ]]; then
        pipeline-state task-write "$run_id" "$task_id" executor_worktree "\"$worktree\"" \
          >/dev/null 2>>"$run_dir/transcript-errors.log" \
          || printf '[subagent-stop-transcript] WARN: executor_worktree write failed for %s/%s\n' "$run_id" "$task_id" >&2
        pipeline-state task-write "$run_id" "$task_id" worktree "\"$worktree\"" \
          >/dev/null 2>>"$run_dir/transcript-errors.log" \
          || printf '[subagent-stop-transcript] WARN: worktree write failed for %s/%s (task-executor)\n' "$run_id" "$task_id" >&2
      fi
      ;;
    implementation-reviewer|quality-reviewer|security-reviewer|architecture-reviewer)
      # Shared key (last-writer-wins, retained for back-compat)
      pipeline-state task-write "$run_id" "$task_id" reviewer_status "\"$status\"" \
        >/dev/null 2>>"$run_dir/transcript-errors.log" \
        || printf '[subagent-stop-transcript] WARN: task-write reviewer_status failed for %s\n' "$task_id" >&2
      # Per-role key: implementation_reviewer_status, quality_reviewer_status, etc.
      _role_key="${agent_type//-/_}_status"
      pipeline-state task-write "$run_id" "$task_id" "$_role_key" "\"$status\"" \
        >/dev/null 2>>"$run_dir/transcript-errors.log" \
        || printf '[subagent-stop-transcript] WARN: task-write %s failed for %s\n' "$_role_key" "$task_id" >&2
      if [[ -n "$worktree" ]]; then
        pipeline-state task-write "$run_id" "$task_id" "reviewer_worktree_${agent_type//-/_}" "\"$worktree\"" \
          >/dev/null 2>>"$run_dir/transcript-errors.log" \
          || printf '[subagent-stop-transcript] WARN: task-write reviewer_worktree_%s failed for %s\n' "${agent_type//-/_}" "$task_id" >&2
      fi
      if [[ -n "$review_path" ]]; then
        if $is_holdout_reviewer; then
          # Layer 4 holdout output is consumed by `pipeline-holdout-validate
          # check` at the next postexec invocation, NOT by postreview. Write
          # to the dedicated single-value field so postreview's review_files[]
          # parser never sees this artifact.
          pipeline-state task-write "$run_id" "$task_id" holdout_review_file "\"$review_path\"" \
            >/dev/null 2>>"$run_dir/transcript-errors.log" \
            || printf '[subagent-stop-transcript] WARN: holdout_review_file write failed for %s\n' "$task_id" >&2
        else
          pipeline-state task-array-append "$run_id" "$task_id" review_files "\"$review_path\"" >/dev/null \
            || printf '[subagent-stop-transcript] WARN: review_files append failed for %s\n' "$task_id" >&2
        fi
      fi
      ;;
  esac
fi

if [[ "$agent_type" == "scribe" ]]; then
  scribe_status=$( [[ "$status" == "DONE" || "$status" == "DONE_WITH_CONCERNS" ]] && echo done || echo failed )
  if ! pipeline-state write "$run_id" '.scribe.status' "\"$scribe_status\"" 2>/dev/null; then
    printf '[subagent-stop-transcript] ERROR: failed to write scribe.status=%s for run %s\n' \
      "$scribe_status" "$run_id" >&2
    exit 1
  fi
  # On terminal success, reset re-spawn attempts so a future re-entry is not
  # falsely capped on stale state.
  if [[ "$scribe_status" == "done" ]]; then
    pipeline-state write "$run_id" '.scribe.attempts' '0' >/dev/null 2>&1 || true
  fi
  # Remove path-scope sentinel regardless of outcome so the guard does not
  # persist after scribe exits (even on failure/retry the next spawn writes a
  # fresh sentinel).
  rm -f "$run_dir/.scribe_active" 2>/dev/null || true
fi

# --- 6. Emit metric ---
# pipeline-lib.sh was sourced at the top of this hook for env-var
# canonicalization, so log_metric is already available here.
if command -v log_metric >/dev/null 2>&1; then
  log_metric "pipeline.subagent.end" \
    "agent_type=\"$agent_type\"" \
    "status=\"$status\"" \
    "task_id=\"${task_id:-}\"" 2>/dev/null || true
fi

exit 0
