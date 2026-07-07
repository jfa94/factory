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

Evidence is memoized by the worktree's git tree-SHA, so an identical-content
re-run skips re-executing the tool — but the verdict is still re-derived, so a
cache hit never bypasses re-derivation.

## CI-parity gate env (`quality.gateEnv`)

Every gate command (`build`, `test`, `type`, `lint`, `mutation`, `security`) runs in a
**fresh task worktree** with no `.env.local`. The `quality.gateEnv` name→value map is
merged over `process.env` into each gate's spawn env (`defaultGateTools(gateEnv)`,
wired from config in `src/cli/wiring.ts`). Use it to mirror the repo's CI build-step env
so the gate measures the code, not a missing-env crash — e.g. a Next.js static prerender
that needs `NEXT_PUBLIC_*` defined would otherwise fail the `build` gate on a missing-env
crash unrelated to task quality. It is **CI-parity placeholders, not a secret store**. Populate it
with `factory configure --set quality.gateEnv.<KEY>=<value>`. The same map is the single source of
truth in the other direction too: `factory scaffold` renders it into the managed `quality-gate.yml`
it writes, so the local gate and the repo's GitHub CI build with identical env. See
[configuration.md](./configuration.md#gateenv--ci-parity-placeholders).

## Which gates CI mirrors (the render partition, S2)

The local `GateRunner` and the scaffolded GitHub CI job (`quality-gate.yml`,
[Decision 53](../explanation/decisions.md#decision-53--stack-adaptive-quality-gate-ci-rendered-from-the-gate-contract))
enforce **overlapping but not identical** gate sets. `src/ci/render-quality-gate.ts`
pins that split explicitly so local-green can never silently diverge from CI-green:

- `CI_RENDERED_GATES` = `type`, `lint`, `test`, `build`, `mutation` — rendered as CI
  steps (mutation via its own begin/end region, the other four as plain `- run:`
  steps). CI mirrors these so a task that passes the local gate also passes the repo's
  own CI on the shipped commit.
- `LOCAL_ONLY_GATES` = `tdd`, `coverage`, `sast` — enforced by the local runner but
  **not** rendered into CI:
  - `tdd` needs the pre-squash task branch (commit ordering); CI only ever sees the
    squashed merge, so the check cannot run there.
  - `coverage` reads a per-tree-SHA local store keyed off the task worktree — no CI
    analogue.
  - `sast` is deliberately local for now (a plain command gate, so a future CI step
    is possible — a classification choice, not a hard constraint).

A cross-check test asserts `[...CI_RENDERED_GATES, ...LOCAL_ONLY_GATES]` equals the
canonical `GATE_IDS`. A **9th** gate id therefore fails the partition test until it is
classified into one bucket or the other — the whole point is that adding a gate can't
skip the local-vs-CI decision. No new CI steps were added by this pinning; `sast` and
`coverage` stay local.

## Gates in force (S3)

The gates the merge gate will actually enforce for a run are **derived from the
repo's committed `.factory/gates.json` contract**, never stored on run state
(derive-don't-store). `enumerateGatesInForce(contract)`
(`src/verifier/deterministic/gate-contract.ts`) is a pure helper returning:

- `contracted` — the gate ids whose contract entry is `contracted: true`.
- `skipped` — each `contracted: false` gate id with its committed `reason` (the
  waiver).
- `warnings` — one line per **floor** gate that is not contracted (see below).

**`DEFAULT_GATES`** — `test`, `tdd`, `type` — is the universal floor every stack
resolver contracts unconditionally. `build` is additionally a floor gate for every
stack **except deno** (deno waives build by stack — `deno check` covers compilation,
there is no emit step — so a normal deno contract never false-warns).

If a committed contract leaves a floor gate `contracted: false`, an operator
hand-edited the contract to drop it — the one misconfiguration TCB write-protection
cannot catch (it guards the file's *writability*, not its *content*). So:

- **At `run create`**, each such dropped floor gate is warned loudly on stderr
  (`run create: default-set gate '<id>' is not contracted: … — the merge gate will
  not enforce it`). The created/superseded JSON envelope also carries `gates`
  (the full `GatesInForce` shape).
- **At finalize**, the run report re-derives the same enumeration from the committed
  contract and renders a **Gates in force** markdown section (Enforced / Not
  contracted / warnings). If the contract is absent or invalid at finalize, the
  section renders that fact **loudly** rather than omitting it.

## The gates

| Gate       | Checks                                                                                                                                                                                                                                         | Fail-closed when                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test`     | The vitest-runnable changed test files pass (diff-scoped). Pure non-JS/non-runnable test sets (pgTAP, Go, `.d.ts`…) are **skipped** (not applicable — execution-only gate, `tdd` owns existence).                                              | Runnable tests fail or cannot run.                                                                                                                                              |
| `tdd`      | Tests precede implementation on the pre-squash task branch (test-before-impl commit ordering).                                                                                                                                                 | An impl commit lands with no preceding failing-test commit. Memoized by tip SHA; a no-op on squashed history.                                                                   |
| `coverage` | Measures head (task worktree) and base (ephemeral detached worktree) with vitest's json-summary coverage reporter; no metric (`lines`, `branches`, `functions`, `statements`) regressed by more than `quality.coverageRegressionTolerancePct`. | Either measurement fails (command error, summary missing/invalid), the base ref is unresolvable, or no coverage command is derivable from a non-vitest test command. See below. |
| `mutation` | Mutation score (derived in-engine from the stock json report's per-file mutants) meets `quality.mutationScoreTarget`.                                                                                                                          | Score below target, or no score is derivable from a present report (non-empty scope).                                                                                           |
| `sast`     | Static security analysis (built-in semgrep or `quality.securityCommand`) finds no blocking issue.                                                                                                                                              | Findings present (unless `quality.securityAllowFailures`).                                                                                                                      |
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

**Measurements persist per tree SHA** at `runs/<run-id>/coverage/<treeSha>.json`
(a perf cache only — never a correctness fallback; verdicts are re-derived every
sweep). Because keys are content-addressed, the post-squash staging tree equals
the shipped head tree, so later tasks in the run are served from the store instead
of re-running the suite.

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
  Ruby, Deno…), contract the test gate's `command` in the repo's committed
  `.factory/gates.json` (Decision 46) rather than bypassing enforcement.

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
- **The Stryker config is shadow-proof.** TCB write-protection covers **every**
  basename Stryker's discovery can load (the full `{'',.'} × {.conf,.config} ×
{json,js,mjs,cjs}` set), not just the scaffolded `.stryker.config.json`. An
  implementer therefore cannot create an unprotected sibling (e.g. `stryker.config.mjs`
  — executable JS that would run inside the gate process) to shadow or weaken the
  gate config. The protected set and the gate's applicability set are both derived
  from one list (`src/shared/gate-config-names.ts`) with a drift-guard test.

## Beyond the deterministic gates

The deterministic gates are only the first layer of the merge gate. The merge gate
also records in **holdout validation** (a withheld answer-key, validated
independently) and the **risk-invariant review panel** (a four-reviewer floor,
unanimous approval required, with verify-then-fix confirmation of each blocking
finding). The overall merge gate is the subject of
[../explanation/verifier.md](../explanation/verifier.md).

A fifth **content-conditional** reviewer, `database-design-reviewer`, is appended to
the panel only when the task diff touches relational-schema files — migrations,
`*.sql`, or ORM schema (`touchesDatabase`, `src/verifier/judgment/db-detect.ts`;
[Decision 51](../explanation/decisions.md)). It is strictly additive: the four-lens
floor always runs, and a DB-touching task gets floor + specialist. The trigger is diff
_content_, not risk tier, so it does not weaken risk-invariance.

The expected panel roster is enforced at the record seam: an all-approve **subset** of
it can no longer clear the gate. `enforcePanelRoster` (`src/orchestrator/record.ts`)
takes the re-derived roster (`panelRolesFor` — the `PANEL_ROLES` floor plus the
conditional specialist), synthesizes a `verdict:"error"` review for every roster entry
missing from the supplied `--results`, and demotes any unknown reviewer name to `error`
— either failing the unanimity conjunction loudly. The cross-vendor reviewer is an
**executor of a roster role** (e.g. quality-reviewer via Codex), never an extra reviewer
name, so it stays additive to the roster — supplying it never changes the required
roles. Its
_availability_ is policy-gated separately: `review.requireCrossVendor: "block"` (default
`warn`) fails the gate when no cross-vendor reviewer ran, by demoting the quality-reviewer
to `verdict:"error"` ([Decision 44](../explanation/decisions.md#decision-44--verifier-upgrades-grep-rescue-claim-only-verification-real-cross-vendor)).
(`/factory:debug`'s whole-scope `runPanel` is deliberately outside this
check — it is not a task merge gate.)
</content>
