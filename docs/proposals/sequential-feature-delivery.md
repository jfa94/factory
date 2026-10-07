# Sequential feature delivery (v2)

Accepted implementation plan, 2026-09-05. One PRD produces one feature branch,
one producer at a time, and one PR. Version 1 runs are diagnostic artifacts only.

## Implementation ledger

- [x] Validate executable specs inside bounded generation/revision; snapshot inputs.
- [x] Implement durable feature checkpoints and the single next-action engine.
- [x] Integrate task, slice, and feature checks and independent review.
- [x] Implement truthful delivery, no-change completion, stop, answer, and resume.
- [x] Wire CLI, debug, hooks, runner policy, and replace obsolete instructions.
- [x] Fix YAML serialization and mutation I/O errors with regression coverage.
- [x] Exercise real Git and built CLI interruption/integration journeys.
- [x] Run verification, update bundles, and synchronize major version.
- [x] Run authorized external uninterrupted/interrupted canaries before release.

Spec generation has five revisions. Execution and spec repair have three repair
passes at each boundary. Infrastructure waiting consumes no implementation pass.
All criteria are visible; evaluator evidence remains independent. Review evidence
is bound to a spec revision and exact commit range. Accepted work is repaired
forward, never reset or replaced on the remote.

No legacy migration, external spec import, or parallel task producer is included.
External publication and test-repository writes need separately scoped permission.

## Verification evidence and remaining work

The 2026-09-07 focused implementation review completed five tracks and four
independent refutations. It verified four important findings and one cleanup.
All five are addressed: PR HEAD refresh, invalid-journal recovery, v2 state write
protection, interrupted base-merge verification, and unreachable CLI aliases.
The retained pre-fix report is
`.code-review/runs/20260907T125816Z-focused-V8gm0D/report.md`.

The final full suite passed 3,495 tests in 174 files. Real Git tests cover sequential
shared-file slices, one PR, no-change acceptance, actual RED/GREEN, repair limits,
CI waiting, answer retention, stale submissions, journal recovery and interrupted
base integration. Built CLI subprocess tests cover stop/resume with preserved
commits. Protocol tests also cover independent finding confirmation, complete
acceptance evidence, bounded spec revision, rejected accepted-prefix edits and
CLI creation/debug/recovery. Native Vitest and colored reporter evidence execute
successfully. Typecheck, lint, build, formatting, circular-dependency and version
checks passed.

Coverage passes the unchanged CI thresholds: 94.67% lines/statements, 91.55%
branches and 94.97% functions. Final bundles were rebuilt; the synchronized version
is `2.0.0-rc.1`. No package or branch has been published.

Semgrep scanned 503 files with the repository's three CI rule packs. It reported
one pre-existing dummy AWS-key fixture at
`src/verifier/deterministic/strategies/sast.test.ts:103` and a parser warning at
`src/verifier/holdout/split.ts:57`; neither file changed in this implementation.
No finding points to the new implementation. This adjacent CI issue remains
reported separately; no test or scanner rule was suppressed to make the scan green.

## External canary procedure

Use a disposable GitHub test repository with committed gate configuration and
stable strict protection. Supply two PRD issues with two dependent slices sharing
an interface, a real assertion failure and explicit acceptance criteria.

1. Run one PRD uninterrupted through generation, tasks, integrated review, acceptance,
   CI and observed merge. Verify exactly one feature PR and unchanged protection.
2. Interrupt the other after a producer commit and again while its existing PR is
   awaiting CI. Stop the worker, resume from a fresh session, and complete delivery.
   Verify no repeated accepted work, lost answer, branch replacement or duplicate PR.
3. Retain run ledgers, raw independent evidence, commit ranges and CI/PR URLs.
   Release only after both canaries pass.

The repository, issue creation, branch pushes, PR creation and merges must be
explicitly authorized before this procedure runs. Local bare remotes used by the
tests do not substitute for GitHub/agent canaries.

