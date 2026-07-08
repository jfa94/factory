# Design Review — Dark Factory Plugin (2026-07-07)

> **Status:** Comprehensive external-perspective design review, requested by the maintainer.
> Inputs: the full decision ledger (D1–D56), the runner protocol, the architecture/state docs,
> the design-intent brief, a `src/` deep-dive (359 files, ~72K LOC), the seven research
> documents, and a 2025–26 web sweep of long-running-autonomous-agent best practice
> (Anthropic harness/context/managed-agent engineering posts, LLM-reviewer reliability
> studies, mutation-guided test generation, multi-agent failure taxonomies).
>
> Maintainer constraints confirmed in-session: **subscription-only is a hard constraint**
> (no API tokens, no headless `claude -p`); operating profile is **solo, high-throughput**
> (many runs/day, several repos in parallel, minimal babysitting); **autonomy stays
> absolute** (no default human checkpoint); the #1 operational pain is **stalls needing
> rescue**.

---

## 1. Verdict

**The architecture is fundamentally right. No ground-up redesign is warranted.** The
Model-A split (deterministic engine owns all control flow; the LLM session is a dumb
spawn-and-collect loop), derive-don't-store, fail-closed everywhere, the verification
stack, and the decision-ledger discipline put this system ahead of nearly everything the
research corpus describes. Independent evidence converges on the same conclusion: the
`src/` deep-dive called the engineering discipline "unusually strong and consistent," and
the design matches Anthropic's managed-agents pattern (stateless harness + persistent
event log) almost exactly — arrived at independently.

**The real gap is singular: the quality architecture is complete, but the autonomy
architecture is not.** Every quality question ("is this code correct?") has a
deterministic, layered, anti-gameable answer. But almost every _failure_ path still
terminates in a human: quota parks wait for a human `/factory:resume`; state↔GitHub
drift waits for a consent-gated rescue; a dead runner session waits for a human to
notice. For a solo, high-throughput, autonomy-absolute profile, this is THE design debt —
and it is exactly the pain you named. The system was built quality-first (correctly), and
the autonomy half of the north star was deferred; the deferral is now the binding
constraint.

The proposal below is one focused program — **Close the Loop** — five workstreams that
convert stall classes into self-healing paths, plus a ranked list of secondary findings.
Nothing in it weakens a gate.

---

## 2. What is right — keep, and do not relitigate

Worth stating plainly, because most of these were contested decisions at some point and
the evidence now validates them:

