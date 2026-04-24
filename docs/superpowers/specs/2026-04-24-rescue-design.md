# Rescue Command Design

**Date:** 2026-04-24
**Status:** Approved design, pre-implementation
**Scope:** New `/factory:rescue` command for complex recovery of pipeline runs; split of concerns with existing `/factory:run resume`; standardization of task PR titles to enable GitHub-side discovery.

---

## 1. Purpose

`/factory:run resume` handles graceful interruptions (quota cap, human gate, CI wait, session crash, mid-stage crash) via the existing idempotent stage machine. It cannot recover from complex failure modes such as unmerged PRs, merge conflicts, review deadlocks, state/GitHub divergence, orphan worktrees, or tasks that ended in `failed` state.

`/factory:rescue` fills that gap. It inspects the run's state and GitHub artifacts, detects complex issues, auto-applies safe fixes, surfaces risky/destructive fixes for batch approval, dispatches a diagnostic subagent per failed task to produce a remediation plan, applies approved plans, and finally hands off to `resume`. The result is a run whose state is clean enough that `/factory:run resume` can naturally pick up and continue to completion.

Resume is reduced to trivial-only recovery: on startup it runs a preflight scan; if any tier-2 or tier-3 issue is detected, resume halts and instructs the user to run `/factory:rescue` first.

## 2. Non-Goals

- No recovery of circuit-breaker-tripped runs. The pipeline ends gracefully in that case and rescue does not intervene.
- No LLM-driven remediation. The diagnostic subagent is diagnosis-only; all actions are deterministic.
- No support for rescuing multiple runs in one invocation. Rescue targets exactly one run.
- No cleanup of stale runs (`pipeline-cleanup` handles that).

## 3. Architecture

### 3.1 Entry flow

```
/factory:rescue (command)
        │
        ▼
 pipeline-rescue skill
        │
        ├──► pipeline-ensure-autonomy (existing, unchanged)
        │      └─ relaunch prompt or continue with current settings
        │
        ├──► pipeline-rescue-scan <run-id>        (new, deterministic)
        │      emits rescue-report.json
        │
        ├──► pipeline-rescue-apply --tier=safe    (new, deterministic)
        │      auto-applies tier-1 fixes silently
        │
        ├──► AskUserQuestion (mechanical batch)
        │      approve-all | review-per-item | cancel
        │
        ├──► pipeline-rescue-apply --tier=risky --plan=approved.json
        │
        ├──► INVESTIGATION PHASE
        │      For every task with status=failed OR flagged by scan:
        │      spawn rescue-diagnostic agent (Sonnet, read-only)
        │      in parallel via Agent(); each emits structured output JSON.
        │
        ├──► AskUserQuestion (investigation batch)
        │      approve-all | review-per-item | cancel
        │
        ├──► pipeline-rescue-apply --plans=approved-plans.json
        │
        └──► invoke /factory:run resume
```

### 3.2 Design principles

- **Deterministic-first.** Scan and apply are bash scripts. The only LLM in the loop is the diagnostic agent, which is read-only and produces structured JSON.
- **State integrity.** Every state write routes through `pipeline-state` (atomic lock + atomic write). No rescue code hand-edits `state.json`.
- **Idempotency.** Every action detects before it acts; re-running rescue after partial progress is safe.
- **Audit trail.** Every action appends an entry to `.rescue.applied_actions` with timestamp, before/after state, and result.
- **Isolation of concerns.** Scan detects, apply mutates. Agent diagnoses, apply executes. These responsibilities do not cross.

### 3.3 Short-circuits

- Scan finds zero issues and zero failed tasks → skip directly to resume invocation.
- User cancels at either batch-approve prompt → rescue halts cleanly; tier-1 fixes already applied remain; re-running picks up where it left off.

## 4. Components

### 4.1 New

