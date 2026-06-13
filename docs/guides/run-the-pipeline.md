# How to Run the Pipeline

This guide drives a PRD issue to shipped pull requests. It assumes you have a
GitHub repo with a PRD issue, the plugin installed in your Claude Code session,
and competence with `gh`. For the deterministic detail of each step, see the
[CLI reference](../reference/cli.md); for the full control loop, see
`skills/pipeline-orchestrator/SKILL.md`.

The `factory` CLI is the deterministic engine: it owns all control flow and
exposes one seam, the **pump** (`factory next` + `factory drive`). A thin
**driver** pumps that seam and spawns the agents each envelope names. You pick the
driver with `--mode` (below); the default runs the loop **in your Claude Code
session**.

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
| `--mode`              | no       | `session` (default) \| `workflow`. Which driver pumps the seam — see below.             |
| `--ship-mode`         | no       | `no-merge` (default; opens task PRs, never merges) \| `live` (auto-merge into staging). |

`--mode` selects the driver. Both pump the same `factory next` / `factory drive`
seam and enforce the identical engine gates; they differ only in where the loop
runs:

- **`--mode session`** (default) — the in-session LLM orchestrator loop
  (`skills/pipeline-orchestrator/SKILL.md`). It runs in your Claude Code session
  and drives tasks one at a time.
- **`--mode workflow`** — the plugin-shipped Workflow script
  (`workflows/factory-run.workflow.js`). It drives ready tasks in the background;
  because Workflow JS cannot shell out, it wraps every `factory` CLI call in a
  small exec agent. Note: workflow mode has no quota pacing (it cannot observe the
  usage signal) — it hard-stops when the allowance runs out.

`--ship-mode` is the cutover-safety knob. The default `no-merge` opens each task
PR but never merges; pass `live` only when you have explicitly opted into
auto-merge. Ship mode is not persisted — re-pass it on resume.

## 3. What happens (the four phases)

The driver follows `skills/pipeline-orchestrator/SKILL.md` (session mode) or runs
the equivalent Workflow script (workflow mode):

1. **Preconditions** — `factory scaffold` (idempotent re-check).
2. **Spec** — the bounded generate ⇄ review loop (`factory spec
resolve|gate|store`), spawning `spec-generator` / `spec-reviewer`, until the
   spec is `reuse`d or `stored`.
3. **Create** — `factory run create`; the `RunState` is emitted with the tasks
   seeded.
4. **Drive** — the driver pumps the seam. `factory next` returns the ready task;
   `factory drive` advances it through the per-task stage machine (`preflight →
tests → exec → verify → ship`), emitting a spawn manifest whenever it needs
   agents. The driver spawns the producers and the review panel the manifest
   names, then folds their raw output back with `factory drive --results` (one
   state step). The engine — not the driver — decides every transition.
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
