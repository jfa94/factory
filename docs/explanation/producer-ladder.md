# The Producer Escalation Ladder

When a producer's output fails the floor, the factory does not blindly retry. It
runs a bounded, structured escalation — the **ladder** (`src/producer/ladder.ts`)
— governed by three rules: classify before retry, change a variable each rung, and
cap the retries before a loud classified drop. This document explains why each rule
exists.

## The shape

The ladder is two nested loops:

```mermaid
graph TD
  Start[producer attempt] --> Classify{classify failure}
  Classify -->|spec-defect / environmental| Drop[classified loud drop<br/>no rung burned]
  Classify -->|capability| Verify[run verify floor]
  Verify -->|clear| Adv[advance → ship]
  Verify -->|confirmed misses| Fix[inner: fix-forward patch<br/>bounded by patchBudget]
  Fix -->|budget/progress spent| Esc[outer: nuke + escalate rung]
  Esc -->|rung ≤ CAP| Start
  Esc -->|CAP exhausted| DropCap[drop: capability-budget]
```

- **Outer loop** — the bounded nuke-and-retry over rungs `0..CAP` (CAP = 2 extra
  attempts). Each rung is a fresh start that changes a variable.
- **Inner loop** — fix-forward: after a `done` producer spawn, the floor runs; on
  confirmed misses the producer is re-spawned to _patch the specific remaining
  blockers_ (not nuked), bounded by a patch budget and by making progress.

## Rule 1 — Classify before retry

Not every failure is worth retrying. Before any rung is burned, the failure is run
through `classifyFailure`. A failure that is structural — a spec defect (e.g. an
untestable acceptance criterion), a structurally-unfixable gate, or an
environmental blocker — routes _straight_ to a classified loud drop. Retrying it
only wastes the budget on a determined failure.

Only a capability failure — a fixable miss, a verifier error, a producer that ran
out of context — re-executes. This is why drops carry a closed failure class
(`capability-budget`, `spec-defect`, `blocked-environmental`): the class tells the
human what to do, and tells the ladder whether to retry.

## Rule 2 — Change a variable each rung

A blind re-roll (re-running the same producer on the same model with the same
context) wastes attempts — if it failed once, it will likely fail again. So each
rung must change something:

- **Rung 0** — the model dialed for the task's risk tier, fresh context.
- **Rung 1** — the _same_ dialed model, _fresh_ context (the clean slate is the
  change).
- **Rung 2** — an _escalated_ model (the next tier up the `producerModels` map:
  low→medium→high; high is the ceiling) _plus_ injected prior-failure context.

The escalated model comes from the same `quota.producerModels` config map — no new
literal, no new knob — so a config override flows through every rung. The ladder
asserts the change at runtime (`assertRungChange`): a true blind re-roll throws.
This is the only place the `risk_tier` dial acts — it sets the producer's starting
model and escalation budget. (The verifier floor is risk-invariant; see
[verifier.md](./verifier.md).)

## Rule 3 — Cap, then drop loud

The retries are capped (CAP = 2 past the starting rung). When the cap is exhausted
with the floor still blocked, the task is dropped with `capability-budget` and a
reason — a third retry never spawns. Every terminal path of the ladder is loud and
classified: success is an `advance`, every failure is a `taskDropped`. There is no
silent return.

## The inner fix-forward loop

Nuking the whole producer on every miss is wasteful when only a couple of confirmed
blockers remain. So before escalating, the ladder patches forward: it re-spawns the
producer over the _specific_ remaining confirmed blockers (folded into the prompt),
re-verifies, and repeats — bounded by the patch budget and by the requirement that
each pass reduce the blocker count. When the budget or progress is spent, the outer
loop nukes and escalates the model. This keeps cheap, targeted fixes cheap and
reserves the expensive model escalation for genuine capability shortfalls.

## What a drop becomes

A dropped task is terminal. At run finalize, each drop becomes one GitHub issue
(labelled with its failure class) and a line in the partial-run report. The
dependency-closed done-set still ships; the run ends `partial`. Nothing is papered
over. See [../guides/run-the-pipeline.md](../guides/run-the-pipeline.md).
</content>
