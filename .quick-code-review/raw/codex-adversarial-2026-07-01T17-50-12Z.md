# codex-adversarial — raw findings

Target: {"mode": "branch", "label": "branch diff against 8f2614a", "baseRef": "8f2614a", "explicit": true}
Verdict: needs-attention
Summary: No-ship: the e2e phase still lets unreviewed author output bypass the intended trust boundary and can silently pass a failed throwaway run.

## Finding 1: [high] src/orchestrator/e2e.ts:384-386 — Manifest-declared files outside the e2e suite can be merged unreviewed

**Confidence:** 0.9

**Body:** `runE2eRecord` only rejects absolute paths and `..` segments before trusting the author's manifest, then the merge guard allows any changed file that either starts with `cfg.testDir/` or is listed in `allowedSpecPaths`. Because `allowedSpecPaths` comes directly from the autonomous e2e author, a critical entry such as `checkout.spec.ts` at repo root can be declared, proven, and merged even though it is outside the committed e2e suite directory. The likely impact is landing unreviewed files from the author branch into staging, violating the W5 trust boundary this guard is meant to enforce.

**Recommendation:** Require every `critical` manifest `spec_path` to be under `cfg.testDir/`, and make the stray-file guard allow only declared critical spec paths under that directory plus narrowly-defined support files under the same directory.

---

## Finding 2: [high] src/orchestrator/e2e.ts:680-724 — Throwaway Playwright tooling failures can be marked done

**Confidence:** 0.86

**Body:** The fail-closed tooling check only examines `criticalResult`; throwaway execution can return `ok:false` because of a nonzero exit or reporter `errors[]` with no per-spec failed status, but the code only derives `throwawayFailed` from failed specs. In that scenario `mappable` is empty and the phase calls `markDone`, so a broken throwaway run is reported as a successful e2e phase instead of failing or suspending visibly.

**Recommendation:** Add the same tooling-failure check for `throwawayResult` before deriving `throwawayFailed`; fail or suspend when `throwawayResult.ok` is false and no individual failed spec can be mapped.

---

## Next steps
- Block shipping until the e2e manifest path policy and throwaway tooling-failure handling are fixed and covered by regression tests.