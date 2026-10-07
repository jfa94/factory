<!-- last-documented: 6babea3a8ff3fe119f53333e74124dc198ae1ee2 -->

# Dark Factory Plugin

Factory is a Claude Code plugin that turns a GitHub PRD issue into one reviewed,
integrated feature pull request without a human in the loop. It is for a developer
who wants to hand off well-specified features and come back to a PR whose tests,
checks and reviews already passed.

## What it does

1. **Spec.** A `spec-generator` agent turns the PRD into an executable spec:
   tasks with acceptance criteria, dependencies and slices, snapshotted against the
   PRD, the base commit and the repository's committed contracts. A `spec-reviewer`
   scores it, and deterministic checks enforce requirement coverage, dependency
   order and contiguous slices. Up to five revisions are allowed.
2. **Build.** One run creates one feature branch and worktree from the base branch
   and executes the tasks one at a time. Each task is written tests-first by a
   `test-writer`, implemented by an `implementer`, checked by executed gates
   (tests, types, lint, TDD order) and reviewed.
3. **Verify.** Slice and feature boundaries add broader gates (build, coverage,
   mutation, SAST) and a panel of independent reviewers working on immutable
   snapshots. Review findings must cite real code and survive an independent
   `finding-verifier` before they cost a repair. An `acceptance-evaluator` checks
   every PRD requirement and acceptance criterion at the end.
4. **Deliver.** The run opens one PR. With `--no-ship` it stops at a PR ready for
   review; otherwise it completes only after observing the reviewed HEAD merged.
   Factory never merges into `main`; a run based on `main` stops ready for review.

## Design philosophy

- **Brain in code, hands in the LLM.** A deterministic CLI decides every
  transition, gate, repair budget and state write. The in-session runner only
  spawns the agents an action names and writes their replies to disk. See
  [Model A](explanation/model-a.md).
- **Evidence, not claims.** A producer saying "done" proves nothing. Gates must
  execute; reviewers must cite code; evaluators are independent of producers. See
  [the verifier](explanation/verifier.md).
- **Bounded, forward-only repair.** Each boundary has three repair passes. Invalid
  results are re-issued at most twice; transient failures are retried before the
  run parks. Accepted commits and evidence are never reset or force-pushed away.
- **Unattended by default.** Quota pressure becomes a wait, not a failure, and
  every attempt is persisted before dispatch so any session can resume it.

Version 2 is a release candidate. See
[the implementation ledger](proposals/sequential-feature-delivery.md) for
verification evidence and remaining release gates. The retired v1 engine is
preserved at the git tag `archive/v1-engine`.

## Contents

### Tutorial

- [Getting started](getting-started.md): build and verify the engine from a fresh clone.

### How-to guides

- [Scaffold a repository](guides/scaffold-a-repo.md)
- [Configure the factory](guides/configure-the-factory.md)
- [Run a feature](guides/run-the-pipeline.md)
- [Run with end-to-end tests](guides/run-with-e2e.md)
- [Resume a feature](guides/rescue-a-stalled-run.md)
- [Build and verify the plugin](guides/build-and-verify.md)

### Reference

- [CLI](reference/cli.md)
- [Configuration](reference/configuration.md)
- [State model](reference/state-model.md)
- [Automated gates](reference/automated-gates.md)
- [Hooks](reference/hooks.md)
- [Exit codes](reference/exit-codes.md)
- [Runner protocol](../skills/pipeline-runner/SKILL.md)

### Architecture

- [Overview](architecture/overview.md)
- [Components](architecture/components.md)

### Explanation

- [Model A: the deterministic / LLM split](explanation/model-a.md)
- [The verifier](explanation/verifier.md)
- [Quota pacing](explanation/quota-pacing.md)
- [The plugin data dir](explanation/plugin-data-dir.md)
- [Design decisions](explanation/decisions.md) (historical ledger)

### Glossary

- [Glossary](glossary.md)

### Proposals

Design proposals and plans live in [proposals/](proposals/) and
[superpowers/plans/](superpowers/plans/). They record intent at the time of
writing, not current behaviour.
