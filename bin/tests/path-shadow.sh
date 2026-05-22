#!/usr/bin/env bash
# path-shadow.sh — verifies that pipeline-run-task resolves sibling binaries
# from _SCRIPT_DIR, not from PATH, so a shadowing binary cannot intercept calls.
set -euo pipefail

BIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$BIN_DIR:$PATH"

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

echo "=== PATH shadow test ==="

# Setup: temp dirs
SHADOW_DIR=$(mktemp -d)
WORK_DIR=$(mktemp -d)
MARKER_SHADOW="$WORK_DIR/shadow_invoked"
REAL_STATE_FILE=""

cleanup() { rm -rf "$SHADOW_DIR" "$WORK_DIR"; }
trap cleanup EXIT

# Stub pipeline-state: creates a marker and exits 0 (no-op — never writes real state)
cat > "$SHADOW_DIR/pipeline-state" <<'STUB'
#!/usr/bin/env bash
touch "$SHADOW_MARKER"
exit 0
STUB
chmod +x "$SHADOW_DIR/pipeline-state"

# Inject stub BEFORE bin/ in PATH so it would shadow if pipeline-run-task
# does bare-name resolution via PATH rather than _SCRIPT_DIR.
export SHADOW_MARKER="$MARKER_SHADOW"
export CLAUDE_PLUGIN_DATA="$WORK_DIR/data"
mkdir -p "$CLAUDE_PLUGIN_DATA"

# Initialise a real run so state.json exists (pipeline-run-task needs it)
pipeline-init "shadow-test-run" --issue 99 --mode prd >/dev/null 2>&1

# Record real state file path
REAL_STATE_FILE="$CLAUDE_PLUGIN_DATA/runs/shadow-test-run/state.json"

# Inject the shadow dir BEFORE bin/ in PATH
export PATH="$SHADOW_DIR:$PATH"

# Run pipeline-run-task through the preflight stage; it must call pipeline-state
# internally. We don't care about the exit code — we only check which binary ran.
set +e
"$BIN_DIR/pipeline-run-task" "shadow-test-run" "task-001" \
  --stage preflight \
  --worktree "$WORK_DIR/wt" \
  >/dev/null 2>&1
set -e

# Assertion 1: shadow stub was NOT the binary that handled pipeline-state calls
# (if stub ran, the marker file would exist)
if [[ ! -f "$MARKER_SHADOW" ]]; then
  echo "  PASS: shadow stub was NOT invoked (real binary resolved via _SCRIPT_DIR)"
  pass=$((pass + 1))
else
  echo "  FAIL: shadow stub WAS invoked — _SCRIPT_DIR not prepended to PATH"
  fail=$((fail + 1))
fi

# Assertion 2: real state.json still exists and contains expected run_id field
# (only the real pipeline-state reads/writes it; stub exits 0 without touching it)
if [[ -f "$REAL_STATE_FILE" ]]; then
  run_id_val=$(jq -r '.run_id // empty' "$REAL_STATE_FILE" 2>/dev/null || true)
  assert_eq "state.json has correct run_id" "shadow-test-run" "$run_id_val"
else
  echo "  FAIL: state.json missing — real pipeline-state was not invoked"
  fail=$((fail + 1))
fi

echo ""
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
