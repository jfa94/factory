# Design Decisions

This document explains key architectural choices and their rationale.

## Decision 1: Deterministic-First Architecture

**Choice:** Approximately 3:1 ratio of deterministic components (bin scripts, hooks) to non-deterministic (agents). If a step CAN be a script, it MUST be a script.

**Why:**

- Agent instructions are followed approximately 70% of the time
- Hooks and scripts enforce at 100%
- Concrete operational rules outperform abstract directives by 123% (research)

**Result:** 21 bin scripts, 4 plugin agents, 4 hooks. Scripts handle validation, state, classification, parsing. Agents handle code generation, review, spec creation.

---

## Decision 2: Orchestrator Runs in Main Session

**Choice:** The orchestrator logic lives in `commands/run.md` and runs in the invoking Claude Code session. It is not a sub-agent.

**Why not orchestrator-as-sub-agent?**

Claude Code only exposes the `Agent` tool to the top-level session. Sub-agents cannot themselves spawn further sub-agents. An orchestrator-as-agent therefore deadlocks the first time it needs to dispatch `spec-generator`, `task-executor`, or a reviewer.

**Why not a pure script orchestrator?**

Only agent sessions can invoke the `Agent` tool. A shell script cannot spawn sub-agents.

**Why not pure agent orchestration?**

State management, circuit breakers, DAG traversal, and classification MUST be 100% reliable. Agent instructions for these would fail approximately 30% of the time.

**Isolation:**

The orchestrator creates a dedicated worktree at `.claude/worktrees/orchestrator-<run_id>/` (Step 6a of `commands/run.md`) and runs all git operations there. The user's primary checkout is never touched. Sub-agents (`spec-generator`, `task-executor`, reviewers, `scribe`) continue to run with `isolation: worktree`.

**Mitigations:**

- State persistence: every state transition is written by a bin script
- Circuit breakers: deterministic limits prevent runaway execution
- Idempotent scripts: re-running produces the same output
- Resume capability: interrupted runs recover from persisted state

---

## Decision 3: Bundle All Pipeline Agents

**Choice:** All agents used by the pipeline are bundled inside the plugin's `agents/` directory. No user-provided agents are required.

**Why:**

- Documented behavior works out of the box — no missing-agent silent degradation
- Consistent output formats across all consumers; `pipeline-parse-review` never breaks
- Plugin ships as a complete unit; install = fully functional

**Trade-off:** Bundled agents pin behavior to the plugin version. User edits to plugin agents propagate to all pipeline runs from that project.

---

## Decision 4: Separate implementation-reviewer from quality-reviewer

**Choice:** Create a new `implementation-reviewer` agent in the plugin rather than reusing the existing `quality-reviewer` directly.

**Why:**

- `implementation-reviewer` adds acceptance-criteria validation
- `implementation-reviewer` validates holdout criteria (criteria the executor never saw)
- `implementation-reviewer` outputs machine-parseable structured format
- `implementation-reviewer` is round-aware (tracks review iteration)

The existing `quality-reviewer` is still used as a fallback when Codex is unavailable.

---

## Decision 5: Holdout Specs in Plugin Data, Not Repo

**Choice:** Store withheld acceptance criteria in `${CLAUDE_PLUGIN_DATA}/holdouts/`, outside the git worktree.

**Why:**

- Task-executors run in isolated worktrees
- If holdouts were in the repo, executors could read them
- Plugin data directory is inaccessible from worktrees
- Maintains holdout integrity

---

## Decision 6: Three-Tier Component Model

**Choice:** Three distinct tiers with clear responsibility boundaries.

| Tier        | Reliability                | Responsibility                                 |
| ----------- | -------------------------- | ---------------------------------------------- |
| Hooks       | 100% enforcement           | Safety constraints that must never be violated |
| Bin scripts | 100% given valid input     | Logic with a single correct answer             |
| Agents      | ~70% instruction following | Tasks requiring judgment, creativity, NLU      |

**Why not just hooks + agents?**

Hooks fire on specific events. They cannot be called on-demand by the orchestrator. Scripts fill the gap: on-demand deterministic logic.

**Why not just scripts + agents?**

Hooks are un-bypassable. Even if the orchestrator ignores instructions, hooks still fire. Branch protection via hook blocks force-push regardless of agent behavior.

---

## Decision 7: No External State Server

**Choice:** JSON files in `${CLAUDE_PLUGIN_DATA}` for all state management.

**Why:**

- Human-readable, trivially inspectable with `jq`
- No dependencies
- Same pattern as the original Bash pipeline

**Exception:** The metrics MCP server uses SQLite because metrics queries benefit from SQL aggregation.

