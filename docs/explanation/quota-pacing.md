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
- **7d curve** (`quota.dailyThresholds`, default `[14, 29, 43, 57, 71, 86, 95]`)
  — the cap for each of the 7 window-days.

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
or a `dropped` task. Those are quality outcomes owned by the verifier and the
producer ladder. Because the type has no constructor for them, "quota never emits
fail/drop" is true by construction, not by convention.

The reverse separation also holds: the **circuit breaker**
(`src/quota/circuit-breaker.ts`) is a distinct hard-abort predicate, _not_ part of
the pacer. It trips on `consecutiveFailures >= maxConsecutiveFailures` (default 3)
or on effective runtime `>= maxRuntimeMinutes` (default 480). Critically, **paused
minutes are deducted from wall time** — waiting out a quota curve never counts
against the runtime budget, so a quota pause can never trip the breaker.

## Decision 3 — Fail closed; absence is never permission

Usage is read from a statusline cache (`src/quota/usage-source.ts`). Every way the
cache can be degraded — missing file, malformed JSON, missing fields, a non-numeric
or past `resets_at`, a cache older than the staleness ceiling (3600s), or a window
that has already reset — maps to a first-class `unavailable` reading, which the
pacer turns into `unavailable-halt`. An observability gap **halts cleanly**; it is
never treated as "under curve, proceed". The unobservable case is a value the
pacer routes on, not an exception it swallows.

## Resumption

A suspended (or paused) run resumes via `factory resume`, which calls
`planResume` (`src/quota/resume.ts`). Resume:

1. Pulls a **fresh** usage reading — it does not trust the persisted reset horizon
   alone, because a persisted horizon is not proof the window actually recovered.
2. Re-runs the pacer against that fresh reading. A fresh `proceed` clears the
   quota checkpoint and returns the run to `running`; any non-proceed decision (or
   an unobservable reading) leaves the run `still-blocked` and tells the operator
   why.
3. **Never touches committed task state.** Suspended means "no work dropped,
   nothing failed quality" — every `done`/`dropped` task stays exactly as
   persisted. Resume only applies a run-level status/quota patch.

This is the dividing line between resume and [rescue](../guides/rescue-a-stalled-run.md):
resume re-checks the quota gate and nothing else; rescue resets stuck task state.
v1 is human-relaunch only — there is no scheduled wake — but the seam is built so a
future scheduler would fire the same `planResume`.

## The single producer dial

The quota router (`src/quota/router.ts`) carries the _only_ risk-tier dial in the
system: it selects a producer model from `quota.producerModels` by the task's risk
tier (low / medium / high). It exposes no review-depth axis — the verifier floor is
risk-invariant (see [verifier.md](./verifier.md)). On a non-proceed pacer decision
the router returns the graceful-stop result and **no** model: a throttled run does
not produce.

## See also

- [State model](../reference/state-model.md) — the `RunStatus` enum and the quota
  checkpoint fields persisted on suspend.
- [Configuration schema](../reference/configuration.md) — the `quota` block:
  curves, `producerModels`, and the breaker limits.
- [The producer escalation ladder](./producer-ladder.md) — how the routed model
  feeds the producer's starting rung.
