# Rate Limiting

This document explains how the pipeline manages API rate limits and pauses.

## Two Rate Limit Windows

Anthropic's API has two independent rate limit windows:

**5-Hour Burst Window**

- Resets every 5 hours (session-anchored, not UTC-clock)
- Designed to prevent short-term overconsumption

**7-Day Rolling Window**

- Resets on a rolling 7-day basis
- Designed for sustained usage budgeting
- Harder to recover from when exceeded

Both windows are tracked independently. Exceeding either triggers recovery behavior.

---

## Quota Gates

Every gate goes through `pipeline_quota_gate` (`bin/pipeline-lib.sh`) — orchestrator-level callers invoke it via `bin/pipeline-quota-gate-cli` so the wrapper script enforces the same exit-code contract for prose-driven skills.

| Gate                   | When                                       | Tier               |
| ---------------------- | ------------------------------------------ | ------------------ |
| **0 — run-start**      | Once, before any agent spawns              | `feature`          |
| **A — spec**           | Before spec generation                     | `feature`          |
| **B — batch**          | Before each parallel batch                 | max tier in batch  |
| **C — task preflight** | Per-task pre-flight                        | task's `risk_tier` |
| **D — postexec**       | Before reviewer fan-out                    | task's `risk_tier` |
| **E — postreview**     | Before parsing reviewer artifacts          | task's `risk_tier` |
| **F — ship**           | Before `gh pr create` / `pipeline-wait-pr` | task's `risk_tier` |
| **G — finalize-run**   | Before scribe + final-PR                   | `feature`          |

Each gate calls `pipeline-quota-check` → `pipeline-model-router` and handles the result:

- `proceed` → continue
- `wait` → sleep with exponential back-off (120s base, doubles each cycle, capped at `.quota.sleepCapSec` default 540s), re-check, record pause time in `.circuit_breaker.pause_minutes`
- `stale_yield` → `usage-cache.json` is missing or too old; yield `wait_retry` so the next agent turn refreshes the statusline
- `end_gracefully` → drain in-flight tasks, mark run `partial`, run summary, cleanup

Three independent bounds govern the wait loop:

- **Wall-clock budget** — accumulated pause time (`.circuit_breaker.pause_minutes`) must not exceed `.quota.wallBudgetMin` (default 30). Checked before each sleep; if already at budget, surfaces a human gate immediately rather than sleeping further.
- `.circuit_breaker.quota_wait_cycles` — consecutive "still over threshold" yields. Cap `.quota.maxWaitCycles` (default 60, ≈ 9 h).
- `.circuit_breaker.quota_stale_cycles` — consecutive stale-cache yields (statusline silent). Cap `.quota.maxStaleCycles` (default 6, ≈ 1 h).

Hitting any cap returns `end_gracefully`. Any successful `proceed` resets cycle counters (pause_minutes is not reset — it accumulates across the run for audit).

## How the Pipeline Checks Limits

Before each task spawn, the orchestrator runs:

```bash
pipeline-quota-check
```

This script reads `${CLAUDE_PLUGIN_DATA}/usage-cache.json`, which is written by
`bin/statusline-wrapper.sh` on every Claude Code statusline update. The statusline
JSON provides real-time `rate_limits` data — no API calls, no token cost.

Fields read from `usage-cache.json`:

- `five_hour.used_percentage`
- `five_hour.resets_at` (epoch seconds)
- `seven_day.used_percentage`
- `seven_day.resets_at` (epoch seconds)
- `captured_at` (epoch seconds of last statusline update)

The script computes dynamic thresholds based on window position. Curves are defaults and overridable via the plugin config (`.quota.hourlyThresholds`, `.quota.dailyThresholds`):

**5-Hour Window** (default `[20, 40, 60, 80, 90]`):

In hour 1, the threshold is 20% utilization. By hour 5, it's 90%. This allows heavier usage late in the window when you're closer to reset.

**7-Day Window** (default `[14, 29, 43, 57, 71, 86, 95]`):