| Path                                                            | Kind      | Purpose                                                                                                                                                |
| --------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `commands/rescue.md`                                            | command   | `/factory:rescue` entry point. Parses args, invokes the `pipeline-rescue` skill.                                                                       |
| `skills/pipeline-rescue/SKILL.md`                               | skill     | Thin orchestrator: autonomy → scan → auto-apply safe → mechanical batch → apply → investigation → investigation batch → apply plans → invoke resume.   |
| `skills/pipeline-rescue/reference/issue-taxonomy.md`            | reference | Enumerates every issue type, its tier, detection signal, and remediation template.                                                                     |
| `skills/pipeline-rescue/reference/remediation-protocol.md`      | reference | Exact commands per remediation action; invariants; failure handling.                                                                                   |
| `skills/pipeline-rescue/reference/diagnostic-agent-contract.md` | reference | Input/output schema for the diagnostic agent; decision → apply mapping.                                                                                |
| `agents/rescue-diagnostic.md`                                   | agent     | Sonnet subagent, read-only (Read + Grep + Glob + scoped Write to output file). Diagnoses failed/flagged tasks and emits structured JSON.               |
| `bin/pipeline-rescue-scan`                                      | bin       | Reads state + GitHub (`gh pr list`, `gh pr view`, worktree/branch inventory). Emits `rescue-report.json`.                                              |
| `bin/pipeline-rescue-apply`                                     | bin       | Executes remediations from a plan file. Flags: `--tier=safe`, `--tier=risky`, `--plan=<path>`, `--plans=<path>`, `--dry-run`. Every action idempotent. |
| `bin/pipeline-rescue-lib.sh`                                    | lib       | Shared detectors and fixers, sourced by scan and apply.                                                                                                |
| `bin/tests/rescue-scan.sh`                                      | test      | Unit tests for every detector.                                                                                                                         |
| `bin/tests/rescue-apply.sh`                                     | test      | Unit tests for every remediation action; idempotency; failure isolation.                                                                               |
| `bin/tests/rescue-lib.sh`                                       | test      | Unit tests for shared detector/fixer helpers.                                                                                                          |
| `bin/tests/rescue-integration.sh`                               | test      | End-to-end on seeded fake run; agent phase simulated with canned outputs.                                                                              |
| `skills/pipeline-rescue/tests/diagnostic-contract.sh`           | test      | Decision → action mapping; schema validation.                                                                                                          |

### 4.2 Modified

