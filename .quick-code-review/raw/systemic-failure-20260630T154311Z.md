# systemic-failure-reviewer — 8f2614a...HEAD

**Status:** DONE
**Verdict:** One systemic finding — the workflow money-path re-verify budget is shared with transient error-sweep retries.

## Findings

### [important] (systemic / invariant-without-repair) src/orchestrator/e2e-sweep.ts:321 — Shared sweep-attempt budget lets a transient error sweep defeat the workflow money-path fix-and-reverify path

- Failure mode: `invariant-without-repair`
- Scenario: workflow run, `e2e.semantic` on, all tasks done. Sweep #1 returns `error` (app momentarily fails to boot) → attempts=1, suspended; human fixes boot + resumes; sweep #2 boots and finds a real blocking money-path → done, `blocking_count>0`, attempts=2, suspended/fix-forward; human fixes the money-path on staging + resumes, but `wantsSemanticSweep` sees `attempts(2) < 2 == false` so it never re-sweeps, and finalize's backstop sees `attempts(2) >= 2` → run finalized `failed` WITHOUT re-verifying the fix.
- Why: `MAX_E2E_SWEEP_ATTEMPTS (=2)` is one counter (`e2e_sweep.attempts`) incremented by BOTH the agent-`error` retry path (line 321) and the blocking-money-path `done` re-verify path (line 280). The whole durable-halt mechanism in `next.ts` (`wantsSemanticSweep`, 128-135) exists to give the human a fix-on-staging → resume → re-sweep → GREEN convergence cycle; `finalize.ts:189` terminates the run `failed` once the shared counter hits the cap. Because the cap conflates the two populations, a transient sweep error silently consumes the blocking-reverify budget, so a real blocking finding surfacing afterward gets ZERO re-verify cycles. The carve-out at line 308 handles only the error-AFTER-blocking ordering; the error-BEFORE-blocking ordering is unguarded. Outcome is fail-safe (no bug ships, PRD left open) but the human's valid fix is never tested and the only recovery is a fresh full run that re-implements every task.
- Fix sketch: separate the two budgets — a dedicated counter, or reset `attempts` when the marker transitions from a `failed` error record to a `done` blocking record — so `next.ts:131` and `finalize.ts:189` count only genuine blocking re-verify attempts.

Chain anchors (all verbatim-verified):

- `src/orchestrator/e2e-sweep.ts:321` — `const attempts = (run.e2e_sweep?.attempts ?? 0) + 1;` (error path increments shared counter)
- `src/orchestrator/e2e-sweep.ts:280` — `attempts: (s.e2e_sweep?.attempts ?? 0) + 1,` (blocking-done re-verify increments SAME counter)
- `src/orchestrator/next.ts:131` — `(run.e2e_sweep.attempts ?? 0) < MAX_E2E_SWEEP_ATTEMPTS` (re-sweep gate reads shared counter)
- `src/orchestrator/finalize.ts:189` — `if ((run.e2e_sweep?.attempts ?? 0) >= MAX_E2E_SWEEP_ATTEMPTS) {` (cap forces terminal `failed` without re-verify)