| Design decision                                                                                                                                                                                       | External validation                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic engine owns ALL control flow; LLM only produces and judges (D28/D42)                                                                                                                    | Anthropic managed-agents: stateless replaceable harness + durable session log. The 20K-session misalignment study shows agent drift is systematic — control flow in an LLM is a liability, and you removed it.                                                                                                                                                 |
| Verification stacking: 8 contracted gates incl. mutation + TDD commit-order + holdout criteria + fresh-context 4-lens panel + citation-verify + independent finding-verifier + PRD-traceability audit | "The bottleneck has shifted from generation to verification" is the consensus 2025–26 finding. Mutation testing is the one gate that catches vacuous AI tests (coverage cannot); holdout + cross-vendor are the anti-overfit/anti-echo-chamber pair the literature prescribes. The moat is knowing the code is correct — the investment is in the right place. |
| Citation-verification filter + claim-only adversarial verify (D27)                                                                                                                                    | RepoAudit/IRIS research: the _validator layer_ is why hybrid reviewers reach ~78% precision vs. near-random raw LLM judgment. Your verify-then-fix is exactly that validator.                                                                                                                                                                                  |
| Panel consolidation 7→4, conditional specialist (D43/D51)                                                                                                                                             | MAST taxonomy (1,600+ traces): more agent roles ≠ better; add roles only for genuinely new signal. The content-conditional DB reviewer is the right template for future dimensions.                                                                                                                                                                            |
| Derive-don't-store with branded verdicts; two sanctioned event exceptions                                                                                                                             | Structurally nothing in state to forge — stronger than anything in the reviewed literature.                                                                                                                                                                                                                                                                    |
| Quota inserts only delay, never quality reduction (D24); escalation ladder must change a variable (D25)                                                                                               | Matches the "no fast path" doctrine and the retry-ladder research (blind re-rolls waste quota; classified, variable-changing rungs don't).                                                                                                                                                                                                                     |
| Per-run staging + app-level serial merge writer + idempotent PR create                                                                                                                                | Closes the race classes the design-intent brief identified (Δ L/M); the serial writer's MERGED short-circuit is the correct crash-window guard.                                                                                                                                                                                                                |
| Loud classified drop; no silent degradation anywhere                                                                                                                                                  | Yuan et al.: 92% of catastrophic failures stem from mishandled non-fatal errors. The codebase's 11-throw orchestrator and contracted-but-unrunnable→FAIL gate rule embody the lesson.                                                                                                                                                                          |

Also verified during this review: the **D8 dirty-worktree re-drive defect is fixed** —
`ensureOnStaging` now does `resetHardClean` (`src/git/worktree.ts:143`); the 2026-07-06
investigation note is stale.

---

## 3. The central finding: the autonomy gap, decomposed

"Stalls needing rescue" is not one problem. It is five, each with a different root cause
and a different fix. Ranked by how often they will bite at high throughput:

### 3a. State↔GitHub drift is guarded against crashes but never reconciled

`rescue scan` is explicitly run-state-only (`src/rescue/scan.ts:25-29`): a
merged-but-unrecorded PR, an auto-armed rollup that later landed (`rollup.ts` returns
`merged:false, auto-armed` and nothing ever re-checks), a stale `pr_number` retained
across a rescue reset, an orphan branch — all invisible. The `src/` deep-dive ranked this
the #1 structural risk: the idempotency guards (list-first PR create, MERGED
short-circuit) only help _if the same task is re-driven_, but rescue may **reset** a task
whose work already shipped, re-doing (or colliding with) merged work.

The philosophical inversion: **the project's own doctrine is facts→script,
judgment→agent — and "is PR #N merged?" is a fact.** Today it is answered by a
consent-gated LLM agent (`rescue-reconciler`). That is the doctrine violated at the exact
spot where the #1 pain lives.

### 3b. Quota parks require a human, by explicit v1 scoping

`src/quota/resume.ts` header: _"v1 = HUMAN relaunch only; this file deliberately contains
NO scheduler / scheduled-wake (v2 — a v2 wake would fire the SAME planResume)."_ The
design-intent brief (§6, Δ F) decided suspend + scheduled auto-resume at
`resets_at_epoch` back in June — it was designed, never built. Consequence: every 5h/7d
window event on an overnight run converts into a human touch, directly against the
touch-metric-1.0 north star. At "many runs/day" throughput, quota parks are not an edge
case — they are the _expected_ state of several runs at any moment.

### 3c. A dead runner session leaves a `running` run silently frozen

The state file says `running`; nothing drives it; nothing notices. The stateless-harness
property (any new session can resume from state — genuinely well built) is only half of
Anthropic's managed-agent pattern. The other half is the `wake(sessionId)` — something
that _notices_ the harness died and restarts it. There is no watchdog. Recovery latency
is "whenever the human looks."

### 3d. Post-compaction protocol drift in the runner

The one LLM with a long-lived context is the runner session, executing a 445-line
protocol over hours. The known-gaps section of CLAUDE.md itself records that the
SessionStart re-injection hook (Iron Laws after compaction) **was not ported to TS**.
Additionally the runner still hand-assembles prompts in three places — producer prompts
(from `ProducerContext` + `prompt_ref`), the codex `exec` cross-vendor command, and the
finding-verifier spawn (SKILL.md:414: _"runner-chosen type not carried by an envelope"_).
Every hand-built prompt is pipeline logic living in the fragile layer, and every one is a
compaction-drift liability. This contradicts the D52 doctrine that envelopes carry
everything.

### 3e. Safe repairs are consent-gated; self-heal is bounded to ONE cycle

The rescue machinery already classifies repairs into forward-only (fetch, FF-merge,
re-push a missing branch) vs. destructive (force, delete, un-ship) — but even the
forward-only class waits for human approval, and `factory rescue auto` requires
`self_heal.attempts === 0` (D48), so a run gets exactly one autonomous repair _ever_.
The consent gate conflates "human must approve" with "must be safe"; the safety
classification already exists and is not being used to route autonomy.

