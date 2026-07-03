# silent-failure-hunter — 8f2614a...HEAD

**Status:** DONE

## Findings (verified)

### [minor] src/cli/subcommands/scaffold.ts:586 — Opted-in e2e.blocking gate silently defeated if e2e.yml indent drifts

- Quote: `return blocking ? withEnv.replace(/^        continue-on-error: true.*\n/m, "") : withEnv;`
- Why: when `e2e.blocking` is true the scaffolder strips `continue-on-error: true` from the smoke step so a crashing app reds the job. `String.replace` returns the input unchanged on no match — no throw, no post-condition asserting the line was removed. The regex hard-codes the template's current 8-space indent; any future reindent of `templates/ci/e2e.yml` makes the strip a silent no-op, leaving `continue-on-error` in place (job green on failure), so the required `"E2E"` check passes anyway. `ensureRequiredCheck` does not catch it (the check IS registered and IS green). An operator who opted into blocking gets advisory-only behaviour with zero signal.

### [minor] scripts/factory-run-runner.js:527 — Non-blocking sweep findings discarded when the author emits an `error` verdict

- Quote: `if (sweep.verdict === "error") return { verdict: "error", journeys_total: 0, findings: [] };`
- Why: an e2e-author can surface real but non-blocking problems (uncertain/fail journeys) then hit a mid-sweep MCP/boot failure → verdict `"error"`. `normalizeSweep` collapses that to a clean empty error, zeroing `journeys_total` and dropping every finding, so the genuine problems already observed vanish from the recorded sweep. At `MAX_E2E_SWEEP_ATTEMPTS` the run best-effort advances to completed with an empty money-path summary; the findings re-surface only if a later clean re-sweep happens to re-find them.

## Dropped (refuted by adversarial verify)

### [important→refuted] scripts/factory-run-runner.js:528 — Workflow sweep rewrites a `blocked` verdict to `approve` when no finding carries blocking:true

- Quote: `return { ...sweep, verdict: "approve" };`
- Refute reason: line 528 is intended, documented behavior mirroring the engine's own cross-field invariant. (1) The engine REJECTS the worried input: `e2e-sweep.ts:115-121 superRefine` — a `blocked` verdict with no blocking finding is engine-illegal and the engine's prescribed correction IS `approve`; `normalizeSweep` pre-applies it at the retryable author boundary. (2) The verdict string carries no halt authority — the halt/recommendation is derived from `blockingCount = findings.filter(f=>f.blocking).length` (`e2e-sweep.ts:256`), so `blocked` with zero blocking findings derives `advance` either way. (3) No blocking finding is dropped — line 526 forces `verdict:"blocked"` for ANY blocking finding first; line 528 is reached only when nothing is blocking, and `...sweep` preserves non-blocking findings. Nothing is silently dropped.
