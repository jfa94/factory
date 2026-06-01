#!/usr/bin/env bash
# Hook script tests — covers plan 09 (run-tracker seq lock + chained hash,
# branch-protection rewrite, env-migrations Bash guard).
#
# task_09_01: parallel bumps don't collide
# task_09_02: hash chain links every entry and verify_chain detects tampering
# task_09_03: branch-protection inspects repo state, not command substrings
# task_09_04: covered by templates/settings.autonomous.json (see tests/config.sh)
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_TRACKER="$PLUGIN_ROOT/hooks/run-tracker.sh"
BRANCH_PROTECTION="$PLUGIN_ROOT/hooks/branch-protection.sh"

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

assert_exit_status() {
  local label="$1" expected="$2"; shift 2
  local actual=0
  set +e
  ( "$@" >/dev/null 2>&1 )
  actual=$?
  set -e
  assert_eq "$label" "$expected" "$actual"
}

# ===========================================================================
echo "=== task_09_01: run-tracker seq counter is serialized ==="

# Build a fake run dir so the hook will write to it.
TMPROOT=$(mktemp -d "${TMPDIR:-/tmp}/run-tracker-XXXXXX")
trap '[[ -n "${TMPROOT:-}" && ( "$TMPROOT" == /tmp/* || "$TMPROOT" == /var/folders/* ) ]] && rm -rf "$TMPROOT"' EXIT

export CLAUDE_PLUGIN_DATA="$TMPROOT/data"
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/run-tracker-01"
: > "$CLAUDE_PLUGIN_DATA/runs/run-tracker-01/audit.jsonl"
ln -s "$CLAUDE_PLUGIN_DATA/runs/run-tracker-01" "$CLAUDE_PLUGIN_DATA/runs/current"

# Sanity: 5 sequential invocations produce sequence numbers 1..5 in order.
for i in 1 2 3 4 5; do
  printf '{"tool_name":"Bash","tool_input":{"command":"echo seq-%d"}}' "$i" \
    | bash "$RUN_TRACKER"
done
serial_seqs=$(jq -r '.seq' "$CLAUDE_PLUGIN_DATA/runs/run-tracker-01/audit.jsonl" | tr '\n' ' ')
assert_eq "5 sequential bumps return 1 2 3 4 5" "1 2 3 4 5 " "$serial_seqs"

# Reset audit log for the parallel run.
: > "$CLAUDE_PLUGIN_DATA/runs/run-tracker-01/audit.jsonl"

# Parallel: launch 10 PostToolUse calls in the background and wait. With the
# pre-fix `wc -l + 1` race we'd see duplicates and gaps. With the mkdir mutex
# we get exactly 1..10 (in some order).
for i in 1 2 3 4 5 6 7 8 9 10; do
  ( printf '{"tool_name":"Bash","tool_input":{"command":"echo par-%d"}}' "$i" \
    | bash "$RUN_TRACKER" ) &
done
wait

parallel_total=$(wc -l < "$CLAUDE_PLUGIN_DATA/runs/run-tracker-01/audit.jsonl" | tr -d ' ')
assert_eq "parallel bumps wrote 10 entries" "10" "$parallel_total"

distinct_seqs=$(jq -r '.seq' "$CLAUDE_PLUGIN_DATA/runs/run-tracker-01/audit.jsonl" | sort -n | uniq | wc -l | tr -d ' ')
assert_eq "parallel bumps produced 10 distinct seq numbers" "10" "$distinct_seqs"

sorted_seqs=$(jq -r '.seq' "$CLAUDE_PLUGIN_DATA/runs/run-tracker-01/audit.jsonl" | sort -n | tr '\n' ' ')
assert_eq "parallel seqs cover 1..10 with no gaps" "1 2 3 4 5 6 7 8 9 10 " "$sorted_seqs"

# Mutex must always be released — no leftover lock dir after a clean run.
if [[ -d "$CLAUDE_PLUGIN_DATA/runs/run-tracker-01/.run-tracker.lock" ]]; then
  echo "  FAIL: mutex lock dir leaked after run"
  fail=$((fail + 1))
else
  echo "  PASS: mutex lock dir cleaned up after run"
  pass=$((pass + 1))
fi

# ===========================================================================
echo ""
echo "=== F1: run-tracker writes lock_timeout sentinel on contention ==="

# Set up a fresh run dir so we don't pollute run-tracker-01's chain.
mkdir -p "$CLAUDE_PLUGIN_DATA/runs/run-tracker-lock-timeout"
: > "$CLAUDE_PLUGIN_DATA/runs/run-tracker-lock-timeout/audit.jsonl"
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
ln -s "$CLAUDE_PLUGIN_DATA/runs/run-tracker-lock-timeout" "$CLAUDE_PLUGIN_DATA/runs/current"

# Hold the lock so the hook cannot acquire it.
mkdir "$CLAUDE_PLUGIN_DATA/runs/run-tracker-lock-timeout/.run-tracker.lock"

# Invoke the hook with tight retry knobs so the contention path returns fast.
RUN_TRACKER_MAX_ATTEMPTS=3 RUN_TRACKER_LOCK_SLEEP_S=0.01 \
  printf '{"tool_name":"Bash","tool_input":{"command":"contended"}}' \
  | bash "$RUN_TRACKER" >/dev/null 2>&1 || true

sentinel_count=$(jq -r 'select(.event == "lock_timeout") | .event' \
  "$CLAUDE_PLUGIN_DATA/runs/run-tracker-lock-timeout/audit.jsonl" 2>/dev/null \
  | wc -l | tr -d ' ')