Similar logic — more aggressive usage allowed later in the week. Day 7 caps at 95% so the final reserve is preserved.

---

## Model Routing Decisions

`pipeline-model-router` takes the quota check output and makes routing decisions:

**Case: Both windows within limits**

```json
{ "provider": "anthropic", "action": "proceed" }
```

Normal operation. Use Claude.

**Case: 5h over threshold, 7d within limits**

```json
{ "provider": "anthropic", "action": "wait", "wait_minutes": 47 }
```

Wait for the 5h window reset. `wait_minutes` is derived from `resets_at_epoch`
in the quota output — accurate to the actual session window, not a fixed UTC boundary.

**Case: 7d over threshold**

```json
{ "action": "end_gracefully" }
```

Stop spawning new tasks. Let in-flight tasks complete. Mark run as `partial`.

**Case: quota data unavailable** (`detection_method == "unavailable"`)

`pipeline-quota-check` emits this sentinel when `usage-cache.json` is missing, malformed, has missing rate-limit fields, older than 1 h, has non-numeric scalars where numbers are expected (coerced via `tonumber? // 0` so the existing sentinel branches catch them — fail-closed under `set -u`), or carries a `resets_at` already in the past (`reason: five-hour-window-reset` / `seven-day-window-reset`). The post-reset case occurs because Claude Code only refreshes `rate_limits` on its own API responses — between window-reset and the next response, the wrapper writes a fresh `captured_at` over pre-reset numbers. Treating that as valid would silently produce false-secure proceed decisions (clamped `window_hour=5`, util < curve threshold).

`pipeline_quota_gate` intercepts the sentinel **before** the router and yields `wait_retry` (rc=3) — the next orchestrator turn fires a fresh statusline tick which refreshes the cache. The yield increments `circuit_breaker.quota_stale_cycles`; only when the counter hits `.quota.maxStaleCycles` (default 6, ≈ 1 h of fully silent telemetry) does the gate fall through to `end_gracefully`.

**Crash-safe.** The gate also catches outright failures of `pipeline-quota-check` or `pipeline-model-router` (e.g. transient `jq` errors, missing dependencies). Any non-zero exit from either subprocess returns rc=2 (`end_gracefully`) with a `quota.check action="error"` metric — never propagates `set -e` up the call stack mid-gate.

**User prompt on first unavailable.** When quota detection fails on the very first check of a run, the orchestrator prompts the user via `AskUserQuestion` instead of immediately yielding: "Telemetry unavailable — statusline may not be configured. Continue without budget gates?" A `Yes` bypasses gates for the session; `No` halts immediately. This prevents silent failures when the statusline wrapper was never installed.

This design unifies the previous fail-closed-on-first-stale behavior with the resilient wait-and-retry behavior the orchestrator already used for over-threshold cases. A genuinely broken wrapper still halts the run, just after a bounded recovery window rather than instantly.

---

## Statusline Auto-Install

`usage-cache.json` is written by `bin/statusline-wrapper.sh`. The wrapper is
**auto-installed for all pipeline sessions** via `templates/settings.autonomous.json`,
which declares `statusLine.command` pointing at the wrapper. `pipeline-ensure-autonomy`
regenerates `merged-settings.json` on version bumps, resolving the
`${CLAUDE_PLUGIN_ROOT}` path — no user setup required.

**Coexistence with a user's existing statusline.** When `pipeline-ensure-autonomy`
regenerates `merged-settings.json`, it reads `~/.claude/settings.json` for an
existing `statusLine.command`. If found, it injects the path as
`env.FACTORY_ORIGINAL_STATUSLINE` in the merged file so the wrapper chains to it
during pipeline sessions. The user's `~/.claude/settings.json` is never modified.

Outside pipeline sessions (any session not launched with `--settings merged-settings.json`),
the user's own statusline is unchanged.

