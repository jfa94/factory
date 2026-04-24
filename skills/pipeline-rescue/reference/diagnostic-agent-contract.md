# Diagnostic Agent Contract

The `rescue-diagnostic` agent (`agents/rescue-diagnostic.md`) is a read-only Sonnet subagent that analyses a failed or flagged task and returns a structured decision.

## Input

Written by the skill to `$CLAUDE_PLUGIN_DATA/runs/<run-id>/rescue/diagnostic.<task-id>.input.json`:

```jsonc
{
  "run_id": "<run-id>",
  "task_id": "<task-id>",
  "issue_type": "I-13" | "I-14" | "I-16",
  "context": {
    "state_snapshot": { /* per-task state object from state.json */ },
    "worktree_path": "<abs-path-or-null>",
    "pr_url": "<url-or-null>",
    "pr_state": "<OPEN|CLOSED|MERGED|null>",
    "review_files": ["<path>", ...],
    "ci_logs_path": "<path-or-null>",
    "branch": "<branch-or-null>",
    "failure_reason": "<string-or-null>"
  }
}
```

## Output

Written by the agent to `diagnostic.<task-id>.output.json` in the same directory:

```jsonc
{
  "decision": "reset_pending" | "mark_failed" | "delete_branch" | "reset_postreview" | "no_action",
  "reason": "<one-paragraph root-cause summary>",
  "evidence": ["<file:line or log excerpt>", ...],
  "state_updates": { ".tasks.<id>.failure_reason": "<text>" /* optional extras */ },
  "confidence": "high" | "medium" | "low"
}
```

## Decision semantics

| decision         | when to choose                                                                    |
| ---------------- | --------------------------------------------------------------------------------- |
| reset_pending    | Task can be retried; code or context suggests a transient or environmental issue  |
| mark_failed      | Task is unrecoverable without human intervention; preserve branch + PR for triage |
| delete_branch    | Branch is an orphan with no task state and no useful content                      |
| reset_postreview | Review files are stale/contradictory; fresh review fan-out will unblock the task  |
| no_action        | Uncertain; no state change is safer than a wrong one                              |

## Guardrails

- Unknown decisions, missing fields, or malformed JSON → apply treats as `no_action` with `result: "error"` in audit trail.
- Agent timeout or missing output file → apply treats as `no_action` with reason `"diagnostic timeout"`.
- Agent is parallelised: one `Agent()` call per task in the same message.
- Agent declared tool set: Read, Grep, Glob, Write (output file only). No Edit, Bash, or git.

## Worked example

**Scenario:** Task T3 stuck in `status=failed` after executor crash (I-16).

Input:

```json
{
  "run_id": "run-2026-04-20",
  "task_id": "T3",
  "issue_type": "I-16",
  "context": {
    "state_snapshot": {
      "status": "failed",
      "stage": "postexec_done",
      "failure_reason": "executor timed out"
    },
    "worktree_path": "/repo/.worktrees/dark-factory/run-2026-04-20/T3",
    "pr_url": null,
    "pr_state": null,
    "review_files": [],
    "ci_logs_path": null,
    "branch": "dark-factory/112/t3",
    "failure_reason": "executor timed out"
  }
}
```

Expected output:

```json
{
  "decision": "reset_pending",
  "reason": "Task failed due to an executor timeout with no code changes committed. Worktree is clean. Resetting to pending allows a fresh executor dispatch.",
  "evidence": [
    "state.failure_reason: executor timed out",
    "worktree: no uncommitted changes"
  ],
  "state_updates": {},
  "confidence": "high"
}
```
