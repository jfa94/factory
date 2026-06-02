#!/usr/bin/env bash
# secret-patterns.sh — unit tests for bin/_secret-patterns.sh (redact_secrets).
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=/dev/null
source "$PLUGIN_ROOT/bin/_secret-patterns.sh"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

# Assemble real contiguous tokens at runtime so this file carries no committable
# secret (the "AKIA""..." split is two string literals concatenated by bash).
AKIA_KEY="AKIA""IOSFODNN7EXAMPLE"

# Case 1: an AWS access key is redacted to [REDACTED].
t_redacts_akia() {
  local out
  out=$(printf 'leak: %s end\n' "$AKIA_KEY" | redact_secrets)
  printf '%s' "$out" | grep -q '\[REDACTED\]' || fail "akia: expected [REDACTED]; got '$out'"
  if printf '%s' "$out" | grep -q "$AKIA_KEY"; then fail "akia: raw key still present: '$out'"; fi
  pass "redacts AWS access key"
}

# Case 2: benign text is left byte-for-byte untouched.
t_keeps_benign() {
  local in='const total = items.length + 1' out
  out=$(printf '%s\n' "$in" | redact_secrets)
  [[ "$out" == "$in" ]] || fail "benign: text was altered: '$out'"
  pass "leaves benign text untouched"
}

# Case 3: redaction preserves JSON validity (secret sits inside a string value).
t_preserves_json() {
  local in out
  in=$(jq -nc --arg k "$AKIA_KEY" '{results:[{lines:("x="+$k)}]}')
  out=$(printf '%s' "$in" | redact_secrets)
  printf '%s' "$out" | jq -e '.' >/dev/null || fail "json: redacted output not valid JSON: '$out'"
  if printf '%s' "$out" | grep -q "$AKIA_KEY"; then fail "json: raw key leaked: '$out'"; fi
  pass "preserves JSON validity while redacting"
}

# Case 4: multiple distinct secrets on one line are all redacted.
t_redacts_multiple() {
  local gh out
  gh="ghp_$(printf 'A%.0s' {1..36})"   # ghp_ + 36 chars → matches ghp_[A-Za-z0-9]{36}
  out=$(printf 'a %s b %s c\n' "$AKIA_KEY" "$gh" | redact_secrets)
  if printf '%s' "$out" | grep -q "$AKIA_KEY"; then fail "multi: AKIA leaked: '$out'"; fi
  if printf '%s' "$out" | grep -q "$gh"; then fail "multi: ghp leaked: '$out'"; fi
  pass "redacts multiple secrets on one line"
}

# Case 5: empty input → empty output, no error under set -e.
t_empty() {
  local out; out=$(printf '' | redact_secrets)
  [[ -z "$out" ]] || fail "empty: expected empty output, got '$out'"
  pass "empty input yields empty output"
}

# Case 6: a literal "private_key" JSON object stays valid JSON after redaction
# (the quote-anchored pattern must not consume JSON structural syntax), and the
# PEM marker is still redacted by the value-only sibling pattern.
t_private_key_json() {
  local in out
  in='{"private_key": "-----BEGIN PRIVATE KEY-----"}'
  out=$(printf '%s\n' "$in" | redact_secrets)
  printf '%s' "$out" | jq -e '.' >/dev/null || fail "pk: not valid JSON after redaction: '$out'"
  if printf '%s' "$out" | grep -q 'BEGIN PRIVATE KEY'; then fail "pk: PEM marker leaked: '$out'"; fi
  printf '%s' "$out" | jq -e 'has("private_key")' >/dev/null || fail "pk: private_key key destroyed: '$out'"
  pass "private_key JSON stays valid + marker redacted"
}

t_redacts_akia; t_keeps_benign; t_preserves_json; t_redacts_multiple; t_empty; t_private_key_json
printf 'all secret-patterns tests passed\n'