assert_eq "lock_timeout sentinel appears in audit.jsonl on contention" "1" "$sentinel_count"

# Release the held lock and restore runs/current so subsequent tests
# (task_09_02 verifies run-tracker-01's chain) see the original fixture.
rmdir "$CLAUDE_PLUGIN_DATA/runs/run-tracker-lock-timeout/.run-tracker.lock" 2>/dev/null || true
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
ln -s "$CLAUDE_PLUGIN_DATA/runs/run-tracker-01" "$CLAUDE_PLUGIN_DATA/runs/current"

# ===========================================================================
echo ""
echo "=== F1b: verify_chain skips lock_timeout sentinels ==="

# Regression for code-quality review of commit 6b6d374: the lock_timeout
# sentinel row appended on contention has no chain fields, so the previous
# verify_chain treated it as a corrupted entry (missing_chain_field) and the
# next legitimate entry's prev_hash linkage broke. Both code paths must now
# filter sentinel rows.
ver_dir="$CLAUDE_PLUGIN_DATA/runs/run-tracker-verify-skip"
mkdir -p "$ver_dir"
: > "$ver_dir/audit.jsonl"
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
ln -s "$ver_dir" "$CLAUDE_PLUGIN_DATA/runs/current"

# Write 2 chain entries via the hook.
for i in 1 2; do
  printf '{"tool_name":"Bash","tool_input":{"command":"e%d"}}' "$i" \
    | bash "$RUN_TRACKER"
done
# Append a sentinel (simulating an in-the-wild lock_timeout).
jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg rid "run-tracker-verify-skip" \
  '{event:"lock_timeout", timestamp:$ts, run_id:$rid, attempts:200, hook:"run-tracker"}' \
  >> "$ver_dir/audit.jsonl"
# Write 1 more chain entry via the hook — must chain off the last legitimate
# entry, not the sentinel.
printf '{"tool_name":"Bash","tool_input":{"command":"e3"}}' \
  | bash "$RUN_TRACKER"

# Verify the chain.
set +e
out=$(bash "$RUN_TRACKER" --verify "$ver_dir/audit.jsonl")
rc=$?
set -e
assert_eq "verify_chain returns 0 after sentinel" "0" "$rc"
status=$(printf '%s' "$out" | jq -r '.status')
assert_eq "verify_chain status=valid after sentinel" "valid" "$status"
sentinels=$(printf '%s' "$out" | jq -r '.sentinels // 0')
assert_eq "verify_chain reports 1 sentinel" "1" "$sentinels"

# Sanity: tampering one of the chain entries should still be detected.
# Mutate a chain-validated field (.hash) — verify_chain checks prev_hash and
# .hash, not params_hash, so tampering params_hash alone wouldn't surface.
# Target only the first occurrence so we break the linkage on entry 2.
awk 'BEGIN{done=0} !done && /"hash":"[a-f0-9]/ {sub(/"hash":"[a-f0-9]+"/, "\"hash\":\"TAMPERED\""); done=1} 1' \
  "$ver_dir/audit.jsonl" > "$ver_dir/audit.jsonl.tmp"
mv "$ver_dir/audit.jsonl.tmp" "$ver_dir/audit.jsonl"
set +e
out_t=$(bash "$RUN_TRACKER" --verify "$ver_dir/audit.jsonl" 2>&1)
rc_t=$?
set -e
assert_eq "verify_chain detects tampering even with sentinel present" "1" "$rc_t"
status_t=$(printf '%s' "$out_t" | jq -r '.status' 2>/dev/null)
assert_eq "tampered chain status=broken" "broken" "$status_t"

# Restore runs/current for following tests.
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
ln -s "$CLAUDE_PLUGIN_DATA/runs/run-tracker-01" "$CLAUDE_PLUGIN_DATA/runs/current"

# ===========================================================================
echo ""
echo "=== task_09_02: prev_hash chain links every entry ==="

# Verify the parallel-write log forms a valid chain.
verify_out=$(bash "$RUN_TRACKER" --verify "$CLAUDE_PLUGIN_DATA/runs/run-tracker-01")
verify_status=$(printf '%s' "$verify_out" | jq -r '.status')
assert_eq "verify_chain reports valid for clean log" "valid" "$verify_status"

verify_count=$(printf '%s' "$verify_out" | jq -r '.entries')
assert_eq "verify_chain counted 10 entries" "10" "$verify_count"

# First entry must descend from GENESIS.
first_prev=$(jq -r 'select(.seq == 1) | .prev_hash' "$CLAUDE_PLUGIN_DATA/runs/run-tracker-01/audit.jsonl")
assert_eq "first chain entry has prev_hash=GENESIS" "GENESIS" "$first_prev"

# Each entry's prev_hash must equal the prior entry's hash, when ordered by seq.
# Re-index by .seq because parallel writes can land in any physical order.
chain_ok=true
prev="GENESIS"
while IFS= read -r row; do
  entry_prev=$(printf '%s' "$row" | jq -r '.prev_hash')
  entry_hash=$(printf '%s' "$row" | jq -r '.hash')
  if [[ "$entry_prev" != "$prev" ]]; then
    chain_ok=false
    break
  fi
  prev="$entry_hash"
done < <(
  while IFS= read -r line; do
    seq=$(printf '%s' "$line" | jq -r '.seq')
    printf '%s\t%s\n' "$seq" "$line"
  done < "$CLAUDE_PLUGIN_DATA/runs/run-tracker-01/audit.jsonl" | sort -n | cut -f2-
)
assert_eq "chain links every entry (prev_hash == prior .hash, ordered by seq)" "true" "$chain_ok"

