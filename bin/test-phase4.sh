#!/usr/bin/env bash
# Phase 4 verification tests
set -euo pipefail

export CLAUDE_PLUGIN_DATA=$(mktemp -d)
export PATH="$(cd "$(dirname "$0")" && pwd):$PATH"

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

assert_exit() {
  local label="$1" expected="$2"
  shift 2
  local actual
  set +e
  "$@" >/dev/null 2>&1
  actual=$?
  set -e
  assert_eq "$label" "$expected" "$actual"
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "  PASS: $label"
    pass=$((pass + 1))
  else
    echo "  FAIL: $label (expected to contain '$needle')"
    fail=$((fail + 1))
  fi
}

# ============================================================
echo "=== pipeline-detect-reviewer ==="

# Without Codex installed, should fall back to claude-code
output=$(pipeline-detect-reviewer 2>/dev/null)
assert_eq "fallback reviewer" "claude-code" "$(echo "$output" | jq -r '.reviewer')"
assert_eq "fallback agent" "task-reviewer" "$(echo "$output" | jq -r '.agent')"

# With --base flag
output=$(pipeline-detect-reviewer --base main 2>/dev/null)
assert_eq "base flag accepted" "claude-code" "$(echo "$output" | jq -r '.reviewer')"

# Always exits 0
assert_exit "always exits 0" 0 pipeline-detect-reviewer

# ============================================================
echo ""
echo "=== pipeline-parse-review (APPROVE) ==="

approve_input='## Review Verdict

**VERDICT:** APPROVE
**ROUND:** 2
**CONFIDENCE:** HIGH

## Findings

### [NON-BLOCKING] Minor style issue
- **File:** src/utils.ts:10
- **Severity:** minor
- **Category:** style
- **Description:** Consider using const instead of let

## Acceptance Criteria Check

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Users can log in | PASS | src/auth.ts:42 |
| Password is hashed | PASS | src/auth.ts:55 |

## Summary
Code looks correct and well-tested.'

output=$(printf '%s' "$approve_input" | pipeline-parse-review 2>/dev/null)
assert_eq "verdict APPROVE" "APPROVE" "$(echo "$output" | jq -r '.verdict')"
assert_eq "round 2" "2" "$(echo "$output" | jq -r '.round')"
assert_eq "confidence HIGH" "HIGH" "$(echo "$output" | jq -r '.confidence')"
assert_eq "reviewer claude-code" "claude-code" "$(echo "$output" | jq -r '.reviewer')"
assert_eq "blocking count 0" "0" "$(echo "$output" | jq -r '.blocking_count')"
assert_eq "non-blocking count 1" "1" "$(echo "$output" | jq -r '.non_blocking_count')"
assert_eq "criteria passed 2" "2" "$(echo "$output" | jq -r '.criteria_passed')"
assert_eq "criteria failed 0" "0" "$(echo "$output" | jq -r '.criteria_failed')"

# ============================================================
echo ""
echo "=== pipeline-parse-review (REQUEST_CHANGES) ==="

changes_input='## Review Verdict

**VERDICT:** REQUEST_CHANGES
**ROUND:** 1
**CONFIDENCE:** HIGH

## Findings

### [BLOCKING] SQL injection vulnerability
- **File:** src/db.ts:23
- **Severity:** critical
- **Category:** security
- **Description:** User input is concatenated directly into SQL query
- **Suggestion:** Use parameterized queries

### [BLOCKING] Missing null check
- **File:** src/handler.ts:15
- **Severity:** major
- **Category:** correctness
- **Description:** req.body.email is not validated before use

### [NON-BLOCKING] Unused import
- **File:** src/handler.ts:1
- **Severity:** minor
- **Category:** style
- **Description:** lodash is imported but never used

## Acceptance Criteria Check

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Input validation | FAIL | no validation in handler.ts |
| Data persisted | PASS | src/db.ts:30 |

## Holdout Criteria Check

| Withheld Criterion | Status | Evidence |
|--------------------|--------|----------|
| Rate limiting | FAIL | no rate limit middleware found |
| Error logging | PASS | src/logger.ts:12 |

## Summary
Critical security issues and missing validation.'

