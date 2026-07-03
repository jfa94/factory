# silent-failure-hunter — 2026-06-29T134358Z

**Status:** DONE  
**Verdict:** One important finding: the mixed-mode code path silently drops the non-vitest file count from gate evidence, producing an incomplete audit trail.

## Findings

### [important] Mixed-mode run silently omits non-vitest file exclusions from gate evidence

**File:** `src/verifier/deterministic/strategies/test.ts:39`  
**Verbatim:**

```
const detail =
      runnable.length > 0 ? `diff-scoped (${runnable.length} test file(s))` : "un-scoped";
```

**Citation:** ✓ verified (collapsed match at lines 38-39)

When the diff contains both vitest-runnable files (e.g. `.test.ts`) and non-vitest test files (e.g. `.test.sql`, `_test.go`), the code correctly filters to `runnable` before calling vitest, but the `detail` string records only the count of runnable files. There is no indication in the audit trail that non-vitest test files were present and excluded from execution.

Contrast with the pure-non-vitest branch (lines 27-31) which explicitly surfaces this with `non-vitest test file(s) not executed (e.g. pgTAP)`. A reviewer reading `vitest exit=0 diff-scoped (1 test file(s))` on a mixed diff has no way to know that a pgTAP or Go test in the same diff was silently skipped.

**Fix:** Compute the non-runnable count (`const skipped = scoped.length - runnable.length`) and, when `skipped > 0`, append to the detail string: `diff-scoped (${runnable.length} vitest test file(s)); ${skipped} non-vitest file(s) not executed`. Mirrors phrasing already used by the pure-non-vitest branch.