# Tamper detection: rewrite a middle entry's hash to break the chain.
TAMPERED="$TMPROOT/tampered.jsonl"
cp "$CLAUDE_PLUGIN_DATA/runs/run-tracker-01/audit.jsonl" "$TAMPERED"
# Sort by seq, then mutate the middle line's hash so the next line's prev_hash
# no longer matches.
sorted_tampered="$TMPROOT/tampered.sorted.jsonl"
while IFS= read -r line; do
  seq=$(printf '%s' "$line" | jq -r '.seq')
  printf '%s\t%s\n' "$seq" "$line"
done < "$TAMPERED" | sort -n | cut -f2- > "$sorted_tampered"

awk 'NR==5 {sub(/"hash":"[^"]*"/, "\"hash\":\"deadbeef\"")} 1' "$sorted_tampered" > "$TAMPERED"
verify_tampered=$(bash "$RUN_TRACKER" --verify "$TAMPERED" || true)
tampered_status=$(printf '%s' "$verify_tampered" | jq -r '.status')
assert_eq "verify_chain reports broken for tampered log" "broken" "$tampered_status"

# Tamper detection: drop a middle entry entirely (re-ordering / deletion).
DROPPED="$TMPROOT/dropped.jsonl"
awk 'NR != 5' "$sorted_tampered" > "$DROPPED"
# Re-sort by seq just in case awk processed an unsorted file.
verify_dropped=$(bash "$RUN_TRACKER" --verify "$DROPPED" || true)
dropped_status=$(printf '%s' "$verify_dropped" | jq -r '.status')
assert_eq "verify_chain reports broken when an entry is dropped" "broken" "$dropped_status"

unset CLAUDE_PLUGIN_DATA

# ===========================================================================
echo ""
echo "=== task_09_03: branch-protection inspects repo state ==="

# Build a tiny repo so symbolic-ref returns a known branch.
REPO_FEATURE="$TMPROOT/repo-feature"
mkdir -p "$REPO_FEATURE"
git -C "$REPO_FEATURE" init -q -b feature-x
git -C "$REPO_FEATURE" -c user.email=t@test -c user.name=t commit -q --allow-empty -m "init"

# Helper: invoke the hook from a given cwd with a synthetic Bash command.
_call_protect() {
  local cwd="$1" cmd="$2"
  ( cd "$cwd" && printf '{"tool_input":{"command":%s}}' "$(jq -Rn --arg s "$cmd" '$s')" \
    | bash "$BRANCH_PROTECTION" >/dev/null 2>&1 )
  echo $?
}

# 1. Push to a feature branch from a feature branch → exit 0
status=$(_call_protect "$REPO_FEATURE" "git push origin feature-x")
assert_eq "push origin feature-x from feature branch → allow" "0" "$status"

# 2. Push to main → exit 2
status=$(_call_protect "$REPO_FEATURE" "git push origin main")
assert_eq "push origin main → block" "2" "$status"

# 3. Push HEAD:main (colon refspec) → exit 2
status=$(_call_protect "$REPO_FEATURE" "git push origin HEAD:main")
assert_eq "push origin HEAD:main → block" "2" "$status"

# 4. Force-push +master via refspec → exit 2
status=$(_call_protect "$REPO_FEATURE" "git push origin +master")
assert_eq "push origin +master (force refspec) → block" "2" "$status"

# 5. From `main`, explicit push to a non-protected branch is allowed.
#    Commit 3e8b0cb narrowed Check 1 so it only blocks when the destination is
#    implicit (empty) or equals the current protected branch. Publishing
#    `some-feature` from a main checkout doesn't modify main, so it's safe.
REPO_MAIN="$TMPROOT/repo-main"
mkdir -p "$REPO_MAIN"
git -C "$REPO_MAIN" init -q -b main
git -C "$REPO_MAIN" -c user.email=t@test -c user.name=t commit -q --allow-empty -m "init"
status=$(_call_protect "$REPO_MAIN" "git push origin some-feature")
assert_eq "on main, explicit push to non-protected branch → allow" "0" "$status"

# 6. Decoy: branch named `mainly-fixes` must not match `main`.
status=$(_call_protect "$REPO_FEATURE" "git push origin mainly-fixes")
assert_eq "decoy branch 'mainly-fixes' → allow" "0" "$status"

# 7. Non-push command containing the literal "main" must allow.
status=$(_call_protect "$REPO_FEATURE" "git commit -am main")
assert_eq "git commit -am main (literal in message) → allow" "0" "$status"

# 8. --force-with-lease to a protected branch → block.
status=$(_call_protect "$REPO_FEATURE" "git push --force-with-lease origin main")
assert_eq "force-with-lease to main → block" "2" "$status"

# 9. git push with no args from a feature branch → allow (resolves to current).
status=$(_call_protect "$REPO_FEATURE" "git push")
assert_eq "git push (no args) from feature branch → allow" "0" "$status"

# 10. git push with no args from main → block (current branch is protected).
status=$(_call_protect "$REPO_MAIN" "git push")
assert_eq "git push (no args) from main → block" "2" "$status"

# 11. git push origin --delete main → block.
status=$(_call_protect "$REPO_FEATURE" "git push origin --delete main")
assert_eq "git push origin --delete main → block" "2" "$status"

# 12. git reset --hard origin/develop on a disposable branch → allow.
#     Check 6 now gates on the CURRENT branch (feature-x, not protected); the
#     target ref is irrelevant — resetting a disposable branch is harmless.
status=$(_call_protect "$REPO_FEATURE" "git reset --hard origin/develop")
assert_eq "git reset --hard origin/develop on disposable branch → allow" "0" "$status"

