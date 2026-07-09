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
judgment. ONE runner exists (Decision 42): the in-session parallel event loop
(`skills/pipeline-runner/SKILL.md`).

## The seam — two verbs

The orchestrator exposes exactly one seam, a pair of CLI verbs the runner calls in
a loop:

| Verb                  | Scope      | Emits        | Asks                                   |
| --------------------- | ---------- | ------------ | -------------------------------------- |
| `factory next-task`   | run-level  | `NextTask`   | "which task is ready, or are we done?" |
| `factory next-action` | task-level | `NextAction` | "what's the next action on this task?" |

Both returns are discriminated unions whose `kind` is an **imperative** — it tells
the runner what to do, not what state something is in.

The `work` kind also carries an advisory `stale` list — ready tasks whose in-flight
spawn has aged past `config.stallTtlMinutes`, telling the runner to abandon a
silently-dead agent and re-drive (see [cli.md](./cli.md#next-task)).

**`NextTask` kinds:** `work` (drive this ready task) · `traceability` (run the
PRD-traceability audit — every non-debug run, before docs) · `document` (run the docs
phase) · `finalize` (everything terminal — roll up) · `done` (run already terminal)
· `pause` (quota-blocked; wait — `scope` names the binding window: `5h`, `7d`, or
`unavailable`). (Opt-in `--e2e` runs also emit `e2e-assessment` and `e2e` — see the
[e2e guide](../guides/run-with-e2e.md).)

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
agent to spawn — `{ role, isolation, model, max_turns, prompt?, effort? }`. The
runner spawns exactly the agents the request names and feeds their raw output back
via `--results`, keyed by **`result_key`** so the orchestrator knows which spawn the
output answers.

`prompt` is the engine-composed prompt the runner spawns **verbatim** — the engine
does the prompt assembly, not the runner. It is set on producer specs (the full
`ProducerContext` + the cd-to-worktree sentence) and omitted on panel-reviewer specs,
whose lens the runner still builds inline from `agents/<role>.md` +
`skills/review-protocol/SKILL.md`. A verify (`expects:"reviews"`) request adds two
verify-only fields:

- **`cross_vendor`** — the resolved cross-vendor slot (S5/C). `{status:"present", model, prompt}`
  ⇒ run the quality-reviewer via `codex exec`, spawning the pre-composed `prompt` verbatim;
  `{status:"absent", reason}` ⇒ all-Claude panel, echo `reason` as `crossVendorAbsent`.
- **`verifier_spec`** — the independent finding-verifier's spawn **template**
  `{ agent_type, model, isolation, prompt_template, interpolate_fields }`. The finding set
  is only known after the panel returns, so the runner renders one instance per
  blocking+citable finding by substituting exactly `interpolate_fields` into
  `prompt_template`. A field is admissible iff the verifier can check it against the code,
  so never the reviewer's `description`, `severity`, or `reviewer` (anti-anchoring). This
  carries the last spawn decision (`agent_type`/`model`/`isolation`) the runner hardcoded.

## Execution mode

`execution_mode` (`ExecutionModeEnum`: `sequential | balanced`) is the run's
task-scheduling preset, persisted in `state.json`. It is NOT the runner — it is a
dial the orchestrator reads when choosing how many tasks to advance at once.
