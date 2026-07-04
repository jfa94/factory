---
description: "Repair a stalled factory run with ONE self-routing verb: resume, rescue, or page — whatever the run actually needs"
argument-hint: "[--run <id>] [--dry-run]"
arguments:
  - name: "--run"
    description: "Run id to recover (OPTIONAL — defaults to the current run, runs/current)"
    required: false
  - name: "--dry-run"
    description: "Scan and report the chosen route only; write nothing"
    required: false
---

# /factory:recover

The "just fix it" front door (S10, Decision 48). `factory recover` reads the run's state +
rescue scan and routes itself — you don't need to know whether the run needs a resume, a
rescue, or a human decision. `/factory:resume` and `/factory:rescue` remain as the flag-rich
escape hatches for surgical control.

## How it runs

Invoke the runner skill, then:

```
Skill(pipeline-runner)   # then: factory recover [--run <id>] [--dry-run]
```

One envelope comes back (always exit 0). Act on `kind`:

- `nothing` — terminal or healthy run; report it (relay `hint` if present, e.g. a
  `--recheck-rollup` pointer) and STOP.
- `resumed` — the park cleared (`awaiting` names what it was: `quota` | `e2e` |
  `traceability` | `docs` | `spec-approval`). Re-enter the skill's Phase 3 event loop.
- `pause` — the quota window has not recovered (fail-closed). Report `reason` +
  `resets_at_epoch` and STOP; a later `/factory:recover` continues from here.
- `rescued` — stuck/recoverable tasks were reset (`reset`), a terminal run reopened
  (`reopened`), any surviving park cleared (`resume`). **If `reconcile: true`**, the
  recorded git state drifted (a task branch missing, the staging base gone): spawn the
  `rescue-reconciler` agent to repair remote drift BEFORE re-entering the loop —
  forward-only fixes are autonomous; destructive ones surface for confirmation (see
  `skills/rescue-protocol/reference/disposition-taxonomy.md`). Then re-enter Phase 3.
- `page` — nothing safely auto-fixable (dead-ends only, or a failed e2e verdict). Report
  `reason`, `dead_ends`, and the per-task `hints` (each an exact `factory rescue apply`
  command), then STOP — a human decides.

`--dry-run` emits the scan + the chosen `route` and writes nothing (`factory rescue scan`
is an alias of this).

## `--auto` (runner-internal)

`factory recover --auto --run <id>` is the runner's bounded self-heal, fired ONCE after a
failed finalize — not for human use. It resets the auto-safe set (stuck + recoverable tasks
whose dependency closure is clean post-reset; never dead-ends, e2e verdicts, or rollups),
stamping `self_heal.attempts` so the cycle can never repeat. Blocked → `{kind:"page"}` plus
ONE deduped comment on the originating PRD. See `skills/pipeline-runner/SKILL.md` Phase 3.

## Autonomous mode

The write routes (`resumed`/`rescued`/`--auto`) share `factory resume`'s gate: they HALT
loud (`NotAutonomousError`) unless `FACTORY_AUTONOMOUS_MODE=1`. Read-only routes
(`nothing`/`page`/`--dry-run`) work anywhere.
