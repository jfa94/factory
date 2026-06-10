# Configuration Schema

All configuration lives in one Zod schema, `src/config/schema.ts`, where every
field carries a default. `ConfigSchema.parse({})` yields a complete, typed config,
so a missing config file is equivalent to all-defaults. Inspect and edit the
overlay with `factory configure` (see [cli.md](./cli.md)); print the resolved
config with `factory config-defaults`.

Edits are persisted as a **sparse overlay** — only the keys you set are written,
so unset keys continue to track future default changes.

Key paths are dotted (e.g. `quality.holdoutPercent`, `git.stagingBranch`).

## `quality`

Quality-gate thresholds.

| Key                              | Type              | Default | Meaning                                                                                                             |
| -------------------------------- | ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `holdoutPercent`                 | number 0–100      | `20`    | Percent of acceptance criteria withheld as an unreadable answer-key.                                                |
| `holdoutPassRate`                | number 0–100      | `80`    | Min pass-rate (%) on the holdout set to clear the gate.                                                             |
| `mutationScoreTarget`            | number 0–100      | `80`    | Target mutation score (%) for the mutation gate.                                                                    |
| `coverageRegressionTolerancePct` | number ≥0         | `0.5`   | Allowed coverage regression (percentage points) before the gate fails.                                              |
| `securityCommand`                | string (optional) | —       | Custom SAST/security command; else the built-in semgrep run.                                                        |
| `securityAllowFailures`          | boolean           | `false` | Treat security findings as non-blocking.                                                                            |
| `securityRedactFindings`         | boolean           | `true`  | Redact secrets from the persisted findings artifact.                                                                |
| `redTestCommand`                 | string (optional) | —       | Custom red-test verification command for exotic runners (Go, Ruby, Deno…), so TDD enforcement need not be bypassed. |

## `quota`

The two-window quota pacer.

| Key                     | Type      | Default                  | Meaning                                                     |
| ----------------------- | --------- | ------------------------ | ----------------------------------------------------------- |
| `sleepCapSec`           | int >0    | `540`                    | Max single sleep chunk per gate call (seconds).             |
| `maxWaitCycles`         | int >0    | `60`                     | Max wait cycles before the gate ends a wait.                |
| `maxStaleCycles`        | int >0    | `6`                      | Max consecutive stale-cache cycles before graceful end.     |
| `wallBudgetMin`         | int >0    | `75`                     | Accumulated wall-clock wait budget across cycles (minutes). |
| `hourlyThresholds`      | number[5] | `[20,40,60,80,90]`       | 5h-window utilization caps by hour 1..5 (%).                |
| `dailyThresholds`       | number[7] | `[14,29,43,57,71,86,95]` | 7d-window utilization caps by day 1..7 (%).                 |
| `producerModels.low`    | string    | `claude-haiku-4-5`       | Producer model for low risk tier.                           |
| `producerModels.medium` | string    | `claude-sonnet-4-5`      | Producer model for medium risk tier.                        |
| `producerModels.high`   | string    | `claude-opus-4-6`        | Producer model for high risk tier.                          |

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

## `scribe`

| Key        | Type   | Default | Meaning                                |
| ---------- | ------ | ------- | -------------------------------------- |
| `maxTurns` | int >0 | `20`    | Max turns for the docs (Scribe) agent. |

## `codex`

| Key     | Type              | Default | Meaning                            |
| ------- | ----------------- | ------- | ---------------------------------- |
| `model` | string (optional) | —       | Codex cross-vendor executor model. |

## `observability`

| Key                    | Type    | Default | Meaning                                |
| ---------------------- | ------- | ------- | -------------------------------------- |
| `auditLog`             | boolean | `true`  | Emit the jsonl audit log.              |
| `metricsRetentionDays` | int >0  | `30`    | Days to retain metrics before pruning. |

## `dependencies`

| Key              | Type   | Default | Meaning                                                   |
| ---------------- | ------ | ------- | --------------------------------------------------------- |
| `pollInterval`   | int >0 | `30`    | Poll interval while waiting on a dependency PR (seconds). |
| `prMergeTimeout` | int >0 | `1800`  | Timeout waiting for a PR to merge (seconds).              |

## `git`

Branch and protection contract.

| Key                    | Type     | Default   | Meaning                                                                                                                                               |
| ---------------------- | -------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseBranch`           | string   | `develop` | The durable base branch staging forks from and rolls up into. Never `main`.                                                                           |
| `stagingBranch`        | string   | `staging` | The integration branch task PRs serial-merge into.                                                                                                    |
| `requiredStatusChecks` | string[] | `[]`      | Status checks branch protection must enforce on staging before a run may start. Empty = no specific checks, but protection itself is still mandatory. |
| `provision`            | boolean  | `false`   | Opt-in protection provisioning. Off by default — the run verifies and refuses when protection is missing.                                             |
| `branchPrefix`         | string   | `factory` | Prefix for run-scoped task branches: `<branchPrefix>/<run_id>/<task_id>`.                                                                             |

## Root keys

| Key                      | Type   | Default | Meaning                                          |
| ------------------------ | ------ | ------- | ------------------------------------------------ |
| `maxConsecutiveFailures` | int >0 | `3`     | Consecutive task failures before the run aborts. |
| `maxRuntimeMinutes`      | int >0 | `480`   | Hard wall-clock cap for a whole run (minutes).   |

## Retired keys

The following bash-era keys are deliberately **absent** and must not be carried
forward (human-review gates are retired — Decision 5/19; the review-depth axis was
removed — Decision 25): `humanReviewLevel`, `NEEDS_DISCUSSION`, the exit-42 code,
and the per-tier review caps.
</content>