---

## 4. Proposal: the Close-the-Loop program

Five workstreams. None weakens a gate; all are bounded and ledgered. Together they
convert the five stall classes into self-healing paths with loud audit trails.

### P1 — Deterministic GitHub reconciliation in the engine ⟶ kills 3a

Build `factory reconcile` as an engine capability (not an agent):

- **Facts gathered via the existing single I/O seam** (`gh-client.ts`): PR state by head
  branch, merged-SHA vs. recorded state, staging-branch existence/tip, rollup PR state.
- **Forward-only adoptions applied automatically under the state lock**: record a
  merged-but-unrecorded PR as `done`; detect a landed auto-armed rollup and route to the
  finalize resume-guard; re-push a missing branch; refresh a stale `pr_number` before any
  rescue reset is allowed to touch that task.
- **Invoked automatically**, not as a new human verb: (i) by `next-task` when a task
  wedges in `shipping`, (ii) at every resume, (iii) by `rescue scan` — scan finally gains
  GitHub truth, closing its self-documented blind spot.
- **Destructive divergence still surfaces** (never auto-force, never auto-delete,
  never un-ship) — same taxonomy as today, but the taxonomy now routes autonomy instead
  of prose.

**Nuke candidate:** once deterministic reconcile covers the observed drift classes, the
`rescue-reconciler` LLM agent shrinks to the genuinely-ambiguous residue — and should be
deleted if that residue turns out to be empty. Keep `rescue-diagnostic` (dead-end
diagnosis is genuine judgment).

This is the largest new engine surface since D42, but it is localized: one new module
behind `gh-client.ts`, consumed at three existing call sites.

### P2 — Scheduled wake / auto-resume ⟶ kills 3b, halves 3c

> **Superseded — DROPPED, replaced by the in-session 5h quota wait (Decision 62,
> v1.33.0).** The two-layer sentinel below (park-armed wake + heartbeat) was built as the
> Session 6 spike, judged "way too janky and unnecessarily complex", and reverted whole.
> The replacement restores the pre-D42 behavior as a runner-protocol change only: a
> `scope "5h"` pause WAITs in-session (TaskStop agents, end the turn) and the existing
> `CronCreate` heartbeat re-drives REFILL, with `factory next-task` self-clearing
> `paused`→`running` on a fresh proceed. This covers a _live_ session; a **dead** session
> (the "watchdog for 3c" role below) still needs a human `/factory:resume` — that gap is
> the accepted price of dropping the sentinel. `7d`/`unavailable` still STOP.

Build the v2 the code already names. Two layers:

1. **Park-armed wake**: whenever the engine parks a run (quota suspend, docs suspend,
   5h pause), the runner arms a scheduled Claude Code task at `resets_at_epoch` (or a
   TTL) whose sole job is to open a session in the target repo and run
   `/factory:resume`. Subscription-native, no API. The promptless clean-park resume path
   already exists (D50) — this just fires it on a clock instead of a human.
2. **Sentinel heartbeat**: a recurring scheduled session (every 30–60 min while any run
   is non-terminal) that runs resume-if-parked + `factory reconcile`. This is the
   watchdog for 3c: a dead session's run gets picked up within one heartbeat rather than
   whenever the human looks. It also refreshes the statusline usage cache that quota
   decisions depend on.

Ledger semantics: an auto-resume **must not** append to `human_touches` (it is not a
human — same rule as `rescue auto`, D49). The touch metric keeps meaning.

Open dependency: verify scheduled-session support on your setup (Claude Code scheduled
tasks / cron sessions on Max). If absent, the fallback is a `launchd` timer opening a
Claude Code session — spike this first; it determines P2's shape.

### P3 — Autonomous forward-only repair: raise the self-heal bound ⟶ kills 3e

Route autonomy by the **safety class**, not by who approves:

