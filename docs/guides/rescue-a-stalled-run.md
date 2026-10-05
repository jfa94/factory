# Resume a v2 feature

Inspect the persisted reason and attempt before acting:

```sh
factory state --run <id> --ledger
```

Some failures do not need you. A transient git, `gh` or worktree provisioning
failure leaves the run `waiting` and is retried every 60 seconds; only the fifth
consecutive failure parks it as `environment`. An invalid agent result is
re-issued to that role with the reason, at most twice; a third rejection parks the
run as `producer`. An agent reporting `blocked` is re-issued the same way; a third
`blocked` parks the run as `environment`. A `needs-context` question is first sent
to spec repair. See [result validation](../reference/state-model.md#result-validation).

For an explicit stop or a resolved environment/CI problem:

```sh
factory resume --run <id>
```

For a pending question (a `context` park, or a `spec` park where spec repair was
blocked), supply a nonempty answer; `resume` refuses without one. Answers remain in
future prompts and the audit ledger:

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
