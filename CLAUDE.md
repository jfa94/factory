# Dark Factory Plugin

Autonomous coding pipeline that converts GitHub PRD issues into merged pull requests via a quality-first, TDD-enforced stage machine.

## Testing Discipline

This plugin enforces test-driven development (TDD) at the harness layer:

- Tasks run through two phases: `test-writer` commits failing tests first, then `task-executor` commits the minimal implementation.
- `pipeline-tdd-gate` enforces test-before-impl commit ordering. Violations block the task.
- See `skills/test-driven-development/SKILL.md` for the full discipline.
- Opt-out per task via `tdd_exempt: true` in the spec's `tasks.json`; globally via `package.json.factory.tddExempt`. For repos with exotic test runners (Go, Ruby, Deno, etc.), set `.quality.redTestCommand` in config to provide a custom red-test verification command instead of bypassing enforcement.
- `tdd_exempt` is read from `spec/tasks.json` — never from `state.json`.

Reviewer roles:

- `implementation-reviewer` — spec alignment: does the code address the spec, not just pass tests?
- `quality-reviewer` — adversarial code quality; Codex is the preferred executor when available.

## Key scripts

- `bin/pipeline-run-task` — per-task stage machine (preflight → preexec_tests → postexec → postreview → ship); shared helpers + `case "$stage"` dispatch
- `bin/pipeline-run-task-stages.sh` — sourced `_stage_*` handlers for the above (mirrors `pipeline-score-steps.sh`)
- `bin/pipeline-tdd-gate` — test-before-impl commit-order validation
- `commands/run.md` — main entry point (orchestrator runs in the invoking Claude Code session; see `skills/pipeline-orchestrator/SKILL.md` for the protocol)

## Worktree base invariant

`.claude/settings.json` sets `worktree.baseRef: "head"` so every `Agent({isolation:"worktree"})` subagent worktree branches from the orchestrator's staging HEAD, not stale `origin/main`. The orchestrator FFs/forks its worktree to `origin/staging` before any spawn; the `checkout -B … origin/staging` in `_stage_preflight` (`bin/pipeline-run-task-stages.sh`) stays as an idempotent fallback. The `worktree` block is read at session start (not mid-session) and is project-wide — see `docs/explanation/decisions.md` Decision 12.

## Skills

- `skills/pipeline-orchestrator/SKILL.md` — full orchestrator protocol
- `skills/test-driven-development/SKILL.md` — TDD discipline for subagents
- `skills/prd-to-spec/SKILL.md` — converts PRD issues to spec + tasks.json
