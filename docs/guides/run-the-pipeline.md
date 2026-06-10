# How to Run the Pipeline

This guide drives a PRD issue to shipped pull requests. It assumes you have a
GitHub repo with a PRD issue, the plugin installed in your Claude Code session,
and competence with `gh`. For the deterministic detail of each step, see the
[CLI reference](../reference/cli.md); for the full control loop, see
`skills/pipeline-orchestrator/SKILL.md`.

The pipeline runs **in your Claude Code session** — you (the session) are the
Model-A orchestrator; the `factory` CLI is the deterministic brain.

## 1. Scaffold the target repo (once per repo)

The pipeline refuses to start against an unscaffolded or unprotected repo.

```
/factory:scaffold --repo <owner/name>
```

If it refuses on missing branch protection, provision it or protect the staging
branch manually first. See [Scaffold a target repo](./scaffold-a-repo.md).

## 2. Start the run

```
/factory:run --repo <owner/name> --issue <N>
```

| Flag                  | Required | Notes                                                                                   |
| --------------------- | -------- | --------------------------------------------------------------------------------------- |
| `--repo <owner/name>` | yes      | Target repo.                                                                            |
| `--issue <N>`         | one of   | PRD issue number (the stable spec key).                                                 |
| `--spec-id <id>`      | one of   | `<issue>-<slug>`; mutually exclusive with `--issue`.                                    |
| `--driver`            | no       | `sequential` (concurrency 1) \| `balanced` (concurrency 3). Default `balanced`.         |
| `--ship-mode`         | no       | `no-merge` (default; opens task PRs, never merges) \| `live` (auto-merge into staging). |

`--ship-mode` is the cutover-safety knob. The default `no-merge` opens each task
PR but never merges; pass `live` only when you have explicitly opted into
auto-merge.

## 3. What happens (the four phases)

The orchestrator follows `skills/pipeline-orchestrator/SKILL.md`:

1. **Preconditions** — `factory scaffold` (idempotent re-check).
2. **Spec** — the bounded generate ⇄ review loop (`factory spec
resolve|gate|store`), spawning `spec-generator` / `spec-reviewer`, until the
   spec is `reuse`d or `stored`.
3. **Create** — `factory run create`; the `RunState` is emitted with the tasks
   seeded.
4. **Drive** — the run loop (dependency order, cascade-drop, deadlock guard)
   wrapping the per-task stage machine (`preflight → tests → exec → verify →
ship`). For each task the orchestrator spawns the producers and the review
   panel the CLI's envelopes ask for, and folds each outcome back with the
   `record-*` writers.
5. **Completion** — `factory run finalize` builds the report, files one issue per
   drop, and ships the `staging → develop` rollup; then `factory score` +
   `factory state --summary` report the outcome.

## 4. Read the outcome

The run ends in one of three terminal statuses:

- `completed` — every task done, rollup CI green.
- `partial` — the retry ladder was exhausted on one or more tasks; the
  dependency-closed done-set shipped, and one GitHub issue was filed per dropped
  task with its failure class (`capability-budget`, `spec-defect`, or
  `blocked-environmental`).
- `failed` — the run could not start or hit a non-recoverable error before any
  partial delivery.

A `partial`/`failed` run is a legible, classified outcome — read the filed issues
and the `report.md`. The rollup PR targets `develop`; `main` is never touched.

## 5. If the run pauses or suspends on quota

A run that hits a quota window does **not** finalize — it has unfinished work.

- `paused` (5h window) — self-heals; waits out the curve in-session.
- `suspended` (7d window) — state is persisted and the process exits cleanly.

Re-enter it once the window resets:

```
/factory:run resume [--run <id>]
```

On `{kind:"still-blocked", …}` the orchestrator reports the reason +
`resets_at_epoch` and stops; on `{kind:"resumed", run}` it continues the run loop.

## 6. If the run gets stuck mid-stage

If a session crashed and left tasks stuck in flight (so a re-drive would
deadlock), `resume` cannot help — use [Rescue a stalled run](./rescue-a-stalled-run.md).
</content>
