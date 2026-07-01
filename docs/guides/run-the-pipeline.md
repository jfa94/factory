# How to Run the Pipeline

This guide drives a PRD issue to shipped pull requests. It assumes you have a
GitHub repo with a PRD issue, the plugin installed in your Claude Code session,
and competence with `gh`. For the deterministic detail of each step, see the
[CLI reference](../reference/cli.md); for the full control loop, see
`skills/pipeline-runner/SKILL.md`.

The `factory` CLI is the deterministic engine: it owns all control flow and
exposes one seam, the **orchestrator** (`factory next-task` + `factory next-action`). A thin
**runner** steps that seam and spawns the agents each envelope names. You pick the
runner with `--workflow` (below); by default the loop runs **in your Claude Code
session**.

## 1. Scaffold the target repo (once per repo)

The pipeline refuses to start against an unscaffolded or unprotected repo.

```
/factory:scaffold --repo <owner/name>
```

If it refuses on missing branch protection, provision it or protect the `develop`
branch manually first. See [Scaffold a target repo](./scaffold-a-repo.md). (Scaffold
protects `develop`; each run cuts its own private `staging-<run-id>` integration
branch at create — there is no shared `staging` branch to protect.)

## 2. Start the run

```
/factory:run --repo <owner/name> --issue <N>
```

