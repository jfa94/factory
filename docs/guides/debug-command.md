# Debugging Code with /factory:debug

Use `/factory:debug` to run a two-phase debugging workflow against recent changes. **Phase 0** is a one-shot all-hands sweep that fans out to architecture, security, quality, and implementation reviewer subagents in parallel (plus Codex when available, plus the orchestrator's own review), validates and deduplicates the findings, and ships a remediation plan to `task-executor`. **Phase 1** is the existing iterative reviewer-implementer loop, which runs until the reviewer is satisfied, time runs out, or the implementer escalates.

## When to Use

- After manual code changes that need quality validation
- To address code review findings from an external reviewer
- To polish a feature branch before opening a PR

## Basic Usage

```
/factory:debug
```

Reviews the diff between `HEAD~1` and `HEAD`. Runs the Phase 0 sweep first, applies its remediation plan, then enters the Phase 1 reviewer-implementer loop until clean or escalated.

## Flags

| Flag            | Default  | Description                                                                                   |
| --------------- | -------- | --------------------------------------------------------------------------------------------- |
| `--base <ref>`  | `HEAD~1` | Git ref to diff against                                                                       |
| `--full`        | -        | Review entire codebase (empty-tree SHA as base)                                               |
| `--limit <s>`   | 0        | Soft time limit in seconds (0 = unlimited)                                                    |
| `--fixSeverity` | `medium` | Minimum severity to address: critical, high, medium, all                                      |
| `--quick`       | -        | Skip Phase 0 (the all-hands sweep) and go straight to the Phase 1 reviewer ⇄ implementer loop |

`--base` and `--full` are mutually exclusive.

## Budget Gates

The skill checks the 5-hour API budget twice via `pipeline-quota-check` (see `docs/explanation/rate-limiting.md`). Crossing a low-budget threshold **pauses the run** until the next band is reached — it does not stop the factory. The only abort paths are quota-detection failure (telemetry broken — fail-closed) and the wait-cycle limit (default 60 cycles ≈ 9h, env: `FACTORY_DEBUG_BUDGET_MAX_CYCLES`).

1. **Before launch.** If `--quick` was passed, this check is skipped. Otherwise the 5h **remaining** percentage drives the response:
   - `≥ 40%` remaining: proceed (one-line notice if `< 60%`).
   - `20–40%` remaining: prompt the user via `AskUserQuestion`: "5h API budget at X% used (Y% left). Use --quick (skip Phase 0)?" — defaults to `Yes` if no answer.
   - `10–20%` remaining: enters a bounded **wait-and-retry loop** until `remaining ≥ 20%` (next band crossed), then re-evaluates the ladder.
   - `< 10%` remaining: enters a bounded **wait-and-retry loop** until `remaining ≥ 10%`, then re-evaluates.
   - Quota detection unavailable: aborts (fail-closed, matches the rest of the pipeline).
2. **Between Phase 0 and Phase 1.** Skipped when `--quick` was active. Otherwise:
   - `≥ 40%` remaining: proceed (one-line notice if `< 60%`).
   - `20–40%` remaining: print a notice; proceed into Phase 1.
   - `< 20%` remaining: enters the **wait-and-retry loop** until `remaining ≥ 20%`. Phase 0 results remain on disk throughout the wait.

The wait loop sleeps in chunks of ≤ 9 minutes (Bash 10-min cap), re-runs `pipeline-quota-check` after each chunk, and tracks cumulative wait minutes + cycles in `state.json`. Pause time is excluded from `--limit`.

## Reviewer Selection

The command detects the available reviewer once at the start:

1. **Codex** (preferred): If `codex` CLI is installed and authenticated, uses `pipeline-codex-review` for structured adversarial review and includes Codex in the Phase 0 sweep.
2. **Claude Code** (fallback): Spawns the `quality-reviewer` agent for the Phase 1 loop and normalizes its output via `pipeline-parse-review` and `pipeline-debug-normalize`. Phase 0 runs without the Codex slot.

The choice is fixed for the entire run.

## Phase 0 — All-Hands Sweep

Runs once, before the Phase 1 loop. Designed as an exhaustive first pass:

1. **Parallel reviewer fan-out** (single assistant message, multiple `Agent` tool calls):
   - `architecture-reviewer` — module boundaries, dependency direction, AI architectural anti-patterns
   - `security-reviewer` — OWASP Top 10, framework-specific risks, AI insecure defaults
   - `quality-reviewer` — adversarial code quality, logic errors, test quality
   - `implementation-reviewer` — apparent intent of the diff vs what was implemented
   - **Codex sweep** (only when `reviewer == codex`) — runs in the same message via background `Bash`
2. **Orchestrator self-review** — exhaustive line-by-line read of the diff, covering anything the specialists would not natively catch.
3. **Validate + dedupe + classify** every finding as `confirmed | dismissed | uncertain` against (a) the actual code and (b) the apparent intent of the diff. Output: `phase0/findings.json`.
4. **Build the remediation plan** from confirmed + in-threshold findings. Output: `phase0/plan.md`.
5. **Execute the plan** via a single `task-executor` invocation. Output: `phase0/executor.log`.

Phase 0 executor STATUS handling:

- `DONE` / `DONE_WITH_CONCERNS` — proceed to the between-phases gate, then Phase 1.
- `NEEDS_CONTEXT` — **falls through to Phase 1.** The iterative loop is designed to surface and resolve missing context; halting here would waste the rest of the budget.
- `BLOCKED — escalate: <reason>` — write audit trail and halt with `STATUS: ESCALATED`.
- `BLOCKED` (other) — halt with `STATUS: BLOCKED — phase 0 executor blocked`.

Phase 0 is skipped entirely when `--quick` is set (either by the user or forced by the budget gate).

## Phase 1 — Reviewer ⇄ Implementer Loop

Each round:

1. Run the reviewer against the diff
2. Filter findings by `--fixSeverity` threshold
3. If no blocking findings: exit with `STATUS: CLEAN`
4. Spawn `task-executor` to verify and fix findings
5. If executor returns `BLOCKED -- escalate: <reason>`: write audit trail, exit with `STATUS: ESCALATED`
6. Otherwise: increment round, repeat

## Severity Mapping

| Level      | Includes                         |
| ---------- | -------------------------------- |
| `critical` | critical only                    |
| `high`     | critical, high                   |
| `medium`   | critical, high, medium (default) |
| `all`      | critical, high, medium, low      |

Findings below the threshold are counted but not addressed.

## Escalation

When the executor cannot resolve a finding (e.g., architectural flaw outside scope), it returns:

```
STATUS: BLOCKED -- escalate: <reason>
```

The skill then:

1. Runs `pipeline-debug-escalate` to write an audit trail (`escalation.md`)
2. Prints `ESCALATED path=<path>` on stdout
3. Exits with `STATUS: ESCALATED` and includes the path in the final summary

## State Directory

All artifacts are persisted under:

```
${CLAUDE_PLUGIN_DATA}/debug/<run-id>/
```

Contents:

| File                            | Description                                                      |
| ------------------------------- | ---------------------------------------------------------------- |
| `state.json`                    | Run metadata: base, severity, deadline, reviewer                 |
| `phase0/architecture.raw.txt`   | Raw output from the architecture-reviewer subagent               |
| `phase0/security.raw.txt`       | Raw output from the security-reviewer subagent                   |
| `phase0/quality.raw.txt`        | Raw output from the quality-reviewer subagent                    |
| `phase0/implementation.raw.txt` | Raw output from the implementation-reviewer subagent             |
| `phase0/orchestrator.raw.txt`   | Orchestrator's own line-by-line review                           |
| `phase0/codex.raw.txt`          | Raw Codex sweep output (when `reviewer == codex`)                |
| `phase0/findings.json`          | Validated, deduped, classified catalogue of all Phase 0 findings |
| `phase0/plan.md`                | Remediation plan (confirmed + in-threshold items only)           |
| `phase0/executor.log`           | Phase 0 executor final message                                   |
| `round-N.review.json`           | Normalized review findings for Phase 1 round N                   |
| `round-N.raw-review.txt`        | Raw reviewer output for Phase 1 round N (Claude branch)          |
| `round-N.executor.log`          | Phase 1 executor final message for round N                       |
| `escalation.md`                 | Audit trail when escalated                                       |

## Example

Review the last 3 commits, fix only critical/high issues, with a 10-minute limit:

```
/factory:debug --base HEAD~3 --fixSeverity high --limit 600
```
