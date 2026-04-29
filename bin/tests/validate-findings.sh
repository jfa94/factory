#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source bin/pipeline-lib.sh

PASS=0; FAIL=0
pass() { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL+1)); }

# Test 1: empty diff keeps verdict, adds marker
empty_diff=$(mktemp); printf '' > "$empty_diff"
input='{"verdict":"REQUEST_CHANGES","findings":[{"severity":"critical","verbatim_line":"phantom"}],"summary":"x","blocking_count":1,"non_blocking_count":0,"declared_blockers":1}'
out=$(printf '%s' "$input" | validate_findings "$empty_diff")
verdict=$(printf '%s' "$out" | jq -r '.verdict')
[[ "$verdict" == "REQUEST_CHANGES" ]] && pass "empty-diff: verdict preserved" || fail "empty-diff verdict: $verdict"
summary=$(printf '%s' "$out" | jq -r '.summary')
[[ "$summary" == *"diff empty"* ]] && pass "empty-diff: marker appended" || fail "empty-diff marker: $summary"
rm -f "$empty_diff"

# Test 2: all blockers unverifiable — verdict stays REQUEST_CHANGES
diff_file=$(mktemp); printf 'unrelated diff text\n' > "$diff_file"
input='{"verdict":"REQUEST_CHANGES","findings":[{"severity":"critical","verbatim_line":"this-string-is-not-in-the-diff"}],"summary":"y","blocking_count":1,"non_blocking_count":0,"declared_blockers":1}'
out=$(printf '%s' "$input" | validate_findings "$diff_file")
verdict=$(printf '%s' "$out" | jq -r '.verdict')
[[ "$verdict" == "REQUEST_CHANGES" ]] && pass "all-unverifiable: verdict preserved" || fail "all-unverifiable verdict: $verdict (was downgrade)"
blocking=$(printf '%s' "$out" | jq -r '.blocking_count')
[[ "$blocking" == "0" ]] && pass "all-unverifiable: blocking_count=0" || fail "blocking_count: $blocking"
summary=$(printf '%s' "$out" | jq -r '.summary')
[[ "$summary" == *"dropped 1 unverifiable"* ]] && pass "unverifiable: marker present" || fail "unverifiable marker: $summary"
rm -f "$diff_file"

# Test 3: blocker IS in diff — verbatim_line found, kept
diff_file=$(mktemp); printf 'a\nthis-string-IS-here\nb\n' > "$diff_file"
input='{"verdict":"REQUEST_CHANGES","findings":[{"severity":"critical","verbatim_line":"this-string-IS-here"}],"summary":"z","blocking_count":1,"non_blocking_count":0,"declared_blockers":1}'
out=$(printf '%s' "$input" | validate_findings "$diff_file")
blocking=$(printf '%s' "$out" | jq -r '.blocking_count')
[[ "$blocking" == "1" ]] && pass "verifiable: kept blocking_count=1" || fail "verifiable blocking_count: $blocking"
verdict=$(printf '%s' "$out" | jq -r '.verdict')
[[ "$verdict" == "REQUEST_CHANGES" ]] && pass "verifiable: verdict preserved" || fail "verifiable verdict: $verdict"
rm -f "$diff_file"

printf 'Results: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]] || exit 1
