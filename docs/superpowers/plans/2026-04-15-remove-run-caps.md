# Remove Run-Length Caps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `maxTasks` and `execution.maxOrchestratorTurns` circuit breakers, default `maxRuntimeMinutes` to unlimited, raise `maxConsecutiveFailures` to 5, and lower Claude Code auto-compact threshold to 50%.

**Architecture:** Mechanical refactor across four surfaces: (1) `bin/pipeline-circuit-breaker` (drop two checks, guard third); (2) `.claude-plugin/plugin.json` (drop two fields, change two defaults, version bump); (3) `bin/pipeline-state` + `agents/pipeline-orchestrator.md` (remove `increment-turn` wiring — becomes dead code once its consumer is gone); (4) `settings.json` (add `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50`). Tests are driven by `bin/tests/config.sh` (schema) and `bin/tests/state.sh` (runtime behavior), which we update in lockstep.

**Tech Stack:** Bash, `jq`, Claude Code plugin config schema, Markdown docs.

**Spec:** `docs/superpowers/specs/2026-04-15-remove-run-caps-design.md`

---

## Files changed

**Code / config**

- `.claude-plugin/plugin.json` — remove `maxTasks`, remove `execution.maxOrchestratorTurns`, change `maxRuntimeMinutes` default/min, change `maxConsecutiveFailures` default, bump version.
- `bin/pipeline-circuit-breaker` — drop `max_tasks`/`max_turns` reads and checks, guard runtime branch on `max_runtime > 0`, shrink jq output.
- `bin/pipeline-state` — delete `increment-turn` action (no longer consumed).
- `agents/pipeline-orchestrator.md` — delete the "run `increment-turn` as first Bash call" paragraph.
- `settings.json` — add `env` block with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.

**Tests**

- `bin/tests/config.sh` — drop two keys from required-keys loop, add absence assertions, add default-value assertions.
- `bin/tests/state.sh` — rewrite circuit-breaker test section, delete `task_15b_01` and `task_15b_02` blocks, update all inline config JSON stubs.

**Docs**

- `docs/reference/configuration.md`, `docs/reference/state-schema.md`, `docs/reference/bin-scripts.md`, `docs/reference/commands.md`, `docs/reference/exit-codes.md`
- `docs/getting-started.md`, `docs/guides/configuration.md`, `docs/architecture/components.md`, `docs/explanation/rate-limiting.md`
- `commands/configure.md`

**Untouched:** `remediation/` (historical artifacts), `02-quality-and-config.md`, `03-components.md`, `05-decisions.md` (remediation-era artifacts at repo root).

---

## Task 1: Failing tests for the new circuit breaker contract

**Files:**

- Modify: `bin/tests/state.sh:184-250`

- [ ] **Step 1: Replace the `pipeline-circuit-breaker` test block**

Open `bin/tests/state.sh`. Replace lines 184–250 (from `echo "=== pipeline-circuit-breaker ==="` through the comment `# Restore shared default config for downstream tests.` and the `echo '{"maxTasks":20...}'` line immediately after) with the block below. This deletes the `task_15b_01` and `task_15b_02` sections entirely and rewrites the main circuit-breaker test to reflect the new contract.

