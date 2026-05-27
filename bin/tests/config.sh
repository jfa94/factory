#!/usr/bin/env bash
# config.sh — plugin.json userConfig schema, commands/configure.md,
# templates (settings.autonomous, stryker, dep-cruiser, package.scaffold),
# commands/run.md materialization, .mcp.json.
set -euo pipefail

# All pipeline-* scripts default to human-readable output (commit 3fc2060).
# Tests parse JSON via jq, so opt into machine output for the whole file.
export FACTORY_JSON=1

PLUGIN_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Single combined EXIT trap covering every tmpdir this suite creates. Avoids
# the prior overwriting-trap pattern (each `trap '...' EXIT` overwrote prior
# cleanup, leaking earlier dirs on abnormal exit). Each guard checks that
# the var is set AND inside $TMPDIR to refuse to rm anything else.
_config_cleanup() {
  local _td="${TMPDIR:-/tmp}"
  local _d
  for _d in MATERIALIZE_DIR SCAFFOLD_DIR EA_DIR EA_DIR_HEAL EA_DIR2 \
            EA_DIR_MIG EA_DIR_WM RCS_DIR; do
    local _v="${!_d:-}"
    [[ -n "$_v" && "$_v" == "$_td"/* ]] && rm -rf "$_v"
  done
}
trap _config_cleanup EXIT

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
  local label="$1" needle="$2" file="$3"
  if grep -qF "$needle" "$file"; then
    echo "  PASS: $label"
    pass=$((pass + 1))
  else
    echo "  FAIL: $label (file does not contain '$needle')"
    fail=$((fail + 1))
  fi
}

assert_file_exists() {
  local label="$1" file="$2"
  if [[ -f "$file" ]]; then
    echo "  PASS: $label"
    pass=$((pass + 1))
  else
    echo "  FAIL: $label ('$file' does not exist)"
    fail=$((fail + 1))
  fi
}

assert_valid_json() {
  local label="$1" file="$2"
  if jq -e . "$file" >/dev/null 2>&1; then
    echo "  PASS: $label"
    pass=$((pass + 1))
  else
    echo "  FAIL: $label ('$file' is not valid JSON)"
    fail=$((fail + 1))
  fi
}

# ============================================================
echo "=== .claude-plugin/plugin.json manifest ==="

PLUGIN_JSON="$PLUGIN_ROOT/.claude-plugin/plugin.json"
assert_file_exists "plugin.json exists" "$PLUGIN_JSON"
assert_valid_json "plugin.json is valid JSON" "$PLUGIN_JSON"

plugin_version=$(jq -r '.version' "$PLUGIN_JSON")
expected_version=$(jq -r '.version' "$PLUGIN_JSON")
assert_eq "plugin version parses from plugin.json" "$expected_version" "$plugin_version"

# userConfig was removed in 0.3.1: Claude Code's manifest validator rejects
# dotted keys and requires fields (title) that conflict with the nested runtime
# config layout read from ${CLAUDE_PLUGIN_DATA}/config.json. Runtime defaults
# live inline at each read_config call; schema documentation lives in
# docs/reference/configuration.md.
has_user_config=$(jq -r 'has("userConfig") | tostring' "$PLUGIN_JSON")
assert_eq "plugin.json has NO userConfig block" "false" "$has_user_config"

# ============================================================
echo "=== docs/reference/configuration.md key coverage ==="

CONFIG_REF="$PLUGIN_ROOT/docs/reference/configuration.md"
assert_file_exists "docs/reference/configuration.md exists" "$CONFIG_REF"

# Canonical runtime config keys. Each must be documented as an `### key`
# heading in docs/reference/configuration.md. Keep this list in sync with the
# keys consumed by bin/pipeline-* via read_config.
for key in \
  maxRuntimeMinutes \
  maxConsecutiveFailures \
  humanReviewLevel \
  maxParallelTasks \
  review.routineRounds \
  review.featureRounds \
  review.securityRounds \
  review.preferCodex \
  quality.holdoutPercent \
  quality.holdoutPassRate \
  quality.mutationScoreTarget \
  quality.mutationTestingTiers \
  quality.coverageMustNotDecrease \
  quality.coverageRegressionTolerancePct \
  execution.defaultModel \
  execution.modelByTier.simple \
  execution.modelByTier.medium \
  execution.modelByTier.complex \
  execution.maxTurnsSimple \
  execution.maxTurnsMedium \
  execution.maxTurnsComplex \
  dependencies.prMergeTimeout \
  dependencies.pollInterval \
  observability.auditLog \
  observability.metricsExport \
  observability.metricsRetentionDays \
  safety.writeBlockedPaths \
  safety.useTruffleHog \
  safety.allowedSecretPatterns; do
  if grep -qE "^### ${key//./\\.}\$" "$CONFIG_REF"; then
    echo "  PASS: configuration.md documents $key"
    pass=$((pass + 1))
  else
    echo "  FAIL: configuration.md missing $key"
    fail=$((fail + 1))
  fi
done

# Removed keys must NOT be documented: 0.2.0 dropped the task/turn circuit
# breakers; 0.3.0 dropped Ollama/LiteLLM local-LLM routing (claude-code#38698).
for removed in \
  maxTasks \
  execution.maxOrchestratorTurns \
  localLlm.enabled \
  localLlm.ollamaUrl \
  localLlm.model \
  localLlm.useLiteLlm \
  localLlm.liteLlmUrl \
  review.ollamaRoutineRounds \
  review.ollamaFeatureRounds \
  review.ollamaSecurityRounds; do
  if grep -qE "^### ${removed//./\\.}\$" "$CONFIG_REF"; then
    echo "  FAIL: configuration.md still documents removed key $removed"
    fail=$((fail + 1))
  else
    echo "  PASS: configuration.md does not document $removed"
    pass=$((pass + 1))
  fi
done

# task_16_01: write-protection hook registered for Edit/Write/MultiEdit
HOOKS_JSON="$PLUGIN_ROOT/hooks/hooks.json"
wp_registered=$(jq -r '[.hooks.PreToolUse[] | select(.matcher | test("Edit|Write|MultiEdit")) | .hooks[] | .command] | map(select(test("write-protection"))) | length' "$HOOKS_JSON")
assert_eq "hooks.json registers write-protection.sh on Edit/Write/MultiEdit" "1" "$wp_registered"

# task_16_12: scaffold slash command + --check mode
assert_eq "commands/scaffold.md exists" "true" \
  "$([[ -f "$PLUGIN_ROOT/commands/scaffold.md" ]] && echo true || echo false)"
assert_contains "scaffold.md has frontmatter description" "description:" "$PLUGIN_ROOT/commands/scaffold.md"
assert_contains "scaffold.md mentions trufflehog" "trufflehog" "$PLUGIN_ROOT/commands/scaffold.md"

# scaffold blocklist neutrality regression guard. The writeBlockedPaths default
# is empty + opt-in (commit 2679ae7); a docs revert that re-introduces canned
# suggestions like `supabase/migrations/**` or `.env*` silently re-removes
# pipeline autonomy on those paths. The terraform tfstate gap is now covered
# by template denies (see Write/Edit(**/*.tfstate)) rather than scaffold prompts.
scaffold_md="$PLUGIN_ROOT/commands/scaffold.md"
neutral_count=$( (grep -c 'defaults to empty' "$scaffold_md" 2>/dev/null || true) | tr -d '[:space:]')
assert_eq "scaffold.md documents empty default for writeBlockedPaths" "1" "${neutral_count:-0}"
suggestions=$( (grep -cE 'Add `(supabase/migrations|\.env|prisma/migrations|terraform/)' "$scaffold_md" 2>/dev/null || true) | tr -d '[:space:]')
assert_eq "scaffold.md does NOT pre-suggest canned blocklist entries" "0" "${suggestions:-0}"

# Template deny list covers terraform tfstate (replaces the removed scaffold prompt).
TEMPLATE_AUTONOMOUS="$PLUGIN_ROOT/templates/settings.autonomous.json"
tfstate_denies=$(jq -r '[.permissions.deny[] | select(test("\\*\\.tfstate"))] | length' "$TEMPLATE_AUTONOMOUS")
assert_eq "settings.autonomous.json deny list covers *.tfstate (Write + Edit, base + .backup)" "4" "$tfstate_denies"

# pipeline-scaffold --check: empty tempdir → exit 1
scaffold_empty=$(mktemp -d)
set +e
"$PLUGIN_ROOT/bin/pipeline-scaffold" "$scaffold_empty" --check >/dev/null 2>&1
check_empty_ec=$?
set -e
assert_eq "pipeline-scaffold --check in unscaffolded dir → exit 1" "1" "$check_empty_ec"

# Run full scaffold then re-check
"$PLUGIN_ROOT/bin/pipeline-scaffold" "$scaffold_empty" >/dev/null 2>&1 || true
set +e
"$PLUGIN_ROOT/bin/pipeline-scaffold" "$scaffold_empty" --check >/dev/null 2>&1
check_full_ec=$?
set -e
assert_eq "pipeline-scaffold --check after scaffolding → exit 0" "0" "$check_full_ec"
rm -rf "$scaffold_empty"

# ============================================================
echo "=== commands/configure.md ==="

CONFIGURE="$PLUGIN_ROOT/commands/configure.md"
assert_file_exists "configure.md exists" "$CONFIGURE"
assert_contains "has description" "description:" "$CONFIGURE"
assert_contains "has Step 1" "Step 1" "$CONFIGURE"
assert_contains "has Step 2" "Step 2" "$CONFIGURE"
assert_contains "writes to config.json" "config.json" "$CONFIGURE"

# task_08_02: write step must use setpath with split(".") so dotted keys
# create nested objects, not flat keys with literal dots in their name.
assert_contains "configure.md uses setpath for nested keys" "setpath" "$CONFIGURE"
assert_contains "configure.md splits dotted key into path array" 'split(".")' "$CONFIGURE"
if grep -qE "jq[^']*'\.\[\\\$k\] = \\\$v'" "$CONFIGURE"; then
  echo "  FAIL: configure.md still uses flat-key write '.[\$k] = \$v'"
  fail=$((fail + 1))
else
  echo "  PASS: configure.md no longer uses flat-key write"
  pass=$((pass + 1))
fi

# Exercise the documented jq one-liner against a synthetic fixture to confirm
# that the dotted key produces a nested object (and not a flat top-level key).
# Cleanup is inline at the end of this block — the materialize section below
# installs its own EXIT trap and would overwrite anything set here.
CFG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/phase9-configure-XXXXXX")
CFG_FILE="$CFG_DIR/config.json"
echo '{}' > "$CFG_FILE"

CFG_TMP=$(mktemp "$CFG_DIR/config.XXXXXX")
jq --arg k "review.routineRounds" --argjson v 3 \
  'setpath(($k | split(".")); $v)' \
  "$CFG_FILE" > "$CFG_TMP"
mv -f "$CFG_TMP" "$CFG_FILE"

nested_value=$(jq -r '.review.routineRounds // "missing"' "$CFG_FILE")
assert_eq "setpath creates nested review.routineRounds" "3" "$nested_value"

flat_value=$(jq -r '."review.routineRounds" // "missing"' "$CFG_FILE")
assert_eq "no flat key with literal dot in name" "missing" "$flat_value"

# Adding a sibling key under the same namespace must preserve the first.
CFG_TMP2=$(mktemp "$CFG_DIR/config.XXXXXX")
jq --arg k "review.featureRounds" --argjson v 5 \
  'setpath(($k | split(".")); $v)' \
  "$CFG_FILE" > "$CFG_TMP2"
mv -f "$CFG_TMP2" "$CFG_FILE"

sibling_first=$(jq -r '.review.routineRounds' "$CFG_FILE")
sibling_second=$(jq -r '.review.featureRounds' "$CFG_FILE")
assert_eq "sibling write preserves review.routineRounds" "3" "$sibling_first"
assert_eq "sibling write adds review.featureRounds" "5" "$sibling_second"

# task_08_03: string-typed settings must use --arg, not --argjson, because raw
# strings (e.g. URLs) are not valid JSON literals. Confirm both that the
# documented technique works at runtime AND that configure.md documents both
# variants.
CFG_TMP3=$(mktemp "$CFG_DIR/config.XXXXXX")
jq --arg k "execution.defaultModel" --arg v "opus" \
  'setpath(($k | split(".")); $v)' \
  "$CFG_FILE" > "$CFG_TMP3"
mv -f "$CFG_TMP3" "$CFG_FILE"

string_value=$(jq -r '.execution.defaultModel // "missing"' "$CFG_FILE")
assert_eq "setpath with --arg writes string execution.defaultModel" \
  "opus" "$string_value"

# Sanity-check: --argjson on a non-JSON string SHOULD fail, proving why we
# need the string/number distinction in the first place.
CFG_TMP4=$(mktemp "$CFG_DIR/config.XXXXXX")
if jq --arg k "execution.defaultModel" --argjson v "not-valid-json" \
  'setpath(($k | split(".")); $v)' \
  "$CFG_FILE" > "$CFG_TMP4" 2>/dev/null; then
  echo "  FAIL: --argjson unexpectedly accepted a non-JSON string"
  fail=$((fail + 1))
else
  echo "  PASS: --argjson rejects non-JSON string (proves --arg is required for strings)"
  pass=$((pass + 1))
fi
rm -f "$CFG_TMP4"

[[ -n "${CFG_DIR:-}" && "$CFG_DIR" == "${TMPDIR:-/tmp}"/* ]] && rm -rf "$CFG_DIR"
unset CFG_DIR CFG_FILE CFG_TMP CFG_TMP2 CFG_TMP3 CFG_TMP4

# task_08_03: configure.md must document the --arg vs --argjson distinction.
# Note: grep -qF would interpret a leading "--" as an option terminator, so the
# assertions search for unambiguous substrings of the documented examples.
assert_contains "configure.md documents argjson for numbers/booleans" \
  'argjson v 3' "$CONFIGURE"
assert_contains "configure.md documents arg for strings" \
  'arg v "opus"' "$CONFIGURE"
assert_contains "configure.md gives a string-valued example (execution.defaultModel)" \
  'execution.defaultModel' "$CONFIGURE"
assert_contains "configure.md gives a numeric example (review.routineRounds)" \
  'review.routineRounds' "$CONFIGURE"

# task_08_04: legacy key names must not appear in code or docs that the plugin
# actually reads at runtime (excludes remediation/ history and the plan files
# describing the migration itself).
for legacy in 'circuitBreaker.maxTasks' 'parallel.maxConcurrent' 'holdout.percent' 'mutationTesting.scoreThreshold'; do
  hits=$(grep -RIl --exclude-dir=remediation --exclude-dir=.git \
    --exclude-dir=node_modules \
    -F "$legacy" "$PLUGIN_ROOT" 2>/dev/null | grep -v 'tests/config.sh' || true)
  if [[ -z "$hits" ]]; then
    echo "  PASS: no live reference to legacy key $legacy"
    pass=$((pass + 1))
  else
    echo "  FAIL: legacy key $legacy still referenced in: $hits"
    fail=$((fail + 1))
  fi
done

# ============================================================
echo ""
echo "=== templates/settings.autonomous.json ==="

TEMPLATE="$PLUGIN_ROOT/templates/settings.autonomous.json"
assert_file_exists "template exists" "$TEMPLATE"
assert_valid_json "template is valid JSON" "$TEMPLATE"

# env var is set
env_val=$(jq -r '.env.FACTORY_AUTONOMOUS_MODE' "$TEMPLATE")
assert_eq "FACTORY_AUTONOMOUS_MODE = 1" "1" "$env_val"

# Bash(*) wildcard must be present (covers pipeline-* and all other commands)
has_bash_wildcard=$(jq -r '.permissions.allow | index("Bash(*)") | if . != null then "yes" else "no" end' "$TEMPLATE")
assert_eq "permissions includes Bash(*)" "yes" "$has_bash_wildcard"

# --- Deny list: full set ported from old pipeline ---
deny_count=$(jq -r '.permissions.deny | length' "$TEMPLATE")
if [[ "$deny_count" -ge 20 ]]; then
  echo "  PASS: deny list has $deny_count entries (>= 20)"
  pass=$((pass + 1))
else
  echo "  FAIL: deny list too small ($deny_count entries, need >= 20)"
  fail=$((fail + 1))
fi

for pattern in \
  "Bash(rm -rf /*)" \
  "Bash(git push --force*)" \
  "Bash(*--no-verify*)" \
  "Bash(git reset --hard*)" \
  "Bash(find .claude*)" \
  "Write(.env)" \
  "Edit(.env)" \
  "Write(**/secrets/**)" \
  "Write(**/migrations/**)"; do
  match=$(jq --arg p "$pattern" -r '.permissions.deny | index($p) | if . != null then "yes" else "no" end' "$TEMPLATE")
  assert_eq "deny list contains $pattern" "yes" "$match"
done

# --- PreToolUse hooks: multiple, covering all old-pipeline guards ---
pretool_groups=$(jq -r '.hooks.PreToolUse | length' "$TEMPLATE")
if [[ "$pretool_groups" -ge 6 ]]; then
  echo "  PASS: has $pretool_groups PreToolUse matcher groups (>= 6)"
  pass=$((pass + 1))
else
  echo "  FAIL: PreToolUse has $pretool_groups matcher groups, need >= 6"
  fail=$((fail + 1))
fi

# .claude access block — matcher must cover Read/Glob/Grep/Edit/Write
dotclaude_block=$(jq -r '[.hooks.PreToolUse[] | select(.matcher | test("Glob|Grep|Read|Edit|Write")) | .hooks[] | .command] | map(select(test("\\.claude"))) | length' "$TEMPLATE")
if [[ "$dotclaude_block" -ge 1 ]]; then
  echo "  PASS: .claude access block hook present"
  pass=$((pass + 1))
else
  echo "  FAIL: .claude access block hook missing"
  fail=$((fail + 1))
fi

# Branch protection via git branch --show-current (inline)
branch_protect=$(jq -r '[.. | .command? // empty] | map(select(test("git branch --show-current"))) | length' "$TEMPLATE")
if [[ "$branch_protect" -ge 1 ]]; then
  echo "  PASS: branch protection hook (git branch --show-current) present"
  pass=$((pass + 1))
else
  echo "  FAIL: branch protection hook missing"
  fail=$((fail + 1))
fi

# Protected-files hook (.env, secrets, migrations)
protected_files=$(jq -r '[.. | .command? // empty] | map(select(test("secrets") and test("migrations"))) | length' "$TEMPLATE")
if [[ "$protected_files" -ge 1 ]]; then
  echo "  PASS: protected-files (.env/secrets/migrations) hook present"
  pass=$((pass + 1))
else
  echo "  FAIL: protected-files hook missing"
  fail=$((fail + 1))
fi

# SQL safety hook — matches Supabase execute_sql
sql_safety=$(jq -r '[.hooks.PreToolUse[] | select(.matcher | test("execute_sql"))] | length' "$TEMPLATE")
if [[ "$sql_safety" -ge 1 ]]; then
  echo "  PASS: SQL safety hook (execute_sql matcher) present"
  pass=$((pass + 1))
else
  echo "  FAIL: SQL safety hook missing"
  fail=$((fail + 1))
fi

# Dangerous Bash pattern hook
dangerous_bash=$(jq -r '[.. | .command? // empty] | map(select(test("Blocked dangerous command pattern"))) | length' "$TEMPLATE")
if [[ "$dangerous_bash" -ge 1 ]]; then
  echo "  PASS: dangerous Bash pattern hook present"
  pass=$((pass + 1))
else
  echo "  FAIL: dangerous Bash pattern hook missing"
  fail=$((fail + 1))
fi

# Self-containment: pre-commit-check and pre-push-check must NOT be referenced.
# Their functionality is duplicated by hooks/secret-commit-guard.sh and bin/pipeline-quality-gate.
for script in pre-commit-check.sh pre-push-check.sh; do
  match=$(jq --arg s "$script" -r '[.. | .command? // empty] | map(select(test($s))) | length' "$TEMPLATE")
  if [[ "$match" -eq 0 ]]; then
    echo "  PASS: $script not referenced (self-contained)"
    pass=$((pass + 1))
  else
    echo "  FAIL: $script still referenced — plugin should be self-contained"
    fail=$((fail + 1))
  fi
done

# --- PostToolUse: prettier + related tests + audit log ---
prettier_hook=$(jq -r '[.. | .command? // empty] | map(select(test("prettier --write"))) | length' "$TEMPLATE")
if [[ "$prettier_hook" -ge 1 ]]; then
  echo "  PASS: PostToolUse prettier auto-format hook present"
  pass=$((pass + 1))
else
  echo "  FAIL: prettier auto-format hook missing"
  fail=$((fail + 1))
fi

related_tests=$(jq -r '[.. | .command? // empty] | map(select(test("findRelatedTests"))) | length' "$TEMPLATE")
if [[ "$related_tests" -ge 1 ]]; then
  echo "  PASS: PostToolUse related-tests hook present"
  pass=$((pass + 1))
else
  echo "  FAIL: related-tests hook missing"
  fail=$((fail + 1))
fi

audit_log=$(jq -r '[.. | .command? // empty] | map(select(test("tool-audit.jsonl"))) | length' "$TEMPLATE")
if [[ "$audit_log" -ge 1 ]]; then
  echo "  PASS: PostToolUse audit-log hook present"
  pass=$((pass + 1))
else
  echo "  FAIL: audit-log hook missing"
  fail=$((fail + 1))
fi

# Stop hook: intentionally absent in autonomous template (commit d8ddaee).
# Per-turn full-suite vitest ran in wrong cwd against stale main; coverage
# is provided by hooks/stop-gate.sh + pipeline-quality-gate at postexec +
# pretooluse ship gate.
stop_hook_count=$(jq -r '.hooks | (.Stop // []) | length' "$TEMPLATE")
if [[ "$stop_hook_count" -eq 0 ]]; then
  echo "  PASS: autonomous template has no Stop hook (intentional, see d8ddaee)"
  pass=$((pass + 1))
else
  echo "  FAIL: autonomous template should not register a Stop hook"
  fail=$((fail + 1))
fi

# Self-containment: native-tool-nudge.sh must reference plugin's own hooks/ via CLAUDE_PLUGIN_ROOT
nudge=$(jq -r '[.. | .command? // empty] | map(select(test("\\$\\{CLAUDE_PLUGIN_ROOT\\}/hooks/native-tool-nudge.sh"))) | length' "$TEMPLATE")
if [[ "$nudge" -ge 1 ]]; then
  echo "  PASS: native-tool-nudge.sh hook present (plugin-relative path)"
  pass=$((pass + 1))
else
  echo "  FAIL: native-tool-nudge.sh hook missing or not self-contained"
  fail=$((fail + 1))
fi

# Self-containment: the actual file must exist in hooks/
PLUGIN_NUDGE="$PLUGIN_ROOT/hooks/native-tool-nudge.sh"
if [[ -x "$PLUGIN_NUDGE" ]]; then
  echo "  PASS: hooks/native-tool-nudge.sh exists and is executable"
  pass=$((pass + 1))
else
  echo "  FAIL: hooks/native-tool-nudge.sh missing or not executable"
  fail=$((fail + 1))
fi

# ============================================================
echo ""
echo "=== commands/run.md materialization (\${CLAUDE_PLUGIN_ROOT} substitution) ==="

RUN_MD="$PLUGIN_ROOT/commands/run.md"
assert_file_exists "run.md exists" "$RUN_MD"

# Materialization moved to pipeline-ensure-autonomy; run.md delegates to the
# pipeline-orchestrator skill which invokes the autonomy check. Accept either
# inline reference in run.md or in the skill body.
SKILL_MD="$PLUGIN_ROOT/skills/pipeline-orchestrator/SKILL.md"
if grep -q 'pipeline-ensure-autonomy' "$RUN_MD" \
   || { [[ -f "$SKILL_MD" ]] && grep -q 'pipeline-ensure-autonomy' "$SKILL_MD"; }; then
  echo "  PASS: orchestrator (run.md or pipeline-orchestrator skill) calls pipeline-ensure-autonomy"
  pass=$((pass + 1))
else
  echo "  FAIL: neither run.md nor pipeline-orchestrator skill calls pipeline-ensure-autonomy"
  fail=$((fail + 1))
fi

# /factory:debug must also gate the quota check behind the autonomy check —
# usage-cache.json is only fresh inside an autonomous session, so calling
# pipeline-quota-check from a regular session always returns `unavailable`.
DEBUG_SKILL_MD="$PLUGIN_ROOT/skills/debug/SKILL.md"
if [[ -f "$DEBUG_SKILL_MD" ]] && grep -q 'pipeline-ensure-autonomy' "$DEBUG_SKILL_MD"; then
  echo "  PASS: skills/debug/SKILL.md calls pipeline-ensure-autonomy"
  pass=$((pass + 1))
else
  echo "  FAIL: skills/debug/SKILL.md does not call pipeline-ensure-autonomy"
  fail=$((fail + 1))
fi

if grep -q 'FACTORY_AUTONOMOUS_MODE:-' "$RUN_MD"; then
  echo "  FAIL: run.md still contains expansion-triggering echo of FACTORY_AUTONOMOUS_MODE"
  fail=$((fail + 1))
else
  echo "  PASS: run.md does not contain expansion-triggering FACTORY_AUTONOMOUS_MODE probe"
  pass=$((pass + 1))
fi

# The walk() + CLAUDE_PLUGIN_ROOT materialization must live in pipeline-ensure-autonomy
ENSURE_SCRIPT="$PLUGIN_ROOT/bin/pipeline-ensure-autonomy"
if grep -q 'walk(' "$ENSURE_SCRIPT" && grep -q 'CLAUDE_PLUGIN_ROOT' "$ENSURE_SCRIPT"; then
  echo "  PASS: pipeline-ensure-autonomy materialization uses walk() + CLAUDE_PLUGIN_ROOT"
  pass=$((pass + 1))
else
  echo "  FAIL: pipeline-ensure-autonomy does not use walk() + CLAUDE_PLUGIN_ROOT"
  fail=$((fail + 1))
fi

if grep -qF 'PreToolUse[0].hooks[0].command' "$RUN_MD"; then
  echo "  FAIL: run.md still references brittle PreToolUse[0].hooks[0].command path"
  fail=$((fail + 1))
else
  echo "  PASS: run.md does not use brittle PreToolUse[0].hooks[0].command path"
  pass=$((pass + 1))
fi

# Exercise the same jq expression against a synthetic fixture. The fixture mixes
# plugin-relative paths (with ${CLAUDE_PLUGIN_ROOT}) and user-env paths that must
# NOT be rewritten.
MATERIALIZE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/phase9-materialize-XXXXXX")

FIXTURE="$MATERIALIZE_DIR/fixture.json"
cat > "$FIXTURE" <<'EOF'
{
  "env": {"FACTORY_AUTONOMOUS_MODE": "1"},
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {"type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/branch-protection.sh"},
          {"type": "command", "command": "~/.claude/hooks/pre-commit-check.sh"}
        ]
      },
      {
        "matcher": "Edit|Write",
        "hooks": [
          {"type": "command", "command": "FILE=$(cat); echo inline"},
          {"type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/rm-guard.sh --strict"}
        ]
      }
    ]
  }
}
EOF

FAKE_ROOT="$MATERIALIZE_DIR/fake-plugin"
mkdir -p "$FAKE_ROOT/hooks"

MATERIALIZED="$MATERIALIZE_DIR/merged.json"
jq --arg root "$FAKE_ROOT" '
  walk(
    if type == "string" and test("\\$\\{CLAUDE_PLUGIN_ROOT\\}")
    then gsub("\\$\\{CLAUDE_PLUGIN_ROOT\\}"; $root)
    else . end
  )
' "$FIXTURE" > "$MATERIALIZED"

assert_valid_json "materialized fixture is valid JSON" "$MATERIALIZED"

# Plugin-relative ${CLAUDE_PLUGIN_ROOT} references replaced with $FAKE_ROOT
rewritten_branch=$(jq -r '.hooks.PreToolUse[0].hooks[0].command' "$MATERIALIZED")
assert_eq "plugin-relative path rewritten to absolute" \
  "$FAKE_ROOT/hooks/branch-protection.sh" \
  "$rewritten_branch"

rewritten_rmguard=$(jq -r '.hooks.PreToolUse[1].hooks[1].command' "$MATERIALIZED")
assert_eq "nested plugin-relative path rewritten to absolute" \
  "$FAKE_ROOT/hooks/rm-guard.sh --strict" \
  "$rewritten_rmguard"

# User-env ~/.claude/hooks/* paths preserved verbatim
preserved_user_hook=$(jq -r '.hooks.PreToolUse[0].hooks[1].command' "$MATERIALIZED")
assert_eq "user-env ~/.claude/hooks path preserved verbatim" \
  "~/.claude/hooks/pre-commit-check.sh" \
  "$preserved_user_hook"

# Inline shell snippets preserved verbatim
preserved_inline=$(jq -r '.hooks.PreToolUse[1].hooks[0].command' "$MATERIALIZED")
assert_eq "inline shell command preserved verbatim" \
  'FILE=$(cat); echo inline' \
  "$preserved_inline"

# No ${CLAUDE_PLUGIN_ROOT} tokens remain anywhere
remaining=$(grep -c 'CLAUDE_PLUGIN_ROOT' "$MATERIALIZED" || true)
assert_eq "no \${CLAUDE_PLUGIN_ROOT} tokens remain in materialized output" "0" "$remaining"

# Idempotency: re-running the same substitution produces byte-identical output
MATERIALIZED2="$MATERIALIZE_DIR/merged2.json"
jq --arg root "$FAKE_ROOT" '
  walk(
    if type == "string" and test("\\$\\{CLAUDE_PLUGIN_ROOT\\}")
    then gsub("\\$\\{CLAUDE_PLUGIN_ROOT\\}"; $root)
    else . end
  )
' "$MATERIALIZED" > "$MATERIALIZED2"

if diff -q "$MATERIALIZED" "$MATERIALIZED2" >/dev/null 2>&1; then
  echo "  PASS: materialization is idempotent"
  pass=$((pass + 1))
else
  echo "  FAIL: materialization is not idempotent"
  fail=$((fail + 1))
fi

# Materializing the real template yields valid JSON (even though it currently
# contains no ${CLAUDE_PLUGIN_ROOT} placeholders — this locks in the walk()
# contract: a no-op substitution must still produce a valid, loadable file).
REAL_MATERIALIZED="$MATERIALIZE_DIR/real-merged.json"
jq --arg root "$FAKE_ROOT" '
  walk(
    if type == "string" and test("\\$\\{CLAUDE_PLUGIN_ROOT\\}")
    then gsub("\\$\\{CLAUDE_PLUGIN_ROOT\\}"; $root)
    else . end
  )
' "$TEMPLATE" > "$REAL_MATERIALIZED"
assert_valid_json "materialized real template is valid JSON" "$REAL_MATERIALIZED"

# Self-containment: real template must have NO ~/.claude/hooks/* references after materialization
real_user_hooks=$(jq -r '[.. | .command? // empty] | map(select(test("~/.claude/hooks/"))) | length' "$REAL_MATERIALIZED")
if [[ "$real_user_hooks" -eq 0 ]]; then
  echo "  PASS: real template has no ~/.claude/hooks/* references (self-contained)"
  pass=$((pass + 1))
else
  echo "  FAIL: real template still references ~/.claude/hooks/* — should be self-contained"
  fail=$((fail + 1))
fi

# ============================================================
echo ""
echo "=== hooks/hooks.json uses \${CLAUDE_PLUGIN_ROOT} ==="

HOOKS_JSON="$PLUGIN_ROOT/hooks/hooks.json"
assert_file_exists "hooks.json exists" "$HOOKS_JSON"
assert_valid_json "hooks.json is valid JSON" "$HOOKS_JSON"

# All 4 hook script references should use CLAUDE_PLUGIN_ROOT
for hook in branch-protection run-tracker stop-gate subagent-stop-gate; do
  if grep -qF "\${CLAUDE_PLUGIN_ROOT}/hooks/${hook}.sh" "$HOOKS_JSON"; then
    echo "  PASS: $hook uses CLAUDE_PLUGIN_ROOT"
    pass=$((pass + 1))
  else
    echo "  FAIL: $hook does not use CLAUDE_PLUGIN_ROOT"
    fail=$((fail + 1))
  fi
done

# ============================================================
echo ""
echo "=== .mcp.json ==="

MCP_JSON="$PLUGIN_ROOT/.mcp.json"
assert_file_exists ".mcp.json exists" "$MCP_JSON"
assert_valid_json ".mcp.json is valid JSON" "$MCP_JSON"

# ============================================================
echo ""
echo "=== pipeline-scaffold quality-gate.yml — dynamic package manager (task_10_01) ==="

SCAFFOLD="$PLUGIN_ROOT/bin/pipeline-scaffold"
assert_file_exists "pipeline-scaffold exists" "$SCAFFOLD"

SCAFFOLD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/phase9-scaffold-XXXXXX")

_scaffold_with_lockfile() {
  local fixture="$1" lockfile="$2"
  mkdir -p "$SCAFFOLD_DIR/$fixture"
  [[ -n "$lockfile" ]] && : > "$SCAFFOLD_DIR/$fixture/$lockfile"
  "$SCAFFOLD" "$SCAFFOLD_DIR/$fixture" >/dev/null
}

# --- quality-gate.yml is copied byte-identical from templates/ regardless of lockfile ---
# Scaffold no longer detects package manager; it copies the canonical pnpm-based
# workflow from templates/.github/workflows/quality-gate.yml. Target projects
# using a different package manager must adapt the workflow manually.
QG_TEMPLATE="$PLUGIN_ROOT/templates/.github/workflows/quality-gate.yml"
assert_file_exists "templates/.github/workflows/quality-gate.yml exists" "$QG_TEMPLATE"

for fixture in pnpm-lock.yaml yarn.lock bun.lockb bun.lock package-lock.json ""; do
  name="${fixture:-bare}-proj"
  _scaffold_with_lockfile "$name" "$fixture"
  dest="$SCAFFOLD_DIR/$name/.github/workflows/quality-gate.yml"
  assert_file_exists "$name scaffold generated quality-gate.yml" "$dest"
  if cmp -s "$QG_TEMPLATE" "$dest"; then
    echo "  PASS: $name workflow is byte-identical to template"
    pass=$((pass + 1))
  else
    echo "  FAIL: $name workflow differs from template"
    fail=$((fail + 1))
  fi
done

# Canonical workflow must have the four jobs (quality, security, mutation, auto-merge)
# and the incremental-vs-full mutation branching.
assert_contains "quality-gate template has quality job" "name: Quality" "$QG_TEMPLATE"
assert_contains "quality-gate template has security job" "name: Security Scan" "$QG_TEMPLATE"
assert_contains "quality-gate template has mutation job" "name: Mutation Testing" "$QG_TEMPLATE"
assert_contains "quality-gate template has auto-merge job" "name: Auto Merge" "$QG_TEMPLATE"
assert_contains "quality-gate template squashes task PRs into staging" "squash --auto" "$QG_TEMPLATE"
assert_contains "quality-gate template merge-commits rollup into develop" "merge --auto" "$QG_TEMPLATE"
assert_contains "quality-gate template gates squash on staging base" "github.base_ref == 'staging'" "$QG_TEMPLATE"
assert_contains "quality-gate template gates merge on develop base" "github.base_ref == 'develop'" "$QG_TEMPLATE"
# Post-port (commit 075ad77): mutation runs as a 4-way matrix with an
# aggregator named "Mutation Testing". The old per-job "Mutation (full scope"
# naming is gone. Keep the incremental-scope assertion (still load-bearing —
# scope is computed from origin/$BASE_REF diff) and add the new structure pin.
assert_contains "quality-gate template uses git since-ref for incremental mutation" 'origin/$BASE_REF' "$QG_TEMPLATE"
assert_contains "quality-gate template has 4-way mutation shard matrix" 'shard: [1, 2, 3, 4]' "$QG_TEMPLATE"
assert_contains "quality-gate template has mutation-testing aggregator job" 'mutation-testing:' "$QG_TEMPLATE"

# Branch cleanup on auto-merge: both staging-target (task branches are
# ephemeral) AND develop-target (commit 075ad77 added --delete-branch to
# clean up the staging rollup branch after merge) delete the head branch.
assert_contains "quality-gate template deletes branch after staging merge" \
  'gh pr merge "$PR_NUMBER" --squash --auto --delete-branch' "$QG_TEMPLATE"
assert_contains "quality-gate template deletes branch after develop-target merge" \
  'gh pr merge "$PR_NUMBER" --merge --auto --delete-branch' "$QG_TEMPLATE"

# pipeline-scaffold --migrate-workflows: idempotent surgical patch that
# upgrades a previously scaffolded quality-gate.yml to add --delete-branch.
MIGRATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/phase9-migrate-XXXXXX")
mkdir -p "$MIGRATE_DIR/.github/workflows"
# Seed with an older copy of the template that lacks --delete-branch.
sed 's| --squash --auto --delete-branch| --squash --auto|' "$QG_TEMPLATE" \
  > "$MIGRATE_DIR/.github/workflows/quality-gate.yml"
assert_contains "seed lacks --delete-branch before migration" \
  'gh pr merge "$PR_NUMBER" --squash --auto' \
  "$MIGRATE_DIR/.github/workflows/quality-gate.yml"

migrate_out=$("$SCAFFOLD" "$MIGRATE_DIR" --migrate-workflows 2>/dev/null)
migrate_count=$(printf '%s' "$migrate_out" | jq -r '.count')
assert_eq "first --migrate-workflows reports one patch" "1" "$migrate_count"
assert_contains "migrated workflow now has --delete-branch" \
  'gh pr merge "$PR_NUMBER" --squash --auto --delete-branch' \
  "$MIGRATE_DIR/.github/workflows/quality-gate.yml"

# Second invocation must be a no-op (idempotent).
migrate_out2=$("$SCAFFOLD" "$MIGRATE_DIR" --migrate-workflows 2>/dev/null)
migrate_count2=$(printf '%s' "$migrate_out2" | jq -r '.count')
assert_eq "second --migrate-workflows is a no-op" "0" "$migrate_count2"

rm -rf "$MIGRATE_DIR"

# ============================================================
echo ""
echo "=== templates: stryker + dep-cruiser + package.scaffold (task_10_02/03) ==="

STRYKER_TMPL="$PLUGIN_ROOT/templates/.stryker.config.json"
DEPCRUISE_TMPL="$PLUGIN_ROOT/templates/.dependency-cruiser.cjs"
PKG_SCAFFOLD_TMPL="$PLUGIN_ROOT/templates/package.scaffold.json"

assert_file_exists "templates/.stryker.config.json exists" "$STRYKER_TMPL"
assert_valid_json "templates/.stryker.config.json is valid JSON" "$STRYKER_TMPL"
assert_file_exists "templates/.dependency-cruiser.cjs exists" "$DEPCRUISE_TMPL"
assert_file_exists "templates/package.scaffold.json exists" "$PKG_SCAFFOLD_TMPL"
assert_valid_json "templates/package.scaffold.json is valid JSON" "$PKG_SCAFFOLD_TMPL"

# Sanity-check template contents
stryker_runner=$(jq -r '.testRunner' "$STRYKER_TMPL")
assert_eq "stryker template uses vitest runner" "vitest" "$stryker_runner"
assert_contains "dep-cruiser template exports config" "module.exports" "$DEPCRUISE_TMPL"

scaffold_has_testmut=$(jq -r '.scripts["test:mutation"] // empty' "$PKG_SCAFFOLD_TMPL")
assert_eq "package.scaffold.json defines test:mutation script" "stryker run" "$scaffold_has_testmut"
scaffold_has_stryker_dep=$(jq -r '.devDependencies["@stryker-mutator/core"] // empty' "$PKG_SCAFFOLD_TMPL")
if [[ -n "$scaffold_has_stryker_dep" ]]; then
  echo "  PASS: package.scaffold.json declares @stryker-mutator/core devDependency"
  pass=$((pass + 1))
else
  echo "  FAIL: package.scaffold.json missing @stryker-mutator/core"
  fail=$((fail + 1))
fi

# --- task_10_02: scaffold deploys stryker + depcruise when package.json exists ---
NODE_PROJ="$SCAFFOLD_DIR/node-proj"
mkdir -p "$NODE_PROJ"
printf '{"name":"user-proj","version":"1.0.0"}\n' > "$NODE_PROJ/package.json"
"$SCAFFOLD" "$NODE_PROJ" >/dev/null

assert_file_exists "scaffold deploys .stryker.config.json when package.json present" \
  "$NODE_PROJ/.stryker.config.json"
assert_file_exists "scaffold deploys .dependency-cruiser.cjs when package.json present" \
  "$NODE_PROJ/.dependency-cruiser.cjs"

# Byte-identical to template (copy, not mutate)
if diff -q "$STRYKER_TMPL" "$NODE_PROJ/.stryker.config.json" >/dev/null 2>&1; then
  echo "  PASS: deployed .stryker.config.json matches template byte-for-byte"
  pass=$((pass + 1))
else
  echo "  FAIL: deployed .stryker.config.json differs from template"
  fail=$((fail + 1))
fi

# --- Idempotency: second run must not overwrite user customizations ---
printf '{"mutate": ["custom/**"]}\n' > "$NODE_PROJ/.stryker.config.json"
"$SCAFFOLD" "$NODE_PROJ" >/dev/null
custom_mutate=$(jq -rc '.mutate' "$NODE_PROJ/.stryker.config.json")
assert_eq "scaffold does not overwrite existing stryker config" '["custom/**"]' "$custom_mutate"

# --- task_10_02: no package.json → no node-specific templates deployed ---
NO_PKG_PROJ="$SCAFFOLD_DIR/no-pkg-proj"
mkdir -p "$NO_PKG_PROJ"
"$SCAFFOLD" "$NO_PKG_PROJ" >/dev/null
if [[ -f "$NO_PKG_PROJ/.stryker.config.json" ]]; then
  echo "  FAIL: scaffold deployed stryker config without package.json"
  fail=$((fail + 1))
else
  echo "  PASS: scaffold skips stryker config when package.json absent"
  pass=$((pass + 1))
fi
if [[ -f "$NO_PKG_PROJ/.dependency-cruiser.cjs" ]]; then
  echo "  FAIL: scaffold deployed dep-cruiser config without package.json"
  fail=$((fail + 1))
else
  echo "  PASS: scaffold skips dep-cruiser config when package.json absent"
  pass=$((pass + 1))
fi

# --- task_10_03: --merge-package-json flag merges scripts and devDependencies ---
MERGE_PROJ="$SCAFFOLD_DIR/merge-proj"
mkdir -p "$MERGE_PROJ"
cat > "$MERGE_PROJ/package.json" <<'PKG'
{
  "name": "merge-proj",
  "version": "2.3.4",
  "scripts": {
    "start": "node ./server.js",
    "test": "jest"
  },
  "devDependencies": {
    "vitest": "^3.0.0"
  }
}
PKG
"$SCAFFOLD" "$MERGE_PROJ" --merge-package-json >/dev/null

# Scaffold scripts added
added_test_mutation=$(jq -r '.scripts["test:mutation"] // empty' "$MERGE_PROJ/package.json")
assert_eq "merge adds scaffold test:mutation script" "stryker run" "$added_test_mutation"
added_lint=$(jq -r '.scripts.lint // empty' "$MERGE_PROJ/package.json")
assert_eq "merge adds scaffold lint script" "eslint . --max-warnings 0" "$added_lint"

# User scripts preserved
preserved_start=$(jq -r '.scripts.start // empty' "$MERGE_PROJ/package.json")
assert_eq "merge preserves user start script" "node ./server.js" "$preserved_start"
preserved_test=$(jq -r '.scripts.test // empty' "$MERGE_PROJ/package.json")
assert_eq "merge preserves user test script (user wins over scaffold)" "jest" "$preserved_test"

# User's other top-level fields preserved
preserved_name=$(jq -r '.name' "$MERGE_PROJ/package.json")
assert_eq "merge preserves user top-level name" "merge-proj" "$preserved_name"
preserved_version=$(jq -r '.version' "$MERGE_PROJ/package.json")
assert_eq "merge preserves user top-level version" "2.3.4" "$preserved_version"

# User devDependency version wins, new ones are added
preserved_vitest=$(jq -r '.devDependencies.vitest' "$MERGE_PROJ/package.json")
assert_eq "merge preserves user vitest version" "^3.0.0" "$preserved_vitest"
added_depcruise=$(jq -r '.devDependencies["dependency-cruiser"] // empty' "$MERGE_PROJ/package.json")
if [[ -n "$added_depcruise" ]]; then
  echo "  PASS: merge adds scaffold dependency-cruiser devDependency"
  pass=$((pass + 1))
else
  echo "  FAIL: merge did not add dependency-cruiser devDependency"
  fail=$((fail + 1))
fi

# --- task_10_03: second run is a no-op (scaffold scripts already present) ---
before_second=$(jq -S . "$MERGE_PROJ/package.json")
"$SCAFFOLD" "$MERGE_PROJ" --merge-package-json >/dev/null
after_second=$(jq -S . "$MERGE_PROJ/package.json")
if [[ "$before_second" == "$after_second" ]]; then
  echo "  PASS: second --merge-package-json run is a no-op"
  pass=$((pass + 1))
else
  echo "  FAIL: second --merge-package-json run mutated package.json"
  fail=$((fail + 1))
fi

# --- task_10_03: default scaffold (no flag) does NOT mutate package.json ---
NOFLAG_PROJ="$SCAFFOLD_DIR/noflag-proj"
mkdir -p "$NOFLAG_PROJ"
cat > "$NOFLAG_PROJ/package.json" <<'PKG'
{"name":"noflag","scripts":{"only":"echo ok"}}
PKG
original=$(jq -S . "$NOFLAG_PROJ/package.json")
"$SCAFFOLD" "$NOFLAG_PROJ" >/dev/null
after=$(jq -S . "$NOFLAG_PROJ/package.json")
if [[ "$original" == "$after" ]]; then
  echo "  PASS: default scaffold does not merge package.json without flag"
  pass=$((pass + 1))
else
  echo "  FAIL: default scaffold mutated package.json without flag"
  fail=$((fail + 1))
fi

# ============================================================
echo ""
echo "=== bin/* executable bit (git-tracked mode 100755) ==="
# Every shipped script under bin/ must be tracked as executable in git.
# Claude Code's plugin loader preserves the git mode bits when materializing
# the cache copy; a non-executable script silently no-ops. Past incident:
# bin/statusline-wrapper.sh was tracked as 100644, statusline never ran,
# usage-cache.json went 5 days stale and the pipeline halted at every quota
# gate with no visible cause.
# Entry-point scripts: extensionless pipeline-* commands + statusline-wrapper.sh.
# Libraries (*-lib.sh, *-steps.sh) and tests/fixtures are intentionally not
# executable — they are sourced or read, never exec'd.
nonexec=$(cd "$PLUGIN_ROOT" && git ls-files -s bin/ \
  | awk '$1 != "100755" {
      if ($4 ~ /\/pipeline-[^\/.]+$/) print $4;
      else if ($4 ~ /\/statusline-wrapper\.sh$/) print $4;
    }' \
  || true)
if [[ -z "$nonexec" ]]; then
  echo "  PASS: all bin/* shipped scripts are tracked as 100755"
  pass=$((pass + 1))
else
  echo "  FAIL: bin/* scripts tracked as non-executable in git:"
  printf '    - %s\n' $nonexec
  echo "    Fix: git update-index --chmod=+x <path>"
  fail=$((fail + 1))
fi

echo "=== bin/pipeline-ensure-autonomy ==="

ENSURE_SCRIPT="$PLUGIN_ROOT/bin/pipeline-ensure-autonomy"
assert_file_exists "pipeline-ensure-autonomy exists" "$ENSURE_SCRIPT"

if [[ -x "$ENSURE_SCRIPT" ]]; then
  echo "  PASS: pipeline-ensure-autonomy is executable"
  pass=$((pass + 1))
else
  echo "  FAIL: pipeline-ensure-autonomy is not executable"
  fail=$((fail + 1))
fi

# _factoryVersion stamped on first-run (missing path)
EA_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ensure-autonomy-test-XXXXXX")

ea_out=$(CLAUDE_PLUGIN_DATA="$EA_DIR" FACTORY_AUTONOMOUS_MODE="" \
  PATH="$PLUGIN_ROOT/bin:$PATH" "$ENSURE_SCRIPT" 2>/dev/null) || true
ea_status=$(printf '%s' "$ea_out" | jq -r '.status')
assert_eq "ensure-autonomy: missing status on first run" "missing" "$ea_status"

if [[ -f "$EA_DIR/merged-settings.json" ]]; then
  echo "  PASS: ensure-autonomy generated merged-settings.json on missing"
  pass=$((pass + 1))
else
  echo "  FAIL: ensure-autonomy did not generate merged-settings.json"
  fail=$((fail + 1))
fi

stamped_ver=$(jq -r '._factoryVersion // empty' "$EA_DIR/merged-settings.json" 2>/dev/null)
assert_eq "ensure-autonomy stamps _factoryVersion in merged-settings.json" \
  "$plugin_version" "$stamped_ver"

# CLAUDE_PLUGIN_DATA pin — wrapper (user-shell env) writes to fallback path
# unless this env var is baked into the merged-settings env block. Without it,
# usage-cache.json drifts and the gates fail closed.
stamped_data=$(jq -r '.env.CLAUDE_PLUGIN_DATA // empty' "$EA_DIR/merged-settings.json" 2>/dev/null)
assert_eq "ensure-autonomy injects env.CLAUDE_PLUGIN_DATA into merged-settings" \
  "$EA_DIR" "$stamped_data"

# Self-heal: existing merged-settings missing env.CLAUDE_PLUGIN_DATA → regenerate
EA_DIR_HEAL=$(mktemp -d "${TMPDIR:-/tmp}/ensure-autonomy-heal-XXXXXX")
# Seed a current-version merged-settings WITHOUT env.CLAUDE_PLUGIN_DATA
jq --arg ver "$plugin_version" 'del(.env.CLAUDE_PLUGIN_DATA) | ._factoryVersion = $ver' \
  "$EA_DIR/merged-settings.json" > "$EA_DIR_HEAL/merged-settings.json"
printf '{"captured_at": %d}' "$(date +%s)" > "$EA_DIR_HEAL/usage-cache.json"
ea_out_heal=$(CLAUDE_PLUGIN_DATA="$EA_DIR_HEAL" FACTORY_AUTONOMOUS_MODE=1 \
  PATH="$PLUGIN_ROOT/bin:$PATH" "$ENSURE_SCRIPT" 2>/dev/null) || true
ea_status_heal=$(printf '%s' "$ea_out_heal" | jq -r '.status')
assert_eq "ensure-autonomy: stale status when merged-settings lacks env.CLAUDE_PLUGIN_DATA" \
  "stale" "$ea_status_heal"
heal_data=$(jq -r '.env.CLAUDE_PLUGIN_DATA // empty' "$EA_DIR_HEAL/merged-settings.json")
assert_eq "ensure-autonomy: self-heal injects env.CLAUDE_PLUGIN_DATA on regen" \
  "$EA_DIR_HEAL" "$heal_data"

# ok path — file current + mode set + fresh usage-cache
printf '{"captured_at": %d}' "$(date +%s)" > "$EA_DIR/usage-cache.json"
ea_out_ok=$(CLAUDE_PLUGIN_DATA="$EA_DIR" FACTORY_AUTONOMOUS_MODE=1 \
  PATH="$PLUGIN_ROOT/bin:$PATH" "$ENSURE_SCRIPT" 2>/dev/null)
ea_status_ok=$(printf '%s' "$ea_out_ok" | jq -r '.status')
assert_eq "ensure-autonomy: ok status when file current and mode set" "ok" "$ea_status_ok"

# stale-cache path — usage-cache.json older than 3600s
printf '{"captured_at": %d}' "$(( $(date +%s) - 7200 ))" > "$EA_DIR/usage-cache.json"
ea_out_stcache=$(CLAUDE_PLUGIN_DATA="$EA_DIR" FACTORY_AUTONOMOUS_MODE=1 \
  PATH="$PLUGIN_ROOT/bin:$PATH" "$ENSURE_SCRIPT" 2>/dev/null) || true
ea_status_stcache=$(printf '%s' "$ea_out_stcache" | jq -r '.status')
assert_eq "ensure-autonomy: stale-cache status when usage-cache >3600s old" \
  "stale-cache" "$ea_status_stcache"

# Restore fresh cache for subsequent tests
printf '{"captured_at": %d}' "$(date +%s)" > "$EA_DIR/usage-cache.json"

# stale path — overwrite _factoryVersion with 0.0.0
jq '._factoryVersion = "0.0.0"' "$EA_DIR/merged-settings.json" > "$EA_DIR/merged-settings.json.tmp"
mv "$EA_DIR/merged-settings.json.tmp" "$EA_DIR/merged-settings.json"

ea_out_stale=$(CLAUDE_PLUGIN_DATA="$EA_DIR" FACTORY_AUTONOMOUS_MODE=1 \
  PATH="$PLUGIN_ROOT/bin:$PATH" "$ENSURE_SCRIPT" 2>/dev/null) || true
ea_status_stale=$(printf '%s' "$ea_out_stale" | jq -r '.status')
assert_eq "ensure-autonomy: stale status on version mismatch" "stale" "$ea_status_stale"

ea_ver_after=$(jq -r '._factoryVersion' "$EA_DIR/merged-settings.json")
assert_eq "ensure-autonomy regenerates to current version after stale" \
  "$plugin_version" "$ea_ver_after"

# bypass path — no file, mode=1
EA_DIR2=$(mktemp -d "${TMPDIR:-/tmp}/ensure-autonomy-bypass-XXXXXX")

ea_out_bypass=$(CLAUDE_PLUGIN_DATA="$EA_DIR2" FACTORY_AUTONOMOUS_MODE=1 \
  PATH="$PLUGIN_ROOT/bin:$PATH" "$ENSURE_SCRIPT" 2>/dev/null)
ea_status_bypass=$(printf '%s' "$ea_out_bypass" | jq -r '.status')
assert_eq "ensure-autonomy: bypass status when no file and mode=1" "bypass" "$ea_status_bypass"

# Stable wrapper path: regenerate must copy bin/statusline-wrapper.sh into
# $CLAUDE_PLUGIN_DATA and bake that path into statusLine.command so plugin
# version cycles don't strand long-lived sessions on a deleted cache dir.
stable_wrapper="$EA_DIR/statusline-wrapper.sh"
if [[ -f "$stable_wrapper" && -x "$stable_wrapper" ]]; then
  echo "  PASS: ensure-autonomy copies wrapper into \$CLAUDE_PLUGIN_DATA and marks executable"
  pass=$((pass + 1))
else
  echo "  FAIL: ensure-autonomy did not copy wrapper into \$CLAUDE_PLUGIN_DATA (or not executable)"
  fail=$((fail + 1))
fi

baked_statusline=$(jq -r '.statusLine.command // empty' "$EA_DIR/merged-settings.json")
assert_eq "ensure-autonomy bakes stable wrapper path into statusLine.command" \
  "$stable_wrapper" "$baked_statusline"

# Legacy migration: a current-version merged-settings whose statusLine.command
# is under .../plugins/cache/<owner>/<plugin>/<ver>/bin/... must be regenerated
# even though _factoryVersion matches.
EA_DIR_MIG=$(mktemp -d "${TMPDIR:-/tmp}/ensure-autonomy-mig-XXXXXX")
jq --arg ver "$plugin_version" \
   '._factoryVersion = $ver
    | .env.CLAUDE_PLUGIN_DATA = "'"$EA_DIR_MIG"'"
    | .statusLine.command = "/Users/example/.claude/plugins/cache/owner/plugin/0.0.1/bin/statusline-wrapper.sh"' \
  "$EA_DIR/merged-settings.json" > "$EA_DIR_MIG/merged-settings.json"
printf '{"captured_at": %d}' "$(date +%s)" > "$EA_DIR_MIG/usage-cache.json"
ea_out_mig=$(FACTORY_JSON=1 CLAUDE_PLUGIN_DATA="$EA_DIR_MIG" FACTORY_AUTONOMOUS_MODE=1 \
  PATH="$PLUGIN_ROOT/bin:$PATH" "$ENSURE_SCRIPT" 2>/dev/null) || true
ea_status_mig=$(printf '%s' "$ea_out_mig" | jq -r '.status')
assert_eq "ensure-autonomy: stale status on legacy cache-pinned wrapper path" \
  "stale" "$ea_status_mig"
mig_statusline=$(jq -r '.statusLine.command // empty' "$EA_DIR_MIG/merged-settings.json")
assert_eq "ensure-autonomy: migration rewrites statusLine.command to stable path" \
  "$EA_DIR_MIG/statusline-wrapper.sh" "$mig_statusline"

# Wrapper-missing path probe: when statusLine.command resolves to a missing
# file AND regenerate cannot fix it (no $CLAUDE_PLUGIN_DATA), surface a
# dedicated status instead of a misleading stale-cache reason.
EA_DIR_WM=$(mktemp -d "${TMPDIR:-/tmp}/ensure-autonomy-wm-XXXXXX")
jq --arg ver "$plugin_version" \
   '._factoryVersion = $ver
    | .env.CLAUDE_PLUGIN_DATA = "'"$EA_DIR_WM"'"
    | .statusLine.command = "/definitely/not/here/wrapper.sh"' \
  "$EA_DIR/merged-settings.json" > "$EA_DIR_WM/merged-settings.json"
printf '{"captured_at": %d}' "$(date +%s)" > "$EA_DIR_WM/usage-cache.json"
# Regenerate will create a working stable-path wrapper at $EA_DIR_WM, so the
# probe self-heals and returns "stale" (caller relaunches). This is the
# happy-recovery path; the dedicated wrapper-missing status fires only when
# regenerate itself cannot land an executable wrapper.
ea_out_wm=$(FACTORY_JSON=1 CLAUDE_PLUGIN_DATA="$EA_DIR_WM" FACTORY_AUTONOMOUS_MODE=1 \
  PATH="$PLUGIN_ROOT/bin:$PATH" "$ENSURE_SCRIPT" 2>/dev/null) || true
ea_status_wm=$(printf '%s' "$ea_out_wm" | jq -r '.status')
# Acceptable outcomes: "stale" (legacy-path migration fired first, repaired
# wrapper) or "stale" again from the path probe. Either way, never "ok".
if [[ "$ea_status_wm" == "stale" || "$ea_status_wm" == "wrapper-missing" ]]; then
  echo "  PASS: ensure-autonomy: probe halts on missing wrapper (status=$ea_status_wm)"
  pass=$((pass + 1))
else
  echo "  FAIL: ensure-autonomy: probe did not halt on missing wrapper (got '$ea_status_wm')"
  fail=$((fail + 1))
fi
wm_wrapper="$EA_DIR_WM/statusline-wrapper.sh"
if [[ -f "$wm_wrapper" && -x "$wm_wrapper" ]]; then
  echo "  PASS: ensure-autonomy: probe self-heals wrapper at stable path"
  pass=$((pass + 1))
else
  echo "  FAIL: ensure-autonomy: probe did not restore wrapper at stable path"
  fail=$((fail + 1))
fi

# ============================================================
echo ""
echo "=== read_config_strict (JSON-null semantics) ==="

RCS_DIR=$(mktemp -d "${TMPDIR:-/tmp}/read-config-strict-XXXXXX")

# Seed config.json with explicit JSON null, present non-null, and missing path.
cat > "$RCS_DIR/config.json" <<'JSON'
{
  "explicit_null": null,
  "present": "value",
  "nested": {"null_inner": null, "real": 42}
}
JSON

# Source pipeline-lib.sh in a subshell with CLAUDE_PLUGIN_DATA pinned.
strict_null=$(CLAUDE_PLUGIN_DATA="$RCS_DIR" bash -c "source '$PLUGIN_ROOT/bin/pipeline-lib.sh'; read_config_strict '.explicit_null'")
assert_eq "read_config_strict: explicit JSON null → empty" "" "$strict_null"

strict_missing=$(CLAUDE_PLUGIN_DATA="$RCS_DIR" bash -c "source '$PLUGIN_ROOT/bin/pipeline-lib.sh'; read_config_strict '.does_not_exist'")
assert_eq "read_config_strict: missing key → empty" "" "$strict_missing"

strict_present=$(CLAUDE_PLUGIN_DATA="$RCS_DIR" bash -c "source '$PLUGIN_ROOT/bin/pipeline-lib.sh'; read_config_strict '.present'")
assert_eq "read_config_strict: present key → value" "value" "$strict_present"

strict_nested_null=$(CLAUDE_PLUGIN_DATA="$RCS_DIR" bash -c "source '$PLUGIN_ROOT/bin/pipeline-lib.sh'; read_config_strict '.nested.null_inner'")
assert_eq "read_config_strict: nested null → empty" "" "$strict_nested_null"

strict_nested_real=$(CLAUDE_PLUGIN_DATA="$RCS_DIR" bash -c "source '$PLUGIN_ROOT/bin/pipeline-lib.sh'; read_config_strict '.nested.real'")
assert_eq "read_config_strict: nested numeric → string repr" "42" "$strict_nested_real"

# Contrast: regular read_config with default substitutes the default on null.
loose_null=$(CLAUDE_PLUGIN_DATA="$RCS_DIR" bash -c "source '$PLUGIN_ROOT/bin/pipeline-lib.sh'; read_config '.explicit_null' 'fallback'")
assert_eq "read_config: explicit JSON null still substitutes default" "fallback" "$loose_null"

# No config file → still empty (don't crash, don't print 'null').
RCS_NO_DIR=$(mktemp -d "${TMPDIR:-/tmp}/read-config-strict-no-XXXXXX")
strict_nofile=$(CLAUDE_PLUGIN_DATA="$RCS_NO_DIR" bash -c "source '$PLUGIN_ROOT/bin/pipeline-lib.sh'; read_config_strict '.anything'")
assert_eq "read_config_strict: missing config.json → empty" "" "$strict_nofile"
rm -rf "$RCS_NO_DIR"

# ============================================================
echo ""
echo "=== read_config parse-error distinction (H13) ==="

# Seed a corrupt config.json — jq must fail to parse → read_config emits
# log_error on stderr (previously a parse error was indistinguishable from
# a missing key, silently reverting every threshold to its compiled default).
RCS_BAD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/read-config-bad-XXXXXX")
printf '{ "broken": "missing-close-brace"' > "$RCS_BAD_DIR/config.json"

# 1. Default is returned (does not crash the caller).
bad_default=$(CLAUDE_PLUGIN_DATA="$RCS_BAD_DIR" bash -c "source '$PLUGIN_ROOT/bin/pipeline-lib.sh'; read_config '.anything' 'compiled-default'" 2>/dev/null)
assert_eq "H13: corrupt config.json returns compiled default" "compiled-default" "$bad_default"

# 2. stderr contains an ERROR log so the operator can see the parse failure.
#    Previously this was silent. Look for 'parse error' phrase from log_error.
bad_stderr=$(CLAUDE_PLUGIN_DATA="$RCS_BAD_DIR" bash -c "source '$PLUGIN_ROOT/bin/pipeline-lib.sh'; read_config '.anything' 'd'" 2>&1 >/dev/null)
if [[ "$bad_stderr" == *"parse error"* && "$bad_stderr" == *"ERROR"* ]]; then
  echo "  PASS: H13: corrupt config.json emits ERROR-level log on stderr"
  pass=$((pass + 1))
else
  echo "  FAIL: H13: expected ERROR + 'parse error' in stderr; got: ${bad_stderr}"
  fail=$((fail + 1))
fi

# 3. Sanity: a present key in a valid config.json must NOT log an error.
RCS_OK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/read-config-ok-XXXXXX")
printf '{"present": "value"}' > "$RCS_OK_DIR/config.json"
ok_stderr=$(CLAUDE_PLUGIN_DATA="$RCS_OK_DIR" bash -c "source '$PLUGIN_ROOT/bin/pipeline-lib.sh'; read_config '.present' 'd'" 2>&1 >/dev/null)
if [[ "$ok_stderr" != *"ERROR"* ]]; then
  echo "  PASS: H13: valid config.json with present key emits no ERROR"
  pass=$((pass + 1))
else
  echo "  FAIL: H13: unexpected ERROR for valid config: ${ok_stderr}"
  fail=$((fail + 1))
fi

# 4. Sanity: missing key in a valid config.json must NOT log an error either
#    (only true parse errors should be loud).
missing_stderr=$(CLAUDE_PLUGIN_DATA="$RCS_OK_DIR" bash -c "source '$PLUGIN_ROOT/bin/pipeline-lib.sh'; read_config '.does_not_exist' 'd'" 2>&1 >/dev/null)
if [[ "$missing_stderr" != *"ERROR"* ]]; then
  echo "  PASS: H13: valid config.json with missing key emits no ERROR (silent default is correct)"
  pass=$((pass + 1))
else
  echo "  FAIL: H13: missing-key path should be silent; got: ${missing_stderr}"
  fail=$((fail + 1))
fi

rm -rf "$RCS_BAD_DIR" "$RCS_OK_DIR"

# ============================================================
echo ""
echo "=== read_config key regex guard (M13) ==="

# Lock the read_config / read_config_strict key contract: only dot-notation
# identifiers are allowed; everything that smells like a jq expression
# (pipes, subscripts, backticks, semicolons, whitespace, empty, digit-start)
# must be rejected loudly with the default returned. There is no current
# dynamic caller, but the API has no guard — this fences off the injection
# surface before it exists.
RCS_M13_DIR=$(mktemp -d "${TMPDIR:-/tmp}/read-config-m13-XXXXXX")
printf '{"present":"value"}' > "$RCS_M13_DIR/config.json"

# Helper: run read_config / read_config_strict and capture both stdout and stderr.
_m13_run() {
  # $1 = fn (read_config or read_config_strict)
  # $2 = key
  # $3 = default (only used for read_config)
  local fn="$1" key="$2" default="${3:-}"
  if [[ "$fn" == "read_config" ]]; then
    CLAUDE_PLUGIN_DATA="$RCS_M13_DIR" bash -c "source '$PLUGIN_ROOT/bin/pipeline-lib.sh'; $fn \"\$1\" \"\$2\"" _ "$key" "$default"
  else
    CLAUDE_PLUGIN_DATA="$RCS_M13_DIR" bash -c "source '$PLUGIN_ROOT/bin/pipeline-lib.sh'; $fn \"\$1\"" _ "$key"
  fi
}

_m13_run_stderr() {
  local fn="$1" key="$2" default="${3:-}"
  if [[ "$fn" == "read_config" ]]; then
    CLAUDE_PLUGIN_DATA="$RCS_M13_DIR" bash -c "source '$PLUGIN_ROOT/bin/pipeline-lib.sh'; $fn \"\$1\" \"\$2\"" _ "$key" "$default" 2>&1 >/dev/null
  else
    CLAUDE_PLUGIN_DATA="$RCS_M13_DIR" bash -c "source '$PLUGIN_ROOT/bin/pipeline-lib.sh'; $fn \"\$1\"" _ "$key" 2>&1 >/dev/null
  fi
}

# Run one negative case for read_config: assert stdout==default AND stderr
# contains ERROR + 'non-conforming key'.
_m13_assert_reject() {
  local label="$1" key="$2"
  local out err
  out=$(_m13_run read_config "$key" 'fallback' 2>/dev/null)
  err=$(_m13_run_stderr read_config "$key" 'fallback')
  assert_eq "M13: $label → default returned" "fallback" "$out"
  if [[ "$err" == *"ERROR"* && "$err" == *"non-conforming key"* ]]; then
    echo "  PASS: M13: $label → ERROR log mentions 'non-conforming key'"
    pass=$((pass + 1))
  else
    echo "  FAIL: M13: $label → expected ERROR + 'non-conforming key' in stderr; got: ${err}"
    fail=$((fail + 1))
  fi
}

# 1. Pipe injection — would let a caller smuggle arbitrary jq.
_m13_assert_reject "pipe injection" '.present | error("pwn")'

# 2. Subscript — array/object indexing is not a key path.
_m13_assert_reject "subscript" '.present[0]'

# 3. Backtick — command-substitution shape.
_m13_assert_reject "backtick" '`whoami`'

# 4. Semicolon — statement separator inside jq filter.
_m13_assert_reject "semicolon" '.foo;rm -rf /'

# 5. Whitespace — space inside the key is never a valid dot path.
_m13_assert_reject "whitespace" '.foo bar'

# 6. Empty string — caller forgot to pass a key.
_m13_assert_reject "empty key" ''

# 7. Starts with digit — identifiers must start letter/underscore.
_m13_assert_reject "digit-start" '.1foo'

# 8. Positive: .present in valid config round-trips, no ERROR.
m13_ok_out=$(_m13_run read_config '.present' 'fallback' 2>/dev/null)
assert_eq "M13: positive .present → returns value" "value" "$m13_ok_out"
m13_ok_err=$(_m13_run_stderr read_config '.present' 'fallback')
if [[ "$m13_ok_err" != *"ERROR"* ]]; then
  echo "  PASS: M13: positive .present → no ERROR on stderr"
  pass=$((pass + 1))
else
  echo "  FAIL: M13: positive .present produced unexpected ERROR: ${m13_ok_err}"
  fail=$((fail + 1))
fi

# 9. Positive: missing key (jq path) — guard passes, missing-key fallback applies, no ERROR.
m13_missing_out=$(_m13_run read_config '.does_not_exist' 'fallback' 2>/dev/null)
assert_eq "M13: positive .does_not_exist → default (jq missing-key path)" "fallback" "$m13_missing_out"
m13_missing_err=$(_m13_run_stderr read_config '.does_not_exist' 'fallback')
if [[ "$m13_missing_err" != *"ERROR"* ]]; then
  echo "  PASS: M13: missing-key path still silent (M13 guard does not trigger)"
  pass=$((pass + 1))
else
  echo "  FAIL: M13: missing-key path should be silent; got: ${m13_missing_err}"
  fail=$((fail + 1))
fi

# 10. read_config_strict — at least one positive + one negative case.
m13_strict_ok=$(_m13_run read_config_strict '.present' 2>/dev/null)
assert_eq "M13: read_config_strict positive .present → value" "value" "$m13_strict_ok"

m13_strict_bad_out=$(_m13_run read_config_strict '.foo | something' 2>/dev/null)
assert_eq "M13: read_config_strict pipe injection → empty" "" "$m13_strict_bad_out"
m13_strict_bad_err=$(_m13_run_stderr read_config_strict '.foo | something')
if [[ "$m13_strict_bad_err" == *"ERROR"* && "$m13_strict_bad_err" == *"non-conforming key"* ]]; then
  echo "  PASS: M13: read_config_strict pipe injection → ERROR log mentions 'non-conforming key'"
  pass=$((pass + 1))
else
  echo "  FAIL: M13: read_config_strict pipe injection → expected ERROR + 'non-conforming key'; got: ${m13_strict_bad_err}"
  fail=$((fail + 1))
fi

rm -rf "$RCS_M13_DIR"

# ============================================================
# Data-dir canonicalization (pipeline-lib.sh _factory_expected_data_dir)
# ============================================================
echo ""
echo "--- data-dir canonicalization ---"

# Helper: source pipeline-lib.sh in a clean subshell and emit the resulting
# CLAUDE_PLUGIN_DATA value. We always run from PLUGIN_ROOT (a dev checkout
# outside ~/.claude/plugins/cache/), so the manifest-based fallback path
# is exercised here.
_canon_result() {
  local poisoned_dir="$1"
  CLAUDE_PLUGIN_DATA="$poisoned_dir" \
    bash -c "source '$PLUGIN_ROOT/bin/pipeline-lib.sh' 2>/dev/null; printf '%s' \"\$CLAUDE_PLUGIN_DATA\""
}

# Expected canonical dir: factory + marketplace name from marketplace.json.
_canon_marketplace=$(jq -r '.name // empty' "$PLUGIN_ROOT/.claude-plugin/marketplace.json" 2>/dev/null)
_canon_plugin=$(jq -r '.name // empty' "$PLUGIN_ROOT/.claude-plugin/plugin.json" 2>/dev/null)
_canon_expected="$HOME/.claude/plugins/data/${_canon_plugin}-${_canon_marketplace}"

# Case 1: poisoned to a foreign plugin dir → must rewrite to factory-<marketplace>.
_canon_foreign_result=$(_canon_result "$HOME/.claude/plugins/data/codex-openai-codex")
assert_eq "canonicalize: foreign plugin dir → rewritten to factory canonical" \
  "$_canon_expected" "$_canon_foreign_result"

# Case 2: factory-inline (--plugin-dir install flavor) → must be left untouched.
_canon_inline="$HOME/.claude/plugins/data/${_canon_plugin}-inline"
_canon_inline_result=$(_canon_result "$_canon_inline")
assert_eq "canonicalize: factory-inline → left untouched (own-plugin variant)" \
  "$_canon_inline" "$_canon_inline_result"

# Case 3: already-correct factory-<marketplace> → left untouched.
_canon_correct_result=$(_canon_result "$_canon_expected")
assert_eq "canonicalize: correct factory-<marketplace> → left untouched" \
  "$_canon_expected" "$_canon_correct_result"

unset _canon_marketplace _canon_plugin _canon_expected _canon_foreign_result \
      _canon_inline _canon_inline_result _canon_correct_result _canon_result

# ============================================================
echo ""
echo "=== Results ==="
echo "  Passed: $pass"
echo "  Failed: $fail"
echo "  Total:  $((pass + fail))"

[[ $fail -eq 0 ]] && exit 0 || exit 1
