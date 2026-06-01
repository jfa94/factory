# Bin Scripts

Reference for all deterministic pipeline utilities in `bin/`.

All scripts source `pipeline-lib.sh` for shared functions. Scripts output JSON where applicable and use exit codes for flow control.

---

## Core Scripts

### pipeline-lib.sh

Shared library sourced by all scripts.

**Plugin Data Directory Canonicalization:**

When a factory script is invoked from a bash block inside another plugin's command or hook chain, the inherited `CLAUDE_PLUGIN_DATA` can point at the wrong plugin's data directory and leak factory state (merged-settings.json, runs/, state/) into a foreign location. The library only rewrites paths under `~/.claude/plugins/data/`; temp dirs, custom paths, and unset values are left untouched. Within that root, the basename is checked against the plugin's manifest `name`:

1. If the basename starts with `<name>-` (or equals `<name>` exactly), the value is already ours — no rewrite. Covers `factory-<marketplace>` (cache installs) and `factory-inline` (inline installs).
2. Otherwise it is a foreign-plugin leak. The canonical id is derived from one of two sources:
   - **Cache-install layout** (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`): id = `<plugin>-<marketplace>` derived from the path.
   - **Dev checkout fallback**: id = `<manifest.name>-<marketplace>` where `marketplace` is read from `.claude-plugin/marketplace.json`.
3. Rewrites emit a `[WARN] pipeline-lib: CLAUDE_PLUGIN_DATA points at foreign plugin dir '<old>'; redirecting to '<new>'` line on stderr so leaks are visible in audit logs.

**Known leak source — codex plugin (`openai-codex/codex`):**
The `codex` plugin's `SessionStart` hook (`scripts/session-lifecycle-hook.mjs:78`) writes `export CLAUDE_PLUGIN_DATA=<codex's dir>` into `$CLAUDE_ENV_FILE`. Claude Code sources that file into the parent shell for every subsequent Bash tool call, pinning codex's data dir session-wide. Because `CLAUDE_PLUGIN_DATA` is meant to be scoped per-plugin by the Claude Code runtime, this promotion to session-global is a bug in the codex plugin. The correct fix is upstream: remove the `appendEnvVar(PLUGIN_DATA_ENV, ...)` call (or export under a private `CODEX_PLUGIN_DATA` name and update `scripts/lib/state.mjs` to read it). Factory's canonicalization guard above is the defensive safety net until the upstream fix ships. Issue draft staged at `docs/superpowers/plans/2026-05-26-codex-plugin-data-leak-issue.md` for filing at https://github.com/openai/codex-plugin-cc/issues.

**Functions:**

| Function                 | Description                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `require_plugin_data`    | Exit 1 if `CLAUDE_PLUGIN_DATA` env var unset; emits actionable error message       |
| `log_info`               | Log info message to stderr                                                         |
| `log_warn`               | Log warning message to stderr                                                      |
| `log_error`              | Log error message to stderr                                                        |
| `read_config`            | Read config value with default fallback                                            |
| `read_config_strict`     | Read config value; null/missing → empty (no default)                               |
| `atomic_write`           | Write file atomically via temp + mv                                                |
| `current_run_id`         | Get current run ID from symlink                                                    |
| `require_command`        | Exit if command not found                                                          |
| `slugify`                | Convert string to slug                                                             |
| `temp_file`              | Create temp file with cleanup trap                                                 |
| `detect_pkg_manager`     | Detect npm/yarn/pnpm/bun                                                           |
| `parse_iso8601_to_epoch` | Parse ISO timestamp to epoch seconds                                               |
| `resolve_base_ref`       | Resolve `staging` or `origin/staging` in a git dir; rc=1 if neither exists         |
| `is_test_path`           | Classify a file path as test (return 0) or non-test (return 1)                     |
| `task_tdd_exempt`        | Check if task has `tdd_exempt: true` in tasks.json                                 |
| `validate_findings`      | Validate review findings against diff (full-line match, rejects forged substrings) |
| `pipeline_quota_gate`    | Quota enforcement with sleep clamped to remaining wall-clock budget                |

---

### pipeline-validate

Pre-flight validation. Checks git, gh auth, required agents/skills, data directory.

**Usage:**

```bash
pipeline-validate [--strict] [--no-clean-check]
```

**Flags:**

| Flag               | Description                                 |
| ------------------ | ------------------------------------------- |
| `--strict`         | Check optional user-provided agents (scout) |
| `--no-clean-check` | Skip working tree clean check               |

**Checks:**

1. Git remote `origin` configured
2. Working tree clean (unless `--no-clean-check`)
3. `gh` CLI installed and authenticated
4. Required skill `prd-to-spec` present
5. `CLAUDE_PLUGIN_DATA` writable
6. Optional agents (with `--strict`)

**Output:**

```json
{
  "valid": true,
  "checks": [
    {"name": "git_remote", "status": "pass", "detail": "origin configured"},
    ...
  ]
}
```

**Exit codes:** 0=all pass, 1=failure

---

### pipeline-init

Initialize a new pipeline run. Creates directory structure, state.json, audit/metrics logs, symlink.

**Usage:**

```bash
pipeline-init <run-id> [--issue <N>] [--mode <mode>] [--force]
```

**Arguments:**

| Argument  | Required | Description                                                                       |
| --------- | -------- | --------------------------------------------------------------------------------- |
| `run-id`  | Yes      | Run identifier (e.g., `run-20260413-140000`). Must match `^[a-zA-Z0-9_-]{1,64}$`. |
| `--issue` | No       | GitHub issue number                                                               |
| `--mode`  | No       | Operating mode: discover, prd, task, resume                                       |
| `--force` | No       | Override active run symlink                                                       |

**Symlink atomicity:**

The `runs/current` symlink is updated atomically via `ln -sfn` to a temp link followed by `mv -fh` (BSD) or `mv -fT` (GNU). Observers never see the symlink missing during the swap.

**Post-init verification (added 0.10.2):**

After the symlink swap completes, the script re-checks that `runs/current` exists as a symlink and that `readlink` resolves to the just-created `run_dir`. A silent atomic-rename failure (e.g., cross-filesystem `mv` returning 0 without moving the link) is otherwise invisible — every downstream hook would then silent-exit because `$CLAUDE_PLUGIN_DATA/runs/current` is missing, hiding all state writes. On verification failure the script removes the run dir and exits 1 with a `log_error` describing the symlink state observed.

**Creates:**

```
${CLAUDE_PLUGIN_DATA}/runs/<run-id>/
├── state.json
├── audit.jsonl
├── metrics.jsonl
├── holdouts/
└── reviews/
```

**Output:**

```json
{
  "run_id": "run-20260413-140000",
  "state_path": "/path/to/state.json",
  "created": true
}
```

**Exit codes:** 0=success, 1=failure

---

### pipeline-state

State manager for pipeline runs.

**Usage:**

```bash
pipeline-state <action> <run-id> [args...]
```

**Actions:**

| Action           | Arguments                        | Description                                                    |
| ---------------- | -------------------------------- | -------------------------------------------------------------- |
| `read`           | `<run-id> [key]`                 | Read full state or jq key                                      |
| `write`          | `<run-id> <key> <value>`         | Atomic write to state key                                      |
| `task-init`      | `<run-id> <task-id> <task-json>` | Seed task record from tasks.json (idempotent)                  |
| `task-status`    | `<run-id> <task-id> <status>`    | Update task status                                             |
| `deps-satisfied` | `<run-id> <task-id>`             | Check if deps done                                             |
| `interrupted`    | `<run-id>`                       | Check if run interrupted                                       |
| `resume-point`   | `<run-id>`                       | Find first incomplete task                                     |
| `list`           | -                                | List all runs                                                  |
| `ensure-current` | `<run-id>`                       | Restore `runs/current` symlink (refuses to clobber active run) |

**task-init behavior:**

Seeds a task record with fields from a tasks.json row: `task_id`, `title`, `description`, `files`, `acceptance_criteria`, `tests_to_write`, `depends_on`. Idempotent: a second call merges on top of the existing record. The `<task-json>` argument must be a JSON object (arrays and scalars are rejected).

The caller is responsible for extracting individual task rows. `tasks.json` may be either a bare array `[ {task_id...}, ... ]` or an object wrapper `{ "tasks": [ ... ] }`; the orchestrator uses a type-aware jq idiom (`(if type == "array" then .[] else (.tasks // [])[] end)`) to handle both shapes consistently with `pipeline-run-task` (preflight, executor fallback) and `pipeline-codex-review`.

**Task statuses:** pending, executing, reviewing, done, failed, interrupted, needs_human_review, ci_fixing

**deps-satisfied fail-closed parsing:**

When the `state.json` file is unparseable (jq error), `deps-satisfied` now exits 2 with `log_error` on stderr instead of silently treating the failure as "no deps recorded → satisfied". Callers must distinguish:

- exit 0 — deps satisfied (proceed)
- exit 1 — deps not satisfied (wait)
- exit 2 — state.json parse failure (do NOT proceed; investigate)

`pipeline-run-task` treats any non-zero from `deps-satisfied` as "not ready" and short-circuits the task; the explicit exit-2 prevents a corrupt state from silently advancing a task whose deps cannot be evaluated.

**Exit codes:** 0=success/true, 1=failure/false, 2=state parse failure (deps-satisfied only)

**ensure-current behavior:**

Defensive restore of the `runs/current` symlink. Used by operator recovery and by `pipeline-init`'s post-init verification path when the symlink is found missing. Refuses to clobber a different run whose `state.json.status` is `"running"`, so the action is safe to call unconditionally. Atomic-rename via `mv -fh` (BSD) or `mv -fT` (GNU) of a `.tmp.$$` symlink to the target name. Emits `{"action":"ensure-current","run_id":...,"target":...,"restored":true}` on stdout.

Exits 1 when the run dir is absent or when the symlink already points at an active (`status=running`) run with a different `run_id`.

---

### pipeline-lock

Acquire/release directory lock. Prevents concurrent access to shared resources.

**Usage:**

```bash
pipeline-lock acquire <lock-name> [--timeout <seconds>]
pipeline-lock release <lock-name>
```

---

### pipeline-run-task

Stage-machine wrapper that drives a single task (or the run-level finalize step) through the pipeline protocol. Every validation, classification, state-write, quota-gate, quality-gate, coverage-gate, holdout, review dispatch, PR-open, CI-wait, and cleanup step lives inside this wrapper — the orchestrator LLM never names them.

**Usage:**

```bash
pipeline-run-task <run-id> <task-id> --stage <stage> [--worktree <path>] [--review-file <path>]... [--ci-status <green|red|timeout>]
pipeline-run-task <run-id> RUN --stage finalize-run
```

**Arguments:**

| Argument        | Required | Description                               |
| --------------- | -------- | ----------------------------------------- |
| `run-id`        | Yes      | Run identifier                            |
| `task-id`       | Yes      | Task ID (or `RUN` for finalize-run stage) |
| `--stage`       | Yes      | Stage to execute                          |
| `--worktree`    | No       | Path to task worktree                     |
| `--review-file` | No       | Path to reviewer output (repeatable)      |
| `--ci-status`   | No       | CI result: `green`, `red`, or `timeout`   |

**Stages:**

| Stage           | Purpose                                                               |
| --------------- | --------------------------------------------------------------------- |
| `preflight`     | Circuit breaker, dep check, classify, quota gate, test-writer         |
| `preexec_tests` | Red-test verification, then task-executor spawn                       |
| `postexec`      | Quality gate, security gate, TDD gate, coverage gate, holdout, review |
| `postreview`    | Parse verdicts, retry or advance                                      |
| `ship`          | Human gate, task-commit, PR create, CI wait                           |
| `finalize-run`  | Scribe spawn (isolation: worktree), final PR, cleanup                 |

**Postreview error handling:**

Malformed reviewer JSON now fails loud: writes `failure_reason` to state and blocks the task, instead of defaulting to 0 blockers. This prevents silent progression when review parsing fails.

**Terminal-failure status writes in postexec / postreview (added 0.10.3):**

When `_stage_postexec` and `_stage_postreview` reach a terminal failure path (e.g., review parse failure with no recoverable state, hard quality-gate fail with retries exhausted), the wrapper now writes `status=failed` to the task record before returning exit 30. Previously these paths returned 30 while leaving the task status at the prior in-flight value (`executing`, `reviewing`), producing a state that looked recoverable but was not. The explicit `failed` write makes the terminal classification visible to the orchestrator, rescue scan (I-16), and resume logic.

**ID validation:**

`run-id` and `task-id` are validated against `^[a-zA-Z0-9_-]{1,64}$` immediately after argument parsing (via `_validate_id` in `pipeline-lib.sh`). Invalid IDs exit 1 before any state read or worktree resolution. This blocks path-traversal and shell-meta payloads from reaching downstream `pipeline-state` and `git` calls.

**Sibling-binary resolution (PATH-shadow hardening):**

`pipeline-state` is invoked through `_STATE_BIN="$_SCRIPT_DIR/pipeline-state"` (an absolute path derived from `BASH_SOURCE`), not via PATH. This prevents a stale or malicious `pipeline-state` earlier on PATH (e.g. `~/bin`, a legacy plugin install) from intercepting state reads and writes for the current run. Other sibling bin tools (`pipeline-tdd-gate`, `pipeline-mutation-gate`, `pipeline-quality-gate`, etc.) remain PATH-resolved so test harnesses can stub them.

**Configurable reviewer model and turn limits:**

The wrapper reads `review.model`, `review.maxTurnsQuick`, `review.maxTurnsDeep`, `testWriter.maxTurns`, and `scribe.maxTurns` from `config.json` via `read_config` and threads them into every reviewer / test-writer / scribe spawn manifest in this script. Defaults reproduce the previously-hardcoded values (`sonnet`, `25`, `30`, `40`, `60`). See `docs/guides/configuration.md` for the operator-facing description.

**Test-writer → executor branch handoff (`_stage_preexec_tests`, added 0.10.2):**

The two-phase TDD flow runs test-writer and task-executor in separate worktrees. After RED-verification succeeds, the executor would spawn into a fresh worktree pinned at `origin/staging` and see none of the test-writer's failing-test commits. To bridge the gap, `_stage_preexec_tests` now:

1. Resolves the test-writer's branch via `git -C "$tw_wt" rev-parse --abbrev-ref HEAD`.
2. Pushes that branch to `origin` (`git push -u origin "$tw_branch"`). A push failure marks `test_writer_status: BLOCKED`, sets the task to `failed`, and returns exit 30.
3. Records the branch name to state at `.tasks.<task-id>.test_writer_branch`.
4. Passes `--bootstrap-branch "$tw_branch"` to `pipeline-build-prompt` so the executor prompt starts with a `## Bootstrap` block (see `pipeline-build-prompt`).

Fallback: if the test-writer worktree is not a git repo, has a detached HEAD, or has no `origin` remote (legacy / offline test fixtures), the wrapper logs a warning and spawns the executor without the bootstrap block (`local-only` mode). This preserves backward compatibility with tests that don't drive a real RED commit.

**Exit codes:**

| Code | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| 0    | Stage complete — advance to next                               |
| 2    | `end_gracefully` (quota cap, circuit breaker, exhausted)       |
| 3    | `wait_retry` (quota chunk slept, still over) — re-invoke       |
| 10   | `spawn_required` — stdout is a JSON spawn manifest             |
| 20   | `human_gate_pause` — orchestrator halts until resume           |
| 30   | `task_terminal_failed` / `needs_human_review` — skip, continue |

**Spawn manifest shape (exit 10):**

```json
{
  "action": "spawn_agents",
  "stage_after": "<next-stage>",
  "agents": [
    {
      "subagent_type": "task-executor",
      "isolation": "worktree",
      "model": "sonnet",
      "maxTurns": 60,
      "prompt_file": ".state/<run-id>/<task-id>.executor-prompt.md"
    }
  ]
}
```

> `isolation` is present only when the test-writer branch was pushed to origin (the normal online case); in offline/test runs with no origin remote the field is omitted and the executor reuses the test-writer worktree.

---

## Input and Discovery

### pipeline-fetch-prd

Fetch PRD body from GitHub issue.

**Usage:**

```bash
pipeline-fetch-prd <issue-number> [--strict]
```

**Flags:**

| Flag       | Description                     |
| ---------- | ------------------------------- |
| `--strict` | Require `[PRD]` marker in issue |

**Output:**

```json
{
  "issue_number": 42,
  "title": "...",
  "body": "...",
  "has_prd_marker": true
}
```

---

### pipeline-validate-spec

Validate spec output files.

**Usage:**

```bash
pipeline-validate-spec <spec-dir>
```

**Checks:**

- `spec.md` exists and is non-empty
- `tasks.json` exists and is valid JSON
- Tasks have required fields

---

### pipeline-validate-tasks

Field validation, cycle detection, topological sort, size budget enforcement.

**Usage:**

```bash
pipeline-validate-tasks <tasks-json-path>
```

**Validations:**

1. **Size budget** (security M3/M4): file size must not exceed `FACTORY_TASKS_MAX_BYTES` (default 256 KB). Checked before JSON parsing to bound memory/CPU and limit prompt-injection blast radius.
2. Required fields: task_id, title, description, files, acceptance_criteria, tests_to_write, depends_on
3. `files` array capped at 3 entries per task
4. `task_id` format: alphanumerics, underscore, hyphen only
5. `task_id` uniqueness across tasks
6. Dependency cycle detection (DFS)
7. Topological sort via Kahn's algorithm
8. Parallel group assignment
9. **Prompt-injection guards**: descriptions are rejected if they contain control chars, command-substitution syntax (backtick, `$(...)`), or leading `--`. The previously-rejected shell metacharacters `;&|<>` are now **allowed** — descriptions are embedded inside untrusted-data fences by `pipeline-build-prompt` and never shell-eval'd, and the rejected set blocked legitimate TypeScript syntax (unions, generics, intersections, statement terminators). Tab and CR remain allowed.

**Environment variables:**

| Variable                  | Default | Description                      |
| ------------------------- | ------- | -------------------------------- |
| `FACTORY_TASKS_MAX_BYTES` | 262144  | Maximum tasks.json size in bytes |

**Output:**

```json
{
  "valid": true,
  "task_count": 5,
  "execution_order": [
    { "task_id": "task_01", "parallel_group": 0 },
    { "task_id": "task_02", "parallel_group": 0 },
    { "task_id": "task_03", "parallel_group": 1 }
  ]
}
```

---

## Task Execution

### pipeline-branch

Branch creation, worktree operations, staging init, task commit.

**Usage:**

```bash
pipeline-branch staging-init
pipeline-branch commit-spec <spec-dir>
pipeline-branch create <branch-name> [--base <ref>]
pipeline-branch worktree-create <branch-name> <worktree-path>
pipeline-branch worktree-remove <worktree-path>
pipeline-branch exists <branch-name>
pipeline-branch naming <task-id> <issue-number>
pipeline-branch task-commit <task-id> --worktree <path> [--message <msg>]
```

**Actions:**

| Action            | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `staging-init`    | Create or reconcile staging branch from base           |
| `commit-spec`     | Commit spec directory to staging                       |
| `create`          | Create task branch from base (default: staging)        |
| `worktree-create` | Create worktree for branch (forks from origin/staging) |
| `worktree-remove` | Remove worktree and optionally delete branch           |
| `exists`          | Check if branch exists (local or remote)               |
| `naming`          | Generate branch name from task-id and issue number     |
| `task-commit`     | Finalize task changes in worktree                      |

**task-commit flags:**

| Flag         | Required | Description           |
| ------------ | -------- | --------------------- |
| `--worktree` | Yes      | Path to task worktree |
| `--message`  | No       | Custom commit message |

**worktree-create behavior:**

When the base is `staging` (the default), the script fetches `origin/staging` and resolves the base to `origin/staging` before running `git worktree add`. This ensures worktrees always fork from the live remote tip rather than a potentially stale local ref. This prevents drift issues when multiple worktrees are created during long-running pipeline executions.

**staging-init fetch:**

The `git fetch origin staging` call is now fatal on failure (previously silent). This ensures staging-init fails fast when the remote is unreachable rather than proceeding with stale state.

**commit-spec staging-worktree resolution (added 0.10.2):**

`commit-spec` no longer assumes the invoking cwd owns the `staging` branch. It resolves the worktree that has `staging` checked out via `git worktree list --porcelain` and routes every git operation through `git -C "$staging_wt"`. This is required when the orchestrator runs in a separate worktree (`.claude/worktrees/orchestrator-<run_id>/`) — without it, `git checkout staging` and `git add` would fail because another worktree already owns the `staging` ref.

The spec directory is mirrored from the caller's path into `$staging_wt/<rel-spec-dir>` before staging. A `pwd -P` symlink-resolution check on both source and target prevents an in-place self-copy from `rm -rf` + `cp -R` wiping the source when the two paths differ only by symlink resolution (macOS `/tmp` vs `/private/tmp`).

The JSON output gained a `staging_worktree` field carrying the resolved absolute path:

```json
{
  "action": "commit-spec",
  "result": "committed",
  "spec_dir": ".state/run-20260526-154940",
  "branch": "staging",
  "sha": "abc1234...",
  "push": "ok",
  "staging_worktree": "/path/to/staging-worktree"
}
```

The orchestrator's spec-handoff sequence (`skills/pipeline-orchestrator/SKILL.md` step 6) passes an **absolute** spec path (`$staging_wt/.state/$run_id`) to `commit-spec` for the same reason.

---

### pipeline-classify-task

Classify task complexity to determine model and max turns.

**Usage:**

```bash
pipeline-classify-task '<task-json>'
```

**Classification logic:**

- File count: 1=simple, 2=medium, 3+=complex
- Dep count: 0=simple, 1-2=medium, 3+=complex
- Tier = max(file_rank, dep_rank)

**Output:**

```json
{
  "tier": "medium",
  "model": "sonnet",
  "maxTurns": 60,
  "reasoning": "2 file(s), 1 dep(s) -> medium"
}
```

---

### pipeline-classify-risk

Classify task risk tier from file paths.

**Usage:**

```bash
pipeline-classify-risk '<task-json>'
```

**Risk patterns:**

| Tier     | Patterns                                                                                 |
| -------- | ---------------------------------------------------------------------------------------- |
| Security | auth/_, security/_, migration/_, payment/_, crypto/_, .env_, middleware/auth\*, hooks/\* |
| Feature  | api/_, routes/_, models/\_, services/\*                                                  |
| Routine  | Everything else                                                                          |

**Output:**

```json
{
  "tier": "security",
  "review_rounds": 6,
  "extra_reviewers": ["security-reviewer", "architecture-reviewer"],
  "matched_patterns": ["auth/*"],
  "reasoning": "src/auth/login.ts -> security tier"
}
```

---

### pipeline-build-prompt

Build structured prompt for task executor.

**Usage:**

```bash
pipeline-build-prompt '<task-json>' [--spec-path <path>] [--holdout <percent>] [--fix-instructions <json>] [--bootstrap-branch <name>]
```

**Flags:**

| Flag                 | Description                                                          |
| -------------------- | -------------------------------------------------------------------- |
| `--spec-path`        | Path to spec directory                                               |
| `--holdout`          | Percentage of criteria to withhold (0-50)                            |
| `--fix-instructions` | JSON with review findings to address                                 |
| `--seed`             | Seed for holdout randomization                                       |
| `--bootstrap-branch` | Branch name to fetch + `reset --hard` to before starting (see below) |

**Holdout behavior:**

When `--holdout` is specified, the script:

1. Randomly selects N% of acceptance criteria
2. Saves withheld criteria to `${CLAUDE_PLUGIN_DATA}/runs/<run-id>/holdouts/<task-id>.json`
3. Returns prompt with only visible criteria

**Input validation:**

The `task_id` argument is validated against `^[a-zA-Z0-9_-]+$` to block directory traversal attacks. `git fetch` failures now emit warnings (previously silent).

**Prompt-fencing redaction:**

Untrusted content (`title`, `description`, `files`, `tests_to_write`, `acceptance_criteria`) is sanitized before interpolation:

- Any string matching `<<<(END:)?UNTRUSTED:[A-Z_]+(:[A-Za-z0-9]+)?>>>` is replaced with `[redacted-fence]`
- `title` is truncated to first line, control chars stripped, capped at 200 chars
- A per-invocation nonce is appended to fence tokens so untrusted content cannot close the fence by embedding the literal close tag

This prevents prompt-injection attacks where attacker-controlled content (e.g., GitHub issue titles) attempts to break out of fenced regions.

**Malformed `--fix-instructions` rejection (fail-closed):**

When `--fix-instructions` is supplied, the script parses it through jq to extract `.findings[]` and format them as bullet lines. If jq exits non-zero (invalid JSON, wrong shape, unparseable input), the script now exits 1 with `log_error "build-prompt: fix_instructions is malformed JSON: <stderr>"`. Previously the failure fell back to pasting the raw `fix_instructions` blob into the prompt, which exposed unparseable reviewer output to the executor verbatim. Callers that pass `--fix-instructions` must ensure the payload is valid JSON with a `findings` array.

**`--bootstrap-branch` (test-writer → executor handoff, added 0.10.2):**

When supplied, prepends a `## Bootstrap` section to the executor prompt instructing it to `git fetch origin <branch> staging --depth=50` and `git reset --hard origin/<branch>` before doing anything else. This exists because the executor spawns into a fresh worktree pinned at `origin/staging`, and cannot otherwise see the RED commits the test-writer made on a sibling-worktree branch.

The branch name is validated against `^[A-Za-z0-9._/-]+$` before substitution into the bash block; shell metacharacters or empty values exit 1.

Caller responsibility: the branch must already be reachable from `origin` (i.e., pushed) before the executor spawns. `pipeline-run-task`'s `_stage_preexec_tests` performs the push and only adds `--bootstrap-branch` when the test-writer's worktree has an `origin` remote — legacy / offline test fixtures fall through to a "local-only" mode without bootstrap.

---

### pipeline-circuit-breaker

Check safety thresholds before each task.

**Usage:**

```bash
pipeline-circuit-breaker <run-id>
```

**Thresholds checked:**

| Threshold    | Config Key               | Default |
| ------------ | ------------------------ | ------- |
| Max runtime  | `maxRuntimeMinutes`      | 0 (off) |
| Max failures | `maxConsecutiveFailures` | 5       |

The runtime check is skipped when `maxRuntimeMinutes` is `0`. The script trips on two conditions only: `maxConsecutiveFailures` being reached, or a positive `maxRuntimeMinutes` being exceeded.

**Output:**

```json
{
  "tripped": false,
  "runtime_minutes": 45,
  "pause_minutes_total": 30,
  "pause_minutes_consecutive": 2,
  "consecutive_failures": 0,
  "thresholds": {
    "max_runtime_minutes": 0,
    "max_consecutive_failures": 5
  },
  "reason": null
}
```

**Exit codes:** 0=safe, 1=tripped

---

## Review and Quality

### pipeline-detect-reviewer

Check Codex availability, return reviewer configuration.

**Usage:**

```bash
pipeline-detect-reviewer [--base <ref>]
```

**Flags:**

| Flag     | Default   | Description             |
| -------- | --------- | ----------------------- |
| `--base` | `staging` | Git ref to diff against |

**Detection logic:**

1. Check if `codex` command exists
2. Run `codex login status` to verify authentication
3. If both pass: return Codex config with command path
4. Otherwise: return Claude Code fallback

**Output (Codex available):**

```json
{
  "reviewer": "codex",
  "command": "/path/to/plugin/bin/pipeline-codex-review --base staging"
}
```

**Output (fallback):**

```json
{
  "reviewer": "claude-code",
  "agent": "quality-reviewer"
}
```

---

### pipeline-codex-review

Codex exec wrapper for adversarial code review. Builds a prompt from task metadata, spec files, and git diff, invokes Codex with structured output, and maps the result to the normalized pipeline verdict JSON.

**Usage:**

```bash
pipeline-codex-review --base <ref> --task-id <id> --spec-dir <path> [--worktree <path>]
```

**Arguments:**

| Argument     | Required | Default   | Description                                                 |
| ------------ | -------- | --------- | ----------------------------------------------------------- |
| `--base`     | No       | `staging` | Git ref for diff base                                       |
| `--task-id`  | Yes      | -         | Task identifier for prompt context                          |
| `--spec-dir` | No       | -         | Path to spec directory (spec.md, acceptance.md, holdout.md) |
| `--worktree` | No       | -         | Task worktree to `cd` into before computing the diff        |

**Worktree handling:**

When `--worktree` is set, the script validates that the path exists and is a git repository, then `cd`s in before running `git diff`. `pipeline-run-task` passes the task worktree via this flag so codex always sees the executor's working tree, not whichever cwd the orchestrator was launched in. Missing or non-git paths exit 1 with `log_error`.

**Behavior:**

1. Compute `git diff --unified=5 <base> HEAD`
2. If diff is empty: emit auto-approve verdict and exit 0
3. Build prompt from `skills/review-protocol/SKILL.md` + spec files + diff
4. Verify Codex supports `--sandbox` flag (fail-closed: refuses to run unsandboxed)
5. Invoke Codex with `--sandbox read-only` only; aborts on failure (sandbox cascade removed)
6. Parse Codex JSON output via `schemas/codex-review.schema.json`
7. Map to normalized verdict JSON (same shape as `pipeline-parse-review`)

**Authoritative acceptance-criteria anchor:**

Before the spec dump, the prompt prepends an `## Authoritative acceptance criteria for <task-id>` section built from the matching row in `tasks.json` (via the type-aware jq idiom that handles both bare-array and `{tasks:[...]}` shapes). The prompt then instructs codex: "Judge scope against THIS list, not narrative inference from spec.md" and "When in conflict, the Authoritative acceptance criteria list above wins over narrative in spec.md." This narrows codex's scope to the structured AC list and prevents it from flagging spec.md narrative as missing functionality. `tasks.json` parse failures emit `log_warn "tasks.json parse failed (codex prompt will lack AC anchor): ..."` and continue without the anchor section.

**Trust boundary fencing:**

Spec text and diff content are wrapped in `<<<UNTRUSTED:SPEC:<nonce>>>>` / `<<<UNTRUSTED:DIFF:<nonce>>>>` fences with a per-invocation 16-char random nonce. This prevents prompt injection attacks where attacker-controlled content attempts to break out of fenced regions by embedding literal close tags.

**Output:**

```json
{
  "verdict": "REQUEST_CHANGES",
  "round": 1,
  "confidence": "HIGH",
  "findings": [
    {
      "title": "SQL injection risk",
      "file": "src/db.ts",
      "severity": "critical",
      "category": "codex",
      "description": "User input passed directly to query",
      "suggestion": "",
      "blocking": true
    }
  ],
  "blocking_count": 1,
  "non_blocking_count": 0,
  "declared_blockers": 1,
  "criteria_passed": 0,
  "criteria_failed": 0,
  "holdout_passed": 0,
  "holdout_failed": 0,
  "summary": "Patch has one critical security issue.",
  "reviewer": "codex"
}
```

**Exit codes:** 0=success (JSON on stdout), 1=failure

**Schema:** `schemas/codex-review.schema.json`

The Codex output schema defines:

| Field                         | Type   | Description                                    |
| ----------------------------- | ------ | ---------------------------------------------- |
| `findings`                    | array  | Individual issues found                        |
| `findings[].title`            | string | One-line summary                               |
| `findings[].body`             | string | Detailed explanation                           |
| `findings[].priority`         | enum   | `critical`, `high`, `medium`, `low`            |
| `findings[].confidence_score` | number | 0-1 confidence this is a real issue            |
| `findings[].code_location`    | object | Optional `absolute_file_path` and `line_range` |
| `overall_correctness`         | enum   | `patch is correct` or `patch is incorrect`     |
| `overall_explanation`         | string | One-paragraph assessment                       |
| `overall_confidence_score`    | number | 0-1 overall confidence                         |

Priority mapping: `critical`/`high` = blocking, `medium`/`low` = non-blocking.

**Configuration:**

- `FACTORY_CODEX_MODEL` (env) — explicit `model` value passed to `codex exec`
  via `-c model="..."`. Use this on ChatGPT (Plus/Pro) auth accounts where
  codex's built-in default model is not supported. Example: `gpt-5-codex`.
- `.codex.model` (project config) — same value resolved from the project's
  configuration (read via `read_config` in `pipeline-lib.sh`). Env wins on
  conflict.
- Empty / unset → no `-c model=` is appended; codex resolves from
  `~/.codex/config.toml`.

The resolved value is charset-validated against `^[a-zA-Z0-9._-]+$` before
being embedded in the `-c model="..."` argument. Values containing spaces,
quotes, or shell metacharacters exit 1 with `log_error` and never reach the
codex CLI.

**Inverse-hallucination fallback:**

`pipeline-run-task` guards against two known codex output pathologies in its postexec spawn manifest. Both discard the codex verdict file, log a `task.review.codex_inverse_hallucination` metric (with `kind` describing which case), and fall through to the agent-reviewer path — behaviour identical to a non-zero codex rc.

1. **`REQUEST_CHANGES` with zero verified findings** (`kind=""` — default):
   When `validate_findings` (`pipeline-lib.sh:1102`) drops every reviewer
   finding because each `verbatim_line` failed exact-line match against the
   diff, the verdict is intentionally preserved (see the comment block at
   `pipeline-lib.sh:1097`). The resulting `REQUEST_CHANGES` with
   `blocking_count=0` and `non_blocking_count=0` is not actionable — the
   executor has nothing to fix.

2. **`APPROVE` / `APPROVED` with non-zero `blocking_count`** (`kind="approve_with_blockers"`):
   Codex declared the patch correct while simultaneously emitting blocking
   findings. This is an internal contradiction — the review cannot be
   trusted to gate the task. The verdict is discarded for the same reason.

Both checks run after the existing JSON-validity and empty-file gates: codex output that is truncated, malformed, or simply empty also routes to the agent reviewer with the same metric kinds as the rc-nonzero path.

---

### pipeline-parse-review

Extract structured verdict from reviewer output.

**Usage:**

```bash
echo "<reviewer output>" | pipeline-parse-review [--reviewer <codex|claude-code>] [--base <ref>]
```

**Output:**

```json
{
  "verdict": "REQUEST_CHANGES",
  "findings": [
    {
      "severity": "critical",
      "file": "src/auth.ts",
      "line": 42,
      "description": "SQL injection via unsanitized input",
      "category": "security"
    }
  ],
  "round": 1,
  "reviewer": "codex",
  "summary": "..."
}
```

**Verdict normalization:**

Accepts `APPROVE` from JSON block (normalized to `APPROVED` for validation).

**Findings validation (via `validate_findings` in `pipeline-lib.sh`):**

Blocking findings are validated against the diff using exact full-line match (`grep -qxF`) against a normalized line-set built from the diff. Normalization strips the diff column-1 prefix (`+`/`-`/space) before collapsing intra-line whitespace and trimming — reviewers cite source lines without prefixes, so stripping here enables like-for-like matching while preserving full-line anti-forgery. Forged 10-char substring blockers are rejected.

---

## Debug Loop Scripts

### pipeline-debug-review

Codex branch for `/factory:debug`. Invokes `pipeline-codex-review` and pipes output through `pipeline-debug-normalize`.

**Usage:**

```bash
pipeline-debug-review --base <ref> --severity <critical|high|medium|all> \
                      --out-dir <dir> [--round <N>]
```

**Flags:**

| Flag         | Required | Default  | Description                 |
| ------------ | -------- | -------- | --------------------------- |
| `--base`     | Yes      | -        | Git ref for diff base       |
| `--severity` | No       | `medium` | Severity threshold          |
| `--out-dir`  | Yes      | -        | Directory for review output |
| `--round`    | No       | 1        | Round number                |

**Output (stdout, single line JSON):**

```json
{
  "blocking_count": 2,
  "below_threshold_count": 1,
  "verdict": "REQUEST_CHANGES",
  "review_file": "/path/to/round-1.review.json"
}
```

**Exit codes:** 0=success, 1=reviewer or IO failure

**Note:** This script is the Codex branch only. If the detected reviewer is `claude-code`, the skill routes through `quality-reviewer` agent + `pipeline-parse-review` + `pipeline-debug-normalize` instead.

---

### pipeline-debug-normalize

Shared severity normalization and threshold counting for `/factory:debug`. Used by both Codex and Claude-fallback branches.

**Usage:**

```bash
cat review.json | pipeline-debug-normalize --severity <level> --out-dir <dir> [--round <N>]
```

**Flags:**

| Flag         | Required | Default  | Description                 |
| ------------ | -------- | -------- | --------------------------- |
| `--severity` | No       | `medium` | Severity threshold          |
| `--out-dir`  | Yes      | -        | Directory for review output |
| `--round`    | No       | 1        | Round number                |

**Severity normalization:**

| Input       | Normalized |
| ----------- | ---------- |
| `important` | `high`     |
| `minor`     | `low`      |
| (missing)   | `medium`   |

**Threshold sets:**

| Level      | Includes                    |
| ---------- | --------------------------- |
| `critical` | critical                    |
| `high`     | critical, high              |
| `medium`   | critical, high, medium      |
| `all`      | critical, high, medium, low |

**Output (stdout, single line JSON):**

```json
{
  "blocking_count": 2,
  "below_threshold_count": 1,
  "verdict": "REQUEST_CHANGES",
  "review_file": "/path/to/round-1.review.json"
}
```

**Exit codes:** 0=success, 1=IO or parse failure

---

### pipeline-debug-escalate

Writes the escalation audit trail for `/factory:debug` when the executor returns `STATUS: BLOCKED -- escalate: <reason>`.

**Usage:**

```bash
pipeline-debug-escalate --run-id <id> --reason <text> --base <ref> \
                        --severity <s> --findings <path> --executor-msg <path>
```

**Flags:**

| Flag             | Required | Description                      |
| ---------------- | -------- | -------------------------------- |
| `--run-id`       | Yes      | Debug run identifier             |
| `--reason`       | Yes      | Escalation reason from executor  |
| `--base`         | Yes      | Git ref used as diff base        |
| `--severity`     | Yes      | Severity threshold used          |
| `--findings`     | Yes      | Path to review findings JSON     |
| `--executor-msg` | Yes      | Path to executor's final message |

**Output (stdout, exact):**

```
ESCALATED path=/absolute/path/to/escalation.md
```

**Behavior:**

1. Validates all required flags are present
2. Validates `--findings` and `--executor-msg` files are readable (fail-closed)
3. Writes `escalation.md` with run metadata, findings JSON, and executor message
4. Prints the `ESCALATED path=<path>` marker

**Environment:** Invokes `require_plugin_data` — exits 1 with actionable error if `CLAUDE_PLUGIN_DATA` is unset.

**Exit codes:** 0=success, 1=IO failure or missing required inputs

---

### pipeline-security-gate

Run a configured security-analysis command and write structured results to state.

**Usage:**

```bash
pipeline-security-gate <run-id> <task-id> [<worktree>]
```

**Arguments:**

| Argument   | Required | Default | Description           |
| ---------- | -------- | ------- | --------------------- |
| `run-id`   | Yes      | -       | Run identifier        |
| `task-id`  | Yes      | -       | Task identifier       |
| `worktree` | No       | `$PWD`  | Path to task worktree |

**Behavior:**

1. Read `.quality.securityCommand` from factory config
2. If unset, skip gate (exit 2) and record `skipped: true` with reason `no-security-command`
3. Validate command tokens against allowlist (same discipline as `redTestCommand`)
4. Validate command prefix against allowed runners: `semgrep`, `pytest`, `vitest`, `jest`, `mocha`, `phpunit`, `rspec`, `go test`, `cargo test`, `deno test`, `bundle exec rspec`
5. Execute command in task worktree
6. Save stdout to `$CLAUDE_PLUGIN_DATA/runs/<run-id>/<task-id>.security-findings.json`
7. If stdout is not valid JSON, wrap raw output in `{"raw_output": "...", "exit_code": N}`
8. Write structured result to state at `.tasks.<task-id>.security_gate`

**Output (pass):**

```json
{
  "ok": true,
  "status": "passed",
  "command": "semgrep --config auto --error",
  "duration_s": 12,
  "findings_file": "/path/to/task_01.security-findings.json",
  "log": "/path/to/task_01.security-gate.log"
}
```

**Output (fail):**

```json
{
  "ok": false,
  "status": "failed",
  "command": "semgrep --config auto --error",
  "duration_s": 15,
  "findings_file": "/path/to/task_01.security-findings.json",
  "log": "/path/to/task_01.security-gate.log"
}
```

**Exit codes:**

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | Gate passed (no findings OR `securityAllowFailures=true`)              |
| 1    | Gate failed (findings present) or validation error (unsafe command)    |
| 2    | Gate skipped (no `securityCommand` configured or worktree/pkg missing) |

**Configuration:**

| Setting                         | Default | Description                                       |
| ------------------------------- | ------- | ------------------------------------------------- |
| `quality.securityCommand`       | (none)  | Command to run; unset = gate skipped              |
| `quality.securityAllowFailures` | false   | When true, findings are recorded but non-blocking |

---

### pipeline-coverage-gate

Compare before/after coverage reports. Block if coverage decreased.

**Usage:**

```bash
pipeline-coverage-gate <before.json> <after.json> [--tolerance <percent>] [--task-id <id>]
```

**Flags:**

| Flag          | Description                                          |
| ------------- | ---------------------------------------------------- |
| `--tolerance` | Allowed coverage decrease (default: 0.5%)            |
| `--task-id`   | Task identifier for metrics logging (added in 0.3.5) |

**Output:**

```json
{
  "passed": true,
  "before": { "lines": 80, "branches": 75, "functions": 85, "statements": 80 },
  "after": { "lines": 82, "branches": 76, "functions": 85, "statements": 81 },
  "delta": { "lines": 2, "branches": 1, "functions": 0, "statements": 1 },
  "tolerance": 0.5
}
```

**Exit codes:** 0=passed, 1=failed

---

### pipeline-mutation-gate

Run scoped Stryker mutation testing locally with the same scope semantics as `templates/.github/workflows/quality-gate.yml`. Invoked from `_run_ship_pregate` in `pipeline-run-task` for every staging-bound task PR (no risk-tier filter).

**Usage:**

```bash
pipeline-mutation-gate <run-id> <task-id> <worktree>
```

**Behavior:**

1. Compute mutation scope: `git diff --name-only --diff-filter=AM origin/<base_ref>...HEAD -- ':(glob)src/**/*.ts'`, then filter out `*.test.ts`, `*.spec.ts`, `*.d.ts`, `types/`, `data/`, `index.ts`. The `:(glob)` magic prefix ensures `**` matches recursively across all git versions.
2. If scope is empty, exit 0 with reason `no-mutable-changes`.
3. Otherwise invoke `<pkg-manager> exec stryker run --mutate <csv-scope>`.
4. Read score from `reports/mutation/mutation.json`, compare against `quality.mutationScoreTarget` (default 80).

**Base ref:** `origin/staging` by default. Override with `FACTORY_MUTATION_BASE` env var.

**Output:** `{ok, reason, score, target, scope}` to stdout, mirrored into state at `tasks.<task-id>.mutation_gate`.

**Exit codes:**

- `0` — pass or skip
- `1` — fail (`base-missing`, `stryker-failed`, `score-below-target`)

**Skip reasons (exit 0):** `no-package-json`, `no-script`, `no-mutable-changes`, `no-report`, `no-score`.

**Fail reasons (exit 1):** `base-missing`, `stryker-failed`, `score-below-target`.

**Output (pass):**

```json
{
  "ok": true,
  "reason": "ok",
  "score": 85,
  "target": 80,
  "scope": ["src/foo.ts", "src/bar.ts"]
}
```

**Output (fail):**

```json
{
  "ok": false,
  "reason": "score-below-target",
  "score": 42,
  "target": 80,
  "scope": ["src/foo.ts"]
}
```

---

### pipeline-tdd-gate

Validate that each implementation commit is preceded by a test-only commit with the same `[task-id]` tag.

**Usage:**

```bash
pipeline-tdd-gate --task-id <id> [--base <ref>] [--run-id <id>] [--spec-dir <path>]
```

**Flags:**

| Flag         | Default    | Description                            |
| ------------ | ---------- | -------------------------------------- |
| `--task-id`  | (required) | Task identifier                        |
| `--base`     | `staging`  | Git ref for diff base                  |
| `--run-id`   | -          | Run ID for state writes                |
| `--spec-dir` | -          | Path to spec directory (for exemption) |

**Validation logic:**

1. Classify ALL commits in `base..HEAD` (not just task-tagged ones)
2. For each commit, classify files as `test-only`, `impl`, or `empty`
3. Test-only: all files match `*.test.*`, `*.spec.*`, `tests/`, `__tests__/`, or docs/config patterns
4. Impl: any file outside those patterns
5. Report violation if an impl commit is untagged or appears before any tagged test commit

**Exemption:**

Tasks with `tdd_exempt: true` in `tasks.json` skip validation. Checked via `task_tdd_exempt` helper in `pipeline-lib.sh`.

**Monorepo support:**

The `is_test_path` helper (used by TDD gate and red-test verification) recognizes per-package test directories like `packages/*/tests/` and `packages/*/__tests__/`.

**State write:**

When `--run-id` is provided, the result is written to `.tasks.<task-id>.quality_gates.tdd`. If the write fails, the script logs to stderr and returns exit code 1 (propagating the state-write failure rather than silently succeeding).

**`git diff-tree` fail-closed:**

Both branches of the per-commit file-classification loop (merge-commit and regular-commit) capture `git diff-tree` stderr to a temp file and exit 1 with `log_error "tdd-gate: git diff-tree failed for <sha>: <stderr>"` when the call fails. The previous `|| true` silently treated missing trees or corrupt refs as "no files in this commit" and let the gate pass. The strict path ensures a git error never masquerades as a clean commit.

**Output:**

```json
{
  "ok": true,
  "exempt": false,
  "violations": []
}
```

**Output (violation):**

```json
{
  "ok": false,
  "exempt": false,
  "violations": [
    { "commit": "abc123", "reason": "impl-without-preceding-test" }
  ]
}
```

**Exit codes:** 0=ok or exempt, 1=violation

---

### pipeline-quality-gate

Run the full quality gate stack.

**Usage:**

```bash
pipeline-quality-gate <run-id> <task-id>
```

Runs layers in sequence: static analysis, tests, coverage, holdout, mutation.

**Non-JS skip:**

When the project has no `package.json` or tests are not configured, the gate logs a skip reason and exits 2 (not 0) to distinguish "not applicable" from "passed". Exit code 2 is interpreted by `pipeline-run-task` as "not applicable, treat as pass". Exit code 1 remains a hard failure. This allows non-JS projects to pass through cleanly while preserving the distinction between success and skip.

---

## Rate Limiting

### pipeline-quota-check

Parse rate limit headers, compute window position.

**Usage:**

```bash
pipeline-quota-check [--strict]
```

**Flags:**

| Flag       | Description                                                 |
| ---------- | ----------------------------------------------------------- |
| `--strict` | Exit 1 on detection failure (test-only; prod uses sentinel) |

**Reads:** `${CLAUDE_PLUGIN_DATA}/usage-cache.json` (written by `bin/statusline-wrapper.sh`). Invokes `require_plugin_data` at the top — exits 1 with actionable error if `CLAUDE_PLUGIN_DATA` is unset. No hardcoded fallback path.

**Fail-closed behavior:**

On missing, malformed, or stale cache (>1 h), the script emits a sentinel JSON with `detection_method: "unavailable"` and `over_threshold: true`. The sentinel routes through `pipeline_quota_gate`'s stale-yield branch (rc=3), giving the statusline a chance to refresh. Consecutive stale yields are capped by `.quota.maxStaleCycles` (default 6).

Non-numeric `resets_at` values (e.g., string-encoded timestamps from corrupt caches) are coerced via `tonumber? // empty` and treated as missing — emitting `reason: "resets-at-missing"`.

**Output:**

```json
{
  "five_hour": {
    "utilization": 45,
    "hourly_threshold": 40,
    "over_threshold": true,
    "window_hour": 3,
    "resets_at_epoch": 1776329771
  },
  "seven_day": {
    "utilization": 25,
    "daily_threshold": 29,
    "over_threshold": false,
    "window_day": 2,
    "resets_at_epoch": 1776900000
  },
  "detection_method": "statusline"
}
```

---

### pipeline-model-router

Route task execution based on quota utilization.

**Usage:**

```bash
pipeline-model-router --quota '<quota-json>' --tier <routine|feature|security>
```

**Output (proceed):**

```json
{
  "provider": "anthropic",
  "action": "proceed",
  "review_cap": 2,
  "tier": "routine"
}
```

**Output (wait — 5h over threshold):**

```json
{
  "provider": "anthropic",
  "action": "wait",
  "trigger": "5h_over",
  "wait_minutes": 47,
  "milestone": "hour_3",
  "tier": "routine"
}
```

The `wait_minutes` value points to the next hourly threshold milestone rather than a full window reset. The `milestone` field indicates the target: `hour_N` (next hourly boundary within the 5h window) or `window_reset` (full 5h window reset).

**Output (end gracefully — 7d over threshold):**

```json
{
  "provider": "anthropic",
  "action": "end_gracefully",
  "trigger": "7d_over",
  "tier": "routine"
}
```

**7-day bypass:**

When `FACTORY_ALLOW_7D_OVER=1` is set in the environment, the router skips the `seven_day → end_gracefully` branch and falls through to the 5h logic. This allows the pipeline to wait for hourly threshold milestones even when the 7d window is over. The flag is propagated by `pipeline_quota_gate` when run state has `.flags.allow_7d_over=true`. See [Rate Limiting: Override](../explanation/rate-limiting.md#override).

---

## Completion

### pipeline-wait-pr

Poll for PR merge with CI/conflict handling.

**Usage:**

```bash
pipeline-wait-pr <pr-number> [--timeout <minutes>] [--interval <seconds>]
```

**Exit codes:**

| Code | Meaning                       |
| ---- | ----------------------------- |
| 0    | PR merged                     |
| 1    | Timeout                       |
| 2    | Closed without merge          |
| 3    | CI failed (details on stdout) |
| 4    | Unresolvable merge conflict   |

**CI red conditions:**

The script treats a PR as CI-red when any required check reports `failure`, `timed_out`, `action_required`, or `cancelled`. Pending checks do not block; only terminal failure states.

**Single-call PR + checks fetch via `statusCheckRollup` (added 0.10.3):**

PR metadata and check results are fetched in a single `gh pr view --json state,mergedAt,mergeable,headRefName,statusCheckRollup` call. The rollup is the GraphQL union of `CheckRun` and `StatusContext` records — both expose `.conclusion` (where applicable) and `.status` / `.state`. The previous two-call pattern (`gh pr view` + `gh pr checks --json`) lost conclusion-level granularity because `gh pr checks --json` whitelists `conclusion` out and forces a lossy `bucket` mapping.

Each rollup entry is classified using `status` + `state` + `conclusion`, mirroring the existing classifier semantics. The `failed_names` field emitted on CI-red exits is now formatted as `<check>=<CONCLUSION>` (e.g., `build=FAILURE, deploy=ACTION_REQUIRED`) so operators can distinguish hard failures from `ACTION_REQUIRED` / `TIMED_OUT` / `CANCELLED` without re-querying GitHub.

**Rebase error surfacing:**

When auto-rebase fails, stderr from `git rebase --abort` and `git checkout <branch>` is captured and logged via `log_warn` / `log_error` instead of being silently swallowed. This makes debugging stuck worktrees easier. The `_safe_checkout_back` helper also logs failures (previously swallowed with `|| true`).

**CI skipping detection:**

When CI checks settle with `bucket=skipping`, the script fails fast with exit 3 and `status: ci_skipping` JSON output instead of waiting out the full timeout. This prevents indefinite waits on PRs where CI has been explicitly skipped.

---

### pipeline-gh-comment

Post comments and labels to GitHub issues.

**Usage:**

```bash
pipeline-gh-comment <issue-number> --body '<text>'
pipeline-gh-comment <issue-number> --label '<label>'
```

---

### pipeline-summary

Aggregate run results into execution summary.

**Usage:**

```bash
pipeline-summary <run-id>
```

---

### pipeline-cleanup

Clean up after a pipeline run: branches, worktrees, issues, spec directory, and state archival.

**Usage:**

```bash
pipeline-cleanup <run-id> [flags]
```

**Flags:**

| Flag                 | Description                                       |
| -------------------- | ------------------------------------------------- |
| `--close-issues`     | Close GitHub issues (only if ALL tasks merged)    |
| `--delete-branches`  | Delete local+remote branches for merged PRs       |
| `--remove-worktrees` | Remove git worktrees for merged tasks             |
| `--clean-spec`       | Remove spec dir after all tasks merged            |
| `--spec-dir <path>`  | Spec directory path (required for `--clean-spec`) |

**Behavior:**

1. **Branch deletion** (`--delete-branches`): Only deletes branches for tasks with status=done AND whose PR is actually MERGED. Skips branches for unfinished tasks or non-merged PRs.

2. **Worktree removal** (`--remove-worktrees`): Removes worktree directories for done tasks.

3. **Orphan cleanup** (runs when `--remove-worktrees` is set):
   - `worktree-agent-*` branches: Claude Code's `isolation:worktree` harness creates these but only removes the worktree directory, leaving orphan branches. The script deletes any not backing a live worktree.
   - `spec-handoff/<run_id>` branch: Deleted for the current run (already merged into staging). Cross-references active runs via `pipeline-state list` to avoid deleting mid-run branches for other runs.
   - `orchestrator-run-*` branches and worktrees: Sweeps orphan orchestrator artifacts left by crashed/aborted runs.

4. **Issue closure** (`--close-issues`): Closes issues only when ALL tasks for the run are done.

5. **Spec cleanup** (`--clean-spec`): Removes the spec directory only when all tasks are done. Includes refuse-list to prevent deletion of system paths, `$HOME`, or project root.

6. **State archival**: Copies `state.json`, `audit.jsonl`, `metrics.jsonl`, `reviews/`, and `holdouts/` to `${CLAUDE_PLUGIN_DATA}/archive/<run-id>/`, then removes the run directory.

7. **Retention trim**: Drops audit/metrics JSONL lines older than `observability.metricsRetentionDays` (default 90).

**Output:**

```json
{
  "run_id": "run-20260413-140000",
  "cleanup_status": "ok",
  "branches_deleted": 3,
  "branches_skipped": 1,
  "worktrees_removed": 3,
  "agent_branches_deleted": 2,
  "spec_handoff_deleted": 1,
  "orphan_spec_deleted": 0,
  "orchestrator_branches_deleted": 1,
  "orchestrator_wts_removed": 1,
  "issues_closed": 1,
  "spec_cleaned": true,
  "archive_path": "/path/to/archive/run-20260413-140000",
  "warnings": [],
  "worktree_errors": [],
  "issue_errors": [],
  "agent_branch_errors": [],
  "orchestrator_errors": []
}
```

**Exit codes:** 0=success, 1=partial failure (some cleanup operations failed)

---

### pipeline-scaffold

Create project scaffolding files.

**Usage:**

```bash
pipeline-scaffold [--type <type>]
```

---

## Statusline Integration

### statusline-wrapper.sh

Composable statusline script that captures Claude Code rate limit data for pipeline quota checks.

**Usage:**

Configure as `statusLine.command` in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/path/to/factory/bin/statusline-wrapper.sh"
  }
}
```

**Behavior:**

1. Reads Claude Code statusline JSON from stdin
2. Extracts `.rate_limits` and writes to `${CLAUDE_PLUGIN_DATA}/usage-cache.json` with `captured_at` timestamp
3. Chains to original statusline if `FACTORY_ORIGINAL_STATUSLINE` env var is set
4. Otherwise, outputs default statusline: `<model> in <dir> | <remaining%> left for <time>`

**Chaining to existing statusline:**

```json
{
  "env": {
    "FACTORY_ORIGINAL_STATUSLINE": "~/.claude/statusline.sh"
  },
  "statusLine": {
    "type": "command",
    "command": "/path/to/factory/bin/statusline-wrapper.sh"
  }
}
```

**Output file (`usage-cache.json`):**

```json
{
  "five_hour": {
    "used_percentage": 45.2,
    "resets_at": 1776329771
  },
  "seven_day": {
    "used_percentage": 25.0,
    "resets_at": 1776900000
  },
  "captured_at": 1776312000
}
```

**Notes:**

- Fails silently on cache write errors to never break statusline output
- The statusline runs in the user's shell environment, NOT in the plugin command runtime, so `CLAUDE_PLUGIN_DATA` is not set automatically. `pipeline-ensure-autonomy` bakes `CLAUDE_PLUGIN_DATA` into the merged-settings `env` block; Claude Code loads that env when the session is launched with `--settings`, which is how both the wrapper and `pipeline-quota-check` see a consistent path. If the env var is unset, the wrapper silently skips its cache write (no guessed path), and `pipeline-quota-check` errors out — a missing env means the session wasn't launched via the pipeline's `--settings` flag.
- Required for `pipeline-quota-check` to function

---

## Rescue Scripts

### pipeline-rescue-scan

Scan a pipeline run for rescue-actionable issues.

**Usage:**

```bash
pipeline-rescue-scan <run-id>
```

**Output:**

```json
{
  "run_id": "run-20260413-140000",
  "state_summary": {"status": "...", "tasks": [...]},
  "mechanical_issues": [
    {"id": "I-03", "tier": 1, "task_id": "task_01", "description": "PR #42 merged but task status=executing"}
  ],
  "investigation_flags": [
    {"id": "I-16", "task_id": "task_02", "reason": "task status=failed"}
  ]
}
```

**Issue IDs:**

| ID   | Tier | Description                                   |
| ---- | ---- | --------------------------------------------- |
| I-01 | 1    | Stale state lock (dead PID)                   |
| I-02 | 1    | Orphan worktree (branch gone)                 |
| I-03 | 1    | PR merged, state not updated                  |
| I-04 | 1    | PR exists on GitHub but state.pr_url empty    |
| I-05 | 1    | Stale CI status                               |
| I-06 | 2    | CI red, stage=ship, no ci_fixing              |
| I-07 | 2    | PR merge conflict with base                   |
| I-08 | 2    | PR closed unmerged                            |
| I-09 | 2    | Review verdict deadlock                       |
| I-10 | 2    | Stuck executing, no worktree, no PR           |
| I-11 | 2    | Spec done, no handoff branch, tasks empty     |
| I-12 | 2    | state.json malformed or non-numeric pr_number |
| I-14 | inv  | Orphan task branch, no state entry            |
| I-15 | 3    | Duplicate PRs for same branch                 |
| I-16 | inv  | Task status=failed                            |

**Exit codes:** 0=success (including no issues), 1=fatal (state missing, GitHub unreachable)

---

### pipeline-rescue-apply

Apply rescue remediations. Idempotent per action.

**Usage:**

```bash
pipeline-rescue-apply --tier=safe --plan=<report.json>
pipeline-rescue-apply --tier=risky --plan=<approved.json>
pipeline-rescue-apply --plans=<approved-plans.json>
pipeline-rescue-apply --action=rehydrate-archived-run --run-id=<id>
pipeline-rescue-apply --dry-run ...
```

**Arguments:**

| Argument    | Description                                     |
| ----------- | ----------------------------------------------- |
| `--tier`    | `safe` (tier-1) or `risky` (tier-2/3)           |
| `--plan`    | Path to scan report or approved mechanical JSON |
| `--plans`   | Path to approved investigation plans JSON       |
| `--action`  | Direct action: `rehydrate-archived-run`         |
| `--run-id`  | Run ID for direct actions                       |
| `--dry-run` | Log actions without applying                    |

**Rehydrate action:**

Restores an archived run from `${CLAUDE_PLUGIN_DATA}/archive/<run-id>/` back to `runs/<run-id>/` and re-creates the `runs/current` symlink if absent. Archive copy is preserved.

**Protected branches:**

The `_RESCUE_PROTECTED_BRANCHES` flat list is `("main" "master" "develop" "staging" "production")`. A `release/*` glob is also matched via `_is_rescue_protected`. Rescue operations that would affect any of these branches are blocked.

**I-07 rebase safety:**

Force-push is removed from the I-07 rebase path. If rebase succeeds but push is rejected (e.g., branch protection rules), or if rebase fails due to unresolvable conflicts, the task escalates to I-13 with audit `error` and `failure_reason` set to `"push rejected after rebase (I-13)"` or `"unresolvable merge conflict (I-13)"`.

**State update validation:**

Plan `state_updates` maps now reject keys starting with `.tasks` — task-level state modifications must go through `task-write` whitelist to prevent unauthorized task state manipulation.

**Audit integrity:**

All `rescue_audit` calls check state-write return codes. When writes fail, an `error` audit entry is emitted before the operation fails.

**Exit codes:** 0=success, 1=fatal

---

### pipeline-ensure-autonomy

Verify that the current session has up-to-date autonomous-mode settings.

**Usage:**

```bash
pipeline-ensure-autonomy
```

**Behavior:**

1. Self-heal exec bits on entry-point scripts (statusline-wrapper.sh, pipeline-\*)
2. Check if `merged-settings.json` exists and matches current plugin version
   - 2a. Migrate legacy cache-pinned `statusLine.command` paths (pre-0.6.2 layouts that baked a versioned cache path) to the stable wrapper path, regenerating settings
   - 2b. Detect and repair statusLine wrapper-missing state (pre-0.8.6 compat: dangling wrapper symlinks reported a misleading `stale-cache` status; now surfaces a dedicated `wrapper-missing` or self-heals via regeneration)
3. Regenerate if missing or stale — substitutes `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, and `${CLAUDE_PLUGIN_DATA_TILDE}` placeholders from the template at materialization time. The tilde form is the home-shortened version of the data dir, used inside the inline `.claude/` access hook so its `case` pattern is a pure POSIX literal with no runtime bash dependency.
4. Check FACTORY_AUTONOMOUS_MODE env var
5. Check usage-cache.json freshness (>3600s = fail-closed)

**Environment requirements:**

`$CLAUDE_PLUGIN_DATA` must be set. The script invokes `require_plugin_data` (from `pipeline-lib.sh`) at the top, which exits 1 with a verbose `export CLAUDE_PLUGIN_DATA=...` example when the env var is unset. There is no hardcoded fallback path. This ensures `merged-settings.json` is portable across marketplace installs (different users get different plugin-data suffixes) and that downstream paths (cache file, merged settings, wrapper destination) cannot silently resolve to root-relative locations. The `FACTORY_AUTONOMOUS_MODE=1` bypass path runs **after** the env-var guard — bypass callers must still export `CLAUDE_PLUGIN_DATA` so the bypass status report's `settings_path` field points at a real location.

**Placeholder substitution:**

The template contains `${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_PLUGIN_DATA_TILDE}` placeholders. At regeneration time:

- `${CLAUDE_PLUGIN_DATA}` is replaced with the absolute data dir path
- `${CLAUDE_PLUGIN_DATA_TILDE}` is replaced with the tilde-shortened form (e.g., `~/.claude/plugins/data/factory-xyz`)

The tilde form is used in the inline `.claude/` access hook's `case` pattern so it works as a pure POSIX literal with no runtime bash expansion.

**Output:**

```json
{
  "status": "ok",
  "message": "autonomous mode active (version <current-version>)",
  "settings_path": "/path/to/merged-settings.json"
}
```

**Statuses:**

| Status      | Meaning                                          | Exit |
| ----------- | ------------------------------------------------ | ---- |
| ok          | File current, FACTORY_AUTONOMOUS_MODE=1          | 0    |
| bypass      | No file but env var set (CI path)                | 0    |
| stale       | File regenerated; session must relaunch          | 2    |
| missing     | First run; file generated; session must relaunch | 2    |
| stale-cache | usage-cache.json missing or >3600s old           | 2    |

---

## Test Runner

### bin/test

Master test runner for all pipeline test suites.

**Usage:**

```bash
bin/test [suite...] [--list]
```

**Flags:**

| Flag     | Description                      |
| -------- | -------------------------------- |
| `--list` | List available suites, then exit |

**Available suites:**

All `bin/tests/*.sh` files are discovered automatically by `bin/test`. Run `bin/test --list` for the current inventory of suite names; suite domains are encoded in the filename (e.g., `state.sh` covers `pipeline-state` / `pipeline-init` / circuit breaker; `routing.sh` covers quota and model routing).

**Examples:**

```bash
bin/test                     # Run every discovered suite (see `bin/test --list` for the current inventory)
bin/test state hooks         # Run only the state and hooks suites
bin/test --list              # Show available suite names
```

Suites live in `bin/tests/` with domain-scoped names (e.g., `state.sh`, `routing.sh`).

---

### bin/tests/run-all.sh

Aggregator script that discovers every sibling `*.sh` suite via `shopt -s nullglob`, runs each serially in a subshell (so a suite's `set -euo pipefail` cannot abort the runner), records exit code + wall time, and prints one line per suite plus an aggregate summary. Exits 0 iff every executed suite exited 0.

**Flags:**

| Flag            | Description                                                                   |
| --------------- | ----------------------------------------------------------------------------- |
| `--verbose`     | Stream each suite's stdout/stderr live (default: capture, print only on fail) |
| `--filter GLOB` | Run only suites whose basename matches GLOB (e.g., `wait-pr-*`)               |
| `--list`        | Print the discovered + filtered + post-skip test list and exit 0 (CI debug)   |

**Skip list:** `bin/tests/.skip` — one basename per line, `#` comments allowed. Every skip entry MUST carry an inline `# reason: ...` comment. Quarantine env-dependent tests only; never mask a regression.

**CI gating (added 0.10.3):** `.github/workflows/tests.yml` runs `bash bin/tests/run-all.sh` on every push and PR to `main` (ubuntu-latest, 30-min timeout, concurrency group `tests-${{ github.ref }}` cancels in-progress runs). The workflow installs `pnpm@9` (required by `hooks.sh` quality-gate fixtures via `detect_pkg_manager`'s default), configures a throwaway git identity, and uploads `/tmp/run-all.log` as an artifact on failure. Exists because a 30-day regression in `wait-pr-checks.sh` shipped undetected — local-only invocation discipline was insufficient.