```bash
echo "=== pipeline-circuit-breaker ==="

# Write config with new defaults: no maxTasks, runtime unlimited (0), failures=5.
mkdir -p "$CLAUDE_PLUGIN_DATA"
echo '{"maxRuntimeMinutes":0,"maxConsecutiveFailures":5}' > "$CLAUDE_PLUGIN_DATA/config.json"

# Safe baseline.
assert_exit "circuit breaker safe" 0 pipeline-circuit-breaker "run-test-001"

# Large task counts and stale turn counters must NOT trip the breaker —
# those circuit breakers have been removed.
pipeline-state write "run-test-001" '.circuit_breaker.tasks_completed' '1000' >/dev/null 2>&1
pipeline-state write "run-test-001" '.circuit_breaker.turns_completed' '9999' >/dev/null 2>&1
assert_exit "circuit breaker ignores tasks_completed" 0 pipeline-circuit-breaker "run-test-001"

# consecutive_failures=5 trips (new default).
pipeline-state write "run-test-001" '.circuit_breaker.consecutive_failures' '5' >/dev/null 2>&1
assert_exit "circuit breaker tripped (failures)" 1 pipeline-circuit-breaker "run-test-001"

# consecutive_failures=4 is still safe at the new default.
pipeline-state write "run-test-001" '.circuit_breaker.consecutive_failures' '4' >/dev/null 2>&1
assert_exit "circuit breaker safe at 4 failures" 0 pipeline-circuit-breaker "run-test-001"

# Reset failures for remaining assertions.
pipeline-state write "run-test-001" '.circuit_breaker.consecutive_failures' '0' >/dev/null 2>&1

# maxRuntimeMinutes=0 (unlimited) must NOT trip regardless of elapsed time.
pipeline-state write "run-test-001" '.started_at' '"2020-01-01T00:00:00Z"' >/dev/null 2>&1
assert_exit "circuit breaker safe when maxRuntimeMinutes=0" 0 pipeline-circuit-breaker "run-test-001"

# Positive maxRuntimeMinutes still trips when elapsed exceeds it.
echo '{"maxRuntimeMinutes":1,"maxConsecutiveFailures":5}' > "$CLAUDE_PLUGIN_DATA/config.json"
output=$(pipeline-circuit-breaker "run-test-001" 2>/dev/null) || true
assert_exit "circuit breaker tripped (runtime)" 1 pipeline-circuit-breaker "run-test-001"
if echo "$output" | jq -e '.reason // empty' >/dev/null 2>&1; then
  reason_has_runtime=$(echo "$output" | jq -r '.reason' | grep -qi 'runtime' && echo "true" || echo "false")
  assert_eq "circuit breaker reason mentions runtime" "true" "$reason_has_runtime"
else
  assert_eq "circuit breaker reason check (skipped)" "skipped" "skipped"
fi

# Output must NOT expose removed threshold keys.
output=$(pipeline-circuit-breaker "run-test-001" 2>/dev/null) || true
has_max_tasks=$(echo "$output" | jq -e '.thresholds | has("max_tasks")' 2>/dev/null || echo "false")
has_max_turns=$(echo "$output" | jq -e '.thresholds | has("max_orchestrator_turns")' 2>/dev/null || echo "false")
assert_eq "output.thresholds does NOT include max_tasks" "false" "$has_max_tasks"
assert_eq "output.thresholds does NOT include max_orchestrator_turns" "false" "$has_max_turns"

# Restore shared default config for downstream tests.
echo '{"maxRuntimeMinutes":0,"maxConsecutiveFailures":5}' > "$CLAUDE_PLUGIN_DATA/config.json"
pipeline-state write "run-test-001" '.started_at' '"2099-01-01T00:00:00Z"' >/dev/null 2>&1
```

- [ ] **Step 2: Update the `task_06_06` pause-time test config stubs**

Still in `bin/tests/state.sh`, around lines 556 and 592–593, update the two inline config JSON stubs to drop `maxTasks` and use the new failures default:

```bash
# line ~556
echo '{"maxRuntimeMinutes":180,"maxConsecutiveFailures":5}' \
  > "$CLAUDE_PLUGIN_DATA/config.json"

# line ~592
echo '{"maxRuntimeMinutes":0,"maxConsecutiveFailures":5}' \
  > "$CLAUDE_PLUGIN_DATA/config.json"
```

Note: the pause-time test uses `maxRuntimeMinutes=180` deliberately (needs a positive cap to test the pause credit math), so only the default-restoration line at the end switches to `0`.

- [ ] **Step 3: Run the test suite and verify tests fail as expected**

Run: `bash bin/tests/state.sh`

Expected: multiple FAILs in the `=== pipeline-circuit-breaker ===` section because the current `bin/pipeline-circuit-breaker` still reads `.maxTasks` and `.execution.maxOrchestratorTurns` and still trips on `tasks_completed=1000`. Do not commit yet — proceed to Task 2.

---

## Task 2: Rewrite `pipeline-circuit-breaker` to match the new contract

**Files:**

- Modify: `bin/pipeline-circuit-breaker` (full rewrite of thresholds/output section)

- [ ] **Step 1: Replace the threshold reads, checks, and jq output**

Open `bin/pipeline-circuit-breaker`. Replace everything from line 19 (`# Read thresholds from config (with defaults).`) through the end of the file with:

