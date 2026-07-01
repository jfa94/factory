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
so a local `playwright test` and the run-level phase boot the app identically. Optional
tuning ([full key table](../reference/configuration.md#e2e)):

- `e2e.testDir` (default `e2e`) — the repo-relative directory the committed critical
  suite lives in. **Leave it at the default** unless you have a reason to move it: the
  TCB write-guard is hardcoded to the literal `e2e` path, so a custom `testDir` loses
  the implementer-write-deny on committed specs.
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

2. **Fail-first proof (critical specs only).** Before any critical spec is merged, the
   engine runs it twice: once against the **unmodified base branch** (its `control:`
   assertion must pass — proving the app booted — while every journey assertion fails —
   proving the feature didn't exist yet) and once against **staging with the feature**
   (everything must pass). A spec that already passes on base is rejected as vacuous; one
   whose control fails on base is rejected as "base unusable". Only proven specs are
   merged into `staging-<run-id>`. This stands in for the human review an
   autonomously-authored assertion never gets.

3. **Run the suite + decide.** The full suite (critical + throwaway) runs against current
   staging. The disposition:
   - **No critical red** → the phase passes; a residual throwaway red becomes an advisory
     line in the report, not a blocker. The run proceeds to docs, then finalize.
   - **A mappable spec is red** → the task(s) it covers are reopened (reset to `pending`
     carrying the failure as `e2e_feedback`) and re-driven through the normal phase
     machine. The run **stays `running`** — the e2e phase never marks the run itself
     failed or complete. Once the reopened tasks settle back to terminal, the phase
     re-fires (re-running the existing suite, not re-authoring it). Pass 1 reopens for any
     mappable failure; pass 2+ reopens only for critical failures.
   - Playwright's own **flaky** classification (fail then pass on retry) never reopens.

## 4. Read the outcome

The e2e phase is not a terminal state — it feeds the normal run outcome (see
[Run the pipeline § Read the outcome](./run-the-pipeline.md#4-read-the-outcome)). It ends
the run's e2e contribution in one of:

- **Pass** — every critical journey green; the committed critical suite ships with the
  rollup and keeps gating future runs and CI. Any throwaway red is reported as advisory.
- **Fail** — the run finalizes `failed` when a critical journey exhausts `e2e.reopenCap`,
  a critical failure is **unmappable** (no manifest entry names the failing spec), the
  fail-first proof rejects a spec, or the e2e-author returns a non-`DONE` status. There is
  deliberately no re-author retry loop. On a failed e2e phase the docs and rollup steps
  are skipped.
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