**Atomic writes:** All state writes use `write-to-temp + mv` pattern to prevent corruption.

---

## Decision 8: Worktree Isolation Replaces Directory Locking

**Choice:** Each task-executor runs in its own git worktree.

**Why:**

- True isolation: each executor has its own working directory and branch
- No possibility of git conflicts between concurrent tasks
- No deadlocks from held locks
- Native support via Claude Code's `isolation: "worktree"` frontmatter

The lock (`pipeline-lock`) exists only to prevent two orchestrator instances from running simultaneously.

---

## Decision 9: Adversarial Review with Vendor Fallback

**Choice:** Use OpenAI Codex's adversarial review mode as primary reviewer when available; fall back to Claude Code's implementation-reviewer.

**Why Codex as primary:**

- Purpose-built adversarial review command
- Different vendor creates genuine independence (different biases, failure modes)
- Actor-Critic pattern is strongest when Actor and Critic are distinct systems

**Why Claude Code as fallback:**

- Codex may not be installed or authenticated
- Fallback must be fully functional
- `review-protocol` skill injects adversarial posture

Detection is deterministic: `pipeline-detect-reviewer` checks Codex availability via CLI commands.

---

## Decision 10: Dual Usage Checks (5h and 7d)

**Choice:** Run two independent usage checks before each task spawn with distinct behaviors.

**Why not coalesce into a single metric?**

- 5-hour limit is a burst constraint (temporary, appropriate to wait)
- 7-day limit is a budget constraint (indicates sustained over-consumption, should stop)

**5-hour behavior:**

- Over threshold: wait until reset

**7-day behavior:**