```bash
# Read thresholds from config (with defaults).
# Keys match the canonical schema in .claude-plugin/plugin.json (top-level).
# maxRuntimeMinutes=0 means unlimited (default).
max_runtime=$(read_config '.maxRuntimeMinutes' '0')
max_failures=$(read_config '.maxConsecutiveFailures' '5')

# Read current values from state
consecutive_failures=$(printf '%s' "$state" | jq -r '.circuit_breaker.consecutive_failures // 0')
pause_minutes=$(printf '%s' "$state" | jq -r '.circuit_breaker.pause_minutes // 0')

# Calculate runtime, deducting time the run was paused (e.g. rate-limit waits).
# pause_minutes is maintained by the orchestrator via pipeline-state when
# model-router returns action=wait.
started_at=$(printf '%s' "$state" | jq -r '.started_at // empty')
if [[ -n "$started_at" ]]; then
  # parse_iso8601_to_epoch handles BSD/GNU/Homebrew date variants uniformly
  # AND respects the UTC 'Z' suffix.
  start_epoch=$(parse_iso8601_to_epoch "$started_at" 2>/dev/null || echo 0)
  now_epoch=$(date +%s)
  wall_minutes=$(( (now_epoch - start_epoch) / 60 ))
  runtime_minutes=$(( wall_minutes - pause_minutes ))
  if (( runtime_minutes < 0 )); then
    runtime_minutes=0
  fi
else
  runtime_minutes=0
fi

# Check thresholds. Runtime check is skipped when max_runtime=0 (unlimited).
tripped="false"
reason=""

if (( max_runtime > 0 )) && [[ "$runtime_minutes" -ge "$max_runtime" ]]; then
  tripped="true"
  reason="max runtime reached (${runtime_minutes}min >= ${max_runtime}min)"
elif [[ "$consecutive_failures" -ge "$max_failures" ]]; then
  tripped="true"
  reason="max consecutive failures ($consecutive_failures >= $max_failures)"
fi

# Output
jq -n \
  --argjson tripped "$tripped" \
  --argjson runtime_minutes "$runtime_minutes" \
  --argjson pause_minutes "$pause_minutes" \
  --argjson consecutive_failures "$consecutive_failures" \
  --argjson max_runtime "$max_runtime" \
  --argjson max_failures "$max_failures" \
  --arg reason "$reason" \
  '{
    tripped: $tripped,
    runtime_minutes: $runtime_minutes,
    pause_minutes: $pause_minutes,
    consecutive_failures: $consecutive_failures,
    thresholds: {
      max_runtime_minutes: $max_runtime,
      max_consecutive_failures: $max_failures
    },
    reason: (if $tripped then $reason else null end)
  }'

if [[ "$tripped" == "true" ]]; then
  log_error "circuit breaker tripped: $reason"
  exit 1
fi
```

The removed pieces: `max_tasks` and `max_turns` reads; `tasks_completed`/`turns_completed` state reads; the two corresponding `elif` branches in the trip check; the four removed fields from jq output (`tasks_completed`, `turns_completed`, `max_tasks`, `max_orchestrator_turns`).

- [ ] **Step 2: Re-run the test suite and verify all new assertions pass**

Run: `bash bin/tests/state.sh`

Expected: the `=== pipeline-circuit-breaker ===` and `=== task_06_06 ===` sections all PASS. The deleted `task_15b_01` / `task_15b_02` sections no longer appear in the output.

- [ ] **Step 3: Commit**

```bash
git add bin/pipeline-circuit-breaker bin/tests/state.sh
git commit -m "refactor(circuit-breaker): drop maxTasks and maxOrchestratorTurns; default runtime unlimited"
```

---

## Task 3: Failing schema assertions in `config.sh`

**Files:**

- Modify: `bin/tests/config.sh:63-104` (required-keys loop), plus add default-value assertions after the existing ones

- [ ] **Step 1: Remove two keys from the required-keys loop**

