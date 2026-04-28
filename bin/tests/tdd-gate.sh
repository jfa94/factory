#!/usr/bin/env bash
# tdd-gate.sh — structural tests for bin/pipeline-tdd-gate.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GATE="$PLUGIN_ROOT/bin/pipeline-tdd-gate"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

_mk_repo() {
  local dir="$1"
  mkdir -p "$dir"
  ( cd "$dir" && git init -q && git checkout -q -b staging
    mkdir src tests
    printf 'x' > src/.keep && printf 'x' > tests/.keep
    git add . && git -c user.email=t@t -c user.name=t commit -q -m "init"
    git checkout -q -b feat/task-001
  )
}
_commit() {
  local dir="$1" msg="$2"; shift 2
  ( cd "$dir"
    for f in "$@"; do mkdir -p "$(dirname "$f")"; printf 'x%s' "$RANDOM" >> "$f"; done
    git add -A && git -c user.email=t@t -c user.name=t commit -q -m "$msg"
  )
}

# Test 1: pass case — test-only commit precedes impl commit.
case1() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  _commit "$repo" "test(x): failing [task-001]" "tests/x.test.ts"
  _commit "$repo" "feat(x): impl [task-001]"    "src/x.ts"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-001 --base staging )
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case1 expected exit 0, got $rc"; fi
  printf '%s' "$out" | jq -e '.ok == true' >/dev/null \
    || fail "case1 expected ok=true in JSON"
  pass "case1: test-before-impl passes gate"
}

# Test 2: fail case — impl commit without any preceding test-only commit.
case2() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  _commit "$repo" "feat(x): impl [task-001]" "src/x.ts"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-001 --base staging )
  rc=$?
  set -e
  if [[ $rc -ne 1 ]]; then fail "case2 expected exit 1, got $rc"; fi
  printf '%s' "$out" | jq -e '.ok == false' >/dev/null \
    || fail "case2 expected ok=false in JSON"
  pass "case2: impl-without-test fails gate (exit 1, ok=false)"
}

# Test 3: skip case — diff is tests-only.
case3() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  _commit "$repo" "test(x): only tests [task-001]" "tests/x.test.ts"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-001 --base staging )
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case3 expected exit 0, got $rc"; fi
  printf '%s' "$out" | jq -e '.exempt == true' >/dev/null \
    || fail "case3 expected exempt=true in JSON"
  pass "case3: tests-only diff is exempt"
}

# Test 4: exempt case — tasks.json marks task as tdd_exempt.
case4() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  mkdir -p "$repo/specs/current"
  cat > "$repo/specs/current/tasks.json" <<JSON
{"tasks":[{"task_id":"task-001","tdd_exempt":true}]}
JSON
  ( cd "$repo" && git add specs && git -c user.email=t@t -c user.name=t commit -q -m "spec" )
  _commit "$repo" "feat(x): impl [task-001]" "src/x.ts"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-001 --base staging --spec-dir specs/current )
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case4 expected exit 0, got $rc"; fi
  printf '%s' "$out" | jq -e '.exempt == true' >/dev/null \
    || fail "case4 expected exempt=true in JSON"
  pass "case4: tdd_exempt flag respected"
}

case4b() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  mkdir -p "$repo/specs/current"
  cat > "$repo/specs/current/tasks.json" <<JSON
{"tasks":[{"task_id":"task-001","tdd_exempt":true}]}
JSON
  ( cd "$repo" && git add specs && git -c user.email=t@t -c user.name=t commit -q -m "spec" )
  _commit "$repo" "feat(x): impl [task-001]" "src/x.ts"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-001 --base staging --spec-dir specs/current )
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case4b expected exit 0, got $rc"; fi
  printf '%s' "$out" | jq -e '.exempt == true' >/dev/null \
    || fail "case4b: tdd_exempt with .task_id schema not honored"
  pass "case4b: tdd_exempt respected with canonical .task_id schema"
}

