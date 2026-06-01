# State Schema

Reference for run state structure and task lifecycle.

## Directory Structure

```
${CLAUDE_PLUGIN_DATA}/
├── config.json                    # User configuration
├── usage-cache.json               # Rate limit data from statusline wrapper
├── pipeline.lock                  # Lock file (PID + timestamp)
├── metrics.jsonl                  # JSONL event log (MCP server)
│
├── runs/
│   ├── current -> run-YYYYMMDD-HHMMSS/   # Symlink to active run
│   │
│   └── run-YYYYMMDD-HHMMSS/
│       ├── state.json             # Run state
│       ├── audit.jsonl            # Append-only audit log
│       ├── metrics.jsonl          # Append-only metrics
│       ├── holdouts/
│       │   └── <task-id>.json     # Withheld acceptance criteria
│       └── reviews/
│           └── <task-id>_round_N.json
│
└── archive/                       # Completed runs (moved by cleanup)
```

---

## state.json

### Top-Level Fields

| Field             | Type   | Description                                  |
| ----------------- | ------ | -------------------------------------------- | -------------------------- |
| `run_id`          | string | Run identifier (e.g., `run-20260413-140000`) |
| `status`          | string | Run status                                   |
| `mode`            | string | Operating mode                               |
| `started_at`      | string | ISO 8601 timestamp                           |
| `updated_at`      | string | ISO 8601 timestamp                           |
| `ended_at`        | string | null                                         | ISO 8601 timestamp or null |
| `input`           | object | Input parameters                             |
| `spec`            | object | Spec generation state                        |
| `tasks`           | object | Task states keyed by task_id                 |
| `execution_order` | array  | Validated task execution order               |
| `orchestrator`    | object | Orchestrator worktree metadata               |
| `circuit_breaker` | object | Circuit breaker counters                     |
| `cost`            | object | Token/cost tracking                          |

### Run Status Values

| Status        | Description                     |
| ------------- | ------------------------------- |
| `running`     | Pipeline actively executing     |
| `completed`   | All tasks finished successfully |
| `partial`     | Some tasks done, can resume     |
| `failed`      | Unrecoverable error             |
| `interrupted` | Manually stopped or crashed     |

### Mode Values

| Mode       | Description                    |
| ---------- | ------------------------------ |
| `discover` | Processing multiple PRD issues |
| `prd`      | Processing single PRD issue    |
| `task`     | Executing single task          |
| `resume`   | Resuming interrupted run       |

---

## Input Object

```json
{
  "input": {
    "issue_numbers": [42, 43],
    "resumed_from": "run-20260412-090000"
  }
}
```

| Field           | Type   | Description          |
| --------------- | ------ | -------------------- | ----------------- |
| `issue_numbers` | array  | GitHub issue numbers |
| `resumed_from`  | string | null                 | Run ID if resumed |

---

## Spec Object

```json
{
  "spec": {
    "status": "approved",
    "path": "/path/to/spec",
    "handoff_branch": "spec-handoff/run-20260413-140000",
    "handoff_ref": "abc123",
    "review_iterations": 2,
    "review_score": 56
  }
}
```

| Field               | Type   | Description                       |
| ------------------- | ------ | --------------------------------- |
| `status`            | string | Spec status                       |
| `path`              | string | Path to spec directory            |
| `handoff_branch`    | string | Branch for cross-worktree handoff |
| `handoff_ref`       | string | Git ref of handoff commit         |
| `review_iterations` | number | Number of spec review rounds      |
| `review_score`      | number | Last review score (max 60)        |

### Spec Status Values

| Status       | Description                 |
| ------------ | --------------------------- |
| `pending`    | Not started                 |
| `generating` | spec-generator running      |
| `reviewing`  | spec-reviewer running       |
| `approved`   | Passed review (score >= 54) |
| `failed`     | Failed after max retries    |

---

## Orchestrator Object

```json
{
  "orchestrator": {
    "worktree": ".claude/worktrees/orchestrator-run-20260413-140000",
    "project_root": "/Users/dev/my-project"
  }
}
```

| Field          | Type   | Description                                            |
| -------------- | ------ | ------------------------------------------------------ |
| `worktree`     | string | Path to orchestrator worktree (relative to repo root)  |
| `project_root` | string | Absolute path to the user's original working directory |

The orchestrator worktree is created at Step 6a of `commands/run.md` to isolate git operations from the user's primary checkout. `project_root` preserves the original cwd so sub-agents and scripts can reference user files outside the worktree when needed.

