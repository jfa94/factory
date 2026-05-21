# Scaffold blocklist neutrality + plugin-data path canonicalization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Stop `/factory:scaffold` from suggesting autonomy-blocking write-blocklist patterns by default. (2) Stop hardcoding the install-specific suffix `factory-jfa94` throughout the plugin; rely on `$CLAUDE_PLUGIN_DATA` everywhere, substitute at materialization time where the placeholder appears in JSON.

**Architecture:**

- `/factory:scaffold` Step 4 becomes a single neutral prompt with no detection logic. The blocklist defaults to empty, matching the pipeline's autonomy thesis.
- `templates/settings.autonomous.json` uses a `${CLAUDE_PLUGIN_DATA}` placeholder (mirroring the existing `${CLAUDE_PLUGIN_ROOT}` pattern). `bin/pipeline-ensure-autonomy` substitutes it at materialization time via its existing `jq | walk` pipeline.
- Shell-side fallbacks (`statusline-wrapper.sh`, `tools/score-run*.sh`) drop their `factory-jfa94` defaults and require `$CLAUDE_PLUGIN_DATA` to be set. The wrapper is OK to require it because `pipeline-ensure-autonomy` already injects `env.CLAUDE_PLUGIN_DATA` into `merged-settings.json` and rewrites `statusLine.command` to the stable wrapper copy under `$CLAUDE_PLUGIN_DATA/statusline-wrapper.sh`.

**Tech Stack:** Bash, `jq`, JSON config files. No new dependencies.

---

## Background a junior engineer needs

**What is `CLAUDE_PLUGIN_DATA`?** An environment variable Claude Code sets per-plugin to a writable directory. For this plugin it currently resolves to `~/.claude/plugins/data/factory-jfa94`. The `-jfa94` suffix is the user's marketplace id (see `.claude-plugin/marketplace.json`). Anyone who installs from a different marketplace gets a different suffix. So we must never hardcode the suffix.

**What is `merged-settings.json`?** A file that `pipeline-ensure-autonomy` generates by reading `templates/settings.autonomous.json`, substituting placeholders, and writing the result to `$CLAUDE_PLUGIN_DATA/merged-settings.json`. The factory pipeline boots Claude Code with `--settings $CLAUDE_PLUGIN_DATA/merged-settings.json` so this file is what's actually live.

**What is `safety.writeBlockedPaths`?** A list of glob patterns enforced by `hooks/write-protection.sh` on every `Edit`/`Write`/`MultiEdit`. When a path matches, the hook denies the tool call. The pipeline ships with this list empty by default; the scaffold command used to prompt the user to populate it.

**Why is the scaffold prompt being neutered?** The pipeline is designed to operate autonomously, including authoring migrations and `.env` scaffolding. Pre-populating the blocklist with `supabase/migrations/**` and `.env*` actively blocks autonomous behavior. The new prompt makes no assumptions; users who genuinely need a human gate on a path can opt in.

---

## File Structure

**Files modified:**

- `commands/scaffold.md` — Step 4 rewritten neutral.
- `templates/settings.autonomous.json` — replace `factory-jfa94` literals with `${CLAUDE_PLUGIN_DATA}` placeholder.
- `bin/pipeline-ensure-autonomy` — extend `jq | walk` substitution to also replace `${CLAUDE_PLUGIN_DATA}`; fix two stale comments.
- `bin/statusline-wrapper.sh` — drop hardcoded fallback; require env.
- `tools/score-run.sh`, `tools/score-run-history.sh`, `tools/score-run-backfill.sh` — drop hardcoded fallback; require env.
- `bin/tests/hooks.sh` — update assertions to expect the placeholder in the template.
- `docs/reference/bin-scripts.md` — rewrite the stale paragraph about wrapper fallbacks.

**Out-of-repo state changes (user environment):**

- Clear `safety.writeBlockedPaths` in `~/.claude/plugins/data/factory-jfa94/config.json`.
- Delete legacy `~/.claude/plugin-data/factory/` directory.

---

## Task 1: Rewrite `/factory:scaffold` Step 4 (neutral opt-in)

**Files:**

- Modify: `commands/scaffold.md` (Step 4 section, lines 82–111)

**Goal:** Replace the detection-and-suggest flow with a single neutral question that doesn't push the user toward adding patterns. No automatic detection of supabase/.env/prisma/terraform. If user wants to add patterns, they type them; default = none.

- [ ] **Step 1: Open `commands/scaffold.md` and find the Step 4 block**

