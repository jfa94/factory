#!/usr/bin/env bash
# security-gate.sh — structural tests for bin/pipeline-security-gate.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GATE="$PLUGIN_ROOT/bin/pipeline-security-gate"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

# Create a minimal CLAUDE_PLUGIN_DATA dir with optional config.json and state.json.
# Usage: _mk_env [securityCommand] [securityAllowFailures]
_mk_env() {
  local dir; dir=$(mktemp -d)
  local cmd="${1:-}"
  local allow="${2:-}"
  local cfg='{}'
  if [[ -n "$cmd" ]]; then
    cfg=$(printf '%s' "$cfg" | jq --arg c "$cmd" '.quality.securityCommand = $c')
  fi
  if [[ -n "$allow" ]]; then
    cfg=$(printf '%s' "$cfg" | jq --argjson a "$allow" '.quality.securityAllowFailures = $a')
  fi
  printf '%s\n' "$cfg" > "$dir/config.json"
  mkdir -p "$dir/runs/run-001"
  printf '{"tasks":{"task-001":{}}}\n' > "$dir/runs/run-001/state.json"
  printf '%s' "$dir"
}

# Stub pipeline-state that always exits 0.
_mk_stub_dir() {
  local d; d=$(mktemp -d)
  cat > "$d/pipeline-state" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$d/pipeline-state"
  printf '%s' "$d"
}

# A stub security command that exits 0 and emits valid JSON findings.
# Named "semgrep" so it matches the runner allowlist.
_mk_pass_cmd() {
  local d; d=$(mktemp -d)
  cat > "$d/semgrep" <<'CMD'
#!/usr/bin/env bash
printf '{"results":[],"errors":[]}\n'
exit 0
CMD
  chmod +x "$d/semgrep"
  printf '%s' "$d"
}

# A stub security command that exits 1 and emits findings JSON.
_mk_fail_cmd() {
  local d; d=$(mktemp -d)
  cat > "$d/semgrep" <<'CMD'
#!/usr/bin/env bash
printf '{"results":[{"check_id":"test.rule","path":"src/x.ts","start":{"line":1},"extra":{"message":"test"}}],"errors":[]}\n'
exit 1
CMD
  chmod +x "$d/semgrep"
  printf '%s' "$d"
}

# A stub that exits 0 but emits non-JSON stdout.
_mk_nonjson_cmd() {
  local d; d=$(mktemp -d)
  cat > "$d/semgrep" <<'CMD'
#!/usr/bin/env bash
printf 'plain text output\n'
exit 0
CMD
  chmod +x "$d/semgrep"
  printf '%s' "$d"
}

# --- Test cases ---

# Case 1: no securityCommand configured → skip (exit 2).
case1() {
  local env stub wt
  env=$(_mk_env)
  stub=$(_mk_stub_dir)
  wt=$(mktemp -d)
  set +e
  out=$(CLAUDE_PLUGIN_DATA="$env" PATH="$stub:$PATH" "$GATE" run-001 task-001 "$wt" 2>/dev/null)
  rc=$?
  set -e
  if [[ $rc -ne 2 ]]; then fail "case1: expected exit 2 (skip), got $rc"; fi
  printf '%s' "$out" | jq -e '.skipped == true' >/dev/null \
    || fail "case1: expected skipped=true in JSON; got $out"
  rm -rf "$env" "$stub" "$wt"
  pass "case1: no securityCommand → skip exit 2"
}

# Case 2: worktree does not exist → exit 1 with error.
case2() {
  local env stub
  env=$(_mk_env "semgrep --config auto")
  stub=$(_mk_stub_dir)
  set +e
  out=$(CLAUDE_PLUGIN_DATA="$env" PATH="$stub:$PATH" "$GATE" run-001 task-001 /nonexistent-wt-$$  2>/dev/null)
  rc=$?
  set -e
  if [[ $rc -ne 1 ]]; then fail "case2: expected exit 1 (worktree missing), got $rc"; fi
  printf '%s' "$out" | jq -e '.error == "worktree_missing"' >/dev/null \
    || fail "case2: expected error=worktree_missing; got $out"
  rm -rf "$env" "$stub"
  pass "case2: missing worktree → exit 1 with error=worktree_missing"
}

