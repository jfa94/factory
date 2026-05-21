#!/usr/bin/env bash
# version-parity.sh — manifests must agree on the plugin version. Locks
# H16: marketplace.json drifted two minor versions behind plugin.json
# because nothing ever cross-checked them. Marketplace clients install
# the version listed in marketplace.json; drift means users get a stale
# build of the plugin with none of the recent fixes.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLUGIN_MANIFEST="$PLUGIN_ROOT/.claude-plugin/plugin.json"
MARKETPLACE_MANIFEST="$PLUGIN_ROOT/.claude-plugin/marketplace.json"

pass=0
fail=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"; pass=$((pass+1))
  else
    echo "  FAIL: $label (expected '$expected', got '$actual')"; fail=$((fail+1))
  fi
}

fail_msg() {
  echo "  FAIL: $1"; fail=$((fail+1))
}

echo "=== plugin.json / marketplace.json version parity ==="

assert_eq "plugin.json exists" "true" \
  "$([[ -f "$PLUGIN_MANIFEST" ]] && echo true || echo false)"
assert_eq "marketplace.json exists" "true" \
  "$([[ -f "$MARKETPLACE_MANIFEST" ]] && echo true || echo false)"

plugin_v=$(jq -r '.version' "$PLUGIN_MANIFEST")
marketplace_v=$(jq -r '.plugins[] | select(.name=="factory") | .version' "$MARKETPLACE_MANIFEST")

if [[ "$plugin_v" == "$marketplace_v" ]]; then
  echo "  PASS: plugin.json and marketplace.json agree on version ($plugin_v)"
  pass=$((pass+1))
else
  fail_msg "version drift: plugin.json=$plugin_v marketplace.json=$marketplace_v"
fi

echo ""
echo "================================"
echo "Version-parity tests: $pass passed, $fail failed"
echo "================================"

[[ $fail -eq 0 ]]
