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

echo; echo "$pass passed, $fail_count failed"; [[ "$fail_count" -eq 0 ]]