case5() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  # Create a side branch, modify a file, then merge it into feat/task-001.
  ( cd "$repo"
    git checkout -q staging
    git checkout -q -b side
    printf 'y' > other.txt
    git add other.txt && git -c user.email=t@t -c user.name=t commit -q -m "side"
    git checkout -q feat/task-001
    git -c user.email=t@t -c user.name=t merge --no-ff -m "merge side [task-001]" side
  )
  _commit "$repo" "feat(x): impl [task-001]" "src/x.ts"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-001 --base staging )
  rc=$?
  set -e
  if [[ $rc -ne 1 ]]; then fail "case5 expected exit 1 (merge must not count as test-only), got $rc"; fi
  printf '%s' "$out" | jq -e '.ok == false' >/dev/null || fail "case5 expected ok=false"
  pass "case5: merge commit does not count as test-only"
}

case6() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-001 --base nonexistent-ref )
  rc=$?
  set -e
  if [[ $rc -ne 1 ]]; then fail "case6 expected exit 1 for missing base ref, got $rc"; fi
  printf '%s' "$out" | jq -e '.error == "base_ref_not_found"' >/dev/null \
    || fail "case6 expected error=base_ref_not_found"
  pass "case6: missing base ref errors with JSON"
}

# Test 7: no --base flag; only origin/staging exists → gate uses it and passes.
case7() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  ( cd "$repo"
    git update-ref refs/remotes/origin/staging "$(git rev-parse staging)"
    git branch -d staging
  )
  _commit "$repo" "test(x): failing [task-007]" "tests/x.test.ts"
  _commit "$repo" "feat(x): impl [task-007]"    "src/x.ts"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-007 )
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case7 expected exit 0 (origin/staging fallback), got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.ok == true' >/dev/null \
    || fail "case7 expected ok=true; got $out"
  pass "case7: origin/staging fallback — no local staging"
}

# Test 8: explicit --base staging with no local staging → base_ref_not_found (backwards compat).
case8() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  ( cd "$repo"
    git update-ref refs/remotes/origin/staging "$(git rev-parse staging)"
    git branch -d staging
  )
  _commit "$repo" "feat(x): impl [task-008]" "src/x.ts"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-008 --base staging )
  rc=$?
  set -e
  if [[ $rc -ne 1 ]]; then fail "case8 expected exit 1 for explicit --base staging, got $rc"; fi
  printf '%s' "$out" | jq -e '.error == "base_ref_not_found"' >/dev/null \
    || fail "case8 expected error=base_ref_not_found; got $out"
  pass "case8: explicit --base staging still errors when local staging missing"
}

# ---- B1: extended language test-path coverage ----

# Go: foo_test.go is a test path.
case_go_test() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  _commit "$repo" "test(go): failing [task-go]"  "pkg/foo_test.go"
  _commit "$repo" "feat(go): impl [task-go]"     "pkg/foo.go"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-go --base staging )
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case_go_test expected exit 0, got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.ok == true' >/dev/null \
    || fail "case_go_test expected ok=true"
  pass "case_go_test: Go _test.go recognised as test path"
}

# Ruby: foo_spec.rb is a test path.
case_ruby_spec() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  _commit "$repo" "test(rb): failing [task-rb]"  "spec/foo_spec.rb"
  _commit "$repo" "feat(rb): impl [task-rb]"     "lib/foo.rb"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-rb --base staging )
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case_ruby_spec expected exit 0, got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.ok == true' >/dev/null \
    || fail "case_ruby_spec expected ok=true"
  pass "case_ruby_spec: Ruby _spec.rb recognised as test path"
}

# Java: FooTest.java is a test path.
case_java_test() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  _commit "$repo" "test(java): failing [task-java]" "src/FooTest.java"
  _commit "$repo" "feat(java): impl [task-java]"    "src/Foo.java"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-java --base staging )
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case_java_test expected exit 0, got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.ok == true' >/dev/null \
    || fail "case_java_test expected ok=true"
  pass "case_java_test: Java FooTest.java recognised as test path"
}

