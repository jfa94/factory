# systemic-failure-reviewer — raw findings

Status: DONE
Verdict: None

## Finding 1: [critical] src/orchestrator/e2e.ts:248 — E2E re-authoring gate is permanently defeated by any pre-manifest authoring failure, and the documented repair (rescue --reset-e2e) does not restore it

**Quote:** `if (run.e2e_phase === undefined) {
    return prepareAuthorSpawn(deps, run, runId, cfg.startCommand, cfg.baseURL, cfg.testDir);
  }`

**Why:** runE2eEmit's ONLY gate for re-spawning the e2e-author is `run.e2e_phase === undefined` (line 248). But runE2eRecord's early failure branches (parseProducerStatus rejection, empty-manifest-without-no_ui_surface, assertSafeSpecPath rejection, unknown task_ids — all lines 325-354) call markFailed BEFORE any real manifest is ever recorded; markFailed (line 552) unconditionally writes `e2e_phase: { ...(s.e2e_phase ?? defaultE2ePhase()), status: 'failed', ... }`, so `e2e_phase` becomes a defined object with `manifest: []` even though authoring never actually produced one. From that point on `e2e_phase` can never again be `undefined`, so runE2eEmit can never re-enter the authoring branch — every future entry falls into `runSuiteAndDecide` (line 255/612), whose `manifest.length === 0` branch (line 622) unconditionally calls `markDone` and reports `{ kind: 'done' }`, silently and permanently converting a retryable authoring failure into a false 'nothing UI-facing, done' verdict. The designed repair, `rescue apply --reset-e2e` → `reopenE2ePhase` (src/rescue/apply.ts:43-51), only strips `status`/`reason`/`advisory`/`ended_at` and explicitly PRESERVES `manifest`/`reopen_counts`/`attempts` — so post-repair `e2e_phase` is still a defined object with an empty manifest, and the very next runE2eEmit call hits the exact same false-done path instead of re-authoring. This falsifies the documented intent in docs/explanation/decisions.md's Decision 39 addendum ('the phase re-enters and re-derives instead of being stuck failed forever') for precisely the case where the author never got far enough to produce a manifest. No test in src/orchestrator/e2e.test.ts exercises a second runE2eEmit call after an early runE2eRecord failure, nor does it combine with rescue/reopenE2ePhase, so this cross-module regression is untested.

**Failure mode:** invariant-without-repair
**Scenario:** e2e-author agent crashes/times out or emits an unparseable status on its first spawn (or lists an unsafe spec_path) → runE2eRecord's early branch marks the phase failed with an empty manifest → operator runs `factory rescue apply --reset-e2e` expecting a clean re-author → the next runE2eEmit instead reports the run's e2e phase 'done' (no UI surface) with zero real coverage, and the run finalizes as if e2e passed.
**Anchors:**
- src/orchestrator/e2e.ts:248 — `if (run.e2e_phase === undefined) {` _sole re-authoring gate_
- src/orchestrator/e2e.ts:552 — `async function markFailed(` _defines e2e_phase on any early failure, closing the gate_
- src/orchestrator/e2e.ts:622 — `if (manifest.length === 0) {` _false-done branch hit on every re-entry after the gate is closed_
- src/rescue/apply.ts:43 — `function reopenE2ePhase(phase: E2ePhase): E2ePhase {` _documented repair path that leaves e2e_phase defined, not undefined_

---

## Finding 2: [important] src/orchestrator/finalize.ts:221 — A 'completed'-terminal run with an auto-armed (not actually merged) rollup PR never gets its PRD closed or branch GC'd, and nothing ever automatically revisits it

**Quote:** `if (rollupResult.merged) {`

**Why:** src/git/rollup.ts's new branch-policy fallback (isBranchPolicyBlock, line 44; the retry at lines 192-209) turns a squash-merge failure into `{ merged: false, reason: 'auto-armed' }` instead of throwing — the develop rollup PR is only ARMED via `gh pr merge --auto`, not landed. finalize.ts computes `terminal` before rollup even runs (independent of merge outcome) and unconditionally flips run status to that terminal via `deps.state.finalize(runId, terminal)` (line 258) regardless of whether rollup merged; the PRD-close/branch-GC block is gated solely on `rollupResult.merged` (line 221), so for 'auto-armed' it's skipped. Once GitHub's policy later allows the queued merge to land, nothing re-checks: StateManager.finalize() throws if re-invoked on a terminal run at a DIFFERENT status, resume explicitly refuses terminal runs, and rescue/scan.ts treats terminal runs as already-finalized — so there is no automatic driver that ever revisits this run to close the PRD or GC the branch once develop actually receives the commits. The only surfacing is a log-line note (rollupNote, lines 259-264); it is not written into the PRD, the report, or PartialRunReport (src/scoring/partial-report.ts's commentFailuresOnPrd requires `report.failures.length === 0 && report.e2e_failure === undefined`, both true here, so no PRD comment fires either). This is a real, if narrower, extension of an already-accepted pattern (finalize.test.ts explicitly tests and names this a deliberately accepted D3 gap for no-merge/ci-failing/ci-timeout/not-mergeable) — the branch-policy retry adds a NEW path into that same gap without adding any mechanism to close it once the async merge actually completes.

**Failure mode:** stuck-state
**Scenario:** develop has a required status check satisfied only by GitHub's merge queue/auto-merge → rollup's immediate squash-merge is blocked by branch policy → rollup arms `--auto` and returns merged:false/reason:auto-armed → finalize marks the run 'completed' and skips PRD-close/branch-GC → the queued merge eventually lands on develop with no further factory involvement ever closing the PRD issue or deleting the run's branches.
**Anchors:**
- src/git/rollup.ts:207 — `await args.ghClient.prMergeSquash(number, { subject, body: args.body, auto: true });` _merge only armed, not landed_
- src/orchestrator/finalize.ts:221 — `if (rollupResult.merged) {` _PRD-close/branch-GC gated on landed merge only_
- src/orchestrator/finalize.ts:258 — `const finalized = await deps.state.finalize(runId, terminal);` _run flipped terminal regardless of merge outcome, closing off automatic re-check_

---
