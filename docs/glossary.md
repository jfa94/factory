# Glossary

Domain and technical terms used across the Dark Factory pipeline.

## Pipeline terms

- **Run** — One end-to-end execution converting a PRD issue into merged PRs. Identified by a `run_id`; state in `${CLAUDE_PLUGIN_DATA}/runs/<run_id>/state.json`.
- **Task** — A single unit of work within a run (from `tasks.json`), executed through the stage machine.
- **Stage machine** — The per-task progression: `preflight → preexec_tests → postexec → postreview → ship → finalize-run`. Driven by `bin/pipeline-run-task`.
- **Orchestrator** — The invoking Claude Code session that walks tasks through the wrapper (`skills/pipeline-orchestrator`).
- **Worktree** — An isolated git working tree for a subagent/task; base ref governed by `worktree.baseRef=head` (see `docs/explanation/decisions.md`).

## Quality gates

- **TDD gate** — Enforces test-before-impl commit ordering (`bin/pipeline-tdd-gate`).
- **Quality / Coverage / Security / Mutation gates** — Per-task checks under `bin/pipeline-*-gate`.
- **Holdout validation** — Layer-4 anti-overfitting check: a subset of acceptance criteria withheld from the executor and verified by an independent reviewer (`bin/pipeline-holdout-validate`).
- **Fail-closed / fail-open** — A gate that blocks on internal error (closed) vs one that passes (open). This project's gates fail closed by default.

## Risk & routing

- **risk_tier** — `routine | feature | security`; drives reviewer fan-out (`bin/pipeline-classify-risk`).
- **Circuit breaker** — Run-level counters (`tasks_completed`, `consecutive_failures`) that halt a run on repeated failure.

## Roles

- **task-executor** — Subagent that writes the minimal implementation.
- **test-writer** — Subagent that commits failing tests first.
- **implementation-reviewer / quality-reviewer** — Spec-alignment and adversarial quality reviewers.
