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

Split the system in two and put a hard seam between them — **one engine, one
seam, two thin drivers**:

- **The CLI is the brain, and it owns ALL control flow.** `factory <subcommand>`
  is a deterministic, tested TypeScript engine. It owns every piece of
  bookkeeping: all run-state writes, the spec gates, the deterministic verifier
  gates, failure classification, the producer escalation ladder, the
  risk-invariant review floor, PR creation — _and the pipeline loop itself_. It is
  the _only_ thing that writes state. **It never spawns an agent** — it has no
  `Agent` tool.
- **The CLI exposes exactly ONE seam — the coroutine.** `factory next` is the
  run-level coroutine (which task is ready); `factory drive` is the task-level coroutine (run
  one task's deterministic steps until it needs agents, emitting a spawn manifest).
  Invoked again as `factory drive --results`, the coroutine folds the agents' raw output
  back into exactly ONE state step. Every transition decision lives behind this
  seam, in code.
- **A driver is the hands — and nothing more.** A driver steps the seam: call
  `next`, spawn exactly the `Agent()`s the resulting `drive` manifest names, feed
  their raw output back via `drive --results`, repeat. A driver carries **no
  pipeline logic of its own** — it never decides a transition, re-runs a gate,
  classifies a failure, or writes state by prose. It is a dumb loop around the
  coroutine.

Two interchangeable drivers step the same seam, selected by `--workflow` on
`/factory:run`:

- **Session mode** (default, no flag) — the in-session LLM orchestrator loop
  (`skills/pipeline-orchestrator/SKILL.md`), running in the invoking Claude Code
  session. This is the driver that can spawn `Agent()`s directly.
- **`--workflow`** — the plugin-shipped Workflow script
  (`scripts/factory-run-driver.js`). Because Workflow JS cannot shell out, it
  wraps every `factory` CLI call in a small exec agent (sonnet).

Both are **subscription-only** — there is no headless `claude -p` / API-token path
anywhere. The driver's entire job is the glue: step → spawn what the manifest names
→ feed the raw results back → follow the step the coroutine returned.

## Why this particular boundary

A few alternatives were rejected:

- **Orchestrator-as-sub-agent.** Claude Code exposes the `Agent` tool only to the
  top-level session; a sub-agent cannot spawn further sub-agents. An
  orchestrator-as-agent would deadlock the first time it needed to dispatch a
  producer or reviewer. So the session driver must run in the main session.
- **Pure-script orchestrator.** A shell/Node process cannot invoke the `Agent`
  tool at all. So the engine cannot also be the thing that spawns agents — the
  workflow driver exists precisely because it can launch `Agent()`s while the
  engine (the coroutine) cannot.
- **Pure-agent orchestration.** This is exactly the unreliability problem above —
  100%-reliable bookkeeping cannot be left to ~70%-reliable prose-following. A
  driver that "decides" anything would re-introduce it; the driver only steps.

Model A is the only split that respects both constraints: the agent-spawning must
live in a driver (the session or the Workflow runtime), and the bookkeeping —
every decision — must live behind the coroutine in code. The seam is the `factory`
CLI's JSON contract.

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
- **One loop, many drivers.** Because the coroutine (`src/driver/coroutine.ts` +
  `next.ts` + `fold.ts`) is the _single_ implementation of the loop, every driver
  inherits identical control flow for free. The session loop and the Workflow
  script are thin and interchangeable; a future out-of-session scheduler would be a
  third driver over the same unchanged seam.

## The cost

The two drivers must each faithfully obey the coroutine's envelopes — spawn exactly
what a manifest names and feed results back verbatim — but they share no pipeline
logic, so they cannot _diverge_ on a transition: there is one loop, in code, and
the drivers only step it. The discipline that remains is at the spawn boundary
(the orchestrator skill's Iron Laws), not in a duplicated loop. This is the
payoff of collapsing the earlier in-process driver and the single-step CLI writers
into the coroutine: the spawn-path fold and a crash-resume fold now run the identical
code (`src/driver/fold.ts`), so they cannot drift.

## See also

- [System Overview](../architecture/overview.md) — the container view and the run
  lifecycle.
- [Derive, don't store](./derive-dont-store.md) — the property that makes the seam
  forgery-resistant.
- `skills/pipeline-orchestrator/SKILL.md` — the orchestrator's Iron Laws and
  control loop.
  </content>
