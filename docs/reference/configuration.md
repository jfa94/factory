# Configuration Schema

Complete reference for every runtime config option read by the pipeline scripts from `${CLAUDE_PLUGIN_DATA}/config.json`. Write values with `/factory:configure`.

## Pipeline Behavior

### maxRuntimeMinutes

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 0      |
| Min      | 0      |
| Max      | 1440   |

Maximum pipeline runtime in minutes before circuit breaker trips. `0` = unlimited (default). Set to a positive value to enable a wall-clock emergency brake.

### maxConsecutiveFailures

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 5      |
| Min      | 1      |
| Max      | 10     |

Consecutive task failures before pipeline aborts.

### humanReviewLevel

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 0      |
| Min      | 0      |
| Max      | 4      |

Human oversight level. Default (0) assumes CI branch protection and GitHub auto-merge are enabled.

| Value | Name              | Behavior                                             |
| ----- | ----------------- | ---------------------------------------------------- |
| 0     | Full Autonomy     | Pipeline creates PR and enables auto-merge (default) |
| 1     | PR Approval       | Pipeline creates PR, human merges                    |
| 2     | Review Checkpoint | Human signs off before PR creation                   |
| 3     | Spec Approval     | Human approves spec before execution                 |
| 4     | Full Supervision  | Human approves at every stage                        |

### maxParallelTasks

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 3      |
| Min      | 1      |
| Max      | 10     |

Maximum concurrent task-executor agents.

---

## Code Review

### review.routineRounds

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 2      |
| Min      | 1      |
| Max      | 5      |

Review rounds for routine-tier tasks.

### review.featureRounds

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 4      |
| Min      | 1      |
| Max      | 10     |

Maximum adversarial review rounds for feature-tier tasks.

### review.securityRounds

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 6      |
| Min      | 1      |
| Max      | 10     |

Maximum adversarial review rounds for security-tier tasks.

### review.preferCodex

| Property | Value   |
| -------- | ------- |
| Type     | boolean |
| Default  | true    |

Use Codex adversarial review when available, fall back to Claude Code.

---

## Quality Gates

### quality.holdoutPercent

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 20     |
| Min      | 0      |
| Max      | 50     |

Percentage of acceptance criteria to withhold for holdout validation. Set to 0 to disable holdout validation.

### quality.holdoutPassRate

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 80     |
| Min      | 50     |
| Max      | 100    |

Minimum percentage of withheld criteria that must be satisfied.

### quality.mutationScoreTarget

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 80     |
| Min      | 50     |
| Max      | 100    |

Minimum mutation score percentage.

### quality.mutationTestingTiers

| Property | Value                     |
| -------- | ------------------------- |
| Type     | array                     |
| Default  | `["feature", "security"]` |

Risk tiers that require mutation testing. Empty array disables mutation testing.

### quality.coverageMustNotDecrease

| Property | Value   |
| -------- | ------- |
| Type     | boolean |
| Default  | true    |

Block tasks that decrease test coverage.

### quality.coverageRegressionTolerancePct

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 0.5    |
| Min      | 0      |
| Max      | 10     |

Maximum allowed drop in coverage (percentage points) before the regression gate fails. Default `0.5` absorbs measurement noise from branch/line count shifts. This is a regression tolerance, NOT a minimum-coverage floor — projects that want to enforce a floor should add a dedicated CI step.

### quality.redTestCommand

| Property | Value  |
| -------- | ------ |
| Type     | string |
| Default  | (none) |

Custom command for red-test verification in repos with exotic test runners (Go, Ruby, Deno, etc.). When set, the TDD gate uses this command instead of the default vitest/jest detection.

**Security constraints:**

- Every token must match `[A-Za-z0-9._/=:+-]+` (no shell metacharacters, globs, tildes, or unicode)
- Command prefix must match an allowed runner sequence:
  - Single-token: `pytest`, `vitest`, `jest`, `mocha`, `phpunit`, `rspec`
  - Two-token: `go test`, `cargo test`, `deno test`
  - Three-token: `bundle exec rspec`

Commands that fail validation are rejected and the task is marked failed with `reason: "unsafe_command"` or `reason: "unallowed_runner"`.

---

## Task Execution

### execution.defaultModel

| Property | Value               |
| -------- | ------------------- |
| Type     | string              |
| Default  | sonnet              |
| Enum     | haiku, sonnet, opus |

Default model for task execution. Overridden by per-tier overrides below:

| Tier (from `pipeline-classify-task`) | Default model | Override key                    |
| ------------------------------------ | ------------- | ------------------------------- |
| Simple                               | haiku         | `execution.modelByTier.simple`  |
| Medium                               | sonnet        | `execution.modelByTier.medium`  |
| Complex                              | opus          | `execution.modelByTier.complex` |

### execution.modelByTier.simple

| Property | Value               |
| -------- | ------------------- |
| Type     | string              |
| Default  | haiku               |
| Enum     | haiku, sonnet, opus |

Model used for tasks classified as simple tier (low file count, no dependencies).

### execution.modelByTier.medium

| Property | Value               |
| -------- | ------------------- |
| Type     | string              |
| Default  | sonnet              |
| Enum     | haiku, sonnet, opus |

