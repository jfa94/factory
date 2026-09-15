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
