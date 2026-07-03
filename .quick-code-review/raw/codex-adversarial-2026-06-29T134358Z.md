# codex-adversarial — 2026-06-29T134358Z

**Status:** DONE  
**Gate B:** mode=branch, baseRef=5ac7027 ✓  
**Verdict:** needs-attention  
**Codex summary:** "No-ship: the change turns unexecuted tests into passing deterministic evidence, weakening the merge gate exactly where it claims ground-truth execution."

## Findings

### [high → important] Unexecuted non-Vitest tests are reported as passing gate evidence

**File:** `src/verifier/deterministic/strategies/test.ts:21-33`  
**Confidence:** 0.92  
**Citation:** ✓ existence-checked (file 43 lines, range in bounds)

`scoped` can contain real test files such as pgTAP or Go tests, but the strategy filters them out with `isVitestRunnable` and either runs only the remaining JS/TS subset or, when none remain, returns `ran("test", true, ...)` without invoking any test runner. That violates the gate contract that `ran` means the check executed and observed a pass signal.

In a mixed diff, a broken `.test.sql`/`_test.go` file is silently ignored if the JS/TS subset passes; in a pure non-JS test diff, the merge gate receives `observed:true` even though nothing executed. The impact is a false green deterministic test gate and potential shipment of broken database/Go/etc. tests if external CI is missing, delayed, or not equivalent.

**Recommendation:** Do not emit passing `GateRan` evidence for files this strategy did not execute. Either run a configured non-Vitest test command for those files, or fail/skip explicitly with a reason that cannot be mistaken for ground-truth pass evidence; for mixed diffs, surface unexecuted non-runnable tests instead of silently dropping them.

## Next steps (Codex)

1. Add regression coverage for mixed runnable + non-runnable test diffs where the runnable subset passes but non-runnable tests are unexecuted.
2. Align the docs and strategy contract so `ran(true)` is only produced after an actual machine check succeeds.