**Reuse fast-forward (0.10.3):** When Step 6 of `skills/pipeline-orchestrator/SKILL.md` reuses an existing orchestrator worktree (resume, retry), it now fetches and `merge --ff-only origin/staging` before any sub-agent is spawned. `Agent({ isolation: 'worktree' })` clones the orchestrator's CWD HEAD into the subagent worktree, so a stale orchestrator HEAD would contaminate every test-writer / executor / reviewer spawn with an out-of-date `package.json` or missing fixtures. A divergent (non-fast-forwardable) reuse path now aborts with `[ERROR] orchestrator worktree at <path> diverged from origin/staging; manual recovery needed` rather than silently propagating drift.

---

## Task Object

```json
{
  "tasks": {
    "task_01": {
      "status": "done",
      "tier": "medium",
      "risk_tier": "feature",
      "model_used": "sonnet",
      "provider": "anthropic",
      "depends_on": ["task_00"],
      "branch": "factory/42/task-01-auth-flow",
      "worktree_path": "/tmp/worktrees/task_01",
      "pr_number": 123,
      "pr_url": "https://github.com/...",
      "pr_status": "merged",
      "review_rounds": [...],
      "quality_gates": {...},
      "started_at": "2026-04-13T14:30:00Z",
      "ended_at": "2026-04-13T14:45:00Z",
      "tokens_used": 45000,
      "error": null,
      "prior_work_dir": null,
      "prior_branch": null,
      "prior_commit": null
    }
  }
}
```

### Task Status Values

| Status               | Description                     |
| -------------------- | ------------------------------- |
| `pending`            | Not started                     |
| `executing`          | task-executor running           |
| `reviewing`          | implementation-reviewer running |
| `done`               | Completed successfully          |
| `failed`             | Failed after max retries        |
| `interrupted`        | Stopped mid-execution           |
| `needs_human_review` | Requires human input            |
| `ci_fixing`          | Fixing CI failures              |

### Task Fields

| Field                                       | Type           | Description                                                                                                                           |
| ------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                                    | string         | Task status                                                                                                                           |
| `tier`                                      | string         | Complexity tier (simple/medium/complex)                                                                                               |
| `risk_tier`                                 | string         | Risk tier (routine/feature/security)                                                                                                  |
| `model_used`                                | string         | Model that executed task                                                                                                              |
| `provider`                                  | string         | anthropic                                                                                                                             |
| `depends_on`                                | array          | Task IDs this depends on                                                                                                              |
| `branch`                                    | string         | Git branch name                                                                                                                       |
| `worktree`                                  | string         | Path to worktree (last-writer-wins for downstream)                                                                                    |
| `test_writer_worktree`                      | string         | Worktree path used by test-writer phase                                                                                               |
| `test_writer_branch`                        | string         | Branch name pushed by the test-writer phase                                                                                           |
| `executor_worktree`                         | string         | Worktree path used by task-executor phase                                                                                             |
| `reviewer_worktree_implementation_reviewer` | string         | Worktree path used by the implementation-reviewer                                                                                     |
| `reviewer_worktree_quality_reviewer`        | string         | Worktree path used by the quality-reviewer                                                                                            |
| `reviewer_worktree_security_reviewer`       | string         | Worktree path used by the security-reviewer                                                                                           |
| `reviewer_worktree_architecture_reviewer`   | string         | Worktree path used by the architecture-reviewer                                                                                       |
| `reviewer_status`                           | string         | Shared last-writer-wins key written alongside per-role `<role>_status` fields for back-compat; prefer per-role fields (authoritative) |
| `implementation_reviewer_status`            | string         | Per-role verdict from implementation-reviewer                                                                                         |
| `quality_reviewer_status`                   | string         | Per-role verdict from quality-reviewer                                                                                                |
| `security_reviewer_status`                  | string         | Per-role verdict from security-reviewer                                                                                               |
| `architecture_reviewer_status`              | string         | Per-role verdict from architecture-reviewer                                                                                           |
| `pr_number`                                 | number         | Pull request number                                                                                                                   |
| `pr_url`                                    | string         | Pull request URL                                                                                                                      |
| `pr_status`                                 | string         | open/merged/closed                                                                                                                    |
| `review_rounds`                             | array          | Review round records                                                                                                                  |
| `quality_gates`                             | object         | Quality gate results                                                                                                                  |
| `started_at`                                | string         | ISO 8601 timestamp                                                                                                                    |
| `ended_at`                                  | string         | ISO 8601 timestamp                                                                                                                    |
| `tokens_used`                               | number         | Tokens consumed                                                                                                                       |
| `error`                                     | string or null | Error message if failed                                                                                                               |
| `prior_work_dir`                            | string         | Worktree path from previous attempt                                                                                                   |
| `prior_branch`                              | string         | Branch from previous attempt                                                                                                          |
| `prior_commit`                              | string         | Last commit from previous attempt                                                                                                     |
| `rescue_last_decision`                      | string         | Last decision from the rescue protocol                                                                                                |
| `rescue_last_reason`                        | string         | Reason text from the last rescue decision                                                                                             |

