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

# 7. auto-merge must depend on quality, mutation-testing, AND security. A
#    regression of 6c417e2 (auto-merge ran before the mutation aggregator
#    landed) silently shipped PRs without gating on mutation. Lock the
#    needs list so the order can drift but membership cannot.
needs_block=$(awk '/^  auto-merge:/{flag=1;next} flag && /^  [a-z]/{exit} flag' "$WORKFLOW")
for required in quality mutation-testing security; do
  if grep -qE "(needs:.*\[.*\<$required\>|^[[:space:]]*-[[:space:]]*$required\>)" <<<"$needs_block"; then
    echo "  PASS: auto-merge.needs includes '$required'"; pass=$((pass+1))
  else
    echo "  FAIL: auto-merge.needs missing '$required'"; fail=$((fail+1))
  fi
done

echo ""
echo "================================"
echo "Mutation-workflow tests: $pass passed, $fail failed"
echo "================================"

[[ $fail -eq 0 ]]
