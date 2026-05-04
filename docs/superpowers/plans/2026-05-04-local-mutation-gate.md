# Local Mutation Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract mutation testing into `bin/pipeline-mutation-gate` so the pipeline runs the **same scoped mutation testing locally that GitHub CI runs**, blocking PR creation when local mutation fails.

**Architecture:**

- New standalone script `bin/pipeline-mutation-gate <run-id> <task-id> <worktree>` mirrors the scope-computation logic in `templates/.github/workflows/quality-gate.yml` (lines 80–101): `git diff --name-only --diff-filter=AM origin/staging...HEAD -- 'src/**/*.ts'`, filtered to drop test/spec/d/types/data/index files.
- The script invokes `stryker run --mutate "$scope"` (matches CI), parses the score from `reports/mutation/mutation.json`, and compares against `quality.mutationScoreTarget` (default 80).
- `_run_ship_pregate()` in `bin/pipeline-run-task` replaces its inline mutation block with a single call to the new script. The risk-tier filter is dropped — every staging-bound PR runs the gate, matching CI.
- Failure (exec error, score < target, scope-execution failure) returns non-zero, propagates through `_run_ship_pregate`, and blocks `gh pr create`.

**Tech Stack:** bash 5+, jq, git, Stryker (vitest runner, configured via project's `.stryker.config.json`).

**Decisions locked in:**

- Base ref is always `origin/staging` (the factory pipeline opens task PRs against `staging`, line 1432 of `pipeline-run-task`). Develop-target rollups stay CI-only.
- Tier filter dropped. CI doesn't filter by tier; local gate must match.
- Empty-scope skip is a pass (matches CI behavior at line 102–104 of the workflow).
- No-`test:mutation`-script and no-`package.json` are pass-with-skip (graceful for non-JS repos).
- Failure blocks PR creation per user instruction.

---

## File Structure

**New files:**

- `bin/pipeline-mutation-gate` — executable bash script. Single responsibility: compute scope, run scoped mutation, evaluate score, write `mutation_gate` to state. ~150 lines.
- `bin/tests/mutation-gate.sh` — test suite. Stubs `stryker`/package manager, fixtures git history for scope computation, asserts behavior across pass/fail/skip paths. ~250 lines.

**Modified files:**

- `bin/pipeline-run-task` — replace mutation block in `_run_ship_pregate()` (lines 1147–1200) with single call to `pipeline-mutation-gate`. Reduce function size; preserve `quality_gates.pregate.mutation` field for downstream consumers (`pipeline-summary`, `pipeline-score`).
- `bin/test` — register `mutation-gate` in `SUITES` array.
- `docs/reference/bin-scripts.md` — document new script.
- `docs/explanation/quality-gates.md` — note local mutation gate parity with CI.
- `docs/architecture/components.md` — add `pipeline-mutation-gate` to component list if present.

**Unchanged (verified to not need updates):**

- `templates/.stryker.config.json`, `templates/package.scaffold.json`, `templates/.github/workflows/quality-gate.yml` — already correct.
- `bin/pipeline-classify-risk` — risk tier still informs reviewer selection elsewhere; only mutation drops the filter.

---

## Task 1: Skeleton + arg parsing for `pipeline-mutation-gate`

**Files:**

- Create: `bin/pipeline-mutation-gate`
- Create: `bin/tests/mutation-gate.sh`

- [ ] **Step 1: Write failing test for arg validation**

Append to `bin/tests/mutation-gate.sh`:

```bash
#!/usr/bin/env bash
# mutation-gate.sh — pipeline-mutation-gate scope computation, stryker
# invocation, score evaluation, and state write across pass/fail/skip paths.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$PLUGIN_ROOT/bin:$PATH"

TEST_ROOT=$(mktemp -d)
trap '[[ "$TEST_ROOT" == /tmp/* ]] && rm -rf "$TEST_ROOT"' EXIT
export CLAUDE_PLUGIN_DATA="$TEST_ROOT/plugin-data"
mkdir -p "$CLAUDE_PLUGIN_DATA"

pass=0
fail=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"; pass=$((pass+1))
  else
    echo "  FAIL: $label (expected '$expected', got '$actual')"; fail=$((fail+1))
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  PASS: $label"; pass=$((pass+1))
  else
    echo "  FAIL: $label (missing '$needle' in '$haystack')"; fail=$((fail+1))
  fi
}

echo "=== T1: missing args exits non-zero ==="
set +e
out=$(pipeline-mutation-gate 2>&1)
rc=$?
set -e
assert_eq "no args → exit non-zero" "1" "$([[ $rc -ne 0 ]] && echo 1 || echo 0)"
assert_contains "no args → usage message" "missing" "$out"

echo ""
echo "Total: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
```

- [ ] **Step 2: Run test, expect failure**

Run: `bash bin/tests/mutation-gate.sh`
Expected: FAIL — `pipeline-mutation-gate: command not found`

- [ ] **Step 3: Create script skeleton**

Create `bin/pipeline-mutation-gate`:

```bash
#!/usr/bin/env bash
# Run scoped Stryker mutation testing locally with the same scope semantics
# as templates/.github/workflows/quality-gate.yml. Mirrors CI exactly so a
# task that fails mutation locally would also fail on CI, and vice versa.
#
# Usage: pipeline-mutation-gate <run-id> <task-id> <worktree>
#
# Output: structured JSON to stdout — `{ok, reason, score, target, scope}`.
# Same JSON written to state under `.tasks.<task-id>.mutation_gate`.
# Exit 0 on pass/skip, 1 on fail.
#
# Skip reasons: no-package-json, no-script, no-mutable-changes, base-missing.
# Fail reasons: stryker-failed, score-below-target.

set -euo pipefail
source "$(dirname "$0")/pipeline-lib.sh"
require_command jq
require_command git

run_id="${1:?missing run-id}"
task_id="${2:?missing task-id}"
worktree="${3:-$PWD}"

if [[ ! -d "$worktree" ]]; then
  log_error "worktree does not exist: $worktree"
  printf '{"ok":false,"reason":"worktree-missing"}\n'
  exit 1
fi
```

Make executable:

```bash
chmod +x bin/pipeline-mutation-gate
```

- [ ] **Step 4: Run test, verify it passes**

Run: `bash bin/tests/mutation-gate.sh`
Expected: PASS — both T1 assertions green.

- [ ] **Step 5: Commit**

```bash
git add bin/pipeline-mutation-gate bin/tests/mutation-gate.sh
git commit -m "feat(pipeline-mutation-gate): script skeleton + arg validation"
```

---

## Task 2: Skip paths — no package.json, no script

**Files:**

- Modify: `bin/pipeline-mutation-gate`
- Modify: `bin/tests/mutation-gate.sh`

- [ ] **Step 1: Write failing tests for skip paths**

Append before final summary in `bin/tests/mutation-gate.sh`:

```bash
echo "=== T2a: no package.json → skip pass ==="
WT=$(mktemp -d)
RUN_ID="run-t2a"; TASK_ID="t2a"
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID"
printf '{"tasks":{"%s":{}}}' "$TASK_ID" > "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json"
out=$(pipeline-mutation-gate "$RUN_ID" "$TASK_ID" "$WT")
rc=$?
assert_eq "no package.json → exit 0" "0" "$rc"
assert_eq "no package.json → ok=true" "true" "$(jq -r .ok <<<"$out")"
assert_eq "no package.json → reason" "no-package-json" "$(jq -r .reason <<<"$out")"

echo "=== T2b: package.json without test:mutation → skip pass ==="
WT=$(mktemp -d)
printf '{"scripts":{"test":"vitest"}}' > "$WT/package.json"
RUN_ID="run-t2b"; TASK_ID="t2b"
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID"
printf '{"tasks":{"%s":{}}}' "$TASK_ID" > "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json"
out=$(pipeline-mutation-gate "$RUN_ID" "$TASK_ID" "$WT")
rc=$?
assert_eq "no test:mutation → exit 0" "0" "$rc"
assert_eq "no test:mutation → ok=true" "true" "$(jq -r .ok <<<"$out")"
assert_eq "no test:mutation → reason" "no-script" "$(jq -r .reason <<<"$out")"
state_reason=$(jq -r --arg t "$TASK_ID" '.tasks[$t].mutation_gate.reason' "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json")
assert_eq "no test:mutation → state.mutation_gate.reason" "no-script" "$state_reason"
```

- [ ] **Step 2: Run tests, expect failures**

Run: `bash bin/tests/mutation-gate.sh`
Expected: FAIL on T2a/T2b — script doesn't yet handle package.json absence.

- [ ] **Step 3: Implement skip paths**

Append to `bin/pipeline-mutation-gate`:

```bash
cd "$worktree"

run_dir="${CLAUDE_PLUGIN_DATA}/runs/${run_id}"

# Helper: write {ok, reason, score, target, scope} to stdout and to
# state.tasks.<task>.mutation_gate. Returns the requested exit code.
_emit() {
  local ok="$1" reason="$2" score="${3:-null}" target="${4:-null}" scope="${5:-}" exit_rc="$6"

  local scope_json='[]'
  if [[ -n "$scope" ]]; then
    scope_json=$(printf '%s' "$scope" | tr ',' '\n' | jq -R -s 'split("\n") | map(select(length > 0))')
  fi

  local payload
  payload=$(jq -n \
    --argjson ok "$ok" \
    --arg reason "$reason" \
    --argjson score "$score" \
    --argjson target "$target" \
    --argjson scope "$scope_json" \
    '{ok:$ok, reason:$reason, score:$score, target:$target, scope:$scope}')

  if [[ -f "$run_dir/state.json" ]]; then
    pipeline-state task-write "$run_id" "$task_id" mutation_gate "$payload" >/dev/null \
      || log_warn "failed to record mutation_gate for $task_id (non-fatal)"
  fi

  printf '%s\n' "$payload"
  log_metric "task.gate.mutation" "task_id=\"$task_id\"" \
    "ok=\"$([[ "$ok" == "true" ]] && echo true || echo false)\"" \
    "reason=\"$reason\""
  exit "$exit_rc"
}

if [[ ! -f package.json ]]; then
  _emit true "no-package-json" null null "" 0
fi

mut_script=$(jq -r '.scripts["test:mutation"] // empty' package.json 2>/dev/null || printf '')
if [[ -z "$mut_script" ]]; then
  _emit true "no-script" null null "" 0
fi
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bash bin/tests/mutation-gate.sh`
Expected: PASS on T1, T2a, T2b.

- [ ] **Step 5: Commit**

```bash
git add bin/pipeline-mutation-gate bin/tests/mutation-gate.sh
git commit -m "feat(pipeline-mutation-gate): skip cleanly when no package.json or test:mutation"
```

---

## Task 3: Scope computation against `origin/staging`

**Files:**

- Modify: `bin/pipeline-mutation-gate`
- Modify: `bin/tests/mutation-gate.sh`

- [ ] **Step 1: Add helper to set up a tiny git repo for scope tests**

Append to `bin/tests/mutation-gate.sh` (between header helpers and tests):

```bash
# Build a minimal git worktree with an `origin/staging` ref that contains
# baseline files and a HEAD that adds/modifies the listed src files.
# Args: <out-dir> <added-or-modified-files...>
_seed_repo() {
  local dir="$1"; shift
  ( set -e
    cd "$dir"
    git init -q -b main
    git config user.email "t@t"; git config user.name "t"
    mkdir -p src
    echo "baseline" > src/baseline.ts
    git add src/baseline.ts
    git commit -q -m "baseline"
    git branch -q staging
    git remote add origin "$dir/.git"
    git fetch -q origin
    git checkout -q -b feature
    for f in "$@"; do
      mkdir -p "$(dirname "$f")"
      printf 'export const x = %s;\n' "$RANDOM" > "$f"
    done
    git add -A
    git commit -q -m "feature changes"
  )
}
```

- [ ] **Step 2: Write failing tests for scope computation**

```bash
echo "=== T3a: no src changes vs origin/staging → skip pass ==="
WT=$(mktemp -d)
_seed_repo "$WT" "docs/readme.md"
printf '{"scripts":{"test:mutation":"stryker run"}}' > "$WT/package.json"
RUN_ID="run-t3a"; TASK_ID="t3a"
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID"
printf '{"tasks":{"%s":{}}}' "$TASK_ID" > "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json"
out=$(pipeline-mutation-gate "$RUN_ID" "$TASK_ID" "$WT")
rc=$?
assert_eq "no src changes → exit 0" "0" "$rc"
assert_eq "no src changes → reason" "no-mutable-changes" "$(jq -r .reason <<<"$out")"

echo "=== T3b: only test/d.ts changes → skip pass ==="
WT=$(mktemp -d)
_seed_repo "$WT" "src/foo.test.ts" "src/types/x.d.ts" "src/data/y.ts" "src/index.ts"
printf '{"scripts":{"test:mutation":"stryker run"}}' > "$WT/package.json"
RUN_ID="run-t3b"; TASK_ID="t3b"
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID"
printf '{"tasks":{"%s":{}}}' "$TASK_ID" > "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json"
out=$(pipeline-mutation-gate "$RUN_ID" "$TASK_ID" "$WT")
rc=$?
assert_eq "only filtered files → exit 0" "0" "$rc"
assert_eq "only filtered files → reason" "no-mutable-changes" "$(jq -r .reason <<<"$out")"

echo "=== T3c: mixed src + filtered changes → scope contains only mutable ==="
# Create env where stryker is mocked to a passing no-op so we exercise scope.
MOCKS=$(mktemp -d)
export PATH="$MOCKS:$PATH"
cat > "$MOCKS/pnpm" <<'EOM'
#!/usr/bin/env bash
# Capture invocation for inspection; succeed silently.
echo "$@" > "$MOCKS_LOG"
mkdir -p "$WT/reports/mutation"
printf '{"metrics":{"mutationScore":95}}' > "$WT/reports/mutation/mutation.json"
exit 0
EOM
chmod +x "$MOCKS/pnpm"

WT=$(mktemp -d)
export MOCKS_LOG="$WT/.pnpm-args"
_seed_repo "$WT" "src/foo.ts" "src/foo.test.ts" "src/bar.ts" "src/types/y.d.ts"
printf '{"scripts":{"test:mutation":"stryker run"}}' > "$WT/package.json"
RUN_ID="run-t3c"; TASK_ID="t3c"
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID"
printf '{"tasks":{"%s":{}}}' "$TASK_ID" > "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json"
out=$(pipeline-mutation-gate "$RUN_ID" "$TASK_ID" "$WT")
rc=$?
assert_eq "mixed → exit 0 (mocked stryker green)" "0" "$rc"
scope_csv=$(jq -r '.scope | join(",")' <<<"$out")
assert_contains "scope contains src/foo.ts" "src/foo.ts" "$scope_csv"
assert_contains "scope contains src/bar.ts" "src/bar.ts" "$scope_csv"
case "$scope_csv" in
  *foo.test.ts*) echo "  FAIL: scope must not contain test files"; fail=$((fail+1)) ;;
  *)             echo "  PASS: scope excludes test files";       pass=$((pass+1)) ;;
esac
case "$scope_csv" in
  *types/*) echo "  FAIL: scope must not contain types/";        fail=$((fail+1)) ;;
  *)        echo "  PASS: scope excludes types/";                pass=$((pass+1)) ;;
esac
```

- [ ] **Step 3: Run tests, expect failures**

Run: `bash bin/tests/mutation-gate.sh`
Expected: FAIL on T3a, T3b, T3c — script doesn't yet compute scope or run stryker.

- [ ] **Step 4: Implement scope computation + stryker invocation**

Append to `bin/pipeline-mutation-gate` (after the `no-script` skip):

```bash
base_ref="${FACTORY_MUTATION_BASE:-staging}"

# Verify origin/<base> exists. Without the base ref we cannot reproduce CI's
# scope. Fail loudly rather than silently full-running, which would diverge
# from CI and defeat the purpose of this gate.
if ! git -C "$worktree" rev-parse --verify "origin/${base_ref}" >/dev/null 2>&1; then
  log_error "mutation gate: origin/${base_ref} not found in $worktree — fetch it before running"
  _emit false "base-missing" null null "" 1
fi

# Mirror templates/.github/workflows/quality-gate.yml lines 86-96.
mapfile -t scope_files < <(
  git -C "$worktree" diff --name-only --diff-filter=AM "origin/${base_ref}...HEAD" -- 'src/**/*.ts' 2>/dev/null \
    | grep -Ev '\.(test|spec|d)\.ts$|/types/|/data/|/index\.ts$' || true
)

if [[ ${#scope_files[@]} -eq 0 ]]; then
  _emit true "no-mutable-changes" null null "" 0
fi

scope_csv=$(IFS=,; printf '%s' "${scope_files[*]}")

pkg_mgr=$(detect_pkg_manager "$worktree")
mut_log="$run_dir/${task_id}.mutation.gate.log"
mkdir -p "$run_dir"

set +e
(cd "$worktree" && "$pkg_mgr" exec stryker run --mutate "$scope_csv") >"$mut_log" 2>&1
mut_rc=$?
set -e
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `bash bin/tests/mutation-gate.sh`
Expected: PASS on T1, T2\*, T3a, T3b. T3c may still fail because score evaluation isn't wired yet — that's expected and addressed in Task 4.

- [ ] **Step 6: Commit**

```bash
git add bin/pipeline-mutation-gate bin/tests/mutation-gate.sh
git commit -m "feat(pipeline-mutation-gate): compute scope vs origin/staging and invoke stryker"
```

---

## Task 4: Score evaluation + failure paths

**Files:**

- Modify: `bin/pipeline-mutation-gate`
- Modify: `bin/tests/mutation-gate.sh`

- [ ] **Step 1: Write failing tests for score evaluation**

Append to `bin/tests/mutation-gate.sh`:

```bash
echo "=== T4a: stryker exits non-zero → fail ==="
MOCKS=$(mktemp -d)
export PATH="$MOCKS:$PATH"
cat > "$MOCKS/pnpm" <<'EOM'
#!/usr/bin/env bash
echo "stryker exploded" >&2
exit 7
EOM
chmod +x "$MOCKS/pnpm"
WT=$(mktemp -d)
_seed_repo "$WT" "src/foo.ts"
printf '{"scripts":{"test:mutation":"stryker run"}}' > "$WT/package.json"
RUN_ID="run-t4a"; TASK_ID="t4a"
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID"
printf '{"tasks":{"%s":{}}}' "$TASK_ID" > "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json"
set +e
out=$(pipeline-mutation-gate "$RUN_ID" "$TASK_ID" "$WT")
rc=$?
set -e
assert_eq "stryker fail → exit 1" "1" "$rc"
assert_eq "stryker fail → reason" "stryker-failed" "$(jq -r .reason <<<"$out")"

echo "=== T4b: score below target → fail ==="
MOCKS=$(mktemp -d)
export PATH="$MOCKS:$PATH"
cat > "$MOCKS/pnpm" <<'EOM'
#!/usr/bin/env bash
mkdir -p "$WT/reports/mutation"
printf '{"metrics":{"mutationScore":42}}' > "$WT/reports/mutation/mutation.json"
exit 0
EOM
chmod +x "$MOCKS/pnpm"
WT=$(mktemp -d)
export WT
_seed_repo "$WT" "src/foo.ts"
printf '{"scripts":{"test:mutation":"stryker run"},"factory":{"quality":{"mutationScoreTarget":80}}}' > "$WT/package.json"
RUN_ID="run-t4b"; TASK_ID="t4b"
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID"
printf '{"tasks":{"%s":{}}}' "$TASK_ID" > "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json"
set +e
out=$(pipeline-mutation-gate "$RUN_ID" "$TASK_ID" "$WT")
rc=$?
set -e
assert_eq "low score → exit 1" "1" "$rc"
assert_eq "low score → reason" "score-below-target" "$(jq -r .reason <<<"$out")"
assert_eq "low score → score field" "42" "$(jq -r .score <<<"$out")"
assert_eq "low score → target field" "80" "$(jq -r .target <<<"$out")"

echo "=== T4c: score at/above target → pass ==="
MOCKS=$(mktemp -d)
export PATH="$MOCKS:$PATH"
cat > "$MOCKS/pnpm" <<'EOM'
#!/usr/bin/env bash
mkdir -p "$WT/reports/mutation"
printf '{"metrics":{"mutationScore":85}}' > "$WT/reports/mutation/mutation.json"
exit 0
EOM
chmod +x "$MOCKS/pnpm"
WT=$(mktemp -d)
export WT
_seed_repo "$WT" "src/foo.ts"
printf '{"scripts":{"test:mutation":"stryker run"}}' > "$WT/package.json"
RUN_ID="run-t4c"; TASK_ID="t4c"
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID"
printf '{"tasks":{"%s":{}}}' "$TASK_ID" > "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json"
out=$(pipeline-mutation-gate "$RUN_ID" "$TASK_ID" "$WT")
rc=$?
assert_eq "good score → exit 0" "0" "$rc"
assert_eq "good score → ok=true" "true" "$(jq -r .ok <<<"$out")"
assert_eq "good score → score=85" "85" "$(jq -r .score <<<"$out")"

echo "=== T4d: pass without report (stryker green, no JSON) → pass ==="
MOCKS=$(mktemp -d)
export PATH="$MOCKS:$PATH"
cat > "$MOCKS/pnpm" <<'EOM'
#!/usr/bin/env bash
exit 0
EOM
chmod +x "$MOCKS/pnpm"
WT=$(mktemp -d)
_seed_repo "$WT" "src/foo.ts"
printf '{"scripts":{"test:mutation":"stryker run"}}' > "$WT/package.json"
RUN_ID="run-t4d"; TASK_ID="t4d"
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID"
printf '{"tasks":{"%s":{}}}' "$TASK_ID" > "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json"
out=$(pipeline-mutation-gate "$RUN_ID" "$TASK_ID" "$WT")
rc=$?
assert_eq "stryker green w/o report → exit 0" "0" "$rc"
assert_eq "stryker green w/o report → reason" "no-report" "$(jq -r .reason <<<"$out")"
```

- [ ] **Step 2: Run tests, expect failures**

Run: `bash bin/tests/mutation-gate.sh`
Expected: FAIL on T4a–T4d.

- [ ] **Step 3: Implement score evaluation**

Append to `bin/pipeline-mutation-gate`:

```bash
if [[ $mut_rc -ne 0 ]]; then
  log_warn "mutation gate: stryker exited $mut_rc — see $mut_log"
  _emit false "stryker-failed" null null "$scope_csv" 1
fi

target=$(read_config '.quality.mutationScoreTarget' '80')

score_file="$worktree/reports/mutation/mutation.json"
if [[ ! -f "$score_file" ]]; then
  _emit true "no-report" null "$target" "$scope_csv" 0
fi

score=$(jq -r '.metrics.mutationScore // empty' "$score_file" 2>/dev/null || printf '')
if [[ -z "$score" ]]; then
  _emit true "no-score" null "$target" "$scope_csv" 0
fi

# Coerce to integer for comparison; preserve raw value in JSON output.
score_int=$(printf '%.0f' "$score")
if (( score_int < target )); then
  log_warn "mutation gate: score $score < target $target"
  _emit false "score-below-target" "$score" "$target" "$scope_csv" 1
fi

_emit true "ok" "$score" "$target" "$scope_csv" 0
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bash bin/tests/mutation-gate.sh`
Expected: PASS on T1, T2*, T3*, T4\*.

- [ ] **Step 5: Commit**

```bash
git add bin/pipeline-mutation-gate bin/tests/mutation-gate.sh
git commit -m "feat(pipeline-mutation-gate): score evaluation against quality.mutationScoreTarget"
```

---

## Task 5: Wire `_run_ship_pregate` to call the new script

**Files:**

- Modify: `bin/pipeline-run-task` (lines 1147–1200, 1219–1221)

- [ ] **Step 1: Read the current block to confirm boundaries**

Run: `Read bin/pipeline-run-task offset=1147 limit=80`
Confirm the block starts at the `# 3. Tier-gated mutation testing` comment and ends before the `local overall_ok=true` line at 1202.

- [ ] **Step 2: Replace the block**

Edit `bin/pipeline-run-task`. Replace lines 1147–1200 (the entire mutation block including its tier filter, package detection, and inline stryker run) with:

```bash
  # 3. Mutation testing — mirrors templates/.github/workflows/quality-gate.yml.
  #    Runs unconditionally for every staging-bound task PR; scope-filters
  #    inside pipeline-mutation-gate so we only mutate files actually changed.
  local mut_gate="skipped"
  set +e
  pipeline-mutation-gate "$run_id" "$task_id" "$wt" >/dev/null
  local mut_rc=$?
  set -e
  local mut_reason
  mut_reason=$(pipeline-state task-read "$run_id" "$task_id" mutation_gate.reason 2>/dev/null \
    | tr -d '"' || printf '')
  case "$mut_rc:$mut_reason" in
    0:ok)                     mut_gate="ok" ;;
    0:no-package-json|0:no-script|0:no-mutable-changes|0:no-report|0:no-score)
                              mut_gate="skipped" ;;
    0:*)                      mut_gate="ok" ;;
    *:*)                      mut_gate="fail" ;;
  esac
  if [[ "$mut_gate" == "fail" ]]; then
    log_warn "ship pregate: mutation gate failed for $task_id (reason=${mut_reason:-unknown})"
  fi

  # Surface score for downstream consumers (pipeline-summary, pipeline-score).
  local mut_score
  mut_score=$(pipeline-state task-read "$run_id" "$task_id" mutation_gate.score 2>/dev/null || printf 'null')
  if [[ "$mut_score" != "null" && -n "$mut_score" ]]; then
    _task_write mutation_score "$mut_score"
  fi
```

- [ ] **Step 3: Verify nothing else references the removed log variable**

Run: `grep -n "mutation.pregate.log" bin/pipeline-run-task`
Expected: 0 matches (only `mutation.gate.log` from the new script remains).

- [ ] **Step 4: Run existing pipeline-run-task suite**

Run: `bin/test run-command integration`
Expected: all pass.

- [ ] **Step 5: Run mutation-gate suite**

Run: `bin/test mutation-gate`
Expected: all pass (suite registered next task).

- [ ] **Step 6: Commit**

```bash
git add bin/pipeline-run-task
git commit -m "feat(pipeline-run-task): delegate ship-pregate mutation to pipeline-mutation-gate"
```

---

## Task 6: Register suite in `bin/test`

**Files:**

- Modify: `bin/test`

- [ ] **Step 1: Read current SUITES array**

Run: `Read bin/test offset=15 limit=20`
Locate the `SUITES=(` array.

- [ ] **Step 2: Add `mutation-gate` after `quality-gate`-adjacent entries**

Edit `bin/test`. In the `SUITES=( ... )` array, add `mutation-gate` after `quota-gate`:

```bash
SUITES=(
  state
  spec-intake
  task-prep
  branching
  cleanup
  hooks
  audit-hooks
  routing
  quota-gate
  mutation-gate
  run-command
  config
  integration
  score
)
```

- [ ] **Step 3: Run full test suite**

Run: `bin/test`
Expected: all suites pass including `mutation-gate`.

- [ ] **Step 4: Commit**

```bash
git add bin/test
git commit -m "test(mutation-gate): register suite in master test runner"
```

---

## Task 7: Update documentation

**Files:**

- Modify: `docs/reference/bin-scripts.md`
- Modify: `docs/explanation/quality-gates.md`
- Modify: `docs/architecture/components.md` (only if it lists bin scripts)

- [ ] **Step 1: Read current bin-scripts reference**

Run: `Read docs/reference/bin-scripts.md`
Identify the section for ship-time gates (likely near `pipeline-coverage-gate`).

- [ ] **Step 2: Add `pipeline-mutation-gate` entry**

Insert after the `pipeline-coverage-gate` entry, matching the document's existing format:

```markdown
### `pipeline-mutation-gate`

`pipeline-mutation-gate <run-id> <task-id> <worktree>`

Runs scoped Stryker mutation testing locally before PR creation. Mirrors the
scope semantics of `templates/.github/workflows/quality-gate.yml` — diffs
`origin/staging...HEAD` for `src/**/*.ts`, filters out test/spec/d.ts/types/
data/index files, and invokes `<pkg-manager> exec stryker run --mutate <csv>`.

Writes `tasks.<task-id>.mutation_gate = {ok, reason, score, target, scope}` to
state. Exit codes: 0 on pass or skip, 1 on failure (stryker exec error or
mutation score below `quality.mutationScoreTarget`, default 80).

Skip reasons (exit 0): `no-package-json`, `no-script`, `no-mutable-changes`,
`no-report`, `no-score`. Fail reasons (exit 1): `base-missing`,
`stryker-failed`, `score-below-target`.

Invoked from `_run_ship_pregate()` in `pipeline-run-task` — every staging-bound
task PR runs this gate, regardless of risk tier.
```

- [ ] **Step 3: Update quality-gates explanation**

Edit `docs/explanation/quality-gates.md`. Find the section discussing local-vs-CI gate parity (search for "mutation"). Replace the tier-gated description with:

```markdown
**Mutation testing (local + CI, identical scope).** `pipeline-mutation-gate`
runs at ship time inside `_run_ship_pregate`. It computes the mutation scope
exactly the way the GitHub `Quality Gate` workflow does — `git diff
--diff-filter=AM origin/staging...HEAD -- 'src/**/*.ts'` minus test/spec/
d.ts/types/data/index files — and invokes `stryker run --mutate <scope>`. A
score below `quality.mutationScoreTarget` (default 80) blocks the PR before
`gh pr create` runs, so mutation regressions cannot reach CI.
```

- [ ] **Step 4: Update components doc if it lists scripts**

Run: `grep -n "pipeline-coverage-gate" docs/architecture/components.md`
If a list exists, add `pipeline-mutation-gate` adjacent with a one-line description matching the doc's tone. Skip if there is no script enumeration.

- [ ] **Step 5: Run docs lint (if configured)**

Run: `bin/test config`
Expected: pass — config tests verify referenced template files.

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -m "docs: document pipeline-mutation-gate and CI parity"
```

---

## Task 8: Smoke test against a real fixture

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bin/test`
Expected: all suites green.

- [ ] **Step 2: Manual smoke test in a scratch repo**

Run:

```bash
cd $(mktemp -d)
git init -q -b main
git config user.email t@t; git config user.name t
mkdir src
echo 'export const add = (a:number,b:number) => a+b;' > src/add.ts
git add -A; git commit -qm baseline; git branch staging; git remote add origin .; git fetch -q origin
git checkout -qb feat
echo 'export const add = (a:number,b:number) => a-b;' > src/add.ts
git add -A; git commit -qm "intentional mutant"
echo '{"scripts":{"test:mutation":"echo skipped"}}' > package.json
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/smoke"
echo '{"tasks":{"t":{}}}' > "$CLAUDE_PLUGIN_DATA/runs/smoke/state.json"
pipeline-mutation-gate smoke t .
echo "exit=$?"
```

Expected: exit 0 with `reason=no-report` (the stub `echo skipped` doesn't produce a Stryker JSON report). The point of this smoke is to verify the script runs end-to-end against a real git repo.

- [ ] **Step 3: Smoke-fail case**

```bash
cat > package.json <<'JSON'
{"scripts":{"test:mutation":"false"}}
JSON
pipeline-mutation-gate smoke t .
echo "exit=$?"
```

Expected: exit 1 with `reason=stryker-failed`.

- [ ] **Step 4: Verify wiring in pipeline-run-task by reading state**

Inspect `$CLAUDE_PLUGIN_DATA/runs/smoke/state.json`. Expected: `tasks.t.mutation_gate.reason == "stryker-failed"`, `tasks.t.mutation_gate.ok == false`.

- [ ] **Step 5: No commit (verification only)**

If everything passes, the feature is shipped. If anything fails, treat as a regression and fix in a new task before declaring complete.

---

## Self-Review Notes

- **Spec coverage:** Task 1 covers script existence; Task 2 covers skip paths (`no-package-json`, `no-script`); Task 3 covers scope computation + `base-missing`/`no-mutable-changes`; Task 4 covers `stryker-failed`, `score-below-target`, `no-report`, `no-score`, `ok`; Task 5 wires the gate into the ship pregate; Task 6 registers tests; Task 7 covers docs; Task 8 is end-to-end verification.
- **Type consistency:** `mutation_gate` is the state field; `mut_gate` is the local variable in pregate; `mutation_score` is preserved at the task level for `pipeline-summary` and `pipeline-score`. Same `reason` strings used everywhere.
- **No placeholders:** every step has the actual code or command.

## Open Question (judgment call locked)

**Non-staging base behavior:** The factory pipeline always opens task PRs against `staging` (line 1432 of `pipeline-run-task`), so the gate hardcodes `origin/staging` as the base ref. `FACTORY_MUTATION_BASE` env var lets advanced users override it for local experimentation, but the default matches CI.
