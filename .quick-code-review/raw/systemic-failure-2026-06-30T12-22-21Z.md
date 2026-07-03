# systemic-failure-reviewer — raw output (2026-06-30T12-22-21Z)

**Status:** DONE

**Verdict:** One systemic finding: the workflow-mode fix-forward halt is advisory only and does not survive a re-drive, so a blocking money-path auto-merges to develop on the very next resume.

## [important] src/orchestrator/next.ts:120 — Workflow-mode fix-forward halt does not survive re-drive — blocking money-path ships to develop on resume

- kind: systemic
- failure_mode: unsafe-recovery
- scenario: Live workflow run with a blocking money-path: runE2eRecord sets e2e_sweep.status="done"/recommendation fix-forward, the runner halts with 'review the rollup + re-run before shipping', operator re-launches the runner (or /factory:resume), wantsSemanticSweep returns false (done), nextTask falls through to finalize, and the rollup squash-merges the blocking money-path into develop with no further gate.
- verbatim: `if (run.e2e_sweep?.status === "done") return false;`
- why: The feature's stated invariant is that 'a blocking money-path never ships invisibly' (factory-run-runner.js:620). In workflow mode there is no adjudicator, so on a blocking sweep the runner returns suspended:true asking the operator to 'review the rollup + re-run before shipping'. But the halt is not durable: runE2eRecord already stamped e2e_sweep.status="done" and the run state is left non-terminal/running (the engine returned kind:done, not a suspend, so nothing persists a gate). When the operator does the requested re-run, wantsSemanticSweep short-circuits on status==="done", the sweep is skipped entirely, and finalize merges the staging→develop rollup (merge: shipMode==="live"). The blocking money-path findings are documented in the PR body but the merge is automatic — the recovery action the halt's own message sanctions is exactly what ships the failure.
- fix_sketch: Make the block durable for workflow mode: either persist a distinct sweep status (e.g. "blocked") that finalize/rollup treats as a hard ship-gate (refuse to merge while blocking_count>0 in workflow mode), or have the workflow halt set run.status to suspended so re-entry cannot silently advance, and only clear it once the money-path re-verifies clean.
  - anchor src/orchestrator/next.ts:120 (re-entry gate skips the sweep on resume because the marker is already done): `if (run.e2e_sweep?.status === "done") return false;`
  - anchor scripts/factory-run-runner.js:623 (workflow halt is only a return value; run state is never persisted as a durable block, and the reason text invites the operator to re-run): `suspended: true,`
  - anchor src/orchestrator/e2e-sweep.ts:265 (record stamps the sweep done even on a blocking (fix-forward) verdict, which is what disqualifies the re-run from re-checking): `status: "done",`
  - anchor src/orchestrator/finalize.ts:223 (finalize auto-merges the rollup to develop with no e2e blocking gate): `merge: deps.shipMode === "live",`

