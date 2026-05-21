#!/usr/bin/env bash
# lib.sh — pipeline-lib.sh helper regression tests.
#
# Currently covers json_emit. The helper has two distinct contracts:
#   - FACTORY_JSON=1: emit args or stream stdin to stdout
#   - FACTORY_JSON=0: no-op, but MUST drain any piped stdin to avoid SIGPIPE on
#     the upstream producer when pipefail is active (the canonical caller form
#     in every pipeline-* script is `jq -n '{...}' | json_emit`).
#
# Production strict-mode contract: set -euo pipefail (line 5 of pipeline-lib.sh).
# Each test below runs under the same flags so a regression that re-introduces
# the SIGPIPE bug fails here instead of silently exiting downstream callers.
set -euo pipefail

BIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$BIN_DIR/pipeline-lib.sh"

pass=0
fail=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"
    pass=$((pass + 1))
  else
    echo "  FAIL: $label (expected '$expected', got '$actual')"
    fail=$((fail + 1))
  fi
}

# --- json_emit ------------------------------------------------------------

# 1. Pipe form + FACTORY_JSON=0: must drain stdin, rc=0, no stdout.
#    Regression: pre-fix this exited 141 because json_emit returned without
#    draining; jq's next write SIGPIPE'd; pipefail propagated 141.
set +e
out=$(FACTORY_JSON=0 bash -c '
  set -euo pipefail
  source "'"$BIN_DIR"'/pipeline-lib.sh"
  printf "{\"a\":1}\n" | json_emit
')
rc=$?
set -e
assert_eq "pipe form, FACTORY_JSON=0: rc=0" "0" "$rc"
assert_eq "pipe form, FACTORY_JSON=0: no stdout" "" "$out"

# 2. Pipe form + FACTORY_JSON=1: must pass stdin through.
set +e
out=$(FACTORY_JSON=1 bash -c '
  set -euo pipefail
  source "'"$BIN_DIR"'/pipeline-lib.sh"
  printf "{\"a\":1}\n" | json_emit
')
rc=$?
set -e
assert_eq "pipe form, FACTORY_JSON=1: rc=0" "0" "$rc"
assert_eq "pipe form, FACTORY_JSON=1: passes stdin" '{"a":1}' "$out"

# 3. Direct-arg form + FACTORY_JSON=0: rc=0, no stdout (already worked; lock in).
set +e
out=$(FACTORY_JSON=0 bash -c '
  set -euo pipefail
  source "'"$BIN_DIR"'/pipeline-lib.sh"
  json_emit "{\"a\":1}"
')
rc=$?
set -e
assert_eq "direct-arg form, FACTORY_JSON=0: rc=0" "0" "$rc"
assert_eq "direct-arg form, FACTORY_JSON=0: no stdout" "" "$out"

# 4. Direct-arg form + FACTORY_JSON=1: emit the arg.
set +e
out=$(FACTORY_JSON=1 bash -c '
  set -euo pipefail
  source "'"$BIN_DIR"'/pipeline-lib.sh"
  json_emit "{\"a\":1}"
')
rc=$?
set -e
assert_eq "direct-arg form, FACTORY_JSON=1: rc=0" "0" "$rc"
assert_eq "direct-arg form, FACTORY_JSON=1: emits arg" '{"a":1}' "$out"

# 5. Real producer regression: jq | json_emit, FACTORY_JSON=0.
#    This is the exact pattern at pipeline-init:164, pipeline-validate:145,
#    pipeline-quota-check:66/235, pipeline-quota-gate-cli:71.
set +e
out=$(FACTORY_JSON=0 bash -c '
  set -euo pipefail
  source "'"$BIN_DIR"'/pipeline-lib.sh"
  jq -n "{a:1, b:2}" | json_emit
')
rc=$?
set -e
assert_eq "jq | json_emit, FACTORY_JSON=0: rc=0 (no SIGPIPE)" "0" "$rc"
assert_eq "jq | json_emit, FACTORY_JSON=0: no stdout" "" "$out"

# --- summary --------------------------------------------------------------

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
