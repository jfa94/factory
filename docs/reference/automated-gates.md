# Automated Gates

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

## Gates by stage

The feature engine (`src/feature/runtime.ts`, `checks`) chooses the gate set from
the stage. Base refs are the task base, the slice base, or the merge-base of `HEAD`
with `origin/<base branch>`.

| Stage           | Gates                                                           | Test scope | Base ref                    |
| --------------- | --------------------------------------------------------------- | ---------- | --------------------------- |
| `tests`         | `test`                                                          | diff       | task base                   |
| `task-check`    | `test`, `type`, `lint`, plus the unsquashed TDD verdict         | full suite | task base                   |
| `slice-check`   | `test`, `type`, `lint`, `build`, `coverage`, `mutation`, `sast` | full suite | slice base                  |
| `feature-check` | as `slice-check`, plus Playwright when the run has `--e2e`      | full suite | merge-base with base branch |

Each check must execute exactly one test command; executed-test counts are part
of the evidence. The `tdd` gate id is not run as a gate strategy by the feature
engine; ordering is checked directly at `task-check` (see
[The TDD check](#the-tdd-check)).

### RED at the tests stage

The tests stage expects failing tests. It records one of three RED kinds:

| RED kind                  | Condition                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assertion`               | At least one test executed and an assertion failed.                                                                                                           |
| `missing-declared-module` | Vitest failed to load a test because an import is missing, and the missing file is declared by the task and absent at the task base.                          |
| `delegated-to-ci`         | Every changed test file is one vitest cannot run (pgTAP, Go, and similar). Their pass/fail is left to the PR's CI; the files are listed in the check details. |

Any RED kind also requires every commit since the task base to be a tagged
test-only commit. Exempt tasks skip this requirement.

### Playwright at feature-check

With `--e2e`, feature-check runs `pnpm exec playwright test --reporter=json` in the
feature worktree. It passes only when the command exits 0 and the report shows
`expected > 0`, `unexpected = 0` and `skipped = 0`. Truncated output is an error.

## How a gate sweep works

For each enabled gate, the runner runs its strategy. A strategy returns one of:

- **ran** — the check executed and observed a pass/fail signal (ground-truth
  `GateEvidence`). The runner feeds this into the conjunction.
- **skip** — the gate is not applicable (no `package.json`, no script configured,
  no mutable changes). A skip is **neither pass nor fail**: it is excluded from the
  conjunction (so it cannot default-open the merge gate) but recorded loudly with a
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

Why not `npx`? See [Why gates exec local bins, never `npx`](../explanation/verifier.md#why-gates-exec-local-bins-never-npx).

The `test` gate additionally runs vitest with `--coverage.enabled=false`
(`DefaultVitestTool`). It is a diff-scoped pass/fail gate (only the changed test
files); a project whose vitest config forces global per-file coverage thresholds
would otherwise fail the scoped run — every file the scoped tests don't exercise
reports 0% — a false negative unrelated to whether the tests pass. Coverage is the
`coverage` gate's job (before/after summaries), never the `test` gate's.

Before handing the diff-scoped test files to vitest, the strategy filters them to
the **vitest-runnable** extensions (`.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`,
excluding `.d.ts` declaration files, via `isVitestRunnable` in
`strategies/test.ts`). The TDD gate's test-path matrix is broader than what vitest
can execute — it also classifies pgTAP (`*.test.sql`), Go (`*_test.go`), declaration
files under `tests/`, and other non-JS test files as test commits. Handing one of
those to vitest yields "No test files found" → exit 1 → a spurious `test`-gate
failure. So:

- **Mixed change** (some vitest-runnable tests present): vitest runs the runnable
  subset; the evidence detail names the excluded count (e.g. `diff-scoped (1 test
file(s)); 1 non-vitest file(s) not executed`). Non-runnable files are left to
  the target repo's own CI and the reviewer panel.
- **Pure non-JS/non-runnable change** (the diff scoped one or more test files but
  **none** are vitest-runnable, e.g. a pgTAP-only commit or a `tests/globals.d.ts`
  change): "nothing ran" must never read as "passed", so the gate is **skipped**
  (`no-vitest-runnable-tests-in-scope`), excluded from the conjunction exactly like
  `coverage` when no summaries are present. The `tdd` gate owns test _existence_;
  non-JS green-ness is delegated to the reviewer panel and the repo's own CI.
- **No test files in the diff:** the run is un-scoped (full suite).

Diff scoping applies only at the tests stage. Every other stage runs the full
suite (see [Gates by stage](#gates-by-stage)). A contracted test command always
runs as-is.

## CI-parity gate env (`quality.gateEnv`)

`quality.gateEnv` is a name→value map of **CI-parity placeholders, not a secret
store**. Populate it with `factory configure --set quality.gateEnv.<KEY>=<value>`.
`factory scaffold` renders it into the managed `quality-gate.yml` as an `env:` block,
so the repo's GitHub CI builds with those values (for example `NEXT_PUBLIC_*` names a
static prerender needs).

The v2 feature runtime also merges the map over `process.env` for every local gate
command and the TDD commit inspection (`defaultGateTools(gateEnv)`). See
[configuration.md](./configuration.md#gateenv--ci-parity-placeholders).

## Which gates CI mirrors (the render partition, S2)

The local `GateRunner` and the scaffolded GitHub CI job (`quality-gate.yml`,
[Decision 53](../explanation/decisions.md#decision-53--stack-adaptive-quality-gate-ci-rendered-from-the-gate-contract))
enforce **overlapping but not identical** gate sets. `src/ci/render-quality-gate.ts`
pins that split explicitly so local-green can never silently diverge from CI-green:

- `CI_RENDERED_GATES` = `type`, `lint`, `test`, `build`, `mutation` — rendered as CI
  steps (mutation via its own begin/end region, the other four as plain `- run:`
  steps). CI mirrors these so a task that passes the local gate also passes the repo's
  own CI on the shipped commit. See [Mutation in CI](#mutation-in-ci).
- `LOCAL_ONLY_GATES` = `tdd`, `coverage`, `sast` — enforced locally but
  **not** rendered into CI:
    - `tdd` needs the unsquashed task history (commit ordering); CI only ever sees
      the squashed merge, so the check cannot run there.
    - `coverage` compares a head and a base measurement taken in local worktrees —
      no CI analogue.
    - `sast` is deliberately local for now (a plain command gate, so a future CI step
      is possible — a classification choice, not a hard constraint).

A cross-check test asserts `[...CI_RENDERED_GATES, ...LOCAL_ONLY_GATES]` equals the
canonical `GATE_IDS`. A **9th** gate id therefore fails the partition test until it is
classified into one bucket or the other — the whole point is that adding a gate can't
skip the local-vs-CI decision. No new CI steps were added by this pinning; `sast` and
`coverage` stay local.

### Template anchors are load-bearing (render throws when one is missing)

`renderQualityGate` customizes the shipped template by substituting into specific
**anchor** lines rather than by generating YAML wholesale. Two substitutions are
guarded, because a silently-missed one renders a workflow that looks valid and gates
the wrong thing:

| Anchor                                                 | Substitution                                                                        | On zero matches                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------- |
| the single-quoted `grep -Ev '…'` mutable-source filter | the single-sourced `MUTABLE_SOURCE_EXCLUDE` predicate                               | **throws** — the mutation scope would be unfiltered |
| the default roots pathspec `'src/**/*.ts'`             | the contract's `gates.mutation.roots` (skipped when the contract keeps the default) | **throws** — mutation would run on the wrong roots  |

**The guard counts what it substitutes.** The mutable-source guard once detected
candidate lines with a broad substring test (`includes('grep -Ev')`) while substituting
with a narrower pattern that also required the single-quoted argument. A template edit
that merely re-quoted the line (double quotes instead of single) would have satisfied the
detector, passed the guard, and then silently no-op'd the replacement — shipping an
unfiltered mutation scope with no error. Detection and substitution now use the **same**
regex, so "the anchor is present" and "the substitution happened" cannot diverge.

If you edit `templates/.github/workflows/quality-gate.yml`, keep both anchors intact
**in their exact quoted form**; a rename or a re-quote that drops one fails the render
loudly at scaffold time instead of shipping a mis-scoped mutation run.

### Extra CI setup steps (`setup_steps`)

A gate command that needs a service or toolchain the default package-manager setup does
not provide (a database, a native CLI) can declare **`setup_steps`** in
`.factory/gates.json` ([Decision 73](../explanation/decisions.md)). `renderQualityGate`
appends each step **after** the package install in **both** the Quality job and the
mutation-shard job (in the shard, each carries the same `if: steps.slice.outputs.slice
!= ''` guard as the package setup, so a custom boot is skipped when the shard has no
mutants). Each step is strict: **exactly one** of `uses` or `run`, an optional `name`,
and `with` **only** alongside `uses`. Hand edits to the managed `quality-gate.yml` are
reverted as drift — declare the step in the contract instead. See
[Scaffold a repo § setup_steps](../guides/scaffold-a-repo.md) for the how-to.

### Per-repo required checks (`requiredChecks`)

Factory config is **global-only**, so a per-repo branch-protection requirement lives
in the committed contract instead. Optional top-level fields in `.factory/gates.json`
extend the required status checks computed by `effectiveProfiles`
(`src/git/protection.ts`). They are **additive-only**: a contract can add required
contexts, never remove a config-required one.

- **`requiredChecks?: string[]`**: extra required CI contexts merged into the
  required list (`git.developRequiredStatusChecks`). Example: `["pgTAP"]`.
  `"Mutation Testing"` is **rejected** here because the config owns it.
- **`requireMutationAtRest?: boolean`**: retired with the at-rest baseline profile.
  Committed contracts carrying it still load; the field is ignored.

The resulting list is used in two places, both against the resolved base branch:
`factory scaffold` strengthens protection to it, and `run create` / `debug create`
preflight refuses to start when protection does not satisfy it. See
[`git` configuration](configuration.md#git).

## The gates

| Gate       | Checks                                                                                                                                                                                                                                         | Fail-closed when                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test`     | The vitest-runnable changed test files pass (diff-scoped). Pure non-JS/non-runnable test sets (pgTAP, Go, `.d.ts`…) are **skipped** (not applicable — execution-only gate, `tdd` owns existence).                                              | Runnable tests fail or cannot run.                                                                                                                                              |
| `tdd`      | Tests precede implementation on the unsquashed task history (test-before-impl commit ordering).                                                                                                                                                | An impl commit lands with no preceding failing-test commit.                                                                                                                     |
| `coverage` | Measures head (task worktree) and base (ephemeral detached worktree) with vitest's json-summary coverage reporter; no metric (`lines`, `branches`, `functions`, `statements`) regressed by more than `quality.coverageRegressionTolerancePct`. | Either measurement fails (command error, summary missing/invalid), the base ref is unresolvable, or no coverage command is derivable from a non-vitest test command. See below. |
| `mutation` | Mutation score (derived in-engine from the stock json report's per-file mutants) meets `quality.mutationScoreTarget`. Scope = mutable `.ts` under the contracted `gates.mutation.roots` (default `["src"]`).                                   | Score below target, or no score is derivable from a present report (non-empty scope).                                                                                           |
| `sast`     | `quality.securityCommand` (allowlisted runners only) exits 0. Skipped when unset.                                                                                                                                                              | Findings present (unless `quality.securityAllowFailures`).                                                                                                                      |
| `type`     | The project type-check passes.                                                                                                                                                                                                                 | Type errors.                                                                                                                                                                    |
| `lint`     | The linter passes.                                                                                                                                                                                                                             | Lint errors.                                                                                                                                                                    |
| `build`    | The project builds.                                                                                                                                                                                                                            | Build fails.                                                                                                                                                                    |

## The coverage gate in detail

The factory MEASURES coverage itself (S8) — nothing in the repo has to produce
summaries. On each contracted sweep the gate runs a coverage command twice and
compares the totals: **head** in the task worktree, **base** in an ephemeral
detached git worktree at the base commit (sharing head's `node_modules` via
symlink, removed afterwards).

**The command** derives from the gate contract, in precedence order:

1. `gates.coverage.command` — runs as-is; it MUST write
   `coverage/coverage-summary.json` (istanbul json-summary shape). This is the
   escape hatch for non-vitest runners (deno, Go, monorepos, vitest
   `coverage.thresholds` — see caveat below).
2. A contracted vitest **test** command — its argument tail is reused with the
   json-summary coverage flags appended (`run` is forced; never watch mode).
   A contracted **non-vitest** test command with no coverage override fails the
   gate loud: contract `gates.coverage.command` or waive coverage.
3. Neither — the built-in `vitest run` + coverage flags.

The strategy accepts an optional per-tree-SHA measurement cache, but the v2 feature
runtime does not supply one, so both sides are measured on every sweep.

**Fail-closed rules:** any non-measured answer — command failed, summary missing,
summary invalid — FAILS the gate naming which side broke (`head` or `base <sha>`)
with a stderr excerpt. An unresolvable base ref fails too. The only skip is an
explicitly uncontracted entry (`uncontracted: <reason>`, the committed waiver) —
a worktree with no `.factory/gates.json` at all fails loud naming `factory scaffold`.

**Scaffold contracts it on npm** when a vitest coverage provider
(`@vitest/coverage-v8` or `@vitest/coverage-istanbul`) is installed; otherwise
scaffold REFUSES — install a provider or pass `--waive coverage` to record the
waiver. Deno stays waived-by-stack (deno coverage emits lcov, not json-summary);
contract a `gates.coverage.command` that writes the summary to opt in. Contracts
written **before** S8 carry the old "not wired yet" waiver — delete
`.factory/gates.json` and re-run `factory scaffold` to pick up the flip (seed
semantics: an existing valid contract is never touched).

**Caveat — vitest `coverage.thresholds`:** if the repo's vitest config enforces
coverage thresholds, a below-threshold run exits non-zero and the measurement
counts as command-failed even when the base-vs-head delta is fine. Remedy:
contract a `gates.coverage.command` that disables thresholds for the measurement
run.

## The TDD check

Test-driven ordering is checked on the **unsquashed** task history
(`task base..HEAD` in the feature worktree). The feature engine calls
`deriveTddVerdict` over the commits tagged with the task id at `task-check`; a
failing verdict fails the check.

- **Commit-tag attribution**: the classifier (`tdd-classify.ts`) reads each commit's
  `[task-id]` tag to attribute it. An implementation commit with no tag is flagged
  `impl-commit-untagged` and blocks the task.
- **Tests-stage admission**: a RED result, or a tests-stage `already-satisfied`,
  is accepted only when every commit since the task base is a tagged test-only
  commit. A tests-stage `already-satisfied` that fails this parks the run as a
  producer failure. When a task is accepted as already satisfied, the ordering
  check is skipped because there is no implementation commit to order.
- **Exemptions**: `tdd_exempt: true` on the task in the frozen spec, or
  `factory.tddExempt` in `package.json` as it existed at the spec's base commit.
  Producer edits to `package.json` during the run cannot grant an exemption. For
  test runners vitest cannot execute, contract the test gate's `command` in the
  repo's committed `.factory/gates.json` rather than bypassing enforcement.

## The mutation gate in detail

The mutation gate runs `stryker run --mutate <diff-scope> --cleanTempDir always`
(scope = added/modified mutable `.ts` under the contracted **mutation roots** minus tests/types/data/index,
mirroring CI) and reads `reports/mutation/mutation.json`. The temp dir is removed even after a
failed run so its instrumented copies never reach the next lint or coverage gate.

- **Mutable-source roots are contract data** ([Decision 75](../explanation/decisions.md#decision-75--mutation-ci-redesign-develop-only-warm-base-incremental-hash-shards-roots)).
  `mutationScope` filters the diff to `.ts` files under the roots named by optional
  `gates.mutation.roots` in `.factory/gates.json` (default `["src"]`; plain
  repo-relative dirs, no globs; mutation gate only — the schema rejects `roots` on any
  other gate). `mutationRoots(contract)` (`src/verifier/deterministic/gate-contract.ts`)
  is the single source both the local scope filter and the CI render read, so they can
  never disagree on where source lives. Scaffold detects the roots (`src/` wins; else
  the candidate dirs `app/components/lib/utils/db/server/hooks` that contain mutable
  `.ts`) and **refuses loudly** rather than contract mutation with zero roots — a repo
  with no matching source would otherwise pass the required "Mutation Testing" check
  having mutated nothing (the goodbyespy no-op). Add explicit `roots` or `--waive
mutation` to opt out; `--waive mutation` wins even when Stryker is installed.

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
- **Below-target feedback names the undetected mutants.** A `score-below-target`
  detail appends `undetected mutants:` followed by each `Survived` or `NoCoverage`
  mutant from the report, in report order, formatted
  `file:line mutator -> replacement` (`mutationSurvivors`,
  `src/verifier/deterministic/tools.ts`). The line is omitted when absent, the mutator
  name falls back to `mutant`, and the replacement is omitted when absent. At most 20
  are listed; the remainder is summarised as
  `+N more (reports/mutation/mutation.json)`. Example:
  `score-below-target: 60 < 80; undetected mutants: src/a.ts:12 ConditionalExpression -> true`.
- **The Stryker config is shadow-proof.** TCB write-protection covers **every**
  basename Stryker's discovery can load (the full `{'',.'} × {.conf,.config} ×
{json,js,mjs,cjs}` set), not just the scaffolded `.stryker.config.json`. An
  implementer therefore cannot create an unprotected sibling (e.g. `stryker.config.mjs`
  — executable JS that would run inside the gate process) to shadow or weaken the
  gate config. The protected set and the gate's applicability set are both derived
  from one list (`src/shared/gate-config-names.ts`) with a drift-guard test.
  Scaffold enforces the same at seed time: it **refuses to seed**
  `.stryker.config.json` when any sibling Stryker config basename already exists,
  warning which file Stryker's first-existing-wins discovery would actually load —
  so the factory seed can never silently shadow a project's own hand-tuned config.
  The seed also renders **after** the gate contract (pass 2a) so its `mutate` globs
  come from the contracted roots.

### Mutation in CI

The scaffolded `quality-gate.yml` triggers on `pull_request` into the resolved
base branch (`branches: [<base branch>]`). Its mutation jobs carry no base-ref
condition, so mutation runs on every such PR, including the factory's feature PR.
The `Mutation Testing` aggregator job reports the matrix outcome under that single
check name. Every quality-gate job carries a `timeout-minutes` bound.

The PR verdict is **hunk-scoped and cold**. The managed helper reads zero-context
diff hunks, mutates added files in full, pads modified and deletion-seam ranges by two
lines, merges adjacent ranges, and stable-hash splits the patterns eight ways. PR jobs
do not restore incremental files: replayed results would make `thresholds.break`
depend on cache history rather than only the PR.

The second MANAGED workflow keeps the historical filename
`.github/workflows/mutation-nightly.yml`, but is displayed as **Mutation Full
(Manual)** and has only `workflow_dispatch`. It checks out the base branch, computes the
full surface with the same helper/exclusions/quarantine rules, and processes each
shard sequentially in eight-file chunks. A 330-minute soft cap leaves publication
headroom under the 360-minute job timeout; at least one chunk always runs. One
incremental file is reused per shard, and partial progress saves even when Stryker's
threshold exits non-zero. Cache restores use the stable OS/shard prefix, while saves
include the checked-out base-branch SHA, `run_id`, and `run_attempt`, avoiding immutable
key reservation collisions. The seed `.stryker.config.json` mirrors the helper's
tests/declarations/type-only/types/data/barrel/Next-metadata exclusions so a CLI
`--mutate` override cannot reintroduce a zero-mutant shard.

## Beyond the deterministic gates

The deterministic gates are the first layer. Review is the second; the
[architecture overview](../architecture/overview.md#verification-and-repairs)
describes the flow and [the verifier](../explanation/verifier.md) explains why.

| Stage            | Roles                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `task-review`    | `quality-reviewer`                                                                                  |
| `slice-review`   | `quality-reviewer`, `implementation-reviewer`, `silent-failure-hunter`, `systemic-failure-reviewer` |
| `feature-review` | as `slice-review`                                                                                   |
| `confirm`        | `finding-verifier`, two claims per attempt                                                          |
| `acceptance`     | `acceptance-evaluator`                                                                              |

`database-design-reviewer` is added to a slice or feature panel when a file in the
review range matches a database path (`isDbPath`,
`src/verifier/deterministic/db-detect.ts`): migration directories, `drizzle/`,
`schema.prisma`, or any `*.sql` file.

Every panel role must return a `claims` array (empty when clean). A claim's quote
must appear within two lines of the cited line in the review snapshot; an invalid
citation rejects that reviewer's result. Claims then go to independent
confirmation, and only confirmed claims become repair feedback.
