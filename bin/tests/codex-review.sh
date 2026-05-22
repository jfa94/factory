#!/usr/bin/env bash
# codex-review.sh — bin/pipeline-codex-review unit tests.
# Stubs the `codex` CLI so we can inspect the generated prompt and argv
# without invoking the real model.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN_DIR="$REPO_ROOT/bin"
FIXTURES="$REPO_ROOT/bin/tests/fixtures/codex-review"
ROOT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/factory-codex-review.XXXXXX")"
STUB_DIR="$ROOT_TMP/stubs"
mkdir -p "$STUB_DIR"
trap 'rm -rf "$ROOT_TMP"' EXIT INT TERM

export PATH="$STUB_DIR:$BIN_DIR:$PATH"
# Isolate plugin data dir so temp_file mktemp calls do not collide with
# real plugin state or across test cases. Kept under ROOT_TMP so the trap
# cleans it up. Outside ~/.claude/plugins/data so the foreign-plugin
# canonicalization in pipeline-lib.sh does not rewrite it.
export CLAUDE_PLUGIN_DATA="$ROOT_TMP/plugin-data"
mkdir -p "$CLAUDE_PLUGIN_DATA/tmp"

passed=0
failed=0
current=""

pass() { passed=$((passed+1)); printf '  PASS [%s] %s\n' "$current" "$1"; }
fail() { failed=$((failed+1)); printf '  FAIL [%s] %s\n' "$current" "$1"; }
assert_eq() {
  local desc="$1" want="$2" got="$3"
  if [[ "$want" == "$got" ]]; then pass "$desc"
  else fail "$desc (want=$want got=$got)"; fi
}
assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$desc"
  else fail "$desc (missing: $needle)"; fi
}

# Stub codex CLI: emits a fake successful JSON to --output-last-message and
# copies its stdin (the prompt) + argv to inspection files for assertions.
write_codex_stub() {
  cat > "$STUB_DIR/codex" <<'STUB'
#!/usr/bin/env bash
# Record argv and stdin so the test can inspect them.
printf '%s\n' "$@" > "${CODEX_STUB_ARGV:-/dev/null}"
cat > "${CODEX_STUB_STDIN:-/dev/null}"
# Find --output-last-message <path>; write a minimal valid codex schema response.
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-last-message) out="$2"; shift 2 ;;
    --help) printf -- '--sandbox\n'; exit 0 ;;
    *) shift ;;
  esac
done
[[ -n "$out" ]] && cat > "$out" <<'JSON'
{"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9,"findings":[]}
JSON
exit 0
STUB
  chmod +x "$STUB_DIR/codex"
}

# Helper: build a minimal spec_dir with the chosen tasks.json + a trivial diff
# in a temp git repo so the wrapper's `git diff` produces non-empty output.
new_case() {
  current="$1"
  local schema="$2"   # array | object
  CASE_DIR="$ROOT_TMP/$current"
  SPEC_DIR="$CASE_DIR/spec"
  WT="$CASE_DIR/wt"
  mkdir -p "$SPEC_DIR" "$WT"
  cp "$FIXTURES/tasks-${schema}.json" "$SPEC_DIR/tasks.json"
  printf '# Spec narrative\n\nRLS belongs in a separate later migration.\n' \
    > "$SPEC_DIR/spec.md"
  ( cd "$WT" && git init -q && git config user.email t@t && git config user.name t \
    && git commit -q --allow-empty -m base && git checkout -q -b staging \
    && git checkout -q -b feature && echo a > a.ts && git add a.ts \
    && git commit -q -m work )
  export CODEX_STUB_ARGV="$CASE_DIR/argv.txt"
  export CODEX_STUB_STDIN="$CASE_DIR/prompt.txt"
}

write_codex_stub

# --- Case 1: bare-array schema → AC block appears ---
new_case ac-array array
pipeline-codex-review --task-id alpha-001 --spec-dir "$SPEC_DIR" --worktree "$WT" >/dev/null 2>&1 \
  || fail "ac-array: wrapper exited non-zero"
