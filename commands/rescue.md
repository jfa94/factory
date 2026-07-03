---
description: "Recover a stalled factory run (tasks stuck mid-stage, or recoverable drops to retry) and hand off to resume"
argument-hint: "[--run <id>] [--task <id>]... [--include-dead-ends] [--reset-e2e] [--recheck-rollup] [--dry-run]"
arguments:
  - name: "--run"
    description: "Run id to rescue (defaults to the current run)"
    required: false
  - name: "--task"
    description: "Reset exactly this task (repeatable); resets a dead-end without --include-dead-ends"
    required: false
  - name: "--include-dead-ends"
    description: "Also reset determined drops (spec-defect / capability-budget) — only after the root cause is actually fixed"
    required: false
  - name: "--reset-e2e"
    description: "Clear a failed e2e-phase verdict or a failed run-start e2e-assessment (Decisions 39/40) so it re-enters — only after the underlying cause no longer applies"
    required: false
  - name: "--recheck-rollup"
    description: "Reopen a completed run whose rollup armed but never landed, so a re-drive re-checks it — only after confirming the queued merge landed"
    required: false
  - name: "--dry-run"
    description: "Scan and report only; skip apply and the resume handoff"
    required: false
---

# /factory:rescue

Recover a run that `factory resume` cannot untangle. Resume only re-checks the quota gate;
it never touches task state. When a crashed/suspended session left tasks **stuck mid-stage**
(so a re-drive would deadlock), or a terminal `failed` run has **recoverable** drops worth
retrying, rescue resets the resettable tasks, reopens a terminal run, reconciles git/GitHub
drift, then hands off to resume.

**Run state THEN git/GitHub drift.** `rescue scan`/`apply` repair RUN STATE (stuck/recoverable
tasks, reopen a terminal run). The `rescue-reconciler` agent then repairs remote drift (a run
branch missing or behind `develop`, a PR/state mismatch, an orphan branch) — **forward-only and
autonomous** (fetch, forward-merge, re-push a missing branch); anything **destructive** (force,
delete, discard, an unresolved merge conflict) is surfaced for a confirmation prompt, never
auto-done. See `skills/rescue-protocol/reference/disposition-taxonomy.md`.

Invoke the `rescue-protocol` skill. It runs: resolve target run → `factory rescue scan`
(read-only classification) → short-circuit if clean → `factory rescue apply` for the default
safe set (stuck ∪ recoverable) → for ambiguous dead-ends, spawn the read-only
`rescue-diagnostic` agent and reset only those it recommends → spawn `rescue-reconciler` to
clear git/GitHub drift (prompting before anything destructive) → hand off to `factory resume`.

Parse the flags from the user's input, then load the skill:

```
Skill(rescue-protocol, "run=<id-or-empty> tasks=<csv-or-empty> include-dead-ends=<bool> reset-e2e=<bool> recheck-rollup=<bool> dry-run=<bool>")
```

`--dry-run` stops after the scan (report only — no apply, no resume). `--include-dead-ends`
also resets determined drops; pass it only when the upstream root cause is genuinely fixed.
`--task <id>` (repeatable) resets exactly those tasks, including a dead-end (naming it is the
assertion the cause is fixed). `--reset-e2e` clears a `failed` e2e-phase verdict (scan reports
this as `e2e_failed`) AND a failed run-start e2e-assessment (`e2e_assessment_failed`, Decision 40) so they re-enter instead of staying stuck failed forever — pass it only once the underlying
cause (flaky infra, an app bug, an unbootable app, a since-fixed reopen-cap exhaustion) no
longer applies. A live adjudication cursor is always dropped on e2e reset (its worktree is
gone); its per-spec caps survive. `--recheck-rollup` reopens a `completed` run whose rollup armed but never
landed (scan reports this as `rollup_pending`) so a re-drive re-enters finalize and picks up
the merged PR — pass it only after confirming the queued merge actually landed. Default (no
flags): reset stuck + recoverable, leave dead-ends, any e2e failure, and any pending rollup
untouched.

All orchestration logic lives in `skills/rescue-protocol/SKILL.md` and its `reference/`
directory. Do not duplicate it here.
