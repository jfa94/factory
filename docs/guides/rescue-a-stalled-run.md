# How to Rescue a Stalled Run

**Start with `/factory:resume`** (Decision 50) — the ONE consent-gated repair
verb. It scans the run and routes: a clean park just resumes (no prompt); anything
needing repair — stuck/recoverable resets, dead-ends, a failed e2e/traceability
verdict, a pending rollup, git drift — is PROPOSED to you first (one interactive
prompt, approve any subset), applied, then resumed. `--dry-run` shows the scan +
route + proposed plan without writing. Everything below is the **manual CLI
plumbing** underneath it — reach for `rescue scan`/`apply` by hand when you
declined the prompt and want to run a specific `hints` command yourself. See
[reference/cli.md § rescue](../reference/cli.md#rescue-scanapplyauto).

Bare `factory resume` only re-checks the quota gate — it never touches task
state. When a crashed or suspended session left tasks **stuck mid-phase** (so a
re-drive would deadlock), or a terminal `failed` run has **recoverable** fails
worth retrying, rescue resets the resettable tasks, reopens a terminal run,
reconciles git/GitHub drift, then hands off to resume.

**Rescue repairs run state, then git/GitHub drift.** `rescue scan`/`apply` repair
RUN STATE (stuck/recoverable tasks, reopen a terminal run). The `rescue-reconciler`
agent then repairs **remote** drift that run state cannot see — a `staging-<run-id>`
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

| Disposition   | Task shape                                                           | Default rescue action       |
| ------------- | -------------------------------------------------------------------- | --------------------------- |
| `shipped`     | `done` (merged)                                                      | Never touched.              |
| `runnable`    | `pending`                                                            | The runner will pick it up. |
| `stuck`       | in-flight (`executing`/`reviewing`/`shipping`) — crashed mid-phase   | **Reset** to pending.       |
| `recoverable` | `failed` + `blocked-environmental` — the blocker may have cleared    | **Reset** to pending.       |
| `dead-end`    | `failed` + `spec-defect`/`capability-budget` — re-running repeats it | Left failed.                |

Key fields: `resettable` (= `stuck ∪ recoverable`), `dead_ends`, `needs_rescue`,
and `would_deadlock` (true iff a re-drive would throw). If `needs_rescue` is false,
there is nothing to do.

Run-level flags also fold into `needs_rescue` even when every task is `done`:

- `e2e_failed` — the e2e phase concluded `failed` (see
  [Run with end-to-end tests § Fail](./run-with-e2e.md#4-read-the-outcome)). Cleared only
  by `apply --reset-e2e`, which is manifest-aware and also drops any in-flight adjudication
  cursor (preserving `adjudication_counts`).
- `e2e_assessment_failed` — the **run-start** e2e-assessment concluded boot- or
  machinery-impossible (Decision 40 D3). Also cleared by `apply --reset-e2e`, which drops the
  failed `e2e_assessment` so the assessment re-runs.
- `traceability_failed` — the PRD-traceability audit concluded `failed` (S9, Decision 47).
  Cleared only by `apply --reset-traceability`, once the unmet PRD intent is addressed.
- `rollup_pending` — the staging→develop rollup did not land (`run.rollup {number?,
merged:false, reason?}`). Two shapes: **(a)** a `completed` run whose rollup was **armed but
  never landed** (e.g. GitHub's branch policy blocked the queued `--auto` merge, D3;
  `number` present) — cleared by `apply --recheck-rollup` (step 3b) once you've confirmed the
  merge landed; **(b)** a **non-terminal** run that hit a **forward-reconcile conflict** in
  finalize (`number` absent) — no apply flag; resolve the staging↔develop conflict by hand,
  then plain `factory resume` (step 3c). Neither is ever auto-recovered — the scan surfaces
  them; a human asserts the cause cleared.

The scan also carries a read-only `work` field — a git-grounded survey of how much
committed work each non-shipped task branch (`factory/<run>/<task>`) carries above the
run's staging base (`commits_ahead`, measured against `origin/staging-<run-id>`). Use it
to see whether a failed task got far before failing vs carried nothing. It is **diagnostic
only**: it changes nothing, and resume still re-cuts a reset task's branch from staging and
redoes the work. `/factory:resume` passes each dead-end's `work` line through to
the `rescue-diagnostic` agent as corroborating evidence (never a `reset` trigger on its own).
See [reference/cli.md](../reference/cli.md#rescue-scan).

## 2. Apply the default safe reset

Reset the stuck + recoverable tasks and reopen a terminal run:

```bash
factory rescue apply [--run <id>]
```

This is idempotent and leaves dead-ends failed. It emits `{ run_id, run_status,
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

## 3b. Recheck a pending rollup

When `scan` reports `rollup_pending: true`, a `completed` run merged every task into its
`staging-<run-id>` branch but the staging→develop rollup PR **armed `--auto` and never
landed** (GitHub's branch policy blocked the queued merge). Once you have confirmed the
queued merge actually landed on develop, reopen the run so a re-drive re-enters finalize and
finishes the PRD-close + branch cleanup:

```bash
factory rescue apply --recheck-rollup
```

`apply` only **reopens** the run — it never touches the `run.rollup` pointer itself. The
re-driven `finalizeRun` re-checks the PR: finding it merged, it completes the PRD-close and
per-run branch GC and clears the pointer. There is no polling and the staging branch is
retained until the merge is confirmed.

## 3c. Resolve a forward-reconcile conflict

When `scan` reports `rollup_pending: true` on a **non-terminal** run (`run.rollup.number`
absent), finalize's forward-reconcile (Decision 33 — merging develop's new commits into the
run's `staging-<run-id>` branch before the rollup PR) hit a **merge conflict**. Finalize
aborts the merge clean (never leaving the tree mid-merge), persists the `merged:false`
marker, and throws with instructions — the run stays non-terminal, so there is **no
`apply` flag** for this case. Resolve it by hand on the staging branch, then resume:

```bash
git checkout staging-<run-id>
git merge origin/develop      # resolve conflicts, commit, and push
factory resume
```

The re-entered `finalizeRun` re-runs the reconcile (now clean), pushes, opens the rollup PR,
and overwrites the marker with the real rollup result.

## 4. Reconcile git/GitHub drift

Before resuming, reconcile any **remote** drift run state cannot see (a run branch
missing or behind `develop`, a PR/state mismatch, an orphan branch). This is the
`rescue-reconciler` agent's job — driven by `/factory:resume`, not a
standalone CLI subcommand. It acts only on **forward-only, non-destructive** repairs
autonomously and surfaces anything destructive for a confirmation prompt. Run it via
the command (below) rather than by hand.

## 5. Resume

After applying and reconciling, continue the run:

```bash
factory resume [--run <id>]
```

A reset task re-cuts its branch from a fresh staging tip, so its first ship push can be
rejected **non-fast-forward** against the stale factory-owned remote ref left by the
pre-rescue run (the "rescue-reset wedge"). Ship self-heals this: it deletes the stale
run-scoped remote ref and retries the push **once**. A second rejection fails the task
`blocked-environmental` (investigate origin by hand); a non-FF-unrelated push error is
never swallowed — it rethrows.

## Via the command

`/factory:resume` wraps this whole flow (scan → resume directly if clean → for
ambiguous dead-ends, consult the read-only `rescue-diagnostic` agents → present
the proposed plan for approval (one multiSelect prompt, any subset) → apply the
approved subset in ONE `rescue apply` → spawn `rescue-reconciler` to clear
git/GitHub drift, prompting before anything destructive → hand off to resume):

```
/factory:resume [--run <id>] [--ignore-quota] [--dry-run]
```

There are no repair flags — the old `--task`/`--include-dead-ends`/`--reset-e2e`/
`--recheck-rollup` assertions became plan items you approve interactively.
`--dry-run` stops after the scan (route + proposed plan, report only). Declining
the whole plan writes nothing and prints each item's manual `hints` command. The
orchestration lives entirely in `skills/rescue-protocol/SKILL.md`.
</content>