In `bin/tests/config.sh`, delete lines 65 (`  maxTasks \`) and 90 (`  execution.maxOrchestratorTurns \`) from the `for key in \` loop.

- [ ] **Step 2: Add absence assertions for removed fields**

Immediately after the required-keys loop closes (after line 104, `done`), insert:

```bash
# Removed in 0.2.0: maxTasks and execution.maxOrchestratorTurns circuit breakers.
# Long-running autonomous pipelines should only trip on consecutive failures or
# an opt-in wall-clock runtime cap — task/turn count caps fight that purpose.
for removed in 'maxTasks' 'execution.maxOrchestratorTurns'; do
  has=$(jq --arg k "$removed" -r '.userConfig | has($k) | tostring' "$PLUGIN_JSON")
  assert_eq "userConfig does NOT contain $removed" "false" "$has"
done
```

- [ ] **Step 3: Add default-value assertions for changed fields**

After the block added in Step 2, insert:

```bash
# 0.2.0 defaults: runtime unlimited (0 = no cap), failures raised to 5.
default_runtime=$(jq -r '.userConfig["maxRuntimeMinutes"].default' "$PLUGIN_JSON")
assert_eq "maxRuntimeMinutes default = 0 (unlimited)" "0" "$default_runtime"

min_runtime=$(jq -r '.userConfig["maxRuntimeMinutes"].min' "$PLUGIN_JSON")
assert_eq "maxRuntimeMinutes min = 0" "0" "$min_runtime"

default_failures=$(jq -r '.userConfig["maxConsecutiveFailures"].default' "$PLUGIN_JSON")
assert_eq "maxConsecutiveFailures default = 5" "5" "$default_failures"

plugin_version=$(jq -r '.version' "$PLUGIN_JSON")
assert_eq "plugin version = 0.2.0" "0.2.0" "$plugin_version"
```

- [ ] **Step 4: Run and verify failures**

Run: `bash bin/tests/config.sh`

Expected: FAILs on the four new default/absence assertions (plugin.json still has the old shape) and PASSes on the required-keys loop (removing keys from the loop doesn't break it; those entries just aren't checked anymore — they will be caught by the new absence assertions once plugin.json is updated).

Wait, re-read — removing a key from the loop will make the test pass vacuously. That's fine; the new absence assertions in Step 2 are what lock in the deletion.

Do not commit yet — proceed to Task 4.

---

## Task 4: Update `plugin.json` to match the new schema

**Files:**

- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Delete the `maxTasks` entry**

Remove lines 6–12 (the entire `"maxTasks": { ... }` block including the trailing comma).

- [ ] **Step 2: Delete the `execution.maxOrchestratorTurns` entry**

Remove lines 171–177 (the entire `"execution.maxOrchestratorTurns": { ... }` block including the trailing comma). Confirm the preceding `"execution.maxTurnsComplex"` entry still ends with `}` + comma as appropriate.

- [ ] **Step 3: Update `maxRuntimeMinutes`**

Replace the existing block with:

```json
    "maxRuntimeMinutes": {
      "type": "number",
      "default": 0,
      "min": 0,
      "max": 1440,
      "description": "Maximum pipeline runtime in minutes before circuit breaker trips. 0 = unlimited (default). Set to a positive value to enable a wall-clock emergency brake."
    },
```

- [ ] **Step 4: Update `maxConsecutiveFailures`**

Change `"default": 3` to `"default": 5`. Leave `min`, `max`, and `description` unchanged.

- [ ] **Step 5: Bump the top-level version**

Change `"version": "0.1.0"` to `"version": "0.2.0"`.

- [ ] **Step 6: Validate and run tests**

Run: `jq . .claude-plugin/plugin.json >/dev/null && echo "valid JSON"`
Expected: `valid JSON`

Run: `bash bin/tests/config.sh`
Expected: all assertions PASS.

- [ ] **Step 7: Commit**

```bash
git add .claude-plugin/plugin.json bin/tests/config.sh
git commit -m "feat(config): drop maxTasks/maxOrchestratorTurns, default runtime unlimited, bump 0.2.0"
```

---

## Task 5: Remove the dead `increment-turn` wiring

**Files:**

- Modify: `bin/pipeline-state` (delete `increment-turn` action)
- Modify: `agents/pipeline-orchestrator.md` (delete the paragraph instructing turn increment)
- Modify: `bin/pipeline-state` usage comment at top

- [ ] **Step 1: Delete the `increment-turn` case from `bin/pipeline-state`**

Remove lines 269–283 (the entire `increment-turn)` case block). Also remove line 12 from the usage comment at the top: `#   increment-turn <run-id>                  Increment .circuit_breaker.turns_completed`.