# 13. git branch -D master → block.
status=$(_call_protect "$REPO_FEATURE" "git branch -D master")
assert_eq "git branch -D master → block" "2" "$status"

# 14. git branch -D some-feature → allow.
status=$(_call_protect "$REPO_FEATURE" "git branch -D some-feature")
assert_eq "git branch -D some-feature → allow" "0" "$status"

# 15. Empty / non-Bash input is allowed (no command field).
status=$( ( printf '{}' | bash "$BRANCH_PROTECTION" >/dev/null 2>&1 ); echo $? )
assert_eq "empty hook input → allow" "0" "$status"

# --- Check 6 (current-branch gating) regression matrix ---

# 16. git reset --hard HEAD~3 on a disposable branch → allow.
status=$(_call_protect "$REPO_FEATURE" "git reset --hard HEAD~3")
assert_eq "reset --hard HEAD~3 on disposable branch → allow" "0" "$status"

# 17. git reset --hard HEAD~3 while on main (protected) → block.
status=$(_call_protect "$REPO_MAIN" "git reset --hard HEAD~3")
assert_eq "reset --hard HEAD~3 on protected branch → block" "2" "$status"

# 18. git reset --hard origin/staging while on main → block (current protected,
#     target irrelevant).
status=$(_call_protect "$REPO_MAIN" "git reset --hard origin/staging")
assert_eq "reset --hard origin/staging on protected branch → block" "2" "$status"

# 19. Bare `git reset --hard` (no ref) on main → block.
status=$(_call_protect "$REPO_MAIN" "git reset --hard")
assert_eq "bare reset --hard on protected branch → block" "2" "$status"

# 20. Bare `git reset --hard` on a disposable branch → allow.
status=$(_call_protect "$REPO_FEATURE" "git reset --hard")
assert_eq "bare reset --hard on disposable branch → allow" "0" "$status"

# 21. git reset HEAD somefile (mixed, default) on disposable → allow.
status=$(_call_protect "$REPO_FEATURE" "git reset HEAD somefile")
assert_eq "mixed reset on disposable branch → allow" "0" "$status"

# 22. git reset --soft HEAD~1 on main → allow (only --hard is blocked).
status=$(_call_protect "$REPO_MAIN" "git reset --soft HEAD~1")
assert_eq "soft reset on protected branch → allow" "0" "$status"

# 23. Detached HEAD: reset --hard <sha> → allow (no current branch ref).
REPO_DETACHED="$TMPROOT/repo-detached"
mkdir -p "$REPO_DETACHED"
git -C "$REPO_DETACHED" init -q -b main
git -C "$REPO_DETACHED" -c user.email=t@test -c user.name=t commit -q --allow-empty -m "c1"
DETACHED_SHA=$(git -C "$REPO_DETACHED" rev-parse HEAD)
git -C "$REPO_DETACHED" -c user.email=t@test -c user.name=t commit -q --allow-empty -m "c2"
git -C "$REPO_DETACHED" checkout -q "$DETACHED_SHA"
status=$(_call_protect "$REPO_DETACHED" "git reset --hard $DETACHED_SHA")
assert_eq "reset --hard on detached HEAD → allow" "0" "$status"