- Forward-only repairs (the existing reconciler taxonomy: fetch, FF, re-push, adopt
  merged PR, plus scan's `resettable` set when the dependency closure is clean) become
  autonomous with a per-run budget — `self_heal.attempts < 3` instead of `=== 0` — each
  cycle ledgered and metrics-visible, still inside the run-level circuit breaker.
- Destructive repairs (force, delete, un-ship, dead-end resets) stay consent-gated
  exactly as today.

D48's rationale ("bounded so a broken repair can't loop") is preserved by the budget +
breaker; only the bound moves. With autonomy-absolute as the stated condition, one
self-heal per run is not a bound, it is a disable-after-first-use.

### P4 — Runner hardening ⟶ kills 3d

1. **Port the SessionStart/compaction re-injection hook** (the acknowledged known gap):
   after compaction, re-inject the Iron Laws + a pointer to the runner protocol. The TS
   hook dispatcher and `hooks.json` wiring already exist; this is the cheapest
   stall-reducer in the whole program.
2. **Move all three remaining hand-assembled prompts into engine envelopes**: producer
   prompt composition, the codex `exec` command line, and the finding-verifier spawn
   (prompt + agent type + model). The envelope contract (D52) already carries everything
   for other spawns; finishing the job makes the runner literally
   spawn-verbatim/collect — zero pipeline logic left to drift.
3. **Engine-side stall TTL**: `next-task` flags an in-flight task whose
   `spawn_in_flight` is older than a TTL with no recorded results, and instructs the
   runner to re-drive it (the idempotent re-spawn machinery already exists; today it
   waits for the runner to _notice_ a dead agent).

### P5 — Outer-loop telemetry: the defect-escape ledger

The system has rich _inner_-loop telemetry (metrics.jsonl, touch metric, score) but no
measure of the only thing that ultimately matters: **does bad code escape?** Without it,
decisions like D43's panel consolidation, the folded quality-reviewer charter, and the
autonomy-absolute stance are unfalsifiable — and "data should decide" questions can never
be decided.

- A lightweight capture verb — `factory escape --run <id> --task <id> --note …` — or a
  PRD-issue label convention, recording "a human later fixed factory-shipped code."
  `factory score` reports escapes/run and escapes/reviewer-lens.
- Make the D43-style reviewer-value analysis repeatable from `metrics.jsonl` (confirmed-
  blocker yield per lens, send-back rates), so panel composition stays evidence-driven.

The research prescription is exact: track agent-authored acceptance/revert/incident rates
_separately_ from human changes. This is the factory's version of that.

---

## 5. Secondary findings (ranked)

**S1 — Holdout verdict store is task-keyed, not rung-keyed** (`handlers.ts:385`,
self-documented). A stale prior-rung holdout verdict can survive an escalation bump — a
real hole in the anti-gaming mechanism. Fix: key by `(task, rung)`. Small.

**S2 — Local gate vs. CI render can diverge.** `GateRunner` and `render-quality-gate.ts`
are two independent consumers of the gate contract; drift lets local-green ≠ CI-green.
Fix: a cross-check test asserting the rendered workflow enumerates exactly the gates the
runner would enforce for the same contract. Small.

**S3 — `gates.json` silent narrowing.** A human dropping a gate from the contract
silently narrows the merge gate (TCB protects against the _agent_, not the operator).
Fix: run report + `run create` output enumerate "gates in force," warning when a
default-set gate is absent. Small.

**S4 — TCB gap for custom `e2e.testDir`** (`tcb.ts:218`, known limitation). The deny
rule cannot read config (that circularity is the whole point of the hardcoded list). The
non-circular fix: `run create` preflight **refuses an autonomous `--e2e` run whose
resolved testDir is nonstandard** — fail-closed, deterministic, no config trust. Small.

**S5 — Citation-verify ±2-line window** can drop a true blocker whose cited line moved.
Consider a content-anchored fallback (match the quoted snippet anywhere in the cited
file before dropping). Low priority — a false _drop_ here is caught by nothing, but the
panel is unanimous-approve so other lenses usually still catch the defect.

**S6 — Cross-vendor: flip it on for yourself.** `review.requireCrossVendor` default-warn
is right for the plugin's general users, but you have Codex: multi-vendor review is the
strongest anti-echo-chamber measure in the literature. Flip to `block` in your own
config; consider routing Codex to the spec gate too (design-intent §8 named it the
highest-leverage cross-vendor site, and it never got one).

**S7 — Legacy global `runs/current` pointer.** At multi-repo throughput a stale global
pointer is a footgun; the per-repo pointers exist. Migrate the remaining no-cwd
consumers (statusline, `hook-context.loadActiveRun`) to per-repo resolution and delete
the global pointer. Small nuke.

**S8 — E2E default.** Browser verification is among the strongest "check the agent can
run" signals for web apps, and today it is opt-in. Consider content-conditional
default-on (repo has a committed Playwright config) — but only **after** P1–P3 land,
because the e2e phase is itself a stall surface (assessment parks, adjudication legs)
and the stall program should win first.

---

## 6. Considered and rejected

- **API/SDK-driven runner rearchitecture.** Rejected on the hard subscription
  constraint — and on merit: the coroutine seam already minimizes what the LLM loop
  does. The correct direction is shrinking the runner's judgment surface to zero (P4),
  not replacing the loop.
- **Default human spec checkpoint.** You ruled autonomy absolute; the alternative is
  P5's escape ledger, which makes the spec layer's leak rate measurable so the decision
  stays evidence-based rather than faith-based.
- **Adding reviewer roles** (from the reliability-review research checklists). The
  systemic-failure-reviewer already carries the stuck-state/invariant-without-repair
  charter; MAST + your own D43 telemetry argue against widening the panel. If a new
  dimension ever proves out (via P5 data), the D51 conditional-specialist pattern is the
  template.
- **OS-level sandbox for containment.** Already explored and deferred
  (executor-confinement proposal) under the emergent-gaming threat model; the tripwire
  hooks + system-level independent-catcher design is a reasoned trade. Revisit only if
  the threat model hardens — nothing in this review changes that.
- **Mutation-guided test _generation_** (Meta ACH pattern — generate mutants, have the
  test-writer kill them). Genuinely promising as a future test-writer upgrade, but it
  adds producer complexity while the stall program is the binding constraint. Park it.

---

## 7. Sequencing

> **Superseded by [close-the-loop-sessions.md](./close-the-loop-sessions.md)** (2026-07-07,
> same day): the program is now grouped into seven independently-runnable sessions, and
> amended with the **run-create incident** (PRD #288) — a stall class this review missed:
> non-atomic run creation (`create()` + separate task-seed write, with `pointCurrentAt`
> throwing between them on an unparseable schema-v2 pointer target) plus vacuous
> empty-set passes in `next-task` and `rescue scan`. See the incident addendum there.

| Phase    | Work                                                                                        | Why this order                                                                       |
| -------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1 (days) | P4.1 compaction hook port · S1 holdout rung-keying · S2 CI cross-check · P3 self-heal bound | Highest value-per-effort; all engine-local; no new external dependencies.            |
| 2        | P1 deterministic reconcile                                                                  | The big one; kills the #1 stall class; prerequisite for making P2's sentinel useful. |
| 3        | P2 scheduled wake + sentinel (spike harness capability first)                               | Depends on P1 (a wake that resumes into unreconciled drift just re-parks).           |
| 4        | P4.2 envelope-carried prompts · P4.3 stall TTL · P5 escape ledger                           | Hardening + instrumentation once the loop is closed.                                 |
| 5        | S3, S4, S6, S7 opportunistically; S8 (e2e default) last                                     | Small; none blocks the program.                                                      |

---

## 8. Unresolved questions (maintainer-owned)

1. **Scheduled-session capability**: does your Claude Code setup support scheduled/cron
   sessions on the Max plan? (Determines P2's shape; the fallback is a `launchd` timer
   opening a session.)
2. **Ledger semantics**: confirm auto-resume/reconcile never count as `human_touches`
   (recommended: they don't — matches D49's `rescue auto` precedent).
3. **Escape capture**: is a manual `factory escape` verb enough, or should `score` also
   scan `develop..main` for fix-commits touching factory-shipped lines?
4. **Self-heal budget**: is 3 cycles/run the right bound, or should it scale with task
   count like the circuit breaker (D45)?
5. **Cross-vendor block**: flip `requireCrossVendor` to block in your own config now, or
   after P1 lands (a Codex outage under `block` is itself a stall source)?
