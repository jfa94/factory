# Asset-generator canary

Target selected by the user on 2026-09-07: `jfa94/asset-generator`.

## Preflight

- Original checkout is clean on `main`, commit `280ebb8`.
- GitHub repository is public and empty (`git ls-remote origin` returned no refs).
  The user explicitly approved publication on 2026-09-07 ("yes, publish").
  Its nine local commits are now published on `main`.
- Local preparation is isolated on `factory/canary-setup` in
  `/Users/Javier/Projects/asset-generator-canary-setup`.
- Factory configuration/state: `/tmp/factory-asset-generator-canary/data`;
  integration branch is `main`. Strict up-to-date protection now requires Quality,
  Mutation Testing and Security Scan. The initial protection snapshot is retained
  at `/tmp/factory-asset-generator-canary/protection-before.json`.
- The original package-manager pin, pnpm 11.13.0, is rejected by pnpm as a broken
  release. Setup pins the locally verified 11.9.0; frozen-lockfile install succeeds.
- Original baseline: 202 tests passed, including actual Puppeteer rendering, when
  run outside the macOS sandbox. Coverage thresholds pass (98.8% lines).

Scaffolding surfaced and prompted fixes for configured-branch CI targeting,
unconditional Playwright imports, and the generated mutation helper losing its
source ESLint annotation during bundling. Scaffold help now describes stable v2
protection. The setup branch retains existing source and quality thresholds.
Scaffold correctly refuses completion until the remote base and strict required
checks exist; generated files are available for review locally.

Verification after repairs: all 3,499 Factory tests pass in 174 files, including
113 scaffold/CI tests. Factory typecheck, scoped lint, formatting and bundle build
pass. The target setup passes typecheck, lint and production build; its original
checkout remains clean. Target mutation and GitHub CI have not run yet. Logs are
retained under `/tmp/factory-canary-*` and `/tmp/asset-generator-canary-*`.

## Proposed canaries

Each PRD has two dependent slices, explicit acceptance criteria and a real RED
assertion, followed by independent task/slice/feature review and acceptance.

1. **Uninterrupted: validate copy from the command line.** First add a typed,
   runtime-validated dispatch interface for RSA, PMax and Meta copy, reusing the
   existing platform validators. Then add a documented CLI that reads one JSON
   file, prints structured issues, and exits distinctly for valid copy, invalid
   copy, and malformed input/I/O. Tests cover valid platforms, rejected shapes,
   platform limits, malformed JSON and missing files. Both slices share the
   validation interface and declare dependencies for shared paths.
2. **Interrupted: batch copy validation.** Extend that interface with named batch
   entries and deterministic per-entry results, then expose the batch operation
   through the CLI. Test mixed valid/invalid entries, duplicate identifiers,
   malformed entries and stable output ordering. Interrupt after a producer commit
   and again while the existing PR awaits CI; resume with fresh driver identities.

The engine must generate each spec from a fresh GitHub PRD. These outlines are not
imported task suites or pre-approved acceptance evidence.

## Remaining steps

- [x] Approve publishing the nine existing commits and reviewed setup to the public
      target, plus provisioning stable strict protection on `main`.
- [x] Publish bootstrap; observe real CI and establish required checks without
      bypassing or weakening protection.
- [ ] Create both PRDs and execute them sequentially with independent agents.
- [ ] Retain run IDs, raw evidence, commits and CI/PR URLs; verify exactly one PR per
      feature, observed merges, preserved work/answers and unchanged protection.
- [ ] Mark the parent plan's external-canary step complete only after both pass.

## Live GitHub evidence

- Setup PR: https://github.com/jfa94/asset-generator/pull/2, initial commit `e92eb90`.
- Its first CI run (`34135006570`) failed three rendering tests with Chromium's
  "No usable sandbox" on Ubuntu. Commit `d625036` configures the gate contract's
  setup steps to use the runner's installed, AppArmor-allowed Chrome. Rendering
  assertions and quality thresholds are unchanged.
- Second CI run (`34145220116`) passed Quality, Mutation Scope, Mutation Testing
  and Security Scan. This setup diff has no mutable source, so mutation shards
  correctly had empty scope; this is not evidence for feature mutation coverage.
- Setup PR #2 merged at `2026-09-07T16:54:49Z`, commit
  `c7489509592266f56634da50f4ba8f524769312b`. The original checkout fast-forwarded
  to this baseline. Protection snapshots before and after the merge are identical.
- Uninterrupted PRD: https://github.com/jfa94/asset-generator/issues/3.
- Interrupted PRD: https://github.com/jfa94/asset-generator/issues/4.

Before the quota override was authorized, `spec resolve --issue 3` returned
`{"kind":"pause","scope":"unavailable","reason":"usage unavailable: usage-cache-missing"}`.
The user explicitly authorized `--ignore-quota` for these two Codex-driven runs.
The override is applied to spec resolution and will persist at run creation;
no usage signal is fabricated.

