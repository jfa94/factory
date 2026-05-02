# Locking Model

The pipeline uses two distinct lock scopes. They must always be acquired in the
order listed below; acquiring them in the reverse order risks deadlock.

## 1. Orchestrator lock (`pipeline-lock`)

**Scope:** the orchestrator process (one per `pipeline-orchestrator` invocation).

**Purpose:** prevents two concurrent orchestrator instances from racing to
advance the same run's stage machine simultaneously.

**Mechanism:** `bin/pipeline-lock` — an advisory `flock(1)` (or mkdir fallback)
on `$CLAUDE_PLUGIN_DATA/runs/<run_id>/orchestrator.lock`.

**Who holds it:** the orchestrator skill, for the duration of a single
orchestrator turn.

## 2. State lock (`pipeline-state` per-run lock)

**Scope:** a single atomic read-modify-write cycle on `state.json`.

**Purpose:** serialises concurrent `pipeline-state write`, `task-write`,
`task-init`, and `task-status` calls that could otherwise produce a torn write.

**Mechanism:** `flock(1)` on `$CLAUDE_PLUGIN_DATA/runs/<run_id>/state.lock`
(acquired inside `bin/pipeline-state`, held for microseconds).

**Who holds it:** `pipeline-state` internally, never by callers.

## Invariants

- **Acquisition order:** orchestrator lock → state lock (never the reverse).
  Code inside an orchestrator-locked region may safely call `pipeline-state`
  because the state lock is acquired and released within that inner call.
- **No nesting:** `pipeline-state` never calls itself recursively, so the state
  lock is never re-entered.
- **Callers must not hold the state lock externally.** All callers invoke
  `pipeline-state` as a subprocess; the lock is internal to that subprocess.

## Adding a new lock

Before adding a third lock, verify it fits one of the two scopes above. If it
spans multiple `pipeline-state` calls (i.e., it needs to be held across
several state writes), it belongs at the orchestrator scope — wrap the block
in `pipeline-lock` rather than trying to hold the state lock across calls.
