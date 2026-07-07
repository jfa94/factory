# Model A: The Deterministic / LLM Split

The single most consequential design choice in the factory is where the line
between deterministic code and LLM judgment falls. Model A is the answer the
Node + TypeScript rewrite settled on: a hard seam with the **brain in code** and
the **hands in the LLM**.

## The problem

Autonomous coding requires two very different kinds of work:

1. **Judgment** — generating a spec from a PRD, writing code, reviewing code.
   These genuinely need an LLM.
2. **Bookkeeping** — deciding the next phase, classifying a failure, running a
   gate, computing a verdict, writing state, opening a PR. These need to be
   _exactly right, every time_.

An agent following prose instructions does so unreliably. If the bookkeeping is
expressed as agent instructions, a meaningful fraction of runs will skip a gate,
mis-classify a failure, or write inconsistent state — and do so _silently_. That
is unacceptable for an unattended pipeline whose whole value proposition is trust.

## The Model-A answer

Split the system in two and put a hard seam between them — **one engine, one
seam, one thin runner**:

- **The CLI is the brain, and it owns ALL control flow.** `factory <subcommand>`
  is a deterministic, tested TypeScript engine. It owns every piece of
  bookkeeping: all run-state writes, the spec gates, the deterministic verifier
  gates, failure classification, the producer escalation ladder, the
  risk-invariant merge gate, PR creation — _and the pipeline loop itself_. It is
  the _only_ thing that writes state. **It never spawns an agent** — it has no
  `Agent` tool.
- **The CLI exposes exactly ONE seam — the orchestrator.** `factory next-task` is the
  run-level orchestrator (which task is ready); `factory next-action` is the task-level orchestrator (run
  one task's deterministic steps until it needs agents, emitting a spawn request).
  Invoked again as `factory next-action --results`, the orchestrator records the agents' raw output
  back into exactly ONE state step. Every transition decision lives behind this
  seam, in code.
- **A runner is the hands — and nothing more.** A runner steps the seam: call
  `next-task`, spawn exactly the `Agent()`s the resulting `next-action` request names, feed
  their raw output back via `next-action --results`, repeat. A runner carries **no
  pipeline logic of its own** — it never decides a transition, re-runs a gate,
  classifies a failure, or writes state by prose. It is a dumb loop around the
  orchestrator.

ONE runner steps the seam (Decision 42): the in-session parallel event loop
(`skills/pipeline-runner/SKILL.md`), running in the invoking Claude Code session
— the only place that can spawn `Agent()`s directly. Every `factory` CLI call
runs foreground in that session (one-driver-per-task by construction); the
agents of up to `maxParallelTasks` ready tasks run in the background, and the
runner multiplexes their completions back through `next-action --results`.

It is **subscription-only** — there is no headless `claude -p` / API-token path
anywhere. The runner's entire job is the glue: step → spawn what the request names
→ feed the raw results back → follow the step the orchestrator returned.

## Why this particular boundary

A few alternatives were rejected:

- **Runner-as-sub-agent.** Claude Code exposes the `Agent` tool only to the
  top-level session; a sub-agent cannot spawn further sub-agents. An
  runner-as-agent would deadlock the first time it needed to dispatch a
  producer or reviewer. So the session runner must run in the main session.
- **Pure-script runner.** A shell/Node process cannot invoke the `Agent`
  tool at all. So the engine cannot also be the thing that spawns agents — the
  runner exists precisely because it can launch `Agent()`s while the
  engine (the orchestrator) cannot.
- **Pure-agent orchestration.** This is exactly the unreliability problem above —
  100%-reliable bookkeeping cannot be left to ~70%-reliable prose-following. A
  runner that "decides" anything would re-introduce it; the runner only steps.

Model A is the only split that respects both constraints: the agent-spawning must
live in the runner session, and the bookkeeping —
every decision — must live behind the orchestrator in code. The seam is the `factory`
CLI's JSON contract.

## What the seam buys

- **Testability.** Every transition, gate, classification, and ladder step is a
  pure function with unit tests (over a thousand of them). The non-deterministic
  parts are pushed to the edges (the agent prompts), where they belong.
- **Loud failure.** An unknown envelope kind, an unexpected non-zero CLI exit, a
  missing field, or a deadlock is a hard stop, not a silent fall-through. The Iron
  Laws in the runner skill exist precisely to forbid the "I'll just advance"
  rationalizations that would skip a gate.
- **Forgery resistance.** Because the CLI derives verdicts from ground truth and
  stores none (see [derive-dont-store.md](./derive-dont-store.md)), an agent cannot
  fake a passing gate by writing to state — there is no field to write.
- **One loop, runner-agnostic.** Because the orchestrator (`src/orchestrator/orchestrator.ts` +
  `next.ts` + `record.ts`) is the _single_ implementation of the loop, any runner
  inherits identical control flow for free. The event loop stays thin; a future
  out-of-session scheduler would just be a second runner over the same unchanged
  seam.
- **Zero prompt-assembly in the runner.** The last decisions the runner still made
  on its own — assembling a producer's prompt, composing the Codex cross-vendor
  reviewer prompt, and choosing the finding-verifier's agent-type/model/isolation —
  are now carried by envelope fields the engine composes (`AgentSpec.prompt`,
  `cross_vendor.prompt`, `verifier_spec`; see
  [engine-vocabulary](../reference/engine-vocabulary.md#spawn-payload) and
  [verifier.md](./verifier.md)). The runner spawns them verbatim. (Panel-reviewer
  prompts remain the one thing the runner builds inline, from the committed
  `agents/<role>.md` + `skills/review-protocol/SKILL.md` — static plugin surface, not
  per-run engine output.)
- **Self-healing inside a live session.** Two failure modes that used to strand a
  session now recover without a human: a mid-run **compaction** that drops the runner
  skill from context is re-seeded by the `SessionStart` re-injection hook (once wired —
  see [hooks.md](../reference/hooks.md#sessionstart-wiring-is-pending)), and a
  **silently-dead agent** whose spawn never returns is flagged by an engine-side stall
  TTL (`config.stallTtlMinutes`) in the `work` envelope's `stale` list so the runner
  abandons and re-drives it.

## The cost

The runner must faithfully obey the orchestrator's envelopes — spawn exactly
what a request names and feed results back verbatim — but it carries no pipeline
logic, so it cannot _diverge_ on a transition: there is one loop, in code, and
the runner only steps it. The discipline that remains is at the spawn boundary
(the runner skill's Iron Laws), not in a duplicated loop. This is the
payoff of collapsing the earlier in-process runner and the single-step CLI writers
into the orchestrator: the spawn-path record and a crash-resume record now run the identical
code (`src/orchestrator/record.ts`), so they cannot drift.

## See also

- [System Overview](../architecture/overview.md) — the container view and the run
  lifecycle.
- [Derive, don't store](./derive-dont-store.md) — the property that makes the seam
  forgery-resistant.
- `skills/pipeline-runner/SKILL.md` — the runner's Iron Laws and
  control loop.
  </content>
