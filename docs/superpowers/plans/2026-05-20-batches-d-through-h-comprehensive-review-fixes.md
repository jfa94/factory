# Comprehensive Review Remediation — Batches D through H Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the remaining four-and-a-half batches (D, E, F, G, H) from the 2026-05-20 comprehensive code review. Batches A, B, and C already shipped (commits 67e4c89, 741235c, d6b7fe2).

**Architecture:** Five sequential batches, each landing as a single PR.

- **Batch D (P4) — architecture/encapsulation.** Restore the single-reader-writer contract for `state.json` and document two design intents.
- **Batch E (P5) — CI workflow.** Two tiny fixes: mutation aggregator must exempt `skipped`, marketplace manifest must catch up to plugin manifest.
- **Batch F (P6) — regression tests.** Lock in the P1 bug fixes already shipped in Batch A, plus close coverage gaps the reviewers surfaced.
- **Batch G (P7) — documentation drift.** Mechanical scribe pass; one big docs PR.
- **Batch H (P8) — convention drift.** Idiom cleanup (`_unquote_json_string`, single trap registry, `_quiet_or_warn`) plus a careful, per-script `set -euo pipefail` audit gated by a CI lint.

**Tech Stack:** Bash 5 (`set -euo pipefail` discipline), `jq`, `awk`, `gh` CLI, GitHub Actions YAML. Tests are Bash files in `bin/tests/` driven by `bin/test`. Plugin runtime is Claude Code with the `factory-plugin`'s hooks, agents, and skills under `~/.claude/plugins/...`.

**Plan-wide conventions every engineer must follow:**

1. **TDD is mandatory.** For every behavioral change in this plan, the failing test commit lands **before** the implementation commit. The plugin's own `bin/pipeline-tdd-gate` script enforces this contract on its callers — practice what we preach.
2. **One commit per step in the plan that says "Commit".** Do not batch commits across tasks. Smaller commits make rescue cheap.
3. **Run `bin/test` after every commit.** It is the gate of record. If a test outside the file you touched starts failing, stop and root-cause; do not "fix forward".
4. **Conventional Commit prefixes** (`fix:`, `feat:`, `test:`, `docs:`, `chore:`, `refactor:`) with an in-line scope: `fix(pipeline)`, `test(tdd-gate)`, etc. Look at `git log --oneline -20` for the project's house style.
5. **Never use `git commit --no-verify`, `--no-gpg-sign`, or `-n`.** The pre-commit hooks exist for a reason. If a hook blocks you, fix the underlying issue.
6. **Never use `git push --force` / `--force-with-lease`.** If you need to overwrite remote history, stop and ask.
7. **No emojis in commit messages, PR bodies, code, or comments unless the user explicitly asks.**

**How to dispatch the work to a subagent (recommended):**

For each task below, spawn a fresh subagent via the superpowers:subagent-driven-development skill. Hand them:

- The full task block (Files + Steps).
- A pointer to this plan document and the relevant section of the source plan at `~/.claude/plans/perform-a-comprehensive-code-sparkling-ember.md`.
- Instruction to run `bin/test` before reporting completion.

Between tasks, review the diff and the commit and only then move to the next task.

---

## Pre-flight (do once before Batch D)

- [ ] **Step 1: Confirm Batches A, B, C have landed on the current branch.**

Run:

```bash
git log --oneline -10
```

Expected first few lines (SHAs may differ but messages should match):

```
69ca7ac chore(scribe): pin model to opus alias
d6b7fe2 fix(security): batch C — P3 defense-in-depth (#20, M1, M2, M3, M13, M14)
741235c fix(pipeline): batch B — silent-failure hardening (H8-H13, M4, M6-M10)
67e4c89 fix(pipeline): batch A — silent pipeline-outcome bugs (H1-H7)
```

If those four commits are absent, **stop**. Batches D–H assume A–C are in place (especially: H4 already extended `_write_ship_checklist` to write `security_gate`; H5 already added `security_gate` to `_KNOWN_TASK_FIELDS`). Land A–C first.

- [ ] **Step 2: Run the full test suite to establish a green baseline.**

Run:

```bash
bin/test
```

Expected: every suite reports passed. If anything is red, fix it (or revert to a green commit) before starting Batch D.

- [ ] **Step 3: Create a single working branch for this plan.**

```bash
git checkout -b review/batches-d-through-h
```

We will open one PR per batch from this branch's history (using `gh pr create` against `staging`) or, if simpler, one PR per batch from per-batch sub-branches cut off this one. Decide before Batch E.

---

# Batch D — Architecture / Encapsulation (P4)

**Scope:** Three items from the source plan. A3 (split the 1700-line `pipeline-run-task`) is deferred per the source plan's note; don't touch it here.

| #   | Item                                                                                    | Files                                                    |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| D.1 | **A1** — replace direct `jq … "$state_file"` with `pipeline-state task-read`            | `bin/pipeline-run-task`, `bin/pipeline-human-gate`       |
| D.2 | **A2-doc** — add inline comment + decisions.md entry for fixed-model reviewer policy    | `bin/pipeline-run-task`, `docs/explanation/decisions.md` |
| D.3 | **A4** — document `exit 42` from `pipeline-human-gate`; fix exit-code mapping in caller | `docs/reference/exit-codes.md`, `bin/pipeline-run-task`  |

---

### Task D.1: Restore single-reader contract on state.json

**Why this matters.** `pipeline-state` is the only component that takes the state-file advisory lock. Direct `jq` reads bypass that lock. Under concurrent writes from gate scripts (security-gate, coverage-gate, mutation-gate all `task-write` independently) a direct `jq` read can observe a torn or pre-`mv` temp file. The fix collapses these reads into `pipeline-state task-read`, which (a) goes through the same advisory lock and (b) gives one place to evolve the schema.

**Files:**

- Modify: `bin/pipeline-run-task` — lines 1252, 1253, 1276, 1277, 1288, 1300, 1301, 1302 inside `_write_ship_checklist`
- Modify: `bin/pipeline-human-gate` — line 62 (the `jq -r '.input.issue_numbers[0]'` direct read)
- Test: `bin/tests/run-wrapper.sh` (new case) or fold into existing `run-wrapper.sh` test for `_write_ship_checklist`

**Background reading (the engineer should skim before touching code):**

- `bin/pipeline-state` lines 1–47 — see `_KNOWN_TASK_FIELDS` and the `task-read` action.
- `bin/pipeline-state` `task-read` action body — confirm it takes the lock and supports a nested-key arg like `quality_gates.tdd.ok`.
- `bin/pipeline-run-task` lines 1245–1340 — the existing `_write_ship_checklist` body. The function already uses `_task_field` for some fields; we are completing that migration.

- [ ] **Step 1: Confirm `pipeline-state task-read` supports nested-key arguments.**

Run:

```bash
grep -n "task-read" bin/pipeline-state | head -20
```

Look for the action handler. It should accept `pipeline-state task-read <run-id> <task-id> <field>` where `<field>` is dot-delimited (e.g. `quality_gates.tdd.ok`). If the handler today only supports a single top-level field, you'll need to extend it. Read the implementation. If you extend `task-read`, add a test for the dotted-key path in `bin/tests/state.sh` **before** writing the read-call migration below.

- [ ] **Step 2: Write the failing test for the A1 migration.**

Add a new test case to `bin/tests/run-wrapper.sh` that seeds a task state with `quality_gates.tdd.ok=true`, `quality_gate.skipped=true`, `quality_gates.pregate.ok=false`, and `security_gate.ok=true` and asserts the ship checklist contains the expected gate values. Then **temporarily intercept** `pipeline-state` (e.g. wrap it in a function in the test harness) and assert that `_write_ship_checklist` calls `pipeline-state task-read` for every gate field — not `jq` against the state file. Use `bash -x` tracing or wrap `pipeline-state` and `jq` with mock functions that log invocations to a tempfile, then assert the log contains zero `jq … state.json` lines for gate-field reads.

