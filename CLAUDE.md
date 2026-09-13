# Factory Plugin v2

Factory converts a GitHub PRD into one integrated feature branch and one PR.
The canonical execution design is [docs/architecture/overview.md](docs/architecture/overview.md).
Version 1 execution is retired. Existing v1 artifacts are preserved for diagnosis.

## Implementation rules

- Markdown in commands, agents and skills is executable policy. Keep it aligned
  with the CLI schemas and test its recovery and evidence requirements.
- The deterministic engine in `src/feature/` owns transitions. The session runner
  in `skills/pipeline-runner/SKILL.md` only dispatches persisted attempts and submits
  raw agent results. One producer may run per repository.
- One feature worktree accumulates sequential tasks. The engine creates immutable
  reviewer snapshots. Never ask Agent for another native isolation worktree.
- Keep accepted commits, answers and audit evidence. Repair forward; never reset,
  force-push, delete feature branches or lower branch protection during recovery.
- Specs snapshot PRD, base and repository contracts. Validate dependency order,
  shared-file dependencies, contiguous slices and complete requirement coverage.
  No imported specs, arbitrary three-file cap, or hidden acceptance criteria.
- Task checks include tests, types, lint and unsquashed TDD ordering unless exempt.
  Slice and feature boundaries add integrated gates and independent review.
  A successful process without executed-test evidence is not a passing test.
- Independent evaluator evidence is distinct from producer claims. Review citations
  are checked against the exact attempt SHA. Invalid or absent evidence fails closed.
- Three repair passes per task, slice, feature or spec boundary. Spec generation
  permits five revisions. Infrastructure waiting does not spend producer passes.
- Explicit stop remains parked until resume. Recovery consumes journaled results
  before retiring a stopped worker's lease; uncommitted work is preserved.
- No-ship ends with one complete PR ready for review. Live completion requires an
  observed merge. Verified no-change completion creates no empty PR.

## Source and verification

- `src/feature/{schema,store,engine,runtime,cli}.ts`: v2 state, persistence and execution.
- `src/spec/`: PRD generation, snapshotting, executable validation and bounded revision.
- `src/hooks/feature-guards.ts`: v2 path/session ownership and observational Stop hook.
- `src/verifier/`: shared gate tools and judgment utilities.
- `src/orchestrator/` and old state modules remain as historical implementation and
  regression coverage; production execution does not dispatch their task runner.
- `src/cli/main.ts` and `src/hooks/main.ts`: production registries.
- `dist/factory.js`, `dist/factory-hook.js` and the mutation scaffold helper are
  checked-in build outputs. Rebuild them after source changes.
- Use pnpm: typecheck, check:circular, lint, test, build and version:check.
  Never weaken gates to make a regression pass.

External canary runs and publication require scoped user authorization. Consult
[the implementation ledger](docs/proposals/sequential-feature-delivery.md) for
release readiness; do not infer completion from a version number.
