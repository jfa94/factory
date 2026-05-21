#!/usr/bin/env bash
# mutation-workflow.sh — static structural assertions on the templated
# quality-gate.yml workflow. Branch protection on staging/develop requires a
# status check named exactly "Mutation Testing"; a typo here is invisible at
# CI time because the check is never registered and the merge proceeds with
# zero enforcement. Pin the wire shape so a future yaml edit can't break it
# silently.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKFLOW="$PLUGIN_ROOT/templates/.github/workflows/quality-gate.yml"

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

echo "=== quality-gate.yml mutation aggregator wire-shape ==="

assert_eq "quality-gate.yml exists" "true" \
  "$([[ -f "$WORKFLOW" ]] && echo true || echo false)"

# 1. Aggregator job key must be `mutation-testing` (jobs.<key>:).
mt_jobkey=$(grep -cE '^  mutation-testing:$' "$WORKFLOW" || true)
assert_eq "mutation-testing job key declared" "1" "$mt_jobkey"

# 2. Aggregator display name MUST be exactly "Mutation Testing" — branch
#    protection on staging+develop is configured against this string.
mt_name=$(grep -cE '^    name: Mutation Testing$' "$WORKFLOW" || true)
assert_eq "aggregator name pinned to 'Mutation Testing' (branch-protection check)" "1" "$mt_name"

# 3. Aggregator must depend on both mutation-scope (scope output) and
#    mutation (matrix). Re-ordering or dropping either masks a real failure.
mt_needs=$(grep -cE '^    needs: \[mutation-scope, mutation\]$' "$WORKFLOW" || true)
assert_eq "aggregator needs [mutation-scope, mutation]" "1" "$mt_needs"

# 4. Aggregator runs even when shards skipped (`if: always()`).
mt_always=$(grep -cE '^    if: always\(\)$' "$WORKFLOW" || true)
[[ "$mt_always" -ge 1 ]] && { echo "  PASS: aggregator has 'if: always()' (covers skipped-shard case)"; pass=$((pass+1)); } || { echo "  FAIL: aggregator missing 'if: always()'"; fail=$((fail+1)); }

# 5. Matrix shard list must be exactly [1, 2, 3, 4]. Round-robin sharding
#    assumes 4-way distribution; changing this requires the split step to
#    update in lockstep.
shard_line=$(grep -cE '^        shard: \[1, 2, 3, 4\]$' "$WORKFLOW" || true)
assert_eq "matrix shard list is [1, 2, 3, 4]" "1" "$shard_line"

# 6. Matrix job display name must be "Mutation" (single word). Branch
#    protection sees individual matrix checks as "Mutation (N)" which is
#    distinct from the aggregator and must not be confused with it.
matrix_name=$(grep -cE '^    name: Mutation$' "$WORKFLOW" || true)
assert_eq "matrix job display name is 'Mutation'" "1" "$matrix_name"

# 7. Aggregator must exempt both `cancelled` (force-push supersession) and
#    `skipped` (docs-only / tests-only PRs leave the matrix shard skipped).
#    Without `skipped`, the Mutation Testing check fails on docs-only PRs and
#    auto-merge never fires. Regression lock for H14.
# Extract the mutation-testing job block. awk range would re-match the
# start line against the end pattern; instead, start the range from the
# line after the header and stop at the next top-level job.
agg_block=$(awk '/^  mutation-testing:/{flag=1; next} flag && /^  [a-z]/{flag=0} flag' "$WORKFLOW")
if grep -q 'cancelled' <<<"$agg_block"; then
  echo "  PASS: aggregator exempts 'cancelled' outcomes"; pass=$((pass+1))
else
  echo "  FAIL: aggregator missing 'cancelled' exemption"; fail=$((fail+1))
fi
if grep -q 'skipped' <<<"$agg_block"; then
  echo "  PASS: aggregator exempts 'skipped' outcomes (H14)"; pass=$((pass+1))
else
  echo "  FAIL: aggregator missing 'skipped' exemption (regression for H14)"; fail=$((fail+1))
fi

echo ""
echo "================================"
echo "Mutation-workflow tests: $pass passed, $fail failed"
echo "================================"

[[ $fail -eq 0 ]]
