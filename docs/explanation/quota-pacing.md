# Quota Pacing

An unattended run lasts hours. Left unchecked, it would spend a whole usage budget
early and leave nothing for the rest of the window. The factory throttles itself
with a **two-window pacer** (`src/quota/pacer.ts`). When the pacer says stop, the
engine waits; it never fails or parks a run for quota.

## Two windows, two curves

Claude usage is metered over a rolling 5-hour window and a rolling 7-day window.
The pacer compares each against a _rising curve_, so utilization may climb as the
window ages: early budget is spent cautiously and late budget freely.

- **5h curve** (`quota.hourlyThresholds`, default `[20, 40, 60, 80, 90]`): the cap
  (%) for each window-hour.
- **7d curve** (`quota.dailyThresholds`, default `[20, 40, 60, 80, 95, 95, 95]`):
  the cap for each window-day. It ramps to 95% by day 5, then plateaus, leaving a
  5% end-of-window reserve.

The window position comes from each window's reset time, not the wall clock. A
reading is over curve when utilization is strictly greater than the cap for the
current position.

The pacer returns `proceed`, `pause-5h`, `suspend-7d` (the 7-day window dominates
when both are over) or `unavailable-halt`.

## Waiting until the curve can change

A cap only changes when the window crosses into its next hour (5h) or day (7d).
Polling sooner cannot produce a different answer, so the engine
(`LocalFeatureRuntime.quota`, `src/feature/runtime.ts`) waits until that boundary:

| Decision           | Wait                                                 |
| ------------------ | ---------------------------------------------------- |
| `pause-5h`         | Seconds to the next window-hour, clamped to 60–3600. |
| `suspend-7d`       | Seconds to the next window-day, clamped to 60–3600.  |
| `unavailable-halt` | 60 seconds.                                          |

The run is persisted as `waiting` with stop reason `quota`, and `next-action`
returns `wait` with that delay. The runner calls again when it expires. The 3600
second ceiling means a long 7-day wait is re-evaluated at least hourly, so a usage
change (for example a manual reset) is noticed without operator action.

An earlier design suspended a run on a 7-day breach and required a human
relaunch. Waiting in place removes that stall: the run continues on its own once
the curve allows it, and an explicit stop remains the only way to park a run
without a failure.

## Quota never produces a quality outcome

The decision type can describe proceeding, waiting or halting, but has no way to
express a failed task. Quality outcomes belong to the gates and review. Quota
waits spend no repair pass.

## Fail closed: absence is never permission

Usage is read from the statusline cache (`<dataDir>/usage-cache.json`, written by
`factory statusline`; `src/quota/usage-source.ts`). Every degraded state (missing
file, malformed JSON, missing fields, a past or non-numeric reset time, a cache
older than 3600 seconds, a window that already reset) is an `unavailable` reading.
The pacer turns it into `unavailable-halt`, which the engine treats as a short
wait. An observability gap is never read as "under curve".

The cache is only written while a statusline is running. `factory autonomy ensure`
wires the factory statusline into the autonomous relaunch for this reason.

## `--ignore-quota`

`run create --ignore-quota` and `debug create --ignore-quota` persist
`ignore_quota: true`; the engine then skips the pacer for that run. `spec resolve
--ignore-quota` does the same for spec generation. It trades runaway protection
for forward progress, so use it deliberately.

## See also

- [Configuration](../reference/configuration.md#quota): the curves.
- [State model](../reference/state-model.md#statuses-and-stop-reasons): `waiting`
  and the `quota` stop reason.