- Over threshold: end gracefully, mark partial
- Override: `/factory:run resume --allow-7d-over` bypasses the local circuit-breaker decision (see [Rate Limiting: Override](./rate-limiting.md#override))

**Why source from statusline?**

Claude Code's statusline JSON includes `rate_limits` data. The `statusline-wrapper.sh` script captures this to `usage-cache.json` on every statusline update — no API calls, no token cost, real-time data.

---

## Decision 11: Existing User Hooks Fire Automatically

**Choice:** Do NOT duplicate the user's existing hooks in the plugin.

**Why:**

- User's hooks fire for ALL agent sessions including plugin agents
- Duplicating would cause double-execution
- User customizations should be inherited, not overridden

Plugin-specific hooks (branch-protection, run-tracker, stop-gate) cover pipeline-specific concerns only.

---

## Decision 12: Staging Branch as Integration Point

**Choice:** All task worktrees branch from `staging`, and all task PRs target `staging`.

**Why:**

- `main` and `develop` are protected branches
- Multiple concurrent tasks modifying protected branches would conflict
- `staging` provides an integration layer without touching `main`
- Humans retain explicit control over what moves to `main`

**Dependent task ordering:**

Task B waits for Task A's PR to merge into `staging` before starting. Sequential execution for dependent tasks, parallel for independent.

---

## Decision 13: Bundled Autonomous Settings

**Choice:** The plugin ships `templates/settings.autonomous.json`. The `/factory:run` command detects whether the session was launched with these settings.

**Detection:** The settings file sets `FACTORY_AUTONOMOUS_MODE=1`. The command checks for this env var.

**Why not hook-based swap?**

The session must start with correct settings. Subagents inherit parent session settings. A swap approach risks leaving autonomous settings in place if the pipeline crashes.

---

## Decision 14: CI Integration and Conflict Handling

**Choice:** `pipeline-wait-pr` polls both PR merge status AND CI checks. On CI failure, attempt up to 2 automated fixes. On merge conflicts, attempt one rebase.

**CI failure retry limit (2):**

CI failures from pipeline output should be rare (quality gates run first). Two attempts handle transient issues. Beyond that, human judgment is needed.

**Rebase-once strategy:**

One rebase resolves most simple conflicts. If it still fails, the conflict is likely semantic and requires human review.

---

## Decision 15: Project Scaffolding

**Choice:** `pipeline-scaffold` creates project files on first run. Files only created if absent (idempotent).

**Why scaffold instead of bundled templates?**

Scaffolding files are project-specific artifacts. They belong in the user's repository, versioned and visible to teammates.

**Why idempotent?**

Users may customize files after first run. Overwriting would destroy customizations.

---

## Decision 16: Asymmetric Auto-Merge Strategy

**Choice:** Task PRs (→ staging) auto-merge with `--squash`. The final run-rollup PR (staging → develop) auto-merges with `--merge` (true merge commit).

**Why:**

- Squashing the rollup PR severs staging↔develop ancestry. Next run's `staging-init` cannot FF-reconcile, replays already-shipped work, or aborts on conflict.
- A merge commit on develop keeps staging tip as an ancestor of develop tip. `staging-init` fast-forwards in one step.
- Per-task squash on staging is still desired: collapses the test-writer + task-executor commit pair into one logical commit on the integration branch.

**Workflow gate:** `templates/.github/workflows/quality-gate.yml` checks `github.base_ref` to pick the strategy. Repo settings must permit merge commits on `develop`.

**`--delete-branch` on develop-target merges:**

The workflow uses `gh pr merge --merge --auto --delete-branch` for staging-to-develop rollup PRs. This deletes the `staging` branch after the PR merges. This is safe because:

- `bin/pipeline-branch staging-init` checks whether `origin/staging` exists (line 41) and recreates it from `origin/develop` (or the configured base branch) when missing (lines 85-106).
- The concern in this section is about merge _strategy_ preserving history within develop, not about the `staging` ref persisting between runs.

**Migration:** Already-scaffolded repos retain the old single-squash workflow. To pick up both this fix and the Node 24 action-runtime upgrade: delete `.github/workflows/quality-gate.yml` and re-run `pipeline-scaffold`, or patch the file manually to match the new template (asymmetric auto-merge + `checkout@v6`, `setup-node@v6`, `pnpm/action-setup@v6`, `cache@v5`).

---

## Decision 17: Coarse Bash Allow with Hook-Enforced Defense-in-Depth

**Choice:** `templates/settings.autonomous.json` lists `Bash(*)` in `permissions.allow`. The allow-list is intentionally coarse; the security boundary lives in hooks and `permissions.deny`, not in the allow-list.

**Why:**

- In fully autonomous mode there is no human in the loop to approve granular `Bash(...)` permission prompts. A missing allow rule would deadlock the pipeline mid-task.
- The LLM cannot enumerate every shell invocation it will need up front (build tools, test runners, ad-hoc `jq`/`awk`/`grep`, git plumbing, project-specific scripts). Coarse allow + hook-enforced denial is more reliable than fine allow + perpetually-missing rules.
- The real boundary is enforced at execution time by hooks, which fire on every Bash call and cannot be bypassed by an LLM that "didn't get the memo."

**Where the boundary actually lives:**

- `hooks/secret-commit-guard.sh` — blocks `git commit`/`push` when staged content matches the secret regex.
- `hooks/pretooluse-pipeline-guards.sh` — blocks scribe Bash writes outside `/docs/**`, blocks `gh pr create` without an attributable `task_id`, and similar pipeline-shape guards.
- `hooks/_security-common.sh` — shared deny library; `_is_nested_shell_or_hook_bypass` blocks nested-shell and hook-bypass attempts.
- `hooks/write-protection.sh` — blocks `Edit`/`Write` on `main`/`master` and protected files.
- The `permissions.deny` block in the same `templates/settings.autonomous.json` — dense list covering destructive shell patterns (`rm -rf /`, `git push --force*`, `--no-verify`), language `-e`/`-c` interpreters (`python -c`, `node -e`, `eval`), AWS destructive APIs (`iam delete-*`, `s3 rb`, `rds delete-*`), and writes to `~/.ssh`, `~/.aws`, `~/.claude/**`, etc.

**Why not narrow the allow-list?**

Every narrowing has been tried and produces the same failure mode: the pipeline halts on a command the allow-list did not anticipate, and there is no operator to approve it. The cost of one missed allow rule is a stalled run; the cost of one missed deny rule is bounded by the hook layer.

**Scope:** This design applies only to autonomous mode (sessions launched with `templates/settings.autonomous.json`, identified by `FACTORY_AUTONOMOUS_MODE=1`). Interactive sessions use the user's normal settings, which can — and typically do — enforce a tighter allow-list because a human is present to approve prompts.

---

## Plugin System Constraints

### Agents Cannot Use Hooks Per-Agent

All hooks in `hooks.json` fire for all agents. Hook scripts check context to decide whether to act.

### Agents Cannot Use mcpServers Per-Agent

MCP servers declared in `.mcp.json` are available to all plugin agents.

### Agents Cannot Use permissionMode

Cannot set per-agent permissions (e.g., read-only for reviewers). Reviewer agents are instructed to only use read tools; enforcement is ~70% reliable.

### No Process Manager Primitive

Solved by running the orchestrator in the main session. The command body IS the control loop.

### Concurrent Agent Results

The orchestrator (main session) emits multiple `Agent()` calls in one message. Claude Code invokes them in parallel natively. All results return in the same turn.

---

## Open Questions

### Codex Plugin Availability

Is the Codex Claude Code plugin stable and publicly available?

**Status:** Unvalidated. Fallback via Claude Code reviewer is fully functional.
