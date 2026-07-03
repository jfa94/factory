# Engine vocabulary

The control-flow words the factory uses, and what each one actually does. This is
the mechanism reference; for the domain glossary (Holdout, Risk Tier, the gates,
ship/staging/develop) see [glossary.md](../glossary.md).

The naming follows one rule: **a name describes behaviour, never a metaphor.** The
control plane decides; the data plane acts; the names say which is which.

## The two roles

| Role             | What it is                                                                                 | Can it act?            |
| ---------------- | ------------------------------------------------------------------------------------------ | ---------------------- |
| **Orchestrator** | The deterministic `factory` CLI engine. Owns ALL control flow; emits the next thing to do. | No — decides only.     |
| **Runner**       | A thin loop that steps the orchestrator and spawns the agents it names.                    | Yes — but no judgment. |

The orchestrator is the brain that cannot move; the runner is the hands with no
judgment. Two runners exist, stepping the identical seam: the in-session LLM loop
(`skills/pipeline-runner/SKILL.md`, `--mode session`) and the Workflow script
(`scripts/factory-run-runner.js`, `--mode workflow`).

## The seam — two verbs

The orchestrator exposes exactly one seam, a pair of CLI verbs the runner calls in
a loop:

| Verb                  | Scope      | Emits        | Asks                                   |
| --------------------- | ---------- | ------------ | -------------------------------------- |
| `factory next-task`   | run-level  | `NextTask`   | "which task is ready, or are we done?" |
| `factory next-action` | task-level | `NextAction` | "what's the next action on this task?" |

Both returns are discriminated unions whose `kind` is an **imperative** — it tells
the runner what to do, not what state something is in.

**`NextTask` kinds:** `work` (drive this ready task) · `document` (run the docs
phase) · `finalize` (everything terminal — roll up) · `done` (run already terminal)
· `pause` (blocked; wait — `scope` distinguishes a quota window from the workflow
runtime-budget suspend, Decision 41).

**`NextAction` kinds:** `spawn` (spawn these agents, resume after) · `done` (task
terminal) · `pause` (quota-blocked; wait).

`done` and `pause` appear in both unions deliberately — same vernacular, parsed
per-verb.

## Action, record, resume

- A **phase** is one step of a task's fixed order: `preflight → tests → exec →
verify → ship` (`TaskPhase`). The run-level phase is `finalize`.
- An **action** is one turn of the task loop: the orchestrator emits a `NextAction`,
  the runner carries it out (`nextAction`).
- **Record** is how agent output re-enters the engine: the runner calls
  `factory next-action --results <file>` and the orchestrator **records** that output
  into ONE state step (`recordResults` in `src/orchestrator/record.ts`). No metaphor —
  it writes the result down.
- `resume_phase` on a `spawn` request is the phase the engine resumes at once the
  spawned agents return.

## Spawn payload

A `spawn` action carries a **`SpawnRequest`**: `{ resume_phase, agents: AgentSpec[] }`,
optionally a `holdout?: AgentSpec` (the holdout validator). An **`AgentSpec`** is one
agent to spawn — `{ role, isolation, model, max_turns, prompt_ref, effort? }`. The
runner spawns exactly the agents the request names and feeds their raw output back
via `--results`, keyed by **`result_key`** so the orchestrator knows which spawn the
output answers.

## Execution mode

`execution_mode` (`ExecutionModeEnum`: `sequential | balanced`) is the run's
task-scheduling preset, persisted in `state.json`. It is NOT the runner — it is a
dial the orchestrator reads when choosing how many tasks to advance at once.