`/factory:run` always starts a **fresh** run — see [Start fresh vs. continue an
existing run](#start-fresh-vs-continue-an-existing-run) below for what happens when
an active run already exists for the spec.

| Flag                  | Required | Notes                                                                                                                                                                                   |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--repo <owner/name>` | no       | Target repo. Auto-derived from the `origin` remote when omitted.                                                                                                                        |
| `--issue <N>`         | one of   | PRD issue number (the stable spec key).                                                                                                                                                 |
| `--spec-id <id>`      | one of   | `<issue>-<slug>`; mutually exclusive with `--issue`.                                                                                                                                    |
| `--workflow`          | no       | Run the background Workflow runner. Omit for the in-session loop (default) — see below.                                                                                                 |
| `--no-ship`           | no       | Open the PRs but never merge. Omit for the default **live** — auto-merge tasks→staging, rollup→develop.                                                                                 |
| `--e2e`               | no       | Opt into the run-level e2e phase — author + run Playwright journeys against staging before docs. Create-only + immutable on resume. See [Run with end-to-end tests](./run-with-e2e.md). |
| `--supersede`         | no       | If an active run already exists, replace it (see below). Mutually exclusive with `--resume`.                                                                                            |
| `--resume`            | no       | If an active run already exists, hand off to `/factory:resume` instead of starting fresh.                                                                                               |
| `--ignore-quota`      | no       | Override the weekly-quota hard stop **and** disable per-step quota pacing for this run (see below).                                                                                     |

`--workflow` selects the runner. Both step the same `factory next-task` / `factory next-action`
seam and enforce the identical engine gates; they differ only in where the loop
runs:

- **Session mode** (default, no flag) — the in-session LLM runner loop
  (`skills/pipeline-runner/SKILL.md`). It runs in your Claude Code session
  and drives tasks one at a time.
- **`--workflow`** — the plugin-shipped Workflow script
  (`scripts/factory-run-runner.js`). It drives ready tasks in the background;
  because Workflow JS cannot shell out, it wraps every `factory` CLI call in a
  small exec agent. Note: workflow mode has no quota pacing (it cannot observe the
  usage signal) — it hard-stops when the allowance runs out.

`--no-ship` is the cutover-safety opt-out. The default is **live**: each task
auto-merges into the run's `staging-<run-id>` branch and the `staging-<run-id>` →
develop rollup merges into develop (gated by branch protection + the review panel +
TDD + the holdout), but **only when the whole PRD completed** (see [Read the
outcome](#4-read-the-outcome)). Pass `--no-ship` to open the PRs but never merge.
Ship mode **is persisted** on the run at create, so the workflow runner,
`/factory:resume`, and `finalize` read it back without re-passing. (`run finalize
--no-ship` overrides the persisted value for that one finalize call.)

### Start fresh vs. continue an existing run

A PRD has **at most one active run at a time**. `/factory:run` always starts a
**fresh** run and never silently reuses an existing one. When an active run already
exists for the spec, `factory run create` exits `3` and emits
`{kind:"exists", existing:{run_id, status}}`. The command then prompts you
(AskUserQuestion) to choose:

- **Continue (resume)** — re-enter the existing run where it left off via
  `/factory:resume`; its `staging-<run-id>` branch and merged work are intact.
- **Supersede (fresh)** — mark the old run `superseded`, delete its
  `staging-<run-id>` branch (which auto-closes its task PRs), and start fresh.
  Supersede also deletes the durable spec for the issue so Phase 1 regenerates it
  from the PRD — the fresh run does not inherit the same broken spec. (No effect on
  the spec when paired with `--spec-id`, which skips Phase 1.)
- **Cancel** — leave the existing run untouched.

Pass `--resume` or `--supersede` up front to skip the prompt. To repair a run that
resume cannot untangle (tasks stuck mid-phase, or git/GitHub drift), use
[`/factory:rescue`](./rescue-a-stalled-run.md) instead.

If the existing run is **weekly-parked** (suspended on the 7d quota window), `run
create` instead emits `{kind:"pause", scope:"7d", …}` and exits `3` — a hard
stop, not the prompt above. This blocks the default path, `--supersede`, and `--new`
alike. Wait for the window to reset and run `/factory:resume`, or pass `--ignore-quota`
to override the wall and proceed. `--ignore-quota` also disables per-step quota pacing
for the run (it persists on the run, like the `--workflow` no-pacing mode) — use it only
to override a mistaken suspend or after a manual quota reset.

## 3. What happens (the four phases)

The runner follows `skills/pipeline-runner/SKILL.md` (session mode) or runs
the equivalent Workflow script (workflow mode):

1. **Preconditions** — `factory scaffold` (idempotent re-check).
2. **Spec** — the bounded generate ⇄ review loop (`factory spec
resolve|gate|store`), spawning `spec-generator` / `spec-reviewer`, until the
   spec is `reuse`d or `stored`.
3. **Create** — `factory run create`; the `RunState` is emitted with the tasks
   seeded.
4. **Drive** — the runner steps the seam. `factory next-task` returns the ready task;
   `factory next-action` advances it through the per-task phase machine (`preflight →
tests → exec → verify → ship`), emitting a spawn request whenever it needs
   agents. The runner spawns the producers and the review panel the request
   names, then records their raw output back with `factory next-action --results` (one
   state step). The engine — not the runner — decides every transition.
5. **E2E** (`--e2e` runs only) — once all tasks are terminal, before docs,
   `factory next-task` schedules the e2e stage. The runner runs `factory run e2e`,
   which spawns the `e2e-author` to write + prove journey specs against the integrated
   staging app, then runs the suite. A failing mappable journey reopens its task
   (`e2e_feedback`) and re-drives it — the run stays `running`; a critical failure that
   exhausts `e2e.reopenCap` fails the run. On a run created without `--e2e` this phase is
   skipped entirely. See [Run with end-to-end tests](./run-with-e2e.md).
6. **Docs** — once all tasks are terminal (and the e2e phase, if any, is `done`) and the
   PRD would be `completed`,
   `factory next-task` returns `document` (not yet `finalize`) if the repo keeps a
   `/docs` directory and docs aren't opted out. The runner runs `factory run docs`,
   which emits a scribe spawn request; the runner spawns the `scribe` agent and records the
   docs commit onto the `staging-<run-id>` branch. Only after that record does `next-task`
   emit `finalize`. A docs failure suspends the run (resumable via
   `/factory:resume`). On a `failed` run, or when docs are opted out, this phase is
   skipped.
7. **Completion** — `factory run finalize` builds the report; on a `failed` run it
   posts one comment on the PRD issue listing the failed tasks; **only when the
   whole PRD completed** does it ship the `staging-<run-id> → develop` rollup (which
   includes the docs commit, since it landed on staging before finalize), comment on
   and close the originating PRD issue, and delete the per-run branch. Then
   `factory score` + `factory state --summary` report the outcome.

## 4. Read the outcome

`develop` receives a run's work **only as a whole PRD** — there is no partial
delivery. The run ends in one of two finalize statuses:

- `completed` — every task done, rollup CI green; the `staging-<run-id> → develop`
  rollup merged, the PRD issue was closed, and the per-run branch was deleted.
- `failed` — one or more tasks could not be delivered (the retry ladder was
  exhausted, or the run could not start / wedged and tripped the circuit breaker).
  `develop` is left **untouched**, the PRD issue stays **open**, and the run **keeps
  its `staging-<run-id>` branch** banked for [rescue](./rescue-a-stalled-run.md). One
  comment is posted on the PRD issue listing every failed task with its failure class
  (`capability-budget`, `spec-defect`, or `blocked-environmental`).

(A third terminal status, `superseded`, is set when a fresh run replaces this one —
see [Start fresh vs. continue](#start-fresh-vs-continue-an-existing-run).)

A `failed` run is a legible, classified outcome — read the PRD-issue fails comment
and the `report.md`. The rollup PR targets `develop`; `main` is never touched.

## 5. If the run pauses or suspends on quota

A run that hits a quota window does **not** finalize — it has unfinished work.

- `paused` (5h window) — self-heals; waits out the curve in-session.
- `suspended` (7d window) — state is persisted and the process exits cleanly.

Re-enter it once the window resets:

```
/factory:resume [--run <id>] [--ignore-quota]
```

On `{kind:"pause", …}` the runner reports the reason +
`resets_at_epoch` and stops; on `{kind:"resumed", run}` it continues the run loop.
Pass `--ignore-quota` to force a resume regardless of the live window reading (it
persists `ignore_quota` on the run, so the gate stays skipped on every later step) —
use it only to override a mistaken suspend or after a manual quota reset.

## 6. If the run gets stuck mid-phase

If a session crashed and left tasks stuck in flight (so a re-drive would
deadlock), `resume` cannot help — use [Rescue a stalled run](./rescue-a-stalled-run.md).

## 7. If you need to abandon a run

To deliberately discard a live run — mark it terminal without shipping anything — run:

```
factory run cancel --run <run_id>
```

This marks the run terminal (`failed`) without shipping anything; it works even
with a task still executing. Add `--cleanup` to also delete the run's
`staging-<run-id>` branch and its task PRs (omit it to keep them). A cancelled run
is **not** resumable — start over with `/factory:run`. Do not hand-edit run state;
`run cancel` is the sanctioned abandon verb.

> You do **not** need `cancel` merely to end a session. The Stop hook no longer
> blocks a session whose run still has unfinished work — the session may stop, and
> the run stays resumable via `factory resume` (`/factory:resume`). Use `cancel`
> only when you want to throw the run away.
