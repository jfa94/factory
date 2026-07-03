# codex-adversarial — render

**Verdict:** needs-attention
**Target:** {"mode":"branch","label":"branch diff against 8f2614a","baseRef":"8f2614a","explicit":true}

**Summary:** No-ship: the change still has recoverability and gate-coherence holes in the new E2E sweep path.

## Findings

### [high · conf 0.89] src/orchestrator/next.ts:120-135 — Session resume bypasses E2E adjudication and terminally fails recoverable runs
- For a session run with `e2e_sweep.status === "done"` and `blocking_count > 0`, `wantsSemanticSweep` always returns false. On a crash after `runE2eRecord` records the blocking sweep but before the runner calls `--adjudicated`, `nextTask` returns `finalize` instead of re-entering the semantic/adjudication stage. `finalizeRun` then marks the otherwise completed run as `failed` because the adjudication marker is absent. This makes a recoverable runner crash or skipped marker a terminal run failure, despite the runner instructions saying resume should re-run adjudication and record the marker.
- recommendation: Teach `nextTask` to surface a resumable semantic/adjudication step for session runs with `done + blocking_count>0 + !adjudicated`, or add a separate engine envelope for pending adjudication so resume cannot go straight to finalize.

### [high · conf 0.92] src/config/schema.ts:213-300 — Empty `e2e.startCommand` validates but disables scaffolding
- `startCommand` is `z.string().optional()` and the refinement only rejects `undefined`, so `""` satisfies `e2e.semantic` or `e2e.blocking`. Scaffold then gates all E2E template generation and required-check insertion on truthiness (`if (opts.config.e2e.startCommand)`), so an opted-in blocking smoke gate can validate while producing no `playwright.config.ts`, no E2E workflow, and no required `E2E` check. The orchestrator uses a different presence check (`!== undefined`), so semantic runs may still be scheduled with an empty boot command. This is a gate disappearing silently under a realistic misconfiguration.
- recommendation: Normalize/validate `startCommand` as a non-empty trimmed string, and use the same helper/predicate in config validation, scaffold, and `wantsSemanticSweep`; add regression tests for `""` and whitespace-only values with `semantic` and `blocking` enabled.

## next_steps
- Block shipping until the session crash-resume path and `startCommand` validation/scaffold predicate are fixed and covered by tests.