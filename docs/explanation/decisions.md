# Design Decisions

This document explains key architectural choices and their rationale.

> **Cutover annotation (2026-06-10, Scribe).** This ledger (D1–D27) is preserved
> verbatim as the historical design record. The project has since completed a
> big-bang rewrite from the original bash implementation to a Node + TypeScript
> engine, and a cutover commit deleted the bash sources. Decisions framed in
> bash-era terms — e.g. Decision 1's "41 pipeline-\* bin scripts / 13 hooks" — now
> map onto the **Model A** TypeScript surface: the deterministic engine is the
> single `factory` CLI (`src/` → `dist/factory.js`) plus the `factory-hook`
> dispatcher (`dist/factory-hook.js`, 7 guards in `hooks/hooks.json`); agents are
> the markdown surface (`commands/`, `agents/`, `skills/`). The _principle_ each
> decision records is unchanged; only the implementation substrate moved. For the
> current architecture see [model-a.md](./model-a.md) and
> [../architecture/overview.md](../architecture/overview.md). No decision below has
> been edited or removed.

## Decision 1: Deterministic-First Architecture

**Choice:** Approximately 5.4:1 ratio of deterministic components (bin scripts, hooks) to non-deterministic (agents). If a step CAN be a script, it MUST be a script.

**Why:**

- Agent instructions are followed approximately 70% of the time
- Hooks and scripts enforce at 100%
- Concrete operational rules outperform abstract directives by 123% (research)

**Result:** 41 pipeline-\* bin scripts, 10 plugin agents, 13 hooks. Scripts handle validation, state, classification, parsing. Agents handle code generation, review, spec creation.

---

## Decision 2: Runner Runs in Main Session

**Choice:** The runner logic lives in `commands/run.md` and runs in the invoking Claude Code session. It is not a sub-agent.

**Why not runner-as-sub-agent?**

Claude Code only exposes the `Agent` tool to the top-level session. Sub-agents cannot themselves spawn further sub-agents. An runner-as-agent therefore deadlocks the first time it needs to dispatch `spec-generator`, `implementer`, or a reviewer.

**Why not a pure script runner?**

Only agent sessions can invoke the `Agent` tool. A shell script cannot spawn sub-agents.

**Why not pure agent orchestration?**

State management, circuit breakers, DAG traversal, and classification MUST be 100% reliable. Agent instructions for these would fail approximately 30% of the time.

**Isolation:**

The runner creates a dedicated worktree at `.claude/worktrees/orchestrator-<run_id>/` (Step 6 of `skills/pipeline-runner/SKILL.md`) and runs all git operations there. The user's primary checkout is never touched. Sub-agents (`spec-generator`, `implementer`, reviewers, `scribe`) continue to run with `isolation: worktree`.

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
- `implementation-reviewer` validates holdout criteria (criteria the implementer never saw)
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

Hooks fire on specific events. They cannot be called on-demand by the runner. Scripts fill the gap: on-demand deterministic logic.

**Why not just scripts + agents?**

Hooks are un-bypassable. Even if the runner ignores instructions, hooks still fire. Branch protection via hook blocks force-push regardless of agent behavior.

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

**Choice:** Each implementer runs in its own git worktree.

**Why:**

- True isolation: each implementer has its own working directory and branch
- No possibility of git conflicts between concurrent tasks
- No deadlocks from held locks
- Native support via Claude Code's `isolation: "worktree"` frontmatter

The lock (`pipeline-lock`) exists only to prevent two runner instances from running simultaneously.

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

**Inverse-hallucination guards (fall through to fallback):**

In addition to "codex unavailable" and "codex rc non-zero", the runner treats two pathological codex outputs as faults and routes through the Claude Code fallback path (with a `task.review.codex_inverse_hallucination` metric logged):

1. `REQUEST_CHANGES` with zero verified findings — every finding's `verbatim_line` failed exact-line match against the diff, leaving the implementer nothing to fix.
2. `APPROVE` / `APPROVED` with non-zero `blocking_count` — internal contradiction; the review cannot be trusted to gate the task.

The fallback path is identical to a codex CLI failure: the bogus verdict file is discarded, agent reviewers are spawned, and the task continues. See `docs/reference/bin-scripts.md` (`pipeline-codex-review` and `pipeline-run-task`) for details.

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

**Enforcing the staging base deterministically (`worktree.baseRef: "head"`):**

By default Claude Code's `worktree.baseRef` is `"fresh"` — every `Agent({isolation: "worktree"})` worktree branches from `origin/<default-branch>` (here `origin/main`), **ignoring the runner's staging HEAD**. That left subagent worktrees on a stale `origin/main` base (the 2026-05-28 bootstrap defect: postexec automated gates failed because `origin/main` lacked pipeline scripts present on staging).

`.claude/settings.json` sets `worktree.baseRef: "head"`, which makes subagent worktrees branch from the **invoking session's local HEAD**. The runner fast-forwards (resume) or forks (fresh-create) its own worktree to `origin/staging` _before_ any subagent spawn (`skills/pipeline-runner/SKILL.md` §6), so every subagent — test-writer, implementer, reviewers, rescue — now births on the current staging tip with no per-agent bootstrap step.

- **Defense in depth:** the test-writer/implementer still run `git checkout -B <branch> origin/staging` (the `_stage_preflight` handler in `bin/pipeline-run-task-phases.sh`) as an _idempotent fallback_ — a no-op once the worktree already births on staging, and the safety net if the setting is absent/overridden. Do not remove it; dropping it would make correctness depend solely on a global setting.
- **Blast radius:** `worktree.baseRef` is project-wide. It also changes interactive human `--worktree` / `Agent({isolation:"worktree"})` use in this repo — worktrees carry local unpushed HEAD instead of a clean `origin/main`. For the pipeline this is strictly more correct; for ad-hoc human use it is a behavior change to be aware of. No per-spawn override exists.
- **Activation:** the `worktree` settings block is read at **session start**, not mid-session — it takes effect on the next session/run after the setting lands (supported since Claude Code v2.1.133).

