# Components

This document provides a detailed inventory of all plugin components: agents, hooks, bin scripts, commands, skills, and MCP servers.

## Plugin File Structure

```
factory-plugin/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest (name, version, description)
├── commands/
│   ├── run.md                   # /factory:run entry point
│   └── configure.md             # /factory:configure settings editor
├── agents/
│   ├── spec-generator.md        # PRD to spec conversion
│   ├── task-executor.md         # Code generation in worktree
│   └── implementation-reviewer.md         # Adversarial code review
├── skills/
│   └── review-protocol/
│       └── SKILL.md             # Actor-Critic review methodology
├── hooks/
│   ├── hooks.json               # Hook definitions
│   ├── branch-protection.sh     # Block destructive git operations
│   ├── run-tracker.sh           # Audit logging
│   ├── stop-gate.sh             # Session end validation
│   └── subagent-stop-gate.sh    # Subagent artifact validation
├── bin/
│   └── (21 scripts)             # Deterministic pipeline utilities
├── servers/                     # (empty — orphaned MCP server removed in 0.3.5)
├── templates/
│   └── settings.autonomous.json # Safety settings for autonomous mode
├── settings.json                # Default permission grants
└── .mcp.json                    # MCP server configuration
```

---

## Commands

### `/factory:run`

Entry point for all pipeline invocations.

**Arguments:**

| Argument     | Required        | Default    | Description                                         |
| ------------ | --------------- | ---------- | --------------------------------------------------- |
| `mode`       | No              | `discover` | Operating mode: `discover`, `prd`, `task`, `resume` |
| `--issue`    | For `prd` mode  | -          | GitHub issue number                                 |
| `--task-id`  | For `task` mode | -          | Task ID to execute                                  |
| `--spec-dir` | For `task` mode | -          | Path to spec directory                              |
| `--strict`   | No              | -          | Require [PRD] marker on issues                      |
| `--dry-run`  | No              | -          | Validate without executing                          |

**Behavior:**

1. Check `FACTORY_AUTONOMOUS_MODE` environment variable
2. Run `pipeline-validate` to check preconditions
3. Parse mode and validate arguments
4. Initialize run state via `pipeline-init`
5. Create a dedicated orchestrator worktree at `.claude/worktrees/orchestrator-<run_id>/` and run the full orchestration inline in the invoking session — spec generation, task execution, adversarial review, PR creation, and cleanup. The command itself is the control loop; sub-agents (`spec-generator`, `task-executor`, reviewers, `scribe`) are spawned via `Agent()` with `isolation: worktree` from the main session.

### `/factory:debug`

Reviewer-implementer loop for iterative code quality fixes.

**Arguments:**

| Argument        | Required | Default  | Description                                              |
| --------------- | -------- | -------- | -------------------------------------------------------- |
| `--base`        | No       | `HEAD~1` | Git ref to diff against                                  |
| `--full`        | No       | -        | Review entire codebase (empty-tree SHA as base)          |
| `--limit`       | No       | 0        | Soft time limit in seconds (0 = unlimited)               |
| `--fixSeverity` | No       | `medium` | Minimum severity to address: critical, high, medium, all |

**Behavior:**

1. Detect available reviewer (Codex or Claude Code fallback)
2. Review diff between base and HEAD
3. Filter findings by severity threshold
4. If blocking findings exist, spawn `task-executor` to fix them
5. Repeat until clean, escalated, or time limit reached
6. Write audit trail on escalation

### `/factory:configure`

Conversational settings editor.

**Behavior:**

1. Load current config from `${CLAUDE_PLUGIN_DATA}/config.json`
2. Load defaults from `plugin.json`
3. Present settings grouped by category
4. Validate and apply changes
5. Validate changes against schema

---

## Agents

### Orchestrator (main session via `commands/run.md`)

The orchestrator is not a sub-agent — it is the main Claude Code session that invoked `/factory:run`. The command body at `commands/run.md` encodes the full control loop: DAG iteration, sub-agent spawning, retry logic, review rounds, and human escalation.

