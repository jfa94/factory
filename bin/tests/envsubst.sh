#!/usr/bin/env bash
# envsubst.sh — _envsubst_bash allowlist + temp_file plugin-data dir tests.
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

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  PASS: $label"
    pass=$((pass + 1))
  else
    echo "  FAIL: $label (expected to contain '$needle', got '$haystack')"
    fail=$((fail + 1))
  fi
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "  PASS: $label"
    pass=$((pass + 1))
  else
    echo "  FAIL: $label (expected NOT to contain '$needle', got '$haystack')"
    fail=$((fail + 1))
  fi
}

# ============================================================
echo "=== _envsubst_bash allowlist ==="

# Allowlisted vars substitute (${VAR} form)
out=$(run_id=abc task_id=t1 bash -c '
  source "'"$BIN_DIR"'/pipeline-lib.sh"
  printf "run=%s task=%s\n" "${run_id}" "${task_id}" | _envsubst_bash
' 2>/dev/null)
assert_contains "run_id \${VAR} substitutes" "abc" "$out"
assert_contains "task_id \${VAR} substitutes" "t1" "$out"

# Non-allowlisted var blocked (${VAR} form)
out=$(HOME=/sensitive bash -c '
  source "'"$BIN_DIR"'/pipeline-lib.sh"
  printf "leak=\${HOME}\n" | _envsubst_bash
' 2>/dev/null)
assert_contains "HOME \${VAR} blocked sentinel" "[BLOCKED:HOME]" "$out"
assert_not_contains "HOME \${VAR} value not leaked" "/sensitive" "$out"

# Non-allowlisted var blocked ($VAR form)
out=$(SECRET=evil bash -c '
  source "'"$BIN_DIR"'/pipeline-lib.sh"
  printf "x=\$SECRET y\n" | _envsubst_bash
' 2>/dev/null)
assert_contains "SECRET \$VAR blocked sentinel" "[BLOCKED:SECRET]" "$out"
assert_not_contains "SECRET \$VAR value not leaked" "evil" "$out"

# All 6 allowlisted vars work ($VAR and ${VAR} form)
out=$(stage=ship base_ref=staging bash -c '
  source "'"$BIN_DIR"'/pipeline-lib.sh"
  printf "\$stage/\${base_ref}\n" | _envsubst_bash
' 2>/dev/null)
assert_eq "stage and base_ref substitute" "ship/staging" "$out"

# spec_path and role are allowlisted
out=$(spec_path=/some/path role=executor bash -c '
  source "'"$BIN_DIR"'/pipeline-lib.sh"
  printf "\${spec_path} \${role}\n" | _envsubst_bash
' 2>/dev/null)
assert_contains "spec_path substitutes" "/some/path" "$out"
assert_contains "role substitutes" "executor" "$out"

# PATH blocked
out=$(bash -c '
  source "'"$BIN_DIR"'/pipeline-lib.sh"
  printf "p=\${PATH}\n" | _envsubst_bash
' 2>/dev/null)
assert_contains "PATH blocked sentinel" "[BLOCKED:PATH]" "$out"
assert_not_contains "PATH value not leaked" "/usr/bin" "$out"

# ============================================================
echo "=== temp_file plugin-data dir ==="

tmp_plugin_data=$(mktemp -d)
out=$(CLAUDE_PLUGIN_DATA="$tmp_plugin_data" bash -c '
  source "'"$BIN_DIR"'/pipeline-lib.sh"
  temp_file ".test"
')
assert_contains "temp_file path under plugin data" "$tmp_plugin_data/tmp/" "$out"
assert_contains "temp_file suffix" ".test" "$out"
[[ -f "$out" ]] && rm -f "$out"
rm -rf "$tmp_plugin_data"

# ============================================================
echo ""
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