| Path                                                                     | Change                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/pipeline-run-task`                                                  | Replace `gh pr create --fill` for task PRs with explicit `--title "[<issue>] task(<task-id>): <description>"`. Issue number and description read from state. Final PR title (`Final: <run-id>`) unchanged. |
| `bin/pipeline-branch`                                                    | In `task-commit`, default commit message becomes `[<issue>] task(<task-id>): <description>` (replacing `chore(dark-factory): finalize task <id>`). Reads issue and description from state.                 |
| `skills/pipeline-orchestrator/SKILL.md` + `reference/resume-protocol.md` | Document new resume preflight scan. On tier-2/3 issue detection, resume halts with `"Complex issues detected. Run /factory:rescue."` exit 2.                                                               |
| `bin/pipeline-state`                                                     | Document new state keys (`.rescue.*`, `.tasks.<id>.rescue_last_*`). No code changes — existing `write` covers these paths.                                                                                 |

### 4.3 Reused unchanged

- `pipeline-ensure-autonomy` (autonomy check).
- `pipeline-state` (atomic state mutations).
- `pipeline-cleanup` (rescue may invoke selected cleanup actions, e.g., `--remove-worktrees` for a specific task).
- `pipeline-orchestrator` resume mode (invoked as rescue's final step).

## 5. Issue Taxonomy

Tiers: **1 = safe (auto-apply)**, **2 = risky (batch-approve)**, **3 = destructive (batch-approve)**.

Batch approval presents all tier-2 and tier-3 mechanical issues in a single `AskUserQuestion` with options `approve-all`, `review-per-item`, `cancel`. Per-item review asks one follow-up per issue with approve/skip choices. The fix applied for a given issue type is fixed (not user-selectable).

| ID   | Type                                 | Detection signal                                            | Tier | Remediation                                                                                       |
| ---- | ------------------------------------ | ----------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| I-01 | Stale state lock                     | `state.lock/` dir exists, PID dead                          | 1    | `rm` pid file, then `rmdir` lock dir                                                              |
| I-02 | Orphan worktree                      | `git worktree list` entry, branch gone                      | 1    | `git worktree remove --force`                                                                     |
| I-03 | PR merged, state not updated         | state `!= done`, `gh pr view`=`MERGED`                      | 1    | Set `.tasks.<id>.status=done`, `.stage=ship_done`                                                 |
| I-04 | PR exists, state missing `pr_url`    | empty `pr_url`, PR found by branch                          | 1    | Write `pr_url` and `pr_number` into state                                                         |
| I-05 | Stale CI status                      | `.ci_status` disagrees with `gh pr view` latest             | 1    | Overwrite `ci_status` from current `gh` view                                                      |
| I-06 | CI red, no recovery attempted        | `stage=ship` + CI red + not `ci_fixing`                     | 2    | Reset `.stage=postreview_done`, `.status=ci_fixing`                                               |
| I-07 | PR merge conflict with base          | `gh pr view --json mergeable`=`CONFLICTING`                 | 2    | `git rebase origin/<base>` in task worktree; on failure, task is flagged for investigation (I-13) |
| I-08 | PR closed unmerged                   | `state`=`CLOSED`, `mergedAt`=null                           | 2    | Mark task `failed` (autonomous); task flows into investigation (I-16)                             |
| I-09 | Review verdict deadlock              | review files present, contradictory verdicts, no progress   | 2    | Reset to `postreview` with fresh review fan-out                                                   |
| I-10 | Stuck `executing` no worktree        | `status=executing`, no worktree, no PR                      | 2    | Reset task to `pending`                                                                           |
| I-11 | Spec handoff branch missing          | past spec, no `spec-handoff/<run-id>`, empty `.tasks`       | 2    | Re-run spec generation phase                                                                      |
| I-12 | Malformed state.json                 | `jq .` fails, or required fields missing                    | 2    | Restore from `.backup/` if available; otherwise surface to user; no auto-fix                      |
| I-13 | Unresolvable merge conflict          | I-07 rebase failed                                          | 3    | Flag task for investigation phase                                                                 |
| I-14 | Orphan task branch (no PR, no state) | branch matches `dark-factory/<run-issue>/*`, no state entry | 3    | Flag for investigation phase                                                                      |
| I-15 | Duplicate PRs for same task          | multiple open PRs for same branch                           | 3    | Close all but most recent (autonomous, no per-item choice)                                        |
| I-16 | Failed task root cause               | `.tasks.<id>.status=failed`                                 | 2    | Investigation phase dispatches diagnostic agent to produce plan                                   |

Tier-3 destructive actions (`git branch -D`, `git push origin --delete`, `gh pr close`) require explicit approval via either the `approve-all` batch option or per-item approval.

## 6. Investigation Phase

### 6.1 Purpose

Every task in `status=failed` (either pre-existing or transitioned by mechanical apply, e.g., via I-08) plus every task flagged by scan for agent review (I-13, I-14) is investigated. The goal: return the task to a state that `/factory:run resume` naturally picks up, or terminally mark it failed with a reason if unrecoverable.

### 6.2 Agent contract

**Agent:** `agents/rescue-diagnostic.md`.

**Model:** Sonnet (cheaper than Opus; task is well-scoped).

**Tools available:** Read, Grep, Glob, and a scoped Write permission to the output file only. No Edit, no Bash, no git operations.

**Input** (one file per task, written by the skill to `$CLAUDE_PLUGIN_DATA/runs/<run-id>/rescue/diagnostic.<task-id>.input.json`):

```jsonc
{
  "run_id": "<run-id>",
  "task_id": "<task-id>",
  "issue_type": "I-13" | "I-14" | "I-16",
  "context": {
    "state_snapshot": { /* per-task state */ },
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

**Output** (written by the agent to `diagnostic.<task-id>.output.json`):

```jsonc
{
  "decision": "reset_pending" | "mark_failed" | "delete_branch" | "reset_postreview" | "no_action",
  "reason": "<one-paragraph root-cause summary>",
  "evidence": ["<file:line or log excerpt>", ...],
  "state_updates": { ".tasks.<id>.failure_reason": "<text>", /* optional extras */ },
  "confidence": "high" | "medium" | "low"
}
```

### 6.3 Decision → apply mapping

Deterministic. The agent has no control beyond selecting a decision.

