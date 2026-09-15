# Run a v2 feature

Prepare the target repository with `/factory:scaffold`. Commit its gate configuration
and ensure the base branch has strict required checks. Provisioning remote branch
protection requires authorization. Run execution does not weaken that protection.

Start from a GitHub PRD issue:

```text
/factory:run --issue <number> [--repo owner/name] [--no-ship | --local] [--e2e]
```

The command generates a fresh spec from the PRD and committed repository contracts.
The bounded generation loop checks requirement coverage, dependency order, shared
file ownership and contiguous slices. It allows five revisions. A failed spec
must be corrected before a feature run starts.

One repository has at most one active run. One run uses one feature branch and
worktree, executes tasks sequentially and opens one PR. Independent reviewers use
detached snapshots. Task checks cover tests, types and lint; slice and feature
boundaries run broader checks and review. Final acceptance covers every PRD
requirement and task criterion.

The runner follows execute, wait, park and terminal envelopes from
`factory next-action`. It never invents a transition. Three repair passes are
available at each execution boundary; waiting does not spend a repair pass.

`--no-ship` ends with the feature PR ready for review. Live execution completes only
after observing the reviewed HEAD merged. No-change completion requires independent
acceptance evidence and creates no empty PR. `--e2e` adds test authoring and an
executed Playwright suite before final acceptance. Ship and quota policy persist.

Inspect progress with `factory state --run <id> --ledger`. To stop, use
`factory run stop --run <id>`; stopping preserves the branch and all work. Follow
[the recovery guide](rescue-a-stalled-run.md) to continue.

See [the CLI reference](../reference/cli.md) and
[the runner protocol](../../skills/pipeline-runner/SKILL.md) for exact arguments
and result contracts. V1 runs and imported specs cannot execute through v2.