**Why main-session, not sub-agent?** Claude Code only exposes the `Agent` tool to the top-level session. A sub-agent cannot itself spawn further sub-agents, so an orchestrator-as-agent deadlocks the first time it needs to dispatch a `spec-generator` or `task-executor`.

**Isolation.** Step 6a of `commands/run.md` creates a dedicated worktree at `.claude/worktrees/orchestrator-<run_id>/` and runs every orchestrator git operation inside it. The user's primary checkout is never touched. Sub-agents (`spec-generator`, `task-executor`, reviewers, `scribe`) continue to run with `isolation: worktree` as before.

**Key behaviors:**

- Delegates all deterministic work to `bin/pipeline-*` scripts
- Makes judgment calls: retry vs skip, escalate vs continue
- Spawns concurrent task-executors via multiple `Agent()` calls in one assistant message
- Manages review rounds and human escalation

### spec-generator

Converts a PRD issue body into a spec directory with `spec.md` and `tasks.json`.

| Property  | Value       |
| --------- | ----------- |
| Model     | opus        |
| Max Turns | 60          |
| Isolation | worktree    |
| Skills    | prd-to-spec |

**Key behaviors:**

- Skips step 5 (user quiz) in autonomous mode
- Validates output via `pipeline-validate-spec`
- Spawns `spec-reviewer` for quality validation
- Completes handoff protocol to transfer spec across worktree boundary

### task-executor

Implements a single task from the spec in an isolated worktree.

| Property  | Value                                          |
| --------- | ---------------------------------------------- |
| Model     | sonnet (default, overridden by classification) |
| Max Turns | 60 (default, overridden by classification)     |
| Isolation | worktree                                       |

**Model/turns by complexity:**

| Tier    | Model  | Max Turns |
| ------- | ------ | --------- |
| Simple  | haiku  | 40        |
| Medium  | sonnet | 60        |
| Complex | opus   | 80        |

**Key behaviors:**

- Reads spec and task context
- Implements code changes
- Writes tests (property-based where applicable)
- Runs tests and auto-fixes failures (max 3 attempts)
- Commits with task_id reference

### implementation-reviewer

Fresh-context adversarial code review with structured verdicts.

| Property  | Value                        |
| --------- | ---------------------------- |
| Model     | sonnet                       |
| Max Turns | 25                           |
| Skills    | review-protocol              |
| Tools     | Read, Grep, Glob (read-only) |

**Key behaviors:**

- Reviews with zero implementation context
- Follows Actor-Critic adversarial posture
- Validates acceptance criteria with file:line evidence
- Validates holdout criteria (criteria executor did not see)
- Outputs structured verdict: APPROVE, REQUEST_CHANGES, or NEEDS_DISCUSSION

### architecture-reviewer

Validates architectural compliance: module boundaries, dependency direction, coupling metrics, AI-specific anti-patterns.

| Property       | Value                  |
| -------------- | ---------------------- |
| Model          | sonnet                 |
| Max Turns      | 25                     |
| Tools          | Read, Bash, Grep, Glob |
| permissionMode | plan (read-only)       |

**Key behaviors:**

- Checks dependency-cruiser / eslint-plugin-boundaries rules if configured; falls back to manual import-graph scan
- Detects god objects (>300 lines or >15 exports), circular imports, leaky abstractions
- Flags AI anti-patterns: over-engineering, barrel file abuse, swallowed errors, hallucinated packages
- Spawned for feature-tier and security-tier tasks

### security-reviewer

Audits code for security vulnerabilities following OWASP Top 10 and AI-specific insecure defaults.

| Property       | Value                  |
| -------------- | ---------------------- |
| Model          | opus                   |
| Max Turns      | 25                     |
| Tools          | Read, Grep, Glob, Bash |
| permissionMode | plan (read-only)       |

**Key behaviors:**

- Traces all user-input sources to sinks (SQL, HTML, shell, file paths, redirects)
- Checks auth/authz: IDOR prevention, ownership verification, RLS (if Supabase), JWT validation
- Scans for hardcoded secrets using pattern + Shannon-entropy analysis
- Verifies new dependencies exist (no typosquatting, no hallucinated subpath imports)
- Checks AI-specific insecure defaults: wildcard CORS, Math.random() for crypto, disabled TLS, missing rate limits
- Spawned for security-tier tasks only

