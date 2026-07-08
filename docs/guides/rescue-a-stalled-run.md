# How to Rescue a Stalled Run

**Start with `/factory:resume`** (Decision 50) — the ONE consent-gated repair
verb. It scans the run and routes: a clean park just resumes (no prompt); anything
needing repair — stuck/recoverable resets, dead-ends, a failed e2e/traceability
verdict, a pending rollup, git drift — is PROPOSED to you first (one interactive
prompt, approve any subset), applied, then resumed. `--dry-run` shows the scan +
route + proposed plan without writing. Everything below is the **manual CLI
plumbing** underneath it — reach for `rescue scan`/`apply` by hand when you
declined the prompt and want to run a specific `hints` command yourself. See
[reference/cli.md § rescue](../reference/cli.md#rescue-scanapplyautogc).

Bare `factory resume` only re-checks the quota gate — it never touches task
state. When a crashed or suspended session left tasks **stuck mid-phase** (so a
re-drive would deadlock), or a terminal `failed` run has **recoverable** fails
worth retrying, rescue resets the resettable tasks, reopens a terminal run,
reconciles git/GitHub drift, then hands off to resume.

**Rescue repairs run state, adopts GitHub truth, then reconciles local-git residue.**
`rescue scan`/`apply` repair RUN STATE (stuck/recoverable tasks, reopen a terminal run) and
**adopt** forward-only GitHub drift the engine can prove — a merged-but-unrecorded PR recorded
`done`, a stale `pr_number` rebound, a still-local branch re-pushed, a landed rollup reopened
(Decision 60), all before any reset runs so merged work is never clobbered. The
`rescue-reconciler` agent then handles only the **local-git residue** adoption can't decide —
a `staging-<run-id>` branch **behind** its base needing a forward-merge, a branch gone **both**
locally and remotely, an orphan worktree, an unresolvable base. Its repairs are **forward-only
and autonomous** (fetch, forward-merge, re-push); anything **destructive** (a force-push, a
branch/PR deletion, discarding commits, an unresolved merge conflict) is **surfaced for a
prompt**, never auto-done. See `skills/rescue-protocol/SKILL.md` and its `reference/` dir.

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
- `empty_task_map` — the run has **zero tasks** (Decision 57): half-created wreckage from a
  crash between run birth and task seeding. There is nothing to reset, so the scan's only hint
  is `factory run cancel --run <id> --cleanup` — cancel the half-created run, then re-run
  `factory run create`. (Runs created after the atomic-seeding fix are born whole and can never
  hit this; it exists to make pre-existing wreckage visible rather than scan as healthy.)

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

Most state↔GitHub drift now **repairs itself**. Since [Decision 60](../explanation/decisions.md#decision-60--autonomous-forward-only-adoption-write-side),
the engine **adopts** the forward-only fixes autonomously — no agent, no prompt:
`merged-unrecorded` → task recorded `done` (so a reset can never clobber merged work),
`stale-pr-number` → `pr_number` rebound/cleared, `branch-missing` (still-local) → re-pushed,
`rollup-landed` → the completed run reopened so resume finalizes. Adoption fires inside
`rescue apply`/`auto`, inside `next-task` (for a stale `shipping` task), and on demand via
[`factory reconcile --adopt`](../reference/cli.md#reconcile) — always forward-only (never a
reset, force-push, or PR close) and degrading quietly on a gh outage.

**What still needs judgment** is the `rescue-reconciler` agent's job (driven by
`/factory:resume`, not a standalone subcommand): **LOCAL-git residue** adoption can't decide —
a run branch **behind** its base needing a forward-merge (conflict → blocked), a branch gone
**both** locally and remotely, an orphan worktree, an unresolvable staging base. It acts only
on forward-only, non-destructive repairs and surfaces anything destructive for a confirmation
prompt. It is spawned only when a post-apply scan still reports `reconcile: true`.

**The scan already carries the evidence.** Since the P1 reconcile slice (Decision 59),
`rescue scan` probes GitHub and embeds a `github` section — `{ok:true, facts, drifts,
rollup_landed}` — classifying state↔GitHub drift (`merged-unrecorded`, `closed-unmerged`,
`stale-pr-number`, `pr-unrecorded`, `branch-missing`, `staging-missing`, `rollup-landed`; each
`detail` names its remedy). A gh outage degrades that section to `{ok:false, error}` **without
failing the scan**, so the repair entry point still works offline.

For a standalone survey — outside the rescue flow, failing **loud** if gh is down — run
[`factory reconcile [--run <id>]`](../reference/cli.md#reconcile) (add `--adopt` to apply the
forward-only fixes). It emits the same `facts`/`drifts`/`rollup_landed` as the scan's `github`
section, but as its own `{kind:"reconcile"}` document.

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
approved subset in ONE `rescue apply` (which adopts forward-only GitHub drift first,
then resets) → spawn `rescue-reconciler` ONLY if a post-apply scan still reports
`reconcile: true` (local-git residue), prompting before anything destructive → hand
off to resume):