prompt=$(cat "$CODEX_STUB_STDIN" 2>/dev/null || printf '')
assert_contains "ac-array: prompt has AC header" "Authoritative acceptance criteria for alpha-001" "$prompt"
assert_contains "ac-array: prompt has AC1" "AC1: declares CREATE TABLE alpha" "$prompt"
assert_contains "ac-array: prompt has AC3 (RLS)" "AC3: enables RLS in this migration" "$prompt"

# --- Case 2: {tasks:[...]} schema → AC block also appears ---
new_case ac-object object
pipeline-codex-review --task-id alpha-001 --spec-dir "$SPEC_DIR" --worktree "$WT" >/dev/null 2>&1 \
  || fail "ac-object: wrapper exited non-zero"
prompt=$(cat "$CODEX_STUB_STDIN" 2>/dev/null || printf '')
assert_contains "ac-object: prompt has AC header" "Authoritative acceptance criteria for alpha-001" "$prompt"
assert_contains "ac-object: prompt has AC1" "AC1: declares CREATE TABLE alpha" "$prompt"

# --- Case 3: unknown task_id → no AC block, but wrapper still succeeds ---
new_case ac-unknown array
pipeline-codex-review --task-id ghost-999 --spec-dir "$SPEC_DIR" --worktree "$WT" >/dev/null 2>&1 \
  || fail "ac-unknown: wrapper exited non-zero"
prompt=$(cat "$CODEX_STUB_STDIN" 2>/dev/null || printf '')
# Look for the task-specific injected header (## Authoritative acceptance
# criteria for <task_id>), not the generic instruction line that mentions
# "Authoritative acceptance criteria list" in the prompt's static text.
if [[ "$prompt" == *"Authoritative acceptance criteria for ghost-999"* ]]; then
  fail "ac-unknown: AC block should be absent for unknown task_id"
else
  pass "ac-unknown: AC block absent for unknown task_id"
fi

# --- Case 4: FACTORY_CODEX_MODEL set → `-c model="..."` in argv ---
new_case model-env array
FACTORY_CODEX_MODEL=gpt-5-codex pipeline-codex-review \
  --task-id alpha-001 --spec-dir "$SPEC_DIR" --worktree "$WT" >/dev/null 2>&1 \
  || fail "model-env: wrapper exited non-zero"
argv=$(cat "$CODEX_STUB_ARGV" 2>/dev/null || printf '')
assert_contains "model-env: argv contains -c" "-c" "$argv"
assert_contains "model-env: argv contains model=\"gpt-5-codex\"" 'model="gpt-5-codex"' "$argv"

# --- Case 5: FACTORY_CODEX_MODEL unset → no `-c model=` injected ---
new_case model-unset array
unset FACTORY_CODEX_MODEL
pipeline-codex-review --task-id alpha-001 --spec-dir "$SPEC_DIR" --worktree "$WT" >/dev/null 2>&1 \
  || fail "model-unset: wrapper exited non-zero"
argv=$(cat "$CODEX_STUB_ARGV" 2>/dev/null || printf '')
if [[ "$argv" == *'model='* ]]; then
  fail "model-unset: argv should not contain model= (got: $argv)"
else
  pass "model-unset: argv omits model= override"
fi

# --- Case 6: malformed tasks.json → log_warn emitted, script still exits 0 ---
new_case ac-malformed-json array
# Overwrite tasks.json with invalid JSON to trigger a jq parse error
printf '{' > "$SPEC_DIR/tasks.json"
stderr_out=$(pipeline-codex-review --task-id alpha-001 --spec-dir "$SPEC_DIR" --worktree "$WT" 2>&1 >/dev/null)
exit_code=$?
assert_eq "ac-malformed-json: exits 0 on parse failure" "0" "$exit_code"
assert_contains "ac-malformed-json: stderr contains parse-failure warning" "tasks.json parse failed" "$stderr_out"

