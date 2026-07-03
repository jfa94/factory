# systemic-failure-reviewer — raw output (2026-06-30T14-08-07Z)

Status: DONE

## Verdict

One critical systemic stuck-state: a workflow-mode run whose assembled app cannot boot autonomously wedges in an unbounded suspend→resume→re-sweep loop because the attempt cap that was designed to bound "the app never boots" is structurally bypassed for any blocking verdict — and a boot failure is contractually a blocking verdict.

## Findings (1)

### [critical] src/orchestrator/next.ts:126 — Workflow run with a non-bootable app wedges forever: the boot-failure attempt cap is unreachable on the blocking path

- Quote: `if (run.mode === "workflow" && (run.e2e_sweep.blocking_count ?? 0) > 0) {`
- Failure mode: stuck-state
- Scenario: A --workflow run opts into e2e.semantic but the staging app's `/` needs a seeded DB/service container (the guide says this is unsupported autonomously); e2e-author reports the boot failure as verdict "blocked", runE2eRecord records e2e_sweep done+blocking_count=1 and suspends, and every subsequent `factory resume` re-routes to a fresh re-sweep that boot-fails the same way — MAX_E2E_SWEEP_ATTEMPTS never engages and the run never reaches completed/failed.
- Why: MAX_E2E_SWEEP_ATTEMPTS exists to bound a repeatedly-failing sweep — its own comment names "the app never boots, MCP tools unavailable" as the loop it stops. But the e2e-author contract (Iron Law 2) classifies a boot failure as a BLOCKING finding with verdict "blocked", NOT "error". In runE2eRecord, verdict "blocked" takes the `results.verdict !== "error"` branch (e2e-sweep.ts:239), which writes e2e_sweep.status="done" + blocking_count>=1 and, for workflow mode, suspends (suspendOnBlocking, e2e-sweep.ts:263) — incrementing attempts but NEVER gating on the cap. On every `factory resume`, wantsSemanticSweep sees status==="done" and returns at next.ts:126/127, short-circuiting BEFORE the cap check at next.ts:131. So the cap is unreachable for this path: the run re-sweeps, boot-fails identically, and re-suspends with no transition to any terminal state. Disabling e2e.semantic does not escape — finalize.ts:182 then throws the fail-closed backstop on every resume instead. The run is permanently non-terminal with no in-system repair.
- Fix sketch: Bound the workflow blocking re-sweep too: track attempts across the done+blocking path and, at the cap, either fail the run loud (decideFinalize→failed with a blocked-environmental class) or best-effort-advance with the findings surfaced — OR distinguish a boot/infra "blocked" (journey:"boot") from a money-path "blocked" so only genuine money-path failures get the uncapped never-ship treatment while boot/MCP failures fall under the cap as the comment promises.
- Anchors:
  - src/orchestrator/next.ts:126 — `if (run.mode === "workflow" && (run.e2e_sweep.blocking_count ?? 0) > 0) {` (stuck-state: re-sweep re-route returns BEFORE the cap check at line 131, so the loop is unbounded)
  - src/orchestrator/next.ts:131 — `if ((run.e2e_sweep?.attempts ?? 0) >= MAX_E2E_SWEEP_ATTEMPTS) return false; // cap: best-effort` (missing-repair: the bounding cap, unreachable whenever the marker status is 'done')
  - src/orchestrator/e2e-sweep.ts:239 — `if (results.verdict !== "error") {` (trigger: a boot failure (verdict 'blocked') enters this branch — which has no attempt-cap — instead of the capped error branch below)
  - src/orchestrator/e2e-sweep.ts:65 — `export const MAX_E2E_SWEEP_ATTEMPTS = 2;` (invariant: the cap whose comment claims it bounds the 'app never boots' loop, defeated for workflow blocking)