```
/factory:resume [--run <id>] [--ignore-quota] [--dry-run]
```

There are no repair flags — the old `--task`/`--include-dead-ends`/`--reset-e2e`/
`--recheck-rollup` assertions became plan items you approve interactively.
`--dry-run` stops after the scan (route + proposed plan, report only). Declining
the whole plan writes nothing and prints each item's manual `hints` command. The
orchestration lives entirely in `skills/rescue-protocol/SKILL.md`.

## Sweep orphaned staging branches (`rescue gc`)

`rescue scan`/`apply`/`resume` all leave TERMINAL runs alone — but a terminal run
can leak a protected `staging-<run-id>` branch on GitHub when no teardown path fired
(a `failed` run banked for rescue, a crash between finalize steps, a `suspended` run
abandoned after its PRD shipped out-of-band). `rescue gc` (Decision 55) reclaims
those. It is read-only by default and never touches an active (`running`/`paused`)
run.

### 1. Scan for leftovers (read-only)

```bash
factory rescue gc
```

Probes every terminal (`completed`/`superseded`/`failed`) and `suspended` run's
pinned staging branch on GitHub and emits `{ kind:"gc", findings, suspended, stale }`:

- `findings` — terminal runs with a live branch and/or protection rule, each with an
  exact `factory rescue gc --apply --run <id>` hint. A `failed` run is flagged
  `banked: true` — its branch is deliberately kept for rescue, so only GC it once the
  run is truly dead.
- `suspended` — suspended runs with live leftovers. These are NEVER `gc --apply`
  targets (deleting their branch destroys resumability); each carries a
  `factory run cancel --run <id> --cleanup` hint instead — cancel the run first, then
  its `--cleanup` tears the branch down.
- `stale` — run dirs this engine **cannot parse** (Decision 57): an old schema version or
  corrupt JSON. A stale `current` pointer at one of these is what crashes `run create`, so
  sweep them. Each carries `{ run_id, reason, staging_branch?, branch_exists?,
protection_live?, hint }` (GitHub is probed only when `staging_branch` + repo were
  raw-extractable); the `hint` is the same `factory rescue gc --apply --run <id>` command.

### 2. Tear down a terminal run's leftovers

```bash
factory rescue gc --apply --run <id>    # repeat --run for several runs
```

Deletes protection first (GitHub blocks deleting a protected ref), then the branch,
for each named terminal run. It refuses any non-terminal run with a loud error. The
deletes are idempotent (404-tolerant), so re-running over an already-clean run is a
no-op. A named id that is a **stale** run dir (Decision 57) instead routes to the stale
sweep: best-effort branch/protection teardown (when raw-extractable), then the run dir plus
any `current` pointer naming it are deleted (reported under `stale_cleaned`). See
[reference/cli.md § rescue gc](../reference/cli.md#rescue-gc).

Since Decision 55, per-run staging protection is created with `allow_deletions: true`,
so a leftover branch you spot by hand also deletes with a plain `git push --delete`
without stripping its protection rule first.
</content>
