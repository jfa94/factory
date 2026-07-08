# Quota Pacing and Resumption

An unattended pipeline runs for hours. Left unchecked it will burn through a
usage budget mid-task and die in an inconsistent state. The factory's answer is a
**two-window pacer** (`src/quota/pacer.ts`) that throttles the run against a usage
curve, plus a clean **pause / suspend / resume** lifecycle that never loses work.
This document explains the model and the three design choices that shape it.

## Two windows, two horizons

Claude usage is metered over two rolling windows: a 5-hour window and a 7-day
window. The pacer reads both (`src/quota/window.ts`) and compares each against a
_rising curve_ — utilization is allowed to climb as the window ages, so early
budget is spent cautiously and late budget freely:

- **5h curve** (`quota.hourlyThresholds`, default `[20, 40, 60, 80, 90]`) — the
  utilization cap (%) for each of the 5 window-hours.
- **7d curve** (`quota.dailyThresholds`, default `[20, 40, 60, 80, 95, 95, 95]`)
  — the cap for each of the 7 window-days. It ramps to 95% by window-day 5 — a
  5-workday spend pattern — then plateaus through days 6–7, leaving a 5%
  end-of-window reserve.

The window position is **session-anchored, not UTC-clock**: it is derived from
each window's reset horizon, not the wall-clock hour. A reading is breached when
utilization is **strictly greater** than the curve cap for the current position;
at-or-below proceeds.

## Decision 1 — The binding window wins, 7d dominates

When both windows are over curve, the **7-day window dominates** and the run
suspends. The reasoning is recovery horizon: a 5h breach self-heals — the run can
pause in place and wait out the rising curve within a single session. A 7d breach
cannot be waited out mid-session (its recovery horizon is days, not hours), so the
more-constrained window binds and the run exits cleanly to be resumed later.

This produces a closed decision union (`QuotaDecision`):

| Decision           | Trigger                        | RunStatus   | Recovery                                 |
| ------------------ | ------------------------------ | ----------- | ---------------------------------------- |
| `proceed`          | both windows at-or-below curve | `running`   | —                                        |
| `pause-5h`         | 5h over curve (7d OK)          | `paused`    | self-heals in-session as curve rises     |
| `suspend-7d`       | 7d over curve (dominant)       | `suspended` | `factory resume` after the window resets |
| `unavailable-halt` | usage cannot be observed       | clean halt  | fail-closed (see below)                  |

## Decision 2 — Quota never produces a quality outcome

The pacer's vocabulary is deliberately small and **quota-only**. It can describe
proceed, pause, suspend, or halt — but it has _no_ way to describe a `failed` run
or a `failed` task. Those are quality outcomes owned by the verifier and the
producer ladder. Because the type has no constructor for them, "quota never emits
fail/fail" is true by construction, not by convention.

The reverse separation also holds: the **circuit breaker**
(`src/quota/circuit-breaker.ts`) is a distinct hard-abort predicate, _not_ part of
the pacer. The pure predicate trips on `cumulativeFailures >= effectiveThreshold`,
where the threshold is **proportional to the task-graph size** (Decision 45):
`max(maxConsecutiveFailures, ceil(0.15 × totalTasks))` — the config key is the
floor (default 3; ≤20 tasks behave as the old flat cap, 30 tasks → 5, 40 → 6), and
the 0.15 ratio is a module constant, not config. The breaker is **failures-only**
since Decision 42 deleted the runtime arm (along with the long-retired
workflow-mode runner). The predicate's
failure input is named `cumulativeFailures` to match the signal it actually bounds;
the public config key keeps its historical name `maxConsecutiveFailures` for
back-compat. The runner wires it into the run orchestrator through
`src/orchestrator/circuit-breaker-gate.ts` (evaluated in `nextTask`, mirroring the
`applyQuotaGate` seam). A trip — the `failures` arm, or `fail-closed` on malformed
input — is a hard abort: every remaining non-terminal task is
failed `blocked-environmental` and the run finalizes `failed`. Following derive-don't-store,
**no breaker counter is persisted** — the gate derives the signal from run state: the
count of `capability-budget` fails, i.e.
tasks whose producer ladder genuinely exhausted its budget. `blocked-environmental`
(dependency cascades **and the breaker's own trip sweep**) and `spec-defect` (wedge)
fails are deliberately **excluded**: they are consequences of a failure, not
independent failures, so one real failure that cascades to two dependents can never
masquerade as three counted failures and abort still-runnable work. The trip sweep
is failed `blocked-environmental` for exactly this reason — a `capability-budget`
sweep would count its own output and re-trip on any rescue-reopen re-drive before an
agent ran, and the class also makes the swept tasks rescue-**recoverable** (they never
ran, so a default rescue may retry them). A quota pause can **never** trip the breaker.

## Decision 3 — Fail closed; absence is never permission

Usage is read from a statusline cache (`src/quota/usage-source.ts`). Every way the
cache can be degraded — missing file, malformed JSON, missing fields, a non-numeric
or past `resets_at`, a cache older than the staleness ceiling (3600s), or a window
that has already reset — maps to a first-class `unavailable` reading, which the
pacer turns into `unavailable-halt`. An observability gap **halts cleanly**; it is
never treated as "under curve, proceed". The unobservable case is a value the
pacer routes on, not an exception it swallows.

## The usage signal

Usage-based pacing requires _observing_ the usage cache
(`${CLAUDE_PLUGIN_DATA}/usage-cache.json`), which the `factory statusline`
passthrough writes on every statusline tick and `applyQuotaGate`
(`src/orchestrator/quota-gate.ts`) reads on every step. Pacing applies to **every**
run (Decision 42). When the cache is unobservable the gate does not guess — it fails
closed (Decision 3 above), suspending with scope `"unavailable"` and writing a
`{binding_window: "unavailable"}` checkpoint: `run.quota` present ⇔ the stop was
quota-caused, the invariant `planResume` discriminates on.

## `--ignore-quota` — the per-run pacing override

A per-run **`ignore_quota`** flag is the one way `applyQuotaGate` short-circuits
to `proceed`: when true the gate
returns `null` unconditionally — it neither reads the usage signal nor writes state.
The flag is persisted on the run (`RunState.ignore_quota`,
default `false`) so **both orchestrators** (`factory next-task`/`factory next-action`) and the
runner read it straight from state — no per-call flag threading. The schema
defaults it to `false`.

Two entry points set it:

- **`factory run create --ignore-quota`** persists `ignore_quota: true` on the new run.
- **`factory resume --ignore-quota`** persists `ignore_quota: true` _before_ `applyResume`
  runs, so `planResume` (`src/quota/resume.ts`) force-clears the checkpoint regardless of
  the fresh live reading, and subsequent steps stay un-paced.

It is an operator escape hatch for a mistaken suspend or a manual quota reset — it trades
the pacer's runaway protection for forward progress, so use it deliberately. (The
state-based circuit breaker still applies; only usage pacing is bypassed.)

