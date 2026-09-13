# Resume a v2 feature

Inspect the persisted reason and attempt before acting:

```sh
factory state --run <id> --ledger
```

For an explicit stop or a resolved environment/CI problem:

```sh
factory resume --run <id>
```

For a context question, supply a nonempty answer. Answers remain in future prompts
and the audit ledger:

```sh
factory resume --run <id> --answer "The requested behavior is ..."
```

If an attempt is still leased, first stop its worker. Then recover explicitly:

```sh
factory resume --run <id> --recover
```

Recovery preserves committed and uncommitted work. It consumes a complete staged
result, re-issues only the missing roles of a partial review panel, or retires the
interrupted attempt. A finished agent's output can still be written verbatim to its
staged path (shown in the ledger) before recovering. Rejected evidence stays on disk
and the rejection reason is audited; the replacement attempt must provide valid
evidence. The next action must still pass all checks and independent review.
Never run two workers for the same attempt.

Continue through `/factory:resume --run <id>` or the
[next-action protocol](../../skills/pipeline-runner/SKILL.md). An ordinary Stop
event never resumes an operator park; quota recovery does not override it either.

`factory run cancel --run <id>` retains artifacts and Git work. Terminal runs need
a fresh run. V1 rescue, reconcile, reset, supersede and garbage-collection commands
are retired; v1 artifacts remain available for diagnosis and are not migrated or
deleted by v2.
