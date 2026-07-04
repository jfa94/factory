---
description: 'Resume a paused/suspended factory run where it left off (re-check the quota gate, continue the loop)'
argument-hint: '[--run <id>] [--ignore-quota]'
arguments:
    - name: '--run'
      description: 'Run id to resume (OPTIONAL — defaults to the current run, runs/current)'
      required: false
    - name: '--ignore-quota'
      description: 'Bypass the live quota re-check: persists ignore_quota=true on the run and force-continues regardless of the current window reading. Use to override a mistaken suspend or after a manual quota reset. NOT a mode/ship flag — can be combined freely.'
      required: false
---

# /factory:resume

Continue an **existing** run — this is `/factory:recover`'s resume route with a manual
override flag. Prefer **`/factory:recover`**, which routes itself (resume, rescue, or page);
use this directly only for `--ignore-quota` or when you know the run is purely parked.

Resume only re-checks the live quota gate and re-enters the loop — it never touches task
state. A run parked WITHOUT a quota checkpoint (spec-approval, docs/e2e/traceability crash
parks) clears **unconditionally** — resume IS the sign-off (S9, Decision 47). A terminal run
is a LOUD error.

## How it runs

```
Skill(pipeline-runner)   # then: factory resume [--run <id>] [--ignore-quota]
```

- `{ kind: "resumed", run }` → re-enter the skill's Phase 3 event loop. Resume takes **no**
  ship flag (`--no-ship`/`--e2e` are rejected loud — a run keeps what it was created with).
- `{ kind: "pause", run_id, status, reason, resets_at_epoch? }` → the quota window has not
  recovered (fail-closed). Report and STOP; state is durable.

## Autonomous mode (MANDATORY)

`factory resume` HALTS loud (`NotAutonomousError`) unless `FACTORY_AUTONOMOUS_MODE=1`. The
runner skill's Phase 0 preflight prints the relaunch command when needed — see
`/factory:run` for the full autonomy contract. Never retry blindly past the gate.
