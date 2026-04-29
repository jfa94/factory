#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
PLUGIN_ROOT="$(pwd)"
export PATH="$PLUGIN_ROOT/bin:$PATH"
export CLAUDE_PLUGIN_DATA="$(mktemp -d)"
trap 'rm -rf "$CLAUDE_PLUGIN_DATA"' EXIT

# Seed a state file with one task
RUN_ID="ccr-test"
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID"
cat > "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json" <<EOF
{
  "run_id": "$RUN_ID",
  "status": "running",
  "tasks": { "t1": { "status": "running", "review_files": [] } },
  "updated_at": "2026-04-28T00:00:00Z"
}
EOF

# Fire N concurrent appends
for i in 1 2 3 4 5; do
  ( pipeline-state task-array-append "$RUN_ID" t1 review_files "\"file$i.json\"" >/dev/null ) &
done
wait

# All five should be present
result=$(jq -r '.tasks.t1.review_files | sort | join(",")' "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json")
expected="file1.json,file2.json,file3.json,file4.json,file5.json"
if [[ "$result" != "$expected" ]]; then
  printf 'FAIL: expected %s, got %s\n' "$expected" "$result" >&2
  exit 1
fi
printf 'PASS: 5 concurrent task-array-append calls retained all entries\n'

# Idempotency: repeated append of the same value should not duplicate
pipeline-state task-array-append "$RUN_ID" t1 review_files '"file1.json"' >/dev/null
count=$(jq -r '.tasks.t1.review_files | length' "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json")
if [[ "$count" != "5" ]]; then
  printf 'FAIL: expected 5 unique, got %s\n' "$count" >&2
  exit 1
fi
printf 'PASS: idempotent append (unique semantics)\n'

# Append to a previously-null field works (creates array). Use a known field
# (review_files is already populated, so seed a fresh task with null instead).
jq '.tasks.t2 = { "status": "running", "review_files": null }' \
  "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json" > "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json.tmp"
mv "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json.tmp" "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json"
pipeline-state task-array-append "$RUN_ID" t2 review_files '"a.log"' >/dev/null
created=$(jq -r '.tasks.t2.review_files | join(",")' "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json")
if [[ "$created" != "a.log" ]]; then
  printf 'FAIL: expected a.log, got %s\n' "$created" >&2
  exit 1
fi
printf 'PASS: append creates field if null\n'

printf 'all state-concurrent tests passed\n'
