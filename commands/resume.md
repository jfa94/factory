---
description: 'Make a stalled run continue — resume it if clean, or propose the repairs (you approve a subset) and then resume'
argument-hint: '[--run <id>] [--ignore-quota] [--dry-run]'
arguments:
    - name: '--run'
      description: 'Run id to resume (OPTIONAL — defaults to the current run, runs/current)'
      required: false
    - name: '--ignore-quota'
      description: 'Bypass the live quota re-check: persists ignore_quota=true on the run and force-continues regardless of the current window reading. Use to override a mistaken suspend or after a manual quota reset.'
      required: false
    - name: '--dry-run'
      description: 'Scan and print the route + proposed repair plan only; write nothing'
      required: false
---

# /factory:resume

THE repair verb (Decision 50, replacing `/factory:rescue` and `/factory:recover`): whatever
the run needs, this command routes it — a clean park just resumes; anything needing repair is
PROPOSED to you first (one interactive prompt, approve any subset), applied, then resumed.
Nothing mutates without consent; escalation is internal, not a second command.

## How it runs

Invoke the runner skill, then scan:

```
Skill(pipeline-runner)   # then: factory rescue scan [--run <id>]
```

The scan envelope is read-only and carries the chosen `route`. Act on it:

- **`nothing`** — no run, or a terminal (completed/superseded/failed-with-nothing-recoverable)
  run. Report it — including any `hints` (e.g. a `--recheck-rollup` pointer for an armed
  rollup) — and STOP.
- **`resume`** — the run is clean (parked or a healthy re-entry; `awaiting` names any park
  cause: `quota` | `e2e` | `traceability` | `docs` | `spec-approval`). Run
  `factory resume [--run <id>] [--ignore-quota]`:
    - `{kind:"resumed"}` → re-enter the skill's Phase 3 event loop. Resume takes **no** ship
      flag (`--no-ship`/`--e2e` rejected loud — a run keeps what it was created with).
    - `{kind:"pause"}` → the quota window has not recovered (fail-closed). Report `reason` +
      `resets_at_epoch` and STOP; a later `/factory:resume` continues from here.
- **`repair`** — something needs fixing before the run can continue. Load the repair
  protocol skill; it owns diagnostics, the consent prompt, the apply, drift reconciliation,
  and the resume handoff:

    ```
    Skill(rescue-protocol, "run=<id-or-empty> ignore-quota=<bool>")
    ```

With `--dry-run`, print the scan's route + proposed plan (its `hints` are the exact
`factory rescue apply` line items) and STOP — nothing is written.

## Autonomous mode (MANDATORY for the write path)

`factory resume` HALTS loud (`NotAutonomousError`) unless `FACTORY_AUTONOMOUS_MODE=1`. The
runner skill's Phase 0 preflight prints the relaunch command when needed — see
`/factory:run` for the full autonomy contract. Never retry blindly past the gate. The scan
(and `--dry-run`) is read-only and works anywhere.
