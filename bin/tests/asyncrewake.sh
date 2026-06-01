#!/usr/bin/env bash
# asyncrewake.sh — asyncrewake-ci hook must track PRs created inside the
# pipeline-run-task ship wrapper, not only bare top-level `gh pr create`.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export CLAUDE_PLUGIN_ROOT="$REPO_ROOT"
DATA=$(mktemp -d "${TMPDIR:-/tmp}/factory-async.XXXXXX")
trap 'rm -rf "$DATA"' EXIT
export CLAUDE_PLUGIN_DATA="$DATA"
export CLAUDE_VERSION="2.1.116"
export ASYNCREWAKE_CI_SLEEP=0 ASYNCREWAKE_CI_MAX=1 ASYNCREWAKE_MERGE_SLEEP=0 ASYNCREWAKE_MERGE_MAX=1
pass=0; fail_count=0
ok(){ pass=$((pass+1)); printf '  PASS: %s\n' "$1"; }
fail(){ fail_count=$((fail_count+1)); printf '  FAIL: %s\n' "$1"; }

RID="run-async"; TID="t1"
mkdir -p "$DATA/runs/$RID"
jq -n '{run_id:"run-async",
        tasks:{"t1":{status:"reviewing", pr_number:4242}}}' \
  > "$DATA/runs/$RID/state.json"
ln -s "$DATA/runs/$RID" "$DATA/runs/current"

stub=$(mktemp -d)
cat > "$stub/gh" <<'EOF'
#!/usr/bin/env bash
# `gh pr view <n> --json statusCheckRollup` → all SUCCESS; merge poll → MERGED.
if printf '%s ' "$@" | grep -q statusCheckRollup; then
  echo '{"statusCheckRollup":[{"conclusion":"SUCCESS"}]}'
else
  echo '{"state":"MERGED","mergedAt":"2026-05-29T00:00:00Z"}'
fi
EOF
chmod +x "$stub/gh"

printf '\n=== C1: wrapper ship invocation triggers CI tracking ===\n'
set +e
PATH="$stub:$REPO_ROOT/bin:$PATH" bash -c '
  printf "{\"tool_input\":{\"command\":\"pipeline-run-task '"$RID"' '"$TID"' --stage ship\"},\"tool_response\":{\"stdout\":\"\"}}\n" \
    | "'"$REPO_ROOT"'/hooks/asyncrewake-ci.sh"' >/dev/null 2>&1
rc=$?
set -e
[[ "$rc" -eq 2 ]] && ok "C1: hook fired (exit 2) on wrapper command" \
  || fail "C1: hook did not fire on wrapper command (rc=$rc)"
ci=$(jq -r '.tasks.t1.ci_status // "unset"' "$DATA/runs/$RID/state.json")
[[ "$ci" == "green" ]] && ok "C1: ci_status written = green" \
  || fail "C1: ci_status=$ci"

printf '\n=== C1: wrapper resolves PR by task_id, not last reviewing task ===\n'
# Two tasks concurrently reviewing. Fire the wrapper for t1 (NOT the last in
# state order). The hook must resolve t1's PR from the command's task_id —
# a `last`-based fallback would wrongly pick t2.
RID2="run-parallel"
mkdir -p "$DATA/runs/$RID2"
jq -n '{run_id:"run-parallel",
        tasks:{"t1":{status:"reviewing", pr_number:1111},
               "t2":{status:"reviewing", pr_number:2222}}}' \
  > "$DATA/runs/$RID2/state.json"
rm -f "$DATA/runs/current"; ln -s "$DATA/runs/$RID2" "$DATA/runs/current"
set +e
PATH="$stub:$REPO_ROOT/bin:$PATH" bash -c '
  printf "{\"tool_input\":{\"command\":\"pipeline-run-task '"$RID2"' t1 --stage ship\"},\"tool_response\":{\"stdout\":\"\"}}\n" \
    | "'"$REPO_ROOT"'/hooks/asyncrewake-ci.sh"' >/dev/null 2>&1
rc=$?
set -e
ci1=$(jq -r '.tasks.t1.ci_status // "unset"' "$DATA/runs/$RID2/state.json")
ci2=$(jq -r '.tasks.t2.ci_status // "unset"' "$DATA/runs/$RID2/state.json")
[[ "$ci1" == "green" ]] && ok "C1: fired-for task t1 got ci_status=green" \
  || fail "C1: t1 ci_status=$ci1 (expected green)"
[[ "$ci2" == "unset" ]] && ok "C1: untargeted task t2 left untouched" \
  || fail "C1: t2 wrongly written ci_status=$ci2 (last-fallback bug)"

printf '\n=== C1: --stage shipping does NOT false-fire ===\n'
RID3="run-noship"
mkdir -p "$DATA/runs/$RID3"
jq -n '{run_id:"run-noship",
        tasks:{"t1":{status:"reviewing", pr_number:3333}}}' \
  > "$DATA/runs/$RID3/state.json"
rm -f "$DATA/runs/current"; ln -s "$DATA/runs/$RID3" "$DATA/runs/current"
set +e
PATH="$stub:$REPO_ROOT/bin:$PATH" bash -c '
  printf "{\"tool_input\":{\"command\":\"pipeline-run-task '"$RID3"' t1 --stage shipping\"},\"tool_response\":{\"stdout\":\"\"}}\n" \
    | "'"$REPO_ROOT"'/hooks/asyncrewake-ci.sh"' >/dev/null 2>&1
rc=$?
set -e
ci=$(jq -r '.tasks.t1.ci_status // "unset"' "$DATA/runs/$RID3/state.json")
[[ "$rc" -eq 0 && "$ci" == "unset" ]] && ok "C1: --stage shipping is a no-op (rc=$rc)" \
  || fail "C1: --stage shipping false-fired (rc=$rc ci=$ci)"

echo; echo "$pass passed, $fail_count failed"; [[ "$fail_count" -eq 0 ]]