### test-writer

Writes behavioral tests from specifications and type signatures, never from implementation. Kills mutation testing survivors.

| Property  | Value                               |
| --------- | ----------------------------------- |
| Model     | opus                                |
| Max Turns | 30                                  |
| Tools     | Read, Write, Edit, Bash, Grep, Glob |

**Key behaviors:**

- Derives expected values from specs, type signatures, and JSDoc — never from reading implementation
- Writes AAA-structured tests with specific value assertions (no tautological or presence-only assertions)
- Writes property-based tests (fast-check) for pure functions and data transformations
- In Phase 5: receives Stryker surviving-mutants report, writes targeted tests to kill each survivor
- Spawned by orchestrator when mutation score < `quality.mutationScoreTarget`

### scribe

Incrementally updates `/docs` after each pipeline run using the Diátaxis framework.

| Property  | Value                               |
| --------- | ----------------------------------- |
| Model     | claude-opus-4-5                     |
| Tools     | Read, Grep, Glob, Bash, Write, Edit |
| Isolation | worktree                            |

**Key behaviors:**

- Reads `<!-- last-documented: <hash> -->` from the first line of `docs/README.md` to determine which commits are new
- Runs `git diff <hash>..HEAD --name-only` and scopes updates to changed files and their dependents
- Produces only sections it can fill accurately — never speculates or creates placeholders
- Rewrites the last-documented marker to current HEAD on completion
- Spawned as the final enforced step of every pipeline run, before `pipeline-cleanup`

**Path scope enforcement:**

When `FACTORY_SUBAGENT_ROLE=scribe`, the `pretooluse-pipeline-guards.sh` hook restricts Edit/Write/MultiEdit to:

- `docs/**` or `/docs/**`
- Version-bump files: `package.json`, `plugin.json`, `pyproject.toml`, `Cargo.toml`, `VERSION`, `.version`
- Root `README.md` (kept as a short intro + link to `/docs`)

Bash write-equivalent operations (redirections, `tee`, `cp`, `mv`, `mkdir`, `touch`, `dd of=`) are also scoped. If the target path cannot be determined, the hook fails closed.

### spec-reviewer

Validates spec output before task execution begins.

| Property  | Value            |
| --------- | ---------------- |
| Model     | sonnet           |
| Max Turns | 20               |
| Tools     | Read, Grep, Glob |

**Key behaviors:**

- Reviews with fresh context — did not write the spec
- Scores across 6 dimensions: granularity, deps, criteria, tests, vertical slices, alignment
- Returns structured PASS/NEEDS_REVISION verdict (score >= 54/60 required)
- Spawned by spec-generator; failure triggers regeneration (max 5 iterations)

### quality-reviewer

Fresh-context code review with semi-formal reasoning and structured findings.

| Property  | Value            |
| --------- | ---------------- |
| Model     | sonnet           |
| Max Turns | 25               |
| Skills    | review-protocol  |
| Tools     | Read, Grep, Glob |

**Key behaviors:**

- Reviews cold (zero implementation context)
- Uses evidence-first grounding: every finding quotes the code
- Signal-over-noise filtering: scores likelihood × impact, drops low-signal findings
- Output is structured and parseable by `pipeline-parse-review`
- Spawned for security-tier tasks alongside implementation-reviewer

---

## Skills

### debug

Drives the `/factory:debug` reviewer-implementer loop. Handles reviewer detection, round iteration, severity filtering, and escalation.

**Key behaviors:**

- Detects reviewer once (Codex or Claude Code) and uses it for all rounds
- Persists review artifacts and executor logs per round
- Enforces Iron Law: every round commits a review artifact before spawning executor
- Writes escalation audit trail when executor cannot resolve findings

### rescue-protocol

Orchestrates recovery of pipeline runs with complex issues. Sequences scan, auto-apply, user approval, diagnostic agent dispatch, and handoff to resume.

**Key behaviors:**

- Runs `pipeline-ensure-autonomy` first
- Auto-applies tier-1 fixes without prompting
- Batch-approves tier-2/3 fixes via `AskUserQuestion`
- Dispatches `rescue-diagnostic` agent in parallel for failed tasks
- Hands off to `pipeline-orchestrator` skill with `mode=resume`
- Never edits state.json directly — all writes go through `pipeline-state`

