# quality-reviewer — 8f2614a...HEAD (base)

Status: DONE
Verdict: REQUEST_CHANGES

## Findings (1)

### [important] src/orchestrator/e2e-sweep.ts:313 — Session-mode error re-sweep erases the blocking money-path gate and ships it
- failure_mode: invariant-without-repair
- scenario: Session run finds a blocking checkout money-path, crashes before adjudicating, resumes, and the re-sweep errors (app won't boot) — attempts hits the cap, the failed marker drops blocking_count, and finalize ships the broken checkout to develop.
- quote: `if (run.mode === "workflow" && (run.e2e_sweep?.blocking_count ?? 0) > 0) {`
- why: PREMISE: runE2eRecord must never let a known blocking money-path (a prior `done` marker with blocking_count>0) ship unverified; the carve-out comment states overwriting that marker to `failed` 'would drop blocking_count and erase the gate'. EVIDENCE: line 313 scopes the gate-preserving carve-out to `run.mode === "workflow"`; for session mode an `error` verdict falls through to lines 326-348 (`const attempts = (run.e2e_sweep?.attempts ?? 0) + 1; const sweepRecord = { status: "failed" ... }` then `e2e_sweep: sweepRecord`), which writes a `failed` marker with NO blocking_count. TRACE: (1) a session sweep finds a blocking money-path -> non-error branch sets attempts:1, blocking_count:1, !adjudicated, returns fix-forward; (2) the session crashes between record and `run e2e --adjudicated` (the tested crash-recovery case in next.test.ts); (3) resume routes to semantic-sweep (wantsSemanticSweep: done+blocking+!adjudicated+attempts1<2); (4) the re-sweep's e2e-author returns verdict 'error' (e.g. the app no longer boots); (5) session mode skips the line-313 carve-out, takes the general path: attempts=1+1=2 >= MAX_E2E_SWEEP_ATTEMPTS, so it writes the bare `failed` marker and returns kind:'done', recommendation:'advance', blocking_count:0, best_effort:true; (6) finalize.ts backstop checks `(run.e2e_sweep?.blocking_count ?? 0) > 0` which is now 0 -> no fail-closed -> rollup ships to develop. CONCLUSION: a transient error on the session crash-recovery re-sweep silently erases the blocking gate and ships the broken revenue path — the exact bug the workflow-only carve-out prevents.
- fix: Make the carve-out mode-agnostic: gate on `(run.e2e_sweep?.blocking_count ?? 0) > 0` (preserve the prior done+blocking marker, bump only attempts, suspend) regardless of run.mode, instead of `run.mode === "workflow" && ...`. The bounded attempts increment still lets next.ts/finalize terminate via the cap path without dropping blocking_count.

