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

Evidence is memoized by the worktree's git tree-SHA, so an identical-content
re-run skips re-executing the tool — but the verdict is still re-derived, so a
cache hit never bypasses re-derivation.

## The gates

| Gate       | Checks                                                                                                                      | Fail-closed when                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `test`     | The project test suite passes.                                                                                              | Tests fail or cannot run.                                                                                     |
| `tdd`      | Tests precede implementation on the pre-squash task branch (test-before-impl commit ordering).                              | An impl commit lands with no preceding failing-test commit. Memoized by tip SHA; a no-op on squashed history. |
| `coverage` | No metric (`lines`, `branches`, `functions`, `statements`) regressed by more than `quality.coverageRegressionTolerancePct`. | Either before/after coverage summary is missing or invalid.                                                   |
| `mutation` | Mutation score meets `quality.mutationScoreTarget`.                                                                         | Score below target.                                                                                           |
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

## Beyond the deterministic gates

The deterministic gates are only the first layer of the verifier floor. The floor
also folds in **holdout validation** (a withheld answer-key, validated
independently) and the **risk-invariant review panel** (six reviewers, unanimous
approval required, with verify-then-fix confirmation of each blocking finding). The
overall floor is the subject of
[../explanation/verifier.md](../explanation/verifier.md).
</content>
