# silent-failure-hunter — raw findings

Status: DONE
Verdict: None

## Finding 1: [important] src/cli/subcommands/debug.ts:440 — debug review --record silently drops whether the committed e2e suite actually ran

**Quote:** `const e2e = await runCommittedE2e({ cwd: worktree, config: deps.config.e2e });`

**Why:** runCommittedE2e returns {kind:"skipped", reason} when e2e.startCommand/baseURL aren't configured (src/debug/review.ts:268-280), and foldE2eIntoBlockers is a no-op on that branch. debugReviewRecord folds the result into confirmedBlockers but never persists or returns e2e.kind/reason anywhere: the DebugEnvelope union (debug.ts:249-301) has no field for it, and when confirmedBlockers.length===0 the function returns `{ kind: "clean", run_id: runId, pass: session.pass }` (line 446) — the exact same envelope whether the e2e suite ran and passed or was silently skipped for missing config.

**Fix sketch:** Thread e2e.kind (and reason, when skipped) through DebugEnvelope's "clean"/"findings" variants (or persist it into DebugSession) so a skip is visibly distinct from a genuine pass.

---

## Finding 2: [important] src/orchestrator/finalize.ts:65 — e2e_advisory (non-gating residual e2e red) never reaches the PRD completion comment

**Quote:** ``PRD delivered — all ${report.totals.shipped} task(s) shipped via rollup PR ${prRef}.\n\n` +`

**Why:** PartialRunReport.e2e_advisory (src/scoring/partial-report.ts) is populated when the e2e phase concludes `done` but leaves throwaway specs still red — it IS rendered into the internal report.md via renderPartialReportMarkdown ('## End-to-end verification — advisory'), but prdDoneComment — the only text posted back to the PRD issue on a successful rollup (finalize.ts:60-68, called at finalize.ts:237) — hardcodes just the shipped-count + rollup link and never reads report.e2e_advisory.

**Fix sketch:** Append report.e2e_advisory (when present) to prdDoneComment's body, mirroring how commentFailuresOnPrd/renderFailureComment already surface e2e_failure.

**REFUTED:** The finding is narrowly true (prdDoneComment at finalize.ts:65 only interpolates report.totals.shipped and the PR ref — it never touches report.e2e_advisory) but does not describe a silent loss of information; it describes the documented design.

The advisory (report.e2e_advisory, set at src/scoring/partial-report.ts:176-178) IS rendered into the run report markdown by renderPartialReportMarkdown (partial-report.ts:271-274, "## End-to-end verification — advisory"). That markdown is exactly the `body` passed to `rollup()` at finalize.ts:211-216 (`body: markdown`), which `rollup()` uses as both the rollup PR body (src/git/rollup.ts:146-150, `prCreate({..., body: args.body})`) and the squash-merge commit body when it lands on develop (rollup.ts:193/207, `prMergeSquash(number, { subject, body: args.body })`). The short `prdDoneComment` links directly to that same PR via `prRef` (`[#${rollupResult.number}](${rollupResult.url})`), so the advisory is one click away from the PRD comment, and permanently recorded in develop's git history.

This split — terse PRD comment + full report (including advisory) in the linked rollup PR/report.md — matches the explicit documented design in docs/explanation/decisions.md Decision 39: "0 critical red → the run completes (a residual throwaway red becomes an advisory line in the report, not a blocker)." The decision text says the report, not the completion comment, is where the advisory belongs, consistent with Decision 34/36's design of a terse PRD comment with details deferred to the linked PR/report. So the finding describes intended, documented behavior rather than a defect where the advisory is dropped/lost.

---

## Finding 3: [minor] scripts/factory-run-runner.js:304 — recordResults' recovery catch is unscoped to delivery-transport errors

**Quote:** `  } catch (err) {`

**Why:** The try block (scripts/factory-run-runner.js:288-303) wraps both the agent() call and parseEnvelope(); the catch (line 304-330) treats ANY exception — a genuine post-tool transport flake, but equally a bug in agent()'s own plumbing or an unrelated parseEnvelope defect — as 'maybe the mutation landed' and dispatches into the same idempotent-reread recovery path. The recovery narrows correctly on `unchanged` (rethrows the original error when the reread's result_key matches), so a same-key case is safe, but a coincidentally-advanced or terminal reread on an unrelated error is classified 'recovered' with only a log line, never surfaced as the distinct failure it was.

**Fix sketch:** Narrow the catch to the specific transport/flake error shapes the design doc describes, or at minimum log the caught error's full detail (not just err.message) whenever the reread differs, so a masked unrelated bug still leaves a legible trace.

---