Unresolved design questions: none. The user selected `jfa94/asset-generator` on
2026-09-07 and then explicitly approved publication and strict protection. The
existing history and setup PR #2 are published and merged with all required CI
checks passing and unchanged strict protection. The user authorized `--ignore-quota`
for both Codex-driven canaries; the first spec is in generation. See the
[canary preparation ledger](asset-generator-canary.md) for setup findings, planned
journeys and remaining steps. Canary #3 ran to its feature-repair attempt and
stalled for want of result submission; canary #4 has not started. On 2026-09-12
results became engine-consumed staged files (see the canary ledger); #3 is now the
recovery canary and #4 the uninterrupted one. On 2026-09-13 #3 was recovered from
a fresh Claude Code driver: the stalled result was consumed without a new implement
attempt and fresh feature gates passed at `4745824`. After one docs repair, all
21 acceptance criteria were met and, with authorization, PR #5 merged on 2026-09-14
(`8c398fb`); the run completed with an observed merge. #4 ran uninterrupted from
2026-09-14 to an observed merge on 2026-09-15 (PR #6, `8d8cde7`) with one engine
fix on the way (`8e61d1b`, tests-stage `already-satisfied`). #3 deviated from the
interrupted journey: no explicit stop during CI, only the unplanned park/resume.
The six canary #4 observations are resolved in `2.0.0-rc.2`; the canary ledger
names the fix per observation.

## Reliability remediation (2026-10, `v2/reliability-remediation`)

Runs stopped midway because recoverable slips parked, bulky hand-offs passed
through the runner, some gates could not converge for valid work, and environment
traps. Ten decisions address these across five phases:

- [x] Delete v1 source; tag `archive/v1-engine` (decision 1).
- [x] Per-role brief files, identity-free results and reviewer sync (decisions 3, 9, 10).
- [x] Re-issue rejected results twice before parking; retry transient git/gh/install
      failures up to five in a row; scope a corrupt state file to its own run (decision 4).
- [x] Converging gates and reviews: RED kinds, CI delegation for non-vitest tests,
      full-suite task-check, scoped re-reviews, test-claim strengthening, merge-base
      feature range and snapshot removal (decisions 2, 5, 6, 7).
- [x] Base-branch resolution, quota boundary waits, a run-scoped compaction reminder
      and fenced spec output parsing (decision 8).
- [ ] Canary on `jfa94/asset-generator` (main-only), with quota active, one
      stop/resume and one compaction. Pass: zero manual recovers, zero `environment`
      parks, no refused or ignored briefs, and snapshots cleaned up.

This remediation is **not release-ready** until that canary passes. Canary #5
(issue #7, 2026-10-05) delivered and merged with zero manual recovers and no
refused briefs, but not cleanly: one environment park (display sleep) and three
defects fixed during the run (Vitest 4 load failures, auto-merge, unreported
required checks). See the [canary ledger](asset-generator-canary.md). The
criterion stays open until a run passes with no environment park and no live fixes.
Canary #6 (issue #10, 2026-10-06, `2.0.0-rc.6`) delivered and merged (PR #11) but
was not clean: load-induced test timeouts parked a baseline as `environment`
(fixed in `45753a82`, `2.0.0-rc.7`: flaky tests rerun and wait), and the runner
asked before merging because of the operator's global merge-confirmation rule.
The clean-canary criterion remains open.
`2.0.0-rc.8` (`563ef321`): Factory never merges into `main`; a live run based on
`main` ends ready for review. Starting a live run confirms push, PR and merge into
`develop`, so the runner no longer asks. A main-only canary therefore ends at
`ready-for-review`, not an observed merge.
Canary #7 (issue #12, 2026-10-07, `2.0.0-rc.8`) passed every condition except
compaction: PR #13 ended `ready-for-review`, with zero manual recovers and zero
`environment` parks, no refused briefs and its snapshots cleaned. The runner never
compacted, so the next canary forces one, targets `develop` and must observe the merge.
`2.0.0-rc.9` (`7e43d100`, `cdf6120d`): a below-target mutation gate names the
undetected mutants (`file:line mutator -> replacement`, at most 20) so repair can
target them, and delivery no longer waits on quota. Quota is checked only once work
leaves `deliver`, for example on a CI-failure repair.
