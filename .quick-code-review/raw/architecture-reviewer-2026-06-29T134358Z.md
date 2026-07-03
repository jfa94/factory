# architecture-reviewer — 2026-06-29T134358Z

**Status:** DONE  
**Verdict:** WARNING

## Findings

### [minor] Tool-specific predicate exported from the tool-agnostic path-classification module

**File:** `src/verifier/deterministic/scope.ts:106`  
**Verbatim:** `export function isVitestRunnable(file: string): boolean {`  
**Citation:** ✓ verified

Every other export in `scope.ts` is a language-agnostic path classifier (`isTestPath`, `isDocsPath`, `isMutableSrc`, `mutationScope`, `diffScopedTestFiles`, `escapeStrykerGlob`). `isVitestRunnable` encodes vitest's supported file extensions — a runtime-tool capability, not a path-structure concern. Its single consumer is `strategies/test.ts` (test.ts:12: `import { diffScopedTestFiles, isVitestRunnable } from "../scope.js";`). Placing it in `scope.ts` means a change to vitest's extension support (e.g. adding `.mts`/`.cts`) requires touching the shared path-classification module rather than the strategy that owns vitest invocation.

**Fix:** Move `isVitestRunnable` from `scope.ts` to a module-private constant in `strategies/test.ts`. Remove it from `scope.ts` exports and from `scope.test.ts` (coverage moves to `test.test.ts`). The import at `test.ts:12` becomes `import { diffScopedTestFiles } from "../scope.js";`.
