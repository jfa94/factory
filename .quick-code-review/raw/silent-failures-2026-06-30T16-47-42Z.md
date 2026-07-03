# silent-failure-hunter — raw output

**Status:** DONE
**Verdict:** —

## Findings (1)

### [minor] scripts/factory-run-runner.js:528 — normalizeSweep silently downgrades a 'blocked' sweep verdict to 'approve' with no log line
- kind: local
- quote: `  return { ...sweep, verdict: "approve" };`
- why: normalizeSweep repairs a self-contradictory e2e-author result before the no-retry --results boundary. When the agent emits verdict:"blocked" but encodes none of its findings with blocking:true (a violation of the agent's own contract in agents/e2e-author.md), the first branch (line 526) does not fire, verdict!="error", so this line relaxes the verdict to "approve" and the workflow run advances/merges to develop instead of halting for fix-forward. Unlike the sibling error-collapse (lines 551-553) which logs the dropped observations, this blocked->approve override emits NO log entry, so the run's operational trail gives zero signal that the agent's halt-intent was discarded. The non-blocking findings still appear in the rollup report, so this is surfaced-but-weak rather than fully silent; blast radius is bounded because it requires an agent contract violation and the per-finding `blocking` flag (not the verdict) is the real gate.