The current section starts with `## Step 4: Offer to pre-populate \`safety.writeBlockedPaths\``and ends just before`## Step 5: Summary`.

- [ ] **Step 2: Replace the entire Step 4 section with the new neutral version**

Use `Edit` to replace the block. Old block (what to remove) starts at line 82 with `## Step 4:` and runs through line 111. Replace with:

```markdown
## Step 4: Optional write-blocklist (advanced)

`safety.writeBlockedPaths` is an opt-in glob blocklist enforced by the `write-protection.sh` PreToolUse hook on every `Edit`, `Write`, and `MultiEdit` call. When a path matches, the hook denies the tool call (exit 2, reason `write_blocked`). It blocks the autonomous pipeline **and** interactive Claude sessions.

The blocklist defaults to empty. The autonomous pipeline is designed to author migrations, environment scaffolding, infrastructure code, and similar files without human intervention; adding patterns here removes that autonomy for the matched paths.

Most users should skip this step. Add entries only when you have a concrete reason to require a human gate on a specific path (e.g. a regulated path your org policy forbids agents from modifying, a generated artifact that must stay reproducible from source).

Ask the user once:

> Want to add any glob patterns to `safety.writeBlockedPaths`? (Press Enter to skip; otherwise enter a comma-separated list of globs.)

If the user enters nothing, proceed to Step 5 without writing anything.

If the user enters one or more globs, run `/factory:configure safety.writeBlockedPaths` with the resulting array. Reversible later via `/factory:configure` or by editing `${CLAUDE_PLUGIN_DATA}/config.json` directly.
```

- [ ] **Step 3: Verify the file still parses as a sensible markdown document**

Run: `head -130 commands/scaffold.md`
Expected: Step 4 section reads as above. No stray markdown from the old version.

- [ ] **Step 4: Commit**

```bash
git add commands/scaffold.md
git commit -m "scaffold: make writeBlockedPaths prompt neutral and opt-in"
```

---

## Task 2: Clean up the user's already-applied blocklist + legacy data dir

**Files:**

- Modify (out-of-repo): `~/.claude/plugins/data/factory-jfa94/config.json`
- Delete (out-of-repo): `~/.claude/plugin-data/factory/`

**Goal:** Undo the entries the previous scaffold run wrote, and delete the legacy data dir that no current code references.

- [ ] **Step 1: Show the user the current blocklist for confirmation**

Run: `jq '.safety.writeBlockedPaths' ~/.claude/plugins/data/factory-jfa94/config.json`
Expected: prints `["supabase/migrations/**", ".env*"]`.

- [ ] **Step 2: Clear the blocklist to `[]`**

Run:

```bash
tmp=$(mktemp)
jq '.safety.writeBlockedPaths = []' ~/.claude/plugins/data/factory-jfa94/config.json > "$tmp" && mv "$tmp" ~/.claude/plugins/data/factory-jfa94/config.json
```

Expected: no error.

- [ ] **Step 3: Verify**

Run: `jq '.safety.writeBlockedPaths' ~/.claude/plugins/data/factory-jfa94/config.json`
Expected: prints `[]`.

- [ ] **Step 4: Inspect the legacy `~/.claude/plugin-data/factory/` directory before deleting**

Run: `ls -la ~/.claude/plugin-data/factory/ 2>/dev/null`
Expected: lists a couple of files/subdirs. If non-empty, examine each entry briefly; if any look like in-progress work the user might want, **stop and ask**. If everything is stale (older mtimes, unreferenced by `grep -rn plugin-data/factory bin/ hooks/ commands/ skills/`), proceed.

- [ ] **Step 5: Delete the legacy directory**

Run: `rm -rf ~/.claude/plugin-data/factory/`
Expected: no error. The parent `~/.claude/plugin-data/` will be left in place even if it becomes empty (other plugins may use it in future).

- [ ] **Step 6: No commit (out-of-repo)**

No git changes from this task.

---

## Task 3: Add `${CLAUDE_PLUGIN_DATA}` placeholder substitution (TDD)

**Files:**

- Test: `bin/tests/audit-hooks.sh` (append a new test block)
- Modify: `bin/pipeline-ensure-autonomy:118-144`

**Goal:** Extend the existing `jq | walk` pipeline that already substitutes `${CLAUDE_PLUGIN_ROOT}` so it also substitutes `${CLAUDE_PLUGIN_DATA}` in the same pass. Fail loudly if `CLAUDE_PLUGIN_DATA` is unset (no silent fallback to a guessed path).