# Case 3: command passes (exit 0) → gate passes.
case3() {
  local env stub cmd wt
  env=$(_mk_env "semgrep --config auto")
  cmd=$(_mk_pass_cmd)
  stub=$(_mk_stub_dir)
  wt=$(mktemp -d)
  set +e
  out=$(CLAUDE_PLUGIN_DATA="$env" PATH="$cmd:$stub:$PATH" "$GATE" run-001 task-001 "$wt" 2>/dev/null)
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case3: expected exit 0 (pass), got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.ok == true' >/dev/null \
    || fail "case3: expected ok=true; got $out"
  # findings file must be written
  local findings="$env/runs/run-001/task-001.security-findings.json"
  [[ -f "$findings" ]] || fail "case3: findings file not created at $findings"
  rm -rf "$env" "$cmd" "$stub" "$wt"
  pass "case3: passing command → exit 0, ok=true, findings file written"
}

# Case 4: command fails (exit 1) → gate fails.
case4() {
  local env stub cmd wt
  env=$(_mk_env "semgrep --config auto")
  cmd=$(_mk_fail_cmd)
  stub=$(_mk_stub_dir)
  wt=$(mktemp -d)
  set +e
  out=$(CLAUDE_PLUGIN_DATA="$env" PATH="$cmd:$stub:$PATH" "$GATE" run-001 task-001 "$wt" 2>/dev/null)
  rc=$?
  set -e
  if [[ $rc -ne 1 ]]; then fail "case4: expected exit 1 (fail), got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.ok == false' >/dev/null \
    || fail "case4: expected ok=false; got $out"
  rm -rf "$env" "$cmd" "$stub" "$wt"
  pass "case4: failing command → exit 1, ok=false"
}

# Case 5: securityAllowFailures=true → exit 0 even when command fails.
case5() {
  local env stub cmd wt
  env=$(_mk_env "semgrep --config auto" "true")
  cmd=$(_mk_fail_cmd)
  stub=$(_mk_stub_dir)
  wt=$(mktemp -d)
  set +e
  out=$(CLAUDE_PLUGIN_DATA="$env" PATH="$cmd:$stub:$PATH" "$GATE" run-001 task-001 "$wt" 2>/dev/null)
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case5: expected exit 0 (allowFailures), got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.ok == false' >/dev/null \
    || fail "case5: expected ok=false (still recorded failure) in JSON; got $out"
  rm -rf "$env" "$cmd" "$stub" "$wt"
  pass "case5: securityAllowFailures=true → exit 0 despite failure"
}

# Case 6: unsafe token in command → exit 1, reason=unsafe_command.
case6() {
  local env stub wt
  # Semicolon is rejected by the token allowlist.
  env=$(_mk_env "mock-semgrep;evil")
  stub=$(_mk_stub_dir)
  wt=$(mktemp -d)
  set +e
  out=$(CLAUDE_PLUGIN_DATA="$env" PATH="$stub:$PATH" "$GATE" run-001 task-001 "$wt" 2>/dev/null)
  rc=$?
  set -e
  if [[ $rc -ne 1 ]]; then fail "case6: expected exit 1 (unsafe_command), got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.reason == "unsafe_command"' >/dev/null \
    || fail "case6: expected reason=unsafe_command; got $out"
  rm -rf "$env" "$stub" "$wt"
  pass "case6: unsafe token → exit 1, reason=unsafe_command"
}

# Case 7: unallowed runner prefix → exit 1, reason=unallowed_runner.
case7() {
  local env stub wt
  env=$(_mk_env "bash -c whoami")
  stub=$(_mk_stub_dir)
  wt=$(mktemp -d)
  set +e
  out=$(CLAUDE_PLUGIN_DATA="$env" PATH="$stub:$PATH" "$GATE" run-001 task-001 "$wt" 2>/dev/null)
  rc=$?
  set -e
  if [[ $rc -ne 1 ]]; then fail "case7: expected exit 1 (unallowed_runner), got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.reason == "unallowed_runner"' >/dev/null \
    || fail "case7: expected reason=unallowed_runner; got $out"
  rm -rf "$env" "$stub" "$wt"
  pass "case7: unallowed runner → exit 1, reason=unallowed_runner"
}

# Case 8: non-JSON stdout → wrapped in JSON envelope.
case8() {
  local env stub cmd wt
  env=$(_mk_env "semgrep --config auto")
  cmd=$(_mk_nonjson_cmd)
  stub=$(_mk_stub_dir)
  wt=$(mktemp -d)
  set +e
  out=$(CLAUDE_PLUGIN_DATA="$env" PATH="$cmd:$stub:$PATH" "$GATE" run-001 task-001 "$wt" 2>/dev/null)
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case8: expected exit 0 (pass, non-json), got $rc; out=$out"; fi
  local findings="$env/runs/run-001/task-001.security-findings.json"
  [[ -f "$findings" ]] || fail "case8: findings file not created"
  # envelope must be valid JSON with raw_output key
  jq -e '.raw_output' "$findings" >/dev/null \
    || fail "case8: expected raw_output in findings envelope; got $(cat "$findings")"
  rm -rf "$env" "$cmd" "$stub" "$wt"
  pass "case8: non-JSON stdout → JSON envelope with raw_output"
}