| decision           | `pipeline-rescue-apply` action                                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reset_pending`    | `pipeline-state task-status <id> pending`; clear `.stage`, `.worktree`, `.pr_url`, `.pr_number`, `.ci_status`, `.review_files`; close any open PR for branch; `git worktree remove --force`; delete branch (local + remote). |
| `mark_failed`      | `pipeline-state task-status <id> failed`; write `.failure_reason` from output; preserve branch and PR for forensic inspection.                                                                                               |
| `delete_branch`    | `git branch -D <branch>`; `git push origin --delete <branch>`. (Covered by tier-3 batch approval.)                                                                                                                           |
| `reset_postreview` | Set `.stage=postexec_done`; clear stale review files on disk; next resume triggers fresh review fan-out.                                                                                                                     |
| `no_action`        | Surface to user in final rescue report; no state changes.                                                                                                                                                                    |

### 6.4 Guardrails

- `pipeline-rescue-apply` validates output JSON against the schema. Unknown decisions, missing fields, or malformed JSON are treated as `no_action` with `result: "error"` recorded in the audit trail.
- If the agent times out, crashes, or produces no output file, apply treats the case as `no_action` with reason `"diagnostic timeout"`.
- Agent invocations are parallelised (one Agent() multi-call in the skill).
- The agent cannot escape its read-only posture because its declared tool set excludes Edit and Bash.

## 7. Data Flow

```
┌────────────────────────────────────────────────────────────┐
│ 1. ensure-autonomy (existing)                              │
└────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────┐
│ 2. SCAN                                                    │
│    pipeline-rescue-scan <run-id>                           │
│    emits rescue-report.json {                              │
│      state_summary,                                        │
│      mechanical_issues[]   (I-01..I-12, I-15),             │
│      investigation_flags[] (I-13, I-14, I-16)              │
│    }                                                       │
└────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────┐
│ 3. AUTO-APPLY SAFE                                         │
│    pipeline-rescue-apply --tier=safe                       │
│    handles I-01..I-05 silently                             │
└────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────┐
│ 4. MECHANICAL BATCH APPROVAL                               │
│    AskUserQuestion: approve-all | review-per-item | cancel │
│    covers I-06..I-12, I-15                                 │
└────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────┐
│ 5. APPLY APPROVED MECHANICAL                               │
│    pipeline-rescue-apply --tier=risky --plan=approved.json │
│    (may transition tasks to failed, e.g. via I-08)         │
└────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────┐
│ 6. INVESTIGATION                                           │
│    For each failed or flagged task, spawn rescue-diagnostic│
│    agent (Sonnet, read-only) in parallel.                  │
│    Each agent emits decision JSON.                         │
└────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────┐
│ 7. INVESTIGATION BATCH APPROVAL                            │
│    AskUserQuestion: approve-all | review-per-item | cancel │
│    shows task → decision → reason                          │
└────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────┐
│ 8. APPLY APPROVED PLANS                                    │
│    pipeline-rescue-apply --plans=approved-plans.json       │
└────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────┐
│ 9. INVOKE /factory:run resume                              │
│    resume startup scan now clean                           │
└────────────────────────────────────────────────────────────┘
```

## 8. State Schema

All new keys written via `pipeline-state`.

```jsonc
{
  "rescue": {
    "last_run_ts": "2026-04-24T12:34:56Z",
    "last_report_path": "$CLAUDE_PLUGIN_DATA/runs/<run-id>/rescue/report-<ts>.json",
    "applied_actions": [
      {
        "ts": "2026-04-24T12:34:58Z",
        "phase": "safe" | "mechanical" | "investigation",
        "issue_id": "I-03",
        "task_id": "T3",
        "action": "mark_pr_merged",
        "before": { ".tasks.T3.status": "executing" },
        "after":  { ".tasks.T3.status": "done" },
        "result": "ok" | "error",
        "error": null
      }
    ]
  },
  "tasks": {
    "<id>": {
      "rescue_last_decision": "reset_pending",
      "rescue_last_reason": "<one-paragraph>",
      "rescue_last_ts": "..."
    }
  }
}
```

On-disk artifacts (not in `state.json`):

```
$CLAUDE_PLUGIN_DATA/runs/<run-id>/rescue/
  report-<ts>.json
  approved-mechanical-<ts>.json
  approved-plans-<ts>.json
  diagnostic.<task-id>.input.json
  diagnostic.<task-id>.output.json
  apply-<phase>-<ts>.log
