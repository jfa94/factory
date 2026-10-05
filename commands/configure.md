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
---

# /factory:configure

View and edit the factory config. Every operation goes through one deterministic CLI —
`factory configure` — which validates the whole config against the canonical Zod schema
**before** it touches disk and persists only a sparse overlay (so future default changes
stay visible). You never hand-edit `config.json`.

## Inspect

```bash
factory configure                 # print the full resolved config (defaults + overlay) as JSON
factory configure --get <key>     # print one resolved value, e.g. --get quality.mutationScoreTarget
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
factory configure --set quality.mutationScoreTarget=85
factory configure --set git.rollupCiWaitMinutes=45
factory configure --unset quality.securityCommand
```

## The settings (canonical keys + defaults)

These are the keys the schema actually reads. Run `factory configure` to see live values.

### Quality gates (`quality.*`)

| Key                              | Default | Meaning                                               |
| -------------------------------- | ------- | ----------------------------------------------------- |
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
>
> `factory scaffold` **renders the configured `gateEnv` into the managed `quality-gate.yml`**
> so one config feeds both the local gate and CI (see [/factory:scaffold](./scaffold.md)).

### Spec apex gate (`spec.*`)

| Key                   | Default | Meaning                                             |
| --------------------- | ------- | --------------------------------------------------- |
| `passReviewThreshold` | 56      | Spec-review pass threshold out of 60                |
| `dimensionFloor`      | 5       | Any rubric dimension ≤ this auto-fails the spec     |
| `maxRegenIterations`  | 5       | Max generate→review revisions before a loud give-up |
| `prdBodyMaxBytes`     | 65536   | Max PRD body bytes retained before truncation       |

> The Decision-21 apex pin (spec generator + reviewer model/effort) is NOT config —
> it is invariant by construction, hard consts in `src/spec/agents.ts`.

### Quota pacer (`quota.*`)

`hourlyThresholds` ([20,40,60,80,90]) and `dailyThresholds` ([20,40,60,80,95,95,95]).

### Git (`git.*`)

| Key                           | Default                                  | Meaning                                                              |
| ----------------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `baseBranch`                  | develop                                  | Branch the feature branch forks from and its PR targets (never main) |
| `developRequiredStatusChecks` | Quality, Mutation Testing, Security Scan | Checks scaffold and run preflight require on develop                 |
| `rollupCiWaitMinutes`         | 30                                       | Max wait for the feature PR's CI before parking the run              |

> Retired (locked decision 5 — human gates removed): `humanReviewLevel`,
> `review.routineRounds/featureRounds/securityRounds`, `review.preferCodex`, the
> `safety.*` block, `execution.*`. These keys no longer exist; do not write them.
>
> Retired with v1 execution: `quality.holdoutPercent/holdoutPassRate`,
> `quota.producerModels`, the `review.*`, `codex.*` and `e2e.*` blocks,
> `git.stagingRequiredStatusChecks/provision/branchPrefix/developProtection`,
> `maxConsecutiveFailures`, `maxParallelTasks`, `stallTtlMinutes` and
> `hungSpawnMinutes`. An existing config carrying them still loads; they are ignored.

## Interactive

With no flags, print the full config, ask the user what to change, and apply each change
with a `--set`/`--unset` call, confirming the resolved value after each.
