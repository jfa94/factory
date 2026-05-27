#!/usr/bin/env bash
# run-all.sh — aggregate runner for bin/tests/*.sh.
#
# Discovers every sibling .sh file (excluding itself), runs each serially in
# a subshell so a test's `set -euo pipefail` cannot abort the runner, records
# exit code + wall time, and prints a one-line-per-test summary followed by
# an aggregate count. Exits 0 iff every executed test exited 0.
#
# Flags:
#   --verbose     stream each test's stdout/stderr live (default: capture
#                 and only print on failure)
#   --filter GLOB run only tests whose basename matches GLOB (e.g. wait-pr-*)
#   --list        print the discovered + filtered + post-skip test list and
#                 exit 0; useful for CI debugging
#
# Skip list: bin/tests/.skip (one basename per line; `#` comments allowed).
# Use sparingly — the skip list exists to quarantine env-dependent tests,
# never to mask a real regression. Every skip entry must carry an inline
# `# reason: ...` comment.

set -uo pipefail   # NOT -e: per-test failures must not abort the loop

cd "$(dirname "$0")"
shopt -s nullglob

verbose=0
filter='*'
list_only=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --verbose) verbose=1; shift ;;
    --filter)
      [[ $# -lt 2 ]] && { echo "--filter requires an argument" >&2; exit 2; }
      filter="$2"; shift 2 ;;
    --list)    list_only=1; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

# Discover tests: every *.sh except this runner.
all_tests=()
for f in *.sh; do
  [[ "$f" == "run-all.sh" ]] && continue
  all_tests+=("$f")
done

# Apply skip list.
declare -A skip
if [[ -f .skip ]]; then
  while IFS= read -r line; do
    line="${line%%#*}"             # strip comments
    line="${line//[[:space:]]/}"   # strip whitespace
    [[ -z "$line" ]] && continue
    skip["$line"]=1
  done < .skip
fi

# Apply filter + skip.
tests=()
for t in "${all_tests[@]}"; do
  # shellcheck disable=SC2053
  [[ "$t" != $filter ]] && continue
  [[ -n "${skip[$t]:-}" ]] && continue
  tests+=("$t")
done

if (( list_only )); then
  if (( ${#tests[@]} == 0 )); then
    echo "no tests matched filter '$filter' (after skip-list)" >&2
  else
    printf '%s\n' "${tests[@]}"
  fi
  exit 0
fi

if (( ${#tests[@]} == 0 )); then
  echo "no tests matched filter '$filter' (after skip-list)" >&2
  exit 2
fi

# Colors if stdout is a TTY.
if [[ -t 1 ]]; then
  c_pass=$'\033[32m'
  c_fail=$'\033[31m'
  c_skip=$'\033[33m'
  c_reset=$'\033[0m'
else
  c_pass=''; c_fail=''; c_skip=''; c_reset=''
fi

pass=0
fail=0
failed_names=()
overall_start=$(date +%s)

for t in "${tests[@]}"; do
  start=$(date +%s)
  if (( verbose )); then
    printf '=== %s ===\n' "$t"
    if bash "./$t"; then rc=0; else rc=$?; fi
    out=''
  else
    out=$(bash "./$t" 2>&1)
    rc=$?
  fi
  elapsed=$(( $(date +%s) - start ))

  if (( rc == 0 )); then
    printf '  %sPASS%s %-32s (%ds)\n' "$c_pass" "$c_reset" "$t" "$elapsed"
    pass=$((pass + 1))
  else
    printf '  %sFAIL%s %-32s (%ds, exit=%d)\n' "$c_fail" "$c_reset" "$t" "$elapsed" "$rc"
    fail=$((fail + 1))
    failed_names+=("$t")
    if (( ! verbose )); then
      printf '    --- captured output ---\n'
      if [[ -n "$out" ]]; then
        while IFS= read -r line; do
          printf '    %s\n' "$line"
        done <<< "$out"
      fi
      printf '    --- end ---\n'
    fi
  fi
done

# Print skipped (informational).
# Guard against bash unbound-variable quirk with empty associative arrays.
_skip_keys=("${!skip[@]}")
if (( ${#_skip_keys[@]} > 0 )); then
  echo ""
  echo "Skipped (see .skip for reasons):"
  for s in "${_skip_keys[@]}"; do
    printf '  %sSKIP%s %s\n' "$c_skip" "$c_reset" "$s"
  done
fi

total_elapsed=$(( $(date +%s) - overall_start ))
echo ""
echo "=== Summary ==="
printf 'Ran %d test(s) in %ds: %s%d passed%s, %s%d failed%s\n' \
  "${#tests[@]}" "$total_elapsed" \
  "$c_pass" "$pass" "$c_reset" \
  "$c_fail" "$fail" "$c_reset"

if (( fail > 0 )); then
  echo ""
  echo "Failing tests:"
  printf '  %s\n' "${failed_names[@]}"
  exit 1
fi

exit 0