### review-protocol

Injects Actor-Critic adversarial review methodology into any reviewer.

**Checklist:**

- Correctness: edge cases, error paths, return types
- Security: OWASP Top 10, input validation, secrets exposure
- Test quality: meaningful assertions, failure mode coverage
- AI anti-patterns: hallucinated APIs, over-abstraction, copy-paste drift, dead code, tautological tests
- Performance: algorithmic complexity, missing pagination, memory leaks

**Verdict rules:**

- `APPROVE`: Zero blocking findings AND all acceptance criteria pass
- `REQUEST_CHANGES`: Any blocking finding OR any criterion fails
- `NEEDS_DISCUSSION`: Ambiguity requiring human judgment

---

## Hooks

Defined in `hooks/hooks.json`. All hooks fire for all plugin agents.

### branch-protection (PreToolUse)

Blocks destructive git operations on protected branches (main, master, develop, staging, production, release, prod).

**Blocked operations:**

- Push to protected branch (direct or via refspec)
- Force push to protected branch
- Delete protected branch (local or remote)
- Hard reset to protected branch

**Exit codes:**

- 0: Allow operation
- 2: Block operation (JSON reason on stderr)

### pretooluse-pipeline-guards (PreToolUse)

Enforces pipeline invariants during active runs. Only fires when `${CLAUDE_PLUGIN_DATA}/runs/current` is present.

**Invariants enforced:**

1. **`gh pr create`** — requires ship checklist at `.tasks/<task>.ship_checklist.json` with `tdd_gate`, `coverage_gate`, `quality_gate`, and `review_blockers_resolved` all passing. In autonomous mode, missing checklist = denied.
2. **`gh pr merge`** — requires `.tasks.<task>.pr_number` and `ci_status == "green"`.
3. **`pipeline-state task-status <run> <task> done`** — requires `.worktree`, `.quality_gate.ok`, and `.pr_number` all set. In autonomous mode, cross-run writes (target run ≠ active run) are denied outright.
4. **Broken `runs/current` symlink** — if the symlink exists but its target is missing, the hook fails closed with a deny rather than silently passing through. This prevents operations on corrupted pipeline state.
5. **Nested-shell / hook-bypass** — in autonomous mode, commands that would spawn a subshell or bypass hooks are denied.
6. **Test-writer path scope** — during `preexec_tests` stage, Edit/Write/MultiEdit are restricted to test files and configured fixture directories.
7. **Scribe path scope** — when `FACTORY_SUBAGENT_ROLE=scribe`, writes are restricted to `/docs/**` and version-bump files.

### session-start-resume (SessionStart)

Injects current run stage snapshot into resume sessions.

**Triggers:** Sessions with `source=resume`.

**Behavior:**

- Reads `runs/current` symlink and state file
- Skips if run status is already terminal (`done`, `completed`, `failed`, `partial`)
- Builds per-task stage summary (task_id, status, current stage)
- Computes next action: maps `*_done` stages to the following stage (e.g., `preflight_done` → `preexec_tests`, `postexec_done` → `postreview`)
- Exports `FACTORY_CURRENT_RUN` via `$CLAUDE_ENV_FILE` for subsequent Bash calls
- Outputs `additionalContext` with the stage snapshot and next `pipeline-run-task` invocation

### run-tracker (PostToolUse)

Append-only audit logging during active pipeline runs.

**Triggers:** Bash, Write, Edit tool uses

**Writes to:** `${CLAUDE_PLUGIN_DATA}/runs/<run-id>/audit.jsonl`

**Tamper-evidence:** Each entry includes SHA256 hash chain linking to previous entry. Reordering or deletion is detectable via `--verify` mode.

### stop-gate (Stop)

Validates state consistency when agent session ends.

**Behavior:**

- Checks for incomplete state transitions
- Marks interrupted runs in state
- Removes `runs/current` symlink on clean exit

### subagent-stop-gate (SubagentStop)

Validates subagent artifacts on completion.

**Behavior:**

