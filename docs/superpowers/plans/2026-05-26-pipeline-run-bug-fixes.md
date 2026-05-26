# Factory Pipeline Run-Time Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five bugs that caused `run-20260526-154940` to die mid-run: missing `runs/current` symlink, undefined test-writer→executor worktree handoff, over-aggressive task-description regex, spec-generator self-review violation, and cross-worktree `commit-spec` failure.

**Architecture:** Bash-only changes to `bin/pipeline-*` scripts, `agents/*.md` cards, `skills/pipeline-orchestrator/prompts/*.md`, and the `skills/pipeline-orchestrator/SKILL.md` protocol. Each bug gets a failing test first (TDD), then minimal fix, then commit. No new files except tests where existing ones don't cover the scenario.

**Tech Stack:** Bash, jq, git, Claude Code Agent SDK, ShellCheck. Tests run via `bin/tests/*.sh` harnesses.

---

## Investigation Notes (read before starting)

- **Bug 1 PRIMARY root cause: hook env-var leak, not symlink creation.** `bin/pipeline-init` DOES create `runs/current` correctly (it sources `pipeline-lib.sh` at line 8, which canonicalizes `CLAUDE_PLUGIN_DATA` via `_factory_expected_data_dir`). But six hooks read `${CLAUDE_PLUGIN_DATA}` directly BEFORE sourcing the lib — or never source it at all:
  - `hooks/subagent-stop-transcript.sh:24` (sources lib only at line 236, AFTER the early symlink check at line 24 has already exited silently).
  - `hooks/run-tracker.sh:91-92`, `hooks/pretooluse-pipeline-guards.sh:32-33`, `hooks/session-start-resume.sh:19-20`, `hooks/stop-gate.sh:23-24` — never source lib, read raw env.
  - `hooks/secret-commit-guard.sh:106`, `hooks/write-protection.sh:20` — read raw env for `config_file` lookup.
  - When the codex-openai-codex plugin leaks its `CLAUDE_PLUGIN_DATA` into the orchestrator session, every one of these hooks looks at `codex-openai-codex/runs/current` (which doesn't exist) instead of `factory-jfa94/runs/current` (where init wrote it). Hook silent-exits → state writes lost → wrapper re-emits same manifest. This explains the entire symptom set.
  - User's manual `ls /Users/Javier/.claude/plugins/data/factory-jfa94/runs/current → No such file` could still happen via separate paths (stale symlink cleanup, mv fall-through), so defensive measures (post-init verify, ensure-current action, loud-on-missing) remain valuable.
  - **Dropped from earlier draft:** `finalize-on-stop` conditional symlink removal. That was speculative; no evidence the user's run reached finalize.
- **Bug 2 confirmed.** `bin/pipeline-run-task:680` builds executor manifest with NO `isolation` field. Agent card `agents/task-executor.md:4` declares `isolation: worktree`. Agent SDK creates fresh worktree from current HEAD (orchestrator's), never sees test-writer's RED commits. Two viable fix paths (see Task 4): (a) push test-writer branch + bootstrap block in executor prompt (user's tested workaround); (b) add `cwd: <test-writer-worktree>` to the manifest and drop the executor card's `isolation: worktree`, so the executor SDK reuses test-writer's worktree directly. (b) is structurally cleaner but requires confirming Agent SDK accepts `cwd` in the manifest. Plan implements (a) first because user already proved it works.
- **Bug 3 confirmed.** `bin/pipeline-validate-tasks:113` rejects `[;&|<>]`. Descriptions are fenced via nonce-tagged `<<<UNTRUSTED:DESCRIPTION:NONCE>>>` (`bin/pipeline-build-prompt:228-230`) and never shell-eval'd. Rejection of `;&|<>` is dead weight that blocks legitimate TS syntax. `grep -rn "\.description" bin/ skills/ hooks/` confirms no consumer constructs shell from `.description`.
- **Bug 4 confirmed.** `skills/pipeline-orchestrator/prompts/spec-generator.md:22` instructs the spec-generator to spawn `spec-reviewer` itself. Orchestrator `SKILL.md:222` then _reads_ the review output from the generator. This is structurally fragile — generator can rationalize self-review. Belt-and-suspenders option (deferred to open question): SubagentStop hook that scans spec-generator transcript for evidence of self-spawn and logs a violation.
- **Bug 5 broader scope.** `bin/pipeline-branch:119` runs `git checkout staging` in current cwd; fails when staging is checked out in a sibling worktree. But the same anti-pattern exists in `skills/pipeline-orchestrator/SKILL.md:246` (`git checkout staging` inside the orchestrator's worktree). Plan fixes both.

---

## File Structure

**Modified:**

- `hooks/subagent-stop-transcript.sh` — source `pipeline-lib.sh` at top so `CLAUDE_PLUGIN_DATA` is canonicalized BEFORE the symlink check (Bug 1 PRIMARY)
- `hooks/run-tracker.sh`, `hooks/pretooluse-pipeline-guards.sh`, `hooks/session-start-resume.sh`, `hooks/stop-gate.sh`, `hooks/secret-commit-guard.sh`, `hooks/write-protection.sh` — same lib-source-at-top fix for env-var canonicalization (Bug 1 PRIMARY, fan-out)
- `bin/pipeline-init` — defensive post-rename verification (Bug 1 defense-in-depth)
- `bin/pipeline-state` — new `ensure-current <run-id>` action (Bug 1 recovery)
- `bin/pipeline-run-task` — push test-writer branch + add bootstrap setup to executor prompt (Bug 2)
- `bin/pipeline-build-prompt` — accept `--bootstrap-branch` flag and emit setup block (Bug 2)
- `agents/task-executor.md` — body text reflects bootstrap-first execution (Bug 2)
- `bin/pipeline-validate-tasks` — relax description regex to drop `[;&|<>]` (Bug 3)
- `bin/tests/prompt-fencing.sh` — flip `;&|<>` tests from rejection-asserts to acceptance-asserts; add TS-syntax acceptance tests (Bug 3)
- `agents/spec-generator.md` — remove "spawn spec-reviewer" responsibility; tighten Handoff Protocol (Bug 4)
- `skills/pipeline-orchestrator/prompts/spec-generator.md` — same (Bug 4)
- `skills/pipeline-orchestrator/SKILL.md` — orchestrator spawns `spec-reviewer` between handoff resolution and review-score persistence (Bug 4); step 5 staging mutations route via `git -C <staging-wt>` (Bug 5)
- `bin/pipeline-branch` — `commit-spec` runs in the worktree that owns `staging` via `git worktree list --porcelain` lookup (Bug 5)

**Created:**

- `bin/tests/preexec-handoff.sh` — covers Bug 2 (test-writer→executor branch handoff)
- `bin/tests/symlink-recovery.sh` — covers Bug 1 (hook canonicalization + ensure-current + post-init verify)
- Test additions to `bin/tests/branching.sh` for Bug 5 cross-worktree commit-spec

---

## Task 1 — Bug 3 (validate-tasks regex): cheapest, no upstream dependencies

**Why first:** Pure regex change; existing test file already covers rejection cases — we flip a few of them. Unblocks specs blocked on the staged workaround the user already deployed.

**Files:**

- Modify: `bin/pipeline-validate-tasks:108-116`
- Modify: `bin/tests/prompt-fencing.sh:187-217` (semicolon/ampersand/pipe/angle-bracket sections)
- Test: `bin/tests/prompt-fencing.sh` (add positive-acceptance section)

- [ ] **Step 1.1: Write the failing acceptance tests for legitimate TS syntax**

Add this block to `bin/tests/prompt-fencing.sh` directly after the existing "ampersand should be rejected" block (around line 217):

```bash
# TypeScript-style descriptions should be accepted (regression: factory bug 3)
# These were over-rejected by the prior regex.
TASKS_TS_PIPE=$(make_tasks "Add 'home' | 'activity' union to view kind")
TASKS_TS_PIPE_FILE="$ROOT_TMP/tasks_ts_pipe.json"
printf '%s' "$TASKS_TS_PIPE" > "$TASKS_TS_PIPE_FILE"
result_ts_pipe=$("$BIN_DIR/pipeline-validate-tasks" "$TASKS_TS_PIPE_FILE" 2>/dev/null || true)
if printf '%s' "$result_ts_pipe" | jq -e '.valid == true' >/dev/null 2>&1; then
  ok "TS union | in description accepted"
else
  fail "TS union | in description accepted (expected valid=true)"
fi

TASKS_TS_GENERIC=$(make_tasks "Implement createEventBus<T>() factory returning Promise<void>;")
TASKS_TS_GENERIC_FILE="$ROOT_TMP/tasks_ts_generic.json"
printf '%s' "$TASKS_TS_GENERIC" > "$TASKS_TS_GENERIC_FILE"
result_ts_generic=$("$BIN_DIR/pipeline-validate-tasks" "$TASKS_TS_GENERIC_FILE" 2>/dev/null || true)
if printf '%s' "$result_ts_generic" | jq -e '.valid == true' >/dev/null 2>&1; then
  ok "TS generics <T> and trailing ; accepted"
else
  fail "TS generics <T> and trailing ; accepted (expected valid=true)"
fi

TASKS_TS_AMP=$(make_tasks "Intersection: A & B")
TASKS_TS_AMP_FILE="$ROOT_TMP/tasks_ts_amp.json"
printf '%s' "$TASKS_TS_AMP" > "$TASKS_TS_AMP_FILE"
result_ts_amp=$("$BIN_DIR/pipeline-validate-tasks" "$TASKS_TS_AMP_FILE" 2>/dev/null || true)
if printf '%s' "$result_ts_amp" | jq -e '.valid == true' >/dev/null 2>&1; then
  ok "TS intersection & accepted"
else
  fail "TS intersection & accepted (expected valid=true)"
fi
```

- [ ] **Step 1.2: Delete the now-obsolete rejection tests in the same file**

In `bin/tests/prompt-fencing.sh`, remove the four blocks: "semicolon should be rejected" (~lines 187-201), "ampersand should be rejected" (~lines 203-217), any "pipe should be rejected" block, any "angle-bracket should be rejected" block. Keep:

- Leading `--` rejection
- Backtick rejection
- `$(` rejection
- Control-char rejection

- [ ] **Step 1.3: Run prompt-fencing tests; verify TS acceptance tests FAIL and removed rejection tests are gone**

Run: `bash /Users/Javier/Projects/factory-plugin/bin/tests/prompt-fencing.sh`
Expected: 3 FAIL lines on `TS union | accepted`, `TS generics <T>`, `TS intersection &`. Other tests still PASS.

- [ ] **Step 1.4: Edit the regex in `bin/pipeline-validate-tasks`**

In `bin/pipeline-validate-tasks`, replace lines 108-116 with:

```bash
# Reject task descriptions containing control chars, leading --, or shell
# command-substitution syntax. Descriptions are embedded verbatim inside
# untrusted-data fences (see pipeline-build-prompt) and are never shell-eval'd,
# so the shell-metacharacters ;&|<> are NOT rejected — they appear in legit
# TypeScript syntax (unions, generics, intersections, statement terminators).
# Rejection set: leading --, backtick, $(, control chars \x00-\x08, \x0A-\x0C, \x0E-\x1F.
# Tab (\x09) and CR (\x0D) remain allowed.
bad_desc=$(jq -r '[.[] | select(.description | test("^\\s*--|`|\\$\\(|[\\x00-\\x08\\x0A-\\x0C\\x0E-\\x1F]"))] | length' "$tasks_file" 2>/dev/null || printf '0')
if (( bad_desc > 0 )); then
  errors+=("$bad_desc task(s) have unsafe description (control chars / command-substitution / leading --)")
fi
```

- [ ] **Step 1.5: Re-run prompt-fencing tests; verify ALL pass**

Run: `bash /Users/Javier/Projects/factory-plugin/bin/tests/prompt-fencing.sh`
Expected: every `ok ` line, zero `fail ` lines, exit 0.

- [ ] **Step 1.6: Commit**

```bash
git add bin/pipeline-validate-tasks bin/tests/prompt-fencing.sh
git commit -m "fix(validate-tasks): allow shell metacharacters in fenced descriptions"
```

---

## Task 2 — Bug 5 (cross-worktree commit-spec): bash-only, isolated from runtime

**Files:**

- Modify: `bin/pipeline-branch:109-155` (`commit-spec` action)
- Test: `bin/tests/branching.sh` (append new section)

- [ ] **Step 2.1: Write the failing test in `bin/tests/branching.sh`**

Append (after the last `commit-spec` test, find the section via `grep -n commit-spec bin/tests/branching.sh`):

```bash
test_case "commit-spec works when staging is checked out in sibling worktree" || true
(
  cd "$REPO"
  # Create a sibling worktree that owns staging.
  staging_wt="$REPO_TMP/staging-sibling"
  rm -rf "$staging_wt"
  git worktree add "$staging_wt" staging >/dev/null 2>&1
  # In the original cwd, switch to a non-staging branch to force cross-wt.
  git checkout -b ad-hoc-branch-1 >/dev/null 2>&1 || git checkout ad-hoc-branch-1 >/dev/null 2>&1
  spec_dir=".state/run-xwt-test"
  mkdir -p "$spec_dir"
  printf 'demo\n' > "$spec_dir/spec.md"
  printf '[]'    > "$spec_dir/tasks.json"
  out=$("$BIN_DIR/pipeline-branch" commit-spec "$spec_dir" 2>&1) || rc=$?
  if [[ "${rc:-0}" -eq 0 ]] && printf '%s' "$out" | jq -e '.action == "commit-spec"' >/dev/null 2>&1; then
    ok "commit-spec succeeds with staging in sibling worktree"
  else
    fail "commit-spec succeeds with staging in sibling worktree (got rc=${rc:-0} out=$out)"
  fi
  git worktree remove --force "$staging_wt" >/dev/null 2>&1 || true
)
```

- [ ] **Step 2.2: Run branching tests; verify NEW test FAILS**

Run: `bash /Users/Javier/Projects/factory-plugin/bin/tests/branching.sh`
Expected: FAIL on "commit-spec succeeds with staging in sibling worktree" (other tests still pass).

- [ ] **Step 2.3: Implement cross-worktree commit-spec**

Replace `bin/pipeline-branch:109-155` (the entire `commit-spec)` action block) with:

```bash
  commit-spec)
    spec_dir="${1:?missing spec dir}"
    if [[ ! -d "$spec_dir" ]]; then
      log_error "spec dir not found: $spec_dir"
      exit 1
    fi

    # Find the worktree that has 'staging' checked out. `git worktree list --porcelain`
    # emits per-worktree records:
    #   worktree <abs-path>
    #   HEAD <sha>
    #   branch refs/heads/<name>
    # We need the <abs-path> whose branch line is `refs/heads/staging`.
    staging_wt=$(git worktree list --porcelain 2>/dev/null \
      | awk '
          /^worktree / { wt = substr($0, 10); next }
          /^branch refs\/heads\/staging$/ { print wt; exit }
        ')

    if [[ -z "$staging_wt" ]]; then
      # No worktree owns staging — create it locally and check it out here.
      if ! git checkout staging &>/dev/null; then
        # staging branch may not exist yet — let staging-init handle that.
        log_error "no worktree owns 'staging' and local checkout failed"
        exit 1
      fi
      staging_wt=$(pwd)
    fi

    # Resolve spec_dir to an absolute path so `git -C "$staging_wt"` can see it
    # regardless of which worktree we were invoked from.
    abs_spec_dir=$(cd "$spec_dir" 2>/dev/null && pwd) || {
      log_error "cannot resolve spec_dir to absolute path: $spec_dir"
      exit 1
    }

    # Mirror the spec into the staging worktree under the same relative path.
    rel_spec_dir="$spec_dir"
    target_spec_dir="$staging_wt/$rel_spec_dir"
    mkdir -p "$(dirname "$target_spec_dir")"
    # Copy spec files (idempotent — repeated commit-spec calls overwrite).
    rm -rf "$target_spec_dir"
    cp -R "$abs_spec_dir" "$target_spec_dir"

    if ! git -C "$staging_wt" add -- "$rel_spec_dir"; then
      log_error "git add $rel_spec_dir in $staging_wt failed; cannot commit spec"
      exit 1
    fi

    push_result="ok"
    if git -C "$staging_wt" diff --cached --quiet 2>/dev/null; then
      sha=$(git -C "$staging_wt" rev-parse HEAD)
      result="no-op"
    else
      git -C "$staging_wt" \
          -c user.email=factory@local \
          -c user.name="factory" \
          commit -m "chore: add spec directory $rel_spec_dir" --quiet
      sha=$(git -C "$staging_wt" rev-parse HEAD)
      result="committed"
    fi

    if ! git -C "$staging_wt" push origin staging --quiet 2>/dev/null; then
      log_warn "git push origin staging failed; subagents may not see the spec"
      push_result="failed"
    fi

    json_output action "commit-spec" \
                result "$result" \
                spec_dir "$rel_spec_dir" \
                branch "staging" \
                sha "$sha" \
                push "$push_result" \
                staging_worktree "$staging_wt"
    ;;
```

- [ ] **Step 2.4: Run branching tests; verify the new test PASSES**

Run: `bash /Users/Javier/Projects/factory-plugin/bin/tests/branching.sh`
Expected: all `ok ` including "commit-spec succeeds with staging in sibling worktree".

- [ ] **Step 2.5: Update orchestrator SKILL.md step 5 to route staging mutations via `git -C <staging-wt>`**

In `skills/pipeline-orchestrator/SKILL.md` step 5 (lines ~233-257), replace the existing block with a version that resolves the staging worktree path first and routes git commands through it:

````markdown
5. **Resolve handoff onto staging.**

   ```bash
   handoff_branch=$(pipeline-state read "$run_id" .spec.handoff_branch)
   handoff_ref=$(pipeline-state read "$run_id" .spec.handoff_ref)
   spec_path=$(pipeline-state read "$run_id" .spec.path)
   [[ -z "$handoff_branch" ]] && { pipeline-gh-comment <issue> ci-escalation --data '{"reason":"spec handoff missing"}'; pipeline-state write "$run_id" .status '"failed"'; exit 1; }

   # Resolve the worktree that owns `staging` so all staging mutations run in it
   # — works whether the orchestrator runs in main or a separate worktree.
   staging_wt=$(git worktree list --porcelain 2>/dev/null \
     | awk '/^worktree / { wt = substr($0, 10); next } /^branch refs\/heads\/staging$/ { print wt; exit }')
   [[ -z "$staging_wt" ]] && staging_wt="$(pwd)"  # fallback: assume current cwd is staging-owning

   git -C "$staging_wt" push origin "$handoff_branch" 2>/dev/null || true
   git -C "$staging_wt" fetch origin "$handoff_branch" 2>/dev/null || git -C "$staging_wt" rev-parse --verify "$handoff_ref" >/dev/null
   mkdir -p "$staging_wt/.state/$run_id"
   git -C "$staging_wt" show "$handoff_ref:$spec_path/spec.md"    > "$staging_wt/.state/$run_id/spec.md"
   git -C "$staging_wt" show "$handoff_ref:$spec_path/tasks.json" > "$staging_wt/.state/$run_id/tasks.json"
   git -C "$staging_wt" checkout staging 2>/dev/null || true   # no-op if already on staging
   git -C "$staging_wt" merge --ff-only "$handoff_ref" || git -C "$staging_wt" merge --no-ff "$handoff_ref" -m "chore: merge spec handoff for $run_id"
   git -C "$staging_wt" push origin --delete "$handoff_branch" 2>/dev/null || true
   git -C "$staging_wt" branch -D "$handoff_branch" 2>/dev/null || true
   pipeline-state write "$run_id" .spec.path "\"$staging_wt/.state/$run_id\""
   pipeline-state write "$run_id" .spec.committed true
   pipeline-branch commit-spec ".state/$run_id"
   git -C "$staging_wt" ls-remote --exit-code --heads origin staging >/dev/null \
     || { log_error "origin/staging missing after commit-spec — aborting before task fan-out"; exit 1; }
   ```
````

````

- [ ] **Step 2.6: Commit**

```bash
git add bin/pipeline-branch bin/tests/branching.sh skills/pipeline-orchestrator/SKILL.md
git commit -m "fix(staging-worktree): commit-spec and orchestrator step 5 use git -C <staging-wt>"
````

---

## Task 3 — Bug 4 (spec-generator self-review): move spec-reviewer spawn to orchestrator

**Files:**

- Modify: `agents/spec-generator.md` (remove §3 "Spec Review")
- Modify: `skills/pipeline-orchestrator/prompts/spec-generator.md:22` (drop spawn instruction)
- Modify: `skills/pipeline-orchestrator/SKILL.md:222-231` (add explicit spec-reviewer spawn step)

This task has no Bash test — it is a protocol/agent-card change. Verification is by re-reading the resulting files and confirming the spec-generator no longer references `spec-reviewer` and the orchestrator skill does.

- [ ] **Step 3.1: Remove "Spec Review" section from spec-generator agent card**

In `agents/spec-generator.md`, delete the entire `### 3. Spec Review` section (lines 103-119 in the file as read above). Renumber `### 4. Report Failure` → `### 3. Report Failure`. In the **Verification Checklist** (lines 211-221), remove the line `- [ ] `spec-reviewer` returned PASS with score ≥ 54/60`.

Add a new section between the existing §2 and renumbered §3:

```markdown
### 3. Hand Off — Do NOT Self-Review

After validation passes, **stop**. Do not invoke `spec-reviewer`. The orchestrator owns review-spawn so the reviewing context is provably independent of the generating context. Execute the Handoff Protocol (below) and emit `STATUS: DONE` with the validation output. If the orchestrator's downstream review fails, it will re-invoke you with feedback embedded in the prompt — handle that as a regeneration loop, not as a self-review.
```

- [ ] **Step 3.2: Update the wrapper prompt template**

In `skills/pipeline-orchestrator/prompts/spec-generator.md`, replace lines 19-23 (the `Execution` post-write block) with:

```markdown
After writing spec.md + tasks.json:

1. `pipeline-validate-spec <spec-dir>` — max 5 validation retries.
2. Execute the Handoff Protocol. **DO NOT spawn `spec-reviewer`** — the orchestrator owns review-spawn for independence guarantees.
3. On validation exhaustion: `pipeline-gh-comment <issue> spec-failure --data '{"reason":"..."}'` and exit.
```

- [ ] **Step 3.3: Update orchestrator skill protocol**

In `skills/pipeline-orchestrator/SKILL.md`, replace the existing step 3-4 block (lines ~222-231) with:

```markdown
3. **Spawn spec-generator.** `Agent({subagent_type: "spec-generator", isolation: "worktree", prompt_file: skills/pipeline-orchestrator/prompts/spec-generator.md})`. The agent commits spec.md + tasks.json on `spec-handoff/$run_id` and writes `.spec.handoff_branch`, `.spec.handoff_ref`, `.spec.path` to state. It MUST NOT spawn `spec-reviewer` itself — review is your responsibility.

4. **Spawn spec-reviewer (Iron Law 3: independence).** After spec-generator returns `STATUS: DONE`, build a prompt containing the verbatim contents of `<handoff_ref>:<spec_path>/spec.md` and `<handoff_ref>:<spec_path>/tasks.json`, then:
```

Agent({
subagent_type: "spec-reviewer",
isolation: "worktree",
prompt_file: <path to per-run prompt with embedded spec/tasks>
})

````

Parse the reviewer STATUS line and review-file output. If score < 54/60:
- If iteration budget (max 5) not exhausted: re-spawn spec-generator with the reviewer's findings embedded as `REVIEW_FEEDBACK` in the prompt, then re-spawn spec-reviewer. Loop.
- If budget exhausted: `pipeline-gh-comment <issue> spec-failure --data '{"reason":"spec-reviewer below threshold","score":<score>}'`, mark run failed.

5. **Persist review score.**

```bash
if [[ -f "$spec_reviewer_output" ]]; then
  score=$(jq -r '.score // empty' "$spec_reviewer_output")
  [[ -n "$score" ]] && pipeline-state write "$run_id" '.spec.review_score' "$score"
fi
````

````

Renumber the subsequent steps (current 5→6, 6→7, 7→8) and update all internal back-references in the file (search for "step 5", "step 6", "step 7" and fix).

- [ ] **Step 3.4: Re-read the three modified files end-to-end and confirm no remaining cross-references where spec-generator spawns spec-reviewer**

Run: `grep -rn "spec-reviewer\|spec_reviewer" agents/spec-generator.md skills/pipeline-orchestrator/prompts/spec-generator.md`
Expected: zero output (only the SKILL.md should mention spec-reviewer now).

Run: `grep -n "spec-reviewer" skills/pipeline-orchestrator/SKILL.md`
Expected: at least one match in the new step 4.

- [ ] **Step 3.5: Commit**

```bash
git add agents/spec-generator.md skills/pipeline-orchestrator/prompts/spec-generator.md skills/pipeline-orchestrator/SKILL.md
git commit -m "fix(orchestrator): orchestrator spawns spec-reviewer (was: spec-generator self-spawn)"
````

---

## Task 4 — Bug 2 (test-writer→executor worktree handoff)

**Why this is the big one:** Two-phase TDD breaks if executor can't see RED. Fix is wrapper-side: push test-writer's branch after `_verify_red_tests` succeeds, then embed a bootstrap setup block in the executor prompt that fetches and resets to that branch on first run.

**Files:**

- Modify: `bin/pipeline-run-task` `_stage_preexec_tests` (around lines 615-687) — push test-writer branch + record branch name
- Modify: `bin/pipeline-build-prompt` — accept new `--bootstrap-branch <name>` flag and prepend a setup-block to the emitted prompt
- Modify: `agents/task-executor.md` — body text describing the worktree contents
- Create: `bin/tests/preexec-handoff.sh` — end-to-end verification

- [ ] **Step 4.1: Write the failing test**

Create `bin/tests/preexec-handoff.sh`:

```bash
#!/usr/bin/env bash
# Bug 2: test-writer→executor branch handoff.
#
# Asserts:
#   1. _stage_preexec_tests, after RED_READY verification, pushes the
#      test-writer worktree's branch to origin.
#   2. The executor prompt emitted by _emit_manifest contains a bootstrap
#      block referencing that branch (fetch + reset --hard).
#   3. last_prompt_hash is recorded.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

setup_fake_repo
init_state_for_task "task_42" "Demo task" "src/demo.ts"

# Simulate a test-writer worktree with a green-faking RED commit.
tw_wt="$REPO_TMP/wt-test-writer"
git worktree add -b worktree-agent-DEADBEEF "$tw_wt" >/dev/null 2>&1
( cd "$tw_wt"
  mkdir -p tests
  printf 'test("demo", () => { throw new Error("RED"); });\n' > tests/demo.test.ts
  git add tests/demo.test.ts
  git -c user.email=t@t -c user.name=t commit -m "test(demo): failing tests for task_42 [task_42]" --quiet
)

# Record test-writer status + worktree on state.
pipeline-state task-write "$RUN_ID" task_42 worktree "\"$tw_wt\""
pipeline-state task-write "$RUN_ID" task_42 test_writer_status '"RED_READY"'

# Stub _verify_red_tests so it always succeeds (the integration concern here
# is the branch handoff, not red verification — covered by separate tests).
export FACTORY_TEST_VERIFY_RED_OVERRIDE=1

# Run the preexec_tests stage.
out=$(pipeline-run-task preexec_tests "$RUN_ID" task_42 2>&1) || true

# Assertion 1: branch pushed to origin
if git -C "$REPO" rev-parse --verify --quiet refs/remotes/origin/worktree-agent-DEADBEEF >/dev/null; then
  ok "test-writer branch pushed to origin"
else
  fail "test-writer branch pushed to origin"
fi

# Assertion 2: emitted executor prompt has bootstrap block
prompt_file="$CLAUDE_PLUGIN_DATA/runs/$RUN_ID/.state/$RUN_ID/task_42.executor-prompt.md"
if [[ -f "$prompt_file" ]] && grep -q 'git fetch origin worktree-agent-DEADBEEF' "$prompt_file" && grep -q 'git reset --hard origin/worktree-agent-DEADBEEF' "$prompt_file"; then
  ok "executor prompt contains branch-bootstrap block"
else
  fail "executor prompt contains branch-bootstrap block (prompt_file=$prompt_file)"
fi

# Assertion 3: last_prompt_hash recorded
hash=$(pipeline-state read "$RUN_ID" ".tasks.task_42.last_prompt_hash // empty")
if [[ -n "$hash" && "$hash" != '""' ]]; then
  ok "last_prompt_hash recorded ($hash)"
else
  fail "last_prompt_hash recorded"
fi

summary
```

The helpers `setup_fake_repo`, `init_state_for_task`, `ok`, `fail`, `summary` live in `bin/tests/lib.sh`. If `init_state_for_task` doesn't exist, create it next to `setup_fake_repo` (consult `bin/tests/lib.sh` for current helpers — fall back to an inline `pipeline-init` + `pipeline-state task-init` call if needed).

- [ ] **Step 4.2: Run the new test; verify it FAILS**

Run: `bash /Users/Javier/Projects/factory-plugin/bin/tests/preexec-handoff.sh`
Expected: at least the first two assertions FAIL (no push, no bootstrap block in prompt).

- [ ] **Step 4.3: Add the `--bootstrap-branch` flag to pipeline-build-prompt**

Read the current arg-parsing block in `bin/pipeline-build-prompt` first to anchor the change, then add a new option. After the existing `--holdout`/`--spec-path` parsing, before the prompt body is emitted, add (pseudo-location: right before the first `printf` of the prompt body):

```bash
bootstrap_branch=""
# Parse --bootstrap-branch <branch> from args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bootstrap-branch) bootstrap_branch="$2"; shift 2 ;;
    *) shift ;;  # other flags handled earlier
  esac
done

# … existing prompt-emission code …

# Prepend bootstrap block when supplied. Plain shell commands; the agent
# executes them via Bash on first run before doing anything else.
if [[ -n "$bootstrap_branch" ]]; then
  cat <<EOF
## Bootstrap (run these commands BEFORE anything else)

You spawned into a fresh worktree at \`origin/staging\`. The prior test-writer
phase committed failing tests on branch \`$bootstrap_branch\`. Sync to that
branch so you can see (and turn green) those tests:

\`\`\`bash
git fetch origin $bootstrap_branch staging --depth=50
git reset --hard origin/$bootstrap_branch
\`\`\`

Verify: \`git log --oneline -1\` should show the test-writer's \`test(...): failing tests for <task_id>\` commit.

EOF
fi

# … then the existing body emission …
```

(Exact integration depends on the current structure — read `bin/pipeline-build-prompt` end-to-end first and place the bootstrap block above the existing task header so it appears first in the prompt.)

- [ ] **Step 4.4: Modify `_stage_preexec_tests` to push the test-writer branch and pass `--bootstrap-branch`**

In `bin/pipeline-run-task`, locate `_stage_preexec_tests` (line 541). After `_verify_red_tests "$tw_wt"` succeeds (line 621) and BEFORE building the executor prompt (line 633), insert:

```bash
  # Discover the branch the test-writer committed on. Default to the agent SDK's
  # worktree branch naming if not explicit; fall back to current HEAD's symbolic
  # ref.
  local tw_branch
  tw_branch=$(git -C "$tw_wt" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  if [[ -z "$tw_branch" || "$tw_branch" == "HEAD" ]]; then
    log_error "cannot resolve test-writer branch in $tw_wt"
    _task_write test_writer_status '"BLOCKED"'
    "$_STATE_BIN" task-status "$run_id" "$task_id" failed >/dev/null || true
    t1=$(_now_ms)
    log_step_end "preexec_tests" "failed" "$((t1-t0))" "task_id=\"$task_id\"" "reason=\"tw_branch_unresolved\""
    return 30
  fi

  # Push the test-writer's branch so the executor's fresh worktree can fetch it.
  # `git push -u` is idempotent; we tolerate push failure ONLY when the repo
  # has no remote (offline/local-only). Hard-fail if a remote exists but push
  # rejected (auth, branch protection) — executor cannot proceed without it.
  if git -C "$tw_wt" remote get-url origin >/dev/null 2>&1; then
    if ! git -C "$tw_wt" push -u origin "$tw_branch" --quiet 2>&1; then
      log_error "git push origin $tw_branch from $tw_wt failed"
      _task_write test_writer_status '"BLOCKED"'
      "$_STATE_BIN" task-status "$run_id" "$task_id" failed >/dev/null || true
      t1=$(_now_ms)
      log_step_end "preexec_tests" "failed" "$((t1-t0))" "task_id=\"$task_id\"" "reason=\"tw_branch_push_failed\""
      return 30
    fi
  else
    log_warn "no origin remote; executor will run without fetched RED commits (local-only mode)"
  fi
  _task_write test_writer_branch "\"$tw_branch\""
```

Then in the same function, modify the `args` array for `pipeline-build-prompt` (around line 647-649):

```bash
  local args=()
  [[ -n "$spec_path" ]] && args+=(--spec-path "$spec_path")
  args+=(--holdout "$holdout_pct")
  # Only embed bootstrap when origin push succeeded (push presence proven above).
  if git -C "$tw_wt" remote get-url origin >/dev/null 2>&1; then
    args+=(--bootstrap-branch "$tw_branch")
  fi
```

- [ ] **Step 4.5: Update task-executor agent card body**

In `agents/task-executor.md:18`, replace:

```
You are the GREEN phase of a TDD cycle in the factory pipeline. A prior `test-writer` subagent has already committed failing tests for this task in the worktree. Your job is to write the minimal implementation that turns them green.
```

with:

```
You are the GREEN phase of a TDD cycle in the factory pipeline. A prior `test-writer` subagent committed failing tests for this task on a sibling branch (named in the Bootstrap section of your prompt). Your fresh worktree starts at `origin/staging`; the Bootstrap block tells you exactly how to sync to the test-writer branch. **Run the Bootstrap commands first**; do not start editing before they complete successfully. Your job after sync is to write the minimal implementation that turns the failing tests green.
```

- [ ] **Step 4.6: Run the new test; verify it PASSES**

Run: `bash /Users/Javier/Projects/factory-plugin/bin/tests/preexec-handoff.sh`
Expected: every `ok ` line, zero `fail `, exit 0.

- [ ] **Step 4.7: Run existing run-wrapper tests to confirm no regression**

Run: `bash /Users/Javier/Projects/factory-plugin/bin/tests/run-wrapper.sh`
Expected: green; all existing assertions still pass.

- [ ] **Step 4.8: Commit**

```bash
git add bin/pipeline-run-task bin/pipeline-build-prompt agents/task-executor.md bin/tests/preexec-handoff.sh
git commit -m "fix(run-task): push test-writer branch + bootstrap executor prompt"
```

---

## Task 5 — Bug 1 (runs/current symlink): hook env-var canonicalization (PRIMARY) + defensive layers

**Why last:** Touches six hooks plus pipeline-init/pipeline-state — largest surface area, easiest to regress. PRIMARY root cause is that hooks read raw `${CLAUDE_PLUGIN_DATA}` before sourcing `pipeline-lib.sh`, so when the codex plugin leaks a foreign value into the orchestrator session every hook looks at `codex-openai-codex/runs/current` (missing) instead of `factory-jfa94/runs/current`. Fix is layered: canonicalize in every hook, add a recovery action, add diagnostics for any remaining failure mode.

**Files:**

- Modify: `hooks/subagent-stop-transcript.sh` — source pipeline-lib.sh at top (PRIMARY); add loud-on-missing diagnostic
- Modify: `hooks/run-tracker.sh`, `hooks/pretooluse-pipeline-guards.sh`, `hooks/session-start-resume.sh`, `hooks/stop-gate.sh` — source pipeline-lib.sh at top
- Modify: `hooks/secret-commit-guard.sh`, `hooks/write-protection.sh` — source pipeline-lib.sh at top (config_file path uses CLAUDE_PLUGIN_DATA)
- Modify: `bin/pipeline-init` — add a post-rename verification (defense-in-depth)
- Modify: `bin/pipeline-state` — add new `ensure-current <run-id>` action (recovery)
- Create: `bin/tests/symlink-recovery.sh`

**Notes:**

- `hooks/subagent-stop-gate.sh` and `hooks/asyncrewake-ci.sh` ALREADY source pipeline-lib.sh early — they're correct, leave them.
- Removed from earlier draft: `finalize-on-stop` conditional symlink removal (speculative; no evidence the user's run reached finalize). Plan keeps the existing unconditional removal at line 689-691.

- [ ] **Step 5.1: Write the failing test**

Create `bin/tests/symlink-recovery.sh`:

```bash
#!/usr/bin/env bash
# Bug 1: hook env-var canonicalization + defensive ensure + loud-on-missing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

setup_fake_repo

CORRECT_DATA="$CLAUDE_PLUGIN_DATA"

# --- Assertion 1: pipeline-init creates the symlink and exits 0. ---
RUN_ID="run-symlink-1"
out=$(pipeline-init "$RUN_ID" --mode task 2>&1) || rc=$?
if [[ -L "$CORRECT_DATA/runs/current" ]] \
   && [[ "$(readlink "$CORRECT_DATA/runs/current")" == "$CORRECT_DATA/runs/$RUN_ID" ]]; then
  ok "pipeline-init creates current symlink"
else
  fail "pipeline-init creates current symlink (rc=${rc:-0})"
fi

# --- Assertion 2: subagent-stop-transcript honors canonicalization (PRIMARY). ---
# Simulate the codex-plugin-leak scenario: CLAUDE_PLUGIN_DATA points at a foreign
# plugin dir, but the hook MUST canonicalize via pipeline-lib.sh and read from
# the real factory-jfa94 path. With the fix, the hook locates the symlink and
# writes state. Without the fix, it silent-exits.
foreign_data="$(dirname "$CORRECT_DATA")/codex-openai-codex"
mkdir -p "$foreign_data/runs"  # foreign dir has no symlink
# Pre-seed state with a task to receive the write.
pipeline-state task-init "$RUN_ID" task_zz '{"task_id":"task_zz","title":"x","description":"x","files":["src/x.ts"],"acceptance_criteria":["c"],"tests_to_write":["t"],"depends_on":[]}'
# Tell the hook which task is active.
printf '{"task_id":"task_zz"}' > "$CORRECT_DATA/runs/$RUN_ID/.active-spawn.json"

CLAUDE_PLUGIN_DATA="$foreign_data" \
  printf '%s' '{"agent_type":"task-executor","last_assistant_message":"STATUS: DONE"}' \
  | CLAUDE_PLUGIN_DATA="$foreign_data" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    "$PLUGIN_ROOT/hooks/subagent-stop-transcript.sh" 2>&1 >/dev/null || true

written_status=$(pipeline-state read "$RUN_ID" '.tasks.task_zz.executor_status // empty')
if [[ "$written_status" == '"DONE"' ]]; then
  ok "hook canonicalizes foreign CLAUDE_PLUGIN_DATA before symlink check"
else
  fail "hook canonicalizes foreign CLAUDE_PLUGIN_DATA (got executor_status=$written_status)"
fi

# --- Assertion 3: pipeline-state ensure-current restores the symlink if removed. ---
rm -f "$CORRECT_DATA/runs/current"
pipeline-state ensure-current "$RUN_ID" >/dev/null
if [[ -L "$CORRECT_DATA/runs/current" ]]; then
  ok "ensure-current restores missing symlink"
else
  fail "ensure-current restores missing symlink"
fi

# --- Assertion 4: ensure-current refuses to clobber an active run. ---
RUN_ID2="run-symlink-2"
pipeline-init "$RUN_ID2" --mode task --force >/dev/null
rm -f "$CORRECT_DATA/runs/current"
ln -s "$CORRECT_DATA/runs/$RUN_ID" "$CORRECT_DATA/runs/current"
pipeline-state write "$RUN_ID" .status '"running"' >/dev/null
if pipeline-state ensure-current "$RUN_ID2" 2>/dev/null; then
  fail "ensure-current refuses to clobber an active run"
else
  ok "ensure-current refuses to clobber an active run"
fi

# --- Assertion 5: hook warns loudly when symlink genuinely missing even after canonicalize. ---
# (Different from assertion 2: here the CORRECT data dir has no symlink either.)
rm -f "$CORRECT_DATA/runs/current"
err_out=$(printf '%s' '{"agent_type":"task-executor","last_assistant_message":"STATUS: DONE"}' \
  | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" "$PLUGIN_ROOT/hooks/subagent-stop-transcript.sh" 2>&1 || true)
if printf '%s' "$err_out" | grep -q 'symlink missing'; then
  ok "subagent-stop-transcript fails loud on missing symlink"
else
  fail "subagent-stop-transcript fails loud on missing symlink (got: $err_out)"
fi

summary
```

Helpers used (`setup_fake_repo`, `ok`, `fail`, `summary`, `PLUGIN_ROOT`) live in `bin/tests/lib.sh` — confirm they exist before relying on them; otherwise stub minimal versions inline.

- [ ] **Step 5.2: Run the new test; verify it FAILS**

Run: `bash /Users/Javier/Projects/factory-plugin/bin/tests/symlink-recovery.sh`
Expected: assertion 2 (`hook canonicalizes foreign CLAUDE_PLUGIN_DATA`) FAILS — hook still reads raw env. Assertion 3 (`ensure-current restores`) FAILS — action does not exist yet. Assertion 5 FAILS — hook silent. Assertions 1, 4 may pass.

- [ ] **Step 5.3: Add `ensure-current` action to pipeline-state**

In `bin/pipeline-state`, locate the `case "$action" in` dispatch (search for `task-status)` or `write)` to find it). Add a new branch BEFORE the catchall `*)`:

```bash
  ensure-current)
    run_id="${1:?missing run id}"
    require_plugin_data
    runs_dir="${CLAUDE_PLUGIN_DATA}/runs"
    run_dir="${runs_dir}/${run_id}"
    if [[ ! -d "$run_dir" ]]; then
      log_error "ensure-current: run dir not found: $run_dir"
      exit 1
    fi
    current_link="${runs_dir}/current"
    if [[ -L "$current_link" ]]; then
      target=$(readlink "$current_link" 2>/dev/null || true)
      if [[ -n "$target" && "$target" != "$run_dir" && -f "$target/state.json" ]]; then
        status=$(jq -r '.status // "unknown"' "$target/state.json" 2>/dev/null || echo "unknown")
        if [[ "$status" == "running" ]]; then
          other=$(basename "$target")
          log_error "ensure-current: current symlink points at active run '$other' — refusing to clobber"
          exit 1
        fi
      fi
    fi
    tmp="${current_link}.tmp.$$"
    ln -sfn "$run_dir" "$tmp" || { log_error "ensure-current: ln -s tmp failed"; exit 1; }
    if mv -fh "$tmp" "$current_link" 2>/dev/null \
       || mv -fT "$tmp" "$current_link" 2>/dev/null; then
      :
    else
      rm -f "$tmp"
      log_error "ensure-current: atomic rename failed for $current_link"
      exit 1
    fi
    jq -n --arg run_id "$run_id" --arg target "$run_dir" \
       '{action: "ensure-current", run_id: $run_id, target: $target, restored: true}'
    ;;
```

- [ ] **Step 5.4: Make pipeline-init verify the symlink at the end**

In `bin/pipeline-init`, immediately after the final success block (after `human_summary` at line 158, before the closing `jq -n` JSON emission at line 160), insert:

```bash
# Post-init sanity check: the symlink must exist and point at our run_dir.
if [[ ! -L "$current_link" ]]; then
  log_error "pipeline-init: 'current' symlink missing after creation — atomic rename failed silently"
  rm -rf "$run_dir"
  exit 1
fi
actual_target=$(readlink "$current_link" 2>/dev/null || true)
if [[ "$actual_target" != "$run_dir" ]]; then
  log_error "pipeline-init: 'current' symlink points at '$actual_target', expected '$run_dir'"
  rm -rf "$run_dir"
  exit 1
fi
```

- [ ] **Step 5.5: PRIMARY FIX — source pipeline-lib.sh at top of every affected hook**

For each of the six hooks below, insert the lib-source block immediately AFTER the existing `set -euo pipefail` line and BEFORE the first reference to `CLAUDE_PLUGIN_DATA`:

```bash
# Canonicalize CLAUDE_PLUGIN_DATA before reading from it. When a foreign plugin
# (e.g. codex) leaks its CLAUDE_PLUGIN_DATA into this session, pipeline-lib.sh's
# top-level redirect rewrites the env var to factory's data dir. Without this,
# the hook reads from the wrong runs/current and silent-exits, losing all state
# writes for the run.
_lib="${CLAUDE_PLUGIN_ROOT:-}/bin/pipeline-lib.sh"
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -f "$_lib" ]]; then
  # shellcheck disable=SC1090
  source "$_lib" 2>/dev/null || true
fi
```

Targets:

- `hooks/subagent-stop-transcript.sh` (insert after line 22 `set -euo pipefail`, before line 24 `current_link=…`). Also DELETE the existing late lib-source at lines 236-239 — the early source replaces it.
- `hooks/run-tracker.sh` (insert after `set -euo pipefail`, before line 91 `current_link=…`)
- `hooks/pretooluse-pipeline-guards.sh` (insert after `set -euo pipefail`, before line 32 `current_link=…`)
- `hooks/session-start-resume.sh` (insert after `set -euo pipefail`, before line 19 `current_link=…`)
- `hooks/stop-gate.sh` (insert after `set -euo pipefail`, before line 23 `current_link=…`)
- `hooks/secret-commit-guard.sh` (insert after `set -euo pipefail`, before line 106 `config_file=…`)
- `hooks/write-protection.sh` (insert after `set -euo pipefail`, before line 20 `config_file=…`)

Skip `hooks/subagent-stop-gate.sh` and `hooks/asyncrewake-ci.sh` — already source the lib early.

- [ ] **Step 5.6: Make subagent-stop-transcript hook fail loud when symlink missing after canonicalization**

In `hooks/subagent-stop-transcript.sh`, replace the existing top guard (now at lines ~32-35 after Step 5.5's insertion):

```bash
current_link="${CLAUDE_PLUGIN_DATA:-}/runs/current"
if [[ -z "${CLAUDE_PLUGIN_DATA:-}" || ! -L "$current_link" ]]; then
  exit 0
fi
```

with:

```bash
current_link="${CLAUDE_PLUGIN_DATA:-}/runs/current"
if [[ -z "${CLAUDE_PLUGIN_DATA:-}" ]]; then
  # No plugin data dir — hook not configured for this run. Silent exit is OK.
  exit 0
fi
if [[ ! -L "$current_link" ]]; then
  # Plugin data dir IS set AND has been canonicalized (Step 5.5), yet the symlink
  # is genuinely missing. This is the failure mode that hides all subagent state
  # writes. Log loudly so it surfaces in transcripts and stderr.
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '[%s] [WARN] subagent-stop-transcript: runs/current symlink missing under %s — state writes skipped\n' \
    "$ts" "$CLAUDE_PLUGIN_DATA" >&2
  err_log="$CLAUDE_PLUGIN_DATA/hook-errors.log"
  printf '[%s] subagent-stop-transcript: symlink missing\n' "$ts" >> "$err_log" 2>/dev/null || true
  exit 0
fi
```

- [ ] **Step 5.7: Run the new symlink-recovery test; verify ALL assertions PASS**

Run: `bash /Users/Javier/Projects/factory-plugin/bin/tests/symlink-recovery.sh`
Expected: every `ok ` line, zero `fail `, exit 0.

- [ ] **Step 5.8: Run all hook + state existing tests to confirm no regression**

Run: `bash /Users/Javier/Projects/factory-plugin/bin/tests/hooks.sh && bash /Users/Javier/Projects/factory-plugin/bin/tests/state.sh`
Expected: green. If any pre-existing test breaks because it set a hook-related env var without `CLAUDE_PLUGIN_ROOT`, fix the test to set `CLAUDE_PLUGIN_ROOT` (not the production code) since `CLAUDE_PLUGIN_ROOT` is part of the documented plugin-runtime contract.

- [ ] **Step 5.9: Commit**

```bash
git add hooks/subagent-stop-transcript.sh hooks/run-tracker.sh hooks/pretooluse-pipeline-guards.sh \
        hooks/session-start-resume.sh hooks/stop-gate.sh hooks/secret-commit-guard.sh \
        hooks/write-protection.sh bin/pipeline-init bin/pipeline-state bin/tests/symlink-recovery.sh
git commit -m "fix(hooks): canonicalize CLAUDE_PLUGIN_DATA before symlink/config reads"
```

---

## Task 6 — Full regression run + ship

- [ ] **Step 6.1: Run the entire test suite**

Run: `bash /Users/Javier/Projects/factory-plugin/bin/test`
Expected: zero failing tests across all `bin/tests/*.sh` harnesses.

If any pre-existing test fails due to our changes, fix the test (not by gutting it — by updating its expectations to the new contract) or revisit the implementation if the regression is real.

- [ ] **Step 6.2: Manual smoke verification of one run end-to-end**

In a scratch repo:

```bash
pipeline-init "smoke-$(date +%s)" --mode task --spec-dir /tmp/demo-spec
ls -la "$CLAUDE_PLUGIN_DATA/runs/current"
# Expected: symlink → smoke-* run dir, both present.

# Trigger a fake subagent-stop and check the hook surfaces correctly:
rm -f "$CLAUDE_PLUGIN_DATA/runs/current"
printf '{"agent_type":"task-executor","last_assistant_message":"STATUS: DONE"}' \
  | hooks/subagent-stop-transcript.sh
# Expected: STDERR warning "symlink missing", non-zero exit-code-zero (hook is best-effort).
```

- [ ] **Step 6.3: Push and open PR**

```bash
git push -u origin <branch>
gh pr create --title "Pipeline run-time bug fixes (5 bugs)" --body "$(cat <<'EOF'
## Summary
- Bug 1: `runs/current` symlink — PRIMARY fix is canonicalize `CLAUDE_PLUGIN_DATA` in every hook by sourcing `pipeline-lib.sh` early. Defensive layers: `pipeline-state ensure-current`, post-init verify, loud-on-missing.
- Bug 2: test-writer → executor branch handoff — wrapper pushes test-writer branch and embeds a bootstrap block in the executor prompt.
- Bug 3: `pipeline-validate-tasks` description regex relaxed to allow TypeScript syntax (`|`, `;`, `<>`); descriptions are nonce-fenced and never shell-eval'd.
- Bug 4: spec-generator no longer self-spawns spec-reviewer; orchestrator owns the review-spawn for independence.
- Bug 5: `pipeline-branch commit-spec` AND orchestrator SKILL.md step 5 resolve the worktree that owns `staging` via `git worktree list --porcelain` and route staging mutations via `git -C <staging-wt>`.

## Test plan
- [ ] `bin/test` exits 0
- [ ] `bin/tests/preexec-handoff.sh` passes
- [ ] `bin/tests/symlink-recovery.sh` passes
- [ ] `bin/tests/prompt-fencing.sh` passes (TS syntax acceptance)
- [ ] `bin/tests/branching.sh` passes (cross-worktree commit-spec)
- [ ] Smoke: fresh `pipeline-init` creates `runs/current` symlink

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

(Do NOT push or open PR until user explicitly approves — this step is documented for completion only.)

---

## Self-Review Checklist (run after writing the plan, before execution handoff)

- **Spec coverage:** five bugs in user report → five implementation tasks (1=Bug 3, 2=Bug 5, 3=Bug 4, 4=Bug 2, 5=Bug 1) + a final regression task. Covered.
- **Placeholder scan:** no TODO/TBD/"similar to". Each step shows the code, the command, and the expected output.
- **Type/name consistency:**
  - `tw_branch` used uniformly in Task 4 (4.4) and in the test (4.1).
  - `bootstrap_branch` used in both Task 4.3 (CLI flag in pipeline-build-prompt) and 4.4 (wrapper passes it).
  - `ensure-current` action used identically in Task 5.3 (impl) and Task 5.1 (test).
- **Independence:** Tasks 1, 2 are cleanly isolated. Task 3 (Bug 4) touches docs only. Task 4 (Bug 2) touches the wrapper. Task 5 (Bug 1) touches init/state/hook. Task 6 is the final gate.

## Open Questions (concise)

1. Bug 1: should we add a SessionStart hook that runs `pipeline-state ensure-current` on every session resume, as belt-and-suspenders against any future env-var leak we miss?
2. Bug 2: cleaner alternative — does the Claude Code Agent SDK accept `cwd: "<test-writer-wt>"` in the spawn manifest? If yes, drop `isolation: worktree` from `agents/task-executor.md` and pass `cwd` directly. Eliminates push/fetch/bootstrap. Needs SDK doc check before adopting.
3. Bug 2: executor re-spawn idempotency — should the Bootstrap block short-circuit when `git log -1 --pretty=%s` already shows `test(...): failing tests for <task_id>`? (Cheap guard; prevents needless reset on retry.)
4. Bug 4: max review iterations = 5 is hardcoded — promote to `.spec.reviewMaxIterations` config key?
5. Bug 4 hardening: add a `SubagentStop` hook for `spec-generator` that scans its transcript for evidence of a spec-reviewer self-spawn and logs a violation (defense-in-depth against future regression of the role split).
6. Bug 5: orchestrator SKILL.md step 5's `git -C "$staging_wt" checkout staging` becomes a no-op when the staging worktree is already on staging (expected path), but errors when `staging_wt` was checked out on a different ref. Should we drop the `git checkout staging` entirely and require staging-wt to ALWAYS be on staging by convention?
7. Bug 3: keep tab/CR allowed, or also reject newline-equivalents in descriptions if any downstream consumer trims differently? (Current diff keeps existing newline rejection.)
