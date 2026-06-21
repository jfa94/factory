# Quality Gates

The deterministic verifier runs a closed set of gates against a task's worktree
and **derives** a conjunctive verdict from the evidence each gate produces. There
is no stored gate boolean and no API to inject a verdict — a verdict can only come
out of the derive accessor over evidence a strategy actually produced. Defined in
`src/verifier/deterministic/`.

The single `GateRunner` orchestrates the per-gate strategies. The gate ids, in
canonical order:

```
test → tdd → coverage → mutation → sast → type → lint → build
```

## How a gate sweep works

For each enabled gate, the runner runs its strategy. A strategy returns one of:

- **ran** — the check executed and observed a pass/fail signal (ground-truth
  `GateEvidence`). The runner feeds this into the conjunction.
- **skip** — the gate is not applicable (no `package.json`, no script configured,
  no mutable changes). A skip is **neither pass nor fail**: it is excluded from the
  conjunction (so it cannot default-open the floor) but recorded loudly with a
  reason.

The verdict is the conjunction of the gates that ran. An **all-skipped /
empty-evidence** sweep **fails** — "nothing ran" is never "passed". A strategy
that throws (e.g. truncated tool output) propagates; the runner never swallows it
into a silent pass.

## How a command gate resolves its tool

The command-running gates (`test`, `type`, `lint`, `mutation`) execute the
worktree's **own** binary — they do **not** shell out via `npx <tool>`. For each,
the runner resolves `node_modules/.bin/<tool>` by walking up from the worktree cwd
to the filesystem root (`resolveLocalBin` /
`defaultLocalBinResolver`, `src/verifier/deterministic/tools.ts`), so a
monorepo/workspace bin at a parent root is found too, and execs that path directly.

When no local bin resolves, the tool **fails closed**: `runTool` returns a
synthetic exit-`127` result (`missingBinResult`) whose stderr names the missing
tool — it never falls back to `npx`. The `lint` and `mutation` strategies skip
first on a missing bin (gate not applicable), so in practice only the unconditional
`type` and `test` gates reach the fail-closed path, where a missing `tsc`/`vitest`
in a provisioned worktree is a genuine failure.

Why not `npx`? Under corepack with a `packageManager: pnpm@…` field (node ≥ 24), a
bare `npx <tool>` bypasses the installed `node_modules/.bin` and resolves a remote
registry package of the same name instead — e.g. `npx tsc` fetches an unrelated
`tsc` decoy and exits 1, a false type-gate failure independent of the code under
test. Executing the local bin directly is package-manager-agnostic and never
touches the network.

The `test` gate additionally runs vitest with `--coverage.enabled=false`
(`DefaultVitestTool`). It is a diff-scoped pass/fail gate (only the changed test
files); a project whose vitest config forces global per-file coverage thresholds
would otherwise fail the scoped run — every file the scoped tests don't exercise
reports 0% — a false negative unrelated to whether the tests pass. Coverage is the
`coverage` gate's job (before/after summaries), never the `test` gate's.

Evidence is memoized by the worktree's git tree-SHA, so an identical-content
re-run skips re-executing the tool — but the verdict is still re-derived, so a
cache hit never bypasses re-derivation.

## The gates

| Gate       | Checks                                                                                                                      | Fail-closed when                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `test`     | The project test suite passes.                                                                                              | Tests fail or cannot run.                                                                                     |
| `tdd`      | Tests precede implementation on the pre-squash task branch (test-before-impl commit ordering).                              | An impl commit lands with no preceding failing-test commit. Memoized by tip SHA; a no-op on squashed history. |
| `coverage` | No metric (`lines`, `branches`, `functions`, `statements`) regressed by more than `quality.coverageRegressionTolerancePct`. | Either before/after coverage summary is missing or invalid.                                                   |
| `mutation` | Mutation score (derived in-engine from the stock json report's per-file mutants) meets `quality.mutationScoreTarget`.       | Score below target, or no score is derivable from a present report (non-empty scope).                         |
| `sast`     | Static security analysis (built-in semgrep or `quality.securityCommand`) finds no blocking issue.                           | Findings present (unless `quality.securityAllowFailures`).                                                    |
| `type`     | The project type-check passes.                                                                                              | Type errors.                                                                                                  |
| `lint`     | The linter passes.                                                                                                          | Lint errors.                                                                                                  |
| `build`    | The project builds.                                                                                                         | Build fails.                                                                                                  |

## The TDD gate in detail

The TDD gate is the harness-layer enforcement of test-driven development. It is
pinned to the **pre-squash** branch tip (`base..HEAD` before squash-merge) and
classifies the commit ordering: a test-before-impl ordering passes; an
impl-before-test ordering blocks the task.

- **Memoized by tip SHA**: a re-invocation on the same tip is served from memo.
- **Squash no-op**: a single commit introducing _both_ test and impl files is the
  squashed shape — unverifiable for ordering, so the gate is a pass (not a false
  violation). A single impl-only commit is still a violation.
- **Exemptions**: `tdd_exempt: true` on a task in the spec's `tasks.json` (per
  task), or `package.json.factory.tddExempt` (globally). Read from those sources,
  **never** from `state.json` (derive-don't-store). For exotic test runners (Go,
  Ruby, Deno…), set `quality.redTestCommand` rather than bypassing enforcement.

## The mutation gate in detail

The mutation gate runs `stryker run --mutate <diff-scope>` (scope = added/modified
`src/**/*.ts` minus tests/types/data/index, mirroring CI) and reads
`reports/mutation/mutation.json`.

- **Score is derived in-engine.** Stryker's stock `json` reporter writes a
  schema-1.0 report (`files` / `dependencies` / `system`) with **no**
  `.metrics.mutationScore` — that field is a metric the HTML reporter computes, not
  something the json report carries. So the gate computes the score itself from the
  per-file mutant tally, using Stryker's own formula: `detected = killed + timeout`,
  `valid = detected + survived + noCoverage`, `score = detected / valid * 100`
  (CompileError / RuntimeError / Ignored / Pending are excluded from `valid`). A
  finite `.metrics.mutationScore`, if a metrics-emitting reporter is configured, is
  honored as a fast path. No special reporter config is required.
- **A derivable score overrides the exit code.** Target repos gate CI via Stryker's
  `break: N` threshold, which exits non-zero when CI's bar isn't met. That bar is
  independent of `quality.mutationScoreTarget`, so a present report with a derivable
  score is compared against the factory's target **regardless** of the exit code.
  Only when no score is derivable does a non-zero exit decide (`stryker-failed`) — a
  crash before scoring.
- **Fail-closed (non-empty scope):** score below target (`score-below-target`); a
  present-but-score-less report on a green exit (`no-score`); no report (`no-report`);
  unparseable report (`unparseable-report`); a truncated report **throws** rather
  than risk mis-parsing a clipped payload.

## Beyond the deterministic gates

The deterministic gates are only the first layer of the verifier floor. The floor
also folds in **holdout validation** (a withheld answer-key, validated
independently) and the **risk-invariant review panel** (six reviewers, unanimous
approval required, with verify-then-fix confirmation of each blocking finding). The
overall floor is the subject of
[../explanation/verifier.md](../explanation/verifier.md).
</content>
