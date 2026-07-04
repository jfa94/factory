# Quality-First Design — the first-principles spine

**Status:** Design intent (2026-06-04). The north-star model for how the factory
_should_ be designed to achieve its objective, derived from first principles —
deliberately independent of the current implementation. Formalized as
**Decisions 19–27** in `../explanation/decisions.md`. Companion to
`design-intent-and-redesign.md` (which tracks intent-vs-current-code deltas).

> Read this for the _why_; read the Decisions for the formal _what_; read
> `design-intent-and-redesign.md` for the gap to current code.

## 1. Objective

The project's objective is to produce **high-quality code without human
intervention**. Both quality and autonomy are fundamental — but not symmetric:

- **Autonomy = a hard condition.** "Did a human intervene between the PRD and the
  `develop` rollup?" has an objective yes/no answer, so autonomy can be _assured_:
  every run either satisfies it or fails it.
- **Quality = the maximand.** There is no binary certificate of "high quality"; a
  property you cannot gate on, you can only push toward. Quality is maximised,
  never proven complete.
- **Cost = the free variable**, which flexes with quota.

The split is **verifiability, not priority**: _if_ quality were an objective
yes/no, both would be hard conditions; quality's non-verifiability is what makes it
the maximand. This is also the root of the trust architecture (§2–3) — the verifier
layer is the system's best _synthetic_ stand-in for the quality certificate that
can never exist.

The human acts only at the **boundaries**: authoring the PRD, owning the
`develop → main` promotion, and handling loud failures. There is no mid-run
escalation valve. When quality and cost conflict, quality wins within quota; when
quality cannot be reached autonomously, the system **drops loudly** rather than
ship uncertain quality or call a human.

(Decisions 19, 20.)

## 2. The quality chain: target → ceiling → floor

With no human judge, "quality" is operationally _whatever survives verification_.
The system is three parts on one axis:

- **Spec = the target.** The acceptance criteria are the operational definition of
  "done and good." Everything downstream executes and is certified _against the
  spec_. A flawed spec is certified as success — garbage-in dominates.
- **Producer = the ceiling.** It writes the code; the system can only ship what the
  producer is capable of producing. Verification _filters, it does not create_. The
  producer is a commodity — but a **tunable** one: its model adapts to a task's
  **spec-time risk tier** — a single judgment of how much model strength the task warrants, blending difficulty and stakes (Decision 25) — making it the **secondary** quality lever. The dial sets
  only the ceiling, never the floor (the verifier stays Opus), so mis-tagging
  **degrades gracefully** — more retries or a drop, never a bad merge; risk-tiering
  is a performance optimization, not a safety control (Decision 25).
- **Verifier = the floor + the trust anchor.** Only what passes ships. It stands in
  for the absent human judge, so its independence and un-gameability _are_ the
  system's credibility. It is the **primary** quality investment. It has **two layers** — a deterministic layer (tests, mutation, coverage, SAST, type-check, lint, build) and a judgment layer (the **review panel** of independent reviewers); **TDD exists to maximise the deterministic layer**. The whole floor is **risk-invariant** — only the producer ceiling moves with risk (Decisions 25, 26).

Maximising quality = raising the floor toward the ceiling _and_ raising the ceiling
— but the parts want opposite treatment, captured in the model/effort allocation:

| Layer               | Model        | Effort  | Role                                          |
| ------------------- | ------------ | ------- | --------------------------------------------- |
| Spec (gen + review) | Opus         | **Max** | apex — target, no ground-truth backstop       |
| Verifier            | Opus         | Default | trust anchor — never cheapened on model       |
| Producer            | **Adaptive** | Default | ceiling — tunable commodity; cost flexes here |

(Decisions 18, 21.)

## 3. Trust — why the verdict can be believed

The verifier is only worth anything if the producer cannot game it. The threat
model is **emergent gaming** — a non-malicious producer taking the cheapest path to
"green," not a determined adversary. So the design goal is not to make gaming
_impossible_ (that needs an OS sandbox, out of scope) but to **make honest
compliance the cheapest path**. Five properties serve that one inequality:

1. **Independence** — verifiers run in fresh contexts; the spec generator is never
   its own reviewer; verdicts are derived from ground truth, never read from
   anything the producer can write.
2. **Ground-truth derivation** — a verdict is recomputed from artifacts the
   producer can't forge, not trusted from a stored value.
3. **Hidden criteria (holdout)** — a withheld subset of acceptance criteria the
   producer never sees, so it can't teach to the test.
4. **A diverse review panel** — the judgment layer is a fixed, **risk-invariant**
   panel of independent single-purpose reviewers (correctness, security,
   type-design, silent-failure…) plus cross-vendor review, so gaming all of them
   costs more than satisfying them. Every reviewer runs on every task; risk moves
   the producer, never the panel (Decision 26).
5. **Determinism-first** — prefer machine-checkable facts (tests, mutation,
   coverage, SAST) over judgment; a deterministic fact can't be argued down. **TDD is the device that maximises this layer** — every behaviour gets a test-first assertion, shrinking the judgment surface (Decision 26).

### Findings are verified before they act

The five properties above guard against false _negatives_ — the producer gaming its
way to a PASS. The judgment layer needs the opposite guard too. An LLM reviewer can
raise a blocker that isn't real; with no human reading the output, the producer would
"fix" working code and **degrade the maximand**. So a reviewer's blocker reaches the
producer only after an **independent** verifier confirms it against ground truth —
evidence / `file:line` required, adversarial framing, one bounded pass. It is the
mirror of property 2: don't trust a PASS the producer claims, _and_ don't trust a FAIL
a reviewer claims; both are re-derived from ground truth. The producer may rebut a
verified finding once, adjudicated independently. (Decision 27 — the frontier default:
Anthropic, Cloudflare, Datadog.)