Concretely, add this case (adapt to the suite's house style — read the existing test file first to mirror its `setup` / `teardown` helpers):

```bash
test_write_ship_checklist_uses_state_api() {
  local run_id="test-run-a1"
  _setup_run "$run_id"
  pipeline-state task-init "$run_id" t1 '{"task_id":"t1","title":"x","files":[]}'
  pipeline-state task-write "$run_id" t1 quality_gates.tdd.ok 'true'
  pipeline-state task-write "$run_id" t1 quality_gate.skipped 'true'
  pipeline-state task-write "$run_id" t1 security_gate.ok 'true'

  # Trace every jq invocation. Test fails if jq is invoked against the state file
  # from inside _write_ship_checklist.
  local trace_file
  trace_file=$(mktemp)
  jq() {
    printf '%s\n' "$*" >> "$trace_file"
    command jq "$@"
  }
  export -f jq

  ( cd "$RUN_TASK_TEST_WORKTREE" && task_id=t1 run_id="$run_id" run_dir="$(state_dir "$run_id")" state_file="$(state_file_path "$run_id")" _write_ship_checklist )

  if grep -E "state\.json|\$state_file" "$trace_file"; then
    fail "expected zero direct jq state reads from _write_ship_checklist; got: $(cat "$trace_file")"
  fi
  rm -f "$trace_file"
}
```

Notes: the helper names `_setup_run`, `state_dir`, `state_file_path`, `RUN_TASK_TEST_WORKTREE` may differ; **read `bin/tests/run-wrapper.sh` first** and use the names actually used there. If the test infrastructure does not expose `_write_ship_checklist` standalone (it is a private function), spawn a subshell that sources `bin/pipeline-run-task` with `RUN_TASK_NO_MAIN=1` (look for that guard pattern in the script; if absent, this is a hint that a tiny refactor — making the function callable via a `pipeline-run-task --emit-ship-checklist <run-id> <task-id>` entry point — is the right shape).

- [ ] **Step 3: Run the failing test.**

```bash
bin/test run-wrapper
```

Expected: the new case fails because `_write_ship_checklist` still uses `jq -r --arg t "$task_id" '.tasks[$t].quality_gates.tdd.ok' "$state_file"`.

- [ ] **Step 4: Implement the A1 migration in `_write_ship_checklist`.**

In `bin/pipeline-run-task`, replace each of the eight `jq -r --arg t "$task_id" '<expr>' "$state_file"` reads with the equivalent `pipeline-state task-read` call. Use the existing `_task_field` helper (already in the file) where the field is a single top-level key; for the nested gate keys use the dotted form.

Concrete diff sketch (use this as a guide, not verbatim — preserve the `// "null"` and `// false` fallback semantics):

```bash
# Before (line 1252):
tdd_ok=$(jq -r --arg t "$task_id" '.tasks[$t].quality_gates.tdd.ok // "null"' "$state_file" 2>/dev/null || printf 'null')

# After:
tdd_ok=$(pipeline-state task-read "$run_id" "$task_id" quality_gates.tdd.ok 2>/dev/null)
tdd_ok=$(_unquote_json_string "${tdd_ok:-null}")
[[ -z "$tdd_ok" || "$tdd_ok" == "null" ]] && tdd_ok="null"
```

Apply the same translation to:

| Field                          | Old expression | New call                                   |
| ------------------------------ | -------------- | ------------------------------------------ |
| `quality_gates.tdd.ok`         | line 1252      | `task-read … quality_gates.tdd.ok`         |
| `quality_gates.tdd.exempt`     | line 1253      | `task-read … quality_gates.tdd.exempt`     |
| `quality_gate.ok`              | line 1276      | `task-read … quality_gate.ok`              |
| `quality_gate.skipped`         | line 1277      | `task-read … quality_gate.skipped`         |
| `quality_gates.pregate.ok`     | line 1288      | `task-read … quality_gates.pregate.ok`     |
| `security_gate.ok`             | line 1300      | `task-read … security_gate.ok`             |
| `security_gate.skipped`        | line 1301      | `task-read … security_gate.skipped`        |
| `security_gate.allow_failures` | line 1302      | `task-read … security_gate.allow_failures` |

Edge case: `_unquote_json_string` already exists in `pipeline-lib.sh`. Use it. Do **not** use `tr -d '"'` (see Batch H Task H.1).

- [ ] **Step 5: Migrate `pipeline-human-gate:62` read.**

In `bin/pipeline-human-gate`, the call site is the issue-number lookup inside the human-gate comment block. Replace:

```bash
issue_number=$(jq -r '.input.issue_numbers[0] // empty' "$state_file" 2>/dev/null)
```

with:

```bash
issue_number=$(pipeline-state read "$run_id" '.input.issue_numbers[0]' 2>/dev/null)
issue_number=$(_unquote_json_string "${issue_number:-}")
[[ "$issue_number" == "null" || "$issue_number" == "empty" ]] && issue_number=""
```

`pipeline-state read` already accepts a jq path argument — see `bin/pipeline-state` lines 1–17 for the action menu. Confirm by reading the `read` action body before depending on the shape.

- [ ] **Step 6: Run the new test and the full suite.**

```bash
bin/test run-wrapper
bin/test
```

Expected: the new case passes; the full suite stays green.

- [ ] **Step 7: Commit.**

```bash
git add bin/pipeline-run-task bin/pipeline-human-gate bin/tests/run-wrapper.sh
git commit -m "$(cat <<'EOF'
refactor(pipeline): route ship-checklist state reads through pipeline-state task-read (A1)

Direct jq reads against state.json bypassed the per-run advisory lock.
Under concurrent gate writes a torn read could mis-classify the ship
checklist. Migrate _write_ship_checklist + pipeline-human-gate's
issue-number lookup to the pipeline-state CLI so every reader takes
the lock.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task D.2: Document fixed-model reviewer policy (A2-doc)

**Why this matters.** A reviewer agent flagged the 11 reviewer spawn sites in `pipeline-run-task` for not routing through `pipeline-model-router`. The current behavior is intentional: review consistency matters more than quota economy. We must record that decision so the next reviewer doesn't re-raise the same concern.

**Files:**

- Modify: `bin/pipeline-run-task` — near the reviewer spawn sites (search for `subagent_type":"quality-reviewer"` and `subagent_type":"implementation-reviewer"`)
- Modify: `docs/explanation/decisions.md` — append a new Decision section

- [ ] **Step 1: Locate the reviewer spawn sites.**

Run:

```bash
grep -n 'subagent_type":"\(quality\|implementation\)-reviewer"' bin/pipeline-run-task
```

You should see roughly 6–12 hits. They cluster around the `_emit_manifest` calls for the postexec and postreview stages.

- [ ] **Step 2: Add a single inline comment block above the first cluster.**

Insert (above the first reviewer spawn) — pick a stable anchor; do not duplicate the comment at every site:

```bash
# Reviewer model is intentionally fixed (sonnet or opus), not routed through
# pipeline-model-router. Routing reviewer model by quota tier would let two
# reviews of the same task disagree because they ran on different models —
# review consistency outweighs quota economy. See docs/explanation/decisions.md
# "Decision 18: Reviewer Model is Fixed, Not Quota-Routed". Do not change
# without updating that decision.
```

- [ ] **Step 3: Add the matching Decision 18 to `docs/explanation/decisions.md`.**

Find the highest existing Decision number (currently 17 per the file's heading "Decision 17: Coarse Bash Allow with Hook-Enforced Defense-in-Depth"). Append after it:

```markdown
---

## Decision 18: Reviewer Model is Fixed, Not Quota-Routed

**Choice:** Reviewer subagents (`quality-reviewer`, `implementation-reviewer`) spawn with a fixed model (`sonnet` for routine reviews, `opus` for escalations). They do not consult `pipeline-model-router`.

**Why:**

- Review consistency outweighs quota economy. Two reviews of the same task that ran on different models can disagree, which inflates `request_changes` cycles and confuses reviewers' own retry logic.
- The Actor–Critic discipline (see Decision 9) is strongest when the Critic is held constant; varying the Critic by quota tier collapses the value of repeat reviews.
- Reviewer cost is small relative to executor cost; routing reviewers by tier would save little.

**Trade-off:** Reviewers consume quota at the higher tier even on routine tasks. Accepted.

**Scope:** Applies to `bin/pipeline-run-task` reviewer spawn manifests only. The model router still governs executor and test-writer spawns.
```

- [ ] **Step 4: Run the suite.**

```bash
bin/test
```

Expected: green. (No behavioral change, so no new test.)

- [ ] **Step 5: Commit.**

```bash
git add bin/pipeline-run-task docs/explanation/decisions.md
git commit -m "$(cat <<'EOF'
docs: document fixed-model reviewer policy (A2)

Reviewer subagents intentionally bypass pipeline-model-router. Add an
inline anchor comment in pipeline-run-task and a matching Decision 18
in docs/explanation/decisions.md so the choice survives future audits.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task D.3: Document `exit 42` and fix caller exit-code mapping (A4)

**Why this matters.** `pipeline-human-gate` exits 42 when the gate trips (run becomes `awaiting_human`). The caller in `pipeline-run-task` uses `if ! pipeline-human-gate …`, which collapses rc=1 (argument error) and rc=42 (legitimate pause) into the same `return 20`. An operator who breaks the human-gate invocation cannot distinguish a real pause from a misuse.

**Files:**

- Modify: `docs/reference/exit-codes.md` — add a `pipeline-human-gate` section
- Modify: `bin/pipeline-run-task` — line ~1442 (the `if ! pipeline-human-gate "$run_id" pre-merge; then` block)
- Test: `bin/tests/run-wrapper.sh` — new case

- [ ] **Step 1: Write the failing test.**

Add to `bin/tests/run-wrapper.sh`:

```bash
test_ship_distinguishes_human_gate_pause_from_error() {
  local run_id="test-run-a4"
  _setup_run "$run_id"
  # Force humanReviewLevel=1 so pre-merge gate trips
  _set_config humanReviewLevel 1

  # Stub pipeline-human-gate to return 42 (legitimate pause)
  local stub_dir; stub_dir=$(mktemp -d)
  cat > "$stub_dir/pipeline-human-gate" <<'STUB'
#!/usr/bin/env bash
exit 42
STUB
  chmod +x "$stub_dir/pipeline-human-gate"
  PATH="$stub_dir:$PATH" \
    bash -c '... call _ship stage ... ' \
    && rc=0 || rc=$?
  assert_equals 20 "$rc" "pause path must map to return 20"

  # Now stub to return 1 (argument error)
  cat > "$stub_dir/pipeline-human-gate" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
  PATH="$stub_dir:$PATH" \
    bash -c '... call _ship stage ...' \
    && rc=0 || rc=$?
  assert_equals 30 "$rc" "argument error must map to return 30 (distinct from pause)"
  rm -rf "$stub_dir"
}
```

Helper names (`_set_config`, `_setup_run`, `assert_equals`) follow the test file's existing conventions — read the file first.

- [ ] **Step 2: Confirm the test fails.**

```bash
bin/test run-wrapper
```

Expected: failure — both stubs currently map to `return 20`.

- [ ] **Step 3: Implement the mapping fix in `bin/pipeline-run-task` near line 1442.**

Replace:

```bash
if ! pipeline-human-gate "$run_id" pre-merge; then
  t1=$(_now_ms)
  log_step_end "ship" "human_gate_pause" "$((t1-t0))" "task_id=\"$task_id\""
  return 20
fi
```

with:

```bash
pipeline-human-gate "$run_id" pre-merge
local _hg_rc=$?
case "$_hg_rc" in
  0)
    : # gate passed, fall through
    ;;
  42)
    t1=$(_now_ms)
    log_step_end "ship" "human_gate_pause" "$((t1-t0))" "task_id=\"$task_id\""
    return 20
    ;;
  *)
    log_error "pipeline-human-gate failed unexpectedly: rc=$_hg_rc"
    t1=$(_now_ms)
    log_step_end "ship" "failed" "$((t1-t0))" "task_id=\"$task_id\"" "reason=\"human_gate_error\" rc=$_hg_rc"
    return 30
    ;;
esac
```

Search the rest of `pipeline-run-task` for any other `if ! pipeline-human-gate` calls — if there are post-execute or spec invocations, apply the same fix. As of the source-plan audit only the pre-merge call site existed; verify with `grep -n 'pipeline-human-gate' bin/pipeline-run-task`.

- [ ] **Step 4: Add `pipeline-human-gate` to `docs/reference/exit-codes.md`.**

After the `pipeline-quality-gate` section (and before "Rate Limiting"), insert:

```markdown
### pipeline-human-gate

| Exit Code | Meaning                                                              |
| --------- | -------------------------------------------------------------------- |
| 0         | Gate passed (humanReviewLevel below threshold); proceed              |
| 1         | Argument error or state-write failure (refuses to mark gate tripped) |
| 42        | Gate tripped; run marked `awaiting_human` and comment posted         |

Callers MUST distinguish rc=1 from rc=42. rc=42 is a legitimate pause; rc=1 is a misuse and should fail the stage.
```

- [ ] **Step 5: Run the suite.**

```bash
bin/test run-wrapper && bin/test
```

Expected: green; the new case passes.

- [ ] **Step 6: Commit.**

```bash
git add bin/pipeline-run-task docs/reference/exit-codes.md bin/tests/run-wrapper.sh
git commit -m "$(cat <<'EOF'
fix(pipeline): distinguish human-gate pause (42) from error (1) at ship stage (A4)

The ship stage collapsed rc=1 and rc=42 from pipeline-human-gate into
return 20. A broken human-gate invocation looked like a legitimate
pause to the orchestrator. Switch to an explicit case on rc and add
the gate's exit codes to docs/reference/exit-codes.md.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Batch D wrap-up

- [ ] **Step 1: Open the Batch D PR.**

```bash
git push -u origin review/batches-d-through-h
gh pr create --base staging \
  --title "fix(pipeline): batch D — architecture encapsulation (A1, A2-doc, A4)" \
  --body "$(cat <<'EOF'
## Summary
- A1: route _write_ship_checklist and pipeline-human-gate state reads through pipeline-state task-read so they take the per-run lock
- A2-doc: document the fixed-model reviewer policy (no router) with an inline anchor + Decision 18
- A4: distinguish pipeline-human-gate rc=1 (error) from rc=42 (pause) at the ship stage; document the gate's exit codes

## Test plan
- [ ] `bin/test` green
- [ ] `bin/test run-wrapper` green; new A1 trace test and A4 case pass
- [ ] Manual: seed a state with the gate fields → `pipeline-run-task --emit-ship-checklist` produces the same checklist as before A1

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

If you split per-batch sub-branches instead, cut `review/batch-d` off `staging`, cherry-pick D.1–D.3, and PR that. Same content.

---

# Batch E — CI Workflow (P5)

**Scope:** Two unrelated, single-line-ish fixes. Combine into one tiny PR.

| #   | Item                                                                                           | Files                                           |
| --- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| E.1 | **H14** — mutation aggregator must exempt `skipped` outcomes                                   | `templates/.github/workflows/quality-gate.yml`  |
| E.2 | **H16** — bump `marketplace.json` to 0.9.0 (matches `plugin.json`) and add a release-step note | `.claude-plugin/marketplace.json`, release docs |

---

### Task E.1: Exempt `skipped` from mutation aggregator failure (H14)

**Why this matters.** When a PR touches only `docs/` or only `bin/tests/`, the mutation matrix shard correctly returns `skipped`. The aggregator job at `templates/.github/workflows/quality-gate.yml:219` only exempts `cancelled`; `skipped` is treated as failure, so docs-only PRs cannot pass Mutation Testing → auto-merge never fires.

**Files:**

- Modify: `templates/.github/workflows/quality-gate.yml` line 219
- Test: `bin/tests/mutation-workflow.sh`

- [ ] **Step 1: Write the failing test in `bin/tests/mutation-workflow.sh`.**

Existing tests in this file shell out to `yq`/`awk` against the workflow file and assert structural invariants. Add a new case:

```bash
test_mutation_aggregator_exempts_skipped() {
  local agg_block
  agg_block=$(awk '/^  mutation-testing:/,/^  [a-z]/' templates/.github/workflows/quality-gate.yml)
  # The shell snippet must contain both "cancelled" and "skipped" as exempt outcomes
  if ! grep -q 'cancelled' <<<"$agg_block"; then
    fail "mutation aggregator missing 'cancelled' exemption"
  fi
  if ! grep -q 'skipped' <<<"$agg_block"; then
    fail "mutation aggregator missing 'skipped' exemption (regression for H14)"
  fi
}
```

Match the file's existing helpers (`fail`, `setup`, etc.) — read it first.

- [ ] **Step 2: Confirm failure.**

```bash
bin/test mutation-workflow
```

Expected: the new case fails because the aggregator's shell snippet does not currently mention `skipped`.

- [ ] **Step 3: Apply the YAML fix.**

In `templates/.github/workflows/quality-gate.yml`, find the aggregator step:

```yaml
if [[ "$MUTATION_RESULT" != "success" && "$MUTATION_RESULT" != "cancelled" ]]; then
echo "::error::one or more mutation shards did not succeed"
exit 1
fi
```

Replace with:

```yaml
# Exempt cancelled (force-push supersession) and skipped (no mutable
# source files in this PR — e.g. docs-only or tests-only changes).
if [[ "$MUTATION_RESULT" != "success" && "$MUTATION_RESULT" != "cancelled" && "$MUTATION_RESULT" != "skipped" ]]; then
echo "::error::one or more mutation shards did not succeed"
exit 1
fi
```

- [ ] **Step 4: Re-run the test.**

```bash
bin/test mutation-workflow && bin/test
```

Expected: green.

- [ ] **Step 5: Commit.**

```bash
git add templates/.github/workflows/quality-gate.yml bin/tests/mutation-workflow.sh
git commit -m "$(cat <<'EOF'
fix(ci): mutation aggregator must exempt skipped outcomes (H14)

A PR that touches only docs/ or only tests/ leaves the mutation matrix
shard with result=skipped. The aggregator only exempted cancelled, so
docs-only PRs failed Mutation Testing → auto-merge never fired.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task E.2: Bump marketplace manifest to 0.9.0 (H16)

**Why this matters.** `plugin.json` is at 0.9.0; `marketplace.json` is stuck at 0.7.0 (two releases behind). Marketplace clients install 0.7.0 and miss every fix since.

**Files:**

- Modify: `.claude-plugin/marketplace.json` line 9
- Modify: `bin/pipeline-scaffold` OR a release docs file — add a one-line check reminding the operator to bump both manifests in lockstep
- Test: `bin/tests/spec-intake.sh` or a new tiny case asserting the version field equals plugin.json's

- [ ] **Step 1: Write the failing test.**

Add a small case (the `spec-intake.sh` file or a new `bin/tests/version-parity.sh`):

```bash
test_marketplace_manifest_matches_plugin_manifest() {
  local plugin_version marketplace_version
  plugin_version=$(jq -r '.version' .claude-plugin/plugin.json)
  marketplace_version=$(jq -r '.plugins[] | select(.name=="factory") | .version' .claude-plugin/marketplace.json)
  if [[ "$plugin_version" != "$marketplace_version" ]]; then
    fail "version drift: plugin.json=$plugin_version marketplace.json=$marketplace_version"
  fi
}
```

If you create `bin/tests/version-parity.sh`, register it in `bin/test` (look for the suite-discovery logic; usually it's automatic for any `bin/tests/*.sh`).

- [ ] **Step 2: Confirm failure.**

```bash
bin/test version-parity
```

Expected: failure showing plugin.json=0.9.0 marketplace.json=0.7.0.

- [ ] **Step 3: Update `marketplace.json`.**

```json
{
  "name": "jfa94",
  "owner": { "name": "Javier Flores" },
  "plugins": [
    {
      "name": "factory",
      "source": "./",
      "description": "Autonomous coding pipeline: converts GitHub PRD issues into merged pull requests with quality-first review gates",
      "version": "0.9.0"
    }
  ]
}
```

- [ ] **Step 4: Add a release-step reminder.**

Find the release/version-bump docs. Check `bin/pipeline-scaffold` (it may emit release scaffolding), `docs/guides/`, or the project README for a release checklist section. If a release checklist exists, append:

```markdown
- Bump the version in BOTH `.claude-plugin/plugin.json` AND `.claude-plugin/marketplace.json`. The new test `bin/tests/version-parity.sh` (or `spec-intake.sh::test_marketplace_manifest_matches_plugin_manifest`) fails on drift.
```

If no release checklist exists, add a top-level comment in `.claude-plugin/marketplace.json` is impossible (JSON has no comments). Instead, create or extend `docs/guides/release.md` with a minimal Release Checklist:

```markdown
# Release Checklist

1. Update `CHANGELOG.md`.
2. Bump version in BOTH:
   - `.claude-plugin/plugin.json` (`.version`)
   - `.claude-plugin/marketplace.json` (`.plugins[].version`)
     The test suite enforces parity (see `bin/tests/`).
3. Tag the commit and push.
```

- [ ] **Step 5: Re-run tests.**

```bash
bin/test && bin/test version-parity
```

Expected: green.

- [ ] **Step 6: Commit.**

```bash
git add .claude-plugin/marketplace.json bin/tests/version-parity.sh docs/guides/release.md
git commit -m "$(cat <<'EOF'
chore(release): bump marketplace manifest to 0.9.0 and lockstep-test version parity (H16)

marketplace.json was at 0.7.0 while plugin.json was at 0.9.0 — clients
were two releases behind. Add a parity test that fails on drift and a
release checklist doc to prevent re-occurrence.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Batch E wrap-up

- [ ] **Step 1: Open the Batch E PR.**

```bash
gh pr create --base staging \
  --title "fix(ci): batch E — mutation aggregator skipped exemption + marketplace version bump (H14, H16)" \
  --body "$(cat <<'EOF'
## Summary
- H14: mutation aggregator now exempts result=skipped (docs-only / tests-only PRs)
- H16: marketplace.json bumped 0.7.0 → 0.9.0 to match plugin.json; new parity test + release checklist

## Test plan
- [ ] `bin/test` green
- [ ] `bin/test mutation-workflow` green
- [ ] `bin/test version-parity` green
- [ ] Manual: open a docs-only PR; confirm Mutation Testing aggregator passes

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# Batch F — Regression Tests (P6)

**Scope:** Ten new test cases that lock in Batch A's bug fixes (T7, T8, T9, ship-checklist security gate) and close the coverage gaps the reviewers surfaced (T1–T6).

Each task is independent; you can interleave them across files. Keep one task per commit.

| #    | Item                                                                                                                         | Suite                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| F.1  | **T7** — TDD gate: `has_impl==0`, non-exempt → `exempt=false` (regression for H1)                                            | `bin/tests/tdd-gate.sh`                           |
| F.2  | **T8** — mutation gate: score 79.5, target 80 → fail (regression for H2)                                                     | `bin/tests/mutation-gate.sh`                      |
| F.3  | **T9** — `FACTORY_ASYNC_CI=off`: stub `pipeline-wait-pr` to return 1/2/3/4 and assert distinct `reason=` (regression for H3) | `bin/tests/run-wrapper.sh`                        |
| F.4  | **H4 follow-up** — seed `security_gate.ok=false`; assert ship checklist + PR-create guard block                              | `bin/tests/run-wrapper.sh` + `bin/tests/hooks.sh` |
| F.5  | **T1** — auto-merge `needs: [quality, mutation-testing, security]` ordering                                                  | `bin/tests/mutation-workflow.sh`                  |
| F.6  | **T2** — holdout fail-closed branches (file unset, file missing, validator rc=1)                                             | `bin/tests/run-wrapper.sh`                        |
| F.7  | **T3** — secret-guard regex fixture per pattern (6 new cases)                                                                | `bin/tests/hooks.sh`                              |
| F.8  | **T4** — direct CLI surface tests for `pipeline-quota-gate-cli`                                                              | new `bin/tests/quota-gate-cli.sh`                 |
| F.9  | **T5** — `_is_nested_shell_or_hook_bypass` adversarial fixture matrix                                                        | `bin/tests/hooks.sh`                              |
| F.10 | **T6** — security-gate `allow_failures=true` exits 0 with finding + state summary contains `"allow_failures":true`           | `bin/tests/security-gate.sh`                      |

---

### Task F.1: TDD gate has_impl==0 non-exempt case (T7)

**Files:**

- Test: `bin/tests/tdd-gate.sh`

**Background:** Batch A's H1 fix changed `bin/pipeline-tdd-gate:117` from `_emit true true '[]'` to `_emit true false '[]'`. We need a test that fails if anyone reverts that.

- [ ] **Step 1: Write the test.**

Open `bin/tests/tdd-gate.sh`, find an existing "no impl commits" test to use as a structural template. Add:

```bash
test_no_impl_commits_non_exempt_emits_exempt_false() {
  _setup_branch_with_only_test_commits  # writes 1 test-writer commit, 0 impl commits
  _seed_task_non_tdd_exempt              # tasks.json row with tdd_exempt absent or false

  local out
  out=$(pipeline-tdd-gate --run-id "$RUN_ID" --task-id "$TASK_ID")
  local rc=$?

  assert_equals 0 "$rc" "gate should exit 0 when impl absent on a non-exempt task"
  # The critical assertion: exempt must be false, not true. H1 regression.
  local exempt_val
  exempt_val=$(jq -r '.quality_gates.tdd.exempt' <<<"$out")
  assert_equals "false" "$exempt_val" "exempt must be false; was '$exempt_val' (regression for H1)"
  local ok_val
  ok_val=$(jq -r '.quality_gates.tdd.ok' <<<"$out")
  assert_equals "true" "$ok_val" "ok must be true when impl absent (still waiting for impl)"
}
```

The helper names `_setup_branch_with_only_test_commits`, `_seed_task_non_tdd_exempt`, `assert_equals` follow the file's house style — read first.

- [ ] **Step 2: Run and confirm it passes against the current (post-H1) tree.**

```bash
bin/test tdd-gate
```

Expected: green. Then **prove the test catches the regression**: temporarily revert `bin/pipeline-tdd-gate:117` to `_emit true true '[]'`, re-run the test, confirm it fails, then revert the revert. Do not commit the revert.

- [ ] **Step 3: Commit.**

```bash
git add bin/tests/tdd-gate.sh
git commit -m "$(cat <<'EOF'
test(tdd-gate): lock H1 — has_impl==0 non-exempt must emit exempt=false (T7)

Without this test, a regression of pipeline-tdd-gate:117 (silent TDD
bypass via exempt=true on impl-absent tasks) would slip past CI.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task F.2: Mutation-gate boundary 79.5 vs 80 (T8)

**Files:**

- Test: `bin/tests/mutation-gate.sh`

**Background:** Batch A's H2 fix replaced `printf '%.0f'` (rounds half-up) with `awk` strict float comparison. We need a test that fails if anyone reverts.

- [ ] **Step 1: Write the test.**

```bash
test_mutation_gate_boundary_below_target_fails() {
  _seed_mutation_report 79.5 80   # score=79.5, target=80
  pipeline-mutation-gate --run-id "$RUN_ID" --task-id "$TASK_ID"
  local rc=$?
  assert_equals 1 "$rc" "gate must fail when score (79.5) < target (80) — regression for H2"
}

test_mutation_gate_at_target_passes() {
  _seed_mutation_report 80.0 80
  pipeline-mutation-gate --run-id "$RUN_ID" --task-id "$TASK_ID"
  local rc=$?
  assert_equals 0 "$rc" "gate must pass when score (80.0) == target (80)"
}

test_mutation_gate_just_below_target_fails() {
  _seed_mutation_report 79.999 80
  pipeline-mutation-gate --run-id "$RUN_ID" --task-id "$TASK_ID"
  local rc=$?
  assert_equals 1 "$rc" "gate must fail when score (79.999) < target (80)"
}
```

- [ ] **Step 2: Run, confirm green, then prove it catches the regression.**

```bash
bin/test mutation-gate
```

Temporarily revert the `awk` comparison to `printf '%.0f'`, re-run, confirm the 79.5 and 79.999 cases fail, revert the revert.

- [ ] **Step 3: Commit.**

```bash
git add bin/tests/mutation-gate.sh
git commit -m "$(cat <<'EOF'
test(mutation-gate): lock H2 — boundary score < target must fail (T8)

Without this test, a regression of pipeline-mutation-gate:135 (half-up
rounding silently bumping 79.5 → 80) would slip past CI.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task F.3: FACTORY_ASYNC_CI=off rc fan-out (T9)

**Files:**

- Test: `bin/tests/run-wrapper.sh`

**Background:** Batch A's H3 fix captured `pipeline-wait-pr`'s rc and routed 0/1/2/3/4 to distinct outcomes. We need a test per branch.

- [ ] **Step 1: Write the test.**

Add four cases (one per non-zero rc; rc=0 is already covered by the green-path test):

```bash
_stub_wait_pr_returning() {
  local rc="$1"
  local stub_dir; stub_dir=$(mktemp -d)
  cat > "$stub_dir/pipeline-wait-pr" <<STUB
#!/usr/bin/env bash
echo '{"status":"stub","rc":'"$rc"'}'
exit $rc
STUB
  chmod +x "$stub_dir/pipeline-wait-pr"
  printf '%s' "$stub_dir"
}

test_async_off_rc1_timeout() {
  local stub; stub=$(_stub_wait_pr_returning 1)
  PATH="$stub:$PATH" FACTORY_ASYNC_CI=off _run_ship_stage "$RUN_ID" "$TASK_ID"
  local rc=$?
  assert_equals 30 "$rc"
  assert_log_contains 'reason="ci_timeout"'
}

test_async_off_rc2_pr_closed() {
  local stub; stub=$(_stub_wait_pr_returning 2)
  PATH="$stub:$PATH" FACTORY_ASYNC_CI=off _run_ship_stage "$RUN_ID" "$TASK_ID"
  local rc=$?
  assert_equals 30 "$rc"
  assert_log_contains 'reason="pr_closed"'
  # Confirmed semantics: rc=2 means PR closed without merge → mark rejected,
  # do NOT spawn a fix attempt.
  assert_log_does_not_contain 'spawn'
}

test_async_off_rc3_ci_red() {
  local stub; stub=$(_stub_wait_pr_returning 3)
  PATH="$stub:$PATH" FACTORY_ASYNC_CI=off _run_ship_stage "$RUN_ID" "$TASK_ID"
  local rc=$?
  assert_equals 10 "$rc"  # spawn fix attempt
  assert_log_contains 'reason="ci_red"'
}

test_async_off_rc4_merge_conflict() {
  local stub; stub=$(_stub_wait_pr_returning 4)
  PATH="$stub:$PATH" FACTORY_ASYNC_CI=off _run_ship_stage "$RUN_ID" "$TASK_ID"
  local rc=$?
  assert_equals 10 "$rc"  # rebase attempt
  assert_log_contains 'reason="merge_conflict"'
}
```

The helper `_run_ship_stage` must be visible from the test. If `pipeline-run-task` does not expose a way to call only the ship stage, add a `--stage ship` debug flag in a tiny separate prep commit, or invoke `pipeline-run-task` with a state primed at the ship-stage boundary.

- [ ] **Step 2: Run.**

```bash
bin/test run-wrapper
```

Expected: green (Batch A already implemented the routing). Prove it catches the regression by collapsing the case statement back to the old single-rc check, confirm failures, then revert.

- [ ] **Step 3: Commit.**

```bash
git add bin/tests/run-wrapper.sh
git commit -m "$(cat <<'EOF'
test(run-wrapper): lock H3 — FACTORY_ASYNC_CI=off rc fan-out (T9)

Without this test, a regression of pipeline-run-task:1481-1496
(collapsing rc=1/2/3/4 into a single return code) would silently route
PR-closed cases as CI failures.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task F.4: security_gate in ship checklist + PR-create guard (H4 follow-up)

**Files:**

- Test: `bin/tests/run-wrapper.sh`
- Test: `bin/tests/hooks.sh`

**Background:** Batch A's H4 fix already wires `security_gate` into the checklist and the PR-create guard. Lock both.

- [ ] **Step 1: Write `bin/tests/run-wrapper.sh` case.**

```bash
test_ship_checklist_includes_security_gate_fail() {
  _setup_run "$RUN_ID"
  _seed_task_with_security_gate "$RUN_ID" "$TASK_ID" 'false' 'false' 'false'  # ok=false, skipped=false, allow_failures=false
  local checklist
  checklist=$(_emit_ship_checklist "$RUN_ID" "$TASK_ID")
  local sg
  sg=$(jq -r '.security_gate' <<<"$checklist")
  assert_equals "fail" "$sg" "security_gate must be 'fail' when ok=false and allow_failures=false"
}

test_ship_checklist_security_gate_allow_failures_maps_to_ok() {
  _setup_run "$RUN_ID"
  _seed_task_with_security_gate "$RUN_ID" "$TASK_ID" 'false' 'false' 'true'  # ok=false, allow_failures=true
  local checklist
  checklist=$(_emit_ship_checklist "$RUN_ID" "$TASK_ID")
  local sg
  sg=$(jq -r '.security_gate' <<<"$checklist")
  assert_equals "ok" "$sg" "allow_failures=true must map ok=false → checklist=ok (informational mode)"
}
```

- [ ] **Step 2: Write `bin/tests/hooks.sh` case.**

The PR-create guard lives in `hooks/pretooluse-pipeline-guards.sh:292-307`. Find the existing test scaffolding (look for `test_pr_create_guard_*` cases) and add:

```bash
test_pr_create_guard_blocks_when_security_gate_fail() {
  local checklist_file; checklist_file=$(mktemp)
  cat > "$checklist_file" <<'JSON'
{
  "task_id": "t1",
  "tdd_gate": "ok",
  "coverage_gate": "ok",
  "quality_gate": "ok",
  "pregate_gate": "ok",
  "security_gate": "fail",
  "review_blockers_resolved": true,
  "ci_status": "green"
}
JSON
  # Invoke the guard with a fake `gh pr create` Bash payload referencing
  # this checklist; assert exit code 2 (blocked).
  local out rc
  out=$(_invoke_pretooluse_guard 'gh pr create --base staging --title "..." --body "..."' "$checklist_file") || rc=$?
  assert_equals 2 "$rc" "guard must block PR create when security_gate=fail"
  rm -f "$checklist_file"
}
```

- [ ] **Step 3: Run.**

```bash
bin/test run-wrapper hooks
```

Expected: green. Prove the guard test catches a regression by temporarily removing `security_gate` from the guard's required-checks list, confirm failure, revert.

- [ ] **Step 4: Commit.**

```bash
git add bin/tests/run-wrapper.sh bin/tests/hooks.sh
git commit -m "$(cat <<'EOF'
test: lock H4 — security_gate in ship checklist and PR-create guard

Two cases: ship checklist must include security_gate (fail and
allow_failures-mapped-to-ok), and the PR-create guard must block when
security_gate=fail.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task F.5: Auto-merge needs list (T1)

**Files:**

- Test: `bin/tests/mutation-workflow.sh`

- [ ] **Step 1: Write the test.**

```bash
test_auto_merge_needs_includes_quality_mutation_security() {
  local needs_list
  needs_list=$(awk '/^  auto-merge:/,/^  [a-z]/' templates/.github/workflows/quality-gate.yml \
    | awk -F': ' '/needs:/ {print $2; exit}' \
    | tr -d '[]' )
  # Must contain quality, mutation-testing, security; order doesn't matter
  for required in quality mutation-testing security; do
    if ! grep -q "$required" <<<"$needs_list"; then
      fail "auto-merge needs missing '$required'; got: $needs_list (regression for H14/6c417e2)"
    fi
  done
}
```

- [ ] **Step 2: Run, confirm green, then commit.**

```bash
bin/test mutation-workflow
git add bin/tests/mutation-workflow.sh
git commit -m "$(cat <<'EOF'
test(mutation-workflow): lock auto-merge needs list (T1)

auto-merge must depend on quality, mutation-testing, and security
jobs. Without this assertion, a regression of 6c417e2 (auto-merge
shipped before mutation-testing aggregator) would slip past CI.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task F.6: Holdout fail-closed (T2)

**Files:**

- Test: `bin/tests/run-wrapper.sh`

**Background:** `pipeline-run-task:749-774` (current line numbers; may have shifted) has three holdout fail-closed branches: holdout_review_file state field unset, file missing from disk, validator returned rc=1. All three must fail the stage.

- [ ] **Step 1: Locate the holdout block.**

```bash
grep -n 'holdout_review_file\|holdout-validate' bin/pipeline-run-task | head -20
```

Read the three branches.

- [ ] **Step 2: Write the three cases.**

```bash
test_holdout_unset_field_fails_closed() {
  _setup_run "$RUN_ID"
  _seed_task_status "$RUN_ID" "$TASK_ID" postreview_done
  # holdout_review_file intentionally unset
  _run_ship_stage "$RUN_ID" "$TASK_ID"
  local rc=$?
  assert_equals 30 "$rc"
  assert_log_contains 'holdout'
}

test_holdout_missing_file_on_disk_fails_closed() {
  _setup_run "$RUN_ID"
  _seed_task_status "$RUN_ID" "$TASK_ID" postreview_done
  pipeline-state task-write "$RUN_ID" "$TASK_ID" holdout_review_file '"/nonexistent/path.json"'
  _run_ship_stage "$RUN_ID" "$TASK_ID"
  local rc=$?
  assert_equals 30 "$rc"
  assert_log_contains 'holdout'
}

test_holdout_validator_rc1_fails_closed() {
  _setup_run "$RUN_ID"
  _seed_task_status "$RUN_ID" "$TASK_ID" postreview_done
  local f; f=$(mktemp)
  echo '{"verdict":"REQUEST_CHANGES"}' > "$f"
  pipeline-state task-write "$RUN_ID" "$TASK_ID" holdout_review_file "\"$f\""
  # Stub pipeline-holdout-validate to return 1
  local stub_dir; stub_dir=$(mktemp -d)
  cat > "$stub_dir/pipeline-holdout-validate" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
  chmod +x "$stub_dir/pipeline-holdout-validate"
  PATH="$stub_dir:$PATH" _run_ship_stage "$RUN_ID" "$TASK_ID"
  local rc=$?
  assert_equals 30 "$rc"
}
```

- [ ] **Step 3: Run, commit.**

```bash
bin/test run-wrapper
git add bin/tests/run-wrapper.sh
git commit -m "$(cat <<'EOF'
test(run-wrapper): lock holdout fail-closed branches (T2)

Three cases: holdout_review_file unset, file missing on disk, validator
rc=1. All must fail the stage. Closes a coverage gap noted in the
2026-05-20 comprehensive review.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task F.7: Secret-guard regex fixture per pattern (T3)

**Files:**

- Test: `bin/tests/hooks.sh`

**Background:** `hooks/secret-commit-guard.sh` has seven regex patterns; only one (`AKIA…EXAMPLE`) has a fixture today. Add one fixture per pattern.

- [ ] **Step 1: Enumerate the patterns.**

```bash
grep -nE '^\s*(SECRET_PATTERNS|_PATTERN_|regex|pattern)=' hooks/secret-commit-guard.sh
# Also look for the pattern array body
grep -nA 20 'SECRET_PATTERNS=' hooks/secret-commit-guard.sh | head -40
```

Catalog all seven patterns. Likely candidates (verify by reading):

1. AWS access key — `AKIA[0-9A-Z]{16}`
2. AWS secret key — base64 40-char heuristic
3. GitHub PAT — `gh[pousr]_[A-Za-z0-9]{36,}`
4. OpenAI key — `sk-[A-Za-z0-9]{48}`
5. Anthropic key — `sk-ant-[A-Za-z0-9-]{95,}`
6. JWT-shaped — `eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`
7. Generic PEM private-key block — `-----BEGIN [A-Z ]+PRIVATE KEY-----`

Confirm against the actual file before writing fixtures.

- [ ] **Step 2: Add one test per pattern.**

For each pattern, stage a file containing a synthetic match (use deliberately fake values that are also clearly fake — e.g. `AKIAIOSFODNN7EXAMPLE` for the AWS pattern), run the guard, assert rc=2 (block). Then mutate the value by one character to break the regex, assert rc=0.

```bash
test_secret_guard_blocks_aws_access_key() {
  _stage_file "leak.txt" "aws_key=AKIAIOSFODNN7EXAMPLE"
  _invoke_secret_guard
  local rc=$?
  assert_equals 2 "$rc"
}

test_secret_guard_passes_non_match_aws() {
  _stage_file "leak.txt" "aws_key=AKIAXXXX"  # too short to match
  _invoke_secret_guard
  local rc=$?
  assert_equals 0 "$rc"
}

# ... repeat for the other six patterns
```

For each pattern document the source line in a comment so future maintainers can map test → regex.

- [ ] **Step 3: Run, confirm green, commit.**

```bash
bin/test hooks
git add bin/tests/hooks.sh
git commit -m "$(cat <<'EOF'
test(hooks): one fixture per secret-commit-guard regex (T3)

Six new cases (AWS secret, GitHub PAT, OpenAI key, Anthropic key,
JWT, PEM private key) plus the existing AKIA fixture. Closes a
coverage gap noted in the 2026-05-20 comprehensive review.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task F.8: Direct CLI tests for `pipeline-quota-gate-cli` (T4)

**Files:**

- Test: new `bin/tests/quota-gate-cli.sh`

**Background:** `bin/pipeline-quota-gate-cli` has no direct test file. It is currently exercised only transitively. Write happy-path + at least three failure-mode tests.

- [ ] **Step 1: Read the CLI's argument surface.**

```bash
bin/pipeline-quota-gate-cli --help 2>&1 || head -80 bin/pipeline-quota-gate-cli
```

Document every flag/subcommand it accepts. Test the contract from the outside.

- [ ] **Step 2: Write `bin/tests/quota-gate-cli.sh`.**

```bash
#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=bin/tests/_helpers.sh
source "$(dirname "$0")/_helpers.sh"  # adapt to actual helper path

test_quota_gate_cli_help() {
  pipeline-quota-gate-cli --help > /dev/null
  assert_equals 0 "$?" "--help must exit 0"
}

test_quota_gate_cli_proceed_when_under_threshold() {
  _seed_usage_cache 30  # 30% remaining
  pipeline-quota-gate-cli check
  assert_equals 0 "$?"
}

test_quota_gate_cli_wait_when_burst_exhausted() {
  _seed_usage_cache 5   # 5% remaining → wait
  local out rc
  out=$(pipeline-quota-gate-cli check) || rc=$?
  assert_log_contains "wait" "$out"
}

test_quota_gate_cli_end_gracefully_when_7d_over() {
  _seed_usage_cache_7d_over
  local out rc
  out=$(pipeline-quota-gate-cli check) || rc=$?
  assert_log_contains "end_gracefully" "$out"
}

test_quota_gate_cli_invalid_command() {
  pipeline-quota-gate-cli not-a-real-command
  local rc=$?
  assert_not_equals 0 "$rc" "invalid subcommand must exit non-zero"
}
```

Read existing similar test files for helper names — `bin/tests/quota-gate.sh` probably has `_seed_usage_cache` already.

- [ ] **Step 3: Register the suite.**

If `bin/test` discovers suites automatically (`bin/tests/*.sh`), nothing to do. Otherwise, add to the suite list.

- [ ] **Step 4: Run, commit.**

```bash
bin/test quota-gate-cli
git add bin/tests/quota-gate-cli.sh
git commit -m "$(cat <<'EOF'
test(quota-gate-cli): direct CLI surface tests (T4)

Closes a coverage gap noted in the 2026-05-20 comprehensive review.
Five cases: --help, proceed under threshold, wait on burst exhaustion,
end_gracefully on 7d over, invalid subcommand.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task F.9: `_is_nested_shell_or_hook_bypass` adversarial matrix (T5)

**Files:**

- Test: `bin/tests/hooks.sh`

**Background:** The helper lives in `hooks/_security-common.sh`. It is invoked by other hooks to detect attempts to bypass via nested-shell tricks (`bash -c`, `env -i bash`, etc.) or hook-bypass flags (`--no-verify`, `--no-gpg-sign`).

- [ ] **Step 1: Read the helper.**

```bash
grep -n '_is_nested_shell_or_hook_bypass' hooks/_security-common.sh
# Read the function body
```

Enumerate every pattern it claims to detect. Add at least one positive and one negative fixture for each.

- [ ] **Step 2: Write the matrix.**

```bash
test_nested_shell_bash_c() {
  source hooks/_security-common.sh
  _is_nested_shell_or_hook_bypass 'bash -c "git commit"' && assert_pass || fail "bash -c missed"
}

test_nested_shell_env_i_bash() {
  source hooks/_security-common.sh
  _is_nested_shell_or_hook_bypass 'env -i bash -c "git commit"' && assert_pass || fail "env -i missed"
}

test_no_verify_flag() {
  source hooks/_security-common.sh
  _is_nested_shell_or_hook_bypass 'git commit --no-verify' && assert_pass || fail "--no-verify missed"
}

test_no_gpg_sign_flag() {
  source hooks/_security-common.sh
  _is_nested_shell_or_hook_bypass 'git commit --no-gpg-sign' && assert_pass || fail "--no-gpg-sign missed"
}

test_benign_git_commit_passes() {
  source hooks/_security-common.sh
  _is_nested_shell_or_hook_bypass 'git commit -m "feat: x"' && fail "false positive on benign commit" || assert_pass
}

# ... add cases for every regex actually present in the helper
```

- [ ] **Step 3: Run, commit.**

```bash
bin/test hooks
git add bin/tests/hooks.sh
git commit -m "$(cat <<'EOF'
test(hooks): adversarial matrix for _is_nested_shell_or_hook_bypass (T5)

Positive cases (bash -c, env -i bash, --no-verify, --no-gpg-sign, …)
plus a negative case (benign git commit must not trigger). Closes a
coverage gap noted in the 2026-05-20 comprehensive review.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task F.10: security-gate allow_failures=true informational path (T6)

**Files:**

- Test: `bin/tests/security-gate.sh`

- [ ] **Step 1: Write the test.**

```bash
test_security_gate_allow_failures_exits_0_on_finding() {
  _seed_config_security_gate_with_allow_failures
  _seed_findings_file_with_one_high_finding
  pipeline-security-gate --run-id "$RUN_ID" --task-id "$TASK_ID"
  local rc=$?
  assert_equals 0 "$rc" "allow_failures=true must exit 0 even with findings"

  local state
  state=$(pipeline-state task-read "$RUN_ID" "$TASK_ID" security_gate)
  local allow_val
  allow_val=$(jq -r '.allow_failures' <<<"$state")
  assert_equals "true" "$allow_val" "state summary must record allow_failures:true"
  local ok_val
  ok_val=$(jq -r '.ok' <<<"$state")
  assert_equals "false" "$ok_val" "ok must reflect the underlying gate result (false), not the exit code"
}
```

Helper names follow the file's conventions — read it first.

- [ ] **Step 2: Run, commit.**

```bash
bin/test security-gate
git add bin/tests/security-gate.sh
git commit -m "$(cat <<'EOF'
test(security-gate): allow_failures=true informational path (T6)

Closes a coverage gap noted in the 2026-05-20 comprehensive review.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Batch F wrap-up

- [ ] **Step 1: Open Batch F PR.**

```bash
gh pr create --base staging \
  --title "test: batch F — regression tests for Batch A + reviewer coverage gaps (T1-T9, H4)" \
  --body "$(cat <<'EOF'
## Summary
- T1 auto-merge needs ordering
- T2 holdout fail-closed branches
- T3 secret-guard regex fixture per pattern
- T4 pipeline-quota-gate-cli direct tests (new suite)
- T5 _is_nested_shell_or_hook_bypass adversarial matrix
- T6 security-gate allow_failures=true informational path
- T7 TDD gate has_impl==0 non-exempt (locks H1)
- T8 mutation-gate boundary 79.5 vs 80 (locks H2)
- T9 FACTORY_ASYNC_CI=off rc fan-out (locks H3)
- H4 follow-up: security_gate in ship checklist + PR-create guard

## Test plan
- [ ] `bin/test` green
- [ ] Each new case verified against the regression it locks by temporarily reverting the corresponding Batch A/B fix

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# Batch G — Documentation Drift (P7)

**Scope:** One scribe pass; one PR. Items are mechanical. Do them in this order so later items don't undo earlier items.

| #    | Item                                                                              | Files                                                              |
| ---- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| G.1  | Remove phantom `bin/pipeline-orchestrator` reference                              | `CLAUDE.md`                                                        |
| G.2  | "9-phase / 9-stage" → "8-stage"                                                   | `docs/README.md`, `docs/architecture/overview.md`                  |
| G.3  | "21 scripts" → actual count; add `task.gate.tdd`, `task.gate.mutation` to metrics | `docs/architecture/components.md`, `docs/architecture/overview.md` |
| G.4  | Remove `servers/` row + Node.js MCP prereq; refresh bundled-agents list           | `docs/architecture/components.md`, `docs/getting-started.md`       |
| G.5  | Refresh file-structure tree                                                       | `docs/architecture/components.md`                                  |
| G.6  | Fix Stage E layer ordering                                                        | `docs/architecture/overview.md`                                    |
| G.7  | "5-step ladder" → "4-band ladder"                                                 | `commands/debug.md`                                                |
| G.8  | Replace `release/*` glob with the actual flat list                                | `docs/architecture/components.md`, `docs/reference/bin-scripts.md` |
| G.9  | Drop hardcoded `654 tests`; reconcile 11 vs 31 suite count                        | `docs/reference/bin-scripts.md`                                    |
| G.10 | Add `pipeline-security-gate` to gate list (M11)                                   | `agents/task-executor.md`                                          |
| G.11 | Refresh last-documented SHA marker                                                | `docs/README.md`                                                   |

---

### Task G.1: Remove phantom `bin/pipeline-orchestrator` (H17)

**Files:**

- Modify: `CLAUDE.md` line 24

- [ ] **Step 1: Confirm the file does not exist.**

```bash
ls bin/pipeline-orchestrator 2>&1
```

Expected: `No such file or directory`. The real orchestrator is `commands/run.md` + the `pipeline-orchestrator` skill.

- [ ] **Step 2: Edit `CLAUDE.md` line 24.**

Replace:

```
- `bin/pipeline-orchestrator` — main entry point (invoked by the `pipeline-orchestrator` skill)
```

with:

```
- `commands/run.md` — main entry point (orchestrator runs in the invoking Claude Code session; see `skills/pipeline-orchestrator/SKILL.md` for the protocol)
```

- [ ] **Step 3: Commit at end of Batch G.**

(Hold the commit; we'll lump all G items into one or two commits at the end.)

---

### Task G.2: Phase/stage count

- [ ] **Step 1: Confirm the current canonical count.**

The source plan and `docs/explanation/quality-gates.md` say 8 stages (A–H). Let's verify by reading `docs/explanation/quality-gates.md`:

```bash
grep -n "Stage [A-Z]" docs/explanation/quality-gates.md | head -20
```

Note whether the canonical count is 7 layers (quality gates) versus 8 stages (pipeline phases). The source plan says "9-phase → 8-stage". Confirm before editing.

- [ ] **Step 2: `docs/README.md:5`.**

```
- The plugin implements a 9-phase autonomous coding pipeline …
+ The plugin implements an 8-stage autonomous coding pipeline …
```

- [ ] **Step 3: `docs/architecture/overview.md:3`.**

```
- … 9-stage autonomous coding pipeline …
+ … 8-stage autonomous coding pipeline …
```

(Keep wording elsewhere consistent — `grep -n "9-phase\|9-stage" docs/` and fix all hits.)

---

### Task G.3: Script count + metrics list

- [ ] **Step 1: Count actual scripts.**

```bash
ls bin/ | grep -v '^tests$\|^test$\|\.md$\|\.sh$' | wc -l
ls bin/ | grep -E '^pipeline-' | wc -l
```

Use the number that reflects "pipeline scripts excluding library files". The source plan's claim is 39; verify it still holds when you run the command (a few may have landed since 2026-05-20).

- [ ] **Step 2: Update all sites.**

In `docs/architecture/components.md:28, 474, 540`, `docs/architecture/overview.md:126`:

```
- (21 scripts)
+ (N scripts)   # use the actual count
```

In `docs/architecture/components.md:540` (the metrics list section), add:

```
- task.gate.tdd
- task.gate.mutation
```

(Confirm those metric names exist by `grep -rn 'task\.gate\.' bin/` — use the exact names from the source.)

---

### Task G.4: Remove `servers/` row and Node.js MCP prereq

- [ ] **Step 1: Update `docs/architecture/components.md`.**

Lines 29, 33, 542 reference `servers/`. Remove them; the directory was orphaned in 0.3.5. The file-structure tree at line 7–34 must be refreshed (see Task G.5).

- [ ] **Step 2: Update `docs/getting-started.md`.**

Lines 12 and 14 list a Node.js prereq for an MCP server. Remove it. Refresh the bundled-agents list to match `agents/*.md` actually present:

```bash
ls agents/ | sed 's/\.md$//' | sort
```

Current: architecture-reviewer, implementation-reviewer, quality-reviewer, rescue-diagnostic, scribe, security-reviewer, spec-generator, spec-reviewer, task-executor, test-writer. Use that list verbatim.

---

### Task G.5: Refresh file-structure tree

- [ ] **Step 1: Run inventory.**

```bash
ls commands/ agents/ skills/ | sort
ls hooks/*.sh hooks/*.json 2>/dev/null
```

- [ ] **Step 2: Replace the obsolete tree in `docs/architecture/components.md:7-34`.**

Currently claims 3 commands / 3 agents / 1 skill. Actual: 5 commands / 10 agents / 6 skills. Rewrite the tree to match what is on disk. Use a real `tree`-style ASCII layout — copy the existing format and just update the counts and entries.

---

### Task G.6: Stage E layer ordering

- [ ] **Step 1: Read the canonical order in `docs/explanation/quality-gates.md`.**

The source plan claims the canonical order is: Static → Security → TDD → Test → Coverage → Holdout → Mutation. Verify by reading the file:

```bash
grep -nE 'Static|Security|TDD|Test|Coverage|Holdout|Mutation' docs/explanation/quality-gates.md | head -20
```

- [ ] **Step 2: Update `docs/architecture/overview.md:68-76` to match.**

If overview.md lists Stage E layers in a different order, rewrite them to match `quality-gates.md`. Be careful not to drop layers.

---

### Task G.7: "5-step ladder" → "4-band ladder"

- [ ] **Step 1: Read `skills/debug/SKILL.md`.**

```bash
grep -n 'band\|ladder\|tier' skills/debug/SKILL.md | head -20
```

Confirm the skill defines four bands.

- [ ] **Step 2: Update `commands/debug.md:42`.**

Replace `5-step ladder` with `4-band ladder` and adjust the bracketed thresholds if they list five.

---

### Task G.8: Replace `release/*` glob with actual flat list

- [ ] **Step 1: Read `bin/pipeline-rescue-apply:25` for the actual list.**

```bash
sed -n '20,40p' bin/pipeline-rescue-apply
```

Whatever lives there (likely a fixed array of rescue-branch names) is the truth.

- [ ] **Step 2: Update `docs/architecture/components.md` and `docs/reference/bin-scripts.md:1466`.**

Replace the `release/*` glob claim with the actual flat list. Quote the array literally.

---

### Task G.9: Drop hardcoded `654 tests`; reconcile suite count

- [ ] **Step 1: Count current tests.**

```bash
bin/test --list 2>/dev/null | wc -l
# Or, if --list isn't a flag, count test_* function definitions
grep -rE '^test_' bin/tests/ | wc -l
```

- [ ] **Step 2: Update `docs/reference/bin-scripts.md:1577`.**

Replace `654 tests` with a statement that the count is dynamic: "See `bin/test --list` for the current suite/test inventory."

- [ ] **Step 3: Reconcile suite count.**

The doc claims 11 suites; the directory has 31 (`ls bin/tests/*.sh | wc -l`). Either list all 31 or rewrite as "all `bin/tests/*.sh` are discovered automatically by `bin/test`". The second framing is more maintainable.

---

### Task G.10: Add `pipeline-security-gate` to the agent gate list (M11)

- [ ] **Step 1: Read `agents/task-executor.md:102`.**

It lists 5 gates. The actual stack is 7 (the missing one is `pipeline-security-gate`; depending on framing also `pipeline-tdd-gate` and others may need adding — verify by reading `docs/explanation/quality-gates.md`).

- [ ] **Step 2: Update the list.**

Insert `pipeline-security-gate` (and any others) in the correct ordering from `quality-gates.md`. Keep the list sourceable from one place — consider replacing the inline list with a one-line pointer to `docs/explanation/quality-gates.md` so future drift is impossible.

---

### Task G.11: Refresh last-documented SHA marker

- [ ] **Step 1: Determine the latest SHA after Batches D–F merge to staging.**

```bash
git log --oneline origin/staging -1
```

- [ ] **Step 2: Update `docs/README.md:1` (or wherever the marker lives).**

Replace the previous SHA with the new one. This step should be the last commit in Batch G so the marker accurately points to the SHA that closes the batch.

---

### Batch G commit + PR

- [ ] **Step 1: Stage all docs edits.**

```bash
git add CLAUDE.md docs/ commands/debug.md agents/task-executor.md
git status
```

Confirm only intended files are staged.

- [ ] **Step 2: Single docs commit.**

```bash
git commit -m "$(cat <<'EOF'
docs: batch G — scribe pass for 2026-05-20 comprehensive review drift

- CLAUDE.md: remove phantom bin/pipeline-orchestrator reference (H17)
- README, overview: 9-phase → 8-stage
- components, overview: 21 scripts → actual count; add task.gate.tdd,
  task.gate.mutation to metrics list
- components, getting-started: remove servers/ row + Node.js MCP prereq;
  refresh bundled-agents list
- components: refresh file-structure tree (5 cmds / 10 agents / 6 skills)
- overview Stage E: fix layer ordering to match quality-gates.md
- commands/debug.md: 5-step → 4-band ladder
- components, bin-scripts: release/* glob → actual flat list from
  pipeline-rescue-apply
- bin-scripts: drop hardcoded 654 tests; reconcile suite count
- agents/task-executor.md: add pipeline-security-gate to listed gates (M11)
- README: refresh last-documented SHA marker

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: PR.**

```bash
gh pr create --base staging \
  --title "docs: batch G — comprehensive review drift cleanup (P7)" \
  --body "$(cat <<'EOF'
## Summary
One scribe pass closing every documentation-drift item from the 2026-05-20 comprehensive review (P7 / G1–G11).

## Test plan
- [ ] `bin/test` green (docs changes are not test-affecting but run the suite anyway)
- [ ] Spot-check: every file:line citation in the review now resolves to the corrected text
- [ ] Spot-check: file-structure tree matches `ls commands/ agents/ skills/`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# Batch H — Convention Drift (P8)

**Scope:** Idiom cleanup + a careful `set -euo pipefail` audit. Items H.1–H.4 are mechanical. H.5 is the careful per-script audit; it is the largest task in the entire plan and must NOT be bulk-applied.

| #   | Item                                                                          | Files                                                                                                   |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| H.1 | **M12** — replace bare `tr -d '"'` with `_unquote_json_string`                | `bin/pipeline-rescue-apply:184`, `bin/pipeline-run-task:94`, `bin/pipeline-run-task:1611`               |
| H.2 | **M5** — consolidate three `trap … EXIT` into one registry                    | `bin/pipeline-parse-review`                                                                             |
| H.3 | log_error in `pipeline-tdd-gate:25`; remove redundant `_allow_json`           | `bin/pipeline-tdd-gate`, `bin/pipeline-security-gate`                                                   |
| H.4 | LOW cluster                                                                   | `bin/pipeline-summary`, `bin/pipeline-cleanup`, `bin/pipeline-tdd-gate`, `bin/pipeline-detect-reviewer` |
| H.5 | **P8 #55** — per-script `set -euo pipefail` audit + CI lint                   | many files in `bin/` and `hooks/`                                                                       |
| H.6 | **P8 #56** — `_quiet_or_warn` helper to replace `2>/dev/null \|\| true` idiom | `bin/pipeline-lib.sh` + opportunistic call-site migration                                               |

---

### Task H.1: `_unquote_json_string` in place of `tr -d '"'` (M12)

**Files:**

- Modify: `bin/pipeline-rescue-apply:184`
- Modify: `bin/pipeline-run-task:94`
- Modify: `bin/pipeline-run-task:1611`

- [ ] **Step 1: Confirm `_unquote_json_string` is exported from `pipeline-lib.sh`.**

```bash
grep -n '_unquote_json_string' bin/pipeline-lib.sh
```

Read the helper. Confirm it handles embedded quotes and the literal string `null`.

- [ ] **Step 2: Write a failing test.**

Add to `bin/tests/rescue-apply.sh` (or the closest existing suite):

```bash
test_rescue_apply_handles_quoted_string_with_embedded_quote() {
  # Seed state where a field value is a JSON string containing an embedded " char
  _seed_state_field "$RUN_ID" "$TASK_ID" failure_reason '"got error: \"foo\" not found"'
  _invoke_rescue_apply_branch_that_reads_failure_reason
  # The bare `tr -d '"'` strips ALL quotes, including the inner escaped ones,
  # producing 'got error: foo not found'. _unquote_json_string strips only the
  # outer quote pair, preserving 'got error: "foo" not found'.
  local observed
  observed=$(_observed_failure_reason)
  assert_equals 'got error: "foo" not found' "$observed"
}
```

- [ ] **Step 3: Confirm it fails.**

```bash
bin/test rescue-apply
```

- [ ] **Step 4: Apply the three replacements.**

For each line, replace:

```bash
foo=$(... | tr -d '"')
```

with:

```bash
foo=$(... )
foo=$(_unquote_json_string "$foo")
```

Verify each call site by reading the file before and after — sometimes the `tr -d '"'` appears in a longer pipeline and a direct in-place swap of `_unquote_json_string` is wrong.

- [ ] **Step 5: Test, commit.**

```bash
bin/test
git add bin/pipeline-rescue-apply bin/pipeline-run-task bin/tests/rescue-apply.sh
git commit -m "$(cat <<'EOF'
refactor: use _unquote_json_string instead of bare tr -d '"' (M12)

Three sites swap a bare quote strip for the shared helper, which
preserves embedded quotes inside JSON-encoded string values.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task H.2: Consolidate `pipeline-parse-review` trap registry (M5)

**Files:**

- Modify: `bin/pipeline-parse-review` lines 31, 161, 392

**Why:** Three independent `trap … EXIT` statements overwrite each other. Whichever ran last wins; the others' tempfiles leak. Same anti-pattern fixed in RM-5 (per source plan).

- [ ] **Step 1: Write a test that detects leakage.**

```bash
test_parse_review_no_temp_leak() {
  local before; before=$(ls /tmp/ | wc -l)
  pipeline-parse-review --round 1 --reviewer test <<<"junk input that triggers all branches"
  local after; after=$(ls /tmp/ | wc -l)
  # Allow for legitimate slack (other processes), but a leak shows as a big delta
  assert_less_than $((after - before)) 3 "parse-review left more than 2 temp files"
}
```

This is a heuristic test; pair it with a direct assertion that the script defines exactly one `trap … EXIT`:

```bash
test_parse_review_single_exit_trap() {
  local count
  count=$(grep -cE "^[[:space:]]*trap .*EXIT" bin/pipeline-parse-review)
  assert_equals 1 "$count" "expected exactly one EXIT trap; got $count"
}
```

- [ ] **Step 2: Implement a registry.**

Replace the three traps with a single trap that walks a `_PARSE_REVIEW_CLEANUP` array:

```bash
_PARSE_REVIEW_CLEANUP=()
_cleanup_register() { _PARSE_REVIEW_CLEANUP+=("$1"); }
_cleanup_run() {
  local f
  for f in "${_PARSE_REVIEW_CLEANUP[@]:-}"; do
    [[ -f "$f" || -d "$f" ]] && rm -rf "$f"
  done
}
trap _cleanup_run EXIT

# … at each former trap site:
tmpfile=$(mktemp); _cleanup_register "$tmpfile"
# (and similar for diff_file in the other two sites)
```

- [ ] **Step 3: Run tests, commit.**

```bash
bin/test
git add bin/pipeline-parse-review bin/tests/  # whichever suite gained the test
git commit -m "$(cat <<'EOF'
refactor(parse-review): consolidate three EXIT traps into a single cleanup registry (M5)

Multiple EXIT traps overwrote each other; only the last-registered
cleanup ran. Replace with a single registry-walking trap so every
tempfile and diff file is reliably reaped.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task H.3: log_error in tdd-gate + remove `_allow_json`

**Files:**

- Modify: `bin/pipeline-tdd-gate:25`
- Modify: `bin/pipeline-security-gate:128-129`

- [ ] **Step 1: tdd-gate change.**

Replace:

```bash
echo "unknown flag" >&2
```

with:

```bash
log_error "unknown flag: $1"
```

Ensure `pipeline-lib.sh` is sourced at the top of `pipeline-tdd-gate` (it almost certainly is; confirm).

- [ ] **Step 2: Remove `_allow_json` indirection.**

Read `bin/pipeline-security-gate:128-129`. The source plan says the indirection is redundant because earlier `tr` normalization already ensures a valid JSON shape. Confirm by reading the surrounding code. If the indirection is truly redundant, inline whatever single check it performs.

- [ ] **Step 3: Run, commit.**

```bash
bin/test
git add bin/pipeline-tdd-gate bin/pipeline-security-gate
git commit -m "$(cat <<'EOF'
chore: log_error in tdd-gate + remove redundant _allow_json indirection

- pipeline-tdd-gate:25: bare echo → log_error so the line lands in
  structured logs
- pipeline-security-gate:128-129: drop the _allow_json wrapper; the
  prior tr normalization already guarantees the shape

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task H.4: LOW cluster

**Files:**

- Modify: `bin/pipeline-summary:140-147`
- Modify: `bin/pipeline-cleanup:447-448`
- Modify: `bin/pipeline-tdd-gate:65`
- Modify: `bin/pipeline-detect-reviewer:18-24`

- [ ] **Step 1: `pipeline-summary` gh-comment failure visibility.**

At lines 140–147, the script logs `gh pr comment` failure and continues. For `human-gate` and `final-rollup` modes the operator must see the failure. Change behavior: if mode is `human-gate` or `final-rollup`, treat gh comment failure as fatal (`exit 1`); other modes keep the current warn-and-continue.

```bash
if ! _gh_comment_out=$(pipeline-gh-comment "$issue" "$kind" --data "$data" 2>&1); then
  case "$mode" in
    human-gate|final-rollup)
      log_error "gh comment failed for critical mode $mode: ${_gh_comment_out//$'\n'/ }"
      exit 1
      ;;
    *)
      log_warn "gh comment failed (non-critical mode $mode): ${_gh_comment_out//$'\n'/ }"
      ;;
  esac
fi
```

- [ ] **Step 2: `pipeline-cleanup:447-448` malformed JSONL.**

Currently malformed lines are silently skipped on the retention sweep. Promote to `log_warn` with the offending byte range so an operator can audit the file:

```bash
if ! jq -e . >/dev/null 2>&1 <<<"$line"; then
  log_warn "skipping malformed JSONL line at $file:$lineno: ${line:0:120}"
  continue
fi
```

- [ ] **Step 3: `pipeline-tdd-gate:65` `log_metric || true`.**

Drop the `|| true`. If the metric write genuinely fails the operator needs to know. Replace with:

```bash
if ! log_metric "$metric_name" "$@"; then
  log_warn "metric write failed: $metric_name"
fi
```

- [ ] **Step 4: `pipeline-detect-reviewer:18-24` missing-base-ref.**

Currently the script silently returns 0 even when the base ref is missing. Change to:

```bash
if ! git rev-parse --verify "$base" >/dev/null 2>&1; then
  log_warn "base ref '$base' missing; falling back to default reviewer 'implementation-reviewer'"
  printf 'implementation-reviewer\n'
  exit 0
fi
```

The behavior (default fallback) is unchanged but the warning surfaces in the structured log so operators can spot it.

- [ ] **Step 5: Run, commit.**

```bash
bin/test
git add bin/pipeline-summary bin/pipeline-cleanup bin/pipeline-tdd-gate bin/pipeline-detect-reviewer
git commit -m "$(cat <<'EOF'
chore: LOW cluster — surface previously-silent failure paths

- pipeline-summary: gh comment failure is fatal for human-gate /
  final-rollup modes (operator must see the signal)
- pipeline-cleanup: malformed JSONL line now logged with file:lineno
  before being skipped
- pipeline-tdd-gate: metric write failure logs a warning instead of
  being masked by '|| true'
- pipeline-detect-reviewer: missing base ref logs a warning before
  falling back to the default reviewer

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task H.5: Per-script `set -euo pipefail` audit (P8 #55)

**This is the biggest, most fragile task in the plan. Read everything below before starting.**

**Why this is dangerous if done wrong.** Adding `set -euo pipefail` to a script that has latent unchecked failures (e.g. `command -v X` probes that intentionally allow rc=1, `read … || break` loops, `grep … | head -1` pipes where grep is allowed to return 1) will silently change behavior — usually by aborting the script at a point that previously continued. The source plan explicitly says: **do not bulk-add**.

**The procedure has four phases:**

1. **Inventory.** Enumerate every script in `bin/` and `hooks/` that lacks `set -euo pipefail` at the top. Save as a checklist file.
2. **Audit each script.** Read the entire script. Flag patterns that would behave differently under `pipefail` or `set -u`. Decide per script whether to (a) add `set -euo pipefail` outright, (b) add it with localized `|| true` annotations on legitimately-tolerant lines, or (c) skip this script and document why in the checklist.
3. **Land per script.** One commit per script: failing test (regression for any latent failure surfaced), the `set -euo pipefail` addition, optional explicit tolerances, green test.
4. **Add CI lint.** Only after every in-scope script is migrated, add a test (`bin/tests/audit-hooks.sh` already exists — extend it) that asserts every `bin/pipeline-*` and `hooks/*.sh` file starts with `set -euo pipefail`.

---

#### H.5.1 Inventory

- [ ] **Step 1: Generate the missing-list.**

```bash
for f in bin/pipeline-* hooks/*.sh; do
  head -10 "$f" 2>/dev/null | grep -q "set -euo pipefail" || echo "MISSING: $f"
done
```

- [ ] **Step 2: Save the list as a working checklist file in the plan working tree.**

Create `docs/superpowers/plans/2026-05-20-batches-d-through-h.h5-inventory.md` with one line per missing script, an empty status column, and a notes column:

```markdown
| Script           | Status | Notes |
| ---------------- | ------ | ----- |
| bin/pipeline-foo | TODO   |       |
| bin/pipeline-bar | TODO   |       |
```

(This file is a working artifact; you can delete it at the end of Batch H or leave it as historical record. Either is fine.)

#### H.5.2 Audit and land per script

For each script in the inventory:

- [ ] **Step 1: Read the entire script.**

Look for these patterns (any of which means `set -euo pipefail` will change behavior):

| Pattern                                                                 | What to do                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --- | --------------------------------------------- |
| `command -v X` probes whose rc=1 result is consumed                     | Wrap in `                                                                       |     | true`explicitly, or use`if command -v X` form |
| `grep -q PATTERN file` whose rc=1 is consumed (e.g. via `[[ … ]]` test) | Use `if grep -q …; then … fi` form                                              |
| `read -r line` loops whose rc=1 ends the loop                           | Replace with `while IFS= read -r line; do …; done < <(cmd)` and check rc on cmd |
| Unset variable accesses (`${VAR}` without default)                      | Replace with `${VAR:-default}` or guard with `[[ -n "${VAR:-}" ]]`              |
| Long pipes where intermediate rc matters                                | Decompose into stages with explicit `local _rc; cmd; _rc=$?`                    |
| `set +e` … `set -e` islands                                             | Preserve as-is; they handle intentional rc=1 capture                            |

- [ ] **Step 2: Write a test for any latent failure surfaced.**

If the audit found a latent path that under `pipefail` would change behavior, write a test that captures the new (correct) behavior **before** flipping the flag. Common case: a `grep` probe with rc=1 propagating now triggers exit; if the propagation is correct, your test should observe the new exit code; if propagation is wrong, your test should observe that the explicit `|| true` keeps the old behavior.

- [ ] **Step 3: Add `set -euo pipefail` to the script.**

Place it on line 2 (immediately after the shebang). For library files (sourced by other scripts), use `set -uo pipefail` (drop `-e` because sourcing in a `set -e` parent already inherits; `-e` in a sourced file is also fine but inert).

- [ ] **Step 4: Run the suite.**

```bash
bin/test
```

- [ ] **Step 5: Commit one script at a time.**

```bash
git add bin/pipeline-foo bin/tests/foo.sh  # if a test changed
git commit -m "$(cat <<'EOF'
chore(pipeline-foo): add set -euo pipefail; tighten latent failure paths

Audited every potential rc=1 propagation. Annotated tolerant probes
with explicit '|| true' (cite the lines). New test asserts the
previously-silent failure now surfaces correctly.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Update the inventory checklist.**

Mark the script DONE in `docs/superpowers/plans/2026-05-20-batches-d-through-h.h5-inventory.md`.

Repeat for every script.

#### H.5.3 CI lint

- [ ] **Step 1: Extend `bin/tests/audit-hooks.sh`.**

Add a case that fails if any `bin/pipeline-*` or `hooks/*.sh` lacks `set -euo pipefail` near the top:

```bash
test_all_pipeline_scripts_have_set_euo_pipefail() {
  local missing=()
  for f in bin/pipeline-* hooks/*.sh; do
    head -10 "$f" 2>/dev/null | grep -q "set -euo pipefail" || missing+=("$f")
  done
  if (( ${#missing[@]} > 0 )); then
    fail "scripts missing 'set -euo pipefail': ${missing[*]}"
  fi
}
```

If any script must be exempt, maintain an exemption list inside the test:

```bash
EXEMPT=(bin/pipeline-statusline-wrapper.sh)
```

and skip those entries in the loop, with a comment in the test explaining the exemption (per-script).

- [ ] **Step 2: Run the lint; commit.**

```bash
bin/test audit-hooks
git add bin/tests/audit-hooks.sh
git commit -m "$(cat <<'EOF'
test(audit-hooks): CI lint — every pipeline script must declare set -euo pipefail (P8 #55)

Lands only after every in-scope script was audited and migrated
individually. Exempt list documented inline.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task H.6: `_quiet_or_warn` helper (P8 #56)

**Files:**

- Modify: `bin/pipeline-lib.sh`
- Opportunistic: any one or two scripts where the idiom is most visible

**Why:** `2>/dev/null || true` masks every kind of failure. A helper that captures stderr and emits `log_warn` on failure surfaces the signal without changing control flow.

- [ ] **Step 1: Add the helper to `pipeline-lib.sh`.**

```bash
# Run a command silently; on non-zero exit, emit a log_warn carrying the
# command and captured stderr. Always returns 0.
# Usage: _quiet_or_warn <description> -- <command> [args...]
_quiet_or_warn() {
  local desc="${1:?missing description}"
  shift
  if [[ "${1:-}" != "--" ]]; then
    log_warn "_quiet_or_warn: missing '--' separator before command (desc=$desc)"
    return 0
  fi
  shift
  local _stderr; _stderr=$(mktemp)
  if ! "$@" 2>"$_stderr" >/dev/null; then
    log_warn "$desc failed: $(tr '\n' ' ' < "$_stderr")"
  fi
  rm -f "$_stderr"
  return 0
}
```

- [ ] **Step 2: Write a test for the helper.**

```bash
test_quiet_or_warn_passes_on_success() {
  local out
  out=$(_quiet_or_warn "test op" -- true 2>&1)
  assert_equals "" "$out"
}

test_quiet_or_warn_warns_on_failure() {
  local out
  out=$(_quiet_or_warn "test op" -- bash -c 'echo "boom" >&2; exit 1' 2>&1)
  assert_contains "$out" "test op failed"
  assert_contains "$out" "boom"
}
```

- [ ] **Step 3: Migrate one or two highly-visible sites.**

Pick the noisiest `2>/dev/null || true` (search with `grep -rn "2>/dev/null || true" bin/ hooks/`). Migrate **only one or two** sites in this commit — bulk migration risks the same hazards as bulk `set -euo pipefail`. Each migrated call site should land with whatever local test still works against it. Leave the rest of the codebase using the old idiom; subsequent PRs (out of scope for this plan) can migrate further.

- [ ] **Step 4: Run, commit.**

```bash
bin/test
git add bin/pipeline-lib.sh bin/tests/  # whichever tests
git commit -m "$(cat <<'EOF'
chore(lib): add _quiet_or_warn helper to replace the silent '2>/dev/null || true' idiom (P8 #56)

The new helper captures stderr and emits log_warn on failure so the
signal lands in structured logs instead of being silently dropped.
Migrate one or two highly-visible call sites; leave the rest for
follow-up PRs (per source plan: do not bulk-migrate).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Batch H wrap-up

- [ ] **Step 1: Open Batch H PR.**

```bash
gh pr create --base staging \
  --title "chore: batch H — convention drift cleanup (P8)" \
  --body "$(cat <<'EOF'
## Summary
- H.1 / M12: replace bare `tr -d '"'` with `_unquote_json_string` at three sites
- H.2 / M5: consolidate pipeline-parse-review's three EXIT traps into a single registry
- H.3: log_error in tdd-gate; remove redundant _allow_json indirection
- H.4: LOW cluster — surface previously-silent failures (gh comment for critical modes, malformed JSONL, metric write, missing base ref)
- H.5: per-script `set -euo pipefail` audit + CI lint (inventory + per-script commits + lint)
- H.6: `_quiet_or_warn` helper + opportunistic migration

## Test plan
- [ ] `bin/test` green
- [ ] `bin/test audit-hooks` enforces lint
- [ ] Spot-check: every `bin/pipeline-*` and `hooks/*.sh` (minus documented exemptions) starts with `set -euo pipefail`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# Plan-wide verification (run after each batch lands; final pass after Batch H)

- [ ] **Step 1: Full test suite.**

```bash
bin/test
```

- [ ] **Step 2: Targeted regression scripts (per source plan §Verification).**

```bash
bin/test tdd-gate       # H1 lock
bin/test mutation-gate  # H2 lock
bin/test run-wrapper    # H3, H4, A1, A4, T2 locks
bin/test security-gate  # T6 lock
bin/test mutation-workflow  # T1, H14 locks
bin/test hooks          # T3, T5, H4 PR-create guard
bin/test version-parity # H16 lock
bin/test audit-hooks    # P8 #55 lint
```

- [ ] **Step 3: Confirm `pipeline-state` no longer warns on `security_gate`.**

```bash
# After a real or simulated run that exercises the security gate:
grep -E 'task-write unknown field: security_gate' "${CLAUDE_PLUGIN_DATA}"/runs/*/log/*.log 2>/dev/null || echo "no warnings (good)"
```

(H5 was already fixed in Batch A; this verifies no regression.)

- [ ] **Step 4: Manual E2E for H3.**

Run an end-to-end task with `FACTORY_ASYNC_CI=off` against (a) a closed PR and (b) a merge-conflict PR. Verify the orchestrator routes them to distinct recovery paths (rejection vs rebase) — not into a single "ci_red" bucket.

- [ ] **Step 5: Operator dry-run for H14.**

Open a docs-only PR; confirm Mutation Testing aggregator passes (via `skipped` exemption).

- [ ] **Step 6: Final scribe sweep.**

```bash
git log --oneline staging..HEAD
```

Diff this list against the items in Task G — every doc claim updated should map to a commit. If anything is missing, add a small follow-up commit before closing the PR chain.

---

# Open questions

None blocking. All resolved in the source plan's "Open questions — resolved 2026-05-20" section. If a new question surfaces during implementation (e.g. a Batch H.5 audit reveals a script that genuinely cannot tolerate `set -euo pipefail`), stop and confirm with the user before adding an exemption.

---

# Cross-references

- Source plan: `~/.claude/plans/perform-a-comprehensive-code-sparkling-ember.md`
- Batches A–C commits: `67e4c89`, `741235c`, `d6b7fe2`
- Quality-gate canonical ordering: `docs/explanation/quality-gates.md`
- Exit-code reference: `docs/reference/exit-codes.md`
- TDD discipline (for the test-before-impl pattern this plan enforces): `skills/test-driven-development/SKILL.md`
