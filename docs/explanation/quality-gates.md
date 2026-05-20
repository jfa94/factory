# Quality Gates

This document explains the 7-layer quality gate stack and the rationale behind each layer.

## Why 7 Layers

AI-generated code has a 67.3% PR rejection rate (LinearB study). The failures cluster around specific patterns:

- **Syntax and style errors** that static analysis catches
- **Security vulnerabilities** that SAST tools detect (injection, hardcoded secrets, etc.)
- **Test-after-implementation shortcuts** where agents write tests post-hoc rather than driving design with them
- **Broken tests** that the test suite catches
- **Coverage regression** where agents delete failing tests rather than fixing implementations
- **Surface-level implementations** that satisfy the letter but not the spirit of requirements
- **Tautological tests** that assert what was written, not what should work

Each layer targets a specific failure mode. The layers are sequential: a failure at any layer blocks progression to the next. This ensures problems are caught early, reducing wasted computation on code that would fail later.

---

## Layer 1: Static Analysis

**Purpose:** Catch syntax errors, lint violations, type errors, and formatting issues before tests run.

**Trigger:** Automatic via existing user hooks. Fires on every commit attempt.

**Why this layer exists:**

Agent instructions to "follow coding standards" are followed approximately 70% of the time. Hooks enforce at 100%. By delegating style enforcement to pre-commit hooks, the pipeline guarantees consistent code quality regardless of agent behavior.

**Failure behavior:**

The task-executor receives hook error output and fixes the issue. Max 3 internal retries. If all retries fail, the task is marked failed.

**Configuration:**

This layer uses the user's existing hook configuration. No plugin-specific settings.

---

## Layer 2: Security Gate (Opt-in)

**Purpose:** Run static application security testing (SAST) to catch vulnerabilities before tests run.

**Trigger:** After static analysis, before tests. Called by `pipeline-run-task` in the `postexec` stage.

**Why this layer exists:**

AI-generated code has 2.74x more vulnerabilities than human code (research finding cited in the security-reviewer agent). Common issues include SQL injection, hardcoded secrets, missing input validation, and insecure defaults like wildcard CORS. Static analysis tools like Semgrep can catch many of these patterns automatically, freeing human and AI reviewers to focus on business-logic issues that tools miss.

This layer is opt-in because not all projects have SAST tooling configured. Once configured, it runs automatically on every task.

**How it works:**

1. `pipeline-security-gate` reads `.quality.securityCommand` from config
2. If unset, the gate is skipped (exit 2) and the pipeline continues
3. If set, the command is validated against a strict allowlist (same discipline as `redTestCommand`)
4. Command runs in the task worktree; stdout is captured as the findings artifact
5. Findings are written to `$CLAUDE_PLUGIN_DATA/runs/<run-id>/<task-id>.security-findings.json`
6. For security-tier tasks, the `security-reviewer` agent receives the findings path and triages them before manual review

**Failure behavior:**

By default, a non-zero exit from the security command fails the task. Set `quality.securityAllowFailures: true` to record findings without blocking — useful during initial rollout to observe findings without breaking the pipeline.

**Configuration:**

| Setting                         | Default | Description                                                |
| ------------------------------- | ------- | ---------------------------------------------------------- |
| `quality.securityCommand`       | (none)  | Command to run (e.g., `semgrep --config auto --error`)     |
| `quality.securityAllowFailures` | false   | When true, findings are recorded but do not block the task |

---

## Layer 3: TDD Gate

**Purpose:** Enforce test-before-implementation commit ordering so tests drive design rather than ratifying it.

**Trigger:** After security gate passes. Called by `pipeline-run-task` via `pipeline-tdd-gate` in the `postexec` stage.

**Why this layer exists:**

Writing tests after the fact is a known failure mode for AI code generators: the model knows the implementation and writes tests that confirm it rather than testing edge cases it hasn't considered. The TDD gate prevents this by verifying that at least one test commit exists before the first implementation commit on the task branch.

**How it works:**

`pipeline-tdd-gate` inspects the git log between the base branch and HEAD. It looks for commits matching the `test(task-id):` prefix convention. If the first non-empty commit is an implementation commit (no test prefix), the gate fails. Tasks can opt out via `tdd_exempt: true` in `spec/tasks.json`, or project-wide via `package.json.factory.tddExempt`.

**Failure behavior:**

The gate exits non-zero, which `pipeline-run-task` treats as a blocking failure (exit 30). The task is escalated for human review rather than automatically retried — an impl-first commit ordering is a structural violation, not a transient error.

**Configuration:**

- Per-task: `tdd_exempt: true` in `spec/tasks.json` (read at spec load time, never from `state.json`)
- Global: `tddExempt: true` in `package.json > factory`
- Custom runner: `.quality.redTestCommand` in config (for non-standard test runners like Go, Ruby, Deno)

---

## Layer 4: Test Suite

**Purpose:** Verify implementation correctness against existing and new tests.