### The recursion bottoms out at the PRD

The spec gate is special: it is the **one gate with no machine-checkable ground
truth**. Its ground truth _is the PRD_ — it certifies that the spec is a
**faithful, complete, testable translation** of the PRD via:

- **bidirectional traceability** (every PRD requirement → ≥1 criterion; every
  criterion → traceable to PRD intent, no invented scope). Requirement extraction
  (`extractPrdRequirements`, `src/spec/gates.ts`) skips content under exclusion headings
  (`Out of Scope` / `Non-Goals` / `Not doing` / `Won't do`, case- and
  punctuation-insensitive and heading-level-aware: a same-or-higher-level heading resets
  the skip, nested subsections stay skipped) so the gate never demands the spec cover an
  explicitly out-of-scope bullet,
- **per-criterion testability** (a vague criterion is a defect — it makes the
  downstream verifier's job impossible),
- **independence + diverse max-effort judgment** for the irreducibly subjective
  rest.

The **PRD itself is the axiom** — the sole unverified input, taken on faith, the
human's one quality responsibility. The system never invents _intent_; it
faithfully translates whatever PRD it is given.

> **Parked feature:** a front-door _PRD-specifiability_ gate — a pre-run loud
> refusal when the PRD is too vague/contradictory to spec to standard (the
> fail-early twin of the loud drop). Deliberately out of current scope.

## 4. Work shape — decomposition and composition

- **Decomposition (hard rule):** every task is an **independently-shippable
  vertical slice** — standalone value, no broken/dead surface if siblings are
  absent. (Decision 23.)
- **Composition (two layers):** per-unit quality does not automatically compose
  into system quality.
    - **Continuous** — each slice is built and verified against the _current
      integrated HEAD_, never a stale base, so drift is caught as it is introduced.
    - **Final** — an authoritative **rollup full-CI gate** over the whole completed
      set before delivery, the coherence check per-task gates structurally can't
      provide.

(Decisions 12, 16, 23.)

## 5. Failure — loud, classified, partial

The autonomy constraint forces the system to self-determine when a task "cannot be
done to standard."

- **Retry before drop:** a tight **fix-forward** inner loop (verifier returns the
  specific misses, producer patches) inside a bounded **nuke-and-retry** outer loop
  that **escalates the producer** each restart (better model / max effort / more
  context — diverse attempts, not repeats), starting from the task's spec-time risk
  tier (Decision 25). **Drop = the outer bound (top rung) is exhausted.**
- **The drop is loud:** any permanently dropped task ⇒ the **run is a failure** and
  the **PRD stays open**, even if every other task passed. A red rollup gate is
  likewise a run-level failure.
- **The drop is classified:** _why_ it dropped is what makes the failure actionable
  — at least _capability/budget exhausted_, _spec defect_, _blocked/environmental_.
- **Completed work is delivered:** the dependency-closed set of passed slices ships
  as a partial result, loudly flagged. **Silence is the only forbidden outcome.**

(Decisions 19, 20, 22.)

## 6. Cost & quota — pacing, not exhaustion

Cost is the free variable (§1), bounded by **proactive pacing** against the
subscription windows — quota is **never a reason to drop work, only to pause it**
(distinct from §5's retry-budget drop).

- **Two windows, paced linearly with a 10% reserve floor:** a **5-hour** window
  (≤ 20%/hr; checkpoints at 80 / 60 / 40 / 20% remaining at hours 1–4) and a
  **7-day** window (the same shape pro-rated, ≤ 14.29%/day). The binding window
  wins.
- **5h over-pace → pause in place** (self-heals within ≤ 5h).
- **7d over-pace → graceful stop** — exit cleanly, _paused not failed_; the PRD
  stays open, completed tasks stay committed, and a human relaunch resumes from
  checkpoint.

**Execution-mode caveat.** Pacing needs an observable usage signal, which only the
orchestrated-**session** mode has. Driven as a background **Workflow**, usage can't
be monitored: no pacing, a hard stop on exhaustion, **warned at opt-in**. The
pause-not-drop guarantee survives — the stop lands on committed-task boundaries, so
a relaunch resumes (only in-flight uncommitted work is lost).

Quota is **environmental**, outside the autonomy domain (§1): a quota relaunch is
mechanical, not a quality valve, so it doesn't break the autonomy condition — it
**bounds** it. End-to-end autonomy holds within the paced quota envelope.

(Decision 24.)

## Relationship to existing Decisions

- **Refines Decision 19** — autonomy is the necessary _condition_, not the
  maximand; quality is. The no-escalation stance stands (§1, Decision 20).
- **Refines Decision 18** — the fixed reviewer tier becomes Opus, plus an effort
  dimension and the spec/producer allocation (§2, Decision 21).
- **Builds on Decisions 12 & 16** — staging integration + asymmetric rollup are the
  _mechanism_ under §4's composition principle.
- **Formalised by Decisions 26 & 27** — the two-layer verifier with a risk-invariant
  floor (§2–§3) and verify-then-fix for reviewer findings (§3).

## Open / not-yet-grilled

- _(none — the reviewer panel and TDD's structural role resolved as Decisions 26–27.)_
