# How to Rescue a Stalled Run

Use rescue when `factory run resume` cannot recover a run. Resume only re-checks
the quota gate — it never touches task state. When a crashed or suspended session
left tasks **stuck mid-stage** (so a re-drive would deadlock), or a terminal
`partial` run has **recoverable** drops worth retrying, rescue resets the
resettable tasks, reopens a terminal run, and hands off to resume.

**v1 reconciles run state only.** GitHub-side drift (a PR merged but not recorded,
an orphan branch/worktree, a closed-unmerged PR) is out of scope — it is surfaced,
not auto-fixed. See `skills/rescue-protocol/SKILL.md` and its `reference/` dir.

## 1. Scan first (read-only)

Classify the run without changing anything:

```bash
factory rescue scan [--run <id>]
```

`--run` defaults to `runs/current`. The `RescueScan` reports per-task
dispositions:

| Disposition   | Task shape                                                            | Default rescue action       |
| ------------- | --------------------------------------------------------------------- | --------------------------- |
| `shipped`     | `done` (merged)                                                       | Never touched.              |
| `runnable`    | `pending`                                                             | The driver will pick it up. |
| `stuck`       | in-flight (`executing`/`reviewing`/`shipping`) — crashed mid-stage    | **Reset** to pending.       |
| `recoverable` | `dropped` + `blocked-environmental` — the blocker may have cleared    | **Reset** to pending.       |
| `dead-end`    | `dropped` + `spec-defect`/`capability-budget` — re-running repeats it | Left dropped.               |

Key fields: `resettable` (= `stuck ∪ recoverable`), `dead_ends`, `needs_rescue`,
and `would_deadlock` (true iff a re-drive would throw). If `needs_rescue` is false,
there is nothing to do.

## 2. Apply the default safe reset

Reset the stuck + recoverable tasks and reopen a terminal run:

```bash
factory rescue apply [--run <id>]
```

This is idempotent and leaves dead-ends dropped. It emits `{ run_id, run_status,
reset, reopened, skipped }`.

## 3. Reset specific tasks, including dead-ends

To reset exactly named tasks (overriding the default set):

```bash
factory rescue apply --task t3 --task t7
```

Naming a dead-end resets it (the naming is your assertion the cause is fixed). A
`done` task named here is a loud error; a `pending` one is skipped.

To reset _all_ dead-ends, only after you have genuinely fixed the upstream root
cause:

```bash
factory rescue apply --include-dead-ends
```

## 4. Resume

After applying, continue the run:

```bash
factory run resume [--run <id>]
```

## Via the command

The `/factory:rescue` command wraps this whole flow (scan → short-circuit if clean
→ apply the safe set → for ambiguous dead-ends, consult the read-only
`rescue-diagnostic` agent → hand off to resume):

```
/factory:rescue [--run <id>] [--task <id>]... [--include-dead-ends] [--dry-run]
```

`--dry-run` stops after the scan (report only). The orchestration lives entirely
in `skills/rescue-protocol/SKILL.md`.
</content>
