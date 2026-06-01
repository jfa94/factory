# Commands

Specification for all plugin commands.

## /factory:run

Entry point for pipeline invocations.

### Arguments

| Argument          | Required         | Default    | Description                                                                                                                 |
| ----------------- | ---------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| `mode`            | No               | `discover` | Operating mode: `discover`, `prd`, `task`, `resume`                                                                         |
| `--issue`         | For `prd` mode   | -          | GitHub issue number                                                                                                         |
| `--task-id`       | For `task` mode  | -          | Task ID to execute                                                                                                          |
| `--spec-dir`      | For `task` mode  | -          | Path to spec directory                                                                                                      |
| `--strict`        | No               | -          | Require `[PRD]` marker on issues                                                                                            |
| `--dry-run`       | No               | -          | Validate without executing                                                                                                  |
| `--allow-7d-over` | Resume mode only | -          | Bypasses the 7-day usage circuit breaker for this run. Writes `.flags.allow_7d_over` to run state. Cleared on run finalize. |

### Modes

**discover**

```
/factory:run discover
```

Finds all open issues with `[PRD]` marker and processes them.

**prd**

```
/factory:run prd --issue 42
```

Processes a single PRD issue.

**task**

```
/factory:run task --task-id task_03 --spec-dir .state/run-20260413-140000
```

Executes a single task from an existing spec.

**resume**

```
/factory:run resume
```

Continues an interrupted run from the last checkpoint.

### Execution Flow

1. Check `FACTORY_AUTONOMOUS_MODE` environment variable. If unset, materialize `$CLAUDE_PLUGIN_DATA/merged-settings.json` from the bundled template and prompt the user. **Recommended path:** relaunch with `claude --settings $CLAUDE_PLUGIN_DATA/merged-settings.json` — loads hooks + permissions. **Advanced / CI path:** set `FACTORY_AUTONOMOUS_MODE=1` to bypass the acknowledgment check only — hooks and permissions are **not** loaded.
2. Run `pipeline-validate --no-clean-check` to verify preconditions
3. Parse mode and validate arguments
4. Initialize run state via `pipeline-init`
5. Create a dedicated orchestrator worktree at `.claude/worktrees/orchestrator-<run_id>/` and run the full orchestration inline in the invoking session (spec generation, task execution, adversarial review, PR creation, cleanup). Sub-agents are spawned from this session via `Agent()` with `isolation: worktree`.

### Exit Behavior

The orchestration runs to completion inside the invoking session — there is no separate orchestrator sub-agent to wait on. Check run status in `${CLAUDE_PLUGIN_DATA}/runs/current/state.json`.

---

## /factory:debug

Reviewer-implementer loop for iterative code quality fixes.

### Arguments

| Argument        | Required | Default  | Description                                                      |
| --------------- | -------- | -------- | ---------------------------------------------------------------- |
| `--base`        | No       | `HEAD~1` | Git ref to diff against (mutually exclusive with --full)         |
| `--full`        | No       | -        | Review entire codebase (empty-tree SHA as base)                  |
| `--limit`       | No       | 0        | Soft time limit in seconds (0 = unlimited)                       |
| `--fixSeverity` | No       | `medium` | Minimum severity to address: `critical`, `high`, `medium`, `all` |
| `--quick`       | No       | -        | Skip Phase 0 all-hands sweep; go straight to Phase 1 loop        |

### Execution Flow

**Phase 0 — All-hands sweep (parallel fan-out):**

1. Dispatch `architecture-reviewer`, `security-reviewer`, `quality-reviewer`, `implementation-reviewer` in parallel + optional Codex review.
2. Orchestrator performs its own exhaustive diff review.
3. Validate, deduplicate, and classify findings (`confirmed | dismissed | uncertain`).
4. Build remediation plan; spawn `task-executor` to implement it.

**Phase 1 — Reviewer ⇄ Implementer loop:**

5. Review diff between base and HEAD.
6. Filter findings by `--fixSeverity`.
7. If blocking findings exist, spawn `task-executor` to fix them.
8. Repeat until clean, escalated, or `--limit` reached.

Requires autonomous session (`claude --settings <merged-settings.json>` or `FACTORY_AUTONOMOUS_MODE=1`). Budget is checked before Phase 0 and between phases via `pipeline-quota-check`.

---

## /factory:scaffold

One-time project bootstrap for the factory pipeline. Run before any `/factory:run` in a new repository.

### Arguments

None.

### Execution Flow

1. Confirm `cwd` is a git repository (`git rev-parse --show-toplevel`).
2. Run `pipeline-scaffold "$PROJECT_ROOT"` to create (idempotently):
   - `claude-progress.json`, `feature-status.json` (progress tracking)
   - `init.sh` (per-run setup hook)
   - `.github/workflows/quality-gate.yml` (CI template)
   - `.stryker.config.json`, `.dependency-cruiser.cjs` (quality gate configs)
