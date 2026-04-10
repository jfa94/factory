# Plan 02 — Quota & Rate Limiting

**Priority:** P0 (blocker — quota detection is the prerequisite for Ollama fallback, runtime pacing, and graceful degradation)
**Tasks:** `task_02_01` through `task_02_05`

## Problem

The entire quota-check system in `bin/pipeline-quota-check` is broken in three compounding ways:

1. **Octal bug (C3):** `date -u +%H` returns `08`/`09` which bash arithmetic interprets as invalid octal, crashing the script during the 08:00–09:59 UTC window.
2. **Wrong window math (C9):** Even with octal fixed, the `hour_in_day % 5` formula assumes Anthropic's 5-hour windows align to UTC midnight. They don't — windows are tied to the first request in a session, so the correct position must come from the `resets_at` field in the API response.
3. **Header detection missing (C2a):** `_check_headers()` is a stub. Decision 10 in `05-decisions.md` specified that header-based detection should replace OAuth to make the plugin cross-platform. That implementation never landed.
4. **OAuth fallback also broken (C2b):** `_check_oauth()` reads `.access_token // empty` but the macOS Keychain credential format nests under `.claudeAiOauth.accessToken`. So even when the fallback runs, it silently fails.
5. **CLI probe burns quota:** `_check_cli()` runs `claude -p "ok"` on every check, consuming a turn from the user's quota just to detect quota.

Net effect: the plugin never detects rate-limit pressure, never switches to Ollama, never paces itself, and is effectively macOS-only — all while silently returning "0% utilization" safe defaults.

## What's in scope

- All 5 failure modes above
- Coldstart probe (one-time only, not per-check)
- Proper window position math from `resets_at`
- 7-day threshold derivation per Decision 10

## What's NOT in scope

- `pipeline-model-router` routing decisions (already has the octal fix per prior memory)
- Ollama availability detection (already working)
- LiteLLM proxy (future work)

## Background reading

- `05-decisions.md` Decision 10 — the full spec for dual usage checks
- `04-data-flow.md` lines 484-550 — the "Detection Flow" block with window math
- `02-quality-and-config.md` "Local LLM Fallback Configuration" section
- Old pipeline `lib/usage.sh` — reference implementation (but uses OAuth, not headers)
- `bin/pipeline-quota-check` — current buggy implementation
- `bin/pipeline-model-router` — consumer of quota-check output; already uses `10#` prefix

## Approach guidance

**Write tests first** using a fixture `last-headers.json` file so the tests are deterministic. The test suite for this plan is `bin/test-phase7.sh`.

Example fixture:

```json
{
  "anthropic-ratelimit-unified-5h-utilization": "0.45",
  "anthropic-ratelimit-unified-5h-reset": "2026-04-10T15:30:00Z",
  "anthropic-ratelimit-unified-7d-utilization": "0.52",
  "anthropic-ratelimit-unified-7d-reset": "2026-04-15T00:00:00Z",
  "anthropic-ratelimit-unified-status": "ok",
  "is_using_overage": "false"
}
```

Task order matters here: fix octal first (02_01), then fix window math (02_02), then implement header detection (02_03). Old code paths come out last.

## Task-specific guidance

### task_02_01 — bash octal
One-line fix at `bin/pipeline-quota-check:69-70`. Search for other `date +%H`, `+%M`, `+%d`, `+%u` usages across the whole codebase while you're at it and prefix them all with `10#`. This is a class of bug, not a single instance.

### task_02_02 — window math rewrite

For the 5-hour window:
```
window_hour = floor((now - (resets_at - 5h)) / 3600) + 1   [clamped to 1–5]
hourly_threshold = min(window_hour * 0.20, 0.90)
```

For the 7-day window:
```
window_day = floor((now - (resets_at - 7d)) / 86400) + 1   [clamped to 1–7]
thresholds = [0.142, 0.286, 0.429, 0.571, 0.714, 0.857, 0.95]
daily_threshold = thresholds[window_day - 1]
```

Both use `resets_at` from the headers, parsed as UTC epoch. Use the portable date parsing idiom already in `bin/pipeline-circuit-breaker` (prefer `gdate` on macOS if available, fall back to BSD `date -j -f`).

### task_02_03 — header detection
Implement `_check_headers()` to:
1. Read `${CLAUDE_PLUGIN_DATA}/last-headers.json`
2. If missing: run a one-time cold-start probe (`claude -p "ok" --max-turns 1 --model haiku`) and re-read. If still missing, return 1.
3. Extract the utilization, reset, and status fields
4. Derive billing_mode:
   - `unified-*` headers present + `is_using_overage=false` → `subscription`
   - `unified-*` headers present + `is_using_overage=true` → `overage`
   - No `unified-*` headers + `$ANTHROPIC_API_KEY` set → `api`
   - No `unified-*` headers + no API key → `unknown`
5. Call the window math from 02_02 to compute thresholds
6. Emit JSON in the shape documented in `04-data-flow.md`

### task_02_04 — OAuth fixup
Either fix the JSON path (`.claudeAiOauth.accessToken`) and keep OAuth as a macOS-only fallback, or delete `_check_oauth` entirely. Recommendation: delete it. Decision 10 explicitly said headers replace OAuth. Keeping broken OAuth code creates a trap.

### task_02_05 — Remove quota-burning probe
Delete `_check_cli` or restrict it to the cold-start path only (the one-time invocation inside `_check_headers` when last-headers.json doesn't exist yet). The auto mode should not fall through to a quota-consuming probe — if headers can't be read after cold-start, return an explicit error.

## Completion checklist

- [ ] All 5 tasks have regression tests
- [ ] `bin/test-phase7.sh` passes with new header-based fixtures
- [ ] Running `pipeline-quota-check` does NOT invoke `claude` except on cold-start
- [ ] `pipeline-quota-check` output JSON matches the schema in `04-data-flow.md`
- [ ] Manual smoke: populate `last-headers.json` with 5h=0.95, run quota-check, verify `over_threshold=true`
- [ ] `tasks.json` updated
- [ ] Commits landed

## On completion

After this, `pipeline-model-router` is fully functional: quota checks produce accurate data, the router can make real routing decisions, and Ollama fallback becomes testable. Proceed to **Plan 03** next.
