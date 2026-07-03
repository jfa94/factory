# codex-adversarial — branch diff vs 8f2614a

Verdict: needs-attention

Summary: No ship: the new semantic E2E scaffold breaks documented opt-in configurations, so generated durable CI will not reliably run the money-path specs it creates.

## Findings (2)

### [medium · conf 0.91] src/cli/subcommands/scaffold.ts:490-507 — Unauthenticated semantic sweeps generate CI that always requires auth
- body: The config contract allows `e2e.semantic` with no `authSetupCommand` and tells the sweep to drive unauthenticated/signup paths, but scaffold always injects a `setup` project, makes every `semantic-*` project depend on it, and forces `storageState`. The generated `auth.setup.ts` then fails when no auth command or E2E credentials exist, so a valid unauthenticated semantic setup produces a permanently failing nightly suite before any authored signup/public specs run.
- rec: Only add the setup dependency and `storageState` when auth is configured, or require auth at config-parse time when `e2e.semantic` is enabled. For unauthenticated mode, generate semantic projects that run without the setup project.

### [medium · conf 0.88] templates/ci/e2e-nightly.yml:25-29 — Committed semantic specs are not replayed with the configured seed command
- body: `e2e.seedCommand` is passed to the in-pipeline authoring sweep, so authored specs can depend on seeded fixtures, but the generated nightly workflow only installs deps/browsers and runs `npx playwright test`. It never runs the seed command before replaying the committed semantic suite, making durable CI non-reproducible: tests that passed during the sweep can fail nightly against an unseeded database, or worse, exercise stale/shared data instead of the intended fixtures.
- rec: Add a scaffold-injected seed step before `npx playwright test` when `e2e.seedCommand` is configured, using the same command passed to the sweep, or require semantic specs to self-seed and remove the runner-only seed knob.

## next_steps
(none)