**Update (2026-06-13):** Same root cause, downstream of this decision — the review panel and holdout-validator inspect a task with `git -C <taskWorktree> diff origin/staging`, **not** `diff staging`. The task worktree forks from the remote-tracking ref `origin/staging` (`createTaskWorktree`, `src/git/worktree.ts`) and never maintains a local `staging` branch, so a bare `diff staging` is stale-or-absent: it degraded silently in session mode and hard-errors in workflow mode. `origin/staging` is the fork point and the deterministic inspect base. See [verifier.md](./verifier.md#how-the-panel-and-holdout-inspect-a-task).

**Update (2026-06-19) — per-run base ref, not a bare `origin/staging`.** Following Decision 33's per-run branch, the inspect base is no longer the single shared `origin/staging` but the run's own `origin/staging-<run-id>`. The orchestrator computes it once from the run's PINNED branch (`base_ref = origin/${resolveStagingBranch(runId, run.staging_branch)}`, `src/orchestrator/orchestrator.ts`) and plumbs it through the spawn `NextAction` (`base_ref` field, [cli.md](../reference/cli.md#next-action)) to every reviewer and the holdout validator; both runners (`scripts/factory-run-runner.js`, `skills/pipeline-runner/SKILL.md`) and all six `agents/*.md` + `skills/review-protocol/SKILL.md` now diff against `<baseRef>`/`${env.base_ref}`, never a hardcoded `origin/staging`. `buildHoldoutPrompt(record, worktree, baseRef)` (`src/verifier/holdout/validate.ts`) requires the base ref and throws if a worktree is supplied without one. A bare `origin/staging` namespace-collides after a repo branch rename and resolves to the wrong/no commit — diffing reviewers against the wrong base.

**Update (2026-06-19) — worktree dependency provisioning at preflight.** `createTaskWorktree` only forks the git tree — it installs no dependencies, but the `test`/`type`/`build` gates run with `cwd=<worktree>` and have no skip-guard, so an empty `node_modules` made them fail closed (the root cause of a stalled run's gate-half never clearing). The preflight handler (`src/orchestrator/handlers.ts`) now runs `provisionWorktree` (`src/git/provision.ts`) immediately after the worktree is created, before the command-gates: it runs the configured `quality.setupCommand` if set, else a lockfile-detected install (`pnpm`/`yarn` frozen install · `npm ci`), else a no-op (Go/Ruby/Deno repos rely on their own runner / `.quality.redTestCommand`). It FAILS LOUD on a non-zero exit, so a broken environment halts as a clear preflight error rather than an opaque downstream gate failure. Because preflight persists its cursor before running, a provisioning (or base-tip-assert) failure leaves the worktree on disk; `createTaskWorktree` is therefore REPLAY-SAFE — on resume it reuses an already-registered worktree (`git worktree list --porcelain` probe → D12 `checkout -B` re-point) instead of a bare `worktree add` that would fatal on the existing path and wedge the run. See [configuration.md](../reference/configuration.md#quality) (`quality.setupCommand`).

---

## Decision 13: Bundled Autonomous Settings

**Choice:** The plugin ships `templates/settings.autonomous.json`. `factory autonomy ensure` materializes a `merged-settings.json` from it; relaunching with `claude --settings <merged-settings.json>` puts the session in autonomous mode. `factory autonomy status` reports whether the current session is autonomous (exits 0/1).

**Detection:** The settings file sets `FACTORY_AUTONOMOUS_MODE=1`. The single predicate is `src/autonomy/mode.ts` (`isAutonomous` = exactly `FACTORY_AUTONOMOUS_MODE === "1"`), shared by the engine gate (Decision 29) and the branch-protection / pipeline guards.

**Why not hook-based swap?**

The session must start with correct settings. Subagents inherit parent session settings. A swap approach risks leaving autonomous settings in place if the pipeline crashes.

---

## Decision 14: CI Integration and Conflict Handling

**Choice:** `pipeline-wait-pr` polls both PR merge status AND CI checks. On CI failure, attempt up to 2 automated fixes. On merge conflicts, attempt one rebase.

**CI failure retry limit (2):**

CI failures from pipeline output should be rare (automated gates run first). Two attempts handle transient issues. Beyond that, human judgment is needed.

**Rebase-once strategy:**

One rebase resolves most simple conflicts. If it still fails, the conflict is likely semantic and requires human review.

---

## Decision 15: Project Scaffolding

**Choice:** `factory scaffold` writes project files idempotently, under a **two-tier
file policy**:

- **MANAGED** — files the plugin is the sole author of: the CI net
  `.github/workflows/quality-gate.yml` and its cost-aware shard helper
  `.github/scripts/shard-mutation-scope.mjs`. These **auto-update by default**:
  when an already-scaffolded repo's copy drifts from the shipped template, the next
  `factory scaffold` overwrites it (reported under `files_updated`). This is the
  propagation path — a template fix (e.g. the 2026-06-18 mutation-shard rebalance)
  reaches downstream repos without a manual delete-and-re-scaffold.
- **SEED** — files the project owns after first write: `.stryker.config.json`,
  `.dependency-cruiser.cjs`, `eslint.config.mjs`. **Scaffold-once, then
  project-owned**: copied verbatim only when absent (a load-safe baseline), and an
  existing file is reported under `files_present` — never read, compared,
  overwritten, or flagged. There is no `files_outdated` bucket (retired): a SEED
  file that has grown into a richer project config (e.g. an `eslint.config.mjs`
  that imports `typescript-eslint`/plugins, or a `.dependency-cruiser.cjs` with
  extra boundary rules) is **recognized as current, not stale**. This is what
  preserves the never-fail-close lint property — a fresh repo only ever receives
  the dependency-free baseline (which loads before any plugin is installed), while
  an established repo's full config is left untouched.
- **MERGE** — `.gitignore` and `.claude/settings.json` are reconciled
  non-destructively (append missing entries / merge keys). The `.gitignore`
  guarantee makes the in-repo split **explicit**: each per-machine `.claude/` child
  (`worktrees/`, `projects/`, `settings.local.json`, …) is enumerated individually
  so `.claude/settings.json` stays **tracked** while `.claude/settings.local.json`
  is **ignored** — never via a wildcard `.claude/`, a sibling-enumeration, or a
  global `core.excludesfile` (which is not portable). `docs/factory/**` (the
  in-repo spec mirror) is deliberately **left tracked** as durable, PR-reviewable
  provenance of the spec that drove each merged PR.

**Why scaffold instead of bundled templates?**

Scaffolding files are project-specific artifacts. They belong in the user's
repository, versioned and visible to teammates.

**Why auto-update only the MANAGED tier?**

The CI workflow + shard helper encode plugin-owned pipeline machinery, not project
preferences; customizing them is unsupported by contract, and git is the safety net
(an auto-overwrite shows up in `git diff`). User-owned configs (SEED) are still never
clobbered — the original "overwriting would destroy customizations" concern applies
to exactly that tier.

**Known limitation — SEED rules do not propagate (deliberate).**

Because a present SEED file is never read, compared, or overwritten
(`applyTemplate`, `src/cli/subcommands/scaffold.ts`), a _new_ baseline rule added to
a shipped SEED template — e.g. an extra boundary rule in `.dependency-cruiser.cjs` or
a tightened `.stryker.config.json` threshold — does **not** reach repos that were
already scaffolded. Their existing copy is recognized as current. This is the
unavoidable cost of the project-ownership guarantee: the same rule that refuses to
clobber a repo's grown-up config also refuses to back-fill plugin baseline changes
into it. There is deliberately **no** drift-detection or merge mechanism for SEED
files — adding one would reintroduce exactly the clobber risk this tier exists to
prevent. A repo that wants a refreshed baseline opts in explicitly by deleting its
SEED file and re-running `factory scaffold` (which then re-copies the current
template). Plugin-owned machinery that _must_ stay in lockstep belongs in the MANAGED
tier, not SEED.

---

## Decision 16: Asymmetric Auto-Merge Strategy

**Choice:** Task PRs (→ staging) auto-merge with `--squash`. The final run-rollup PR (staging → develop) auto-merges with `--merge` (true merge commit).

**Why:**

- Squashing the rollup PR severs staging↔develop ancestry. Next run's `staging-init` cannot FF-reconcile, replays already-shipped work, or aborts on conflict.
- A merge commit on develop keeps staging tip as an ancestor of develop tip. `staging-init` fast-forwards in one step.
- Per-task squash on staging is still desired: collapses the test-writer + implementer commit pair into one logical commit on the integration branch.

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

**Why the nested-shell / hook-bypass guard is autonomous-only (by design, not an oversight):**

The TS port (`decideBranchProtection`, `src/hooks/branch-protection.ts`) denies a nested
shell (`bash -c …`, `sh -c …`) or hook-bypass **only when `isAutonomous()` is true** — a
faithful port of the bash `_is_nested_shell_or_hook_bypass` gate. A nested shell is a
legitimate, everyday tool in a **human** dev session (build scripts, one-liners, editor
integrations); denying it there would be a constant false-positive. It is dangerous only
in an **unattended** run, where it is the canonical way to smuggle a git write past the
parsed-command guards (the guard parses the visible command string; a nested shell hides
the real command from that parse). Scoping the gate to autonomous mode is therefore the
correct security/usability trade-off, not a gap — the same single `isAutonomous` predicate
that gates every other autonomous-only rail (Decision 13/29).

**Why not narrow the allow-list?**

Every narrowing has been tried and produces the same failure mode: the pipeline halts on a command the allow-list did not anticipate, and there is no operator to approve it. The cost of one missed allow rule is a stalled run; the cost of one missed deny rule is bounded by the hook layer.

**`additionalDirectories` (working-directory boundary):** Both the autonomous merged-settings (E2) and the scaffolded target `.claude/settings.json` (E1) declare a `permissions.additionalDirectories` entry plus `Read|Write|Edit(<data-dir>/**)` allow rules covering the data dir. The allow-list grants the _tool_, but Claude Code's working-directory boundary is an independent check: a built-in file tool (Read/Write/Edit) touching a path outside the launch directory still prompts the user to "add" the directory. The plugin writes to out-of-tree paths under the data dir (`results/`, `worktrees/`, `runs/`, `specs/`); declaring the single data-dir parent grants recursive access so those writes never trip the boundary — fatal in autonomous mode, where no human is present to approve the prompt.

**Why these rules are BAKED, never `${CLAUDE_PLUGIN_DATA}` (2026-06-20 fix):** Both emitters resolve the canonical data dir at emit time and write a _concrete path_ into the rule — they do **not** ship the literal `${CLAUDE_PLUGIN_DATA}` placeholder and trust Claude Code to expand it. Two independent reasons:

- Env-var interpolation inside permission rules is **undocumented / unsupported** by Claude Code. Only `~/` (in `Read/Write/Edit` globs) and absolute paths are documented to work; a `${VAR}` rule stays literal and matches nothing.
- `CLAUDE_PLUGIN_DATA` is **session-globally corruptible**: a co-installed plugin's `SessionStart` hook can re-export its own data dir into `$CLAUDE_ENV_FILE` (observed with the Codex plugin), which Claude Code sources for the whole session. A placeholder rule would then resolve to the _other_ plugin's dir.

So E2 substitutes the placeholder to the resolved absolute path at `factory autonomy ensure` time (`substitutePlaceholders` + `resolveDataDir`), and E1's `factory scaffold` bakes the `~`-tilde form (git-safe in a committed `.claude/settings.json`; absolute fallback when the dir is outside `$HOME`) via `buildTargetDataDirRules` (`src/cli/subcommands/target-settings.ts`). Both run through `resolveDataDir()`, which canonicalizes the foreign-plugin leak (`expectedDataDir`), so the emitted rule keeps matching even when the env var is hijacked. The scaffold merge also **migrates** any stale literal-`${CLAUDE_PLUGIN_DATA}` rules a repo carries from an older scaffold (exact-string strip → re-bake), so the prompt-on-every-write regression self-heals on the next `factory scaffold`.

**Scope:** This design applies only to autonomous mode (sessions launched with `templates/settings.autonomous.json`, identified by `FACTORY_AUTONOMOUS_MODE=1`). Since autonomy is now mandatory for a run (Decision 29), every _pipeline_ session is an autonomous one; an interactive session can still use the user's normal (tighter) settings for non-pipeline work, but `factory run create`/`resume` will refuse to start there.

---

## Decision 18: Reviewer Model is Fixed, Not Quota-Routed

> **Refined by Decision 21** (layered model/effort): the "fixed, not quota-routed" principle stands; the canonical tier becomes Opus and an effort dimension is added.

**Choice:** Reviewer subagents (`quality-reviewer`, `implementation-reviewer`, `security-reviewer`, `architecture-reviewer`) spawn with a fixed model. They do not consult `pipeline-model-router`. Default is `sonnet`; operator can override the entire reviewer surface via `package.json.factory.review.model` (and the parallel `review.maxTurnsDeep` / `review.maxTurnsQuick` / `testWriter.maxTurns` knobs).

**Why fixed (not quota-routed):**

- Review consistency outweighs quota economy. Two reviews of the same task that ran on different models can disagree, which inflates `request_changes` cycles and confuses reviewers' own retry logic.
- The Actor–Critic discipline (see Decision 9) is strongest when the Critic is held constant; varying the Critic by quota tier collapses the value of repeat reviews.
- Reviewer cost is small relative to implementer cost; routing reviewers by tier would save little.

**Why operator-configurable (added 2026-05-22):**

- Different installs land on different default models (ChatGPT-account Codex restrictions, opus availability, cost ceilings). A hardcoded `sonnet` was making it impossible to opt into `opus` reviews on cost-tolerant installs or to downgrade to a cheaper model on tight-quota installs.
- The override is applied once per run via `read_config` in `bin/pipeline-run-task` (single read, threaded through every reviewer spawn manifest). Consistency-within-a-run is preserved; only the model identity is operator-controlled.

**Trade-off:** Reviewers consume quota at the configured tier even on routine tasks. Accepted.

**Scope:** Applies to `bin/pipeline-run-task` reviewer / test-writer / scribe / implementer-respawn spawn manifests. The model router still governs initial implementer spawn decisions. The frontmatter defaults inside `agents/<name>.md` remain authoritative outside the pipeline.

---

## Decision 19: Full Autonomy — No Sanctioned Human-Escalation Valve

> **Aligned with Decision 20.** Autonomy and quality are both fundamental; they differ in _kind_, not importance — autonomy is binary-assurable (a hard _condition_), quality has no objective yes/no (the _maximand_). The no-escalation stance below is the operational consequence of the autonomy condition.

**Choice:** Within the domain boundary (PRD → `develop`), the pipeline targets _full_ autonomy. There is no designed human-escalation valve. The `NEEDS_DISCUSSION` review verdict that currently halts a Run for human input, and the human handoff after CI-fix retries are exhausted (Decision 14), are interim crutches — not endorsed end-states. The intent is that the system resolves every within-domain situation itself, including off-path auto-merge failures.

**Why:**

- Autonomy is a **fundamental condition** of the project — not a means to a quality end, nor an end that subordinates quality; both are the point (Decision 20). It is held as a hard _condition_ because it is binary-assurable ("did a human intervene?" is yes/no), whereas quality, lacking any objective yes/no, is the _maximand_. Automated gates, holdout validation, and review exist to _earn_ the trust to act unattended — not to route work to a human.
- A standing human valve would re-introduce the very dependency the domain exists to remove, and would let reliability gaps hide behind "escalate to a human" instead of being closed.
- Treating escalation as a bug (not a feature) keeps pressure on the real fix: more reliable reviewers and more capable autonomous recovery.

**Scope / boundary clarification:**

- The domain ends at the auto-merged rollup into **`develop`**: task PRs auto-merge onto `staging`, then the `staging → develop` rollup auto-merges (Decision 16) — both without human approval. Human control begins only at promotion from `develop` to **`main`**, which is **downstream and out of scope** — deliberate human ownership of the release boundary, not a contradiction of within-domain autonomy. The factory never touches `main`.
- What _is_ in scope, and therefore a crutch to retire over time: `NEEDS_DISCUSSION` → human (`bin/pipeline-run-task` postreview), and CI-retry-exhaustion → human (Decision 14).

**Trade-off:**

- Higher bar on reviewer reliability and recovery automation: every disagreement or failure the system cannot resolve is a gap to close in the agents/scripts, not a supported off-ramp.
- Until the crutches are retired, a Run can still stop for a human in those two cases. This is accepted as interim, and should be tracked as debt against the autonomy goal rather than relied upon.

---

## Decision 20: Objective Ranking — Quality Maximised Under an Autonomy Constraint

**Choice:** The project's objective is to produce **high-quality code without human intervention** — quality and autonomy are _both_ fundamental. They are not symmetric, though: **autonomy is a hard condition** (no human in the loop between PRD and the `develop` rollup) and **quality is the maximand**. **Cost** (tokens + wall-clock) is the free variable that flexes with quota. The human acts only at the boundaries: authoring the PRD, owning `develop → main`, and handling loud failures.

**Why the asymmetry is verifiability, not priority:**

- **Autonomy is binary-assurable.** "Did a human intervene between the PRD and the `develop` rollup?" has an objective yes/no answer, so autonomy can be enforced as a hard condition — a predicate every run either satisfies or fails.
- **Quality cannot be objectively guaranteed.** There is no binary certificate of "high quality." A property you cannot gate on, you can only push toward — so quality is the maximand: maximised, never proven complete. _If_ "high quality" were an objective yes/no, both quality and autonomy would be hard conditions; it is quality's non-verifiability — not a ranking of importance — that makes it the maximand instead.
- **This is the root of the whole trust architecture.** Because quality has no ground-truth certificate, the verifier layer (Decision 21) is the system's best _synthetic_ approximation of one — the closest thing to a quality yes/no it can manufacture. "Quality is the maximand" and "the verifier is the merge gate" are the same fact seen twice.
- **Downstream:** when quality and cost conflict, cost yields (within quota); when quality cannot be reached autonomously, the system fails loudly (Decision 22) rather than ship uncertain quality or call a human. Cost-flexes-with-quota makes throughput the shock absorber — under pressure the system slows or suspends, never lowers the bar.

**Relationship to Decision 19:** Decision 19 (no human-escalation valve) stands — it is the operational consequence of the autonomy _condition_. Decision 19's body has been **aligned** with this framing: where it once called autonomy "the domain's primary reason-for-being, not a means to a quality end," it now states that autonomy and quality are both fundamental, split into condition vs maximand by **verifiability** rather than by importance.

**Trade-off:** A run that cannot reach the quality bar autonomously gets no shortcut — it fails loudly (Decision 22), even at high cost or zero delivery. A confident-wrong merge is worse than a loud failure.

**Scope:** Autonomy is bounded by the subscription-quota envelope — quota is _environmental_, outside the autonomy domain; a quota-forced human relaunch (Decision 24) is mechanical, not a quality-escalation valve, so it does not violate this ranking.

---

## Decision 21: Layered Model/Effort Allocation

**Choice:** Allocate model tier and reasoning effort per layer by each layer's role in the quality chain:

| Layer                      | Model                       | Effort  |
| -------------------------- | --------------------------- | ------- |
| Spec (generation + review) | Opus                        | **Max** |
| Verifier (reviewers)       | Opus                        | Default |
| Producer (implementer)     | **Adaptive** (by task risk) | Default |

**Why:**

- **Spec is the apex.** Acceptance criteria are the operational definition of quality and the one gate with no machine-checkable ground truth (its only anchor is the PRD). A defect here is certified downstream as success, so it gets the most expensive configuration in the system.
- **The verifier is the trust anchor and is never cheapened on model.** It stands in for the absent human; review consistency (Decision 18) and credibility outweigh quota economy. Default effort suffices once the model is top-tier.
- **The producer is a tunable commodity.** Quality can't exceed what it can produce (the ceiling), so its model **adapts up** for high-risk/important tasks (e.g. security) and down for routine ones. This is where cost flexes.

**Relationship to Decision 18:** This **refines Decision 18** (reviewers fixed, not quota-routed). The "fixed, not quota-routed" principle is kept and extended to the whole verifier surface; the canonical fixed tier becomes **Opus** (Decision 18's `sonnet` default was a cost compromise, not the design intent), and the **effort** dimension plus the spec/producer allocations are added.

**Trade-off:** Top-tier verification plus max-effort spec work is a fixed, non-trivial expense every run. Accepted as the price of the trust anchor; savings come from the producer dial, never from review.

---

## Decision 22: Loud, Classified Drop with Partial Delivery

**Choice:** When the system cannot complete a task to standard, it **fails** the task — and a fail is **loud and classified**:

- Any permanently failed task ⇒ the **run is marked a failure** and the **PRD stays open**, even if every other task passed.
- The fail is **classified** by cause — at least _capability/budget exhausted_, _spec defect_, _blocked/environmental_ — so the failure report tells the human what to do.
- Completed work is **delivered**: the dependency-closed set of passed tasks (each a vertical slice, Decision 23) ships, loudly flagged as a partial result. A red **rollup full-CI gate** is likewise a run-level failure even when all tasks passed individually. The only forbidden outcome is **silent** absorption of a fail.

**Why:**

- Under the autonomy constraint (Decisions 19/20) there is no human to escalate to mid-run; the loud, classified fail is the _boundary handback_ — it returns precisely the un-certifiable work to the human, with a reason, after the run.
- Silence is the one behavior incompatible with a quality objective: a quietly-closed PRD with a missing task is a confident-wrong outcome.
- Partial delivery preserves verified high-quality work instead of discarding it to all-or-nothing; coherence is guaranteed by the vertical-slice contract plus the integration gate, not by hoping.

**Trade-off:** `develop` can carry an incomplete PRD (a partial feature). Bounded by: vertical slices leave no broken surface, the rollup gate certifies integration, and the loud failure + open PRD make the remaining work explicit.

---

## Decision 23: Vertical-Slice Decomposition (Hard Rule)

**Choice:** Every task in a spec must be an **independently-shippable vertical slice** — it adds standalone value and leaves no broken or dead surface if its sibling tasks are absent. This is a hard decomposition rule, enforced at spec generation/review, not a preference.

**Why:**

- It is the precondition that makes **partial delivery** (Decision 22) coherent: a failed task then leaves a smaller-but-whole result, not a half-built feature.
- It bounds integration risk: slices compose along explicit dependencies rather than through hidden horizontal coupling.
- It is good decomposition hygiene regardless of failure handling — vertical slices are independently reviewable, testable, and reversible.

**Trade-off:** Some PRDs resist clean vertical slicing (cross-cutting concerns, large migrations); the spec generator must work harder to find slice boundaries and may emit more tasks with explicit dependencies than a horizontal cut would. Accepted as the cost of coherent partial delivery and per-slice verifiability.

---

## Decision 24: Quota Pacing and the Execution-Mode Caveat

**Choice:** The pipeline bounds its own subscription-quota consumption by **proactive pacing**, not reactive backoff. Quota is **never a reason to fail work — only to pause it** (distinct from the Decision 22 retry-budget fail).

- **Two windows, paced linearly with a 10% reserve floor:**
  - **5-hour window** — burn ≤ 20%/hr; milestones at 80 / 60 / 40 / 20% remaining at hours 1 / 2 / 3 / 4; never below 10% remaining.
  - **7-day window** — the same shape pro-rated: ≤ 14.29%/day (100% ÷ 7); never below 10% remaining.
- **Over the curve → pause.** The binding (more-constrained) window wins.
- **5h breach → pause in place.** Self-heals within ≤ 5h as the curve descends with elapsed time and the window resets; the run holds.
- **7d breach → graceful stop.** The recovery horizon is too long to hold a live process, so the run exits cleanly — _paused, not failed_: the PRD stays open, completed tasks stay committed, and a **human relaunch resumes it from checkpoint** (chosen for implementation simplicity over automatic resume).

**Execution-mode caveat:** pacing needs an observable usage signal, which only the **orchestrated-session** mode has.

- **Session mode (default):** fully paced as above.
- **Workflow mode** — the pipeline driven as a background multi-agent Workflow script — **cannot observe usage**, so there is **no pacing**. The user is **warned at opt-in**, and the run simply **hard-stops** when the allowance runs out. The pause-not-fail guarantee still holds: the stop lands on committed-task boundaries, so a relaunch resumes; only the in-flight task's uncommitted work is lost (same guarantee, weaker mechanism).

**Why:**

- Proactive pacing keeps the run under the subscription wall, so the 5h window never _exhausts_ — quota pressure becomes a pause, never a failure. This is what "cost flexes with quota" (Decision 20) operationally means.
- The 5h / 7d split is about **recovery horizon**: a ≤ 5h pause is holdable in-process; a multi-day wait is not, so the long window forces a clean stop-and-resume instead.
- Quota is **environmental**, outside the autonomy domain (Decisions 19/20) — like the host losing power. A quota-induced human relaunch is _mechanical_ (resource), not a _quality/judgment_ escalation valve, so it does not violate the autonomy condition; it **bounds** it: end-to-end autonomy holds within the paced quota envelope, and a mechanical relaunch continues a run that exceeds it.
- Workflow mode trades pacing for the throughput of the Workflow runtime; the up-front warning plus task-boundary resumability keep cost bounded and the no-fail guarantee intact.

**Trade-off:** Proactive pacing can leave allowance unused (idling under-pace) rather than racing to the wall — deliberate, to respect subscription limits. The graceful-stop choice accepts a mechanical human touch-point on 7d-cap stops (vs the more-autonomous but more-complex auto-resume). Workflow mode accepts a hard, unpaced stop as the price of an unmonitorable runtime.

**Scope:** The milestone percentages (80 / 60 / 40 / 20, the 10% floor, 14.29%/day) are tuning parameters, not load-bearing. The load-bearing choices are: proactive-pacing-over-backoff, quota-pauses-never-fails, the 5h-pause / 7d-stop split, and the session/workflow mode caveat.

---

## Decision 25: Risk Determination and the Producer Escalation Ladder

**Choice:** A task's risk/importance — the input to the producer-model dial (Decision 21) — is a **spec-time judgment made by the spec generator** (Opus/Max), recorded as part of the task's acceptance criteria. It sets the **starting rung** of a failure-driven **escalation ladder**, and is never re-assessed mid-run.

- **Judgment, not heuristic.** Risk is assigned by the apex already reasoning over the whole PRD at max effort. Deterministic signals (auth/crypto/payment paths, blast radius, task type) and any human/PRD flags are _inputs_ to that judgment, not separate mechanisms.
- **One unified dial — difficulty and stakes folded together.** The producer dial is a single judgment of _how much model strength the task warrants_, blending **difficulty** (likelihood the producer gets it wrong) and **stakes** (cost if it does) — risk as P(error) × impact. This **supersedes** the earlier two-axis model (`proposals/design-intent-and-redesign.md` §7), which split a count-based _complexity_ dial (→ producer model) from a path-based _risk_ dial (→ review depth): the review-depth axis is gone (the merge gate is now risk-invariant, Decision 26), and "risk tier" now denotes this single producer dial.
- **Static tier = starting rung.** The risk tier fixes where on the producer-model ladder the task's first attempt begins (low-risk low; high-risk high).
- **Escalation is the only dynamic.** Each nuke-and-retry (Decision 22) bumps the rung along a combined **model→effort** dial (`src/producer/model-dial.ts`): it climbs the model to its **ceiling first** (a sub-ceiling task jumps straight to Opus on the first escalation rung), **then** climbs the effort/reasoning level (`xhigh`→`max`), injecting prior-failure context from rung 2 on. **A fail is the top rung exhausted.** A high-risk task starts at the ceiling, so it begins climbing effort immediately and reaches the top in fewer retries.
- **Cap = 4 extra attempts (5 total), shared.** The ladder is capped at `ESCALATION_CAP = 4` (`src/producer/escalation.ts`), enforced by `escalateOrFail` (`src/orchestrator/transitions.ts`). One `escalation_rung` counter is SHARED across producer failures and reviewer send-backs. Raised from 2 so a hard task gets the full model→effort climb before a `capability-budget` fail (see `jfa94/outsidey#231`); the cost is more spend per hard task (low-risk tasks now jump to Opus after two clean-slate fails) — the deliberate quality-over-cost tradeoff.
- **No mid-run re-assessment.** Under-estimation self-corrects for free: a task riskier than tagged simply fails review and escalates.

**Why:**

- **Risk-tiering is a performance optimization, not a safety control.** The dial sets only the **ceiling**; the verifier stays Opus regardless (Decision 21), so the **merge gate never moves**. A mis-classified task therefore **degrades gracefully** — a too-cheap producer fails review → more retries, or a loud fail — and **never ships bad code**. Because errors are safe, risk can be a judgment call rather than a brittle (if auditable) heuristic.
- **Spec-time is the right moment.** Risk is part of the operational definition of the task (the "target"), and the generator is already doing whole-PRD max-effort reasoning — the cheapest place to add the judgment, and the apex best positioned to make it.
- **One judgment + one ladder is the minimal mechanism.** Because escalation absorbs under-estimation, a separate mid-run risk-reclassifier would be redundant machinery.

**Trade-off:** A badly under-tagged high-risk task pays in wasted retries before it climbs to the tier it needed (or fails) — accepted, since the alternative (mid-run re-assessment) is more machinery for a failure mode the ladder already covers, and the merge gate guarantees the under-tagging never reaches `develop` as bad code.

**Relationship:** Refines Decision 21 (how the _adaptive_ producer dial is driven) and Decision 22 (its "nuke-and-retry outer bound" = the ladder's top rung; the risk tier = its starting rung).

---

## Decision 26: The Two-Layer Verifier and the Risk-Invariant Merge Gate

**Choice:** Verification is **two layers** — a **deterministic layer** (tests, mutation, coverage, SAST, type-check, lint, build: machine-checkable facts) and a **judgment layer** (the **review panel** — independent, single-purpose reviewers). The **entire merge gate is risk-invariant**: model, effort, review depth, and panel membership are fixed for every task in a run and do **not** vary with a task's risk. Only the **producer** (the ceiling) is risk-adaptive (Decision 25). **TDD exists to maximise the deterministic layer** — to convert as much of "quality" as possible into machine-checkable fact that needs no judgment.

- **Determinism-first, with TDD as the lever.** A deterministic fact can't be argued down; the judgment layer covers only what determinism can't reach. TDD grows the deterministic layer (every behaviour gets a test-first assertion), shrinking both the judgment surface and the producer's room to rationalise.
- **The merge gate does not move with risk — the safety counterpart to Decision 25.** The producer dial sets only the _ceiling_, so it can mis-classify and still degrade gracefully — _but only because the merge gate is constant_. A risk-sized panel (lighter review for "routine" work) would mean a task mis-tagged low-risk **skips the very reviewer that would have caught its defect** → bad code ships. So every reviewer runs on every task (a no-op when not applicable); the verifier is never thinned for "low-risk" work.
- **It is also forced by Decision 21.** "Widen scrutiny for risk" only makes sense if the baseline is cheap or narrow — but the verifier is always Opus at full depth, so there is no narrower baseline to widen _from_. Fixed-at-max is the only merge gate consistent with a never-cheapened verifier.
- **The panel evolves across versions, not across tasks.** "Fixed" means risk-invariant _within_ a run; the set of reviewers is still expected to change over time as industry standards do (Decision 9; the planned CCR borrows). Two senses of "not fixed": across-risk (forbidden) vs across-versions (expected).

**Why:** With no human judge, the verifier _is_ the quality merge gate and the trust anchor (Decision 20). A merge gate that moves with a fallible spec-time guess is not a merge gate. Holding the whole verifier constant is exactly what makes risk-misclassification a _performance_ question (wasted producer retries) instead of a _safety_ one (a missed defect) — the property that licenses the producer dial to be cheap and adaptive in the first place.

**Trade-off:** Every task pays full verification cost, trivial ones included. Accepted: the verifier is never the cost-flex point (cost flexes on the producer, Decision 21, and via pacing, Decision 24).

**Supersedes:** the "two orthogonal axes" model in `proposals/design-intent-and-redesign.md` §7–§8, where **risk sized the review panel** (routine / feature / security → 2 / 4 / 6 rounds + extra dimensions) and a separate **complexity** dial drove the producer. Review depth no longer varies with risk; risk drives only the producer (Decision 25, unified dial); and spec review is unconditionally max (Decision 21), not "scaled to the maximum risk tier across tasks."

**Relationship:** Pairs with Decision 25 (ceiling moves / merge gate fixed), realises Decision 20 (verifier = merge gate + trust anchor), depends on Decision 21 (fixed verifier model/effort), and is the structure whose output Decision 27 governs.

**Addendum (2026-06-20) — fail-closed command-gate tool resolution + a named block reason.** The deterministic command gates (`test`/`type`/`lint`/`mutation`) now resolve the worktree-local `node_modules/.bin/<tool>` (walk-up from cwd via `resolveLocalBin`, `src/verifier/deterministic/tools.ts`) and exec it directly instead of shelling out through `npx <tool>`. Root cause: under corepack + a `packageManager: pnpm@…` field (node ≥ 24) a bare `npx <tool>` bypasses the installed bin and resolves a REMOTE registry decoy (`npx tsc`/`npx vitest` exit 1), a false gate failure that the generic "merge gate not unanimous" reason then masked. When no local bin resolves, `runTool` FAILS CLOSED with a synthetic exit-127 result (`missingBinResult`) that names the tool — it never reintroduces the npx path. lint/mutation already skip on a missing bin; only the unconditional type/test gates reach the fail-closed path, where a missing tsc/vitest in a provisioned worktree is a genuine failure. The diff-scoped `test` gate also runs vitest with `--coverage.enabled=false` (a scoped run against a config with global per-file coverage thresholds was itself a false negative; coverage is the `coverage` gate's job). `resolveLocalBin` DELIBERATELY does not realpath-contain the resolved bin: a containment guard would reject pnpm's `.bin` symlinks (which point into the content-addressed `.pnpm` store outside the package dir — the very package manager whose npx decoy this dodges), and the gate layer already executes worktree-controlled code on the same trust boundary, so following a `.bin` symlink crosses no new privilege boundary. Finally, `mergeGateBlockReason` was consolidated into a single shared helper in `src/core/state/derive.ts` (replacing divergent private copies in `panel-run.ts` and the `handlers.ts` resume path); it names failing deterministic gates with their detail and reports an empty gate-evidence set explicitly, so a fail-closed gate surfaces instead of hiding behind unanimity wording. See [../reference/automated-gates.md](../reference/automated-gates.md) and [verifier.md](./verifier.md).

**Addendum (2026-06-24) — CI-parity gate env (`quality.gateEnv`).** The same fail-closed gates run in a **fresh task worktree** with no `.env.local` and no build-time env injection, so a repo whose CI supplies placeholder env for the same build step (e.g. a Next.js static prerender needing `NEXT_PUBLIC_*`) failed the `build` gate on a missing-env crash — a false-negative floor unrelated to task quality, the same class of bug the npx-decoy fix above addresses. Fix: a new `quality.gateEnv` config field (`z.record(z.string(), z.string()).default({})`, `src/config/schema.ts`) — a name→value map merged over `process.env` into every gate command's spawn env via `defaultGateTools(gateEnv)` (`src/verifier/deterministic/tools.ts`), wired from config in `src/cli/wiring.ts`. Operators set it with `factory configure --set quality.gateEnv.<KEY>=<value>`. It is **CI parity, NOT a secret store** — the values live in the plaintext config overlay; only placeholders belong there. The string-only schema makes each value an explicit "set this var" (a numeric-looking value must be quoted as JSON at the `--set` boundary). See [../reference/configuration.md](../reference/configuration.md#gateenv--ci-parity-placeholders) and [../reference/automated-gates.md](../reference/automated-gates.md#ci-parity-gate-env-qualitygateenv).

**Addendum (2026-06-24) — auto-detecting `quality.gateEnv` from CI.** Transcribing each placeholder by hand (the manual `--set` above) is the escape hatch; the preferred path now AUTO-DETECTS the CI build env from the repo's workflow YAML (`src/ci/detect-gate-env.ts`, `factory configure --detect-gate-env`). Three design choices: (1) **Hand-rolled YAML line-scanner, no `yaml` dependency** — the dist bundles inline every dep and the surface needed (step/job-level `env:` literals) is narrow; its safety property is **bias to MISS, never mis-detect** (block-style space-indented YAML only; a var in anchors/aliases/merge-keys/flow-mappings is silently skipped, never mangled — the miss's escape hatch is the manual `--set`). Three policy filters fail a value before it reaches gateEnv: a `${{ }}` GitHub-expression ref (unusable + unsafe), anything the secret scanner flags (defense-in-depth — gateEnv is placeholders, not a secret store), and structurally anything inside a `run: |` block scalar. (2) **Gap-fill, operator wins** — detection only fills keys the overlay does not already have; a detected value that differs from a configured one is reported as a CONFLICT (preserved, not overwritten), equal is skipped (idempotent), and the overlay is written only when there are new keys. (3) **Detect-before-managed-overwrite ordering** — `factory scaffold` runs detection FIRST, before its `quality-gate.yml` managed template clobbers the repo's own workflow, so the repo author's CI env is captured into the durable overlay while that file is still theirs. See [../reference/cli.md](../reference/cli.md#configure) and [../reference/configuration.md](../reference/configuration.md#gateenv--ci-parity-placeholders).

---

## Decision 27: Verify-Then-Fix — Reviewer Findings Are Confirmed Before They Act

**Choice:** A reviewer's blocker reaches the producer only after an **independent verifier confirms it against ground truth**. Unverified findings never trigger a fix or a retry. This is the false-_positive_ twin of Decision 1's derive-don't-store: the system already refuses to trust a _PASS_ the producer claims (re-derive the verdict → guard false _negatives_, bad code merging); it now also refuses to trust a _FAIL_ a reviewer claims (re-derive the finding → guard false _positives_, good code needlessly "fixed").

- **Why this matters more here than in industry tools.** Every shipped AI reviewer inserts a verification pass (Anthropic Code Review's "verification step checks candidates against actual code behavior"; the `claude-code-security-review` `findings_filter`; Cloudflare; Datadog) — but each has a _human_ reading the output, for whom a false positive is ignorable noise. This loop has **no human filter**: the producer acts on every finding, so a false positive becomes a **harmful fix to working code**. Precision is non-negotiable, not a nicety. (The "recall beats precision" stance only holds when something downstream filters; nothing does here.)
- **The verifier must be independent.** LLM self-review carries a leniency bias and shares blind spots with the finder ("fail in correlated ways"). Verification runs in a fresh context, cross-vendor where available — never the finder re-checking itself (extends Decision 9 independence to finding-verification).
- **Evidence bar, not confidence vibes.** A finding must carry ground-truth evidence — a `file:line` citation / repro that substring-matches real code — not an inference from naming. (This is the deterministic citation-verify filter already planned in `design-intent-and-redesign.md` §8 / Delta K; determinism-first applied to reviewer output.)
- **Adversarial framing, single bounded pass.** The verifier is asked _"does this finding hold against the code?"_, never _"is this a false alarm?"_ — confirmation-bias framing swings detection 16–93%. And it runs **once** per finding: "more rounds, more noise" — an iterative debate measurably degrades versus a single pass.
- **"Account for every blocker" = fix-or-justify, bounded.** A confirmed blocker returns the task to the producer (the merge gate is conjunctive — _unanimous_ approval to ship). The producer may **rebut** a verified finding once, with evidence, adjudicated by the independent verifier (not the original reviewer) — a single shot, not a multi-round contest.

**Why:** The verifier is the trust anchor (Decision 20); a _noisy_ merge gate corrodes trust as surely as a _low_ one. In an autonomous loop a false positive doesn't merely churn quota — it degrades the very code quality that is the maximand. Verification is the cheapest way to keep the merge gate _trustworthy_, not merely _present_. The pattern is the frontier default (Anthropic, Cloudflare, Datadog), and the research around it (leniency bias, confirmation-bias framing, "more rounds, more noise") dictates the four constraints above.

**Trade-off:** A verification pass per finding costs tokens and latency, and a wrong verifier could suppress a _real_ finding — mitigated, not eliminated, by independence + adversarial framing + the evidence bar. The residual is accepted as strictly smaller than the false-positive-fix risk it removes.

**Relationship:** Extends Decision 1 (derive-don't-store — the false-negative side), Decision 9 (independent review), and Decision 26 (the judgment layer whose output this governs); realises the trust property in `proposals/quality-architecture.md` §3.

---

## Decision 28: One Engine, One Seam (the Orchestrator), Two Thin Drivers

**Choice:** The deterministic `factory` CLI owns **all** pipeline control flow — including the loop itself — and exposes exactly **one** seam, the **orchestrator**, in two halves:

- `factory next-task` — the **run-level** orchestrator (`src/orchestrator/next.ts`, `nextTask`): emits a `NextTask` of ready tasks (or terminal / pause).
- `factory next-action` — the **task-level** orchestrator (`src/orchestrator/orchestrator.ts`, `nextAction`): emits a `NextAction` spawn request; re-invoked with `--results` it records the spawned agents' raw output into exactly **one** state step (record cores in `src/orchestrator/record.ts`).

A **runner** carries no pipeline logic of its own — it only calls the orchestrator, spawns the `Agent()`s the `NextAction` request names, and feeds their output back via `next-action --results`. Two interchangeable runners step the same seam, selected by `--workflow` on `/factory:run` (Decision 32):

- session (default, no flag) — the in-session LLM runner loop (`skills/pipeline-runner/SKILL.md`), which can spawn `Agent()`s directly.
- `--workflow` — the plugin-shipped Workflow script (`scripts/factory-run-runner.js`), which wraps every CLI call in a small exec agent (Workflow JS cannot shell out).

Both are subscription-only; there is no headless `claude -p` / API-token path.

**Why:**

- **One implementation of the loop, by construction.** The earlier design had the loop expressed twice — an in-process runner (`src/orchestrator/loop.ts`, `driveTask` / `driveRun`) used in tests, and the runner skill mirroring it by prose — kept in agreement only by discipline. Collapsing both onto the orchestrator makes the loop a single tested kernel both runners inherit verbatim; two runners cannot diverge on a transition because neither owns one.
- **Idempotent, exactly-once records.** `next-action` without `--results` re-derives the same spawn envelope from persisted state (safe to retry after any crash); `next-action --results` validates the echoed `result_key` (`{phase, rung}`) against the live cursor before any mutation, so a stale or duplicate delivery is rejected loud instead of double-recorded. The resume cursor is the new `TaskState.phase` field.
- **The seam is runner-agnostic.** Because the orchestrator emits a spawn request and the runner merely spawns it, adding a runner (e.g. a future out-of-session scheduler) is a new thin loop over the unchanged seam — not a re-implementation of pipeline logic.

**What this retired:** the six single-step CLI writers — `run-task`, `advance`, `fail`, `record-producer`, `record-holdout`, `record-reviews` — collapsed into the orchestrator; their record logic now runs inside `next-action --results` (`src/orchestrator/record.ts`). `src/orchestrator/loop.ts` and `src/orchestrator/agent-runner.ts` (the in-process `driveTask` / `driveRun` loop) were deleted. The surviving non-orchestrator writers are `spec`, `rescue`, `scaffold`, `configure`, `state`; the current `factory` subcommand registry is `autonomy, config-defaults, configure, next-action, next-task, rescue, resume, run, scaffold, score, spec, state, statusline`.

**Trade-off:** A runner re-invokes the CLI per step (one process spawn per orchestrator call) rather than running the loop in-process, and must persist/relay the per-spawn results file between `next-action` calls. Accepted: the spawn boundary is where an `Agent()` call is unavoidable anyway, and per-call idempotency is what makes crash-resume and the two-runner story sound.

**Relationship:** Realises the Model-A split (Decision 2) as a single seam rather than a reporter+writer fan-out; preserves derive-don't-store (Decision 1) and verify-then-fix (Decision 27) — both now record through `next-action --results`; the workflow runner is the unpaced mode of Decision 24.

---

## Decision 29: Autonomy is Mandatory — Enforced in the Engine, No Opt-Out

**Choice:** Autonomous mode is not an opt-in convenience; it is a **precondition** for a run. `factory run create` and `factory run resume` call `requireAutonomousMode()` (`src/autonomy/mode.ts`) as their first act and **HALT loud** (`NotAutonomousError`, non-zero exit) when `FACTORY_AUTONOMOUS_MODE !== "1"`. There is no bypass flag and no opt-out. `factory autonomy status` is the diagnostic (exits 0/1, never throws).

**Why:**

- **The pipeline is designed to run unattended** (Decisions 19/20). A non-autonomous `/factory:run` used to "work" only by degrading into a per-tool permission-prompt crawl — silently defeating the unattended design and leaving half-created runs behind. Refusing loud at the source is the honest behavior.
- **Enforced in the deterministic engine, not the markdown surface.** The gate is a typed error in the CLI, so it cannot be skipped by editing a prompt or skill; it mirrors `ProtectionMissingError` (Decision 12's branch-protection refusal) as a hard start condition.
- **Single predicate.** `isAutonomous` is the one source of truth, shared by this gate and the hook layer (branch-protection / pipeline guards), so the autonomous signal can never diverge between "may this run start" and "may this run merge."

**Scope of the gate (deliberately narrow):** Only `create` + `resume` are gated — the two verbs that bring a run into existence or re-activate it, both of which execute in the **foreground runner session** that definitively carries the env. Downstream verbs (`next-task`/`next-action`/`finalize`) operate only on an already-autonomous run and stay ungated, so the workflow runner's background exec-agent CLI calls carry no env-propagation dependency. The shipping operations are independently autonomous-gated at the hook layer (`pipelineCanWrite`, Decision 12).

**Trade-off:** A hand-typed `factory next-action --run X` in a non-autonomous shell against a pre-existing run is not caught (never something `/factory:run` does). Closeable later by stamping autonomy on the run record (no env dependency) if ever needed.

**Relationship:** Operationalises the autonomy _condition_ of Decisions 19/20 as a runtime precondition; complements Decision 13 (how a session becomes autonomous) with the enforcement of _requiring_ it.

---

## Decision 30: Guards Derive Run Ownership From Their Own Inputs — No Hook Reads the Global Pointer

**Choice:** A hook never asks "what is the active run?" via the shared mutable pointer (`runs/current`). Each guard **derives the owning run from the signal it already holds**, so N runs across different repos run concurrently — each with TDD enforced — while same-repo simultaneous `run create`s stay serialized:

- **Write-scope arm** (the TDD rail in `pipeline-guards.ts`) derives `{run_id, task_id}` from the **target file path**. A producer writes into `<dataDir>/worktrees/<run_id>/<task_id>/…`; Claude's `Edit`/`Write` `file_path` is absolute, so the path encodes both ids (`runTaskForPath`, `hook-context.ts`; `worktreesRoot`, `core/state/paths.ts`). A target under no worktree is not a producer write → pass through (the bug fixed: an unrelated session editing a non-test file no longer trips the live run's test-writer scope). A target under a worktree whose run/task is missing or corrupt → **fail closed** (deny).
- **Bash arms** (nested-shell, ship) scope by **owner session**: the live run whose `owner_session` equals `CLAUDE_CODE_SESSION_ID` (`StateManager.findActiveByOwner`). No owning run → pass through; env id absent → retain prior behavior (these arms are lower-stakes — nested-shell is a rail, ship is dormant — so they carry the only residual runtime assumption, isolated from the critical write arm).
- **Stop gate** resolves the run **owned by the stopping session** (`findActiveByOwner(stoppingSession)`) instead of `readCurrent()`, so a clobber can no longer make a stopping owner finalize the wrong run; unknown session → degrade to `readCurrent()`.
- **`holdout-guard`** reads only `dataDir` — correctly global, untouched.

**Per-repo `current` is CLI-only (not load-bearing for concurrency).** After the guards stop reading the global pointer, concurrency-correctness is already done. A separate `<dataDir>/current/<repoKey>` → `../runs/<run_id>` pointer tree (kept out of `runs/` so `listRuns` is untouched) only makes the human CLI (`state`/`score`/`rescue`/`run` resume with no `--run`) pick the right run for the caller's checkout (`readCurrentForCwd` resolves the repo from `origin`; unresolvable → global fallback). `run create` writes both the per-repo and legacy global pointers; `pointCurrentAt` **refuses loud** (pre-write) to repoint a repo whose current names a still-live run owned by a different known session — the new run's `state.json` already exists, so it stays addressable via `--run`. `next-task` is left on the global-pointer + `--assert-owner` mechanism untouched; `next-action` still requires `--run`.

**Why:**

- **Ownership is a property of the tool call, not of machine-global state.** The root cause of "runs can't coexist" was one design mistake: globally-installed hooks consulting a single shared mutable pointer instead of deriving ownership from the call. Each guard now reads ownership from inputs it already has — the write arm's target path, the Bash/Stop arms' session id — so enabling the plugin in an unrelated session can never leak a live run's scope into it.
- **The critical arm needs no runtime spike.** Scoping by `session_id` payload or by `process.cwd()` both depend on unprovable-from-repo runtime facts (does a subagent's hook payload carry the runner's id? `Edit`/`Write` honor no `cd`). The worktree target path is the signal the guard **already extracts** and is absolute by construction — verified-correct without a spike. The owner-session scope on the two lower-stakes Bash arms is the only place a runtime assumption survives, and it fails safe.
- **Defense-in-depth, not a weakened boundary.** The write-scope arm is a rail; the authoritative TDD enforcement remains the deterministic commit-order gate on the task branch (`src/verifier/deterministic/strategies/tdd.ts`), which a path-anchor miss does not weaken.

**Trade-off:** A producer write via `Bash` (rather than `Edit`/`Write`) still bypasses the path-anchored rail — already true and already documented; the commit-order gate is the real boundary. The Bash arms' owner-session scope degrades to prior (occasionally cross-session) behavior when `CLAUDE_CODE_SESSION_ID` is absent in the hook subprocess.

**Relationship:** Extends derive-don't-store (Decision 1) to the hook layer — ownership is derived per call, never stored in a global pointer; shares the single `isAutonomous` predicate path with Decision 29; the clobber refusal mirrors the loud start-condition refusals of Decisions 12/29.

---

## Decision 31: Run-Entry Preflight Auto-Scaffolds Autonomous Settings

**Choice:** `/factory:run` (and `/factory:debug`) call `factory autonomy preflight` as their first setup step. Preflight is a thin CLI wrapper around a **pure decision** (`decideAutonomyPreflight`, `src/autonomy/mode.ts`) over three inputs — is this session autonomous, does `merged-settings.json` exist, and does its stamped `_factoryVersion` match the installed plugin. It **regenerates the merged settings (via `ensure`) and halts for a relaunch** when the session is not autonomous OR the settings are stale / missing / unstamped; it **proceeds** when they are already fresh, or when the session is autonomous via a directly-exported env (the CI path), or when the plugin version is unreadable (regenerating would only churn). It exits 0 to proceed, 1 to halt, and — like `status` — never throws on the decision path. `ensure`/`status` remain the manual primitives.

**Why:**

- **Restores a lost convenience, faithfully.** The old bash `pipeline-ensure-autonomy` auto-regenerated the merged settings on (missing OR version-changed) and halted with the relaunch command; the Node+TS port shipped `ensure`/`status` as clean primitives but failed the detect-and-regenerate step and wired no caller. The convenience fell through the cutover — it was a gap, not a reasoned UX decision. Preflight re-composes the primitives into that run-entry behavior.
- **Decision logic lives in the engine, not prose.** The verdict is a pure, total, IO-free function (Model A): testable in isolation, with the markdown surface reduced to "run preflight; on non-zero relay the printed command and stop." The CLI wrapper does IO only and delegates every write to the one `ensure` writer path (idempotency + statusLine chaining for free).
- **The relaunch is irreducible.** Claude Code reads settings only at session launch, so a running session can never make _itself_ autonomous. Automation can cover the **scaffold**, never the relaunch — so preflight stops at printing the command. The hard invariant `regenerate ⟹ halt` encodes this: settings written mid-session can't load into the running session, so proceeding on a fresh regenerate would reintroduce false freshness.
- **No lock needed.** `merged-settings.json` is a pure function of (template, user-settings, plugin version), so concurrent atomic writes from racing preflights converge to the same bytes.

**Trade-off:** Preflight is a UX layer, not a correctness layer — a hand-typed `factory next-action` in a non-autonomous shell still bypasses it. That is exactly why `requireAutonomousMode()` (Decision 29) remains the backstop in `create`/`resume`; preflight makes the common path friendly, the gate keeps the uncommon path safe.

**Relationship:** Sits in front of Decision 29 (the mandatory gate, untouched); operationalises Decision 13 (how a session becomes autonomous) as an automatic run-entry step.

---

## Decision 32: Ship Live by Default; Boolean `--workflow` / `--no-ship` Run-Entry Flags

**Choice:** A no-flag `/factory:run` resolves to **session mode + live ship**: the in-session runner loop drives the run, each task auto-merges into staging, and the staging→develop rollup merges into develop. The two deviations from that default are terse booleans on the user-facing lifecycle verbs:

- `--workflow` → run the background Workflow runner instead of the in-session loop (persisted as `mode: "workflow"`).
- `--no-ship` → open the task/rollup PRs but never merge (persisted as `ship_mode: "no-merge"`).

The verbose `--mode <session|workflow>` / `--ship-mode <no-merge|live>` pairs are **removed** from the user-facing verbs (`run create`, `run finalize`) — not kept as back-compat. `--ship-mode` survives only on the **internal orchestrator seam** (`factory next-action`, `factory next-task` via `--expect-mode`), where the runners machine-generate it and a user never types it; omitting it there honors the run's persisted value. `live` is the single-source-of-truth default in the schema (`ShipModeEnum.default("live")`, `manager.ts`), so schema and CLI agree without a second hardcoded fallback.

**Why:**

- **Auto-merge is the pipeline's purpose, not an opt-in.** A quality-first, TDD-enforced run that ends with an un-merged PR has not shipped. The merge is already gated four ways — branch protection (Decision 12), the risk-invariant review panel (Decision 26), the TDD commit-ordering rail, and the holdout — so `live` is safe to make the default; `no-merge` is the cutover-safety exception, kept for staged rollouts and dry runs.
- **Boolean flags match how operators think.** "Run it" / "run it in the background" / "run it but don't merge" maps to _nothing_ / `--workflow` / `--no-ship` — no value to remember, no enum to mistype. The verbose pairs added a second spelling of the same two dials for no benefit, so they were removed outright rather than carried as hidden aliases (a second accepted spelling is a maintenance and ambiguity cost with no user value once the boolean exists).
- **Persisted-once, read-many.** `mode` and `ship_mode` persist on the run at `run create`; `next-task`/`next-action`/`finalize` and the workflow runner + `resume` read them from state, so the runner never re-marshals ship intent through Phase 3. `run finalize` defaults to the persisted `ship_mode`; its `--no-ship` overrides that one finalize call only.

**Trade-off:** Because the CLI now always resolves a concrete `mode`/`ship_mode` from the flags, the reuse-mismatch guard fires whenever a bare re-`create` resolves to a different intent than the run it would reuse — e.g. re-running a `--workflow`/`--no-ship` run without those flags now hard-fails (loud `UsageError`) instead of silently reusing. This is the desired safety (never drive a pre-existing run under a ship intent the operator did not ask for); the fix is to match the run's flags or pass `--new`. Direct-API callers that pass `mode`/`shipMode` as `undefined` still reuse without divergence (the guard compares only defined intent).

**Relationship:** Inherits the two-runner seam of Decision 28 (`--workflow` is just the runner selector) and the unpaced-workflow contract of Decision 24; the live-by-default merge rides the shipping gates of Decisions 12/26; the reuse-mismatch guard composes with the per-`(repo, spec_id)` run isolation of Decision 30.

---

## Decision 33: Per-Run Staging Branch (Replaces the Single Shared Staging Branch)

**Status:** Implemented (2026-06-18). Supersedes the single-shared-`staging` model assumed by Decisions 12 and 32. `runStagingBranch(runId)` (`src/git/run-staging.ts`) is the single branch-name source; `run create` cuts + protects `staging-<run-id>` from `develop`; ship/handlers/serializer/rollup/finalize target it; scaffold now protects `develop` instead of a shared `staging`; finalize forward-reconciles `develop` into the run branch before rollup.

**Choice:** Each run integrates its tasks on its own private branch `staging-<run-id>`, cut from the current tip of develop at `run create`, instead of all runs sharing one long-lived `staging` branch. Task PRs target the run's own `staging-<run-id>`; that work is invisible to develop and to every other run until the run completes.

**Why:**

- **Confinement makes recovery non-destructive.** An unfinished run's work lives only on its private branch, so superseding, resuming, or rescuing it never touches develop and never reaches for a force-push (forbidden by construction — `GitClient` exposes no force method, `src/git/git-client.ts`).
- **It removes the cross-PRD contamination hazard** of the shared branch: two concurrent runs no longer pile onto one integration line, so cleaning up one never disturbs another.
- **"Start from scratch" becomes literally true and safe:** a fresh run gets a clean branch from current develop; the abandoned attempt is just a branch nobody continues.

**Mechanics:**

- Cut `staging-<run-id>` from current `origin/develop` at `run create`, so staging starts up-to-date with develop.
- Before the completion rollup merges to develop, reconcile forward if develop advanced in the meantime — integrate develop into the run branch (forward-only; never rebase-publish or force-push). The exact sequence (fast-forward vs merge-develop-in to satisfy a "branches up to date" requirement) is an implementation detail, but it is always forward-only and bounded to once per run, at completion.
- `superseded` deletes its `staging-<run-id>` immediately (auto-closing its open task PRs). `failed` KEEPS its branch so rescue can reopen and resume the work already banked on it. Branches orphaned by a fresh start (rather than supersede) are cleaned up manually.

**Amendment (2026-06-19) — flat `-` delimiter, not `/`.** The per-run branch is `staging-<run-id>`, not `staging/<run-id>`. Git stores refs as files (`refs/heads/…`), so a slashed `staging/<run-id>` requires `staging` to be a _directory_ — which collides with a target repo's long-lived `refs/heads/staging` release branch (the common `develop → staging → main` flow). That collision is config-unfixable (the prefix is hardcoded) and blocks every `run create` in such a repo. A flat `staging-<run-id>` shares no path segment with `refs/heads/staging`, so the two coexist regardless of the target repo's branch layout. `runStagingBranch(runId)` (`src/git/run-staging.ts`) builds the name construct-only — nothing parses it — so no callers changed. Runs created before this change live on the old slashed name; they are ephemeral, so supersede/restart rather than migrate.

**Amendment (2026-06-19) — pin the branch name in `RunState`, don't recompute it.** The branch name is now **pinned once at `run create`** into `RunState.staging_branch` (`src/core/state/schema.ts`) and read everywhere through a new pure resolver `resolveStagingBranch(runId, pinned?)` (`src/git/run-staging.ts`): it returns the pinned name when present, else falls back to `runStagingBranch(runId)`. `run create` computes the name once and threads it through `state.create({…, staging_branch})`; every read site — preflight base, the verify gate `baseRef`, ship's PR base + `MergeSerializer` staging (`src/orchestrator/handlers.ts`, `src/orchestrator/ship.ts`), the spawn envelope's `base_ref` (`src/orchestrator/orchestrator.ts`), the holdout validator baseRef (`src/orchestrator/record.ts`), and the finalize rollup + branch GC (`src/orchestrator/finalize.ts`) — resolves through it. _Why:_ recomputing the name on every read silently desyncs the gate base ref / worktree fork point from the branch already pushed to origin if the naming scheme changes mid-run (as the flat-delimiter amendment above just did) or the repo branch layout shifts. A pinned identity is the run's git provenance — an immutable fact about what was created, not a recomputed verdict — so storing it does **not** violate derive-don't-store, which governs only re-derivable quality verdicts (gate pass/fail, the merge gate). The resolver keeps a pure `(string, string?) => string` signature with no `RunState` import, so the git layer stays independent of `core/state`. Legacy runs created before the field fall back to the recomputed name, so nothing breaks.

**Trade-off:** Per-run branches diverge from develop over their lifetime, so a run that completes after another has merged to develop must reconcile forward before its rollup — integration work the single forward-only shared branch did not need. Accepted: the reconciliation is forward-only and bounded, and it buys the confinement that makes the whole recovery model safe.

**Relationship:** Keystone for Decisions 34 and 35; replaces the shared-`staging` assumption in Decision 12's worktree-base invariant and Decision 32's per-task merge-into-staging; preserves the no-force-push global rule.

---

## Decision 34: Develop Receives Only Whole PRDs — Incremental Delivery and the `partial` Status Removed

**Status:** Implemented (2026-06-18). Reverses the partial-rollup-to-develop behavior of the prior `finalize`/`rollup` (the `PARTIAL:` rollup header is retired). `partial` removed from `RunStatusEnum`; `decideFinalize` is binary `completed | failed`; rollup fires only on `completed`; on a merged rollup finalize comments + closes the PRD (new `issueComment`/`issueClose`) and deletes the per-run branch; a wedged run hits the `next.ts` circuit breaker → `failed`.

**Choice:** The `staging-<run-id>`→develop rollup fires ONLY when the run is `completed` (every task shipped). An incomplete run lands nothing on develop. There is no partial delivery: a run delivers the whole PRD or delivers nothing to develop.

**Why:**

- **It realigns the implementation with the domain.** The glossary already defines a Run as succeeding "only when the whole PRD has been delivered, never partially" (`docs/glossary.md`); the code had drifted into partial rollups. This is the code catching up to the decided domain, not a new invention.
- **All-or-nothing is what makes the recovery model coherent.** Since an unfinished run's work is confined to its private branch (Decision 33) and never reaches develop, continuing/repairing/replacing it is always safe. Allowing partial develop landings would reintroduce exactly the develop-collision hazard Decision 33 removes.
- **"Resuming an unfinished run" is the only form of partial progress** — and it is recoverable, not a terminal half-delivery.

**Consequences for the status enum:**

- `partial` is REMOVED. A run is `completed`, or it is unfinished/resumable.
- A wedged run the circuit breaker gives up on goes terminal `failed` — develop clean, PRD left open. `failed` broadens from "could not start" to "delivered no work to develop" (couldn't-start OR gave-up after banking work on its private branch).
- On `completed`, finalize CLOSES and COMMENTS the originating PRD issue — net-new behavior added via `issueClose`/`issueComment` (`src/git/gh-client.ts`). Closing the PRD is what guarantees `run` never re-touches a delivered PRD (Decision 35). On `failed`, finalize instead posts ONE comment on the open PRD listing the failed tasks (Decision 36 — superseding the original per-task `issueCreate`/`issueList` surface, both since removed).

**Trade-off:** Loses "bank the N good tasks, hand off the failures" incremental value delivery — a run that cannot finish delivers nothing to develop, even if most tasks passed. Accepted deliberately: the banked work is not lost (it survives on the run's private branch for rescue/resume), and atomic per-PRD delivery is worth more than partial landings that complicate develop and recovery.

**Relationship:** Rides on Decision 33's per-run branch (where partial work safely waits); revises the `finalize` rollup; orthogonal to Decision 22 (notify-on-ship, untouched); enables Decision 35's "`run` never sees terminal runs" simplification.

---

## Decision 35: `run` / `resume` / `rescue` Are Distinct Lifecycle Verbs; `run` Supersedes Rather Than Silently Reuses

**Status:** Implemented (2026-06-18). Revises Decision 32's idempotent-reuse-on-`create`. `resume` is now its own top-level command (`commands/resume.md` + `factory resume`, with `run resume` kept as a thin CLI alias). Implemented as "fail loud + flags": bare `run create` with an active run exits `3` and emits `{kind:"exists"}`; `--supersede` marks the old run `superseded` + deletes its branch, `--resume` hands off; the interactive prompt (resume/supersede/cancel) lives in `commands/run.md` via `AskUserQuestion`, mapping the answer to the flag. Adds the `superseded` terminal status. Rescue gains a `rescue-reconciler` git/GitHub drift pass before resume.

**Choice:** Three distinct run-lifecycle commands, plus the unchanged standalone `debug`:

- **`run`** — always a fresh start. It looks for a NON-terminal run on the spec; finding one, it PROMPTS (continue via `resume`, or supersede). Proceeding supersedes: the prior run goes `superseded` (its private branch deleted, Decision 33), a fresh run begins. With no active run it starts silently. It never sees terminal runs (a delivered PRD is closed, Decision 34).
- **`resume`** — continue an unfinished run if possible. It classifies via the read-only rescue scan: no active run → report the terminal status; quota-paused → re-check the window; running with runnable work → continue; running but deadlocked → STOP and redirect to rescue. It never mutates state and never auto-escalates.
- **`rescue`** — repair, then auto-resume. It reconciles run-state and git/GitHub drift, then continues driving. Forward-only/non-destructive repair is autonomous; any destructive step (delete a branch, close a PR, discard work) is surfaced for consent; force-push never. Git/GitHub reconciliation is performed by a CODING AGENT that detects, troubleshoots, and addresses the issue — not an enumerated catalog of fix-ups in the deterministic engine. The engine detects "stuck/drifted" and hands off; the open-ended repair is agent work, per Model A.
- **`debug`** — unchanged; a standalone, run-independent review-fix loop (risk-invariant panel + Codex on a chosen scope), not part of the recovery ladder.
- **`run cancel`** — abandon a live run from inside the owning session (added 2026-06-19; see Addendum). Marks the run terminal (reuses `failed`) so the Stop gate releases; it does NOT start, continue, or repair — it is the explicit end-of-line for a run the operator no longer wants.

**Why:**

- **The verbs were conflated.** `run` both started AND silently reused (Decision 32), there was no first-class `resume`, and "continue" vs "repair" were undivided — operators hit the bug where `/factory:run` found an existing run and stopped instead of starting fresh. Separating the verbs maps each to one intent: start-over / continue / repair.
- **Supersede-with-consent honors the never-fail-without-confirmation rule** while still letting an operator start fresh. The at-most-one-non-terminal-run-per-spec invariant it enforces keeps state unambiguous (no zombie parallel runs on one PRD).
- **Agent-driven reconciliation keeps the engine out of a brittle drift catalog.** The engine is good at detecting that progress is blocked; open-ended diagnosis and repair of git/GitHub state is exactly the agent layer's job under Model A.

**Trade-off:** `run` is no longer a silent idempotent no-op on re-invocation — it stops to ask, costing an interaction in the (rare) re-run case. And agent-driven rescue is less predictable than a fixed reconciliation routine. Both accepted: the prompt prevents silent supersede of real work, and the recovery surface is too open-ended to enumerate safely in TS.

**Relationship:** Replaces the idempotent reuse + reuse-mismatch guard of Decision 32 (the guard's intent — never drive a run under an unintended ship mode — is subsumed by the explicit supersede prompt); leans on Decisions 33/34 (terminal runs are closed and confined, so `run` can ignore them); rescue's agent hand-off mirrors the `rescue-diagnostic` pattern; preserves the autonomy gate of Decision 29 (the supersede prompt is a pre-start human moment, before the run goes autonomous).

**Addendum (2026-06-19) — `run cancel`, the in-session abandon verb.** A run with non-terminal tasks left the owning session unable to stop: the Stop gate (`src/hooks/stop-gate.ts`) blocks the session while a `running` run has pending work, and every other lever was unreachable mid-session — `state.json` is TCB-write-protected, `run finalize` refuses an in-flight task, and `FACTORY_ALLOW_STOP` is a launch-time-only env. The lifecycle had a start/continue/repair vocabulary but no _abandon_. `factory run cancel [--run <id>] [--cleanup] [--session-id <id>]` (`runCancel` in `src/cli/subcommands/run.ts`) fills the gap: it resolves the run via `--run` → owner-scan (`findAllActiveByOwner`, robust to a detached `runs/current`) → current pointer (explicit `--run` is a deliberate operator override with NO ownership check — the cross-session escape hatch a crashed owner's run needs, sound under the single-operator local trust model, exactly as `resume`/`finalize` honor `--run`; the owner-scan resolves the SINGLE owned run, failing LOUD and demanding `--run` when the session owns ≥2 live runs rather than guessing which to abandon, yet still falls through to the pointer when it owns none), then calls `state.finalize(runId, "failed")` **directly** — NOT `finalizeRun` (cancel must not attempt rollup CI / ship of a partial run). `finalize` validates only that the _target_ status is terminal — it never inspects task statuses — so a run with a task still `executing` is cancellable, the exact mechanism `--supersede` already uses. The CLI is the sanctioned state writer (it bypasses the TCB hook, which guards Edit/Write tools, not the engine's own fs writes), so this is not "routing around the guard." Design choices: reuse `failed` (no schema change; a user-abandon is a give-up-after-partial-work, which `failed` already means), so a cancelled run is terminal and NOT resumable; teardown of the staging branch + task PRs is opt-in via `--cleanup` (default leaves them for manual handling) and best-effort — a teardown failure is surfaced LOUD (a `cleanup_error` in the envelope plus a safe-retry hint on stderr) but never fails the abandon, since the run is already `failed` and the Stop gate already released; re-running `--cleanup` retries idempotently; and the verb omits the autonomy gate (Decision 29) because it is the documented _escape_ from the Stop gate and must work from any session. The Stop-gate block message now names `factory run cancel --run <id>` so a trapped session discovers it.

**Addendum (2026-06-20) — supersede teardown is resume-safe-ordered.** `supersedeRun` (`src/cli/subcommands/run.ts`) now tears down the old run's protection + `staging-<run-id>` branch BEFORE flipping it `superseded`, the terminal write LAST — the resume-safe convention `finalizeRun` (`src/orchestrator/finalize.ts`) already uses. Previously it finalized first, then tore down unguarded: a teardown throw (GitHub 401/403/5xx) propagated, so the fresh run was never created AND the old run was already terminal — excluded from `findActiveBySpec`, so no re-run ever re-attempted its teardown and the protected branch was orphaned permanently (rescue scopes out branch GC). With finalize last, a teardown failure leaves the old run non-terminal, so re-running `run --supersede` re-resolves it and retries the whole step idempotently (`deleteProtection`/`deleteRemoteBranch` tolerate already-gone), leaving NO orphan. This is the DELIBERATE inverse of `run cancel`'s finalize-first ordering: cancel's priority is releasing the Stop gate even if teardown fails (so the terminal write must win), whereas supersede has no gate and is an interactive pre-start moment, so a clean, recoverable replacement wins over forcing the fresh run through.

**Addendum (2026-06-21) — the Stop-gate pending-work block is removed (simplification Phase 2).** The Stop hook (`src/hooks/stop-gate.ts`) no longer emits `{decision:"block"}` while a `running` run has pending work, and the `FACTORY_ALLOW_STOP` escape hatch is gone. That block was the "session-hostage" behaviour — a session that could not progress was held open indefinitely — and it never functioned in `--workflow` mode (the strategic primary runner) anyway, since a workflow-mode run already passed through. A session may now always stop; a run left `running` with pending work stays cleanly resumable via `factory resume` (an idempotent re-entry — `applyResume`). The hook keeps finalize-on-stop (an owned, session-mode, all-terminal run is finalized so it never dangles) and its two CORRUPTION blocks (unreadable `state.json`, finalize failure — M9), which surface genuine inconsistency, not lack of progress. Consequence for `run cancel` (the 2026-06-19 addendum above): it is no longer the "escape from the Stop gate" — it is simply the explicit ABANDON verb (mark `failed`, optionally `--cleanup` teardown) for deliberately discarding a run you will not resume.

---

## Decision 36: A Failed Run Comments the PRD Issue; Per-Task Failure Issues Are Retired

**Status:** Implemented (2026-06-22). Removes the per-failed-task GitHub-issue surface (`fileFailureIssues` + the gh-client `issueCreate`/`issueList` methods and their types) from `finalize`. On a `failed` run, finalize now posts ONE comment on the originating PRD issue listing every failed task; the PRD stays open.

**Choice:** GitHub issues represent **PRDs**, not run-internal task outcomes. A `failed` run's fails are surfaced as a single comment on the PRD issue (`commentFailuresOnPrd`, `src/orchestrator/finalize.ts`, step 5) carrying fails-only content — for each failed task: id, title, `failure_class`, `failure_reason`, and its full (all-unmet) acceptance criteria. The renderer (`renderFailureComment`, `src/scoring/partial-report.ts`) leads the body with a hidden marker `<!-- factory:run-failed:<run-id> -->`; finalize scans existing PRD comments (new `GhClient.listIssueComments`) for that marker and skips if present, so a resumed finalize (a crash before the terminal flip) never double-posts.

**Why:**

- **Issues = PRDs.** A previous run filed several `[factory] … failed` issues, polluting the issue namespace with run-internal state. Per-task status is **already** authoritative locally — `RunState.tasks[id].status` (`done`/`failed` + `failure_class` + `failure_reason`) plus the durable `report.md`. The fix replaces a redundant, namespace-polluting GitHub surface, not local tracking (which was never missing).
- **Symmetric with the success path.** A `completed` run already comments + closes the PRD (Decision 34); a `failed` run now comments + leaves it open. One PRD-comment surface for both outcomes, keyed off the same `report.issue_number`.
- **One comment, not N issues.** A run that fails K tasks produces ONE consolidated comment, not K issues a human must triage and close. A later successful re-run simply adds its own comment and closes the PRD — no stale open issues to reap.

**Trade-off:** Loses the per-task issue as an independently-assignable/closable work item. Accepted: the PRD is the unit of work in this model, the local run state is the authoritative per-task ledger, and the fails-only comment gives a human everything needed to decide rescue/resume/abandon without a parallel issue namespace to maintain. CLI consequence: the `finalized` envelope emits `failure_comment_posted: boolean` in place of `issues_filed: number`.

**Relationship:** Refines Decision 34's failure path (which left the PRD open but said nothing about how fails were surfaced) and Decision 22's "loud, classified fail" (the comment IS the loud handback). Reuses the same `FailureLine[]` the partial report already derives.

---

## Decision 37 — Documentation Is an Engine Phase Before Finalize

Docs generation was a Phase-4 markdown conditional that ran AFTER the rollup PR
merged and the PRD issue closed, leaving doc updates uncommitted. It is now a
deterministic, blocking, resumable engine phase: `factory next-task` returns
`document` when the prospective status is `completed`, the repo keeps `/docs`,
docs are not opted out (`package.json` `factory.docs.enabled`), and the docs
phase isn't `done`. A runner runs `factory run docs` (emit a scribe spawn request on a
staging-rooted worktree → record publishes the docs commit onto staging). Because
`next-task` withholds `finalize` until docs are `done`, the rollup/PRD-close cannot
fire while docs pend. A docs failure suspends the run for a retry (resumable via
`/factory:resume`), bounded by `MAX_DOCS_ATTEMPTS` (2) — once the cap is hit docs become
best-effort and the run finalizes `completed` without a docs commit rather than
suspend-looping — never shipping half-documented. Whole-PRD diff
(`origin/<baseBranch>..HEAD`); ships inside the one rollup PR (Decision 34).

---

## Decision 38 — Defective-RED-Test Recovery: the Implementer Reports It, the Test-Writer Regenerates It

A workflow run dead-ended on a DB-migration task that had **no executable RED test**:
the test-writer, unable to assert behavior against a SQL migration with no RED-time
runner, fell back to a **source-presence pin** — `toContain("<impl literal>")` over
the migration file — which locked the _first_ implementation guess in as "the
contract." When reviewers later found that guess wrong, the immutable test (the
implementer may never edit a test, Iron Law) made it unfixable. The implementer's
only exit was `BLOCKED — escalate`, which classifies as a **terminal `spec-defect`**
(Decision 25, Rule 1) — and stateless [rescue](../guides/rescue-a-stalled-run.md)
regenerated the same pin. There was no path for a wrong _test_ (as opposed to a wrong
_spec_) to self-heal.

**Choice:** add a recoverable producer outcome, `test-defective`, that resumes the
task **at the `tests` phase** so the **test-writer** regenerates the RED test — the
implementer never touches it.

- **Signal.** The implementer raises `STATUS: BLOCKED — escalate: test requires
revision <reason>`. `parseProducerStatus` (`src/producer/agents.ts`) promotes a
  `BLOCKED — escalate` line to the `test-defective` outcome **only** when it carries
  the _contiguous_ uppercased substring `TEST REQUIRES REVISION`; otherwise the line
  stays `blocked-escalate` (terminal spec-defect). Contiguity is deliberate — a
  genuine spec contradiction that merely mentions "the criterion the test verifies"
  must stay terminal.
- **Classification.** `test-defective` classifies as `{action:"retry"}` →
  `capability` (`src/producer/classify.ts`), **not** the terminal `spec-defect` that
  `blocked-escalate` maps to. `classify.ts` stays phase-agnostic.
- **Routing.** `applyProducerOutcome` (`src/orchestrator/transitions.ts`) accepts the
  outcome only from the `exec` phase (only the implementer may raise it), persists the
  defect reason on the transient task field `test_revision_feedback`, then
  `escalateOrFail(..., "tests")` — resuming at `tests`, not the implementer's own
  `exec` phase. A `test-defective` from a non-exec role (the parser is role-blind) is
  reclassified as a producer **error** and escalated/capped rather than thrown, so it
  never escapes `next-action`'s catch.
- **Feedback.** The `tests` handler (`src/orchestrator/handlers.ts`) injects a
  specific revision note into the regenerating test-writer's `priorFailures` whenever
  `test_revision_feedback` is set — **gated on the field, not the rung dial**, so it
  reaches the test-writer even at rung 1 (where the generic prior-failure note is
  still off). The field is cleared once the test-writer returns `done`, and
  `resetTaskRow` clears it on rescue.
- **Bounding.** The recovery shares the single `escalation_rung` budget (Decision 25,
  Rule 3); a persistent re-pin climbs to `ESCALATION_CAP` then fails
  `capability-budget` — a clean dead-end, never an infinite test↔impl loop.

**Prevention (markdown surface).** `agents/test-writer.md` now forbids source-presence
pins outright (Iron Law 6) and steers a non-executable artifact (e.g. a SQL migration
with no RED-time runner) to a behavior probe or a `STATUS: NEEDS_CONTEXT` defer —
`tdd_exempt` / `.quality.redTestCommand` remain the sanctioned escapes for exotic or
deferred runners, never a text pin. `agents/implementer.md` promotes `test requires
revision` into its sanctioned Final-status menu as the recoverable signal, distinct
from the terminal `BLOCKED — escalate`.

**Trade-off:** one more outcome on the closed producer union and one more transient
task field — the cost of converting a class of dead-ends (wrong test, not wrong spec)
into a self-healing path instead of a loud fail. See
[producer-ladder.md](./producer-ladder.md#the-test-defective-recovery-path).

---

## Plugin System Constraints

### Agents Cannot Use Hooks Per-Agent

All hooks in `hooks.json` fire for all agents. Hook scripts check context to decide whether to act.

### Agents Cannot Use mcpServers Per-Agent

MCP servers declared in `.mcp.json` are available to all plugin agents.

### Agents Cannot Use permissionMode

Cannot set per-agent permissions (e.g., read-only for reviewers). Reviewer agents are instructed to only use read tools; enforcement is ~70% reliable.

### No Process Manager Primitive

Solved by running the runner in the main session. The command body IS the control loop.

### Concurrent Agent Results

The runner (main session) emits multiple `Agent()` calls in one message. Claude Code invokes them in parallel natively. All results return in the same turn.

---

## Open Questions

### Codex Plugin Availability

Is the Codex Claude Code plugin stable and publicly available?

**Status:** Unvalidated. Fallback via Claude Code reviewer is fully functional.
