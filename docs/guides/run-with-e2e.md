# How to Run with End-to-End Tests

This guide adds an autonomous Playwright end-to-end (e2e) phase to a run. The unit
gates (vitest, TDD, coverage, mutation, SAST, type, lint) verify each task in
isolation; they cannot catch a feature that breaks only once every task's change is
integrated. The e2e phase authors and runs journey tests against the **integrated
staging app** after all tasks are terminal, and reopens the task responsible for any
failing journey. It assumes you already know how to [run the pipeline](./run-the-pipeline.md).

For the design rationale (criticality-by-persistence, the fail-first proof, the reopen
cadence), see [Decision 39](../explanation/decisions.md#decision-39--e2e-is-a-run-level-engine-phase-criticality-is-persistence-not-a-tag).
For the config keys and CLI surface, see [configuration](../reference/configuration.md#e2e)
and [`run e2e`](../reference/cli.md#run-e2e).

## Prerequisites

- The target repo is scaffolded (`playwright.config.ts` + `e2e/example.spec.ts` are
  seeded by `factory scaffold`; see [Scaffold a target repo](./scaffold-a-repo.md)).
- `@playwright/test` is a devDependency of the target repo. Scaffold seeds the config,
  not the dependency — install it yourself. The runner refuses the `npx` fallback: a
  missing local `node_modules/.bin/playwright` fails the phase loud.
- The app can be booted headlessly by a single command.

## 1. Configure the app boot (once per repo)

The e2e phase boots the app itself; it needs a start command and the URL it serves.
Both are **required** — an `--e2e` run with either unset **suspends** the phase (loud,
resumable) rather than skipping it silently.

```bash
factory configure --set e2e.startCommand="npm run dev"
factory configure --set e2e.baseURL="http://localhost:3000"
```

Set these to the SAME values as `playwright.config.ts`'s `webServer.command` / `baseURL`
so a local `playwright test` and the run-level phase boot the app identically. The
scaffolded `webServer` block is **env-driven**: the phase passes `FACTORY_E2E_START_COMMAND`
(falls back to `npm run dev`), `BASE_URL`, and `FACTORY_E2E_READY_TIMEOUT_MS` into every
Playwright invocation, plus `FACTORY_E2E=1` — which forces `reuseExistingServer: false` so a
factory-driven run always boots a fresh app. Playwright's own `webServer` owns the boot,
readiness poll, and teardown; the engine does not run a separate process manager. `baseURL`
is validated as a well-formed URL at config time. Optional tuning
([full key table](../reference/configuration.md#e2e)):

- `e2e.testDir` (default `e2e`) — the repo-relative directory the committed critical
  suite lives in. It is **schema-locked to `e2e`**: the config parser rejects any other
  value, because the scaffolded `playwright.config.ts`, the CI `quality-gate.yml`, and the
  TCB write-guard all hardcode that path.
- `e2e.readyTimeoutMs` (default `30000`) — how long to wait for the app to boot.
- `e2e.reopenCap` (default `2`) — how many times a task may be reopened by a still-red
  critical journey before the run fails outright.

## 2. Start the run with `--e2e`

```
/factory:run --repo <owner/name> --issue <N> --e2e
```

`--e2e` is **create-only and immutable**, exactly like `--workflow` / `--no-ship`: it is
persisted on the run at creation and cannot be added, removed, or changed on resume.
Passing `--e2e` together with `--resume` is rejected loud — a resumed run keeps the
`e2e` setting it was born with. It combines freely with `--workflow`, `--no-ship`, and
`--ignore-quota`.

## 3. What the e2e phase does

Once every task is terminal and the run would complete, `factory next-task` schedules the
e2e stage **before** documentation (don't document code the e2e verdict is about to
change). The runner steps [`factory run e2e`](../reference/cli.md#run-e2e):

1. **Author (once per run).** The `e2e-author` agent boots the app, explores each
   user-facing task via the Playwright MCP tools, and writes two kinds of spec —
   distinguished only by **where they land**:
   - **Critical** specs (committed into the repo's `e2e.testDir`) — thin, journey-oriented,
     load-bearing. They gate this run, every future `--e2e` run, and the repo's CI (the
     `e2e` job scaffold adds to `quality-gate.yml`).
   - **Throwaway** specs (an out-of-repo run directory, never committed) — one per
     user-facing task, broader coverage, discarded at run end.

   The author returns a manifest linking each spec to the `task_id`(s) it covers — the
   only join the engine has from a failing spec back to its task.

2. **Manifest + trust-boundary checks.** The author branch is merged **unreviewed**, so
   before spending the fail-first proof the engine validates the returned manifest: every
   `spec_path` is rejected if it is absolute or contains `..`, and every `task_id` must
   exist in `run.tasks` (an unknown id fails loud instead of silently vanishing at reopen
   time). Two location rules then bound what can land, with `<testDir>/` (e.g. `e2e/`) as
   the single allowed area:
   - Every **`critical`** manifest entry's `spec_path` must itself start with `<testDir>/`.
     A critical entry declared at the repo root (or anywhere outside `testDir`) is rejected —
     otherwise a spec could merge an unreviewed file into application source just by
     self-declaring as "critical".
   - The engine diffs the author branch against staging by name and rejects **any** changed
     path outside `<testDir>/`. Throwaway specs live out-of-repo (never committed, so never
     in this diff), so the only files a legitimate author branch touches are critical specs
     under `<testDir>/` — the single rule "only files under `<testDir>/` may change" needs no
     per-file manifest allowlist. A stray edit to application source aborts the phase rather
     than landing unreviewed.

   Authored specs also execute under a **scrubbed, allowlisted environment** (only
   `PATH`/`HOME` plus the `FACTORY_E2E_*`/`BASE_URL` boot vars — never the parent process's
   full `process.env`), so an autonomously-authored spec can't reach ambient CI tokens or
   cloud credentials.

3. **Fail-first proof (critical specs only).** Before any critical spec is merged, the
   engine runs it twice: once against the **unmodified base branch** (its `control:`
   assertion must pass — proving the app booted — while every journey assertion fails —
   proving the feature didn't exist yet) and once against **staging with the feature**
   (everything must pass). A spec that already passes on base is rejected as vacuous; one
   whose control fails on base is rejected as "base unusable". Only proven specs are
   merged into `staging-<run-id>`. This stands in for the human review an
   autonomously-authored assertion never gets. The base-side proof runs in a scratch
   worktree that is `npm ci`-provisioned just like a task worktree.

4. **Run the suite + decide.** The full suite runs against current staging — the committed
   critical specs, plus the throwaway specs (which **do** run, via a generated `--config`
   pointing `testDir` at the out-of-repo throwaway dir with `cwd` set to the run worktree).
   The run worktree is re-synced to staging and `npm ci`-provisioned on every pass. The
   disposition:
   - **Every critical spec present and green** → the phase passes; a residual throwaway red
     becomes an advisory line in the report, not a blocker. The run proceeds to docs, then
     finalize. A critical spec counts as green only if it appears in the results as
     `passed` or `flaky` — one that is **absent, `failed`, or `skipped`** is a miss that
     reopens its task (no longer treated as a silent pass).
   - **A mappable failure** → the task(s) it covers are reopened (reset to `pending`
     carrying the failure as `e2e_feedback`) and re-driven through the normal phase
     machine. The run **stays `running`** — the e2e phase never marks the run itself
     failed or complete. Once the reopened tasks settle back to terminal, the phase
     re-fires (re-running the existing suite, not re-authoring it). Pass 1 reopens for any
     mappable failure (critical miss or throwaway red); pass 2+ reopens only for critical.
   - **A tooling failure** (nonzero Playwright exit / reporter `errors[]` with no individual
     spec marked failed — e.g. the app never booted) fails the run outright rather than
     being silently absorbed into a green suite or attributed to an arbitrary task. This is
     checked for **both** suites: a broken **critical** run always fails the phase, and a
     broken **throwaway** run fails it too **on pass 1** (mirroring the critical check).
     On pass 2+ — where the throwaway tier is already non-gating (Decision 8) — a throwaway
     tooling failure no longer fails the run but is **folded into the advisory line** rather
     than silently dropped.
   - Playwright's own **flaky** classification (fail then pass on retry) never reopens.

## 4. Read the outcome

The e2e phase is not a terminal state — it feeds the normal run outcome (see
[Run the pipeline § Read the outcome](./run-the-pipeline.md#4-read-the-outcome)). It ends
the run's e2e contribution in one of:

- **Pass** — every critical journey green; the committed critical suite ships with the
  rollup and keeps gating future runs and CI. Any throwaway red is reported as advisory.
- **Fail** — the run finalizes `failed` when a critical journey exhausts `e2e.reopenCap`,
  a critical failure is **unmappable** (no manifest entry names the failing spec), a
  **tooling failure** occurs on either suite (nonzero exit / reporter `errors[]` with no spec
  marked failed — the throwaway one only gates on pass 1), the manifest references an unknown
  `task_id` or an unsafe `spec_path`, a `critical` spec_path lands outside `testDir`, the
  author branch touches any path outside `testDir`, the fail-first proof rejects a spec, or
  the e2e-author returns a non-`DONE` status. There is deliberately no re-author retry loop.
  On a failed e2e phase the docs and rollup steps are skipped. A failed verdict is **not
  permanent**, though: `factory rescue apply --reset-e2e` clears the concluded verdict so the
  phase re-enters and re-runs on the next pass. The clear is **manifest-aware**: a phase that
  failed **after** authoring keeps its manifest and per-task reopen counts (the author is not
  re-invoked); a phase that failed **before** a manifest was ever authored (empty manifest —
  e.g. the author crashed or returned an unsafe path) is cleared **entirely**, so the next
  pass genuinely re-spawns the author instead of settling to a false "done" with zero e2e
  coverage. This is never automatic — `factory rescue scan` reports it as
  `e2e_failed: true` (folded into `needs_rescue` even when every task is `done`), but `apply`
  clears it only when `--reset-e2e` is explicitly passed, once the underlying cause (flaky
  infra, an app bug, a since-fixed reopen-cap exhaustion) no longer applies. Plain `resume`
  does not clear it — it only re-checks the quota gate.
- **Suspend** — `e2e.startCommand` / `e2e.baseURL` were not configured. Configure them
  (step 1) and resume:

  ```
  /factory:resume [--run <id>]
  ```

## Limitations

- `debug`'s e2e integration (`--full-e2e`, folding e2e results into a report → spec →
  re-review loop) is **not built** — the deferred item in
  [Decision 39](../explanation/decisions.md#decision-39--e2e-is-a-run-level-engine-phase-criticality-is-persistence-not-a-tag).
  The e2e runner, author, and manifest contract are consumer-agnostic so debug can become
  a second consumer later, but today the only consumer is `factory run --e2e`.
- The TCB `e2e-suite` write-guard covers only the literal `e2e/` directory; a repo that
  moves `e2e.testDir` elsewhere is not protected (see
  [Configuration § e2e](../reference/configuration.md#e2e)).
