# codex-adversarial — 8f2614a...HEAD

**Status:** DONE (structured)
**Verdict:** needs-attention
**Target:** branch diff against 8f2614a (mode: branch, baseRef: 8f2614a) — staleness gate PASS

**Summary:** No-ship: blocking session-mode E2E findings are not durably enforced, so a crash/resume can still merge a known broken money path.

## Findings

### [high · confidence 0.91] src/orchestrator/e2e-sweep.ts:274-285 — Session-mode blocking E2E findings can be bypassed after crash/resume

- Body: `runE2eRecord` only persists a halt when `run.mode === "workflow"` (`const suspendOnBlocking = run.mode === "workflow" && blockingCount > 0;`). Session runs with blocking findings keep `status:"running"` while recording `e2e_sweep.status:"done"` and `blocking_count > 0`. If the session runner crashes or is stopped after this record but before completing its in-memory fix-forward adjudication, the next resume sees a done sweep, skips re-sweep/fail-closed for session mode (`next.ts:127`), and `finalizeRun` only applies the money-path backstop to workflow mode (`finalize.ts:186`). That can turn a known blocking money-path failure into a completed rollup merge.
- Recommendation: make blocking E2E findings durably gate all modes — either suspend/fail-closed session runs too, or persist an explicit adjudicated/fixed marker and have `next`/`finalize` refuse to advance while `blocking_count > 0` without that marker.
- Verification: existence-checked (review schema has no verbatim field) — file exists, lines 274-285 within 344-line file. Codex notes this is an inference from the surrounding state machine.

## Next steps (Codex)

- Add a crash-resume regression test for session mode: record a blocking E2E result, do not run in-memory adjudication, then call `next`/`finalize` and assert it cannot merge.