# Kotlin: FooTest.kt is a test path.
case_kotlin_test() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  _commit "$repo" "test(kt): failing [task-kt]" "src/FooTest.kt"
  _commit "$repo" "feat(kt): impl [task-kt]"    "src/Foo.kt"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-kt --base staging )
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case_kotlin_test expected exit 0, got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.ok == true' >/dev/null \
    || fail "case_kotlin_test expected ok=true"
  pass "case_kotlin_test: Kotlin FooTest.kt recognised as test path"
}

# Python: foo_test.py is a test path.
case_python_test() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  _commit "$repo" "test(py): failing [task-py]" "tests/foo_test.py"
  _commit "$repo" "feat(py): impl [task-py]"    "src/foo.py"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-py --base staging )
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case_python_test expected exit 0, got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.ok == true' >/dev/null \
    || fail "case_python_test expected ok=true"
  pass "case_python_test: Python foo_test.py recognised as test path"
}

# Swift: FooTests.swift is a test path.
case_swift_tests() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  _commit "$repo" "test(swift): failing [task-sw]" "Tests/FooTests.swift"
  _commit "$repo" "feat(swift): impl [task-sw]"    "Sources/Foo.swift"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-sw --base staging )
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case_swift_tests expected exit 0, got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.ok == true' >/dev/null \
    || fail "case_swift_tests expected ok=true"
  pass "case_swift_tests: Swift FooTests.swift recognised as test path"
}

# C#: FooTests.cs is a test path.
case_csharp_tests() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  _commit "$repo" "test(cs): failing [task-cs]" "test/FooTests.cs"
  _commit "$repo" "feat(cs): impl [task-cs]"    "src/Foo.cs"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-cs --base staging )
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case_csharp_tests expected exit 0, got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.ok == true' >/dev/null \
    || fail "case_csharp_tests expected ok=true"
  pass "case_csharp_tests: C# FooTests.cs recognised as test path"
}

# Negative: a .go file that is NOT a test file (foo.go not foo_test.go) → impl.
case_go_impl_rejected() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  # Only impl commit: foo.go (not a test file)
  _commit "$repo" "feat(go): impl only [task-goimpl]" "pkg/foo.go"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-goimpl --base staging )
  rc=$?
  set -e
  if [[ $rc -ne 1 ]]; then fail "case_go_impl_rejected expected exit 1, got $rc"; fi
  printf '%s' "$out" | jq -e '.ok == false' >/dev/null \
    || fail "case_go_impl_rejected expected ok=false"
  pass "case_go_impl_rejected: plain .go file classified as impl (not test)"
}

# ---- B3: merge-commit first-parent classification ----

# B3a: merge commit that brings ONLY test files — classified as test-only,
# so a subsequent impl commit has a preceding test. Gate passes.
case_b3_merge_with_tests() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  ( cd "$repo"
    git checkout -q staging
    git checkout -q -b side-tests
    mkdir -p tests
    printf 'x' > tests/foo_test.go
    git add tests && git -c user.email=t@t -c user.name=t commit -q -m "add go tests"
    git checkout -q feat/task-001
    git -c user.email=t@t -c user.name=t merge --no-ff \
      -m "merge tests into task [task-001]" side-tests
  )
  _commit "$repo" "feat(go): impl [task-001]" "pkg/foo.go"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-001 --base staging )
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then fail "case_b3_merge_with_tests expected exit 0, got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.ok == true' >/dev/null \
    || fail "case_b3_merge_with_tests expected ok=true"
  pass "case_b3_merge_with_tests: merge bringing test files counts as test-only"
}

