---
description: "Recover a stalled factory run (tasks stuck mid-stage, or recoverable drops to retry) and hand off to resume"
argument-hint: "[--run <id>] [--task <id>]... [--include-dead-ends] [--dry-run]"
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
  - name: "--dry-run"
    description: "Scan and report only; skip apply and the resume handoff"
    required: false
---

# /factory:rescue

Recover a run that `factory run resume` cannot untangle. Resume only re-checks the quota gate;
it never touches task state. When a crashed/suspended session left tasks **stuck mid-stage**
(so a re-drive would deadlock), or a terminal `partial` run has **recoverable** drops worth
retrying, rescue resets the resettable tasks, reopens a terminal run, then hands off to resume.

**v1 reconciles RUN STATE only.** GitHub-side drift (a PR merged but not recorded, an orphan
branch/worktree, a merge conflict, duplicate/closed-unmerged PRs) is **out of scope** — it is
surfaced, not auto-fixed. See `skills/rescue-protocol/reference/disposition-taxonomy.md`.

Invoke the `rescue-protocol` skill. It runs: resolve target run → `factory rescue scan`
(read-only classification) → short-circuit if clean → `factory rescue apply` for the default
safe set (stuck ∪ recoverable) → for ambiguous dead-ends, spawn the read-only
`rescue-diagnostic` agent and reset only those it recommends → hand off to `factory run resume`.

Parse the flags from the user's input, then load the skill:

```
Skill(rescue-protocol, "run=<id-or-empty> tasks=<csv-or-empty> include-dead-ends=<bool> dry-run=<bool>")
```

`--dry-run` stops after the scan (report only — no apply, no resume). `--include-dead-ends`
also resets determined drops; pass it only when the upstream root cause is genuinely fixed.
`--task <id>` (repeatable) resets exactly those tasks, including a dead-end (naming it is the
assertion the cause is fixed). Default (no flags): reset stuck + recoverable, leave dead-ends.

All orchestration logic lives in `skills/rescue-protocol/SKILL.md` and its `reference/`
directory. Do not duplicate it here.