3. Apply surgical workflow migrations for post-release fixes (names any patched files).
4. Evaluate tool dependencies: prompt before installing the optional **TruffleHog** secret scanner (never auto-installed); verify the hard deps `gh` and `jq` (error out if missing). Stryker and dependency-cruiser are not installed here — their configs are written as files in step 2.
5. Report newly created files vs already-present files, and any migrations applied.

---

## /factory:rescue

Recover a pipeline run from complex issues that `/factory:run resume` cannot handle: merge conflicts, unmerged PRs, orphan branches, failed tasks, review deadlocks, state corruption. Produces a clean state that resume picks up naturally.

### Arguments

| Argument             | Required | Default | Description                                                           |
| -------------------- | -------- | ------- | --------------------------------------------------------------------- |
| `--dry-run`          | No       | -       | Scan and report only; skip auto-apply and user prompts                |
| `--include-fixtures` | No       | -       | Include test-fixture-named runs (e.g., `run-wrapper-*`) in the picker |

### Execution Flow

1. Run `pipeline-ensure-autonomy` to verify session settings
2. Select target run (current symlink, newest run, archived runs, or user pick)
3. If run is archived, rehydrate it via `pipeline-rescue-apply --action=rehydrate-archived-run`
4. Run `pipeline-rescue-scan` to detect issues
5. Auto-apply tier-1 fixes (safe, always idempotent)
6. Batch-approve tier-2 and tier-3 fixes via user prompt
7. Apply approved mechanical fixes
8. For failed tasks, dispatch read-only `rescue-diagnostic` agent in parallel
9. Batch-approve investigation remediation plans
10. Apply approved plans
11. Invoke `pipeline-orchestrator` skill with `mode=resume`

### Issue Taxonomy

Issues are classified into tiers by required approval:

| Tier | Approval   | Examples                                      |
| ---- | ---------- | --------------------------------------------- |
| 1    | Auto-apply | stale lock, orphan worktree, backfill PR URL  |
| 2    | Batch      | merge conflict, closed PR, CI red, stuck task |
| 3    | Batch      | duplicate PRs, state malformed, spec drift    |
| N/A  | Agent      | failed tasks flagged for investigation        |

### State Directory

Rescue artifacts persist under:

```
${CLAUDE_PLUGIN_DATA}/runs/<run-id>/rescue/
```

Contents:

| File                            | Description                  |
| ------------------------------- | ---------------------------- |
| `report-<ts>.json`              | Scan output                  |
| `approved-mechanical-<ts>.json` | Approved tier-2/3 fixes      |
| `diagnostic.<task>.input.json`  | Input to diagnostic agent    |
| `diagnostic.<task>.output.json` | Diagnostic agent decision    |
| `approved-plans-<ts>.json`      | Approved investigation plans |

---

## /factory:configure

Interactive settings editor.

### Arguments

| Argument  | Required | Default | Description                                     |
| --------- | -------- | ------- | ----------------------------------------------- |
| `setting` | No       | -       | Setting to configure (e.g., `humanReviewLevel`) |

### Execution Flow

1. Load current config from `${CLAUDE_PLUGIN_DATA}/config.json`
2. Merge with built-in defaults (compiled as `read_config '<key>' '<default>'` fallbacks in the bin scripts; canonical reference is `docs/reference/configuration.md`)
3. Present settings grouped by category
4. Validate and apply changes

### Interactive Mode

When invoked without arguments, enters a conversational loop:

1. Shows current settings
2. Asks what to change
3. Applies and confirms each change
4. Offers to show updated settings

### Setting Categories

**Pipeline Control**

- `humanReviewLevel` - Autonomy level (0-4)

**Circuit Breaker**

- `maxRuntimeMinutes` - Max runtime (0 = unlimited)
- `maxConsecutiveFailures` - Max consecutive failures

**Review**

- `review.preferCodex` - Prefer Codex for review
- `review.routineRounds` - Routine tier rounds
- `review.featureRounds` - Feature tier rounds
- `review.securityRounds` - Security tier rounds

**Quality Gates**

- `quality.holdoutPercent` - Holdout percentage
- `quality.holdoutPassRate` - Holdout pass rate
- `quality.mutationScoreTarget` - Mutation score target
- `quality.mutationTestingTiers` - (deprecated, no-op — mutation runs unconditionally now)
- `quality.coverageMustNotDecrease` - Block coverage decreases

**Parallel Execution**

- `maxParallelTasks` - Max concurrent executors

### Validation

Settings are validated inline by the command against the ranges listed in `docs/reference/configuration.md` (not via a schema in `plugin.json` — no such schema exists):

- Numbers: checked against expected `min` / `max` (e.g. `humanReviewLevel` 0-4)
- Enums: checked against allowed values (e.g. `execution.defaultModel`)
- Booleans: must be `true` or `false`

Invalid values are rejected with an error message.

### Persistence

Settings persist to `${CLAUDE_PLUGIN_DATA}/config.json`. Run state is stored separately in `${CLAUDE_PLUGIN_DATA}/runs/`.
