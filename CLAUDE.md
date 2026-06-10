# Dark Factory Plugin

Autonomous coding pipeline that converts GitHub PRD issues into merged pull requests via a quality-first, TDD-enforced stage machine.

## Architecture (Model A)

- The plugin surface is markdown (`commands/`, `agents/`, `skills/`) + hooks. The in-session LLM orchestrator (loaded via `skills/pipeline-orchestrator/SKILL.md`) performs ALL `Agent()` spawns.
- The deterministic engine is one Node+TS CLI — `factory <subcommand>` — built by esbuild into two checked-in bundles: `dist/factory.js` (CLI) and `dist/factory-hook.js` (hook dispatcher, wired in `hooks/hooks.json`). `bin/factory` is the PATH shim onto the bundle.
- CLI subcommands are REPORTERS (read-only JSON envelopes) or WRITERS (single-step state mutations). The CLI never spawns agents.
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

- `commands/run.md` — main entry (orchestrator runs in the invoking Claude Code session; see `skills/pipeline-orchestrator/SKILL.md` for the full protocol + CLI surface table)
- `src/cli/main.ts` — the `factory` subcommand registry (run, spec, run-task, advance, drop, record-\*, rescue, score, state, scaffold, configure)
- `src/driver/loop.ts` — the per-task transition logic the single-step CLI writers share
- `src/hooks/main.ts` — the `factory-hook` guard dispatch (TCB write-deny, holdout guard, secret guard, branch protection, stop gates)

## Worktree base invariant

`.claude/settings.json` sets `worktree.baseRef: "head"` so every `Agent({isolation:"worktree"})` subagent worktree branches from the orchestrator's staging HEAD, not stale `origin/main`. The orchestrator FFs/forks its worktree to `origin/staging` before any spawn; the preflight stage's idempotent `checkout -B … origin/staging` stays as a fallback. The `worktree` block is read at session start (not mid-session) and is project-wide — see `docs/explanation/decisions.md` Decision 12.

## Skills

- `skills/pipeline-orchestrator/SKILL.md` — full orchestrator protocol
- `skills/test-driven-development/SKILL.md` — TDD discipline for subagents
- `skills/prd-to-spec/SKILL.md` — converts PRD issues to spec + tasks.json
- `skills/rescue-protocol/SKILL.md` — recover a stalled run (`factory rescue scan|apply` → resume)

## Known gaps (deliberate)

- `/factory:debug` (`commands/debug.md` + `skills/debug/SKILL.md`) still describes retired bash bins; its redesign is a post-cutover epic.
- The old bash SessionStart hook (Iron-Laws re-injection after compaction) was not ported to TS; the orchestrator skill is re-loaded per `/factory:run` invocation instead.