- [ ] **Step 2: Delete the orchestrator instruction paragraph**

In `agents/pipeline-orchestrator.md`, delete line 26 (the paragraph beginning `Run \`pipeline-state increment-turn <run-id>\`…`) and the surrounding blank line on whichever side leaves the document tidy.

- [ ] **Step 3: Verify nothing else calls `increment-turn`**

Run: `grep -rn "increment-turn" --include='*.sh' --include='*.md' --include='pipeline-*' .`

Expected: only matches in `docs/reference/bin-scripts.md` and `docs/reference/state-schema.md` (which we'll clean up in Task 7) and inside `docs/superpowers/specs/` / `docs/superpowers/plans/` (this plan and spec). If any live script or agent still references it, investigate before continuing.

- [ ] **Step 4: Run the test suite**

Run: `bash bin/tests/state.sh`

Expected: all PASS. (The block that used to call `increment-turn` was deleted in Task 1.)

- [ ] **Step 5: Commit**

```bash
git add bin/pipeline-state agents/pipeline-orchestrator.md
git commit -m "refactor(state): remove increment-turn action — consumer deleted"
```

---

## Task 6: Add autocompact override to `settings.json`

**Files:**

- Modify: `settings.json`

- [ ] **Step 1: Add the `env` block**

Rewrite `settings.json` to:

```json
{
  "env": {
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50"
  },
  "permissions": {
    "allow": [
      "Bash(pipeline-*)",
      "Bash(git *)",
      "Bash(gh *)",
      "Bash(pnpm *)",
      "Bash(npm *)",
      "Bash(npx *)",
      "Bash(yarn *)",
      "Bash(bun *)",
      "Read",
      "Write",
      "Edit",
      "Grep",
      "Glob",
      "Agent"
    ]
  }
}
```

- [ ] **Step 2: Validate**

Run: `jq . settings.json >/dev/null && echo "valid JSON"`
Expected: `valid JSON`

- [ ] **Step 3: Commit**

```bash
git add settings.json
git commit -m "feat(settings): lower autocompact trigger to 50% for long autonomous runs"
```

---

## Task 7: Documentation sync

This task is a coordinated doc sweep. Each step is one file; do them in order and commit once at the end. The grep in the last step catches anything missed.

- [ ] **Step 1: `docs/reference/configuration.md`**

Read the file first. Then:

- Delete the `### maxTasks` section (table + any prose).
- Delete the `### maxOrchestratorTurns` section under Execution.
- Update the `### maxRuntimeMinutes` table to `Default: 0`, `Min: 0`, `Max: 1440`. Append a line to the description: "`0` = unlimited (default). Set to a positive value to enable a wall-clock emergency brake."
- Update the `### maxConsecutiveFailures` table: `Default: 5` (Min/Max unchanged).

- [ ] **Step 2: `docs/reference/state-schema.md`**

Read the file. In the `circuit_breaker` section:

- Remove the `tasks_completed` example field (line 274 area) from the JSON example.
- Remove the `turns_completed` example field (line 278 area) from the JSON example.
- Delete the `tasks_completed` and `turns_completed` rows from the field table (lines 285 and 289 area).
- Add a short note: "Legacy state files from 0.1.x runs may include `tasks_completed` and `turns_completed` fields; these are ignored from 0.2.0 onward."

- [ ] **Step 3: `docs/reference/bin-scripts.md`**

Read the file. Remove any section/entry documenting `pipeline-state increment-turn`. Remove any mention of `maxTasks` or `maxOrchestratorTurns` in the `pipeline-circuit-breaker` description. Update the circuit-breaker script's documented behavior to reflect the new two-check contract.

- [ ] **Step 4: `docs/reference/commands.md`**

Read the file. Remove any references to `maxTasks` or `maxOrchestratorTurns` (typically in `/configure` command examples). Update defaults in examples.

- [ ] **Step 5: `docs/reference/exit-codes.md`**

Read the file. If there are entries for exit codes specifically tied to `maxTasks` or `maxOrchestratorTurns` circuit trips, collapse them into a single "circuit breaker tripped" entry (the script still exits 1 for any trip reason).

- [ ] **Step 6: `docs/getting-started.md`**

Read the file. Replace any mention of the 20-task or 500-turn caps with the new contract: "The pipeline runs until all tasks complete, five consecutive failures occur, or (if set) `maxRuntimeMinutes` elapses."

- [ ] **Step 7: `docs/guides/configuration.md`**

Read the file. Same treatment as configuration.md — remove the two deleted fields, update defaults for the two changed ones.

- [ ] **Step 8: `docs/architecture/components.md`**

Read the file. Remove any references to `maxTasks` / `maxOrchestratorTurns` circuit-breaker stages in the architecture description.

- [ ] **Step 9: `docs/explanation/rate-limiting.md`**

Read the file. If it references `turns_completed` in the pause-credit explanation, simplify — pause credits still apply to `maxRuntimeMinutes`, but the turn counter is gone.

- [ ] **Step 10: `commands/configure.md`**

Read the file. Remove any prompts or examples that configure `maxTasks` or `maxOrchestratorTurns`. Update the failure-threshold example to show `5`.

- [ ] **Step 11: Final grep for missed references**

Run:

```bash
grep -rn "maxTasks\|maxOrchestratorTurns\|turns_completed\|tasks_completed\|increment-turn" \
  --include='*.md' --include='*.json' --include='*.sh' --include='pipeline-*' \
  --exclude-dir=remediation --exclude-dir=node_modules \
  . | grep -v "docs/superpowers/"
```

Expected output: empty (only the spec/plan in `docs/superpowers/` should mention these, and the state-schema note about legacy fields). If anything else matches, open that file and decide whether to update or leave (some mentions in historical bash comments may be fine; live code and docs should be clean).

- [ ] **Step 12: Commit**

```bash
git add docs/ commands/configure.md
git commit -m "docs: sync configuration, state-schema, and guides with 0.2.0 circuit-breaker shape"
```

---

## Task 8: Final verification

- [ ] **Step 1: Run all bin tests**

Run: `bash bin/tests/config.sh && bash bin/tests/state.sh`

Expected: both exit 0, no FAILs.

- [ ] **Step 2: Spot-check the circuit breaker end-to-end**

```bash
# Init a fresh run
pipeline-init "verify-caps" --mode prd --force
# With unlimited runtime and no failures, should be safe at any task count
pipeline-state write "verify-caps" '.circuit_breaker.tasks_completed' '500'
pipeline-state write "verify-caps" '.circuit_breaker.turns_completed' '9999'
pipeline-circuit-breaker "verify-caps" | jq '.tripped'
```

Expected: `false`.

- [ ] **Step 3: Confirm version bump**

Run: `jq -r .version .claude-plugin/plugin.json`
Expected: `0.2.0`.

- [ ] **Step 4: Confirm autocompact env var**

Run: `jq -r '.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE' settings.json`
Expected: `50`.

- [ ] **Step 5: Run scribe agent to catch any missed doc references**

Dispatch the `scribe` agent (per user's global instructions) to sync `/docs` against the current state. If it proposes further edits, review them.

- [ ] **Step 6: No final commit needed unless scribe proposed changes**

If scribe made edits: review diff, then:

```bash
git add docs/
git commit -m "docs: scribe sync after 0.2.0 circuit-breaker changes"
```

---

## Self-review checklist

**Spec coverage:**

- ✅ Delete `maxTasks` from config/circuit-breaker/tests/docs → Tasks 1–4, 7
- ✅ Delete `execution.maxOrchestratorTurns` from config/circuit-breaker/tests/docs → Tasks 1–5, 7
- ✅ `maxRuntimeMinutes` default 0, min 0 → Task 4
- ✅ `maxConsecutiveFailures` default 5 → Task 4
- ✅ `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50` in settings.json → Task 6
- ✅ Plugin version 0.2.0 → Task 4
- ✅ Test updates → Tasks 1, 3
- ✅ State-file tolerance (no migration) → implicit in Task 2's threshold-check code; legacy fields on disk are just unread

**Placeholder scan:** no "TBD" / "appropriate error handling" / "similar to Task N" / bare references. All code steps include code; all command steps include commands and expected output.

**Type consistency:** `max_runtime` and `max_failures` are the two surviving bash variables in the circuit breaker; both used consistently across Task 1 tests and Task 2 implementation. The jq output schema is defined once in Task 2 and asserted on in Task 1 (absence of `max_tasks`, `max_orchestrator_turns` keys).