**Worktree field semantics:**

The pipeline writes worktree fields per task:

- `test_writer_worktree` — set when the test-writer subagent stops
- `executor_worktree` — set when the task-executor subagent stops
- `reviewer_worktree_<role>` — set when a reviewer subagent stops (e.g., `reviewer_worktree_quality_reviewer`, `reviewer_worktree_implementation_reviewer`)
- `worktree` — bare field for backward compatibility; last-writer-wins (executor overwrites test-writer)

Downstream readers (ship, cleanup, score, rescue, red-test verification) consume the bare `worktree` field. The namespaced fields exist for debugging and audit trails.

**Reviewer status field semantics:**

For reviewer roles (`implementation-reviewer`, `quality-reviewer`, `security-reviewer`, `architecture-reviewer`), the `SubagentStop` hook writes:

- `reviewer_status` — shared field (last-writer-wins across all reviewer roles); retained for backward compatibility
- `<role>_status` — per-role field (e.g., `implementation_reviewer_status`, `quality_reviewer_status`, `security_reviewer_status`, `architecture_reviewer_status`); underscores replace hyphens

Per-role fields allow the orchestrator to track individual reviewer verdicts when multiple reviewers run in parallel for security-tier tasks.

---

## Review Rounds

```json
{
  "review_rounds": [
    {
      "round": 1,
      "reviewer": "codex",
      "verdict": "REQUEST_CHANGES",
      "blocking_findings": 2,
      "timestamp": "2026-04-13T14:35:00Z"
    },
    {
      "round": 2,
      "reviewer": "codex",
      "verdict": "APPROVE",
      "blocking_findings": 0,
      "timestamp": "2026-04-13T14:40:00Z"
    }
  ]
}
```

| Field               | Type   | Description                              |
| ------------------- | ------ | ---------------------------------------- |
| `round`             | number | Review round number                      |
| `reviewer`          | string | codex or claude-code                     |
| `verdict`           | string | APPROVE/REQUEST_CHANGES/NEEDS_DISCUSSION |
| `blocking_findings` | number | Count of blocking issues                 |
| `timestamp`         | string | ISO 8601 timestamp                       |

**Codex verdict mapping:** the codex review schema emits `overall_correctness` (`"patch is correct"` / `"patch is incorrect"`), not the state's `verdict` vocabulary. The review glue code in `bin/pipeline-codex-review` maps `overall_correctness == "patch is correct"` → `APPROVE`, otherwise → `REQUEST_CHANGES`, before the verdict is recorded here. `NEEDS_DISCUSSION` is not produced by codex; it originates from Claude-Code reviewers (`bin/pipeline-parse-review`).

---

## Final PR Object

```json
{
  "final_pr": {
    "pr_url": "https://github.com/owner/repo/pull/456",
    "pr_number": 456
  }
}
```

| Field       | Type   | Description                           |
| ----------- | ------ | ------------------------------------- |
| `pr_url`    | string | Final PR URL (staging → develop)      |
| `pr_number` | number | Final PR number for CI/merge tracking |

Written by `pipeline-run-task` at the `finalize-run` stage, only after all task PRs are verified merged into `origin/staging`.

**Legacy:** Older runs wrote this under `.rollup.pr_url` / `.rollup.pr_number`. The scorer reads both keys with `.final_pr.pr_number // .rollup.pr_number` for back-compat.

---

## Quality Gates

```json
{
  "quality_gates": {
    "coverage": "ok",
    "holdout": "pass",
    "pregate": {
      "ok": true,
      "quality": "pass",
      "coverage": "ok",
      "mutation": "ok"
    }
  },
  "mutation_score": 85
}
```

All `quality_gates` status fields are **bare string** scalars, not objects. `coverage` (written `_task_write quality_gates.coverage '"ok"'`) is one of `ok | fail | skipped`, read back as a scalar (`bin/pipeline-run-task` `case "$cov_raw" in ok|fail|skipped`). `holdout` (written `_task_write quality_gates.holdout '"pass"'`) is a string enum. The `pregate` object — written once at the `ship` stage as `{ok, quality, coverage, mutation}` — bundles the final per-gate verdicts, each itself a string status. The mutation **score** is a number stored at the **top level** as `mutation_score`, not under `quality_gates`.