- [ ] **Step 1: Write the failing test**

Open `bin/tests/audit-hooks.sh`. Find the end of the file. Append:

```bash
# ============================================================
echo ""
echo "=== task_C_03: pipeline-ensure-autonomy substitutes \${CLAUDE_PLUGIN_DATA} placeholder ==="

PD_DATA=$(mktemp -d)
PD_TEMPLATE=$(mktemp)
PD_OUT="$PD_DATA/merged-settings.json"

# Minimal template with the placeholder in multiple positions
cat > "$PD_TEMPLATE" <<'JSON'
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

# Stub plugin.json so the script reads a version
PD_ROOT=$(mktemp -d)
mkdir -p "$PD_ROOT/.claude-plugin" "$PD_ROOT/bin" "$PD_ROOT/templates"
echo '{"version":"99.0.0"}' > "$PD_ROOT/.claude-plugin/plugin.json"
cp "$PD_TEMPLATE" "$PD_ROOT/templates/settings.autonomous.json"

# Run the real script against the stub root
env CLAUDE_PLUGIN_DATA="$PD_DATA" \
    bash -c "PLUGIN_ROOT='$PD_ROOT' '$PLUGIN_ROOT/bin/pipeline-ensure-autonomy' --json" \
    >/dev/null 2>&1 || true

# Assert: the placeholder was replaced with the resolved data dir
substituted=$(jq -r '[.. | strings | select(test("\\$\\{CLAUDE_PLUGIN_DATA\\}"))] | length' "$PD_OUT" 2>/dev/null || echo "missing")
assert_eq "pipeline-ensure-autonomy: no \${CLAUDE_PLUGIN_DATA} placeholder remains in merged-settings.json" "0" "$substituted"

resolved=$(jq -r '[.. | strings | select(test("'"$PD_DATA"'"))] | length' "$PD_OUT" 2>/dev/null || echo "0")
[[ "$resolved" -gt 0 ]] || { echo "FAIL: resolved path $PD_DATA does not appear in merged-settings.json"; exit 1; }
echo "PASS: resolved CLAUDE_PLUGIN_DATA appears $resolved times in merged-settings.json"

rm -rf "$PD_DATA" "$PD_ROOT" "$PD_TEMPLATE"
```

- [ ] **Step 2: Run the test and verify it FAILS**

