#!/usr/bin/env bash
# Phase 7 verification tests
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

# ============================================================
echo "=== pipeline-quota-check (auto fallback) ==="

# Without Keychain or claude CLI, auto should return safe defaults
output=$(pipeline-quota-check --method auto 2>/dev/null)
assert_eq "auto returns JSON" "0" "$(printf '%s' "$output" | jq -e . >/dev/null 2>&1; echo $?)"
assert_eq "auto has five_hour" "true" "$(printf '%s' "$output" | jq -e '.five_hour' >/dev/null 2>&1 && echo true || echo false)"
assert_eq "auto has seven_day" "true" "$(printf '%s' "$output" | jq -e '.seven_day' >/dev/null 2>&1 && echo true || echo false)"
assert_eq "auto has detection_method" "true" "$(printf '%s' "$output" | jq -e '.detection_method' >/dev/null 2>&1 && echo true || echo false)"

# ============================================================
echo ""
echo "=== pipeline-quota-check (invalid method) ==="

assert_exit "invalid method exits 1" 1 pipeline-quota-check --method bogus

# ============================================================
echo ""
echo "=== pipeline-quota-check (headers stub) ==="

assert_exit "headers method exits 1" 1 pipeline-quota-check --method headers

# ============================================================
echo ""
echo "=== pipeline-model-router (within limits) ==="

quota='{"five_hour":{"utilization":30,"hourly_threshold":60,"over_threshold":false,"window_hour":3},"seven_day":{"utilization":40,"daily_threshold":57,"over_threshold":false,"window_day":4},"billing_mode":"subscription","detection_method":"oauth"}'

output=$(pipeline-model-router --quota "$quota" --tier routine 2>/dev/null)
assert_eq "within limits → proceed" "proceed" "$(printf '%s' "$output" | jq -r '.action')"
assert_eq "within limits → anthropic" "anthropic" "$(printf '%s' "$output" | jq -r '.provider')"
assert_eq "routine cap" "2" "$(printf '%s' "$output" | jq -r '.review_cap')"

output=$(pipeline-model-router --quota "$quota" --tier feature 2>/dev/null)
assert_eq "feature cap" "4" "$(printf '%s' "$output" | jq -r '.review_cap')"

output=$(pipeline-model-router --quota "$quota" --tier security 2>/dev/null)
assert_eq "security cap" "6" "$(printf '%s' "$output" | jq -r '.review_cap')"

# ============================================================
echo ""
echo "=== pipeline-model-router (5h over, 7d within, no ollama) ==="

quota='{"five_hour":{"utilization":95,"hourly_threshold":60,"over_threshold":true,"window_hour":3},"seven_day":{"utilization":40,"daily_threshold":57,"over_threshold":false,"window_day":4},"billing_mode":"subscription","detection_method":"oauth"}'

output=$(pipeline-model-router --quota "$quota" --tier routine 2>/dev/null)
assert_eq "5h over → wait" "wait" "$(printf '%s' "$output" | jq -r '.action')"
assert_eq "5h over trigger" "5h_over_no_ollama" "$(printf '%s' "$output" | jq -r '.trigger')"
assert_eq "wait has minutes" "true" "$(printf '%s' "$output" | jq -e '.wait_minutes' >/dev/null 2>&1 && echo true || echo false)"

# ============================================================
echo ""
echo "=== pipeline-model-router (7d over, no ollama) ==="

quota='{"five_hour":{"utilization":95,"hourly_threshold":60,"over_threshold":true,"window_hour":3},"seven_day":{"utilization":100,"daily_threshold":57,"over_threshold":true,"window_day":4},"billing_mode":"subscription","detection_method":"oauth"}'

output=$(pipeline-model-router --quota "$quota" --tier feature 2>/dev/null)
assert_eq "7d over → end_gracefully" "end_gracefully" "$(printf '%s' "$output" | jq -r '.action')"
assert_eq "7d over trigger" "7d_over_no_ollama" "$(printf '%s' "$output" | jq -r '.trigger')"

# ============================================================
echo ""
echo "=== pipeline-model-router (missing quota) ==="

assert_exit "missing quota exits 1" 1 pipeline-model-router --tier routine

# ============================================================
echo ""
echo "=== pipeline-model-router (invalid tier) ==="

assert_exit "invalid tier exits 1" 1 pipeline-model-router --quota '{}' --tier bogus

# ============================================================
echo ""
echo "=== pipeline-model-router (unknown flag) ==="

assert_exit "unknown flag exits 1" 1 pipeline-model-router --bogus

# ============================================================
echo ""
echo "=== pipeline-model-router (5h over with ollama enabled) ==="

# Write config that enables Ollama but Ollama is not running
mkdir -p "$CLAUDE_PLUGIN_DATA"
printf '{"localLlm":{"enabled":true,"ollamaUrl":"http://localhost:19999","model":"test-model"}}' > "$CLAUDE_PLUGIN_DATA/config.json"

quota='{"five_hour":{"utilization":95,"hourly_threshold":60,"over_threshold":true,"window_hour":3},"seven_day":{"utilization":40,"daily_threshold":57,"over_threshold":false,"window_day":4},"billing_mode":"subscription","detection_method":"oauth"}'

output=$(pipeline-model-router --quota "$quota" --tier routine 2>/dev/null)
# Ollama unreachable → should fall back to wait
assert_eq "ollama unreachable → wait" "wait" "$(printf '%s' "$output" | jq -r '.action')"

# ============================================================
echo ""
echo "=== pipeline-quota-check (auto with safe defaults shape) ==="

# Verify the safe defaults have the correct shape
output=$(pipeline-quota-check --method auto 2>/dev/null)
assert_eq "five_hour.over_threshold" "false" "$(printf '%s' "$output" | jq -r '.five_hour.over_threshold')"
assert_eq "seven_day.over_threshold" "false" "$(printf '%s' "$output" | jq -r '.seven_day.over_threshold')"

# ============================================================
echo ""
echo "=== Results ==="
echo "  Passed: $pass"
echo "  Failed: $fail"
echo "  Total:  $((pass + fail))"

rm -rf "$CLAUDE_PLUGIN_DATA"

[[ $fail -eq 0 ]] && exit 0 || exit 1
