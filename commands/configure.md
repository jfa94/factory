---
description: 'Inspect or edit factory pipeline settings'
argument-hint: '[--get <key>] [--set <key=value>] [--unset <key>]'
arguments:
    - name: '--get'
      description: 'Print one resolved value (dotted key path)'
      required: false
    - name: '--set'
      description: 'Set a value (key=value, repeatable), validate, persist'
      required: false
    - name: '--unset'
      description: 'Revert a key to its default (repeatable)'
      required: false
    - name: '--detect-gate-env'
      description: 'Auto-detect CI build env → gap-fill quality.gateEnv (standalone)'
      required: false
---

# /factory:configure

View and edit the factory config. Every operation goes through one deterministic CLI —
`factory configure` — which validates the whole config against the canonical Zod schema
**before** it touches disk and persists only a sparse overlay (so future default changes
stay visible). You never hand-edit `config.json`.

## Inspect

```bash
factory configure                 # print the full resolved config (defaults + overlay) as JSON
factory configure --get <key>     # print one resolved value, e.g. --get quality.holdoutPercent
```

## Change

```bash
factory configure --set <key>=<value>   # repeatable; validates + persists; prints the resolved config
factory configure --unset <key>         # repeatable; reverts the key to its default
```

`<value>` parses as JSON when it can (numbers, booleans, arrays — `25`, `true`,
`'["a","b"]'`); otherwise as a bare string. A value that fails schema validation is a loud
error and **nothing is written**. Examples:

```bash
factory configure --set quality.holdoutPercent=25
factory configure --set git.stagingBranch=staging
factory configure --set git.provision=true
factory configure --unset quality.securityCommand
```

## The settings (canonical keys + defaults)

These are the keys the schema actually reads. Run `factory configure` to see live values.

### Quality gates (`quality.*`)

| Key                              | Default | Meaning                                               |
| -------------------------------- | ------- | ----------------------------------------------------- |
| `holdoutPercent`                 | 20      | % of acceptance criteria held out as an answer-key    |
| `holdoutPassRate`                | 80      | Min % of withheld criteria that must pass             |
| `mutationScoreTarget`            | 80      | Min mutation score (%)                                |
| `coverageRegressionTolerancePct` | 0.5     | Max coverage drop (pp) before the gate fails          |
| `securityCommand`                | —       | Custom SAST command (else built-in semgrep)           |
| `securityAllowFailures`          | false   | Treat security findings as non-blocking               |
| `securityRedactFindings`         | true    | Redact secrets from the persisted findings artifact   |
| `gateEnv`                        | {}      | Env vars injected into every gate command (CI parity) |

> **`quality.gateEnv`** mirrors your CI build step's env so the verifier floor measures the
> code, not a missing-env build crash. The gates run `build`/`test`/`type`/`lint`/`security`
> in a fresh worktree with no `.env.local`; if your CI injects placeholders for the same
> build (e.g. a Next.js static prerender that needs `NEXT_PUBLIC_*`), set them here as a
> name→value map. **Placeholders only — not a secret store.** Set each leaf individually:
>
> ```bash
> factory configure --set quality.gateEnv.NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
> factory configure --set quality.gateEnv.NEXT_PUBLIC_SUPABASE_KEY=ci-placeholder
> ```
>
> A purely numeric value is JSON-coerced to a number (rejected by the string-only schema) —
> quote it: `--set quality.gateEnv.PORT='"54321"'`.

#### Auto-detecting `gateEnv` from CI

`--set` is the escape hatch; the **preferred** way to populate `quality.gateEnv` is to let
factory read your CI workflow and gap-fill the placeholders for you:

```bash
factory configure --detect-gate-env
```

This scans `.github/workflows/*.yml` for every step/job-level `env:` literal and merges them
into `quality.gateEnv`. It is **standalone and mutually exclusive** with `--get`/`--set`/`--unset`
(combining them is a usage error). It writes immediately (only when there are new keys) and
prints a `DetectReport` JSON: `detected`, `written`, `skipped`, `conflicts`,
`skippedExpressionRefs`, `droppedSecrets`, `droppedKeys`, `warnings`, `sources` (provenance per
key), and the resolved `gateEnv`.

**Gap-fill — the operator always wins.** Detection only fills keys you have not set:

- key absent from your overlay → **written**;
- key present and equal → **skipped** (idempotent re-run);
- key present and different → reported as a **conflict** (your value is preserved, never
  overwritten).

**Filters drop an entry before it can reach `gateEnv`:**

1. any value containing `${{` (a GitHub expression ref like `${{ secrets.* }}` — unusable and
   unsafe at gate time) → `skippedExpressionRefs`;
2. any value the secret scanner flags (defense-in-depth — gateEnv is placeholders, not a secret
   store) → `droppedSecrets`;
3. any reserved loader/path-injection **key** (`PATH`, `NODE_PATH`, `LD_PRELOAD`,
   `LD_LIBRARY_PATH`, `DYLD_*`) or a non-POSIX key name → `droppedKeys` (reason `reserved` /
   `invalid-name`). A reserved key would hijack the gate subprocess (gateEnv merges over
   `process.env`); `NODE_OPTIONS` and `GIT_*` are legit build vars and are **kept**;
