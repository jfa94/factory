# codex-adversarial — raw output (2026-06-30T12-22-21Z)

**Verdict:** needs-attention

**Summary:** No-ship: workflow-mode blocking E2E findings can be bypassed on the next resume, and generated E2E CI can use the wrong package manager for common explicit setup commands.

## [high / conf 0.88] scripts/factory-run-runner.js:618-630 — Workflow E2E blocker is only returned to the runner, not persisted in run state

When the semantic sweep returns `recommendation === "fix-forward"`, the workflow runner returns `{suspended:true}` but does not write any blocking/suspended state. `runE2eRecord` has already persisted `e2e_sweep.status = "done"` for the same result, and `nextTask` skips future sweeps whenever that marker is done. A user or automation that resumes/continues the run after this workflow return will go straight to docs/finalize and can merge the rollup with known blocking money-path failures. This is an inference across the shown paths: the only durable mutation for the non-error result is the `done` marker, while the workflow suspension is just the script return value.

**Recommendation:** Make a workflow-mode fix-forward result durable before stopping: either have `factory run e2e --results` persist a state that `nextTask` refuses to advance past until explicit adjudication/fix-forward is recorded, or do not mark `e2e_sweep` as done for workflow blocking findings. Add a workflow resume test that proves a fix-forward sweep cannot proceed to finalize unchanged.

## [medium / conf 0.76] src/cli/subcommands/scaffold.ts:348-357 — E2E scaffold misdetects package manager for explicit setup commands

`resolveE2eInstall` lets an explicit `quality.setupCommand` win, then infers the package manager only with `appInstall.startsWith("pnpm")` / `startsWith("yarn")`. Common valid commands such as `corepack enable && pnpm install --frozen-lockfile`, `corepack pnpm install`, or a wrapper script in a pnpm repo fall through to `npm`, so the generated workflow runs the app install with pnpm/yarn but installs `@playwright/test` with `npm i -D`. That can fail in CI or mutate the wrong lockfile/package-manager state, leaving the newly scaffolded E2E gate broken.

**Recommendation:** Determine the E2E package manager from lockfiles or an explicit config value independent of the arbitrary setup command string; if parsing setupCommand, tokenize or match command words rather than prefix-only checks. Cover `corepack ... pnpm` and wrapper-command cases in scaffold tests.

## next_steps

- Fix the durable workflow blocking state before shipping the semantic sweep.
- Harden package-manager detection for generated E2E workflows.
