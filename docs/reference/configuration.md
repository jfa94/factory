# Configuration Schema

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

Resolution order:

| Order | Source               | Behaviour                                                                                                 |
| ----- | -------------------- | --------------------------------------------------------------------------------------------------------- |
| 1     | Explicit override    | A non-empty `dataDir` option passed to `resolveDataDir()` is used as-is (resolved to an absolute path).   |
| 2     | `FACTORY_DATA_DIR`   | When non-empty, used as-is (resolved to an absolute path). No foreign-plugin canonicalization is applied. |
| 3     | `CLAUDE_PLUGIN_DATA` | Subject to the foreign-plugin canonicalization below; loud failure when unset (see above).                |

`factory autonomy ensure` bakes both `FACTORY_DATA_DIR` and `CLAUDE_PLUGIN_DATA`
(the canonical dir) into the autonomous settings `env`. An empty
`FACTORY_DATA_DIR` is treated as unset.

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

| Key                              | Type                  | Default | Meaning                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mutationScoreTarget`            | number 0–100          | `80`    | Target mutation score (%) for the mutation gate.                                                                                                                                                                                                                                                                                                                                                         |
| `coverageRegressionTolerancePct` | number ≥0             | `0.5`   | Allowed coverage regression (percentage points) before the gate fails.                                                                                                                                                                                                                                                                                                                                   |
| `securityCommand`                | string (optional)     | —       | SAST command for the `sast` gate, validated against a token and runner allowlist. Unset: the gate is skipped and scaffold records it as uncontracted.                                                                                                                                                                                                                                                    |
| `securityAllowFailures`          | boolean               | `false` | Treat security findings as non-blocking.                                                                                                                                                                                                                                                                                                                                                                 |
| `securityRedactFindings`         | boolean               | `true`  | Redact secrets from the scanner output recorded in gate evidence.                                                                                                                                                                                                                                                                                                                                        |
| `setupCommand`                   | string (optional)     | —       | Provisioning command run in each new feature worktree and review snapshot before any gate. When unset, a lockfile is auto-detected (`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --frozen-lockfile`, `package-lock.json`/`npm-shrinkwrap.json` → `npm ci`); no lockfile is a no-op. A failure is treated as transient: retried, then the run parks as `environment`. |
| `gateEnv`                        | record<string,string> | `{}`    | Name→value env vars rendered into the managed `quality-gate.yml` and merged into local gate commands. **Placeholders only — not a secret store.** See [the gate-env note](#gateenv--ci-parity-placeholders).                                                                                                                                                                                             |

### `gateEnv` — CI-parity placeholders

A repo whose CI supplies placeholder env vars for a build step (for example a
Next.js static prerender that needs `NEXT_PUBLIC_*` defined) declares them here.
`factory scaffold` renders the map into the managed `quality-gate.yml`.

**Setting values.** Mirror your CI build-step env by setting each leaf individually:

```bash
factory configure --set quality.gateEnv.NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
factory configure --set quality.gateEnv.NEXT_PUBLIC_SUPABASE_KEY=ci-placeholder
```

The schema requires **string** values whose keys are valid POSIX env names
(`z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())`) — an explicit "set this var"
with a usable name. A purely numeric value is JSON-coerced to a number at the `--set` boundary
and rejected, so quote it as JSON: `--set quality.gateEnv.PORT='"54321"'`.

**Rendering.** `injectGateEnvIntoWorkflow` (`src/ci/inject-gate-env.ts`) replaces
the `# factory:gate-env` marker following the rendered build step with an `env:`
block built from the resolved map. Re-run `factory scaffold` after editing the map.
An empty map leaves the marker untouched, and a re-scaffold is byte-identical.

**Local gates.** The v2 feature runtime merges the map over `process.env` for every
local gate command (`defaultGateTools(gateEnv)`), so local and CI builds see the
same placeholders.

This is **CI parity, not secrets**: these placeholders sit in the sparse config overlay in
plaintext and in the committed workflow. Never put a real credential here.

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

| Key                           | Type     | Default                                            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | -------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `baseBranch`                  | string   | unset                                              | The integration base: the feature branch forks from it, its PR targets it, and scaffold protects it. Unset resolves per command and is never saved: `develop` when origin has it, else origin's default branch. An explicit value must exist on origin.                                                                                                                                                                                                                                                                        |
| `developRequiredStatusChecks` | string[] | `["Quality", "Mutation Testing", "Security Scan"]` | Status checks required on the resolved base branch. Scaffold `--provision` strengthens protection to this list; `run create` and `debug create` refuse when protection does not satisfy it. A repo's `.factory/gates.json` can add contexts via `requiredChecks` (additive-only); see [per-repo required checks](automated-gates.md#per-repo-required-checks-requiredchecks).                                                                                                                                                  |
| `qualityGateExtraBranches`    | string[] | `[]`                                               | Extra pull-request target branches for the scaffolded `quality-gate.yml` trigger only (e.g. `["main"]` for release PRs). The resolved base branch is always included; duplicates collapse. GitHub glob patterns such as `release/*` pass through; a leading `!` or whitespace is rejected. The PR mutation job also runs on these targets, so a release PR into `main` mutates the whole develop-to-main change and can take up to the shard timeout. The manual full-mutation workflow still checks out only the base branch. |
| `rollupCiWaitMinutes`         | int >0   | `30`                                               | How long (minutes) the engine waits for the feature PR's required checks and merge before parking the run as `ci`. Work is preserved and resume rechecks.                                                                                                                                                                                                                                                                                                                                                                      |

## Retired keys

The following bash-era keys are deliberately **absent** and must not be carried
forward (human-review gates are retired — Decision 5/19; the review-depth axis was
removed — Decision 25): `humanReviewLevel`, `NEEDS_DISCUSSION`, the exit-42 code,
and the per-tier review caps.

These schema keys were removed because they were **never actually consumed**. Zod
strips an unknown key silently, so `loadConfig` warns loudly (once per process per
file) when a raw overlay still carries one:

| Retired key         | Why it is gone                                                                                                                                                  | Replacement                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `git.stagingBranch` | v2 has no staging branch; each run uses one feature branch `factory/<issue>-<run-id>`.                                                                          | none                                                 |
| `e2e.testDir`       | A `superRefine` already rejected every non-default value, so the knob could only ever hold `e2e`. Both the template and the TCB write-guard hardcode that path. | the literal `e2e` path in the template and TCB guard |

Keys retired with v1 execution are ignored silently when an existing overlay still
carries them: `quality.holdoutPercent`, `quality.holdoutPassRate`,
`quota.producerModels`, the `review`, `codex` and `e2e` blocks,
`git.stagingRequiredStatusChecks`, `git.provision`, `git.branchPrefix`,
`git.developProtection`, `git.developBaselineStatusChecks`, `maxConsecutiveFailures`, `maxParallelTasks`,
`stallTtlMinutes` and `hungSpawnMinutes`.

Remove the warned keys from your overlay:

```bash
factory configure --unset git.stagingBranch
factory configure --unset e2e.testDir
```