Run: `bash bin/tests/audit-hooks.sh 2>&1 | tail -30`
Expected: a `FAIL` line for `task_C_03` (the substitution doesn't exist yet). It's OK if earlier tests pass.

- [ ] **Step 3: Read the current `_regenerate` function in `bin/pipeline-ensure-autonomy`**

Look at lines 70–145. The `jq` invocation appears twice (one branch for chained user statusline, one for none). Both share an identical `walk(...)` block that only substitutes `${CLAUDE_PLUGIN_ROOT}`.

- [ ] **Step 4: Modify the `walk` block to also substitute `${CLAUDE_PLUGIN_DATA}`**

There are two `jq` blocks (around lines 118–130 and 133–143). In **both**, change the `walk(...)` argument from:

```
walk(
  if type == "string" and test("\\$\\{CLAUDE_PLUGIN_ROOT\\}")
  then gsub("\\$\\{CLAUDE_PLUGIN_ROOT\\}"; $root)
  else . end
)
```

to:

```
walk(
  if type == "string"
  then
    (if test("\\$\\{CLAUDE_PLUGIN_ROOT\\}") then gsub("\\$\\{CLAUDE_PLUGIN_ROOT\\}"; $root) else . end)
    | (if test("\\$\\{CLAUDE_PLUGIN_DATA\\}") then gsub("\\$\\{CLAUDE_PLUGIN_DATA\\}"; $plugin_data) else . end)
  else . end
)
```

The `$plugin_data` jq variable is already declared via `--arg plugin_data "$plugin_data"` in both invocations, so no new arg wiring is needed.

- [ ] **Step 5: Guard against `$plugin_data` being empty**

Just above the first `jq` block (after line 80 where `local plugin_data="${CLAUDE_PLUGIN_DATA:-}"` is set), add:

```bash
  if [[ -z "$plugin_data" ]]; then
    log_error "CLAUDE_PLUGIN_DATA is not set; cannot materialize merged-settings.json"
    exit 1
  fi
```

This makes the missing-env failure mode loud instead of silently writing `${CLAUDE_PLUGIN_DATA}` to disk.

- [ ] **Step 6: Run the new test and verify it PASSES**

Run: `bash bin/tests/audit-hooks.sh 2>&1 | tail -10`
Expected: `PASS: pipeline-ensure-autonomy: no ${CLAUDE_PLUGIN_DATA} placeholder remains...` and `PASS: resolved CLAUDE_PLUGIN_DATA appears N times...`.

- [ ] **Step 7: Run the full hook test suite to catch regressions**

Run: `bash bin/tests/audit-hooks.sh`
Expected: all tests pass. If any other test fails, read the failure carefully — the substitution change shouldn't break anything because the existing template still doesn't contain `${CLAUDE_PLUGIN_DATA}` (that comes in Task 4).

- [ ] **Step 8: Commit**

```bash
git add bin/pipeline-ensure-autonomy bin/tests/audit-hooks.sh
git commit -m "pipeline-ensure-autonomy: substitute \${CLAUDE_PLUGIN_DATA} placeholder at materialization"
```

---

## Task 4: Replace `factory-jfa94` literals in the template

**Files:**

- Modify: `templates/settings.autonomous.json` (lines 18–20 and line 144)

**Goal:** The template no longer hardcodes any install-specific suffix. Substitution happens at materialization time courtesy of Task 3.

- [ ] **Step 1: Open `templates/settings.autonomous.json` and change the three permission entries**

Use `Edit` to replace:

```json
      "Read(~/.claude/plugins/data/factory-jfa94/**)",
      "Edit(~/.claude/plugins/data/factory-jfa94/**)",
      "Write(~/.claude/plugins/data/factory-jfa94/**)",
```

with:

```json
      "Read(${CLAUDE_PLUGIN_DATA}/**)",
      "Edit(${CLAUDE_PLUGIN_DATA}/**)",
      "Write(${CLAUDE_PLUGIN_DATA}/**)",
```

- [ ] **Step 2: Update the `.claude/` access hook on line 144**

Inside the long shell command on that line, find:

```
printf '%s' "$FP" | grep -qE '(^|/)\\.claude/plugins/data/factory-jfa94/' && exit 0
```

Replace with:

```
printf '%s' "$FP" | grep -qE "(^|/)$(printf '%s' \"${CLAUDE_PLUGIN_DATA}\" | sed 's|^'\"$HOME\"'/||; s|[.[\\\\*^$()+?{|]|\\\\&|g')/" && exit 0
```

That regex-quote dance is awkward — easier and safer: replace the whole sub-clause with a fixed-string startswith check using shell pattern matching. Use this replacement instead:

```
case "$FP" in "$CLAUDE_PLUGIN_DATA"/*|"${CLAUDE_PLUGIN_DATA/#$HOME/~}"/*) exit 0 ;; esac
```

So the final line 144 command becomes (single-line — preserve in JSON):

```
INPUT=$(cat); FP=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // .tool_input.pattern // empty'); [ -z "$FP" ] && exit 0; printf '%s' "$FP" | grep -qE '(^|/)\.claude(/|$)' || exit 0; printf '%s' "$FP" | grep -qE '(^|/)\.claude/worktrees/' && exit 0; case "$FP" in "$CLAUDE_PLUGIN_DATA"/*|"${CLAUDE_PLUGIN_DATA/#$HOME/~}"/*) exit 0 ;; esac; printf '%s' "$FP" | grep -qE '(^|/)\.claude/projects/[^/]+/[^/]+/tool-results/' && exit 0; echo '{"decision":"block","reason":"Access to .claude/ directory is restricted in autonomous mode."}'
```

Be careful: this is JSON-embedded shell, so the JSON string-escapes (`\"`, `\\`) must remain valid. Use your editor's JSON-aware paste rather than typing manually.

- [ ] **Step 3: Validate the template is still valid JSON**

Run: `jq empty templates/settings.autonomous.json`
Expected: no output, exit 0. If `jq` errors, you broke the JSON; re-check escapes.

- [ ] **Step 4: Re-run the substitution test from Task 3 — now using the real template**

Run: `bash bin/tests/audit-hooks.sh 2>&1 | grep -E 'task_C_03|FAIL|PASS' | tail -20`
Expected: Task 3's test still passes.

- [ ] **Step 5: Manually materialize merged-settings.json against the real template and inspect**

Run:

```bash
TMP=$(mktemp -d)
env CLAUDE_PLUGIN_DATA="$TMP" bin/pipeline-ensure-autonomy --json 2>&1 | tail -5
jq -r '.permissions.allow[] | select(test("plugins/data|CLAUDE_PLUGIN_DATA"))' "$TMP/merged-settings.json"
```

Expected: three lines, each starting with `Read(`, `Edit(`, or `Write(`, each containing the literal `$TMP` path. No `${CLAUDE_PLUGIN_DATA}` placeholder. No `factory-jfa94` literal.

Then clean up: `rm -rf "$TMP"`.

- [ ] **Step 6: Commit**

```bash
git add templates/settings.autonomous.json
git commit -m "settings.autonomous: replace factory-jfa94 hardcode with \${CLAUDE_PLUGIN_DATA} placeholder"
```

---

## Task 5: Update `bin/tests/hooks.sh` to expect the placeholder

**Files:**

- Modify: `bin/tests/hooks.sh:1252–1257`

**Goal:** The four assertions that grep the template for `factory-jfa94` now need to grep for the placeholder instead.

- [ ] **Step 1: Open `bin/tests/hooks.sh` around line 1252**

Read lines 1240–1260 to refresh your memory of the surrounding test block.

- [ ] **Step 2: Replace lines 1252–1257**

Use `Edit` to replace the existing four assertions about `factory-jfa94` with these:

```bash
assert_eq "template allows Read on plugin data dir" "1" "$(jq '[.permissions.allow[] | select(. == "Read(${CLAUDE_PLUGIN_DATA}/**)")] | length' "$autonom")"
assert_eq "template allows Write on plugin data dir" "1" "$(jq '[.permissions.allow[] | select(. == "Write(${CLAUDE_PLUGIN_DATA}/**)")] | length' "$autonom")"
assert_eq "template allows Edit on plugin data dir" "1" "$(jq '[.permissions.allow[] | select(. == "Edit(${CLAUDE_PLUGIN_DATA}/**)")] | length' "$autonom")"
assert_eq "template does NOT deny ~/.claude/** globally" "0" "$(jq '[.permissions.deny[] | select(. | test("~/.claude/\\*\\*"))] | length' "$autonom")"
assert_eq "template denies write on settings.json" "1" "$(jq '[.permissions.deny[] | select(. == "Write(~/.claude/settings.json)")] | length' "$autonom")"
assert_eq ".claude hook allows CLAUDE_PLUGIN_DATA escape" "true" "$(jq -r '[.hooks.PreToolUse[].hooks[]?.command // ""] | join(" ")' "$autonom" | grep -q 'CLAUDE_PLUGIN_DATA' && echo true || echo false)"
```

Note the last assertion's text and grep target both change: previously it grepped `plugins/data/factory-jfa94`; now it greps for `CLAUDE_PLUGIN_DATA`, which is what Task 4 inserted into the hook command.

- [ ] **Step 3: Run the hooks test suite**

Run: `bash bin/tests/hooks.sh 2>&1 | tail -40`
Expected: all assertions pass. If you see `factory-jfa94` referenced in any failure message, you missed one — re-grep.

- [ ] **Step 4: Commit**

```bash
git add bin/tests/hooks.sh
git commit -m "tests: assert template uses \${CLAUDE_PLUGIN_DATA} placeholder, not hardcoded path"
```

---

## Task 6: Drop the hardcoded fallback in `bin/statusline-wrapper.sh`

**Files:**

- Modify: `bin/statusline-wrapper.sh:18–22`

**Goal:** The wrapper no longer guesses a path. It requires `$CLAUDE_PLUGIN_DATA` set in the environment (which `pipeline-ensure-autonomy` guarantees by writing `env.CLAUDE_PLUGIN_DATA` into `merged-settings.json`).

- [ ] **Step 1: Read lines 13–25 of `bin/statusline-wrapper.sh`**

Refresh memory of the current fallback logic.

- [ ] **Step 2: Replace the fallback assignment**

Use `Edit` to replace:

```bash
# Determine plugin data directory. CLAUDE_PLUGIN_DATA is set by the plugin
# system when the pipeline runs; for the statusline (which runs in user env)
# we fall back to the canonical plugin-runtime path so wrapper writes and
# pipeline-quota-check reads agree without env pinning.
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-${HOME}/.claude/plugins/data/factory-jfa94}"
```

with:

```bash
# Plugin data directory. Required: pipeline-ensure-autonomy bakes
# env.CLAUDE_PLUGIN_DATA into merged-settings.json, and Claude Code loads
# that env when the session is launched with --settings. If this is unset,
# we are running outside a properly-launched pipeline session and writing
# usage-cache.json to a guessed path would silently mismatch what
# pipeline-quota-check reads. Skip the cache write in that case.
if [[ -z "${CLAUDE_PLUGIN_DATA:-}" ]]; then
  PLUGIN_DATA=""
else
  PLUGIN_DATA="$CLAUDE_PLUGIN_DATA"
fi
```

- [ ] **Step 3: Guard the cache-write block to skip when `$PLUGIN_DATA` is empty**

Find the existing `if command -v jq` block (around lines 26–36 in the original). Wrap the inner cache-write with a check. The block becomes:

```bash
if [[ -n "$PLUGIN_DATA" ]] && command -v jq >/dev/null 2>&1; then
  if printf '%s' "$input" | jq -e '.rate_limits' >/dev/null 2>&1; then
    mkdir -p "$PLUGIN_DATA" 2>/dev/null || true
    cache_file="${PLUGIN_DATA}/usage-cache.json"
    now=$(date +%s)
    printf '%s' "$input" \
      | jq --argjson now "$now" '.rate_limits + {captured_at: $now}' \
      > "${cache_file}.tmp" 2>/dev/null \
      && mv -f "${cache_file}.tmp" "$cache_file" 2>/dev/null || true
  fi
fi
```

- [ ] **Step 4: Sanity-check by running the wrapper with no env set**

Run:

```bash
echo '{"model":{"display_name":"Claude"},"workspace":{"current_dir":"/tmp"}}' | env -u CLAUDE_PLUGIN_DATA bin/statusline-wrapper.sh
```

Expected: prints `Claude in tmp` (the default statusline output). No error, no file written.

- [ ] **Step 5: Sanity-check with env set**

Run:

```bash
TMP=$(mktemp -d)
echo '{"model":{"display_name":"Claude"},"workspace":{"current_dir":"/tmp"},"rate_limits":{"five_hour":{"resets_at":9999999999,"used_percentage":10}}}' \
  | env CLAUDE_PLUGIN_DATA="$TMP" bin/statusline-wrapper.sh
ls "$TMP"
rm -rf "$TMP"
```

Expected: prints a statusline like `Claude in tmp | 90% left for ...`. `ls "$TMP"` shows `usage-cache.json`.

- [ ] **Step 6: Commit**

```bash
git add bin/statusline-wrapper.sh
git commit -m "statusline-wrapper: require CLAUDE_PLUGIN_DATA; drop factory-jfa94 fallback"
```

---

## Task 7: Drop hardcoded fallback in `tools/score-run*.sh`

**Files:**

- Modify: `tools/score-run.sh:18`
- Modify: `tools/score-run-history.sh:5`
- Modify: `tools/score-run-backfill.sh:12`

**Goal:** These dev tools no longer guess a path. They fail loudly if `$CLAUDE_PLUGIN_DATA` is unset.

- [ ] **Step 1: For each of the three files, replace the `:=` fallback line**

In each file, find a line like:

```bash
: "${CLAUDE_PLUGIN_DATA:=$HOME/.claude/plugins/data/factory-jfa94}"
```

Replace with:

```bash
: "${CLAUDE_PLUGIN_DATA:?CLAUDE_PLUGIN_DATA must be set (e.g. export CLAUDE_PLUGIN_DATA=\"\$HOME/.claude/plugins/data/factory-<your-marketplace-id>\")}"
```

The `:?` form prints the error to stderr and exits non-zero when the variable is unset or empty. Note: in `tools/score-run.sh` there is also an `export CLAUDE_PLUGIN_DATA` on the following line — leave it in place (it propagates the value to child processes).

- [ ] **Step 2: Run each tool with no env to confirm the error fires**

For each of the three scripts:

```bash
env -u CLAUDE_PLUGIN_DATA bash tools/score-run.sh 2>&1 | head -3
env -u CLAUDE_PLUGIN_DATA bash tools/score-run-history.sh 2>&1 | head -3
env -u CLAUDE_PLUGIN_DATA bash tools/score-run-backfill.sh 2>&1 | head -3
```

Expected: each prints `CLAUDE_PLUGIN_DATA must be set...` and exits non-zero.

- [ ] **Step 3: Confirm they still work with env set**

Run: `env CLAUDE_PLUGIN_DATA=/tmp bash tools/score-run-history.sh`
Expected: prints `no history at /tmp/scores.jsonl` (or similar non-error path), exit 0.

- [ ] **Step 4: Commit**

```bash
git add tools/score-run.sh tools/score-run-history.sh tools/score-run-backfill.sh
git commit -m "tools/score-run: require CLAUDE_PLUGIN_DATA; drop factory-jfa94 fallback"
```

---

## Task 8: Fix stale comments in `bin/pipeline-ensure-autonomy`

**Files:**

- Modify: `bin/pipeline-ensure-autonomy:75–79` and `:190–194`

**Goal:** The two comment blocks describe a "fallback to `~/.claude/plugins/data/factory-jfa94`" that no longer exists after Tasks 6 and 7. Bring the docs in line.

- [ ] **Step 1: Replace the comment block at lines 75–79**

Use `Edit`. Old:

```
  # CLAUDE_PLUGIN_DATA pin: bake the current plugin data dir into the merged-settings
  # env block. Both statusline-wrapper.sh and pipeline-quota-check now default to
  # ~/.claude/plugins/data/factory-jfa94 when the env var is unset, so this pin is
  # belt-and-braces — it lets a non-default install (e.g. a forked marketplace id)
  # still keep wrapper writes and gate reads on the same path.
```

New:

```
  # CLAUDE_PLUGIN_DATA pin: bake the current plugin data dir into the merged-settings
  # env block. statusline-wrapper.sh and pipeline-quota-check both require this env
  # var to be set (no install-specific fallback). Pinning it here ensures every
  # session launched via --settings $merged_settings agrees on the same path,
  # regardless of marketplace id or future plugin renames.
```

- [ ] **Step 2: Replace the comment block at lines 190–194**

Old:

```
# Self-heal: 0.6.2 and earlier did not bake CLAUDE_PLUGIN_DATA into the env block.
# Both the wrapper and the quota gate now default to ~/.claude/plugins/data/factory-jfa94
# when the env var is unset, so a missing env entry is no longer load-bearing — but
# regenerating still ensures forks with custom plugin ids stay aligned, and the
# relaunch keeps merged-settings consistent with on-disk state.
```

New:

```
# Self-heal: 0.6.2 and earlier did not bake CLAUDE_PLUGIN_DATA into the env block.
# The wrapper and quota gate now require the env var (no fallback), so a missing
# entry would break statusline writes and quota reads. Regenerate to restore the
# pin; the relaunch keeps merged-settings consistent with on-disk state.
```

- [ ] **Step 3: Sanity-check the script still parses**

Run: `bash -n bin/pipeline-ensure-autonomy`
Expected: no output (syntax OK).

- [ ] **Step 4: Run the full test suite once more for confidence**

Run: `bash bin/tests/audit-hooks.sh && bash bin/tests/hooks.sh`
Expected: both pass clean.

- [ ] **Step 5: Commit**

```bash
git add bin/pipeline-ensure-autonomy
git commit -m "pipeline-ensure-autonomy: update comments to reflect no-fallback contract"
```

---

## Task 9: Rewrite `docs/reference/bin-scripts.md` paragraph

**Files:**

- Modify: `docs/reference/bin-scripts.md:1304–1305`

**Goal:** The current paragraph claims the wrapper and `pipeline-quota-check` "both default to `~/.claude/plugins/data/factory-jfa94`" — false after Tasks 6 and 7.

- [ ] **Step 1: Read the surrounding paragraph (lines 1290–1310) to understand context**

It documents the statusline-wrapper's cache file.

- [ ] **Step 2: Replace the offending bullet**

Use `Edit` to replace:

```markdown
- The statusline runs in the user's shell environment, NOT in the plugin command runtime, so `CLAUDE_PLUGIN_DATA` is not set automatically. The wrapper and `pipeline-quota-check` both default to `~/.claude/plugins/data/factory-jfa94/usage-cache.json` when the env var is unset, so writes and reads agree by default. `pipeline-ensure-autonomy` still bakes `CLAUDE_PLUGIN_DATA` into the merged-settings `env` block as belt-and-braces — useful for forks that ship under a different plugin id.
```

with:

```markdown
- The statusline runs in the user's shell environment, NOT in the plugin command runtime, so `CLAUDE_PLUGIN_DATA` is not set automatically. `pipeline-ensure-autonomy` bakes `CLAUDE_PLUGIN_DATA` into the merged-settings `env` block; Claude Code loads that env when the session is launched with `--settings`, which is how both the wrapper and `pipeline-quota-check` see a consistent path. If the env var is unset, the wrapper silently skips its cache write (no guessed path), and `pipeline-quota-check` errors out — a missing env means the session wasn't launched via the pipeline's `--settings` flag.
```

- [ ] **Step 3: Commit**

```bash
git add docs/reference/bin-scripts.md
git commit -m "docs: bin-scripts wrapper paragraph reflects no-fallback contract"
```

---

## Task 10: End-to-end verification

**Goal:** Confirm everything works together: re-scaffold an existing project, watch for the absence of migration/env prompts, confirm `merged-settings.json` is regenerated cleanly.

- [ ] **Step 1: Force `merged-settings.json` regeneration**

Run:

```bash
mv ~/.claude/plugins/data/factory-jfa94/merged-settings.json /tmp/merged-settings.json.bak 2>/dev/null || true
```

- [ ] **Step 2: Run `pipeline-ensure-autonomy` and inspect the new file**

Run: `bin/pipeline-ensure-autonomy --json 2>&1 | tail -3`
Expected: status `missing` (first-time generation), exit 2. That's correct — the file didn't exist.

- [ ] **Step 3: Verify the regenerated file has no install-specific hardcodes**

Run: `grep -n 'factory-jfa94\|\${CLAUDE_PLUGIN_DATA}' ~/.claude/plugins/data/factory-jfa94/merged-settings.json`
Expected: no matches. (The literal `factory-jfa94` may still appear as part of the resolved path — that's expected because the user's marketplace id is `jfa94`. What must NOT appear is any unresolved `${CLAUDE_PLUGIN_DATA}` placeholder.)

Run: `grep -c 'factory-jfa94' ~/.claude/plugins/data/factory-jfa94/merged-settings.json`
Expected: a number > 0 (because the resolved `$CLAUDE_PLUGIN_DATA` path contains it on your machine). What we care about is that the template didn't have it baked in — verify that with: `grep -c 'factory-jfa94' templates/settings.autonomous.json`. Expected: `0`.

- [ ] **Step 4: Run `/factory:scaffold` against this repo**

In Claude Code, run: `/factory:scaffold`

Watch the output. Expected:

- No prompts about `supabase/migrations`, `.env`, `prisma/migrations`, `terraform/**/*.tfstate`.
- Step 4 asks once: "Want to add any glob patterns to `safety.writeBlockedPaths`?" (or equivalent). Press Enter to skip.
- No `pre-pr-check.sh: No such file or directory` errors (the symlink is in place; this was resolved out-of-plan).

- [ ] **Step 5: Confirm the blocklist stayed empty**

Run: `jq '.safety.writeBlockedPaths' ~/.claude/plugins/data/factory-jfa94/config.json`
Expected: `[]`.

- [ ] **Step 6: Confirm `merged-settings.json` permissions resolved correctly**

Run: `jq -r '.permissions.allow[] | select(test("CLAUDE_PLUGIN_DATA"))' ~/.claude/plugins/data/factory-jfa94/merged-settings.json`
Expected: nothing (no unresolved placeholders).

Run: `jq -r '.permissions.allow[] | select(test("plugins/data"))' ~/.claude/plugins/data/factory-jfa94/merged-settings.json`
Expected: three lines — `Read(...)`, `Edit(...)`, `Write(...)` — each containing the user's actual data dir path.

- [ ] **Step 7: No commit (verification only)**

This task produces no code changes.

---

## Documentation update

After all tasks merge, run the `Scribe` agent per the global CLAUDE.md rule to refresh `/docs`. The Scribe should pick up the changes in `commands/scaffold.md`, `bin/pipeline-ensure-autonomy`, `bin/statusline-wrapper.sh`, and `docs/reference/bin-scripts.md`.

---

## Self-Review Notes

- **Spec coverage:** Plan B (scaffold neutrality) → Task 1+2. Plan C (canonicalization) → Tasks 3–9. End-to-end verification → Task 10. All seven sub-items from Plan C have explicit tasks (template, wrapper, tools, comments, tests, docs, plus the substitution machinery that makes the rest work).
- **Placeholder scan:** every code block is complete; every command has expected output; no TBDs.
- **Type consistency:** the placeholder name `${CLAUDE_PLUGIN_DATA}` is used identically across template, jq walk substitution, and tests.

---

## Open questions

None — the B2 + neutral framing decision is locked. Proceed.