Initial generation exposed truncated wrapped requirements and unrecognized `R1.`
items in the plugin's requirement extractor. The extractor now retains wrapped
text, recognizes explicit requirement labels and ignores fenced examples. Eighty
focused spec/build/protocol tests pass. The full regression suite passes 3,501 tests
in 174 files, with typecheck and scoped lint passing. The fresh envelope contains
all requirements; an independent generator returned issue #3's two dependent tasks
from the merged baseline. Deterministic gates passed; independent spec review passed
59/60 with no blockers. Spec `3-validate-campaign-copy` is stored at revision 1.

Run `canary-single-20260907` uses driver `codex-canary-single-1`, one branch
`factory/3-canary-single-20260907`, and worktree
`/Users/Javier/Projects/asset-generator/.claude/worktrees/feature-canary-single-20260907`.
The engine installed dependencies and passed baseline tests before issuing tests
attempt `77724873-5c9f-43e4-92af-b7124fa173bc`. Raw envelopes and agent evidence live
under `/tmp/factory-asset-generator-canary/`; durable state and audit live under
`data/runs-v2/canary-single-20260907/` there.
Canary issue/branch/PR work is scoped to the selected target; plugin publication
remains separate.

The test writer committed meaningful RED coverage through `6f472cb`: 139 new
behavioral assertions fail while all 24 existing domain tests pass. A full RED
run preserved all 202 existing tests; corrected array-valued fixtures were then
rechecked with the focused suite, and lint passed. The engine accepted the raw
result and issued implementation attempt `7ef13d48-afcb-4e5c-8489-0378eb6fd74a`
for `copy-001`. Implementation commit `a578ec9` passed 163 focused tests and an
independent task review with no important/critical findings. The engine accepted
`copy-001`, then passed the integrated slice gates: 341 tests, typecheck, lint,
build, coverage and mutation score 88.74% against Factory's 80% target. Local SAST
is explicitly uncontracted; GitHub Security Scan remains required. All four slice
reviewers returned no important/critical claims. The engine advanced to CLI task
`copy-002`, tests attempt `1bc0dd74-7023-4332-b143-8a5df2e2be6b`, preserving the
accepted validator commit. The first run remains uninterrupted, with no feature
PR yet.

The CLI test writer committed 57 adapter/process cases at `4b80a59`, with 57
assertion failures, zero skips and passing scoped lint. Factory accepted the RED
result and dispatched implementation. Commit `9125d3e` adds the read-only CLI,
package script and documentation; all 57 focused tests now pass, including actual
command and silent package-script exit codes 0/1/2. Typecheck and scoped lint pass,
and the worktree is clean. The raw implementation result `result-3-06.json` has
been submitted for Factory's task checks and independent review. Broad CLI slice
and feature checks, acceptance, delivery and the second canary remain outstanding.

On 2026-09-09, investigation of repeated mutation scores exposed a false pass:
`DefaultStrykerTool` read the previous slice's generated report after Stryker's
next run failed before reporting. Regression tests reproduce both zero/nonzero
exits without a fresh report. The wrapper now removes only the previous generated
report before running, fails if that removal cannot be completed, and accepts a
score only from the current invocation. Focused tool/strategy tests, typecheck,
lint and rebuild pass. The CLI slice's earlier mutation pass is invalid evidence.
A fresh run correctly reports no score and a failed initial Stryker test run
(the valid-input silent pnpm test returned exit 1). This failure must be repaired
and fresh feature gates must pass before delivery. Four independent CLI slice
reviews returned no important/critical claims; their raw evidence is preserved.

The corrected Factory passes all 3,504 tests in 174 files. Scribe commit `4557b68`
updates the architecture/index/helper inventory. After its result was submitted,
fresh feature checks correctly failed mutation and dispatched repair attempt
`f26443d8-bcb9-4e0f-8c1e-895385708af1` to the implementer. The engine audit retains
the earlier false pass and the later failure; no state or prior evidence was
rewritten. Delivery remains blocked on a genuine fresh gate pass.

Repair commit `4745824` (worktree HEAD) sets `pnpm_config_verify_deps_before_run=false`
in the CLI's package-command tests so pnpm no longer reinstalls inside Stryker's
symlinked sandbox; all 57 CLI tests pass in normal and instrumented checkouts. Its
result `result-3-10.json` was written by the implementer three hours after dispatch
but never submitted: the Codex driver was a chain of separate sessions with nothing
resident to call `next-action`, so state stayed `running` with attempt `f26443d8`
in flight for days. The `--results` flag is gone: the engine now names one staged
file per role in every execute envelope, the driver writes agent output verbatim as
it returns, and any driver's `next-action` (or `resume --recover`) consumes it.
Factory itself now sets the pnpm variable on its Stryker invocation and in both CI
templates, so target repositories need no per-test workaround.

Plan from 2026-09-12: issue #3 is the recovery canary under a Claude Code session
with a fresh driver id. Its stored result is copied to the attempt's staged path,
`resume --recover` must audit a consumed result with no new implement attempt, and
fresh feature gates, review and acceptance must pass at `4745824` before push, PR,
one interrupt/resume while CI runs, and an observed merge. Issue #4 is then the
uninterrupted canary from a fresh spec. Earlier stalls do not count as uninterrupted.

## Recovery of issue #3 (2026-09-13)