output=$(printf '%s' "$changes_input" | pipeline-parse-review 2>/dev/null)
assert_eq "verdict REQUEST_CHANGES" "REQUEST_CHANGES" "$(echo "$output" | jq -r '.verdict')"
assert_eq "round 1" "1" "$(echo "$output" | jq -r '.round')"
assert_eq "blocking count 2" "2" "$(echo "$output" | jq -r '.blocking_count')"
assert_eq "non-blocking count 1" "1" "$(echo "$output" | jq -r '.non_blocking_count')"
assert_eq "criteria passed 1" "1" "$(echo "$output" | jq -r '.criteria_passed')"
assert_eq "criteria failed 1" "1" "$(echo "$output" | jq -r '.criteria_failed')"
assert_eq "holdout passed 1" "1" "$(echo "$output" | jq -r '.holdout_passed')"
assert_eq "holdout failed 1" "1" "$(echo "$output" | jq -r '.holdout_failed')"

# Check finding details
assert_eq "first finding title" "SQL injection vulnerability" "$(echo "$output" | jq -r '.findings[0].title')"
assert_eq "first finding blocking" "true" "$(echo "$output" | jq -r '.findings[0].blocking')"
assert_eq "first finding severity" "critical" "$(echo "$output" | jq -r '.findings[0].severity')"
assert_eq "first finding category" "security" "$(echo "$output" | jq -r '.findings[0].category')"

# ============================================================
echo ""
echo "=== pipeline-parse-review (NEEDS_DISCUSSION) ==="

discuss_input='## Review Verdict

**VERDICT:** NEEDS_DISCUSSION
**ROUND:** 3
**CONFIDENCE:** LOW

## Findings

## Acceptance Criteria Check

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Feature works | PASS | src/feature.ts:10 |

## Summary
Architectural concern needs human input.'

output=$(printf '%s' "$discuss_input" | pipeline-parse-review 2>/dev/null)
assert_eq "verdict NEEDS_DISCUSSION" "NEEDS_DISCUSSION" "$(echo "$output" | jq -r '.verdict')"
assert_eq "round 3" "3" "$(echo "$output" | jq -r '.round')"
assert_eq "confidence LOW" "LOW" "$(echo "$output" | jq -r '.confidence')"

# ============================================================
echo ""
echo "=== pipeline-parse-review (empty input) ==="

set +e
printf '' | pipeline-parse-review >/dev/null 2>&1
exit_code=$?
set -e
assert_eq "empty input exits 1" "1" "$exit_code"

# ============================================================
echo ""
echo "=== pipeline-parse-review (no verdict) ==="

set +e
printf 'Some random review text without structured output' | pipeline-parse-review >/dev/null 2>&1
exit_code=$?
set -e
assert_eq "no verdict exits 1" "1" "$exit_code"

# ============================================================
echo ""
echo "=== pipeline-parse-review (codex JSON passthrough) ==="

codex_json='{"verdict":"APPROVE","round":1,"findings":[],"summary":"ok"}'
output=$(printf '%s' "$codex_json" | pipeline-parse-review --reviewer codex 2>/dev/null)
assert_eq "codex verdict" "APPROVE" "$(echo "$output" | jq -r '.verdict')"
assert_eq "codex reviewer tag" "codex" "$(echo "$output" | jq -r '.reviewer')"

# ============================================================
echo ""
echo "=== pipeline-parse-review (codex invalid JSON) ==="

set +e
printf 'not json' | pipeline-parse-review --reviewer codex >/dev/null 2>&1
exit_code=$?
set -e
assert_eq "codex invalid JSON exits 1" "1" "$exit_code"

# ============================================================
echo ""
echo "=== pipeline-coverage-gate (coverage increase) ==="

before_file="$CLAUDE_PLUGIN_DATA/before.json"
after_file="$CLAUDE_PLUGIN_DATA/after.json"

cat > "$before_file" << 'COVJSON'
{
  "total": {
    "lines": {"total": 100, "covered": 80, "skipped": 0, "pct": 80},
    "branches": {"total": 50, "covered": 40, "skipped": 0, "pct": 80},
    "functions": {"total": 30, "covered": 24, "skipped": 0, "pct": 80},
    "statements": {"total": 120, "covered": 96, "skipped": 0, "pct": 80}
  }
}
COVJSON

cat > "$after_file" << 'COVJSON'
{
  "total": {
    "lines": {"total": 120, "covered": 102, "skipped": 0, "pct": 85},
    "branches": {"total": 60, "covered": 51, "skipped": 0, "pct": 85},
    "functions": {"total": 35, "covered": 30, "skipped": 0, "pct": 85.71},
    "statements": {"total": 140, "covered": 119, "skipped": 0, "pct": 85}
  }
}
COVJSON

