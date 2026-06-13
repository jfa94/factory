# Dark Factory Plugin

Autonomous coding pipeline that converts GitHub PRD issues into merged pull requests via a quality-first, TDD-enforced stage machine.

## Architecture (Model A)

- The plugin surface is markdown (`commands/`, `agents/`, `skills/`) + hooks. The deterministic engine owns ALL control flow and exposes ONE seam — the **pump** (`factory next` + `factory drive`). Two thin drivers pump it: the in-session LLM orchestrator loop (`skills/pipeline-orchestrator/SKILL.md`, `--mode session`) and the plugin-shipped Workflow script (`workflows/factory-run.workflow.js`, `--mode workflow`). A driver only spawns the `Agent()`s the pump's `DriveEnvelope` manifest names — it carries no pipeline logic of its own.
- The deterministic engine is one Node+TS CLI — `factory <subcommand>` — built by esbuild into two checked-in bundles: `dist/factory.js` (CLI) and `dist/factory-hook.js` (hook dispatcher, wired in `hooks/hooks.json`). `bin/factory` is the PATH shim onto the bundle.
- The CLI is the pump seam + reporters + writers, never an agent-spawner: `factory next` emits the ready-task envelope (`NextEnvelope`); `factory drive` emits the spawn manifest (`DriveEnvelope`) and, via `--results`, folds agent output into ONE state step. The six retired single-step writers (`run-task`/`advance`/`drop`/`record-producer`/`record-holdout`/`record-reviews`) collapsed into the pump; the surviving writers are `spec`, `rescue`, `scaffold`, `configure`, `state`.
- Source lives in `src/` (vitest, colocated `*.test.ts`). `npm run verify` = typecheck && lint && test && build. `npx tsc` is shadowed — use `npm run typecheck`.
- Run/spec state lives OUTSIDE the target repo in `$CLAUDE_PLUGIN_DATA`: durable `specs/<repo>/<spec-id>/` + ephemeral `runs/<run-id>/`.

## Testing Discipline

This plugin enforces test-driven development (TDD) at the harness layer:

- Tasks run through two phases: `test-writer` commits failing tests first, then `task-executor` commits the minimal implementation.
- The TDD gate (`src/verifier/deterministic/strategies/tdd.ts`) enforces test-before-impl commit ordering on the pre-squash task branch, memoized by tip SHA. Violations block the task.
- See `skills/test-driven-development/SKILL.md` for the full discipline.
- Opt-out per task via `tdd_exempt: true` in the spec's `tasks.json`; globally via `package.json.factory.tddExempt` (`src/verifier/deterministic/tdd-exempt.ts`). For repos with exotic test runners (Go, Ruby, Deno, etc.), set `.quality.redTestCommand` in config instead of bypassing enforcement.
- `tdd_exempt` is read from the spec's `tasks.json` + the repo's `package.json` — never from `state.json` (derive-don't-store).

Reviewer roles (risk-invariant panel — every reviewer runs on every task):

- `implementation-reviewer` — spec alignment: does the code address the spec, not just pass tests?
- `quality-reviewer` — adversarial code quality; Codex is the preferred executor when available.
- Plus architecture, security, `silent-failure-hunter`, `type-design-reviewer`; blockers pass through an independent finding-verifier before reaching the producer (verify-then-fix, Decision 27).

## Key entry points

- `commands/run.md` — main entry (`--mode session|workflow`: session = the orchestrator loop in the invoking Claude Code session; workflow = the Workflow script. See `skills/pipeline-orchestrator/SKILL.md` for the protocol + CLI surface table)
- `workflows/factory-run.workflow.js` — the `--mode workflow` driver: a Workflow script pumping the same `next`/`drive` seam, wrapping every CLI call in a haiku exec-agent (Workflow JS can't shell out)
- `src/cli/main.ts` — the `factory` subcommand registry (run, spec, next, drive, rescue, score, state, scaffold, configure, config-defaults)
- `src/driver/pump.ts` + `src/driver/next.ts` — the task-level and run-level pumps behind `factory drive`/`factory next` (fold logic in `src/driver/fold.ts`)
- `src/hooks/main.ts` — the `factory-hook` guard dispatch (TCB write-deny, holdout guard, secret guard, branch protection, stop gates)

## Worktree base invariant

`.claude/settings.json` sets `worktree.baseRef: "head"` so every `Agent({isolation:"worktree"})` subagent worktree branches from the orchestrator's staging HEAD, not stale `origin/main`. The orchestrator FFs/forks its worktree to `origin/staging` before any spawn; the preflight stage's idempotent `checkout -B … origin/staging` stays as a fallback. The `worktree` block is read at session start (not mid-session) and is project-wide — see `docs/explanation/decisions.md` Decision 12.

## Skills

- `skills/pipeline-orchestrator/SKILL.md` — full orchestrator protocol (the `--mode session` driver loop)
- `skills/test-driven-development/SKILL.md` — TDD discipline for subagents
- `skills/prd-to-spec/SKILL.md` — converts PRD issues to spec + tasks.json
- `skills/review-protocol/SKILL.md` — the RawReview JSON output contract every risk-invariant-panel reviewer emits (CLI citation-verifies + folds it into the floor)
- `skills/rescue-protocol/SKILL.md` — recover a stalled run (`factory rescue scan|apply` → resume)

## Known gaps (deliberate)

- `/factory:debug` (`commands/debug.md` + `skills/debug/SKILL.md`) still describes retired bash bins; its redesign is a post-cutover epic.
- The old bash SessionStart hook (Iron-Laws re-injection after compaction) was not ported to TS; the orchestrator skill is re-loaded per `/factory:run` invocation instead.