- Verifies expected output files exist
- Records completion status in parent state

---

## Bin Scripts

All scripts live in `bin/`. They source `pipeline-lib.sh` for shared functions.

### Core Scripts

| Script              | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `pipeline-lib.sh`   | Shared library: logging, config, state shortcuts, utilities |
| `pipeline-validate` | Project precondition checks                                 |
| `pipeline-init`     | Create run state tracking files                             |
| `pipeline-state`    | Read/write task status, dep satisfaction                    |
| `pipeline-lock`     | Acquire/release directory lock                              |
| `pipeline-run-task` | Stage-machine wrapper for task/finalize lifecycle           |

### Input & Discovery

| Script                    | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `pipeline-fetch-prd`      | Fetch PRD body from GitHub issue                    |
| `pipeline-validate-spec`  | Validate spec output files                          |
| `pipeline-validate-tasks` | Field validation, cycle detection, topological sort |

### Task Execution

| Script                     | Purpose                                            |
| -------------------------- | -------------------------------------------------- |
| `pipeline-branch`          | Branch creation, worktree operations, staging init |
| `pipeline-classify-task`   | Complexity classification (model/turns)            |
| `pipeline-classify-risk`   | Risk tier (routine/feature/security)               |
| `pipeline-build-prompt`    | Template task metadata into structured prompt      |
| `pipeline-circuit-breaker` | Check runtime/consecutive-failures thresholds      |

### Review & Quality

| Script                     | Purpose                                          |
| -------------------------- | ------------------------------------------------ |
| `pipeline-detect-reviewer` | Check Codex availability, return reviewer config |
| `pipeline-codex-review`    | Codex exec wrapper for adversarial review        |
| `pipeline-parse-review`    | Extract structured verdict from reviewer output  |
| `pipeline-coverage-gate`   | Compare coverage before/after, block decreases   |

### Rate Limiting

| Script                    | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `statusline-wrapper.sh`   | Capture rate limits from Claude Code statusline                 |
| `pipeline-quota-check`    | Read usage-cache.json, compute window position                  |
| `pipeline-model-router`   | Return proceed/wait/end_gracefully action based on quota        |
| `pipeline-quota-gate-cli` | Thin CLI around `pipeline_quota_gate` for skill-side invocation |

### Completion

| Script                | Purpose                                        |
| --------------------- | ---------------------------------------------- |
| `pipeline-wait-pr`    | Poll for PR merge with CI/conflict handling    |
| `pipeline-gh-comment` | Post comments and labels to GitHub issues      |
| `pipeline-summary`    | Aggregate run results into execution summary   |
| `pipeline-cleanup`    | Delete branches, close issues, clean worktrees |
| `pipeline-scaffold`   | Create project scaffolding files               |

---

## Metrics

Pipeline execution metrics are written to `$run_dir/metrics.jsonl` (one JSONL line per event) by the `log_metric` helper in `bin/pipeline-lib.sh`. Every event carries `ts`, `run_id`, and `event` fields plus optional key-value pairs. Events of note: `run.start`, `run.summary`, `task.start`, `task.end`, `task.executor_spawned`, `task.gate.quality`, `task.gate.coverage`, `task.coverage.snapshot`, `task.review.provider`, `task.pr_created`, `pipeline.step.begin/end`, `quota.check`, `quota.wait`, `quota.env_misalignment`, `circuit_breaker`. `quota.check` carries an `action` field (`proceed | wait | end_gracefully | stale_yield`) so the scorer can distinguish over-threshold yields from stale-cache yields. The scorer (`bin/pipeline-score`) reads this file to derive run quality scores.

The MCP metrics server (`servers/pipeline-metrics/`) was removed in version 0.3.5 as it was orphaned and unused. Metrics are now written directly to JSONL files.

---

## Templates

### settings.autonomous.json

Bundled safety settings for autonomous operation. Includes:

- `FACTORY_AUTONOMOUS_MODE=1` environment variable
- Explicit `allow` list for safe commands
- Comprehensive `deny` list blocking destructive operations
- Hooks for .claude/ directory protection, branch protection, dangerous patterns, SQL safety, pre-commit checks, and auto-formatting
