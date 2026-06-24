# Configuration Schema

All configuration lives in one Zod schema, `src/config/schema.ts`, where every
field carries a default. `ConfigSchema.parse({})` yields a complete, typed config,
so a missing config file is equivalent to all-defaults. Inspect and edit the
overlay with `factory configure` (see [cli.md](./cli.md)); print the resolved
config with `factory config-defaults`.

Edits are persisted as a **sparse overlay** — only the keys you set are written,
so unset keys continue to track future default changes.

Key paths are dotted (e.g. `quality.holdoutPercent`, `git.stagingBranch`).

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

The redirect emits a **single WARN per distinct redirect per process** (keyed on
the `current → corrected` pair; `resolveDataDir()` is called ~20×/command, so the
warn is deduplicated rather than spammed). The message states that another plugin
set the var, that factory auto-redirected to its canonical dir, that no action is
required for correctness, and — if you want to silence it permanently — to set
`CLAUDE_PLUGIN_DATA` to factory's own `factory-<your-marketplace-id>` dir. The
redirect **behavior** is unconditional and unaffected by the warn rate-limiting.

**Root cause (why it happens, why it's benign).** The leak is external to factory:
Claude Code does not scope `CLAUDE_PLUGIN_DATA` per-plugin in the **shared process
env**, so a sibling plugin that exports it (e.g. `codex`) leaves its value visible to
every `factory` subprocess. Factory's defense is two-layer and complete on its own
side:

1. **Primary pin — `merged-settings.json`.** In autonomous mode (the sanctioned run
   path), `factory autonomy ensure` bakes `env.CLAUDE_PLUGIN_DATA = <canonical dir>`
   into the merged settings file the session relaunches with (`src/cli/subcommands/autonomy.ts`),
   so the var is correct from process start and no redirect fires.
2. **Backstop — the `CLAUDE_PLUGIN_ROOT` self-correct.** When a session was _not_
   launched through merged settings (a foreign value leaked in), `resolveDataDir()`
   re-derives the canonical dir from `CLAUDE_PLUGIN_ROOT` (the per-plugin anchor Claude
   Code injects reliably) and the WARN is simply **evidence the backstop fired** — not a
   factory misconfiguration.

The warn **repeats across commands by design**: the once-per-process dedup cannot span
processes, and every `factory` CLI call is a fresh process, so each command re-derives
and re-warns once. It is cosmetic; correctness (state always under factory's own dir) is
already guaranteed by the two layers above. The only way to silence it permanently is to
stop the foreign export — i.e. set `CLAUDE_PLUGIN_DATA` to factory's canonical dir in
your shell profile, or launch through `merged-settings.json` (which pins it for you).

## `quality`

Quality-gate thresholds.

| Key                              | Type                  | Default | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `holdoutPercent`                 | number 0–100          | `20`    | Percent of acceptance criteria withheld as an unreadable answer-key.                                                                                                                                                                                                                                                                                                                                                          |
| `holdoutPassRate`                | number 0–100          | `80`    | Min pass-rate (%) on the holdout set to clear the gate.                                                                                                                                                                                                                                                                                                                                                                       |
| `mutationScoreTarget`            | number 0–100          | `80`    | Target mutation score (%) for the mutation gate.                                                                                                                                                                                                                                                                                                                                                                              |
| `coverageRegressionTolerancePct` | number ≥0             | `0.5`   | Allowed coverage regression (percentage points) before the gate fails.                                                                                                                                                                                                                                                                                                                                                        |
| `securityCommand`                | string (optional)     | —       | Custom SAST/security command; else the built-in semgrep run.                                                                                                                                                                                                                                                                                                                                                                  |
| `securityAllowFailures`          | boolean               | `false` | Treat security findings as non-blocking.                                                                                                                                                                                                                                                                                                                                                                                      |
| `securityRedactFindings`         | boolean               | `true`  | Redact secrets from the persisted findings artifact.                                                                                                                                                                                                                                                                                                                                                                          |
| `redTestCommand`                 | string (optional)     | —       | Custom red-test verification command for exotic runners (Go, Ruby, Deno…), so TDD enforcement need not be bypassed.                                                                                                                                                                                                                                                                                                           |
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
`src/cli/wiring.ts`).

**Preferred: auto-detect from CI.** Rather than transcribing each var by hand, let factory read
your CI workflow and gap-fill the placeholders:

```bash
factory configure --detect-gate-env
```

This scans `.github/workflows/*.yml` for every step/job-level `env:` literal and merges them into
`quality.gateEnv` (`applyGateEnvDetection`, `src/ci/detect-gate-env.ts`). `factory scaffold` runs
the **same** detection automatically — before the managed `quality-gate.yml` template overwrites
the repo's own workflow — so a freshly scaffolded repo already has its CI env captured. See
[`configure --detect-gate-env`](./cli.md#configure) for the flag contract and `DetectReport` shape.

The merge is **gap-fill — the operator always wins**: a key absent from the overlay is _written_;
present-and-equal is _skipped_ (idempotent); present-and-different is reported as a _conflict_ and
left untouched. Detection drops an entry — never silently — before it reaches `gateEnv`:

- **value `${{ … }}`** — a GitHub expression ref (`${{ secrets.* }}`, `${{ matrix.* }}`, unusable
  - unsafe at gate time) → reported under `skippedExpressionRefs`;
- **secret-shaped value** — anything the secret scanner flags (defense-in-depth: placeholders, not
  secrets) → reported under `droppedSecrets`;
- **reserved KEY** — a loader / path-injection name (`PATH`, `NODE_PATH`, `LD_PRELOAD`,
  `LD_LIBRARY_PATH`, `DYLD_*`) that would hijack the gate subprocess, since gateEnv merges _over_
  `process.env` → reported under `droppedKeys` with `reason: "reserved"`. The denylist is
  deliberately narrow: `NODE_OPTIONS` and `GIT_*` are legitimate build/identity vars and are **not**
  denied;
- **non-POSIX KEY** — a name that is not a valid POSIX env var (`^[A-Za-z_][A-Za-z0-9_]*$`) → reported
  under `droppedKeys` with `reason: "invalid-name"`. The schema enforces the same regex on the
  config key, so a hand-set non-POSIX key is rejected at the `--set` boundary too;
- **`run: |` block scalar** — anything structurally inside a block scalar is never read as env.

Detection is **biased to miss, never to mis-detect**: it reads block-style YAML with space
indentation only. An _unquoted_ value opening with exotic YAML — an anchor `&`, alias `*`, tag `!`,
or flow collection `{`/`[` — is skipped rather than emitted mangled (`isUndetectableScalar`); a
_quoted_ look-alike (`"[draft]"`, `'!important'`) is a plain string and **is** kept. A workflow file
that cannot be parsed at all is skipped and reported under `warnings` (and logged loudly), never
partial-emitted. The escape hatch for any miss is the manual `--set` below.

**Manual escape hatch.** Set each leaf individually:

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
`factory scaffold` renders it into the managed `quality-gate.yml` it writes — `injectGateEnvIntoWorkflow`
(`src/ci/inject-gate-env.ts`) replaces the `# factory:gate-env` marker in the template's `pnpm build`
step with a real `env:` block built from the resolved map. So editing `quality.gateEnv` (then
re-scaffolding) keeps the local gate and the repo's GitHub CI in lockstep; an empty map leaves the
marker untouched, and a re-scaffold is byte-identical (idempotent).

This is **CI parity, not secrets**: these placeholders sit in the sparse config overlay in
plaintext. Never put a real credential here — they exist only so the merge gate
exercises the same build CI does.

## `quota`

The two-window quota pacer.

| Key                     | Type      | Default                  | Meaning                                                                                                                                                                                                                                                 |
| ----------------------- | --------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sleepCapSec`           | int >0    | `540`                    | Max single sleep chunk per gate call (seconds).                                                                                                                                                                                                         |
| `maxWaitCycles`         | int >0    | `60`                     | Max wait cycles before the gate ends a wait.                                                                                                                                                                                                            |
| `maxStaleCycles`        | int >0    | `6`                      | Max consecutive stale-cache cycles before graceful end.                                                                                                                                                                                                 |
| `wallBudgetMin`         | int >0    | `75`                     | Accumulated wall-clock wait budget across cycles (minutes).                                                                                                                                                                                             |
| `hourlyThresholds`      | number[5] | `[20,40,60,80,90]`       | 5h-window utilization caps by hour 1..5 (%).                                                                                                                                                                                                            |
| `dailyThresholds`       | number[7] | `[20,40,60,80,95,95,95]` | 7d-window utilization caps by day 1..7 (%). Ramps to 95% by window-day 5 (a 5-workday spend pattern) then plateaus through days 6–7, leaving a 5% end-of-window reserve. "Window-day N" is a position in the rolling 7d window, not a calendar weekday. |
| `producerModels.low`    | string    | `claude-sonnet-4-5`      | Producer model for low risk tier.                                                                                                                                                                                                                       |
| `producerModels.medium` | string    | `claude-sonnet-4-5`      | Producer model for medium risk tier.                                                                                                                                                                                                                    |
| `producerModels.high`   | string    | `claude-opus-4-6`        | Producer model for high risk tier.                                                                                                                                                                                                                      |

The review panel is risk-_invariant_ (Decision 26), so there is no review-depth
dial here. `producerModels` is the only dial the quota router carries.

## `spec`

The spec-build pipeline.

| Key                   | Type     | Default | Meaning                                                                          |
| --------------------- | -------- | ------- | -------------------------------------------------------------------------------- |
| `passReviewThreshold` | int 0–60 | `56`    | The single spec-review pass threshold out of 60.                                 |
| `dimensionFloor`      | int 0–10 | `5`     | Any rubric dimension scoring `≤` this forces NEEDS_REVISION regardless of total. |
| `maxRegenIterations`  | int >0   | `5`     | Max generate ⇄ review revision iterations before a loud give-up.                 |
| `specModel`           | string   | `opus`  | Apex model the spec generator AND reviewer are pinned to (Decision 21).          |
| `specEffort`          | string   | `max`   | Apex effort for the spec generator AND reviewer.                                 |
| `prdBodyMaxBytes`     | int >0   | `65536` | Max bytes of PRD body retained before truncation.                                |

`specModel`/`specEffort` are an _unconditional_ apex pin: the apex boundary reads
the frozen defaults, not a per-run override.

## `review`

The judgment panel.

| Key             | Type              | Default | Meaning                                                       |
| --------------- | ----------------- | ------- | ------------------------------------------------------------- |
| `model`         | string (optional) | —       | Reviewer model id (panel runs on a fixed model, Decision 26). |
| `maxTurnsDeep`  | int >0            | `40`    | Max turns for a deep review pass.                             |
| `maxTurnsQuick` | int >0            | `20`    | Max turns for a quick review pass.                            |

## `testWriter`

| Key        | Type   | Default | Meaning                         |
| ---------- | ------ | ------- | ------------------------------- |
| `maxTurns` | int >0 | `30`    | Max turns for a producer agent. |

## `codex`

| Key     | Type              | Default | Meaning                            |
| ------- | ----------------- | ------- | ---------------------------------- |
| `model` | string (optional) | —       | Codex cross-vendor executor model. |

## `git`

Branch and protection contract.

| Key                    | Type     | Default   | Meaning                                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseBranch`           | string   | `develop` | The durable integration base: each run's `staging-<run-id>` branch forks from it and rolls up into it. Scaffold protects this branch. Never `main`.                                                                                                                                                           |
| `stagingBranch`        | string   | `staging` | Legacy default for git helpers that still take an optional branch arg (worktree base, rollup, protection probe). The **per-run** branch is `staging-<run-id>` from a hardcoded prefix (`runStagingBranch`, Decision 33) — it does **not** derive from this key. Changing it does not rename per-run branches. |
| `requiredStatusChecks` | string[] | `[]`      | Status checks branch protection must enforce (on `develop` at scaffold, and on each `staging-<run-id>` at run create). Empty = no specific checks, but protection itself is still mandatory.                                                                                                                  |
| `provision`            | boolean  | `false`   | Opt-in protection provisioning. Off by default — the run verifies and refuses when protection is missing.                                                                                                                                                                                                     |
| `branchPrefix`         | string   | `factory` | Prefix for run-scoped task branches: `<branchPrefix>/<run_id>/<task_id>`.                                                                                                                                                                                                                                     |

## Root keys

| Key                      | Type   | Default | Meaning                                                                                                                                                                                                               |
| ------------------------ | ------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxConsecutiveFailures` | int >0 | `3`     | Cumulative genuine `capability-budget` task failures before the run aborts (cascade/wedge drops excluded). The signal is run-cumulative, not strictly consecutive; the key keeps its historical name for back-compat. |
| `maxRuntimeMinutes`      | int >0 | `480`   | Hard wall-clock cap for a whole run (minutes).                                                                                                                                                                        |

## Retired keys

The following bash-era keys are deliberately **absent** and must not be carried
forward (human-review gates are retired — Decision 5/19; the review-depth axis was
removed — Decision 25): `humanReviewLevel`, `NEEDS_DISCUSSION`, the exit-42 code,
and the per-tier review caps.
</content>