# Case 9: state.json absent — gate still exits correctly and does not error.
case9() {
  local env stub cmd wt
  env=$(_mk_env "semgrep --config auto")
  # Remove state.json from the run dir so state write is skipped.
  rm -f "$env/runs/run-001/state.json"
  cmd=$(_mk_fail_cmd)
  stub=$(_mk_stub_dir)
  wt=$(mktemp -d)
  set +e
  out=$(CLAUDE_PLUGIN_DATA="$env" PATH="$cmd:$stub:$PATH" "$GATE" run-001 task-001 "$wt" 2>/dev/null)
  rc=$?
  set -e
  if [[ $rc -ne 1 ]]; then fail "case9: expected exit 1 (fail, no state.json), got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.ok == false' >/dev/null \
    || fail "case9: expected ok=false; got $out"
  rm -rf "$env" "$cmd" "$stub" "$wt"
  pass "case9: no state.json → gate still exits 1, no error"
}

# Case 10: state write failure on unsafe_command path is reported.
case10() {
  local env stub wt
  env=$(_mk_env "bash;evil")
  # stub pipeline-state that always fails
  stub=$(mktemp -d)
  cat > "$stub/pipeline-state" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
  chmod +x "$stub/pipeline-state"
  wt=$(mktemp -d)
  set +e
  CLAUDE_PLUGIN_DATA="$env" PATH="$stub:$PATH" "$GATE" run-001 task-001 "$wt" >/dev/null 2>/dev/null
  rc=$?
  set -e
  if [[ $rc -ne 1 ]]; then fail "case10: expected exit 1 (state write failure on error path), got $rc"; fi
  rm -rf "$env" "$stub" "$wt"
  pass "case10: state write failure on error path → still exits 1"
}

# Case 11: CLAUDE_PLUGIN_DATA unset → require_plugin_data must hard-fail (exit 1)
# and mention CLAUDE_PLUGIN_DATA in stderr. Validates RC-1 fix.
case11() {
  local stub wt
  stub=$(_mk_stub_dir)
  wt=$(mktemp -d)
  set +e
  err=$(env -u CLAUDE_PLUGIN_DATA PATH="$stub:$PATH" "$GATE" run-001 task-001 "$wt" 2>&1 >/dev/null)
  rc=$?
  set -e
  if [[ $rc -eq 0 || $rc -eq 2 ]]; then
    fail "case11: expected non-zero exit when CLAUDE_PLUGIN_DATA unset, got $rc"
  fi
  printf '%s' "$err" | grep -q 'CLAUDE_PLUGIN_DATA' \
    || fail "case11: expected CLAUDE_PLUGIN_DATA in stderr; got: $err"
  rm -rf "$stub" "$wt"
  pass "case11: CLAUDE_PLUGIN_DATA unset → hard exit, mentions CLAUDE_PLUGIN_DATA in stderr"
}

# Case 12: command exits 127 (binary not found) → gate must fail (exit 1), ok=false.
# Validates RI-1 fix: the gate must treat any non-zero/non-2 rc as failure.
case12() {
  local env stub wt
  env=$(_mk_env "semgrep --config auto")
  stub=$(_mk_stub_dir)
  # Stub semgrep to exit 127 (simulates command not found).
  cat > "$stub/semgrep" <<'CMD'
#!/usr/bin/env bash
exit 127
CMD
  chmod +x "$stub/semgrep"
  wt=$(mktemp -d)
  set +e
  out=$(CLAUDE_PLUGIN_DATA="$env" PATH="$stub:$PATH" "$GATE" run-001 task-001 "$wt" 2>/dev/null)
  rc=$?
  set -e
  if [[ $rc -ne 1 ]]; then fail "case12: expected exit 1 when binary exits 127, got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.ok == false' >/dev/null \
    || fail "case12: expected ok=false; got $out"
  rm -rf "$env" "$stub" "$wt"
  pass "case12: binary exits 127 → gate exit 1, ok=false"
}

case1; case2; case3; case4; case5; case6; case7; case8; case9; case10; case11; case12
printf 'all security-gate tests passed\n'