# 24. Orchestrator exception: autonomous mode + orchestrator worktree on staging
#     → allow even though staging is protected (pipeline manages it).
ORCH_DIR="$TMPROOT/proj/.claude/worktrees/orchestrator-test"
mkdir -p "$ORCH_DIR"
git -C "$ORCH_DIR" init -q -b staging
git -C "$ORCH_DIR" -c user.email=t@test -c user.name=t commit -q --allow-empty -m "init"
status=$( cd "$ORCH_DIR" && printf '{"tool_input":{"command":"git reset --hard origin/staging"}}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$BRANCH_PROTECTION" >/dev/null 2>&1; echo $? )
assert_eq "orchestrator worktree + autonomous on staging → allow" "0" "$status"

# 25. Same orchestrator dir WITHOUT autonomous mode → block (staging protected).
status=$( cd "$ORCH_DIR" && printf '{"tool_input":{"command":"git reset --hard origin/staging"}}' \
  | bash "$BRANCH_PROTECTION" >/dev/null 2>&1; echo $? )
assert_eq "orchestrator worktree without autonomous on staging → block" "2" "$status"

# --- Check 6: --git-dir must resolve the correct repo's current branch ---
# A `--git-dir=<protected>/.git reset --hard` invoked from an unrelated,
# non-protected cwd must still gate on the TARGET repo's current branch.
GITDIR_PROTECTED="$TMPROOT/gitdir-protected"
mkdir -p "$GITDIR_PROTECTED"
git -C "$GITDIR_PROTECTED" init -q -b main
git -C "$GITDIR_PROTECTED" -c user.email=t@test -c user.name=t commit -q --allow-empty -m "init"

# 26. equals form: --git-dir=<protected>/.git reset --hard (bare) → block.
status=$(_call_protect "$REPO_FEATURE" "git --git-dir=$GITDIR_PROTECTED/.git reset --hard")
assert_eq "--git-dir=<protected> reset --hard (equals form) → block" "2" "$status"

# 27. space form: --git-dir <protected>/.git reset --hard (bare) → block.
status=$(_call_protect "$REPO_FEATURE" "git --git-dir $GITDIR_PROTECTED/.git reset --hard")
assert_eq "--git-dir <protected> reset --hard (space form) → block" "2" "$status"

# 28. Sanity guard: --git-dir pointing at a NON-protected repo (feature-x) → allow.
status=$(_call_protect "$REPO_MAIN" "git --git-dir=$REPO_FEATURE/.git reset --hard")
assert_eq "--git-dir=<feature> reset --hard → allow" "0" "$status"

# 29. Minor-3 coverage: orchestrator worktree + autonomous, but on a protected
#     branch NOT in PIPELINE_MANAGED (main, not staging) → still block.
ORCH_MAIN_DIR="$TMPROOT/proj-main/.claude/worktrees/orchestrator-main"
mkdir -p "$ORCH_MAIN_DIR"
git -C "$ORCH_MAIN_DIR" init -q -b main
git -C "$ORCH_MAIN_DIR" -c user.email=t@test -c user.name=t commit -q --allow-empty -m "init"
status=$( cd "$ORCH_MAIN_DIR" && printf '{"tool_input":{"command":"git reset --hard"}}' \
  | FACTORY_AUTONOMOUS_MODE=1 bash "$BRANCH_PROTECTION" >/dev/null 2>&1; echo $? )
assert_eq "orchestrator worktree + autonomous on non-managed protected (main) → block" "2" "$status"

# ===========================================================================
echo ""
echo "=== task_16_01: write-protection hook ==="

WP="$PLUGIN_ROOT/hooks/write-protection.sh"
export CLAUDE_PLUGIN_DATA="$TMPROOT/wp-data"
mkdir -p "$CLAUDE_PLUGIN_DATA"

_write_config() { printf '%s' "$1" > "$CLAUDE_PLUGIN_DATA/config.json"; }

# 1. No config.json → exit 0 (fast path, opt-in only)
rm -f "$CLAUDE_PLUGIN_DATA/config.json"
status=$( ( printf '{"tool_name":"Write","tool_input":{"file_path":"/tmp/x.env"}}' | bash "$WP" >/dev/null 2>&1 ); echo $? )
assert_eq "write-protection: no config.json → allow" "0" "$status"

# 2. Empty blocklist → allow
_write_config '{"safety.writeBlockedPaths":[]}'
status=$( ( printf '{"tool_name":"Write","tool_input":{"file_path":"/tmp/x.env"}}' | bash "$WP" >/dev/null 2>&1 ); echo $? )
assert_eq "write-protection: empty blocklist → allow" "0" "$status"

# 3. .env* blocks an Edit on .env.local
WP_SANDBOX=$(mktemp -d "${TMPDIR:-/tmp}/wp-sandbox-XXXXXX")
_write_config '{"safety.writeBlockedPaths":[".env*"]}'
set +e
wp_block_output=$(printf '{"tool_name":"Edit","tool_input":{"file_path":"%s/.env.local"}}' "$WP_SANDBOX" | bash "$WP" 2>&1 >/dev/null)
wp_ec=$?
set -e
assert_eq "write-protection: .env* blocks Edit on .env.local" "2" "$wp_ec"
assert_eq "write-protection: block JSON reason is write_blocked" "write_blocked" \
  "$(printf '%s' "$wp_block_output" | jq -r '.reason' 2>/dev/null)"

# 4. Same config, unrelated path → allowed
status=$( ( printf '{"tool_name":"Edit","tool_input":{"file_path":"%s/src/config.ts"}}' "$WP_SANDBOX" | bash "$WP" >/dev/null 2>&1 ); echo $? )
assert_eq "write-protection: .env* allows src/config.ts" "0" "$status"

# 5. **/migrations/** blocks a nested SQL migration
_write_config '{"safety.writeBlockedPaths":["**/migrations/**"]}'
mkdir -p "$WP_SANDBOX/supabase/migrations"
status=$( ( printf '{"tool_name":"Write","tool_input":{"file_path":"%s/supabase/migrations/001_init.sql"}}' "$WP_SANDBOX" | bash "$WP" >/dev/null 2>&1 ); echo $? )
assert_eq "write-protection: **/migrations/** blocks nested SQL" "2" "$status"

# 6. MultiEdit with nested edits[].file_path under the blocked glob
status=$( ( printf '{"tool_name":"MultiEdit","tool_input":{"edits":[{"file_path":"%s/supabase/migrations/002.sql"}]}}' "$WP_SANDBOX" | bash "$WP" >/dev/null 2>&1 ); echo $? )
assert_eq "write-protection: MultiEdit edits[] blocked" "2" "$status"

# 7. Non-write tool (Bash) passes through
status=$( ( printf '{"tool_name":"Bash","tool_input":{"command":"ls .env"}}' | bash "$WP" >/dev/null 2>&1 ); echo $? )
assert_eq "write-protection: Bash tool passes through" "0" "$status"

# 8. Basename glob matches regardless of directory depth
_write_config '{"safety.writeBlockedPaths":["credentials.json"]}'
mkdir -p "$WP_SANDBOX/app"
status=$( ( printf '{"tool_name":"Write","tool_input":{"file_path":"%s/app/credentials.json"}}' "$WP_SANDBOX" | bash "$WP" >/dev/null 2>&1 ); echo $? )
assert_eq "write-protection: basename glob matches nested file" "2" "$status"

rm -rf "$WP_SANDBOX"
unset CLAUDE_PLUGIN_DATA

# ===========================================================================
echo ""
echo "=== task_16_02: secret-commit-guard hook ==="

SCG="$PLUGIN_ROOT/hooks/secret-commit-guard.sh"
export CLAUDE_PLUGIN_DATA="$TMPROOT/scg-data"
mkdir -p "$CLAUDE_PLUGIN_DATA"
_scg_write_config() { printf '%s' "$1" > "$CLAUDE_PLUGIN_DATA/config.json"; }

_scg_sandbox() {
  local d
  d=$(mktemp -d "${TMPDIR:-/tmp}/scg-XXXXXX")
  git -C "$d" init -q
  git -C "$d" config user.email "t@t"
  git -C "$d" config user.name "t"
  printf '%s' "$d"
}

_scg_exit() {
  # $1 = cwd, $2 = command; emit the hook's exit code only.
  local cwd="$1" cmd="$2"
  ( cd "$cwd" && printf '{"tool_input":{"command":%s}}' "$(jq -Rn --arg s "$cmd" '$s')" \
    | bash "$SCG" >/dev/null 2>&1 ); echo $?
}

# 1. Non-commit command → allow (fast path)
S1=$(_scg_sandbox)
assert_eq "scg: non-commit command → allow" "0" "$(_scg_exit "$S1" "ls -la")"

# 2. git push on an unborn HEAD (no commits) → nothing to scan → allow.
#    B3 regression guard: the git-log fail-closed branch must NOT fire here —
#    an unborn HEAD is benign, not a git malfunction.
assert_eq "scg: push on unborn HEAD → allow" "0" "$(_scg_exit "$S1" "git push origin main")"

# 2b. First push of a repo whose HEAD commit holds a secret → block.
S1b=$(_scg_sandbox)
printf 'const aws_key = "AKIAIOSFODNN7EXAMPLE";\n' > "$S1b/leak.ts"
git -C "$S1b" add leak.ts
git -C "$S1b" commit -qm seed
assert_eq "scg: push with committed secret → block" "2" "$(_scg_exit "$S1b" "git push origin main")"

# 2c. First push of a repo with only clean commits → allow.
S1c=$(_scg_sandbox)
printf 'hello world\n' > "$S1c/ok.txt"
git -C "$S1c" add ok.txt
git -C "$S1c" commit -qm seed
assert_eq "scg: push clean committed repo → allow" "0" "$(_scg_exit "$S1c" "git push origin main")"

# 3. git commit with nothing staged → allow
assert_eq "scg: empty staged diff → allow" "0" "$(_scg_exit "$S1" "git commit -m nothing")"

# 4. Staged .env file → blocked by path rule
S2=$(_scg_sandbox)
printf 'SECRET=foo\n' > "$S2/.env"
git -C "$S2" add .env
assert_eq "scg: staging .env → block" "2" "$(_scg_exit "$S2" "git commit -m pwn")"

# 5. Source file with AWS key → blocked by content regex
S3=$(_scg_sandbox)
printf 'const aws_key = "AKIAIOSFODNN7EXAMPLE";\n' > "$S3/config.ts"
git -C "$S3" add config.ts
assert_eq "scg: AWS key in diff → block" "2" "$(_scg_exit "$S3" "git commit -m feat")"

# 6. Same AWS key in allowlist → pass through
_scg_write_config '{"safety.allowedSecretPatterns":["AKIAIOSFODNN7EXAMPLE"]}'
assert_eq "scg: allowlist filters content hit → allow" "0" "$(_scg_exit "$S3" "git commit -m feat")"

# 7. Clean source file → allow
rm -f "$CLAUDE_PLUGIN_DATA/config.json"
S4=$(_scg_sandbox)
printf 'const greeting = "hello";\n' > "$S4/hello.ts"
git -C "$S4" add hello.ts
assert_eq "scg: clean diff → allow" "0" "$(_scg_exit "$S4" "git commit -m feat")"

# 8. TruffleHog enabled but not installed → warn + regex-only (no false block)
_scg_write_config '{"safety.useTruffleHog":true}'
SCG_NOTRUF=$(mktemp -d "${TMPDIR:-/tmp}/scg-notruf-XXXXXX")
SCG_OLD_PATH="$PATH"
export PATH="$SCG_NOTRUF:/usr/bin:/bin"
assert_eq "scg: trufflehog enabled + not installed + clean → allow" "0" "$(_scg_exit "$S4" "git commit -m feat")"
export PATH="$SCG_OLD_PATH"
rm -rf "$SCG_NOTRUF"

# 9. TruffleHog enabled + mock returns a finding → block
SCG_TRUF=$(mktemp -d "${TMPDIR:-/tmp}/scg-truf-XXXXXX")
cat > "$SCG_TRUF/trufflehog" <<'MOCKEOF'
#!/usr/bin/env bash
printf '{"Raw":"AKIA1234567890FAKE","SourceMetadata":{"Data":{"Filesystem":{"file":"/x"}}}}\n'
MOCKEOF
chmod +x "$SCG_TRUF/trufflehog"
export PATH="$SCG_TRUF:$PATH"
_scg_write_config '{"safety.useTruffleHog":true}'
assert_eq "scg: trufflehog mock finding → block" "2" "$(_scg_exit "$S4" "git commit -m feat")"

# 10. TruffleHog finding matched by allowlist → filtered, allow
_scg_write_config '{"safety.useTruffleHog":true,"safety.allowedSecretPatterns":["AKIA1234567890FAKE"]}'
assert_eq "scg: trufflehog finding in allowlist → allow" "0" "$(_scg_exit "$S4" "git commit -m feat")"
export PATH="$SCG_OLD_PATH"
rm -rf "$SCG_TRUF"

# 11. B4: TruffleHog explicitly enabled + installed-but-crashes → fail closed.
#     The operator opted into the stronger scan; a silent downgrade to
#     regex-only is a justified-fallback violation, so block (exit 2).
SCG_TRUF_FAIL=$(mktemp -d "${TMPDIR:-/tmp}/scg-truf-fail-XXXXXX")
cat > "$SCG_TRUF_FAIL/trufflehog" <<'MOCKEOF'
#!/usr/bin/env bash
echo "trufflehog: simulated crash" >&2
exit 3
MOCKEOF
chmod +x "$SCG_TRUF_FAIL/trufflehog"
export PATH="$SCG_TRUF_FAIL:$PATH"
_scg_write_config '{"safety.useTruffleHog":true}'
assert_eq "scg: trufflehog enabled + crashes → block" "2" "$(_scg_exit "$S4" "git commit -m feat")"
export PATH="$SCG_OLD_PATH"
rm -rf "$SCG_TRUF_FAIL"

rm -rf "$S1" "$S2" "$S3" "$S4"
unset CLAUDE_PLUGIN_DATA

# ============================================================
echo ""
echo "=== task_C_03: pipeline-ensure-autonomy substitutes \${CLAUDE_PLUGIN_DATA} placeholder ==="

REAL_TEMPLATE="$PLUGIN_ROOT/templates/settings.autonomous.json"
BACKUP_TEMPLATE=$(mktemp)
PD_DATA=$(mktemp -d)
PD_OUT="$PD_DATA/merged-settings.json"

# Backup real template so the swap is reversible even if the test crashes.
# Additive trap: preserves the outer TMPROOT cleanup so the early test fixture
# doesn't leak when any of the assertions below exit non-zero.
cp "$REAL_TEMPLATE" "$BACKUP_TEMPLATE"
trap '
  cp "$BACKUP_TEMPLATE" "$REAL_TEMPLATE" 2>/dev/null
  rm -f "$BACKUP_TEMPLATE"
  rm -rf "$PD_DATA"
  [[ -n "${TMPROOT:-}" && ( "$TMPROOT" == /tmp/* || "$TMPROOT" == /var/folders/* ) ]] && rm -rf "$TMPROOT"
' EXIT

# Write a minimal stub template with the placeholder in multiple positions
cat > "$REAL_TEMPLATE" <<'JSON'
{
  "permissions": {
    "allow": [
      "Read(${CLAUDE_PLUGIN_DATA}/**)",
      "Edit(${CLAUDE_PLUGIN_DATA}/**)",
      "Write(${CLAUDE_PLUGIN_DATA}/**)"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          { "type": "command", "command": "echo ${CLAUDE_PLUGIN_DATA}/x" }
        ]
      }
    ]
  }
}
JSON

# Capture placeholder count in stub before restoration
stub_placeholder_count=$(grep -c '\${CLAUDE_PLUGIN_DATA}' "$REAL_TEMPLATE" 2>/dev/null || true)

# Run real script with the stub template in place. Capture stderr so that a
# regression (e.g. jq parse error, missing dep) doesn't leave the operator
# guessing — the produced-file assertion below dumps the captured output.
ea_stderr=$(env CLAUDE_PLUGIN_DATA="$PD_DATA" \
  "$PLUGIN_ROOT/bin/pipeline-ensure-autonomy" --json 2>&1 >/dev/null) || true

# Restore template immediately so subsequent tests (and a crash mid-assert)
# don't see the stub. Trap still fires on EXIT as belt-and-braces.
cp "$BACKUP_TEMPLATE" "$REAL_TEMPLATE"

# Assertions
if [[ ! -f "$PD_OUT" ]]; then
  echo "FAIL: merged-settings.json was not produced at $PD_OUT"
  echo "--- pipeline-ensure-autonomy stderr ---"
  echo "$ea_stderr"
  exit 1
fi

substituted=$(jq -r '[.. | strings | select(test("\\$\\{CLAUDE_PLUGIN_DATA\\}"))] | length' "$PD_OUT" 2>/dev/null || echo "missing")
assert_eq "pipeline-ensure-autonomy: no \${CLAUDE_PLUGIN_DATA} placeholder remains in merged-settings.json" "0" "$substituted"

resolved=$(jq -r --arg p "$PD_DATA" '[.. | strings | select(contains($p))] | length' "$PD_OUT" 2>/dev/null || echo "0")
[[ "$resolved" -gt 0 ]] || { echo "FAIL: resolved path $PD_DATA does not appear in merged-settings.json"; exit 1; }
echo "PASS: resolved CLAUDE_PLUGIN_DATA appears $resolved times in merged-settings.json"

# Verify the stub template DID contain the placeholder before substitution.
# (Captured above after writing stub, before restoration)
[[ "${stub_placeholder_count:-0}" -ge 1 ]] || { echo "FAIL: stub template had no \${CLAUDE_PLUGIN_DATA} placeholder — test would be vacuous"; exit 1; }
echo "PASS: stub template contained $stub_placeholder_count placeholder(s)"

trap - EXIT
rm -f "$BACKUP_TEMPLATE"
rm -rf "$PD_DATA"

# ============================================================
echo ""
echo "=== task_C_04: pipeline-ensure-autonomy fails loud when CLAUDE_PLUGIN_DATA unset ==="

# Drop CLAUDE_PLUGIN_DATA and confirm the canonical entrypoint exits non-zero
# with a user-actionable stderr — NOT a generic mkdir error from accidental
# unguarded usage of an empty env var. Mutation-test target: removing the
# require_plugin_data guard would let mkdir -p "" fire instead.
#
# Note: pipeline-lib.sh's _factory_expected_data_dir auto-sets CLAUDE_PLUGIN_DATA
# when the script lives under ~/.claude/plugins/cache/. In dev checkouts (which
# is what `bin/test` exercises) the canonicalization is a no-op, so the require
# guard is the only line of defense and this test exercises it directly.
set +e
ec04_stderr=$(env -u CLAUDE_PLUGIN_DATA "$PLUGIN_ROOT/bin/pipeline-ensure-autonomy" --json 2>&1 >/dev/null)
ec04=$?
set -e
assert_eq "ensure-autonomy without CLAUDE_PLUGIN_DATA exits non-zero" "true" "$([[ $ec04 -ne 0 ]] && echo true || echo false)"
assert_eq "ensure-autonomy stderr mentions CLAUDE_PLUGIN_DATA" "true" \
  "$(printf '%s' "$ec04_stderr" | grep -q CLAUDE_PLUGIN_DATA && echo true || echo false)"
# Negative-control: stderr must NOT be the unguarded mkdir error
if printf '%s' "$ec04_stderr" | grep -q 'mkdir:.*No such file or directory'; then
  echo "FAIL: stderr leaked unguarded mkdir error — require_plugin_data guard not firing first"
  fail=$((fail + 1))
else
  echo "  PASS: stderr did not leak unguarded mkdir error"
  pass=$((pass + 1))
fi

# ============================================================
echo ""
echo "=== task_C_05: .claude/ access hook blocks when CLAUDE_PLUGIN_DATA placeholders unset ==="

# Materialize a real merged-settings.json so we can extract the inline hook
# command and drive it directly with synthetic JSON inputs. Confirms the
# defense-in-depth guard against the case-pattern bypass that triggered when
# CLAUDE_PLUGIN_DATA expansion collapsed to /*.
HOOK_DATA=$(mktemp -d)
trap '
  rm -rf "$HOOK_DATA"
  [[ -n "${TMPROOT:-}" && ( "$TMPROOT" == /tmp/* || "$TMPROOT" == /var/folders/* ) ]] && rm -rf "$TMPROOT"
' EXIT

env CLAUDE_PLUGIN_DATA="$HOOK_DATA" \
  "$PLUGIN_ROOT/bin/pipeline-ensure-autonomy" --json >/dev/null 2>&1 || true
HOOK_OUT="$HOOK_DATA/merged-settings.json"

if [[ ! -f "$HOOK_OUT" ]]; then
  echo "FAIL: could not materialize merged-settings.json for hook test"
  fail=$((fail + 1))
else
  # Extract the .claude/ access hook command (first PreToolUse hook on the
  # Glob|Grep|Read|Edit|Write matcher).
  HOOK_CMD=$(jq -r '.hooks.PreToolUse[] | select(.matcher | test("Glob|Grep|Read|Edit|Write")) | .hooks[0].command' "$HOOK_OUT" \
             | head -1)

  if [[ -z "$HOOK_CMD" ]]; then
    echo "FAIL: hook command extraction returned empty"
    fail=$((fail + 1))
  else
    # 1. Placeholder substitution check — neither literal placeholder may remain.
    if printf '%s' "$HOOK_CMD" | grep -qE '\$\{CLAUDE_PLUGIN_DATA(_TILDE)?\}'; then
      echo "FAIL: materialized hook still contains \${CLAUDE_PLUGIN_DATA} or \${CLAUDE_PLUGIN_DATA_TILDE} placeholder"
      fail=$((fail + 1))
    else
      echo "  PASS: both placeholders substituted in materialized hook"
      pass=$((pass + 1))
    fi

    # 2. Path under data dir → allow (exit 0, no block JSON on stdout).
    h_allow_out=$(printf '{"tool_input":{"file_path":"%s/runs/foo"}}' "$HOOK_DATA" \
                  | env CLAUDE_PLUGIN_DATA="$HOOK_DATA" bash -c "$HOOK_CMD" 2>/dev/null)
    h_allow_rc=$?
    assert_eq "hook: path under data dir → exit 0" "0" "$h_allow_rc"
    assert_eq "hook: path under data dir → no block JSON" "" "$h_allow_out"

    # 3. Path under ~/.claude that is NOT data dir → block JSON emitted.
    h_block_out=$(printf '{"tool_input":{"file_path":"%s/.claude/settings.json"}}' "$HOME" \
                  | env CLAUDE_PLUGIN_DATA="$HOOK_DATA" bash -c "$HOOK_CMD" 2>/dev/null)
    assert_eq "hook: path under ~/.claude (not data dir) → block JSON reason" "block" \
      "$(printf '%s' "$h_block_out" | jq -r '.decision' 2>/dev/null)"

    # 4. Path under ~/.claude with env UNSET — the critical bypass test.
    #    Pre-fix: case "$FP" in ""/*|""/*) collapsed to /* and allowed the
    #    write. Post-fix: hook still blocks because the materialized literal
    #    paths don't depend on the runtime env.
    h_bypass_out=$(printf '{"tool_input":{"file_path":"%s/.claude/settings.json"}}' "$HOME" \
                   | env -u CLAUDE_PLUGIN_DATA bash -c "$HOOK_CMD" 2>/dev/null)
    assert_eq "hook: env UNSET + path under ~/.claude → still blocks (no defense-in-depth bypass)" "block" \
      "$(printf '%s' "$h_bypass_out" | jq -r '.decision' 2>/dev/null)"
  fi
fi

echo ""
echo "================================"
echo "Hook tests: $pass passed, $fail failed"
echo "================================"

# task_C_05 set its own EXIT trap that already covers HOOK_DATA + TMPROOT.
# Clear before manual cleanup so we don't double-rm on exit.
trap - EXIT
rm -rf "${HOOK_DATA:-}" 2>/dev/null
[[ -n "${TMPROOT:-}" && ( "$TMPROOT" == /tmp/* || "$TMPROOT" == /var/folders/* ) ]] && rm -rf "$TMPROOT"

[[ $fail -eq 0 ]]