The four `holdout` values (`pass | fail | pending | missing-reviewer-output`):

| Value                     | Meaning                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `pass`                    | Holdout criteria were checked and the implementation satisfied them                          |
| `fail`                    | Holdout criteria were checked and the implementation failed                                  |
| `pending`                 | Holdout reviewer has been spawned; `holdout_review_file` not yet wired by the hook           |
| `missing-reviewer-output` | Reviewer was spawned twice (`holdout_attempts >= 2`) without the hook wiring the review file |

When a holdout file exists, `postexec` first spawns a holdout-reviewer (`implementation-reviewer` with role `holdout-reviewer`) and writes `pending`. The `SubagentStop` hook captures the reviewer's output path into `.tasks.<id>.holdout_review_file` and the next `postexec` entry runs `pipeline-holdout-validate check`. If `holdout_attempts` reaches 2 without the hook wiring `holdout_review_file`, the wrapper fails closed: records `missing-reviewer-output`, marks the task `needs_human_review`, and exits 30.

---

## Execution Order

```json
{
  "execution_order": [
    { "task_id": "task_01", "parallel_group": 0 },
    { "task_id": "task_02", "parallel_group": 0 },
    { "task_id": "task_03", "parallel_group": 1 }
  ]
}
```

Tasks in the same `parallel_group` run concurrently. Groups execute sequentially.

---

## Circuit Breaker

```json
{
  "circuit_breaker": {
    "consecutive_failures": 0,
    "runtime_minutes": 45,
    "pause_minutes_total": 30,
    "pause_minutes_consecutive": 10
  }
}
```

| Field                       | Type   | Description                                                                 |
| --------------------------- | ------ | --------------------------------------------------------------------------- |
| `consecutive_failures`      | number | Consecutive failures (resets on success)                                    |
| `runtime_minutes`           | number | Active runtime (excludes pauses)                                            |
| `pause_minutes_total`       | number | Cumulative time spent waiting (audit, never reset)                          |
| `pause_minutes_consecutive` | number | Consecutive pause time since last proceed (budget check, resets on proceed) |

**Migration:** Legacy state files with `pause_minutes` are migrated on first write — the value is copied to both `pause_minutes_total` and `pause_minutes_consecutive`, then `pause_minutes` is removed.

---

## Run Flags

```json
{
  "flags": {
    "allow_7d_over": false
  }
}
```

### .flags.allow_7d_over

| Type    | boolean |
| ------- | ------- |
| Default | false   |

Set to `true` by the orchestrator when `/factory:run resume --allow-7d-over` is used. Causes `pipeline_quota_gate` to export `FACTORY_ALLOW_7D_OVER=1` before calling `pipeline-model-router`, bypassing the 7d-over → `end_gracefully` branch for the remainder of the run. Cleared by `pipeline-state finalize-on-stop`.

> Legacy state files from 0.1.x runs may contain `tasks_completed` and `turns_completed` fields. These are ignored from 0.2.0 onward — no migration is required.

---

## Cost Tracking

```json
{
  "cost": {
    "total_tokens": 120000,
    "estimated_usd": 0.85,
    "by_model": {
      "opus": { "tokens": 30000, "usd": 0.45 },
      "sonnet": { "tokens": 80000, "usd": 0.35 },
      "haiku": { "tokens": 10000, "usd": 0.05 }
    }
  }
}
```

---

## Holdout Files

`${CLAUDE_PLUGIN_DATA}/runs/<run-id>/holdouts/<task-id>.json`:

```json
{
  "task_id": "task_01",
  "withheld_criteria": [
    "Password must be at least 12 characters",
    "Rate limit: 3 attempts per minute"
  ],
  "total_criteria": 5,
  "withheld_count": 2
}
```

---

## Audit Log

`audit.jsonl` - one JSON object per line:

```json
{
  "timestamp": "2026-04-13T14:30:00Z",
  "run_id": "run-20260413-140000",
  "agent": "task-executor",
  "task_id": "task_01",
  "tool": "Write",
  "file": "src/auth.ts",
  "action": "create",
  "model": "sonnet",
  "provider": "anthropic",
  "tokens_in": 1500,
  "tokens_out": 800,
  "prev_hash": "abc123..."
}
```

Each entry includes a SHA256 hash chain linking to the previous entry for tamper evidence.
