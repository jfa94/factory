---
description: "Resume a paused/suspended factory run where it left off (re-check the quota gate, continue the loop)"
argument-hint: "[--run <id>] [--ignore-quota]"
arguments:
  - name: "--run"
    description: "Run id to resume (OPTIONAL — defaults to the current run, runs/current)"
    required: false
  - name: "--ignore-quota"
    description: "Bypass the live quota re-check: persists ignore_quota=true on the run and force-continues regardless of the current window reading. Use to override a mistaken suspend or after a manual quota reset. NOT a mode/ship flag — can be combined freely."
    required: false
---

# /factory:resume

Continue an **existing** run. Resume only re-checks the live quota gate and re-enters the
loop — it never touches task state. (To start fresh use `/factory:run`; to repair a run that
resume cannot untangle — tasks stuck mid-stage, or git/GitHub drift — use `/factory:rescue`,
which reconciles, then hands back to resume.)

A terminal run (`completed` / `failed` / `superseded`) is a LOUD error — there is nothing to
resume. A `failed` run keeps its `staging/<run-id>` branch banked for `/factory:rescue`.

## How it runs

Invoke the runner skill, then run its resume entry against the target run:

```
Skill(pipeline-runner)   # then: factory resume [--run <id>] [--ignore-quota]
```

`factory resume [--run <id>]` emits one envelope:

- `{ kind: "resumed", run }` → the quota window is open (or already running): re-enter the
  skill's Phase 3 event loop (up to `maxParallelTasks` tasks in flight) and Phase 4.
  Resume itself takes **no** ship flag
  (`factory resume --no-ship` is rejected loud — a run keeps the `ship_mode` it was
  created with).
- `{ kind: "still-blocked", run_id, status, reason, resets_at_epoch? }` → the quota window
  has not recovered. Report `reason` (and `resets_at_epoch` if present) and STOP. The run
  state is durable — a later `/factory:resume` continues from exactly here.

## Autonomous mode (MANDATORY)

Like `factory run create`, `factory resume` **HALTS loud** (`NotAutonomousError`, non-zero
exit) unless the session is autonomous (`FACTORY_AUTONOMOUS_MODE=1`). The runner skill's
Phase 0 (`factory autonomy preflight`) runs first and prints the relaunch command when needed
— see `/factory:run` for the full autonomy contract. Never retry blindly past the gate.