# --- Case 7: schema-conformance — codex emits valid schema → output is normalized JSON with verdict ---
new_case schema-conformance array
# Write a codex stub that emits a codex-schema-conformant response (not the pipeline schema)
cat > "$STUB_DIR/codex" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${CODEX_STUB_ARGV:-/dev/null}"
cat > "${CODEX_STUB_STDIN:-/dev/null}"
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-last-message) out="$2"; shift 2 ;;
    --help) printf -- '--sandbox\n'; exit 0 ;;
    *) shift ;;
  esac
done
[[ -n "$out" ]] && cat > "$out" <<'JSON'
{"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9,"findings":[]}
JSON
exit 0
STUB
chmod +x "$STUB_DIR/codex"
out_json=$(pipeline-codex-review --task-id alpha-001 --spec-dir "$SPEC_DIR" --worktree "$WT" 2>/dev/null)
exit_code=$?
assert_eq "schema-conformance: exits 0" "0" "$exit_code"
if jq -e . <<< "$out_json" >/dev/null 2>&1; then
  pass "schema-conformance: output is valid JSON"
else
  fail "schema-conformance: output is not valid JSON (got: $out_json)"
fi
verdict_field=$(jq -r '.verdict // empty' <<< "$out_json" 2>/dev/null || printf '')
if [[ -n "$verdict_field" ]]; then
  pass "schema-conformance: output contains verdict field"
else
  fail "schema-conformance: output missing verdict field (got: $out_json)"
fi

# --- Case 8: sandbox-cascade negative — codex --help lacks --sandbox → rc=1 with error ---
new_case sandbox-neg array
cat > "$STUB_DIR/codex" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${CODEX_STUB_ARGV:-/dev/null}"
cat > "${CODEX_STUB_STDIN:-/dev/null}"
# --help output deliberately omits --sandbox
case "$1" in
  --help) printf 'Usage: codex exec [options]\n'; exit 0 ;;
esac
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-last-message) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$out" ]] && printf '{"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9,"findings":[]}\n' > "$out"
exit 0
STUB
chmod +x "$STUB_DIR/codex"
stderr_sandbox=""
stderr_sandbox=$(pipeline-codex-review --task-id alpha-001 --spec-dir "$SPEC_DIR" --worktree "$WT" 2>&1 >/dev/null) && exit_code_sandbox=0 || exit_code_sandbox=$?
assert_eq "sandbox-neg: exits 1" "1" "$exit_code_sandbox"
assert_contains "sandbox-neg: stderr mentions --sandbox" "does not support --sandbox" "$stderr_sandbox"

# --- Case 9: invalid-JSON branch — codex writes non-JSON output → rc=1 with error ---
new_case invalid-json array
cat > "$STUB_DIR/codex" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${CODEX_STUB_ARGV:-/dev/null}"
cat > "${CODEX_STUB_STDIN:-/dev/null}"
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-last-message) out="$2"; shift 2 ;;
    --help) printf -- '--sandbox\n'; exit 0 ;;
    *) shift ;;
  esac
done
[[ -n "$out" ]] && printf 'not json\n' > "$out"
exit 0
STUB
chmod +x "$STUB_DIR/codex"
stderr_json=""
stderr_json=$(pipeline-codex-review --task-id alpha-001 --spec-dir "$SPEC_DIR" --worktree "$WT" 2>&1 >/dev/null) && exit_code_json=0 || exit_code_json=$?
assert_eq "invalid-json: exits 1" "1" "$exit_code_json"
assert_contains "invalid-json: stderr mentions not valid JSON" "not valid JSON" "$stderr_json"

# Restore default stub for any subsequent cases
write_codex_stub

printf '\n%d passed, %d failed\n' "$passed" "$failed"
exit $(( failed > 0 ? 1 : 0 ))
