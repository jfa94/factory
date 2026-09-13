# Dark Factory Plugin

Factory v2 turns a GitHub PRD into one reviewed feature PR. It generates an
executable spec from committed repository contracts, runs tasks sequentially in one
worktree, and preserves accepted work across repairs and interruptions.

The CLI owns state transitions, checks and delivery. The session runner dispatches
the exact requested agents and returns their evidence. Task checks and quality
review lead into broader slice and feature checks, independent review and final
acceptance. Live completion requires an observed merge of the reviewed HEAD.

Version 2 is a release candidate. See [the implementation ledger](proposals/sequential-feature-delivery.md)
for verification evidence and remaining release gates.

## Current documentation

- [Architecture](architecture/overview.md)
- [CLI reference](reference/cli.md)
- [Run a feature](guides/run-the-pipeline.md)
- [Resume a feature](guides/rescue-a-stalled-run.md)
- [State model](reference/state-model.md)
- [Hooks](reference/hooks.md)
- [Build and verify](guides/build-and-verify.md)
- [Runner protocol](../skills/pipeline-runner/SKILL.md)

## Historical material

Other documentation pages retain the v1 design for diagnosis of preserved runs.
Their staging branches, parallel tasks, holdouts, rescue/reset commands, escalation
ladder and temporary branch-protection policies do not apply to v2. The current
architecture, CLI and runner protocol take precedence.