output=$(pipeline-coverage-gate "$before_file" "$after_file" 2>/dev/null)
assert_eq "increase passes" "true" "$(echo "$output" | jq -r '.passed')"
assert_eq "before lines" "80" "$(echo "$output" | jq -r '.before.lines')"
assert_eq "after lines" "85" "$(echo "$output" | jq -r '.after.lines')"
assert_eq "delta lines positive" "5" "$(echo "$output" | jq -r '.delta.lines')"

# ============================================================
echo ""
echo "=== pipeline-coverage-gate (coverage decrease) ==="

cat > "$after_file" << 'COVJSON'
{
  "total": {
    "lines": {"total": 120, "covered": 90, "skipped": 0, "pct": 75},
    "branches": {"total": 60, "covered": 51, "skipped": 0, "pct": 85},
    "functions": {"total": 35, "covered": 30, "skipped": 0, "pct": 85.71},
    "statements": {"total": 140, "covered": 119, "skipped": 0, "pct": 85}
  }
}
COVJSON

set +e
output=$(pipeline-coverage-gate "$before_file" "$after_file" 2>/dev/null)
exit_code=$?
set -e
assert_eq "decrease fails" "false" "$(echo "$output" | jq -r '.passed')"
assert_eq "decrease exit 1" "1" "$exit_code"
assert_eq "delta lines negative" "-5" "$(echo "$output" | jq -r '.delta.lines')"

# ============================================================
echo ""
echo "=== pipeline-coverage-gate (no change) ==="

cp "$before_file" "$after_file"
output=$(pipeline-coverage-gate "$before_file" "$after_file" 2>/dev/null)
assert_eq "no change passes" "true" "$(echo "$output" | jq -r '.passed')"
assert_eq "delta lines zero" "0" "$(echo "$output" | jq -r '.delta.lines')"

# ============================================================
echo ""
echo "=== pipeline-coverage-gate (missing file) ==="

set +e
output=$(pipeline-coverage-gate "$CLAUDE_PLUGIN_DATA/nonexistent.json" "$after_file" 2>/dev/null)
exit_code=$?
set -e
assert_eq "missing before exits 1" "1" "$exit_code"
assert_eq "missing before passed false" "false" "$(echo "$output" | jq -r '.passed')"

# ============================================================
echo ""
echo "=== pipeline-coverage-gate (simple numeric format) ==="

cat > "$before_file" << 'COVJSON'
{"total": {"lines": 80, "branches": 75, "functions": 90, "statements": 85}}
COVJSON

cat > "$after_file" << 'COVJSON'
{"total": {"lines": 82, "branches": 75, "functions": 92, "statements": 85}}
COVJSON

output=$(pipeline-coverage-gate "$before_file" "$after_file" 2>/dev/null)
assert_eq "simple format passes" "true" "$(echo "$output" | jq -r '.passed')"
assert_eq "simple format lines" "82" "$(echo "$output" | jq -r '.after.lines')"

# ============================================================
echo ""
echo "=== pipeline-coverage-gate (invalid JSON) ==="

printf 'not valid json' > "$before_file"
cat > "$after_file" << 'COVJSON'
{"total": {"lines": 80, "branches": 75, "functions": 90, "statements": 85}}
COVJSON

set +e
output=$(pipeline-coverage-gate "$before_file" "$after_file" 2>/dev/null)
exit_code=$?
set -e
assert_eq "invalid JSON exits 1" "1" "$exit_code"
assert_eq "invalid JSON passed false" "false" "$(echo "$output" | jq -r '.passed')"

# ============================================================
echo ""
echo "=== Skill & Agent files exist ==="

assert_eq "review-protocol SKILL.md exists" "true" \
  "$([[ -f "$(dirname "$0")/../skills/review-protocol/SKILL.md" ]] && echo true || echo false)"
assert_eq "task-reviewer.md exists" "true" \
  "$([[ -f "$(dirname "$0")/../agents/task-reviewer.md" ]] && echo true || echo false)"

# ============================================================
echo ""
echo "=== Results ==="
echo "  Passed: $pass"
echo "  Failed: $fail"
echo "  Total:  $((pass + fail))"

rm -rf "$CLAUDE_PLUGIN_DATA"

[[ $fail -eq 0 ]] && exit 0 || exit 1