**Trigger:** Runs as part of the task-executor's internal loop. The existing Stop hook also runs tests when the agent session ends.

**Why this layer exists:**

Tests are the primary correctness check. Unlike static analysis (which catches form), tests catch functional errors. The dual trigger (executor loop + Stop hook) ensures tests run even if the executor doesn't explicitly invoke them.

**Failure behavior:**

The task-executor receives test output and fixes failing tests or implementation. Max 3 internal retries. Critical rule: never modify existing tests to make them pass. Fix the implementation instead.

**Configuration:**

Uses the project's test runner. No plugin-specific settings.

---

## Layer 5: Coverage Regression

**Purpose:** Ensure new code doesn't decrease test coverage.

**Why this layer exists:**

Agents under pressure (e.g., running out of turns) have been observed to delete failing tests to improve metrics. This layer catches that behavior. Coverage is treated as a floor, not an optimization target: it must not decrease.

**Trigger:** After test suite passes. Called by the orchestrator.

**How it works:**

`pipeline-coverage-gate` compares before/after coverage JSON files. It checks line coverage, branch coverage, function coverage, and statement coverage. Any decrease beyond the tolerance threshold (default 0.5%) fails the gate.

**Failure behavior:**

The task-executor must add tests to restore coverage. The orchestrator re-runs the coverage gate after the fix.

**Configuration:**

| Setting                                  | Default | Description                                                                                           |
| ---------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `quality.coverageMustNotDecrease`        | true    | Enable/disable this gate                                                                              |
| `quality.coverageRegressionTolerancePct` | 0.5     | Max allowed drop in percentage points before the regression gate fails (not a minimum coverage floor) |

---

## Layer 6: Holdout Validation

**Purpose:** Verify that the implementation genuinely satisfies the spec, not just the explicit instructions.

**Why this layer exists:**

AI implementations can "teach to the test" - satisfying exactly what was asked without understanding the broader requirement. Holdout validation withholds a percentage of acceptance criteria from the task-executor, then checks if those criteria are met anyway. If the implementation is genuinely correct, withheld criteria should be satisfied as a natural consequence.

This pattern comes from machine learning, where holdout data prevents overfitting. Applied to code generation, it prevents surface-level implementations.

**Trigger:** After coverage gate passes. Called by the orchestrator.

**How it works:**

1. `pipeline-build-prompt --holdout N%` randomly selects N% of acceptance criteria
2. Selected criteria are stored in `${CLAUDE_PLUGIN_DATA}/runs/<run-id>/holdouts/<task-id>.json`
3. Task-executor never sees withheld criteria
4. After execution, the orchestrator passes withheld criteria to the reviewer
5. Reviewer verifies whether the implementation satisfies them

Since task-executors run in worktrees and holdouts live in plugin data, the executor cannot access criteria it was not meant to see.

**Failure behavior:**

If fewer than 80% of withheld criteria are satisfied, the implementation is surface-level. The task-executor receives the full spec (including previously withheld criteria) and re-implements. Holdout validation is NOT repeated on re-implementation (that would be unfair - the executor now knows all criteria).

**Missing reviewer output (fail-closed):**

When a holdout file exists but the `SubagentStop` hook has not wired the `holdout_review_file` field to state — meaning the reviewer never wrote its output — the pipeline records `.tasks.<id>.quality_gates.holdout = "missing-reviewer-output"`, marks the task `needs_human_review`, and returns exit 30 (blocking). It does not continue. This fail-closed behavior prevents a missing reviewer output from silently passing as an approval.

**Configuration:**

| Setting                   | Default | Description                        |
| ------------------------- | ------- | ---------------------------------- |
| `quality.holdoutPercent`  | 20      | Percentage of criteria to withhold |
| `quality.holdoutPassRate` | 80      | Minimum % that must be satisfied   |

---

## Layer 7: Mutation Testing

**Purpose:** Verify test quality by measuring mutation score.

**Why this layer exists:**

AI-generated tests often achieve high line coverage (85-95%) but low mutation scores (30-40%). These are tautological tests: they assert what was written, not what should work. Example:

```javascript
// Implementation
function add(a, b) {
  return a + b;
}

// Tautological test
test("add works", () => {
  expect(add(2, 3)).toBe(5); // Passes, but doesn't test edge cases
});
```

A mutant like `return a - b` would make this test fail, but if the test only checks one case, many mutants survive. Mutation score measures test thoroughness: what percentage of code changes (mutants) are caught by tests?

Industry target is >80% mutation score. AI code has 15-25% higher mutation survival rates than human code.

**Trigger:** Ship-time pregate (`_run_ship_pregate` in `pipeline-run-task`), runs unconditionally for every staging-bound task PR. Local execution mirrors the GitHub `Quality Gate` workflow's mutation job exactly — same scope filter, same Stryker invocation — so a task that fails mutation locally would also fail on CI, and mutation regressions cannot reach CI undetected.

**CI workflow architecture:**

