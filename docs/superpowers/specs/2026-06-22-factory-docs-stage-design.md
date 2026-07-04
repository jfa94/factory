# Design: engine-owned docs stage before finalize

**Date:** 2026-06-22
**Status:** approved (design); pending implementation plan
**Scope:** the factory pipeline's end-of-run sequence — make `/docs` generation a deterministic, blocking, resumable stage that ships inside the rollup PR.

## Problem

The most recent run shipped features, merged the rollup PR, and **closed the PRD
issue** — then the documentation update was left **uncommitted** in the local
repo. Three structural causes, all pointing the same way:

1. **Wrong order.** The docs step is the last item of the orchestrator's Phase 4
   (`skills/pipeline-orchestrator/SKILL.md:213-214`), but `factory run finalize`
   runs _first_ in that phase and, inside `finalizeRun()`
   (`src/driver/finalize.ts:165-254`), creates + merges the rollup PR
   (`:200-208`), posts the "delivered" comment, and **closes the PRD issue**
   (`:217-227`). By the time scribe could run, the deliverable has shipped and the
   issue is closed.
2. **Out of band.** Every other stage is owned by the deterministic coroutine.
   Docs is an _aspirational markdown conditional_ in the skill — "if the shipped
   work changed behavior and the repo keeps `/docs`, spawn scribe" — exactly the
   kind of driver discipline that just failed. No engine seam forces it.
3. **No commit/push.** Scribe runs in an isolated worktree and writes files; no
   step merges those commits back to staging or pushes them. They surface as
   uncommitted local changes and never reach the PR.

So docs are both _out of order_ and _out of band_.

## Decisions (locked with the user)

| #   | Decision                                                                                                                                              | Rationale                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| D1  | Docs ship **inside the same rollup PR**, generated _before_ the PR is created and the PRD closes.                                                     | Docs are part of the whole-PRD deliverable (aligns with Decision 34: develop receives whole PRDs only). |
| D2  | Docs is a **blocking, resumable gate**: a docs failure holds the rollup, leaves the PRD open, keeps the staging branch, and leaves the run resumable. | Strictest reading of "docs are part of the deliverable"; nothing ships half-documented.                 |
| D3  | On docs failure: **one attempt**, then the run **suspends** (resumable), not `failed`.                                                                | The code is validated and good — only docs are pending; a human should glance and `/factory:resume`.    |
| D4  | Opt-out is **repo config only** (`package.json` `factory.docs.enabled: false`). No per-run flag.                                                      | Keeps the run surface small; docs-on is the right default for repos that keep `/docs`.                  |
| D5  | Scribe diffs the **whole PRD** (`origin/<baseBranch>..<stagingBranch>`), not per-task.                                                                | One docs pass per PRD, landing as one commit on staging, included in the one rollup PR.                 |

These force the shape: a blocking + resumable + idempotent stage can only live in
the deterministic engine, and `finalize` cannot call scribe because **the CLI is
never an agent-spawner** — scribe must be spawned by a driver from an
engine-emitted manifest. Hence a new run-level stage between "all tasks terminal"
and finalize.

### Rejected alternatives

- **Driver-ordered step + finalize precondition check.** Re-relies on driver
  discipline (the failure mode) for the happy path; the engine check only
  back-stops it. Weaker resume semantics.
- **Synthetic "docs task" through the existing `drive` coroutine.** Drags
  markdown through the TDD gate and the 6-reviewer panel — wrong tooling for docs.
- **Separate docs PR after finalize.** Rejected by D1 (the PRD would already be
  closed; docs trail in a second, orphaned PR).

## Architecture

### Lifecycle position

`stepRun` (`src/driver/next.ts`) returns `all-terminal` at four points. Two are
**clean completions** (`:112` entry-time all-terminal; `:172` post-cascade
all-terminal); two are **failure paths** (`:198` circuit breaker; `:228` wedge).

A **docs gate** is inserted at the two clean-completion return points. Before
returning `all-terminal`, it returns the new envelope kind `docs-ready` instead
**iff all** of:

- the **prospective** terminal status is `completed` (via `decideFinalize` on the
  current run snapshot), and
- the target repo keeps `/docs` (a `docs/` directory exists at the repo root), and
- docs are not opted out (`package.json` `factory.docs.enabled !== false`), and
- the run's `docs` stage marker is not already `done`.

The failure paths (`:198`, `:228`) compute to `failed` → prospective status is not
`completed` → docs is skipped → `all-terminal` as today. So docs only ever runs on
a clean completion.

### The docs seam (emit + fold) — mirrors `drive`

A new run-scoped coroutine, symmetric with the task-level `drive`:

1. **Emit:** `factory run docs --run <id>` returns a `DocsEnvelope` — a spawn
   manifest naming the `scribe` agent, with:
    - a worktree checked out on the **staging branch**, and
    - the whole-PRD diff base `origin/<baseBranch>` (so scribe diffs
      `origin/<baseBranch>..<stagingBranch>` per D5; `baseBranch` is
      `config.git.baseBranch`, typically `develop`).
2. **Spawn:** the driver spawns scribe (isolation omitted — it works _in_ the
   provided staging worktree, like the producer agents), captures its terminal
   STATUS line, and writes a results file.
