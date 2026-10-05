# Configuration Schema

> Historical v1 reference. Its execution and recovery instructions do not apply
> to v2. Start with [the current architecture](../architecture/overview.md) and the
> current CLI/runner protocol linked there.

All configuration lives in one Zod schema, `src/config/schema.ts`, where every
field carries a default. `ConfigSchema.parse({})` yields a complete, typed config,
so a missing config file is equivalent to all-defaults. Inspect and edit the
overlay with `factory configure` (see [cli.md](./cli.md)); print the resolved
config with `factory config-defaults`.

Edits are persisted as a **sparse overlay** — only the keys you set are written,
so unset keys continue to track future default changes.

Key paths are dotted (e.g. `quality.mutationScoreTarget`, `git.baseBranch`).

## Data dir (`CLAUDE_PLUGIN_DATA`)

Run/spec state lives OUTSIDE the target repo, under the data dir resolved by
`resolveDataDir()` (`src/config/load.ts`). The canonical dir for this install is:

```
~/.claude/plugins/data/factory-jfa94
```

`factory-<marketplace-id>`, where `jfa94` is this marketplace's id
(`.claude-plugin/marketplace.json` `name`). Production callers set it via the
`CLAUDE_PLUGIN_DATA` env var; if it is unset, state-using commands loud-fail with
a message pointing at the `factory-<your-marketplace-id>` form.

### The foreign-plugin leak (benign, self-corrected)

Another plugin (e.g. `codex`) can set `CLAUDE_PLUGIN_DATA` to **its own** data dir
(under `~/.claude/plugins/data/`). The source of the leak is outside factory's
control. Factory self-corrects: when `CLAUDE_PLUGIN_DATA` points at a foreign
plugin's dir, `resolveDataDir()` derives the canonical `factory-jfa94` dir (from
the cache-install layout, falling back to `marketplace.json`) and uses that
instead — so state is never written into another plugin's dir.

A **successful** redirect emits a **single DEBUG notice per distinct redirect per
process** (keyed on the `current → corrected` pair; `resolveDataDir()` is called
~20×/command, so the notice is deduplicated rather than spammed). It was demoted
from WARN to DEBUG (Fix 8): a self-correcting redirect is benign, so it no longer
clutters normal output — only a **real** problem inside the expected data dir (an
unparseable `marketplace.json`) still emits a WARN. The notice states that another
plugin set the var, that factory auto-redirected to its canonical dir, that no
action is required for correctness, and — if you want to silence it permanently —
to set `CLAUDE_PLUGIN_DATA` to factory's own `factory-<your-marketplace-id>` dir.
The redirect **behavior** is unconditional and unaffected by the notice
rate-limiting.

Why the leak happens, why it is benign, and why the notice repeats across
commands is explained in
[the plugin-data-dir explanation](../explanation/plugin-data-dir.md).

## `quality`

Quality-gate thresholds.

| Key                              | Type                  | Default | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mutationScoreTarget`            | number 0–100          | `80`    | Target mutation score (%) for the mutation gate.                                                                                                                                                                                                                                                                                                                                                                              |
| `coverageRegressionTolerancePct` | number ≥0             | `0.5`   | Allowed coverage regression (percentage points) before the gate fails.                                                                                                                                                                                                                                                                                                                                                        |
| `securityCommand`                | string (optional)     | —       | Custom SAST/security command; else the built-in semgrep run.                                                                                                                                                                                                                                                                                                                                                                  |
| `securityAllowFailures`          | boolean               | `false` | Treat security findings as non-blocking.                                                                                                                                                                                                                                                                                                                                                                                      |
| `securityRedactFindings`         | boolean               | `true`  | Redact secrets from the persisted findings artifact.                                                                                                                                                                                                                                                                                                                                                                          |
| `setupCommand`                   | string (optional)     | —       | Per-worktree env-prep command run once in the new task worktree, BEFORE the test/type/build gates. When unset, a lockfile is auto-detected (`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --frozen-lockfile`, `package-lock.json`/`npm-shrinkwrap.json` → `npm ci`); no lockfile is a no-op. Set this for non-JS repos or custom setups. Fails the run LOUD at preflight on non-zero exit. |
| `gateEnv`                        | record<string,string> | `{}`    | Name→value env vars injected into **every** deterministic gate command (`build`/`test`/`type`/`lint`/`mutation`/`security`), merged over `process.env`. Mirrors the repo's CI build-step env so the gate measures the code, not a missing-env crash. **Placeholders only — not a secret store.** See [the gate-env note](#gateenv--ci-parity-placeholders) below.                                                             |

### `gateEnv` — CI-parity placeholders

The deterministic gates run in a **fresh task worktree** with no `.env.local` and no
build-time env injection. A repo whose CI supplies placeholder env vars for the same
build step — e.g. a Next.js static prerender that needs `NEXT_PUBLIC_*` defined — would
otherwise fail the `build` gate on a missing-env crash, a **false-negative floor**
unrelated to task quality. `quality.gateEnv` closes that gap: its name→value map is
merged over `process.env` into the spawn env of every gate command
(`defaultGateTools(gateEnv)`, `src/verifier/deterministic/tools.ts`, wired from config in
`src/feature/runtime.ts`).

**Setting values.** Mirror your CI build-step env by setting each leaf individually:

```bash
factory configure --set quality.gateEnv.NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
factory configure --set quality.gateEnv.NEXT_PUBLIC_SUPABASE_KEY=ci-placeholder
```

The schema requires **string** values whose keys are valid POSIX env names
(`z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())`) — an explicit "set this var"
with a usable name. A purely numeric value is JSON-coerced to a number at the `--set` boundary
and rejected, so quote it as JSON: `--set quality.gateEnv.PORT='"54321"'`.

**One config, both gates.** `quality.gateEnv` is the single source of truth for build-env parity in
**both** directions: the local merge gate merges it over `process.env` for every gate command, and
`factory scaffold` injects it into the managed `quality-gate.yml` it renders — `injectGateEnvIntoWorkflow`
(`src/ci/inject-gate-env.ts`) replaces the `# factory:gate-env` marker following the rendered build
step with a real `env:` block built from the resolved map. So editing `quality.gateEnv` (then
re-scaffolding) keeps the local gate and the repo's GitHub CI in lockstep; an empty map leaves the
marker untouched, and a re-scaffold is byte-identical (idempotent).

