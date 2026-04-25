# Debugging Code with /factory:debug

Use `/factory:debug` to run a reviewer-implementer loop against recent changes. The command drives iterative code review and fix cycles until the reviewer is satisfied, time runs out, or the implementer escalates.

## When to Use

- After manual code changes that need quality validation
- To address code review findings from an external reviewer
- To polish a feature branch before opening a PR

## Basic Usage

```
/factory:debug
```

Reviews the diff between `HEAD~1` and `HEAD`. Spawns the task-executor to fix any blocking findings. Repeats until clean or escalated.

## Flags

| Flag            | Default  | Description                                              |
| --------------- | -------- | -------------------------------------------------------- |
| `--base <ref>`  | `HEAD~1` | Git ref to diff against                                  |
| `--full`        | -        | Review entire codebase (empty-tree SHA as base)          |
| `--limit <s>`   | 0        | Soft time limit in seconds (0 = unlimited)               |
| `--fixSeverity` | `medium` | Minimum severity to address: critical, high, medium, all |

`--base` and `--full` are mutually exclusive.

## Reviewer Selection

The command detects the available reviewer once at the start:

1. **Codex** (preferred): If `codex` CLI is installed and authenticated, uses `pipeline-codex-review` for structured adversarial review.
2. **Claude Code** (fallback): Spawns the `quality-reviewer` agent and normalizes its output via `pipeline-parse-review` and `pipeline-debug-normalize`.

The choice is fixed for the entire run.

## Loop Behavior

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

| File                     | Description                            |
| ------------------------ | -------------------------------------- |
| `state.json`             | Run metadata: base, severity, deadline |
| `round-N.review.json`    | Normalized review findings for round N |
| `round-N.raw-review.txt` | Raw reviewer output (Claude branch)    |
| `round-N.executor.log`   | Executor final message                 |
| `escalation.md`          | Audit trail when escalated             |

## Example

Review the last 3 commits, fix only critical/high issues, with a 10-minute limit:

```
/factory:debug --base HEAD~3 --fixSeverity high --limit 600
```