Model used for tasks classified as medium tier.

### execution.modelByTier.complex

| Property | Value               |
| -------- | ------------------- |
| Type     | string              |
| Default  | opus                |
| Enum     | haiku, sonnet, opus |

Model used for tasks classified as complex tier (many files or deep dependency chains).

### execution.maxTurnsSimple

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 40     |
| Min      | 10     |
| Max      | 200    |

Max turns for simple/haiku-tier tasks.

### execution.maxTurnsMedium

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 60     |
| Min      | 20     |
| Max      | 200    |

Max turns for medium/sonnet-tier tasks.

### execution.maxTurnsComplex

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 80     |
| Min      | 20     |
| Max      | 200    |

Max turns for complex/opus-tier tasks.

---

## Dependencies

### dependencies.prMergeTimeout

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 45     |
| Min      | 5      |
| Max      | 180    |

Minutes to wait for dependency PR to merge.

### dependencies.pollInterval

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 60     |
| Min      | 10     |
| Max      | 300    |

Seconds between merge status polls.

---

## Observability

### observability.auditLog

| Property | Value   |
| -------- | ------- |
| Type     | boolean |
| Default  | true    |

Enable tamper-evident audit logging of all tool uses.

### observability.metricsExport

| Property | Value        |
| -------- | ------------ |
| Type     | string       |
| Default  | json         |
| Enum     | json, sqlite |

Metrics storage format.

### observability.metricsRetentionDays

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 90     |
| Min      | 7      |
| Max      | 365    |

Days to retain metrics data.

---

## Quota Management

### quota.wallBudgetMin

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 30     |
| Min      | 5      |
| Max      | 120    |

Maximum accumulated pause time (in minutes) before the quota gate surfaces a human gate. When rate limits force the pipeline to sleep, pause time accumulates in `.circuit_breaker.pause_minutes`. Once this budget is exhausted, further waits trigger `end_gracefully` rather than sleeping indefinitely.

### quota.sleepCapSec

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 540    |
| Min      | 60     |
| Max      | 1800   |

Maximum sleep duration per quota wait cycle (in seconds). The gate uses exponential back-off (120s base, doubling each cycle) capped at this value.

### quota.maxWaitCycles

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 60     |
| Min      | 1      |
| Max      | 200    |

Maximum consecutive wait cycles (utilization still over threshold) before `end_gracefully`. At default sleep cap of 540s, 60 cycles is approximately 9 hours.

### quota.maxStaleCycles

| Property | Value  |
| -------- | ------ |
| Type     | number |
| Default  | 6      |
| Min      | 1      |
| Max      | 20     |

Maximum consecutive stale-cache yields (statusline silent) before `end_gracefully`. At default intervals, 6 cycles is approximately 1 hour.

---

## Safety

Used by the `write-protection` and `secret-commit-guard` PreToolUse hooks. All three keys default to permissive values so the hooks no-op until a project opts in.

### safety.writeBlockedPaths

| Property | Value |
| -------- | ----- |
| Type     | array |
| Default  | `[]`  |

Glob patterns (bash globstar + extglob) of file paths that the write-protection hook must block. Evaluated on PreToolUse for `Edit`, `Write`, and `MultiEdit` tool calls. Empty by default; add entries like `"**/migrations/**"` or `".env*"` to opt into blocking.

### safety.useTruffleHog

| Property | Value   |
| -------- | ------- |
| Type     | boolean |
| Default  | false   |

When `true`, the secret-commit-guard hook runs `trufflehog filesystem --directory <cwd> --only-verified` before every `git commit` in addition to the built-in path and regex scans. Findings are filtered against `safety.allowedSecretPatterns`. If `trufflehog` is not installed the hook logs a warning and continues with regex-only scanning (does not block).

### safety.allowedSecretPatterns

| Property | Value |
| -------- | ----- |
| Type     | array |
| Default  | `[]`  |

Regex patterns (extended regex, evaluated by `grep -E`) for known-safe secret-like strings (e.g. Supabase anon keys, Stripe publishable keys). Any path-scan hit or TruffleHog finding whose raw value matches one of these patterns is filtered out before the hook decides whether to block a commit.

### safety.testWriterFixtureDirs

| Property | Value |
| -------- | ----- |
| Type     | array |
| Default  | `[]`  |

Additional directories the test-writer phase is allowed to write to. By default, only `tests/`, `__tests__/`, `fixtures/`, and files matching `*.test.*` / `*.spec.*` patterns are permitted during the `preexec_tests` stage. Add entries like `"test-fixtures"` or `"e2e/fixtures"` to extend the allowlist. Entries must be at least 2 characters, not start with `/` or `./`, and not contain `..`.

---

## Configuration Reading Semantics

### read_config vs read_config_strict

Two config reading functions exist in `pipeline-lib.sh`:

- **`read_config <key> [default]`** — Returns the value at `<key>`, or `default` if the key is missing or `null`.
- **`read_config_strict <key>`** — Returns the value at `<key>`, or empty string if the key is `null` or missing. Use when an explicit `null` in `config.json` should mean "unset" rather than "fall back to default".

This distinction matters for optional overrides where "not configured" and "explicitly disabled" are different states.
