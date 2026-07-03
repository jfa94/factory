# quality-reviewer — raw findings

Status: DONE
Verdict: None

## Finding 1: [critical] src/orchestrator/e2e.ts:384 — W5 trust-boundary stray-file check can be bypassed via a throwaway manifest entry

**Quote:** `const allowedSpecPaths = new Set(results.manifest.map((e) => e.spec_path));`

**Why:** PREMISE: per the module's own comment at e2e.ts:376-381 ("Trust boundary (Decision 39 W5): the author's ENTIRE branch is about to be merged unreviewed. Reject up front ... if it touches anything outside the spec dir that isn't itself a declared spec_path"), the stray-file guard exists so an autonomous, unreviewed e2e-author branch cannot land an edit to arbitrary application source when it gets squash-merged into staging.

EVIDENCE: `const critical = results.manifest.filter((e) => e.kind === "critical");` (line 360) narrows the entries that will actually be merged, but the allowlist built two blocks later is NOT narrowed the same way: `const allowedSpecPaths = new Set(results.manifest.map((e) => e.spec_path));` (line 384) draws from the FULL manifest — critical AND throwaway rows alike — then `const stray = changed.filter((f) => !f.startsWith(testDirPrefix) && !allowedSpecPaths.has(f));` (line 386) treats anything in that set as safe.

TRACE: `assertSafeSpecPath` (called earlier over every manifest entry, including throwaway ones) only rejects absolute paths and `..` segments — it does not constrain a throwaway entry's `spec_path` to actually live under the ephemeral throwaway directory; per the manifest contract a throwaway `spec_path` is just an author-supplied relative string. So the author (or a prompt-injected/buggy authoring pass) can emit a manifest with one critical entry (e.g. `{spec_path:"checkout.spec.ts", kind:"critical"}`) plus a second, throwaway-labeled entry whose `spec_path` equals an arbitrary real source path it wants to slip through, e.g. `{spec_path:"src/malicious-backdoor.ts", kind:"throwaway", task_ids:[...]}`. If the author's branch (`e2eBranchName(runId)`) also actually contains an edit to `src/malicious-backdoor.ts`, `changed` will include that path, `allowedSpecPaths.has("src/malicious-backdoor.ts")` is now true (because of the throwaway entry), so `stray` comes back empty and the merge gate at lines 387-394 never fires. `deps.git.mergeFfOrCommit(staging, e2eBranchName(runId))` (line 406) then merges the entire branch — including the unrelated source edit — into staging.

CONCLUSION: this defeats the exact protection the code documents itself as providing. The existing test "author branch merge is path-guarded against out-of-testDir changes (W5 trust boundary)" (src/orchestrator/e2e.test.ts:614-654) only exercises a single critical entry and never a mixed critical+throwaway manifest, so the gap is untested and unnoticed. Fix: build `allowedSpecPaths` from `critical.map(e => e.spec_path)` only (the set of paths that will actually be merged), not the full `results.manifest`.

---
