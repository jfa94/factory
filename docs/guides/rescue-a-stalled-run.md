# How to Rescue a Stalled Run

Use rescue when `factory resume` cannot recover a run. Resume only re-checks the
quota gate — it never touches task state. When a crashed or suspended session left
tasks **stuck mid-stage** (so a re-drive would deadlock), or a terminal `failed`
run has **recoverable** drops worth retrying, rescue resets the resettable tasks,
reopens a terminal run, reconciles git/GitHub drift, then hands off to resume.

**Rescue repairs run state, then git/GitHub drift.** `rescue scan`/`apply` repair
RUN STATE (stuck/recoverable tasks, reopen a terminal run). The `rescue-reconciler`
agent then repairs **remote** drift that run state cannot see — a `staging/<run-id>`
branch missing or behind `develop`, a PR whose merged/closed status disagrees with
state, an orphan branch/worktree. Reconciliation is **forward-only and autonomous**
(fetch, forward-merge `origin/develop` into the run branch, re-push a missing
branch); anything **destructive** (a force-push, a branch/PR deletion, discarding
commits, an unresolved merge conflict) is **surfaced for a prompt**, never
auto-done. See `skills/rescue-protocol/SKILL.md` and its `reference/` dir.

## 1. Scan first (read-only)

Classify the run without changing anything:

```bash
factory rescue scan [--run <id>]
```

`--run` defaults to **this repo's current run**, resolved per repo from the
caller's checkout (see [reference/cli.md](../reference/cli.md#per-repo-current-run-resolution)).
The `RescueScan` reports per-task
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

## 4. Reconcile git/GitHub drift

Before resuming, reconcile any **remote** drift run state cannot see (a run branch
missing or behind `develop`, a PR/state mismatch, an orphan branch). This is the
`rescue-reconciler` agent's job — driven by the `/factory:rescue` command, not a
standalone CLI subcommand. It acts only on **forward-only, non-destructive** repairs
autonomously and surfaces anything destructive for a confirmation prompt. Run it via
the command (below) rather than by hand.

## 5. Resume

After applying and reconciling, continue the run:

```bash
factory resume [--run <id>]
```

## Via the command

The `/factory:rescue` command wraps this whole flow (scan → short-circuit if clean
→ apply the safe set → for ambiguous dead-ends, consult the read-only
`rescue-diagnostic` agent → spawn `rescue-reconciler` to clear git/GitHub drift,
prompting before anything destructive → hand off to resume):

```
/factory:rescue [--run <id>] [--task <id>]... [--include-dead-ends] [--dry-run]
```

`--dry-run` stops after the scan (report only). The orchestration lives entirely
in `skills/rescue-protocol/SKILL.md`.
</content>
