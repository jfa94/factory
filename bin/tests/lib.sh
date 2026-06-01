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

# --- _factory_ensure_plugin_bin_path -------------------------------------

# Regression guard: v0.10.x hooks flooded logs with
# "pipeline-state: command not found" because the plugin bin/ was absent from
# the sanitized PATH that Claude Code uses when invoking hooks.
# _factory_ensure_plugin_bin_path must prepend ${CLAUDE_PLUGIN_ROOT}/bin so
# pipeline-* binaries become resolvable.

# 6. With CLAUDE_PLUGIN_ROOT set and plugin bin excluded from PATH,
#    calling the helper must make pipeline-state resolvable.
set +e
out=$(bash -c '
  set -euo pipefail
  BIN_DIR="'"$BIN_DIR"'"
  export CLAUDE_PLUGIN_ROOT="$(cd "$BIN_DIR/.." && pwd)"
  # Sanitized PATH: system paths only — no plugin bin.
  export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
  source "$BIN_DIR/pipeline-lib.sh"
  _factory_ensure_plugin_bin_path
  command -v pipeline-state
' 2>&1)
rc=$?
set -e
assert_eq "_factory_ensure_plugin_bin_path: rc=0" "0" "$rc"
assert_eq "_factory_ensure_plugin_bin_path: pipeline-state resolves" \
  "${BIN_DIR}/pipeline-state" "$out"

# --- record_gate_result ---------------------------------------------------
# record_gate_result: writes only when state.json exists; returns nonzero on
# write failure so the caller decides whether to exit.

# Save any CLAUDE_PLUGIN_DATA the sourced lib may have set.
_rg_old="${CLAUDE_PLUGIN_DATA:-}"
_rg_dir=$(mktemp -d); export CLAUDE_PLUGIN_DATA="$_rg_dir"

# 7. No state.json → no-op, returns 0.
mkdir -p "$_rg_dir/runs/r1"
set +e; record_gate_result r1 t1 quality_gate '{"ok":true}'; _rg_rc=$?; set -e
assert_eq "record_gate_result no-state → rc 0" "0" "$_rg_rc"

# 8. With state.json, a stubbed failing pipeline-state → rc 1.
printf '{"tasks":{"t1":{}}}' > "$_rg_dir/runs/r1/state.json"
_rg_stub=$(mktemp -d)
printf '#!/usr/bin/env bash\nexit 1\n' > "$_rg_stub/pipeline-state"
chmod +x "$_rg_stub/pipeline-state"
set +e; PATH="$_rg_stub:$PATH" record_gate_result r1 t1 quality_gate '{"ok":true}'; _rg_rc=$?; set -e
assert_eq "record_gate_result write-failure → rc 1" "1" "$_rg_rc"

rm -rf "$_rg_dir" "$_rg_stub"
# Restore CLAUDE_PLUGIN_DATA.
export CLAUDE_PLUGIN_DATA="$_rg_old"
unset _rg_old _rg_dir _rg_stub _rg_rc

# --- summary --------------------------------------------------------------

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