3. **Fold:** `factory run docs --run <id> --results <file>` folds the result:
    - on `STATUS: DONE` → push the staging branch (scribe's commit, if any, rides
      along) and set the `docs` stage marker to `done`; return a terminal `done`
      envelope.
    - on non-`DONE` (or no usable output) → leave the marker `pending`, transition
      the run to **suspended** with a loud reason, and return a `blocked` envelope.

The loop then re-invokes `factory next`: with `docs` now `done`, it returns
`all-terminal` → `factory run finalize` ships the rollup (now including the docs
commit) and closes the PRD.

### Scribe execution model

Scribe is spawned into the staging worktree and:

- runs **incremental** documentation from the whole-PRD diff
  (`git -C <worktree> diff origin/<baseBranch>..HEAD`),
- writes `/docs`, and **commits in the worktree** — it does **not** push (the
  engine pushes on fold; same producer division of labor),
- if nothing material changed, commits nothing — the fold's push is a no-op and
  the stage still marks `done`,
- returns a producer-style STATUS line: `STATUS: DONE` |
  `STATUS: BLOCKED — <reason>` | `STATUS: NEEDS_CONTEXT — <reason>`.

`agents/scribe.md` is updated with this contract (commit-in-given-worktree,
don't-push, diff-against-manifest-base, STATUS line).

### Failure handling (D2 + D3)

Because `next` does not emit `all-terminal` until `docs === done`, finalize never
runs while docs is pending — the rollup PR is never created and the PRD never
closes (the block is _structural_, not a check that can be skipped).

Docs gets **one** attempt. If scribe returns non-`DONE`, the fold:

- keeps the `docs` marker `pending`,
- sets the run status to **suspended** (resumable) — **not** `failed` — with a
  reason like `docs stage failed: <scribe reason>; resume to retry`,
- the staging branch and open state are retained.

`/factory:resume` re-enters Phase 3; `next` re-emits `docs-ready`; scribe retries
on a fresh staging worktree. Idempotent: scribe overwrites docs files, so a retry
is safe.

### State + idempotency

One new run-state field: a `docs` stage marker with values `pending | done |
skipped`.

- `skipped` is set (or the gate simply never fires) when docs is not applicable
  (no `/docs`, opted out, or a failed run). `skipped` is treated like `done` by
  the gate (no `docs-ready`).
- On resume with `docs === done` → `all-terminal` → finalize (finalize is already
  idempotent: the merged-rollup short-circuit + idempotent issue close).
- A crash between docs-done and finalize resumes cleanly (docs not re-run;
  finalize re-runs idempotently).

This is genuine run state (a stage transition), not derivable cheaply or reliably
from git, so it is stored — consistent with how task/stage status is tracked.

### Ship-mode interaction

Docs runs regardless of ship mode. In `--no-ship`, the rollup PR is created but
not merged and the PRD stays open anyway — docs still commit to staging so the
_open_ PR includes them.

## Affected components

| Component                                  | Change                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `src/driver/next.ts`                       | Add the docs gate at the two clean all-terminal returns; new `docs-ready` `NextEnvelope` variant. |
| `src/driver/` (new module, e.g. `docs.ts`) | The `run docs` emit + fold coroutine (`DocsEnvelope`, fold logic, suspend-on-failure).            |
| `src/cli/main.ts`                          | Register `run docs` (emit + `--results` fold).                                                    |
| run state types                            | New `docs` stage marker (values `pending` / `done` / `skipped`); suspend transition with reason.  |
| `agents/scribe.md`                         | STATUS contract; commit-in-worktree, don't-push, diff-against-manifest-base.                      |
| `skills/pipeline-orchestrator/SKILL.md`    | Phase 3 loop gains the `docs-ready` case; delete the aspirational Phase-4 scribe conditional.     |
| `scripts/factory-run-driver.js`            | `docs-ready` case: spawn scribe via the sonnet exec-agent + the two `run docs` CLI calls.         |
| `commands/run.md`                          | Update Phase 4 description (docs is now an engine stage, not a manual step).                      |
| `docs/explanation/decisions.md`            | New Decision 37 recording this stage.                                                             |
| factory's own `/docs`                      | Describe the docs stage in the pipeline how-to/explanation.                                       |

## Testing

- **`next` docs gate (unit):** completed → `docs-ready`; failed (wedge/breaker) →
  `all-terminal`; no `/docs` dir → `all-terminal` (skip); `factory.docs.enabled:
false` → skip; `docs === done` → `all-terminal`.
- **`run docs` fold (unit):** `DONE` → staging pushed + marker `done` + terminal
  `done`; non-`DONE` → marker stays `pending` + run `suspended` + `blocked`
  envelope; one-attempt (no auto-retry within a single run pass).
- **Resume idempotency:** `docs === done` resume → finalize only, no scribe
  re-spawn; suspended-after-docs-failure resume → `docs-ready` re-emitted.
- **Ordering integration:** assert the rollup PR creation + PRD close **never**
  fire while `docs` is `pending` (the core regression this design prevents).
- **Scribe no-op:** scribe commits nothing → fold push is a no-op → marker `done`
  → finalize proceeds.

## Out of scope

- Reviewing/quality-gating the docs content (markdown does not go through TDD or
  the reviewer panel).
- Per-task docs or multiple docs PRs.
- Changing what scribe documents or its Diátaxis structure — only _when_ and
  _where_ it runs and how its output lands.

## Open questions

None outstanding — D1–D5 resolve the design decisions.
