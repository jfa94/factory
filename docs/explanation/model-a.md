# Model A: The Deterministic / LLM Split

The single most consequential design choice in the factory is where the line
between deterministic code and LLM judgment falls. Model A is the answer the
Node + TypeScript rewrite settled on: a hard seam with the **brain in code** and
the **hands in the LLM**.

## The problem

Autonomous coding requires two very different kinds of work:

1. **Judgment** — generating a spec from a PRD, writing code, reviewing code.
   These genuinely need an LLM.
2. **Bookkeeping** — deciding the next stage, classifying a failure, running a
   gate, computing a verdict, writing state, opening a PR. These need to be
   _exactly right, every time_.

An agent following prose instructions does so unreliably. If the bookkeeping is
expressed as agent instructions, a meaningful fraction of runs will skip a gate,
mis-classify a failure, or write inconsistent state — and do so _silently_. That
is unacceptable for an unattended pipeline whose whole value proposition is trust.

## The Model-A answer

Split the system in two and put a hard seam between them:

- **The CLI is the brain.** `factory <subcommand>` is a deterministic, tested
  TypeScript engine. It owns every piece of bookkeeping: all run-state writes, the
  spec gates, the deterministic verifier gates, failure classification, the
  producer escalation ladder, the risk-invariant review floor, and PR creation. It
  is the _only_ thing that writes state. **It never spawns an agent** — it has no
  `Agent` tool.
- **The orchestrator is the hands.** A markdown skill loaded into the invoking
  Claude Code session performs every `Agent()` spawn the CLI asks for, collects the
  agents' raw output, and folds it back through a CLI writer. It never decides a
  transition, re-runs a gate, classifies a failure, or writes state by prose.

The CLI is therefore a **reporter + writer**, not a runner. A reporter subcommand
emits one JSON envelope naming what to spawn next; a writer folds an agent outcome
into state and returns the next step. The orchestrator's entire job is the glue:
spawn → write the output to a file → record it → follow the step the CLI returned.

## Why this particular boundary

A few alternatives were rejected:

- **Orchestrator-as-sub-agent.** Claude Code exposes the `Agent` tool only to the
  top-level session; a sub-agent cannot spawn further sub-agents. An
  orchestrator-as-agent would deadlock the first time it needed to dispatch a
  producer or reviewer. So the orchestrator must run in the main session.
- **Pure-script orchestrator.** A shell/Node process cannot invoke the `Agent`
  tool at all. So the engine cannot also be the thing that spawns agents.
- **Pure-agent orchestration.** This is exactly the unreliability problem above —
  100%-reliable bookkeeping cannot be left to ~70%-reliable prose-following.

Model A is the only split that respects both constraints: the agent-spawning must
live in the session, and the bookkeeping must live in code. The seam is the
`factory` CLI's JSON contract.

## What the seam buys

- **Testability.** Every transition, gate, classification, and ladder step is a
  pure function with unit tests (1140 of them). The non-deterministic parts are
  pushed to the edges (the agent prompts), where they belong.
- **Loud failure.** An unknown envelope kind, an unexpected non-zero CLI exit, a
  missing field, or a deadlock is a hard stop, not a silent fall-through. The Iron
  Laws in the orchestrator skill exist precisely to forbid the "I'll just advance"
  rationalizations that would skip a gate.
- **Forgery resistance.** Because the CLI derives verdicts from ground truth and
  stores none (see [derive-dont-store.md](./derive-dont-store.md)), an agent cannot
  fake a passing gate by writing to state — there is no field to write.
- **A clean v2 path.** The same transition logic (`src/driver`) backs both the
  in-process driver (used in tests) and the CLI single-step writers. A future
  out-of-session scheduler can drive the same seam.

## The cost

The orchestrator and the in-process driver are two expressions of the same loop,
so they must be kept in agreement by discipline (the skill mirrors the driver).
The CLI single-step path and the loop also diverge slightly where an agent spawn
is unavoidable (e.g. `verify` folds the holdout differently in the CLI reporter
than in the loop). This divergence is structural and accepted — documented at the
relevant seams in the source.

## See also

- [System Overview](../architecture/overview.md) — the container view and the run
  lifecycle.
- [Derive, don't store](./derive-dont-store.md) — the property that makes the seam
  forgery-resistant.
- `skills/pipeline-orchestrator/SKILL.md` — the orchestrator's Iron Laws and
  control loop.
  </content>