# B3b: merge commit that brings impl files — classified as impl,
# no preceding test → gate fails.
case_b3_merge_with_impl() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  ( cd "$repo"
    git checkout -q staging
    git checkout -q -b side-impl
    mkdir -p pkg
    printf 'x' > pkg/foo.go
    git add pkg && git -c user.email=t@t -c user.name=t commit -q -m "add impl"
    git checkout -q feat/task-001
    git -c user.email=t@t -c user.name=t merge --no-ff \
      -m "merge impl into task [task-001]" side-impl
  )
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-001 --base staging )
  rc=$?
  set -e
  if [[ $rc -ne 1 ]]; then fail "case_b3_merge_with_impl expected exit 1, got $rc; out=$out"; fi
  printf '%s' "$out" | jq -e '.ok == false' >/dev/null \
    || fail "case_b3_merge_with_impl expected ok=false"
  pass "case_b3_merge_with_impl: merge bringing impl files counted as impl (gate fails)"
}

# Test 9: untagged impl commit between staging..HEAD must be a violation
case9() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  _commit "$repo" "test: red tests for untagged-task [task-untagged]" "tests/x.test.ts"
  _commit "$repo" "feat: add impl" "src/impl.ts"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-untagged --base staging )
  rc=$?
  set -e
  local ok exempt
  ok=$(printf '%s' "$out" | jq -r '.ok')
  exempt=$(printf '%s' "$out" | jq -r '.exempt')
  [[ "$ok" == "false" && "$exempt" == "false" ]] \
    || fail "case9: untagged impl must be a violation (ok=$ok exempt=$exempt)"
  [[ $rc -eq 1 ]] || fail "case9: expected exit 1, got $rc"
  reason=$(printf '%s' "$out" | jq -r '.violations[0].reason')
  [[ "$reason" == "impl-commit-untagged" ]] || fail "case9: expected reason impl-commit-untagged, got $reason"
  pass "case9: untagged impl commit flagged as violation"
}

# Test 10: tagged test-only present, untagged impl present, must be a violation
case10() {
  local repo out rc; repo=$(mktemp -d); _mk_repo "$repo"
  _commit "$repo" "test: tests [task-mixed]" "tests/x.test.ts"
  _commit "$repo" "feat: untagged impl" "src/x.ts"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-mixed --base staging )
  rc=$?
  set -e
  local ok
  ok=$(printf '%s' "$out" | jq -r '.ok')
  [[ "$ok" == "false" ]] \
    || fail "case10: untagged impl alongside tagged test must violate (ok=$ok)"
  [[ $rc -eq 1 ]] || fail "case10: expected exit 1, got $rc"
  reason=$(printf '%s' "$out" | jq -r '.violations[0].reason')
  [[ "$reason" == "impl-commit-untagged" ]] || fail "case10: expected reason impl-commit-untagged, got $reason"
  pass "case10: untagged impl alongside tagged test flagged"
}

# Test 11: tagged --allow-empty commit must not advance seen_test_only
case11() {
  local repo out rc ok reason; repo=$(mktemp -d); _mk_repo "$repo"
  ( cd "$repo" && git -c user.email=t@t -c user.name=t commit --allow-empty -q \
      -m "chore: empty placeholder [task-empty]" )
  _commit "$repo" "feat: impl [task-empty]" "src/x.ts"
  set +e
  out=$( cd "$repo" && "$GATE" --task-id task-empty --base staging )
  rc=$?
  set -e
  ok=$(printf '%s' "$out" | jq -r '.ok')
  reason=$(printf '%s' "$out" | jq -r '.violations[0].reason // ""')
  [[ "$ok" == "false" && "$reason" == "impl-without-preceding-test" ]] \
    || fail "case11: empty commit must not satisfy test-only requirement (ok=$ok reason=$reason)"
  pass "case11: tagged empty commit does not advance seen_test_only"
}

case1; case2; case3; case4; case4b; case5; case6; case7; case8
case_go_test; case_ruby_spec; case_java_test; case_kotlin_test
case_python_test; case_swift_tests; case_csharp_tests; case_go_impl_rejected
case_b3_merge_with_tests; case_b3_merge_with_impl
case9; case10; case11
printf 'all tdd-gate tests passed\n'
