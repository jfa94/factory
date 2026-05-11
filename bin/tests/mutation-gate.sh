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

# Build a minimal git worktree with an `origin/staging` ref that contains
# baseline files and a HEAD that adds/modifies the listed src files.
# Args: <out-dir> <added-or-modified-files...>
_seed_repo() {
  local dir="$1"; shift
  ( set -e
    git init -q -b main "$dir"
    git -C "$dir" config user.email "t@t"; git -C "$dir" config user.name "t"
    mkdir -p "$dir/src"
    printf 'baseline' > "$dir/src/baseline.ts"
    git -C "$dir" add src/baseline.ts
    git -C "$dir" commit -q -m "baseline"
    git -C "$dir" branch -q staging
    git -C "$dir" remote add origin "$dir/.git"
    git -C "$dir" fetch -q origin
    git -C "$dir" checkout -q -b feature
    for f in "$@"; do
      mkdir -p "$dir/$(dirname "$f")"
      printf 'export const x = %s;\n' "$RANDOM" > "$dir/$f"
    done
    git -C "$dir" add -A
    git -C "$dir" commit -q -m "feature changes"
  )
}

echo "=== T1: missing args exits non-zero ==="
set +e
out=$(pipeline-mutation-gate 2>&1)
rc=$?
set -e
assert_eq "no args → exit non-zero" "1" "$([[ $rc -ne 0 ]] && echo 1 || echo 0)"
assert_contains "no args → usage message" "missing" "$out"

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
state_reason=$(jq -r --arg t "$TASK_ID" '.tasks[$t].mutation_gate.reason' "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json")
assert_eq "no package.json → state.mutation_gate.reason" "no-package-json" "$state_reason"

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
export WT
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
printf '{"scripts":{"test:mutation":"stryker run"}}' > "$WT/package.json"
RUN_ID="run-t4b"; TASK_ID="t4b"
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID"
printf '{"tasks":{"%s":{}}}' "$TASK_ID" > "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json"
# Override the global config to set target=60 (not the default 80).
printf '{"quality":{"mutationScoreTarget":60}}' > "$CLAUDE_PLUGIN_DATA/config.json"
set +e
out=$(pipeline-mutation-gate "$RUN_ID" "$TASK_ID" "$WT")
rc=$?
set -e
rm -f "$CLAUDE_PLUGIN_DATA/config.json"  # don't leak into later tests
assert_eq "low score → exit 1" "1" "$rc"
assert_eq "low score → reason" "score-below-target" "$(jq -r .reason <<<"$out")"
assert_eq "low score → score field" "42" "$(jq -r .score <<<"$out")"
assert_eq "low score → target field" "60" "$(jq -r .target <<<"$out")"

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

echo ""
echo "=== Results ==="
echo "  Passed: $pass"
echo "  Failed: $fail"
echo "  Total:  $((pass + fail))"

[[ $fail -eq 0 ]] && exit 0 || exit 1