The GitHub workflow (`templates/.github/workflows/quality-gate.yml`) runs mutation testing in a 4-shard matrix for parallelism:

1. `mutation-scope` job: diffs HEAD against `origin/<base_ref>`, splits changed src files round-robin into 4 shards (JSON output). Filters exclude `*.test.ts`, `*.spec.ts`, `*.d.ts`, `types/`, `data/`, `index.ts`, and `src/app/(robots|sitemap).ts`.
2. `mutation` job (matrix x4): each shard runs `stryker run --mutate <slice>` with its own incremental cache and `incrementalFile` per shard.
3. `mutation-testing` aggregator job: collapses shard outcomes into a single "Mutation Testing" status check.

The sharding was introduced in 2026-05-18 to address develop-target full-scope runs hitting ~3.5h wall-clock time as the mutable surface grew. Tight scope + 4-way sharding drops typical rollups to ~10-30 min slowest-shard. Empty slices no-op.

The aggregator exists because branch protection on `staging` and `develop` requires a status check named exactly "Mutation Testing", but the matrix produces "Mutation (1)".."Mutation (4)" checks. The aggregator (`needs: [mutation-scope, mutation]`, `if: always()`) exits non-zero if any upstream job failed, satisfying branch protection with a stable check name regardless of shard count changes.

The workflow uses `upload-artifact@v5` (node24-compatible) for shard artifacts.

**How it works:**

1. `pipeline-mutation-gate` computes scope: `git diff --name-only --diff-filter=AM origin/staging...HEAD -- ':(glob)src/**/*.ts'`, filtered to drop `*.test.ts`, `*.spec.ts`, `*.d.ts`, `types/`, `data/`, `index.ts`.
2. If scope is empty, exit 0 (`no-mutable-changes`) — matches CI's skip behavior for PRs with no mutable src changes.
3. Otherwise invoke `<pkg-manager> exec stryker run --mutate <scope>` and parse `reports/mutation/mutation.json`.
4. Score below `quality.mutationScoreTarget` (default 80) blocks PR creation by causing `_run_ship_pregate` to fail before `gh pr create` runs.

**Failure behavior:**

A failed mutation gate (`stryker-failed`, `score-below-target`, or `base-missing`) causes `_run_ship_pregate` to return non-zero and prevents `gh pr create` from running. The task fails ship and gets retried per the pipeline's retry budget.

**Configuration:**

| Setting                       | Default | Description                       |
| ----------------------------- | ------- | --------------------------------- |
| `quality.mutationScoreTarget` | 80      | Minimum mutation score percentage |
| `FACTORY_MUTATION_BASE`       | staging | Base ref for scope computation    |

---

## Layer Interactions

The layers are designed to complement each other:

1. **Static analysis** catches form errors early, before expensive test runs
2. **Security gate** catches common vulnerability patterns that SAST tools detect
3. **TDD gate** enforces test-before-implementation ordering
4. **Test suite** catches functional errors
5. **Coverage regression** prevents gaming by deleting tests
6. **Holdout validation** prevents surface-level implementations
7. **Mutation testing** prevents tautological tests

Each layer addresses a failure mode that previous layers miss. Together, they form a defense-in-depth strategy against AI-generated code quality issues.

---

## Skipping Layers

Individual layers can be disabled via configuration:

- Security: leave `quality.securityCommand` unset (gate skips by default)
- TDD: `tdd_exempt: true` per-task in `spec/tasks.json`, or `tddExempt: true` globally in `package.json > factory`
- Coverage: `quality.coverageMustNotDecrease: false`
- Holdout: `quality.holdoutPercent: 0`
- Mutation: drop the `test:mutation` script from `package.json` (gate skips with reason `no-script`)

Static analysis and test suite cannot be disabled; they are enforced by the user's existing hooks.

Disabling layers reduces execution time but increases the risk of quality issues reaching pull requests. Disable only when you understand the tradeoff.

---

## Non-JS / Unconfigured Project Handling

When `pipeline-quality-gate` runs in a directory without a `package.json`, or where no quality scripts (`lint`, `typecheck`, `test:coverage`, `test`) are defined, it records `skipped: true` in the quality gate result and exits 2 (not 0). This exit code distinction allows callers to differentiate between:

- Exit 0: All gates passed
- Exit 1: One or more gates failed
- Exit 2: Not applicable (legitimately skipped)

`pipeline-run-task` interprets rc=2 as "not applicable, treat as pass" and records `quality_gate=skipped` in state. The ship checklist and PR-create pretooluse guard accept `quality_gate=skipped` alongside `ok`.

This allows:

- Non-JS projects (Go, Rust, Python) to pass through cleanly
- JS projects with exotic build systems to proceed without blocking

The skip reason (`"no-package-json"` or `"no-quality-scripts"`) is persisted to state for audit purposes. Projects that want to enforce quality gates must configure either the standard npm scripts or a `factory.quality` array in `package.json`.