If you want to preserve a custom statusline for pipeline sessions without relying on
auto-detection (e.g., a complex chained command), set `FACTORY_ORIGINAL_STATUSLINE`
manually in your environment or in `~/.claude/settings.json`'s `env` block:

```json
{
  "env": {
    "FACTORY_ORIGINAL_STATUSLINE": "~/.claude/my-statusline.sh"
  }
}
```

The wrapper is fail-silent on the cache write — a broken jq or missing directory
never breaks statusline output. The chain is also guarded: if `FACTORY_ORIGINAL_STATUSLINE`
points to a missing file, the wrapper falls back to its default output instead of crashing.

---

## Freshness

If `captured_at` is >120s old, `pipeline-quota-check` logs a warning but still
uses the data. This can happen during long `Agent()` tool calls when Claude Code's
statusline pauses. The cached values are still the most recent available.

---

## Wall-Clock Circuit Breaker

Independent of API rate limits, the pipeline can enforce a wall-clock cap via `maxRuntimeMinutes`. When set to a positive value, `pipeline-circuit-breaker` trips if the active runtime (excluding pauses) exceeds the threshold.

**Default: `0` (disabled).** The pipeline runs until all tasks complete or `maxConsecutiveFailures` is reached.

**When to enable:**

Set a positive `maxRuntimeMinutes` as an emergency brake on unattended cost exposure:

```
/factory:configure
> Set maxRuntimeMinutes to 480
```

Pause time (rate-limit waits) is excluded from the runtime counter, so a pipeline that waits for API windows will not trip the breaker prematurely.

**Resuming after a runtime trip:**

```
/factory:run resume
```

The orchestrator reads persisted state and continues from the first incomplete task.

---

## Consecutive Wait Limit

Two independent counters bound the wait loop:

- `circuit_breaker.quota_wait_cycles` (cap `.quota.maxWaitCycles`, default 60) — consecutive yields where the cache is fresh but utilization is still over threshold.
- `circuit_breaker.quota_stale_cycles` (cap `.quota.maxStaleCycles`, default 6) — consecutive yields where the cache is stale or missing (statusline silent).

Hitting either cap returns `end_gracefully`. The split lets a quiet statusline (transient, e.g. during a long bash sleep) yield gracefully for a bounded window — instead of treating the very first stale read as a hard fail — while still capping total time spent waiting on permanently-broken telemetry.

Both counters reset to 0 on the first successful `proceed`.

---

## Graceful Exit

When 7d limits are exceeded:

1. Stop spawning new tasks
2. Let in-flight tasks complete
3. Mark run status as `partial`
4. Update `state.json` with resume-point
5. Print summary: utilization, next threshold, expected reset

The user can resume later:

```
/factory:run resume
```

---

## Monitoring Usage

Check current utilization:

```bash
cat "${CLAUDE_PLUGIN_DATA}/usage-cache.json" | jq '{
  five_hour: .five_hour.used_percentage,
  seven_day: .seven_day.used_percentage,
  captured_at: .captured_at
}'
```

Check run metrics for model distribution:

```bash
cat "${CLAUDE_PLUGIN_DATA}/runs/current/state.json" | jq '.cost.by_model'
```

## Audit Trail (debug runs)

`/factory:debug` persists the full `pipeline-quota-check` output as the audit
record for each budget decision. Inspect post-run via:

```bash
cat "${CLAUDE_PLUGIN_DATA}/debug/<run-id>/state.json" \
  | jq '{phase0: .phase0.pre_launch_check, phase1: .phase1.pre_loop_check}'
```

Each `pre_launch_check` / `pre_loop_check` carries the raw quota JSON
(utilization, threshold, window position, resets-at, detection_method) plus
`checked_at` (when the gate fired) and `cache_age_at_check` (seconds between
the cache write and the gate firing). When the gate fired with telemetry
unavailable, the sentinel is persisted verbatim — its `reason` field
(`usage-cache-missing`, `usage-cache-malformed`, `usage-cache-too-stale`,
`five-hour-window-reset`, `seven-day-window-reset`) is the audit trail.
