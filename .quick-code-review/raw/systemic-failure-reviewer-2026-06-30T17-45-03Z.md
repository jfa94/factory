# systemic-failure-reviewer — 8f2614a...HEAD (base)

Status: DONE
Verdict: —

## Findings (1)

### [minor] scripts/factory-run-runner.js:677 — Workflow runner reads `cascade_dropped` but the engine envelope emits `cascade_failed`
- failure_mode: over-pinned-contract
- scenario: A workflow run cascade-fails 3 tasks as blocked-environmental (or capability-budget / spec-defect wedge) and reaches finalize; the workflow's returned outcome reports `cascade_dropped: []`, hiding from the operator-facing summary which tasks were force-failed in that invocation.
- quote: `cascade_dropped: next.cascade_dropped ?? [],`
- why: The run-level orchestrator (next.ts) names the cascade-fail field `cascade_failed` on both the `work` and `finalize` envelope variants; there is no `cascade_dropped` field anywhere in the engine. The workflow runner consumes `next.cascade_dropped`, which is therefore always `undefined`, so the `?? []` fallback makes the final summary unconditionally report an EMPTY cascade list. The adjacent comment ('surface it, never swallow') states the opposite of the actual behavior — the value is silently swallowed by the name mismatch.
- fix: Read `next.cascade_failed` (and rename the local key/comment to match), or rename the engine envelope field — they must agree byte-for-byte across the workflow boundary.
  - anchor scripts/factory-run-runner.js:677 `cascade_dropped: next.cascade_dropped ?? [],` (consumer reads a field the producer never emits → always [])
  - anchor scripts/factory-run-runner.js:673 `all-terminal carries cascade_dropped (this-invocation drops) — surface it, never swallow.` (comment asserts the value is surfaced; the mismatch swallows it)
  - anchor src/orchestrator/next.ts:249 `return { ...ctx(), kind: "finalize", cascade_failed: cascadeFailed };` (producer emits cascade_failed (the only name the engine uses))