## The weekly-quota hard stop on `run create`

A 7d breach suspends the run cleanly to be resumed later (Decision 1). To stop a parked
run from being silently abandoned and replaced while its window is still exhausted,
`resolveOrCreateRun` (`src/cli/subcommands/run.ts`) treats an active **weekly-parked**
run — `status === "suspended"` _and_ `quota.binding_window === "7d"` — as a hard wall:
it returns a `kind:"pause"` result and `run create` exits `CONFLICT` (3),
emitting `{kind:"pause", scope:"7d", run_id, status, reason, resets_at_epoch?}`.
This blocks **all** new-run attempts for the spec — the default conflict path, `--new`,
and `--supersede` alike.

The guard is narrow by design:

- A **5h pause** and an **`unavailable` suspend** (`quota.binding_window === "unavailable"`)
  are NOT blocked — only the weekly park is.
- The **`--resume` intent** falls through to the ordinary `kind:"exists"` conflict, because
  the `factory resume` door it hands off to already re-checks the LIVE 7d window on the
  fresh session — a hard stop here would be redundant.
- **`--ignore-quota`** overrides the block, letting create/supersede proceed against a
  weekly-parked run.

## Resumption

A suspended (or paused) run resumes via `factory resume`, which calls
`planResume` (`src/quota/resume.ts`). Resume:

1. Pulls a **fresh** usage reading — it does not trust the persisted reset horizon
   alone, because a persisted horizon is not proof the window actually recovered.
   (When the run carries `ignore_quota`, this step is skipped entirely and the
   checkpoint is force-cleared — see [`--ignore-quota`](#--ignore-quota--the-per-run-pacing-override).)
2. Re-runs the pacer against that fresh reading. A fresh `proceed` clears the
   quota checkpoint and returns the run to `running`; any non-proceed decision (or
   an unobservable reading) leaves the run `pause` and tells the operator
   why.
3. **Never touches committed task state.** Suspended means "no work failed,
   nothing failed quality" — every `done`/`failed` task stays exactly as
   persisted. Resume only applies a run-level status/quota patch.

This is the dividing line between resume and [rescue](../guides/rescue-a-stalled-run.md):
resume re-checks the quota gate and nothing else; rescue resets stuck task state.

A **5h pause needs no relaunch** — the in-session runner waits it out on its heartbeat
and re-drives `factory next-task`, whose gate self-clears `paused`→`running` once the
rising curve lifts the cap (Decision 62). `factory resume` is for a **7d suspend** (or an
`unavailable` halt): its recovery horizon is days, not hours, so the run exits the session
and a human relaunches after the window resets. There is no scheduled/background wake.

## The single producer dial

The quota router (`src/quota/router.ts`) carries the _only_ risk-tier dial in the
system: `selectProducerModel` picks a producer model from `quota.producerModels` by
the task's risk tier (low / medium / high). It exposes no review-depth axis — the
merge gate is risk-invariant (see [verifier.md](./verifier.md)). It is a **pure
dial**: throttling lives upstream in `applyQuotaGate`, which stops the run on a
non-proceed decision _before_ the orchestrator ever selects a model — a throttled run
never reaches the producer.

## See also

- [State model](../reference/state-model.md) — the `RunStatus` enum and the quota
  checkpoint fields persisted on suspend.
- [Configuration schema](../reference/configuration.md) — the `quota` block:
  curves and `producerModels`.
- [The producer escalation ladder](./producer-ladder.md) — how the routed model
  feeds the producer's starting rung.