4. structurally, anything inside a `run: |` block scalar is never read as env.

Detection is **biased to miss, never to mis-detect**: it reads block-style YAML with space
indentation only. An UNQUOTED value opening with exotic YAML (an anchor `&`, alias `*`, tag `!`,
or flow collection `{`/`[`) is skipped rather than emitted mangled; a quoted look-alike like
`"[draft]"` is a plain string and IS kept. A file it cannot structurally parse at all (e.g. tab
indentation) is skipped wholesale and listed under `warnings`. For any var detection misses, fall
back to `--set quality.gateEnv.<KEY>=<value>`. `factory scaffold` runs this same detection
automatically and **injects the resolved `gateEnv` into the managed `quality-gate.yml`** so one
config feeds both the local gate and CI (see [/factory:scaffold](./scaffold.md)).

### Spec apex gate (`spec.*`)

| Key                   | Default | Meaning                                             |
| --------------------- | ------- | --------------------------------------------------- |
| `passReviewThreshold` | 56      | Spec-review pass threshold out of 60                |
| `dimensionFloor`      | 5       | Any rubric dimension ≤ this auto-fails the spec     |
| `maxRegenIterations`  | 5       | Max generate→review revisions before a loud give-up |
| `prdBodyMaxBytes`     | 65536   | Max PRD body bytes retained before truncation       |

> The Decision-21 apex pin (spec generator + reviewer model/effort) is NOT config —
> it is invariant by construction, hard consts in `src/spec/agents.ts`.

### Review panel (`review.*`)

| Key                  | Default | Meaning                                                                                                                                             |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`              | —       | Reviewer model override (panel is risk-invariant)                                                                                                   |
| `maxTurnsDeep`       | 40      | Max turns for a deep review pass                                                                                                                    |
| `maxTurnsQuick`      | 20      | Max turns for a quick review pass                                                                                                                   |
| `requireCrossVendor` | warn    | Second-vendor reviewer policy (Δ U/S5): `warn` surfaces an absence in the report/summary; `block` fails the merge gate until Codex actually reviews |

> `requireCrossVendor` needs `codex.model` set AND the `codex` CLI installed —
> the engine probes `codex --version` and stamps the verify manifest; with
> `block` + no working Codex, verify wait-retries instead of shipping
> single-vendor.

### E2E phase (`e2e.*`, Decisions 39 + 40)

| Key              | Default | Meaning                                                                                                                         |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `startCommand`   | —       | **Optional override** (D10) of the boot command — normally the run-start e2e-assessment resolves this itself                    |
| `baseURL`        | —       | **Optional override** (D10) of the base URL the app serves once booted — normally assessment-resolved                           |
| `testDir`        | e2e     | Repo-relative dir the COMMITTED critical suite lives in — persistence here IS the criticality signal, no `@critical` tag exists |
| `readyTimeoutMs` | 30000   | Max wait for the boot command to become ready before the boot fails                                                             |
| `reopenCap`      | 2       | Per-task cap on e2e-triggered reopens; a critical spec still red after this many fails the run outright                         |

> No setup is required before `--e2e` (Decision 40). `run create --e2e` only
> checks the static prerequisites (`package.json`, `@playwright/test` dep,
> `playwright.config.ts` — `factory scaffold` provides them); the run-start
> **e2e-assessment** then resolves the real boot command + base URL and writes
> them into the repo's `playwright.config.ts`. Set `e2e.startCommand`/
> `e2e.baseURL` only to override what assessment resolved (a config value wins).
> If neither source can produce a boot pair, the phase **suspends** loud
> (resumable via `/factory:resume`) rather than skipping silently.

### Quota pacer (`quota.*`)

`sleepCapSec` (540), `maxWaitCycles` (60), `wallBudgetMin` (75),
`hourlyThresholds` ([20,40,60,80,90]), `dailyThresholds` ([20,40,60,80,95,95,95]), and the
producer dial `quota.producerModels.{low,medium,high}` (sonnet/sonnet/opus by risk tier).

### Git / serial-writer (`git.*`)

| Key                    | Default | Meaning                                                   |
| ---------------------- | ------- | --------------------------------------------------------- |
| `baseBranch`           | develop | Branch staging forks from / rolls up into (never main)    |
| `stagingBranch`        | staging | Integration branch task PRs serial-merge into             |
| `requiredStatusChecks` | []      | Status checks protection must enforce before a run starts |
| `provision`            | false   | Write branch protection when missing (else refuse)        |
| `branchPrefix`         | factory | Prefix for run-scoped task branches                       |

### Other roots

`testWriter.maxTurns` (30), `codex.model` (—), `maxConsecutiveFailures` (3 — the
circuit-breaker FLOOR; effective threshold `max(floor, ceil(0.15 × total tasks))`),
`maxParallelTasks` (3 — max tasks the runner drives in flight; emitted as
`max_parallel` on the work envelope).

> Retired (locked decision 5 — human gates removed): `humanReviewLevel`,
> `review.routineRounds/featureRounds/securityRounds`, `review.preferCodex`, the
> `safety.*` block, `execution.*`. These keys no longer exist; do not write them.

## Interactive

With no flags, print the full config, ask the user what to change, and apply each change
with a `--set`/`--unset` call, confirming the resolved value after each.
