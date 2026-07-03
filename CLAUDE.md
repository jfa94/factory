# Dark Factory Plugin

Autonomous coding pipeline that converts GitHub PRD issues into merged pull requests via a quality-first, TDD-enforced phase machine.

## Architecture (Model A)

- The plugin surface is markdown (`commands/`, `agents/`, `skills/`) + hooks. The deterministic engine owns ALL control flow and exposes ONE seam — the **orchestrator** (`factory next-task` + `factory next-action`). ONE thin runner steps it (Decision 42): the in-session parallel event loop (`skills/pipeline-runner/SKILL.md`) — every `factory` call foreground, up to `maxParallelTasks` tasks' agents spawned in the background. The runner only spawns the `Agent()`s the orchestrator's `NextAction` spawn manifest names — it carries no pipeline logic of its own.
- The deterministic engine is one Node+TS CLI — `factory <subcommand>` — built by esbuild into two checked-in bundles: `dist/factory.js` (CLI) and `dist/factory-hook.js` (hook dispatcher, wired in `hooks/hooks.json`). `bin/factory` is the PATH shim onto the bundle.
- The CLI is the orchestrator seam + reporters + writers, never an agent-spawner: `factory next-task` emits the ready-task result (`NextTask`); `factory next-action` emits the spawn manifest (`NextAction`) and, via `--results`, records agent output into ONE state step. The six retired single-step writers (`run-task`/`advance`/`drop`/`record-producer`/`record-holdout`/`record-reviews`) collapsed into the orchestrator; the surviving writers are `spec`, `rescue`, `scaffold`, `configure`, `state`.
- Source lives in `src/` (vitest, colocated `*.test.ts`). `npm run verify` = typecheck && lint && test && build. `npx tsc` is shadowed — use `npm run typecheck`.
- Run/spec state lives OUTSIDE the target repo in `$CLAUDE_PLUGIN_DATA`: durable `specs/<repo>/<spec-id>/` + ephemeral `runs/<run-id>/`.

## Testing Discipline

This plugin enforces test-driven development (TDD) at the harness layer:

- Tasks run through two phases: `test-writer` commits failing tests first, then `implementer` commits the minimal implementation.
- The TDD gate (`src/verifier/deterministic/strategies/tdd.ts`) enforces test-before-impl commit ordering on the pre-squash task branch, memoized by tip SHA. Violations block the task.
- See `skills/test-driven-development/SKILL.md` for the full discipline.
- Opt-out per task via `tdd_exempt: true` in the spec's `tasks.json`; globally via `package.json.factory.tddExempt` (`src/verifier/deterministic/tdd-exempt.ts`). For repos with exotic test runners (Go, Ruby, Deno, etc.), set `.quality.redTestCommand` in config instead of bypassing enforcement.
- `tdd_exempt` is read from the spec's `tasks.json` + the repo's `package.json` — never from `state.json` (derive-don't-store).

Reviewer roles (risk-invariant panel — every reviewer runs on every task):

- `implementation-reviewer` — spec alignment: does the code address the spec, not just pass tests?
- `quality-reviewer` — adversarial code quality; Codex is the preferred executor when available.
- Plus architecture, security, `silent-failure-hunter`, `type-design-reviewer`, `systemic-failure-reviewer`; blockers pass through an independent finding-verifier before reaching the producer (verify-then-fix, Decision 27).

## Key entry points

- `commands/run.md` — main entry (`--no-ship` to open PRs without merging; default: live. The runner loop runs in the invoking Claude Code session — see `skills/pipeline-runner/SKILL.md` for the protocol + CLI surface table). Four distinct lifecycle verbs (Decision 35): `run` starts FRESH (no silent reuse — on an active run it exits 3 / prompts resume·supersede·cancel), `commands/resume.md` (`/factory:resume`, `factory resume`) continues an unfinished run, `commands/rescue.md` repairs git/GitHub drift then resumes, `commands/debug.md` is the standalone review-fix loop.
- `src/cli/main.ts` — the `factory` subcommand registry (run, resume, spec, next-task, next-action, rescue, score, state, scaffold, configure, config-defaults, debug, autonomy, statusline)
- `src/orchestrator/orchestrator.ts` + `src/orchestrator/next.ts` — the task-level and run-level orchestrators behind `factory next-action`/`factory next-task` (record logic in `src/orchestrator/record.ts`)
- `src/hooks/main.ts` — the `factory-hook` guard dispatch (TCB write-deny, holdout guard, secret guard, branch protection, stop gates)

## Worktree base invariant

`.claude/settings.json` sets `worktree.baseRef: "head"` so every `Agent({isolation:"worktree"})` subagent worktree branches from the runner's staging HEAD, not stale `origin/main`. The runner FFs/forks its worktree to `origin/staging` before any spawn; the preflight phase's idempotent `checkout -B … origin/staging` stays as a fallback. The `worktree` block is read at session start (not mid-session) and is project-wide — see `docs/explanation/decisions.md` Decision 12.

## Skills

- `skills/pipeline-runner/SKILL.md` — full runner protocol (the in-session parallel event loop)
- `skills/test-driven-development/SKILL.md` — TDD discipline for subagents
- `skills/prd-to-spec/SKILL.md` — converts PRD issues to spec + tasks.json
- `skills/review-protocol/SKILL.md` — the RawReview JSON output contract every risk-invariant-panel reviewer emits (CLI citation-verifies + records it into the merge gate)
- `skills/rescue-protocol/SKILL.md` — recover a stalled run (`factory rescue scan|apply` → resume)

## Known gaps (deliberate)

- The old bash SessionStart hook (Iron-Laws re-injection after compaction) was not ported to TS; the runner skill is re-loaded per `/factory:run` invocation instead.
