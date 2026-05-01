#!/usr/bin/env bash
# Tests for atomic_write rc + _state_lock concurrency hardening (Task 3.8).
set -euo pipefail
cd "$(dirname "$0")/../.."
PLUGIN_ROOT="$(pwd)"
export PATH="$PLUGIN_ROOT/bin:$PATH"
export CLAUDE_PLUGIN_DATA="$(mktemp -d)"
trap 'chmod -R 755 "$CLAUDE_PLUGIN_DATA" 2>/dev/null || true; rm -rf "$CLAUDE_PLUGIN_DATA"' EXIT

# shellcheck disable=SC1091
source bin/pipeline-lib.sh

# Test atomic_write success
target="$CLAUDE_PLUGIN_DATA/test-atomic.txt"
if atomic_write "$target" "hello world"; then
  [[ "$(cat "$target")" == "hello world" ]] || { printf 'FAIL: content mismatch\n'; exit 1; }
  printf 'PASS: atomic_write basic write\n'
else
  printf 'FAIL: atomic_write returned non-zero on success\n'; exit 1
fi

# Test atomic_write failure on read-only target dir (mv would fail)
ro_dir="$CLAUDE_PLUGIN_DATA/readonly"
mkdir -p "$ro_dir"
chmod 555 "$ro_dir"
if atomic_write "$ro_dir/x.txt" "blocked" 2>/dev/null; then
  chmod 755 "$ro_dir"
  printf 'FAIL: atomic_write returned 0 despite read-only dir\n'; exit 1
fi
chmod 755 "$ro_dir"
printf 'PASS: atomic_write returns non-zero on mv failure\n'

# Concurrent locks (smoke test, both flock + mkdir paths exercised by env)
RUN_ID="lock-test"
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID"
cat > "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json" <<EOF
{"run_id":"$RUN_ID","status":"running","tasks":{},"updated_at":"x"}
EOF

# Fan out 30 writes; assert all succeeded
for i in $(seq 1 30); do
  ( pipeline-state write "$RUN_ID" ".counters.c$i" '"v"' >/dev/null ) &
done
wait
count=$(jq -r '.counters | length' "$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/state.json")
[[ "$count" == "30" ]] || { printf 'FAIL: lock concurrency: expected 30, got %s\n' "$count"; exit 1; }
printf 'PASS: 30 concurrent writes all retained under lock\n'

printf 'all state-locking tests passed\n'
