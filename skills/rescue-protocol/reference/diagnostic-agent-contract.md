# Diagnostic Agent Contract

The `rescue-diagnostic` agent (`agents/rescue-diagnostic.md`) is a read-only Sonnet subagent
the **orchestrator spawns** (Model A: the CLI never spawns agents) to investigate ONE
ambiguous **dead-end** task — a `dropped` task whose `failure_class` is `spec-defect` or
`capability-budget`, where it is unclear whether the root cause has since cleared.

A default `factory rescue apply` leaves dead-ends dropped. The diagnostic is the seam that
decides whether a specific dead-end is worth re-attempting (→ `factory rescue apply --task
<id>`) or is a genuine determined failure (→ leave it dropped, the run finalizes partial).

It is **read-only and advisory**: it has no Write/Edit/Bash tool, mutates nothing, and its
**final message is the decision** — there is no output file.

## Input — passed in the dispatch prompt

The orchestrator builds the prompt from the task's `factory rescue scan` line plus whatever
ground-truth pointers it can gather. Any field may be absent.

```jsonc
{
    "run_id": "<run-id>",
    "task": {
        "task_id": "<task-id>",
        "status": "dropped",
        "disposition": "dead-end",
        "failure_class": "spec-defect | capability-budget",
        "failure_reason": "<string>",
        "branch": "<branch-or-absent>",
        "pr_number": 42,
    },
    "context": {
        "worktree_path": "<abs-path-or-null>",
        "review_files": ["<path>", "..."],
        "ci_logs_path": "<path-or-null>",
        "spec_path": "<abs-path-or-null>",
    },
}
```

## Output — the agent's final message

ONE JSON object, the entire final message (the Agent tool returns it to the orchestrator):

```jsonc
{
    "decision": "reset | leave-dropped | no-action",
    "reason": "<one paragraph: root cause + whether it has cleared>",
    "evidence": ["<file:line or log excerpt>", "..."],
    "confidence": "high | medium | low",
}
```

## Decision semantics

| decision        | when to choose                                                                                                                                  | orchestrator action                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `reset`         | The cause was environmental/transient and has plausibly cleared (dep since shipped, flaky tool, spec ambiguity since clarified). Worth a retry. | `factory rescue apply --run <id> --task <task-id>` |
| `leave-dropped` | Confirmed determined failure (spec truly cannot satisfy a criterion; model hit a real capability ceiling). Retrying repeats it.                 | none — task stays dropped                          |
| `no-action`     | Evidence missing/ambiguous/contradictory. Not touching is safer than a wrong reset.                                                             | none — task stays dropped (flagged uncertain)      |

Only `reset` causes a state change, and only via the explicit `--task` the orchestrator then
issues. `leave-dropped` and `no-action` both leave the task dropped — the difference is a
_confirmed_ dead-end vs. _could-not-tell_.

## Guardrails

- Unknown/missing `decision` or unparseable JSON → orchestrator treats it as `no-action`.
- Agent error or empty final message → orchestrator treats it as `no-action`.
- The agent is parallelisable: one `Agent()` call per ambiguous dead-end, in a single message.
- Declared tool set: **Read, Grep, Glob** — no Write, Edit, Bash, git, or gh.

## Worked example

**Scenario:** Task `T3` was dropped `blocked-environmental`? No — it was dropped
`capability-budget` after the ladder exhausted, but `T3` depended on `T1`, which itself only
shipped _after_ `T3`'s last attempt. The orchestrator is unsure and spawns the diagnostic.

Input (in the prompt):

```json
{
    "run_id": "run-20260608-101500",
    "task": {
        "task_id": "T3",
        "status": "dropped",
        "disposition": "dead-end",
        "failure_class": "capability-budget",
        "failure_reason": "implementer could not satisfy criterion 2: integration with T1's exporter (module absent)",
        "branch": "factory/run-20260608-101500/T3"
    },
    "context": {
        "worktree_path": "/repo/.worktrees/factory/run-20260608-101500/T3",
        "review_files": ["/data/runs/run-20260608-101500/reviews/T3-architecture.json"],
        "ci_logs_path": null,
        "spec_path": "/data/specs/acme__widgets/14-exporter/spec.md"
    }
}
```

Final message:

```json
{
    "decision": "reset",
    "reason": "T3 exhausted the ladder because T1's exporter module did not exist at attempt time — every rung failed on the same missing import, not on a capability ceiling. T1 has since shipped (its module is now on staging), so the blocker has cleared and a fresh attempt can satisfy criterion 2. The drop was misclassified capability-budget; resetting is worth one cycle.",
    "evidence": [
        "failure_reason: 'integration with T1's exporter (module absent)'",
        "reviews/T3-architecture.json:12 — 'cannot import ../exporter; T1 not yet merged'",
        "spec.md:41 — criterion 2 requires T1's exporter, which is a separate shipped task"
    ],
    "confidence": "high"
}
```
