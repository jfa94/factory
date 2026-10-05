# How to Run with End-to-End Tests

Add `--e2e` to a run to have an `e2e-author` agent write a small committed
Playwright suite for the feature's user journeys, and to require that suite to
pass at the feature check. This guide assumes you already know how to
[run the pipeline](./run-the-pipeline.md).

## 1. Prepare the repository

1. Add `@playwright/test` as a dependency or devDependency of the target repo.
   Scaffold never installs packages.
2. Re-run `factory scaffold`. With `@playwright/test` declared, it seeds
   `playwright.config.ts` and `e2e/example.spec.ts` when they are missing. Without
   it, scaffold logs that it is not seeding them.
3. Fill in the seeded config's `webServer.command` with the app's start command,
   or leave it for the `e2e-author` to configure. Keep `testDir` as `./e2e`: the
   write-protection hook guards only the literal `e2e/` directory.
4. Make sure `pnpm exec playwright test` works in the repo. The feature check runs
   exactly that command.

## 2. Start the run

```text
/factory:run --issue <N> [--repo <owner/name>] --e2e
```

`--e2e` is set at `run create` and persisted on the run. It combines with
`--no-ship`, `--local` and `--ignore-quota`.

## 3. What happens

1. Tasks, slices and the `docs` stage run as usual.
2. After `docs`, the run enters the `e2e-author` stage. The agent works in the
   feature worktree, explores the running app through the Playwright MCP tools
   (or falls back to the acceptance criteria and code), and commits a few
   journey specs under `e2e/`. Each spec has one `control:` assertion that passes
   whenever the app boots, so "app did not start" is distinguishable from "feature
   is broken".
3. The run moves to `feature-check`. Besides the usual feature gates, it runs
   `pnpm exec playwright test --reporter=json` in the feature worktree. The check
   passes only when the command exits 0 and the report shows at least one expected
   test, no unexpected results and no skipped tests.
4. A failing feature check takes a feature-scope repair pass like any other gate
   failure. Feature review and acceptance then run on the result.

## 4. Handle an `e2e-author` park

If the agent reports `spec-defect` (the spec describes a journey the feature cannot
expose), the engine takes a spec-repair pass; no action is needed.

A `needs-context` question from the `e2e-author` (environment, credentials,
intended behaviour) goes to spec repair, which makes the spec decide. Only a
question the spec generator cannot answer parks for
`factory resume --run <id> --answer "..."`.

The `e2e-author` parks the run instead of committing specs when it reports
`blocked` three times in a row (the engine re-issues it twice first):

- Playwright or the app cannot be made to run. Fix the
  environment, then `factory resume --run <id>`;
- no task is user-facing: status `blocked` with the message "--e2e requested but
  the feature has no user-facing surface; rerun without --e2e". Start a new run
  without `--e2e`.

See [resume a feature](./rescue-a-stalled-run.md) for recovery details.