This is **CI parity, not secrets**: these placeholders sit in the sparse config overlay in
plaintext. Never put a real credential here — they exist only so the merge gate
exercises the same build CI does.

## `quota`

The two-window quota pacer.

| Key                | Type      | Default                  | Meaning                                                                                                                                                                                                                                                 |
| ------------------ | --------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hourlyThresholds` | number[5] | `[20,40,60,80,90]`       | 5h-window utilization caps by hour 1..5 (%).                                                                                                                                                                                                            |
| `dailyThresholds`  | number[7] | `[20,40,60,80,95,95,95]` | 7d-window utilization caps by day 1..7 (%). Ramps to 95% by window-day 5 (a 5-workday spend pattern) then plateaus through days 6–7, leaving a 5% end-of-window reserve. "Window-day N" is a position in the rolling 7d window, not a calendar weekday. |

Each `hourlyThresholds` / `dailyThresholds` element is validated as a percentage in
`[0, 100]`, and the array as a whole must be **non-decreasing** (a later checkpoint may
not cap lower than an earlier one) — an out-of-range or descending value is a loud config
error, never persisted.

## `spec`

The spec-build pipeline.

| Key                   | Type     | Default | Meaning                                                                          |
| --------------------- | -------- | ------- | -------------------------------------------------------------------------------- |
| `passReviewThreshold` | int 0–60 | `56`    | The single spec-review pass threshold out of 60.                                 |
| `dimensionFloor`      | int 0–10 | `5`     | Any rubric dimension scoring `≤` this forces NEEDS_REVISION regardless of total. |
| `maxRegenIterations`  | int >0   | `5`     | Max generate ⇄ review revision iterations before a loud give-up.                 |
| `prdBodyMaxBytes`     | int >0   | `65536` | Max bytes of PRD body retained before truncation.                                |

The Decision-21 apex pin (the model/effort the spec generator AND reviewer run at)
is deliberately **not** a config key: it is an _unconditional_ pin, hard consts in
`src/spec/agents.ts` — invariant by construction.

## `git`

Branch and protection contract.

| Key                           | Type     | Default                                            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | -------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseBranch`                  | string   | `develop`                                          | The durable integration base: the feature branch forks from it and its PR targets it. Scaffold protects this branch. Never `main`.                                                                                                                                                                                                                                                                                                                                    |
| `developRequiredStatusChecks` | string[] | `["Quality", "Mutation Testing", "Security Scan"]` | Status checks scaffold and run preflight require on `develop` (provisioned with scaffold `--provision`). Defaults to the three contexts the rendered quality-gate workflow always reports (Decision 53), so the feature PR cannot merge red. A repo's committed `.factory/gates.json` can add extra contexts via `requiredChecks` (additive-only) — see [per-repo required checks](automated-gates.md#per-repo-required-checks-requiredchecks-requiremutationatrest). |
| `rollupCiWaitMinutes`         | int >0   | `30`                                               | Outer bound (minutes) the engine waits for the feature PR's required CI and merge before parking the run (`ci`). Sized above the slowest expected quality-gate run (mutation on a cold cache); work is preserved and resume rechecks. Replaces the former hard-coded ~20-min bound ([Decision 75](../explanation/decisions.md#decision-75--mutation-ci-redesign-develop-only-warm-base-incremental-hash-shards-roots)).                                               |

## Retired keys

The following bash-era keys are deliberately **absent** and must not be carried
forward (human-review gates are retired — Decision 5/19; the review-depth axis was
removed — Decision 25): `humanReviewLevel`, `NEEDS_DISCUSSION`, the exit-42 code,
and the per-tier review caps.

These schema keys were removed because they were **never actually consumed**. Zod
strips an unknown key silently, so `loadConfig` warns loudly (once per process per
file) when a raw overlay still carries one:

| Retired key         | Why it is gone                                                                                                                                                     | Replacement                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `git.stagingBranch` | Every consumer read the schema default, never a set value — there is no shared staging branch. The real branch is per-run `staging-<run-id>` (`runStagingBranch`). | none needed (the prefix is a constant)               |
| `e2e.testDir`       | A `superRefine` already rejected every non-default value, so the knob could only ever hold `e2e`. Both the template and the TCB write-guard hardcode that path.    | the literal `e2e` path in the template and TCB guard |

Keys retired with v1 execution are ignored silently when an existing overlay still
carries them: `quality.holdoutPercent`, `quality.holdoutPassRate`,
`quota.producerModels`, the `review`, `codex` and `e2e` blocks,
`git.stagingRequiredStatusChecks`, `git.provision`, `git.branchPrefix`,
`git.developProtection`, `maxConsecutiveFailures`, `maxParallelTasks`,
`stallTtlMinutes` and `hungSpawnMinutes`.

Remove the warned keys from your overlay:

```bash
factory configure --unset git.stagingBranch
factory configure --unset e2e.testDir
```
