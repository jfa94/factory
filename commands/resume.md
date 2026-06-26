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

Invoke the orchestrator skill, then run its resume entry against the target run:

```
Skill(pipeline-orchestrator)   # then: factory resume [--run <id>] [--ignore-quota]
```

`factory resume [--run <id>]` emits one envelope:

- `{ kind: "resumed", run }` → the quota window is open (or already running): re-enter the
  run loop. **Pick the driver from `resumed.run.mode` verbatim — never from command flags.**
  `mode` is immutable (set once at `run create`) and is therefore NEVER ambiguous; do not ask
  the user, and do not infer it from how `/factory:resume` was invoked. Resume itself takes
  **no** mode/ship flag (`factory resume --workflow`/`--no-ship` is rejected loud — a run keeps
  the `mode`/`ship_mode` it was created with):
  - `mode === "session"` → continue the skill's Phase 3 THE LOOP and Phase 4.
  - `mode === "workflow"` → re-launch the driver with
    `Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/scripts/factory-run-driver.js" })`, no `args` —
    it self-resolves `run_id`/`data_dir`/`ship_mode` from the first `factory next-task` envelope
    (`mode`/`ship_mode` are persisted on the run, never re-passed).
- `{ kind: "still-blocked", run_id, status, reason, resets_at_epoch? }` → the quota window
  has not recovered. Report `reason` (and `resets_at_epoch` if present) and STOP. The run
  state is durable — a later `/factory:resume` continues from exactly here.

## Autonomous mode (MANDATORY)

Like `factory run create`, `factory resume` **HALTS loud** (`NotAutonomousError`, non-zero
exit) unless the session is autonomous (`FACTORY_AUTONOMOUS_MODE=1`). The orchestrator skill's
Phase 0 (`factory autonomy preflight`) runs first and prints the relaunch command when needed
— see `/factory:run` for the full autonomy contract. Never retry blindly past the gate.
