---
description: "Inspect or edit factory pipeline settings"
argument-hint: "[--get <key>] [--set <key=value>] [--unset <key>]"
arguments:
  - name: "--get"
    description: "Print one resolved value (dotted key path)"
    required: false
  - name: "--set"
    description: "Set a value (key=value, repeatable), validate, persist"
    required: false
  - name: "--unset"
    description: "Revert a key to its default (repeatable)"
    required: false
  - name: "--detect-gate-env"
    description: "Auto-detect CI build env → gap-fill quality.gateEnv (standalone)"
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

| Key                              | Default | Meaning                                                |
| -------------------------------- | ------- | ------------------------------------------------------ |
| `holdoutPercent`                 | 20      | % of acceptance criteria held out as an answer-key     |
| `holdoutPassRate`                | 80      | Min % of withheld criteria that must pass              |
| `mutationScoreTarget`            | 80      | Min mutation score (%)                                 |
| `coverageRegressionTolerancePct` | 0.5     | Max coverage drop (pp) before the gate fails           |
| `securityCommand`                | —       | Custom SAST command (else built-in semgrep)            |
| `securityAllowFailures`          | false   | Treat security findings as non-blocking                |
| `securityRedactFindings`         | true    | Redact secrets from the persisted findings artifact    |
| `redTestCommand`                 | —       | Custom red-test command for exotic runners (Go/Ruby/…) |
| `gateEnv`                        | {}      | Env vars injected into every gate command (CI parity)  |

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
`skippedExpressionRefs`, `droppedSecrets`, `warnings`, `sources` (provenance per key), and the
resolved `gateEnv`.

**Gap-fill — the operator always wins.** Detection only fills keys you have not set:

- key absent from your overlay → **written**;
- key present and equal → **skipped** (idempotent re-run);
- key present and different → reported as a **conflict** (your value is preserved, never
  overwritten).

**Three filters drop a value before it can reach `gateEnv`:**

1. any value containing `${{` (a GitHub expression ref like `${{ secrets.* }}` — unusable and
   unsafe at gate time) → `skippedExpressionRefs`;
2. any value the secret scanner flags (defense-in-depth — gateEnv is placeholders, not a secret
   store) → `droppedSecrets`;
3. structurally, anything inside a `run: |` block scalar is never read as env.

Detection is **biased to miss, never to mis-detect**: it reads block-style YAML with space
indentation only — a var hidden in anchors, aliases, merge-keys, or flow-mappings is silently
skipped (and the file reported under `warnings`), never mangled. For any var detection misses,
fall back to `--set quality.gateEnv.<KEY>=<value>`. `factory scaffold` runs this same detection
automatically (see [/factory:scaffold](./scaffold.md)).

### Spec apex gate (`spec.*`)

| Key                   | Default | Meaning                                                  |
| --------------------- | ------- | -------------------------------------------------------- |
| `passReviewThreshold` | 56      | Spec-review pass threshold out of 60                     |
| `dimensionFloor`      | 5       | Any rubric dimension ≤ this auto-fails the spec          |
| `maxRegenIterations`  | 5       | Max generate→review revisions before a loud give-up      |
| `specModel`           | opus    | Apex model the generator + reviewer are pinned to (D21)  |
| `specEffort`          | max     | Apex effort the generator + reviewer are pinned to (D21) |
| `prdBodyMaxBytes`     | 65536   | Max PRD body bytes retained before truncation            |

> `specModel`/`specEffort` are the Decision-21 apex pin. The spec boundary reads the frozen
> defaults, not a per-run override — changing them here is for unusual setups only.

### Review panel (`review.*`)

| Key             | Default | Meaning                                           |
| --------------- | ------- | ------------------------------------------------- |
| `model`         | —       | Reviewer model override (panel is risk-invariant) |
| `maxTurnsDeep`  | 40      | Max turns for a deep review pass                  |
| `maxTurnsQuick` | 20      | Max turns for a quick review pass                 |

### Quota pacer (`quota.*`)

`sleepCapSec` (540), `maxWaitCycles` (60), `maxStaleCycles` (6), `wallBudgetMin` (75),
`hourlyThresholds` ([20,40,60,80,90]), `dailyThresholds` ([14,29,43,57,71,86,95]), and the
producer dial `quota.producerModels.{low,medium,high}` (haiku/sonnet/opus by risk tier).

### Git / serial-writer (`git.*`)

| Key                    | Default | Meaning                                                   |
| ---------------------- | ------- | --------------------------------------------------------- |
| `baseBranch`           | develop | Branch staging forks from / rolls up into (never main)    |
| `stagingBranch`        | staging | Integration branch task PRs serial-merge into             |
| `requiredStatusChecks` | []      | Status checks protection must enforce before a run starts |
| `provision`            | false   | Write branch protection when missing (else refuse)        |
| `branchPrefix`         | factory | Prefix for run-scoped task branches                       |

### Other roots

`testWriter.maxTurns` (30), `scribe.maxTurns` (20), `codex.model` (—),
`observability.auditLog` (true) / `observability.metricsRetentionDays` (30),
`dependencies.pollInterval` (30) / `dependencies.prMergeTimeout` (1800),
`maxConsecutiveFailures` (3), `maxRuntimeMinutes` (480).

> Retired (locked decision 5 — human gates removed): `humanReviewLevel`,
> `review.routineRounds/featureRounds/securityRounds`, `review.preferCodex`,
> `maxParallelTasks`, the `safety.*` block, `execution.*`. These keys no longer exist; do
> not write them.

## Interactive

With no flags, print the full config, ask the user what to change, and apply each change
with a `--set`/`--unset` call, confirming the resolved value after each.