```

The audit trail is append-only. Nothing sensitive is inlined; CI logs stay as paths.

## 9. Error Handling and Edge Cases

| Scenario                                    | Handling                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Scan fails (GitHub API down)                | Exit non-zero with partial report. No state changes. User retries when online.                                             |
| Scan fails (malformed `state.json`)         | Only I-12 detection runs; skip GitHub phase. Report surfaces I-12, halts.                                                  |
| User cancels at batch-approve               | Exit 0. Tier-1 fixes already applied stay. `.rescue.last_run_ts` updated. Re-running rescue is clean.                      |
| Diagnostic agent times out or crashes       | Apply treats missing output as `{decision: "no_action", reason: "diagnostic timeout"}`.                                    |
| Diagnostic output fails schema validation   | Rejected; logged with `result: "error"`. Treated as `no_action`.                                                           |
| Apply action fails mid-batch                | Error recorded; batch continues with remaining plans. Final exit code non-zero if any errors.                              |
| State lock held (another pipeline running)  | `pipeline-state` lock timeout (existing 10s). Rescue aborts with clear message.                                            |
| Rescue invoked while `/factory:run` is live | Rescue refuses to start if `.status == "running"` and lock is live.                                                        |
| Resume scan detects tier-2/3 issues         | Resume halts with `"Complex issues detected. Run /factory:rescue."` exit 2. Does not auto-invoke rescue.                   |
| Rescue cannot find target run               | Fall back to `pipeline-state list` → latest. If none exist, exit with `"No run to rescue."`                                |
| PR in GitHub, branch deleted locally        | Classify per PR state. Local branch absence is expected after cleanup; not an orphan.                                      |
| GitHub rate limit during scan               | Backoff + retry (3 attempts). If still limited, exit with partial report; safe to re-run.                                  |
| Multiple runs present                       | Rescue operates on one run. Stale-run cleanup is out of scope.                                                             |
| Rescue invoked during CI-wait               | If `.ci_status` pending and no issues, scan reports `"CI in progress, use /factory:run resume"` and exits without changes. |

### 9.1 Idempotency guarantees

- Every tier-1 fix detects before it acts (no-op if already applied).
- Every mechanical tier-2/3 fix follows the same pattern.
- Investigation input JSON is keyed by task; re-running overwrites. Apply reads the latest output.
- Re-running rescue mid-remediation is safe; scan re-detects actual state.

## 10. PR and Commit Standardization

This change is bundled with rescue because the GitHub scan phase relies on a stable, parseable PR title to locate task PRs.

### 10.1 Task PR title

Format: `[<issue>] task(<task-id>): <description>`

- `<issue>`: the parent PRD GitHub issue number, e.g. `112`.
- `<task-id>`: the task identifier from the spec (e.g. `auth-001`).
- `<description>`: the task description from the spec entry, truncated to 72 chars if necessary.

Example: `[112] task(auth-001): add login endpoint`

Implemented in `bin/pipeline-run-task` at the `gh pr create` call for task PRs. Issue number and description are read from state.

### 10.2 Task commit message (inside task PR)

Default in `pipeline-branch task-commit` becomes:

`[<issue>] task(<task-id>): <description>`

Replaces the existing `chore(dark-factory): finalize task <id>` default. An explicit `--message` still overrides.

### 10.3 Branch name

Unchanged. `pipeline-branch naming` continues to produce `dark-factory/<issue>/<slug>`.

### 10.4 Final PR

Unchanged. Title remains `Final: <run-id>`. Body remains the existing template.

### 10.5 Rationale

The issue-number prefix gives the GitHub scan a deterministic way to list all PRs belonging to a run (`gh pr list --search "[<issue>] task(" in:title`). The `task(<task-id>)` segment lets the scan map each PR back to its task entry in state, which is essential for detecting state/GitHub drift and orphan PRs.

## 11. Testing Strategy

### 11.1 Unit tests (bash)

- `bin/tests/rescue-scan.sh` — detector per issue type. Fixtures: seeded `state.json` + mocked `gh` output. Asserts exact report entries.
- `bin/tests/rescue-apply.sh` — one test per decision/action. Idempotency test. Failure isolation test.
- `bin/tests/rescue-lib.sh` — shared helpers.
- `bin/tests/resume-scan.sh` — resume halts on tier-2/3 issues, continues on tier-1 only.
- `bin/tests/branching.sh` (extend) — asserts new task PR title and commit message format.

### 11.2 Mock strategy

- `gh` mocked via `PATH` shim returning fixture JSON (existing pattern in `branching.sh`).
- `git` operations use real `git` against ephemeral repos in `$TMPDIR`.
- `pipeline-state` uses real state files in `$TMPDIR`.

### 11.3 Agent contract tests

- `skills/pipeline-rescue/tests/diagnostic-contract.sh` — feeds canned input.json through a canned output, asserts apply maps decision → action correctly. No real LLM.

### 11.4 Integration test

- `bin/tests/rescue-integration.sh` — end-to-end on a seeded fake run; agent phase simulated with canned outputs. Asserts final state matches expectations.

### 11.5 Not in v1

- Property-based testing (fast-check): decision space is small and enumerated. Revisit if the issue taxonomy grows.
- Automated skill-markdown tests: matches existing plugin convention (skills are thin orchestration; logic lives in tested bin scripts).

### 11.6 Coverage

New bin scripts ride existing pipeline coverage-gate thresholds.

## 12. Open Questions

None. All points resolved during brainstorming.