Driver `claude-code-01AB5TNiyZ6N5jFVt6aKHpC7` copied `result-3-10.json` to the
staged path of attempt `f26443d8` and ran `resume --recover`. The audit records
"durable result recovered"; `in_flight` cleared with no new implement attempt,
and the stage advanced to feature-check. Fresh feature gates at `4745824` passed:
full-suite tests, typecheck, lint, build, coverage and mutation (87.5%, scope 2).

Two defects surfaced during the fresh gates and were fixed Factory-side, both
outside the reviewed plan and flagged for approval: a failed Stryker run left
`.stryker-tmp` in the worktree, so the next lint gate scanned its instrumented
copies (fixed by `--cleanTempDir always`, commit `1bda7a7`); and `run.feedback`
from the repaired mutation failure survived a passing check, so the feature-review
prompt still cited it and drew an invalid claim (fixed by clearing feedback on
check pass, commit `e843d64`; the persisted run keeps its stale feedback because
state is never edited).

Feature-review attempt `3316a4a9` returned three parseable results and one that
the strict schema rejected: the systemic reviewer's claim text was 304 characters
against the 300 limit, which the engine prompt does not state. The engine treated
the file as not yet written and answered `wait`. `resume --recover` retained the
partial panel and redispatched only `systemic-failure-reviewer` on the same
attempt and snapshot, as designed. Open Factory follow-up, not built: surface
schema-invalid staged files in the `wait` reason and state the claim limit in the
prompt, so a driver can tell "still running" from "finished wrong".

The redispatched systemic reviewer returned a 281-character claim (rejected file
kept as `rejected-3-11-systemic-failure-reviewer.json`); the engine recorded the
full panel and issued confirm attempt `e84895e1`. The finding verifier confirmed
the docs claim (pnpm pins script cwd to the package root, reproduced from `docs/`)
and refuted the stale-mutation claim and the unreachable-rethrow claim. The engine
scheduled feature repair pass 2 (attempt `e4a772a1`) in the feature worktree.
Driver note: the verifier wrapped its JSON in a markdown fence despite explicit
instruction; the driver removed only the fence before staging (raw text kept as
`result-3-14.raw.txt`). A fenced file would otherwise read as "not yet written"
forever, the same failure shape as the oversized claim.

Repair commit `274965c` corrects the docs cwd statement only; no acceptance
criterion requires caller-cwd semantics. Fresh feature gates passed at that HEAD
(full-suite tests, typecheck, lint, build, coverage, mutation 87.5%). The second
feature-review panel (attempt `b30f61f8`) returned one claim from the quality
reviewer (pre-existing O(n^2) near-duplicate scan, no size bound) and one from the
silent-failure hunter (generic read-error message); implementation and systemic
reviewers returned none. The verifier refuted both against the spec: R1 requires
the exported validators to be preserved, and R3 specifies a generic stderr
diagnostic. The engine advanced to acceptance (attempt `3694e605`).
Driver note: the session's loaded plugin predates `agents/acceptance-evaluator.md`,
so `factory:acceptance-evaluator` was not a dispatchable type; the evaluator ran as
a general-purpose Opus agent instructed to read and obey that charter file.

Acceptance attempt `3694e605` returned all 21 criteria met with executed evidence
(220 focused tests, 398 full-suite, gates re-run in the snapshot; only the
uncontracted `format:check` fails on two untouched workflow files). Its result is
staged but not yet consumed: the next `next-action` would run live delivery (push
`factory/3-canary-single-20260907`, open the PR, auto-merge), which requires
explicit user authorization. The branch remains local-only at `274965c`.

## Delivery of issue #3 (2026-09-14)

With user authorization, `next-action` consumed the acceptance result, pushed
`factory/3-canary-single-20260907` and opened
https://github.com/jfa94/asset-generator/pull/5 at `274965c`, then parked the run
with "Unexpected end of JSON input": `gh pr checks` prints no JSON before the first
check reports, and the runtime parsed its empty stdout. Fixed Factory-side (empty
checks output reads as pending) together with the other defects observed this run:
staged reads look past a markdown fence or prose wrapper, the `wait` reason names
schema-invalid staged files, and the engine prompt states the 300-character claim
limit. The parked run was resumed after CI (Quality, Mutation Testing, Security
Scan all passed) and `next-action` observed the squash merge: merge commit
`8c398fb`, merged at 2026-09-14T17:19:21Z, run `completed` with `outcome: merged`.
Exactly one feature PR exists; the feature branch is preserved on the remote.
Current `main` protection still requires strict up-to-date Quality, Mutation
Testing and Security Scan with admins enforced and force pushes disallowed; the
earlier `protection-before.json` snapshot no longer exists on disk, so the
comparison is against the values recorded above, not a byte diff.

Deviations to note: the planned interrupt while CI ran did not happen as an
explicit stop (the driver's `run stop` call omitted `--run`); the unplanned park
and resume during CI is the only interruption evidence for this run. The
acceptance evaluator ran as a general-purpose Opus agent reading the charter file
because the session's installed plugin is the cached 1.45.2 build. Issue #4 is
next as the uninterrupted canary from a fresh spec.
