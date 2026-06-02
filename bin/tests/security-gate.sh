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

# A passing security command whose findings JSON embeds a secret in extra.lines.
# The AKIA token is assembled at the stub's runtime so this test file carries no
# committable secret.
_mk_secret_cmd() {
  local d; d=$(mktemp -d)
  cat > "$d/semgrep" <<'CMD'
#!/usr/bin/env bash
key="AKIA""IOSFODNN7EXAMPLE"
printf '{"results":[{"check_id":"r","path":"a.ts","extra":{"lines":"const k = \"%s\""}}],"errors":[]}\n' "$key"
exit 0
CMD
  chmod +x "$d/semgrep"
  printf '%s' "$d"
}

# A passing command that emits NON-JSON stdout containing a secret.
_mk_secret_nonjson_cmd() {
  local d; d=$(mktemp -d)
  cat > "$d/semgrep" <<'CMD'
#!/usr/bin/env bash
key="AKIA""IOSFODNN7EXAMPLE"
printf 'scan error near %s\n' "$key"
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

# Case 13: securityAllowFailures=true → state summary records the
# informational path explicitly. exit 0 (case5 already covers this), AND
# security_gate.allow_failures=true, security_gate.ok=false. A regression
# that flipped allow_failures to false in the summary would let the
# downstream ship-checklist consumer mistakenly treat a failed scan as
# a hard pass.
case13() {
  local env cmd wt
  env=$(_mk_env "semgrep --config auto" "true")
  cmd=$(_mk_fail_cmd)
  wt=$(mktemp -d)
  # Use the real pipeline-state on PATH (no stub) so the summary actually
  # lands in state.json and we can read it back via task-read.
  set +e
  out=$(CLAUDE_PLUGIN_DATA="$env" PATH="$cmd:$PLUGIN_ROOT/bin:$PATH" "$GATE" run-001 task-001 "$wt" 2>/dev/null)
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case13: expected exit 0 (allowFailures), got $rc; out=$out"; fi
  # Inline JSON (stdout) carries the summary used by callers that don't
  # round-trip through state.
  printf '%s' "$out" | jq -e '.allow_failures == true' >/dev/null \
    || fail "case13: stdout summary.allow_failures expected true; got $out"
  printf '%s' "$out" | jq -e '.ok == false' >/dev/null \
    || fail "case13: stdout summary.ok expected false; got $out"
  # Round-trip via pipeline-state task-read — what downstream consumers see.
  local af ok status
  af=$(CLAUDE_PLUGIN_DATA="$env" PATH="$PLUGIN_ROOT/bin:$PATH" \
    pipeline-state task-read run-001 task-001 security_gate.allow_failures 2>/dev/null)
  ok=$(CLAUDE_PLUGIN_DATA="$env" PATH="$PLUGIN_ROOT/bin:$PATH" \
    pipeline-state task-read run-001 task-001 security_gate.ok 2>/dev/null)
  status=$(CLAUDE_PLUGIN_DATA="$env" PATH="$PLUGIN_ROOT/bin:$PATH" \
    pipeline-state task-read run-001 task-001 security_gate.status 2>/dev/null | tr -d '"')
  [[ "$af" == "true" ]]  || fail "case13: state security_gate.allow_failures=true expected; got '$af'"
  [[ "$ok" == "false" ]] || fail "case13: state security_gate.ok=false expected; got '$ok'"
  [[ "$status" == "failed" ]] || fail "case13: state security_gate.status=failed expected; got '$status'"
  rm -rf "$env" "$cmd" "$wt"
  pass "case13: allowFailures=true → exit 0, state records allow_failures=true + ok=false + status=failed"
}

# Case 14: a secret embedded in findings JSON is redacted at rest (default on).
case14() {
  local env stub cmd wt
  env=$(_mk_env "semgrep --config auto")   # securityRedactFindings defaults true
  cmd=$(_mk_secret_cmd)
  stub=$(_mk_stub_dir)
  wt=$(mktemp -d)
  set +e
  out=$(CLAUDE_PLUGIN_DATA="$env" PATH="$cmd:$stub:$PATH" "$GATE" run-001 task-001 "$wt" 2>/dev/null)
  rc=$?
  set -e
  [[ $rc -eq 0 ]] || fail "case14: expected exit 0, got $rc; out=$out"
  local findings="$env/runs/run-001/task-001.security-findings.json"
  [[ -f "$findings" ]] || fail "case14: findings file missing"
  jq -e '.' "$findings" >/dev/null || fail "case14: findings not valid JSON after redaction: $(cat "$findings")"
  # Match the key by pattern (no literal key in this test file).
  if grep -Eq 'AKIA[0-9A-Z]{16}' "$findings"; then fail "case14: raw AWS key leaked: $(cat "$findings")"; fi
  grep -q 'REDACTED' "$findings" || fail "case14: expected REDACTED marker; got $(cat "$findings")"
  rm -rf "$env" "$cmd" "$stub" "$wt"
  pass "case14: secret in findings JSON redacted at rest (default on)"
}

# Case 15: quality.securityRedactFindings=false preserves the raw findings.
case15() {
  local env stub cmd wt findings
  env=$(_mk_env "semgrep --config auto")
  jq '.quality.securityRedactFindings = false' "$env/config.json" > "$env/config.json.tmp" \
    && mv "$env/config.json.tmp" "$env/config.json"
  cmd=$(_mk_secret_cmd)
  stub=$(_mk_stub_dir)
  wt=$(mktemp -d)
  set +e
  CLAUDE_PLUGIN_DATA="$env" PATH="$cmd:$stub:$PATH" "$GATE" run-001 task-001 "$wt" >/dev/null 2>/dev/null
  rc=$?
  set -e
  [[ $rc -eq 0 ]] || fail "case15: expected exit 0, got $rc"
  findings="$env/runs/run-001/task-001.security-findings.json"
  grep -Eq 'AKIA[0-9A-Z]{16}' "$findings" || fail "case15: opt-out must preserve raw key; got $(cat "$findings")"
  rm -rf "$env" "$cmd" "$stub" "$wt"
  pass "case15: securityRedactFindings=false preserves raw findings (opt-out)"
}

# Case 16: non-JSON stdout is redacted BEFORE being wrapped as raw_output.
case16() {
  local env stub cmd wt findings
  env=$(_mk_env "semgrep --config auto")
  cmd=$(_mk_secret_nonjson_cmd)
  stub=$(_mk_stub_dir)
  wt=$(mktemp -d)
  set +e
  CLAUDE_PLUGIN_DATA="$env" PATH="$cmd:$stub:$PATH" "$GATE" run-001 task-001 "$wt" >/dev/null 2>/dev/null
  rc=$?
  set -e
  findings="$env/runs/run-001/task-001.security-findings.json"
  jq -e '.raw_output' "$findings" >/dev/null || fail "case16: expected raw_output envelope; got $(cat "$findings")"
  if grep -Eq 'AKIA[0-9A-Z]{16}' "$findings"; then fail "case16: raw key leaked in raw_output: $(cat "$findings")"; fi
  rm -rf "$env" "$cmd" "$stub" "$wt"
  pass "case16: non-JSON output redacted before raw_output wrap"
}

# Case 17: a malformed (non-boolean) flag value must still redact (fail-closed).
# Only an explicit `false` is a valid opt-out; null/garbage must not leak secrets.
case17() {
  local env stub cmd wt findings
  env=$(_mk_env "semgrep --config auto")
  jq '.quality.securityRedactFindings = null' "$env/config.json" > "$env/config.json.tmp" \
    && mv "$env/config.json.tmp" "$env/config.json"
  cmd=$(_mk_secret_cmd)
  stub=$(_mk_stub_dir)
  wt=$(mktemp -d)
  set +e
  CLAUDE_PLUGIN_DATA="$env" PATH="$cmd:$stub:$PATH" "$GATE" run-001 task-001 "$wt" >/dev/null 2>/dev/null
  rc=$?
  set -e
  [[ $rc -eq 0 ]] || fail "case17: expected exit 0, got $rc"
  findings="$env/runs/run-001/task-001.security-findings.json"
  if grep -Eq 'AKIA[0-9A-Z]{16}' "$findings"; then fail "case17: malformed flag must NOT disable redaction (fail-open leak): $(cat "$findings")"; fi
  grep -q 'REDACTED' "$findings" || fail "case17: expected REDACTED marker; got $(cat "$findings")"
  rm -rf "$env" "$cmd" "$stub" "$wt"
  pass "case17: malformed flag value still redacts (fail-closed)"
}

case1; case2; case3; case4; case5; case6; case7; case8; case9; case10; case11; case12; case13; case14; case15; case16; case17
printf 'all security-gate tests passed\n'
