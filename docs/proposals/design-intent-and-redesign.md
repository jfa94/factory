# Design Intent & Redesign Brief

> **Status:** Pre-plan design brief. Captures the _verified design intent_ extracted in the
> grill-me session of 2026-06-02, the gaps between that intent and the current code, and the
> proposed execution-modes redesign. This is **not** an implementation plan — it is the reference
> we turn _into_ a plan. Where it states "current code does X", that was verified against the
> source during the session (file:line cited). Where it states "intent is Y", that is a decision
> the maintainer (Javier) confirmed.
>
> **North-star reminder:** the ultimate goal of this project is to **maximise code quality**.
> Every decision below is subordinate to that.

---

## 0. How to read this document

- **§1–§9** are the _design intent_ — what the system is supposed to be, branch by branch of the
  design tree, in grill order (later answers — e.g. Q10's partial call-out — fold into the relevant
  section). Each is a settled decision.
- **§10** is the _execution-modes redesign_ — the one genuinely new piece of design work, reviewed
  against three adversarial critics.
- **§11** is the _delta ledger_ — intent vs. current code, the actionable changes.
- **§12** lists _ADR candidates_ (decisions worth a formal record before implementation).
- **§13** lists _open questions_ still owned by the maintainer.
- **Appendix A** is canonical terminology (to be synced into `docs/glossary.md`).

---

## 1. North star — who this is for, and what "done" means (Q1)

**Decision.** Full lights-out autonomy is the **permanent end-state**, not a transitional mode.
Every human touchpoint currently in the system (`humanReviewLevel` 0–4, `NEEDS_DISCUSSION`,
`needs_human_review`, the first-quota-failure `AskUserQuestion`, the `/factory:rescue` approval
flow) is **scaffolding to be retired** as reliability improves — not permanent product surface.

**Target user.** A **solo developer** handing implementation off to a coding agent that runs
**unattended** (e.g. overnight). Not a team wanting governed, dial-in human gates. This pulls every
design choice toward "resolve it yourself" over "ask a human".

**Consequence.** Because no human reviews anything before it lands, **the gate stack is the entire
trust boundary**. This makes §4 (threat model) and §5 (gate ownership) load-bearing.

---

## 2. Domain boundary & branch topology (Q2–Q3)

**Decision — the factory's domain is `PRD → develop`, fully autonomous.**

Verified branch topology (corrected against `templates/.github/workflows/quality-gate.yml`):

```
Base state:     repo has  main  +  develop                 (pre-existing)
Pipeline:       creates  staging  if absent
Per task:       task PR  --base staging   →  squash-merge   (clean commit per task)
                gated by per-task CI (quality + mutation-testing + security)
Rollup:         staging PR  --base develop  →  merge-commit  (true merge)
                gated by ONE full CI run over the integrated diff
Both merges:    auto-merge on green CI, ZERO human approval
main:           NEVER touched by the factory
develop → main: human release decision, entirely out of scope
```

The squash-vs-merge-commit distinction _is_ the intended difference between the two levels:
task→staging squashes (one commit per task); staging→develop preserves a merge commit (the run as
a unit). `main` is sacred.

**Doc reconciliation done in-session:** `docs/explanation/decisions.md` Decision 19 (lines 347, 357) previously claimed "humans own staging → develop/main promotion" — contradicted by Decision 16
and by the template's auto-merge job. Both lines were rewritten to: domain ends at the _auto-merged_
rollup into `develop`; human control begins only at `develop → main`.

---

## 3. Threat model — system-level gaming-resistance (Q4)

**The honest-vs-adversarial binary was the wrong frame.** Evidence (Anthropic reward-hacking
measurements ~13–18% on hack-available coding tasks; specification-gaming generalises _within a
trajectory_ from weak shortcuts to active test/criteria tampering) makes the real failure mode
**emergent specification gaming**: a non-malicious agent taking a gate-shortcut under optimization
pressure, then escalating.

**Decision — defend at the _system_ level, not the _gate_ level.** Let each individual gate stay
simple and individually gameable. Choose the _gate set_ so the cheap way to beat gate A is caught
by an **independent** gate B, and no single shortcut defeats the conjunction. The power is
independence (different model, different vendor, different environment, different signal).

| Cheap shortcut                                      | Independent catcher                                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Vacuous / assertion-free RED tests                  | **Mutation testing** — surviving mutants expose weak tests (coverage can't)                                                       |
| Overfit to the visible tests                        | **Holdout criteria** the executor never saw                                                                                       |
| Plausible-but-wrong rationalization                 | **Adversarial review**, zero impl context, **all-opus**; cross-vendor _opportunistic, not guaranteed_ — reduced, not closed (Q11) |
| `sys.exit(0)` / harness escape / deleted assertions | **Deterministic gates + reviewer reading the diff + CI re-running independently**                                                 |

**Corollary (drives §5):** the guarantee rests on the backstops being genuinely _independent_ and
_always-on_. Two implications were verified:

- Mutation testing **is** always-on (runs per task locally _and_ in CI — see §5), so the
  vacuous-test shortcut has a catcher at task time. Good.
- An over-zealous gate is _also_ a failure here: in an unattended system a false-positive has no
  human to clear it, so it converts directly into a stalled run — damaging the autonomy that is the
  point. Robustness comes from independence, not from making any one gate adversarial-proof.

---

## 4. Trust boundary & ownership (Q5)

**Decision A — the factory must own its own merge gate.** Under the gaming model, the trustworthy
anti-gaming authority is **CI running in a clean GitHub runner the agent cannot touch** — _not_ the
local pre-gate (which runs in the executor's reach). But the factory currently makes CI the merge
gate **without configuring or verifying it**: branch protection + required checks + auto-merge are
listed as _user preconditions_ (`getting-started.md:101-102`, `configuration.md:52`), and nothing
calls `gh api` to set required-status-checks. So the trustworthy gate is only real if the user
configured GitHub correctly beforehand.
→ **Intent:** at scaffold time the factory **configures (or at minimum hard-verifies) branch
protection + required checks**, and **refuses to run autonomously if they are missing.** The
guarantee must not silently depend on user GitHub setup.

**Decision B — the gate machinery is the Trusted Computing Base (TCB), immutable to the executor.**
Files that define the quality bar (`.stryker.config.json` thresholds, `quality-gate.yml`, coverage
thresholds, the `bin/pipeline-*` machinery) must be **off-limits to the executing agent** — owned by
the plugin and the maintainer only, protected the way `main` and `.claude/` already are. An executor
that can edit its own gates can game them trivially. _(Standing project constraint: the executor
must not modify the machinery; that is reserved for the factory-plugin repo.)_

---

## 5. Delivery & failure model (Q6)

**Decision — partial-rollup is the DEFAULT autonomous graceful exit** (today it is the
`FACTORY_ALLOW_PARTIAL_ROLLUP=1` escape hatch; default `0` is all-or-nothing). When a task fails
permanently after the recovery ladder is exhausted: **roll up the completed, dependency-closed set
to `develop`, mark the run `partial`, report the failure loudly, end on a terminal code**, and hand
the failed task to a future `/factory:rescue`.

**Why partial-to-develop is safe (not a quality compromise):**

1. **Quality bar unchanged** — every rolled-up task still passed all gates + review. Partial ships
   _fewer_ tasks, never _lower-quality_ ones. You trade completeness for autonomy, not quality.
2. **The DAG makes the done-set automatically dependency-closed** — a task can't be `done` unless
   its deps were `done` (preflight fails closed on unsatisfied deps). So "incremental" (option b)
   _is_ "dependency-aware" (option c) for free; a failed task's dependents simply never start.
3. **`develop → main` is human-gated** — partial work landing on `develop` is never auto-released.
   The human sees "run partial, task 7 failed: …" at the `develop → main` boundary and decides.

**Decision — a bounded, _diverse_, _classified_ retry ladder sits ABOVE in-task recovery.** Blind
"nuke and start again" is an autonomy anti-pattern: great on a stochastic/poisoned trajectory,
useless and quota-draining on a deterministic/spec failure. So:

- **Classify the failure first** (cheap check: did the same gate fail the same way?). Deterministic
  / spec-incoherent / integration failures **do not** get re-executed — jump straight to graceful
  exit. Re-decomposition is a spec problem, left to rescue/future capability, **not** done inline
  (never mutate the live DAG).
- **Each rung must change a variable, not re-roll identically:**
    - **Rung 1** — nuke branch + worktree, same model tier, fresh context. Kills flakiness / poisoned
      trajectory.
    - **Rung 2** — nuke, **escalate the model** (e.g. sonnet→opus) **+ inject the prior failure as
      explicit "don't do this" context.** Kills capability + repeated-mistake.
    - **Cap = 2 extra attempts.** Then graceful partial exit.
- **Nuke leaves no orphan** — squash-merge means a task is all-merged or not-merged; an unmerged
  failed branch nukes cleanly. Persist spec + failure classification + attempts tried so rescue
  resumes without repeating dead ends.

**Partial-safety basis (Q10) — safety lives in the rollup gate, not in slice shape.** The original
reasoning ("the DAG makes the done-set dependency-closed, so partial is safe") is **insufficient**:
dependency-closure protects against shipping a task whose _dependencies_ failed, but does nothing
about shipping tasks whose _dependent_ failed. In a horizontal decomposition the integration/wiring
task is the **leaf** (depends on everything); when it fails, the un-wired layers below it have
already shipped. So verticality — a **single, non-independent judgment** (spec-reviewer dimension 5)
— was silently carrying 100% of partial-safety, exactly the single-point-of-failure Q4 forbids.

**Resolution:** take _safety_ off verticality. The load-bearing guarantee is the **rollup full-CI
gate** (`staging→develop`, the "one full final run"): broken or incoherent integrated code fails it
and never reaches `develop`, _regardless of slice shape_ (aligns with Q3 "CI is the trustworthy
authority" + Q4 independence + deterministic-first). Verticality **demotes from a safety property to
a value property** (fewer dead, half-wired partials) and stays as the spec-reviewer's dimension-5
nudge.

**The honest gap + its call-out (Q10).** Rollup CI catches _broken_ code, not _dead-but-not-broken_
code (an endpoint nothing calls yet, if the e2e test that would catch it lived in the failed task).
This is **tolerated** behind the human `develop→main` gate — but it must be **explicitly enumerated**,
never silent:

1. **Partial-run report** (deterministic `bin/`, from `state.json` + the DAG): which task(s) failed,
   the failure class, and the failed task's **unmet acceptance criteria** — exactly what is missing.
2. **Dead-surface scan at rollup** — a deterministic unreferenced-export check (knip / ts-prune)
   scoped to the run's diff, **report-only** (a hard block would false-positive on legit public API /
   next-run scaffolding and stall autonomy). It _enumerates_ the dead code rather than leaving it
   invisible.
3. **Durable surfaces:** a GitHub issue per failed task (also the rescue anchor — not a new
   artifact) + a `PARTIAL: task N failed` header on the `staging→develop` rollup merge commit + the
   run summary. The factory still ships and exits with **zero human gate**; the partial status and
   precise dead surface are impossible to miss at the human-owned `develop→main` boundary.

**Bug to fix:** on an incomplete run, finalize currently returns `wait_retry` (exit 3) and **spins
forever** waiting for a state that will never arrive (`bin/pipeline-run-task-stages.sh:1716-1743`).
Under either intent this is wrong — it must **fail cleanly on a terminal code** and partial-roll-up.

---

## 6. Resource model — quota is orthogonal to quality (Q7)

**Decision — quota only ever inserts _delay_.** It never abandons a task, never partial-ships, never
retries-less, never trades quality. Time is the only thing it sacrifices ("there is no fast path",
applied to resources). Three **distinct** states (the current code wrongly reuses `partial` for both
quality-failure and quota-exhaustion — a latent bug):

| Axis                   | Trigger                           | Response                                                                               | Terminal? |
| ---------------------- | --------------------------------- | -------------------------------------------------------------------------------------- | --------- |
| **Quality** (per task) | retry ladder exhausted            | **partial** — ship dependency-closed done-set to `develop`, hand failed task to rescue | yes       |
| **Quota** (per run)    | 5h burst over threshold           | **paused** — wait for the rising threshold curve / reset, auto-resume                  | no        |
| **Quota** (per run)    | 7d budget / can't wait in-session | **suspended** — persist + exit, scheduled auto-resume, completes every task            | no        |

**Decision — long waits use suspend + scheduled auto-resume, not in-session sleep.** The system
already knows `resets_at_epoch`. When a wait would exceed a threshold, **persist state, exit, and
schedule a wake-up at the exact reset to fire `/factory:resume`** — zero human, robust against
session/machine death, holds nothing hostage. This **replaces** today's 75-minute cumulative-pause
**human gate** (which contradicts both "pause until reset" and the no-human-valve north star — a
full 5h wait would trip it ~4×) and the held in-session sleep.

---

## 7. Quality-allocation dials — two orthogonal deterministic axes + judgment (Q8)

> **Superseded by Decisions 25–26 (2026-06-04 first-principles pass).** The two-axis
> split below is **collapsed**. Risk no longer sizes _review depth_ — the verifier
> floor is now **risk-invariant** (every reviewer runs on every task; Decision 26).
> _Complexity_ folds into a **single unified producer dial**: one spec-time judgment of
> how much model strength a task warrants, blending difficulty and stakes (Decision 25),
> and "risk tier" now names _that_ dial. The judgment-with-a-deterministic-floor
> _mechanism_ described below still stands; only its two-into-one consolidation changed.

Two distinct classifiers exist and are correctly orthogonal:

| Classifier               | Input                      | Determines                 | Tiers                                                                                                           |
| ------------------------ | -------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pipeline-classify-risk` | task's **file paths**      | **review depth**           | routine (2 rounds) · feature (4 + arch) · security (6 + security + arch); escalate-only, fail-closed → security |
| `pipeline-classify-task` | **file count + dep count** | **executor model + turns** | simple→haiku/40 · medium→sonnet/60 · complex→opus/80                                                            |
| `pipeline-model-router`  | **quota**                  | proceed / wait / end       | _no model downgrade exists_ (misnamed — routes quota only)                                                      |

**Decision — complexity is judgment, and should be judged, with a deterministic floor.** Count
(`max(file_count, dep_count)`) is a poor — sometimes _backwards_ — proxy: a 1-file, 0-dep task can
be algorithmically brutal (concurrency fix, tricky parser) → classified `simple` → **haiku**, while
3 files of boilerplate → `complex` → **opus**. For a maximise-quality system that is the dangerous
direction (hardest work → weakest model). It also violates the system's own "facts→script,
judgment→agent" rule: a path either matches `auth/` or it doesn't (a fact, correctly scripted), but
_difficulty_ is judgment. → **Intent:** the **spec-generator judges complexity** (it understands
each task), with a **deterministic floor** so judgment can only **raise** the model, never lower it
below the count-based tier. _(This contradicts Q6's "never trade quality for resources" only if
judgment is allowed to under-power; the floor prevents that.)_

**Decision — risk gets the same treatment.** Risk-by-path has the identical coarse-proxy blind spot
(payment logic in `lib/billing.ts` doesn't match `payment/` → under-reviewed as `routine`).
Judgment may **raise** the risk tier above the path-based floor; the path classifier remains the
fail-closed minimum.

---

## 8. Spec review is the most-scrutinised gate (Q9)

> **Refined by Decisions 21 & 26 (2026-06-04).** The "most-scrutinised gate" thesis
> stands and strengthens — but spec review is **unconditionally max** (Opus / Max, full
> depth), _not_ "scaled to the maximum risk tier across tasks." The risk-invariant-floor
> principle (Decision 26) applies to the spec gate too: its depth does not vary with risk.

**Decision — the spec review is _the_ highest-scrutiny gate in the entire pipeline**, scaled to the
**maximum risk tier across the spec's tasks** (a spec containing any security-tier task is reviewed
at security depth). Rationale: a flawed spec poisons every downstream task; partial-rollup safety
(§5) now depends on slice quality; this is the cheapest place to catch the most expensive errors.

**Verified inconsistency to fix:** the two spec-reviewer definitions disagree on the pass threshold
— `skills/pipeline-orchestrator/prompts/spec-reviewer.md` uses **54/60**, `agents/spec-reviewer.md`
uses **56/60**. Pick one (the higher, given "most-scrutinised") and make both agree; keep the
"any dimension ≤5 → auto NEEDS_REVISION" floor. Spec-reviewer is `opus`, independent of the
generator (Iron Law: review independence).

**Decision — adopt specific agents + one pattern from `comprehensive-code-review` later** (recorded
in memory `ccr-agent-integration`). Net-new correctness classes no current factory gate covers:

- **`silent-failure-hunter`** — empty catches / swallowed errors / silently-degrading fallbacks
  (enforces the standing "never silently degrade" rule; SAST catches syntax, not semantic
  degradation).
- **`type-design-reviewer`** — weak type design (stringly-typed where branded invariants belong;
  representable invalid states). `tsc` catches type _errors_, never type _design_. High leverage in
  a TS stack.
- **Highest-leverage borrow is a _pattern_, not an agent:** the deterministic **citation-verification
  filter** — drop any reviewer finding whose verbatim quote doesn't substring-match real code at
  `file:line ± 2`. Pure deterministic-first anti-hallucination over agent output; apply to the
  escalated spec-review gate and all code reviewers. Implement as a `bin/pipeline-*` script so it is
  un-bypassable.
- **Consider w/ caveat:** `simplification-reviewer`, gated to high-severity only (autonomous loop →
  churn risk). **Skip:** `test-coverage-reviewer` (mutation already covers assertion strength),
  `comment-accuracy-reviewer`, `documentation-reviewer` (Scribe already runs).

**Reviewer independence & model policy (Q11).** "Independence" in the code is **context/role
independence** (producer ≠ critic; reviewers run in fresh worktrees seeing only diff + spec, never the
executor's reasoning) — **not vendor independence**. Every reviewer is Claude; the cross-vendor
reviewer (Codex) is optional and today **degrades silently** to all-Claude. Decisions:

- **All reviewers run on the strongest model (opus)** — including the net-new `silent-failure-hunter`
  / `type-design-reviewer`. The only actual change is `quality-reviewer` (sonnet → opus): the _most_
  adversarial role currently sat on the _weakest_ model. Lost sonnet/opus tier-diversity is
  negligible — fresh context already breaks self-rationalization, and same-vendor tiers share blind
  spots regardless. Independence comes from **role diversity + context isolation**, not tier-mixing.
  (Cost/latency is not an objection — Q7: pause, never under-power.)
- **Cross-vendor review is opportunistic, never required** (the plugin must work for users without a
  second subscription). So it becomes a **pluggable slot** (Codex if present, else any configured
  alternative, else the same-vendor floor), and **its absence is LOUD** — the run records "review
  independence: same-vendor only" instead of silently falling back.
- **When a second vendor IS present, route it to the highest-leverage gates first** — the **spec
  gate** (most-scrutinised per Q9, currently with _zero_ cross-vendor option) and **security-tier**
  tasks.
- **Honest threat-model downgrade:** cross-vendor drops from "_the_ catcher" for plausible-but-wrong
  rationalization to an _opportunistic strengthener_. The floor catcher is fresh-context,
  role-diverse, **all-opus** same-vendor review — which **mitigates, does not close**, shared-vendor
  blind spots.

---

## 9. Execution-modes redesign (the new design work)

The maintainer wants to offer **three ways to complete work**: (1) a **Workflow** (Claude Code's
new primitive) — fastest; (2) **sub-agent-driven** — balanced speed/tokens; (3) **sequential** —
slowest, quota-safe. Required properties: **no race conditions**, **not wasteful with testing**,
**elegant**. The recommendation below was stress-tested against three adversarial critics (race,
test-waste, elegance — all returned NEEDS-REVISION on the first draft) and revised.

### 9.1 Headline — one invariant substrate + two orthogonal knobs

The three "modes" are **not three architectures**. They are **presets** over:

- a single **mode-invariant substrate** (gates, integration, finalize, quota), and
- two orthogonal knobs: **driver** (adaptive-LLM-in-session | deterministic-Workflow) ×
  **concurrency** (1..N).

This is what makes it elegant: only the control loop varies; _everything that can race or waste is
in the invariant substrate and is fixed once._

```
spec → tasks (DAG)                         # spec is the most-scrutinised gate (§8)
for each DAG layer in topological order:   # layers sequential (deps); within a layer independent
    DEVELOP   (concurrency = the dial):     # per task: worktree from staging-HEAD,
              test-writer RED → executor GREEN → review (+risk-tier +citation-verify)
              → open PR  task → staging
    INTEGRATE (GitHub merge queue):         # GitHub serializes + re-tests each PR vs the PROJECTED
              staging head, merges in order, EJECTS failures   ← single serial writer, mode-invariant
    barrier: all layer PRs merged → next layer branches from updated staging
FINALIZE (once): rollup PR staging → develop, full suite, auto-merge
```

| Preset         | Driver                                  | Concurrency | = requested mode                                                   |
| -------------- | --------------------------------------- | ----------- | ------------------------------------------------------------------ |
| **Sequential** | adaptive LLM (in-session)               | 1           | Mode 3 — quota-minimal _(already supported: `maxParallelTasks=1`)_ |
| **Balanced**   | adaptive LLM (in-session)               | 3           | Mode 2 — _today's default backend_                                 |
| **Fast**       | deterministic **Workflow** (background) | N (≤16)     | Mode 1 — **the one genuinely new build**                           |

> **Reframe for the maintainer:** you already _have_ Modes 2 & 3 — they are the current LLM
> orchestrator + the `maxParallelTasks` integer (1 = sequential). The only net-new driver is
> Mode 1 (Workflow).

### 9.2 The decisive fix — integration belongs to GitHub, in every mode

The first draft's "serial single-writer integrate" described a fix **not in the code**. Verified:
the code integrates via **N concurrent `gh pr merge --squash --auto`** (`bin/pipeline-scaffold:71-81`)
with **no merge queue and no "require branches up to date"** (zero branch-protection automation in
the repo — only a local force-push hook and _comments_ assuming the user configured it). **Staging
races today, in all modes**, because merge concurrency is GitHub's, not `maxParallelTasks`.

**Decision — make GitHub the single serial writer via merge queue (factory-owned).** Enable a
**merge queue** on `staging` (closes Delta A). The queue re-tests each PR against the _projected_
staging head, merges in order, and **ejects** any PR that fails. By construction this fixes:

- the **single-writer race** (#1),
- **stalled-PR resurrection** (#4 — a failing PR is ejected, never merged), and
- **stale coverage baseline** (G4 — the queue re-tests against current head),
  …and removes the need for any local merge reducer (preserving Decisions 12/16 — PR-auto-merge stays
  the integration model; `--auto` simply enqueues instead of merging directly). **Fallback** where
  merge queue is unavailable: branch protection **"require branches up to date before merging."**

This also keeps Mode 1 simple: the Workflow never merges to staging — it only opens PRs and waits;
GitHub does the rest. Integration is identical in all three modes.

### 9.3 Mode-invariant fixes (do these first — independent of which modes ship)

Priority order:

1. **Factory owns GitHub serialization** — merge queue on `staging` (fallback: required-up-to-date).
   _Highest value; makes every mode race-free._ (Delta A)
2. **Run-scoped branch names** `factory/<run_id>/<task_id>` — today `task/<id>`
   (`bin/pipeline-run-task-stages.sh:~1585`) collides across concurrent runs (corruption bug).
3. **Disable auto-merge on stalled/failed PRs** before they go terminal (belt-and-braces; the merge
   queue's ejection covers most of this).
4. **TDD gate pinned to the pre-squash branch + memoized by tip SHA.** Squash launders RED-before-
   GREEN ordering (`bin/pipeline-tdd-gate` walks `base..HEAD`; squash collapses test+impl into one
   impl-classified commit). The gate is meaningful only on the per-task branch; it must **never** be
   naively re-run on squashed history (staging or the rollup). Memoize the per-task verdict.
5. **Testing scopes that don't waste _and_ don't blind:**
    - per-PR CI diff-scopes **unit** tests + scoped mutation (already done), but **never** proximity-
      scopes **integration/snapshot** tests, and **force-fulls** on changes to declared
      global-coupling / config / lockfile paths;
    - **rollup mutation scoped to blobs changed since `develop`** (not a full re-run);
    - **coverage baseline snapshotted per-layer** (not per-task);
    - **tree-SHA memoization** so review fix-loops don't re-run gates on unchanged trees (kills the
      O(K·R·M) flaky-amplification).
    - **Dropped as unsound:** the first-draft "skip re-test when changed files don't overlap" —
      file-set intersection ≠ semantic dependence (misses type ripple, DI/global wiring, integration
      tests, config, lockfiles). Quality-first = always re-validate against current staging (the
      merge queue does exactly this). Non-waste comes from _scoping by dependency reality + full
      suite once at rollup_, never from skip-by-guess.
6. **Quota lives entirely behind exit codes in `bin/` scripts** — so both drivers share one quota
   implementation (consistent with deterministic-first; §6 states have one home).

### 9.4 Mode 1 (Workflow) — feasible, but the real cost is honest

**Feasibility:** Decision 2 ("a shell script cannot spawn sub-agents"; "sub-agents cannot spawn
sub-agents"; orchestrator runs in the invoking session) rejected a _shell-script_ orchestrator and a
_sub-agent_ orchestrator — both **pre-date the Workflow primitive**. A Workflow is a **third class**
the harness _does_ endow with agent-spawning. So Mode 1 is **not** barred by Decision 2; Decision 2
is partially obsolete and should be amended.

**Real costs (the bulk of Mode 1's build):**

- **Workflow JS can't shell out** (no filesystem/Node access). Every deterministic `bin/` stage must
  be wrapped in a thin **exec-agent**, and control-flow state must be **threaded through agent return
  values** (structured output), not read from `state.json`. A single task ≈ several agent spawns
  (bin-stage execs + test-writer + executor + reviewer).
- **The current state layer is built for concurrency ≤3.** At high N it exposes: the `mkdir` lock
  busy-waits 10s then **hard-fails** (`bin/pipeline-state:108,138`); a singleton active-task pointer
  clobbers under parallel writers; ungated concurrent `gh` calls risk GitHub **secondary
  rate-limits**; suspend between `gh pr create` and the `pr_number` write (`:1628`) can produce a
  **duplicate PR** on resume (make PR creation idempotent — look up by head branch first); a
  quota-suspend can leave **armed auto-merges / queued PRs** firing (before suspend: stop opening
  PRs, drain or dequeue). → **Mode 1 requires hardening this layer, or capping its concurrency to
  what the layer safely supports.**
- **Quota in a background Workflow is awkward** (it can't cleanly sleep for hours while GitHub keeps
  merging underneath it) — Mode 1 is best for **quota-headroom runs**.

### 9.5 Honest per-mode tradeoffs

|                          | Speed   | Token cost                                           | Quota behavior                                  | Resilience                                                  | Use when                           |
| ------------------------ | ------- | ---------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------- | ---------------------------------- |
| **Fast (Workflow)**      | highest | lowest _per-orchestration_ but highest **peak** burn | **weakest** — background suspend/resume awkward | lowest — deterministic loop; novel failures fall to partial | big graphs **with quota headroom** |
| **Balanced (sub-agent)** | medium  | medium                                               | **native** — in-session wait/auto-resume        | highest — LLM adapts to BLOCKED/ambiguous review            | the default                        |
| **Sequential**           | lowest  | lowest peak                                          | **safest** — minimal concurrent burn            | high                                                        | quota-tight; tricky specs          |

> **Non-obvious truth:** Fast is _not_ strictly best — its quota story is its weak spot, which is
> exactly why Sequential exists. The mode choice doubles as a quota strategy.

### 9.6 Sequencing recommendation

1. Land the **mode-invariant substrate fixes** (§9.3) — these make Balanced & Sequential correct and
   race-free _first_, and they are prerequisites for Mode 1 anyway.
2. Then build **Mode 1 (Workflow)** as a thin driver over the same scripts + state-layer hardening.

This satisfies the three hard constraints: **no races** (GitHub is the single serial writer in every
mode), **no wasted/degraded testing** (scope by dependency reality, full suite once, memoize — never
skip-by-guess), **elegance** (one invariant substrate + driver × concurrency; integration and quota
are mode-invariant; sequential falls out for free).

---

## 10. Delta ledger — intent vs. current code

Actionable gaps. **Source** = the grill question that settled it. Rows **V–Z** are the targeted fixes extracted from the **deferred** executor-confinement thread (`proposals/executor-confinement.md` → Outcome).

| #     | Area                           | Current code                                                                                                                                                                                  | Intended                                                                                                                                                                      | Source      |
| ----- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **A** | Merge-gate ownership           | branch protection = unverified user precondition                                                                                                                                              | factory configures/verifies; refuses to run if missing                                                                                                                        | Q5          |
| **B** | Gate machinery                 | executor can edit `.stryker/quality-gate.yml`/thresholds in worktree                                                                                                                          | TCB — executor-immutable, plugin/maintainer-owned                                                                                                                             | Q5          |
| **C** | Delivery default               | `FACTORY_ALLOW_PARTIAL_ROLLUP=0` (all-or-nothing); incomplete → `wait_retry` **spins forever**                                                                                                | partial-rollup is the default; incomplete → **terminal** exit                                                                                                                 | Q6          |
| **D** | Retry                          | in-task recovery only                                                                                                                                                                         | bounded (≤2) **diverse** (model-escalating) **classified** nuke-retry ladder above it                                                                                         | Q6          |
| **E** | State semantics                | `partial` reused for quality-failure _and_ quota                                                                                                                                              | distinct `partial` / `paused` / `suspended`                                                                                                                                   | Q7          |
| **F** | Long waits                     | 75-min cumulative-pause **human gate** + in-session sleep                                                                                                                                     | **suspend + scheduled auto-resume** at `resets_at_epoch`; no human gate                                                                                                       | Q7          |
| **G** | Complexity dial                | `max(file,dep)` count → model                                                                                                                                                                 | spec-generator **judges** complexity, deterministic **floor** (raise-only)                                                                                                    | Q8          |
| **H** | Risk dial                      | path-match only                                                                                                                                                                               | judgment may **raise** above the path-based floor                                                                                                                             | Q8          |
| **I** | Spec-review threshold          | 54/60 (skill) vs 56/60 (agent) — contradiction                                                                                                                                                | one threshold (the higher), both agree                                                                                                                                        | Q9          |
| **J** | Spec-review scrutiny           | a gate among gates                                                                                                                                                                            | **most-scrutinised**, scaled to max risk tier across tasks                                                                                                                    | Q9          |
| **K** | Reviewer set                   | impl/quality/arch/security                                                                                                                                                                    | + `silent-failure-hunter`, `type-design-reviewer`, **citation-verify** `bin/` filter                                                                                          | Q9          |
| **L** | Staging integration            | N concurrent `--squash --auto`, no queue / no up-to-date → **races**                                                                                                                          | **GitHub merge queue** (factory-owned); fallback require-up-to-date                                                                                                           | §9          |
| **M** | Branch naming                  | `task/<id>` (global) → cross-run collision                                                                                                                                                    | `factory/<run_id>/<task_id>`                                                                                                                                                  | §9          |
| **N** | TDD gate vs squash             | squash destroys RED-before-GREEN ordering                                                                                                                                                     | gate pinned pre-squash + memoized by tip SHA; never re-run on squashed history                                                                                                | §9          |
| **O** | Testing scope                  | full-ish per task; full rollup mutation; per-task coverage baseline                                                                                                                           | diff-scoped unit + un-scoped integration + blob-scoped rollup mutation + per-layer coverage + tree-SHA memoization                                                            | §9          |
| **P** | State layer concurrency        | `mkdir` lock 10s hard-fail; singleton active-task; ungated `gh`; non-idempotent PR create                                                                                                     | hardened for N > 3 (or Mode 1 concurrency capped)                                                                                                                             | §9          |
| **Q** | Decision 2 scope               | implies no JS orchestrator                                                                                                                                                                    | amend: Workflow is a valid 3rd orchestrator class                                                                                                                             | §9          |
| **R** | Partial-safety basis           | relies on verticality (spec-reviewer dim-5 judgment)                                                                                                                                          | safety = **rollup full-CI gate**; verticality demoted to a value property                                                                                                     | Q10         |
| **S** | Partial call-out               | partial ships ~silently (run summary only)                                                                                                                                                    | deterministic **partial-run report** + **dead-surface scan** (knip, report-only) + GH issue/task + `PARTIAL` rollup-commit header                                             | Q10         |
| **T** | Reviewer model                 | quality-reviewer = sonnet; others opus                                                                                                                                                        | **all reviewers opus** (incl. net-new CCR reviewers)                                                                                                                          | Q11         |
| **U** | Cross-vendor review            | optional Codex, **silently** degrades to all-Claude                                                                                                                                           | **pluggable** + opportunistic + **loud when absent**; routed to spec gate + security tier when present                                                                        | Q11         |
| **V** | Verdict integrity              | gate verdicts stored as trusted booleans (`pipeline-state task-write … quality_gate.ok true` writes verbatim; `_validate_task_field_value` enum-guards only `status/stage/risk_tier/holdout`) | **derive-don't-store**: recompute each gate verdict from ground truth at gate time; never read a stored boolean; guard `task-write` of `*_gate*`/`security_gate*`/`coverage*` | Q12         |
| **W** | Gate-machinery write-deny      | `write-protection.sh` denylist is **config-sourced** (executor-editable → circular) + `CLAUDE_PLUGIN_DATA` redirect bypasses the loader; no `.github/workflows/**` cover                      | **hardcode** the denylist in the hook; extend to `.github/workflows/**` (sharpens **B**)                                                                                      | Q12         |
| **X** | Spec keying                    | spec keyed per `<run>` → not referenceable / regenerable (~17 inline `.state/$run_id` sites + score/cleanup/rescue-apply)                                                                     | re-key per `(repo, spec-id)`                                                                                                                                                  | Q12         |
| **Y** | Holdout answer-key             | prompt redaction real, but withheld criteria written to executor-readable `…/runs/<run>/holdouts/<task>.json` + full spec readable (leaks via **reads**)                                      | answer key out of executor read reach — **A1** best-effort placement (deny + only redacted task-json to executor); cat-proof, interpreter-residue accepted                    | Q12         |
| **Z** | Gate of record                 | gate decision can rest on executor self-reported numbers                                                                                                                                      | **trusted local re-run** by orchestrator in a clean checkout post-commit-freeze = gate of record; **mutation local too** (diff-scoped); CI = final net                        | Q-CONF-9/10 |
| **—** | `pipeline-model-router` naming | name implies model routing                                                                                                                                                                    | routes **quota** only — rename / re-doc (minor)                                                                                                                               | Q8          |

---

## 11. ADR candidates

Offer formal ADRs for these (each is hard-to-reverse **and** surprising-without-context **and** a
real trade-off):

1. **Autonomy boundary: `PRD → develop` autonomous; `main` sacred; `develop → main` human-owned.**
2. **Threat model: system-level gaming-resistance via independent backstops** (not gate-level
   hardening).
3. **Trust boundary: factory owns branch protection + gate machinery is an executor-immutable TCB.**
4. **Partial-rollup as the default graceful exit + bounded diverse classified retry ladder.**
5. **Quota is orthogonal to quality:** distinct `paused`/`suspended`/`partial` states; suspend +
   scheduled auto-resume.
6. **Deterministic floor + judgment escalation** for both complexity (model) and risk (review).
7. **Spec review is the most-scrutinised gate, scaled to the max risk tier across tasks.**
8. **Execution modes = one invariant substrate + (driver × concurrency); GitHub merge queue is the
   mode-invariant serializer.** (Supersedes/amends Decision 2's "no JS orchestrator".)
9. **Executor confinement explored, then deferred** for four targeted fixes (derive-don't-store
   verdicts; non-circular gate-machinery write-deny incl. `.github/workflows/**`; per-`(repo, spec-id)`
   re-key; holdout answer-key placement), given the **no-OS-sandbox** constraint + the
   **emergent-gaming** (not determined-adversary) threat model. Revisit only if an OS sandbox is
   adopted or the threat model hardens. (See `proposals/executor-confinement.md` → Outcome.)

---

## 12. Open questions (maintainer-owned)

1. **Merge queue vs required-up-to-date** — is the target repo on a GitHub plan/visibility that
   supports merge queue? (Determines Delta L's form.)
2. **Build Mode 1 now, or after the substrate fixes land?** (Recommendation: substrate +
   Balanced/Sequential first; Mode 1 second — it needs state-layer hardening anyway.)
3. **Does the factory _provision_ branch protection itself** (write repo settings via API) **or
   emit a checked precondition** the run refuses to start without? (Ownership-boundary nuance.)
4. **Fast-mode quota policy:** on hitting the 5h window mid-run, **drain-then-suspend** (finish
   in-flight, stop opening PRs, resume at reset) or **end-partial**? (Q6/Q7 favour
   drain-then-suspend, but it's harder in background.)
5. **Mode 1 concurrency ceiling** — cap N to what the hardened state layer safely supports, or invest
   to make it unbounded?

---

## Appendix A — Canonical terms (to sync into `docs/glossary.md`)

> Glossary entries must stay implementation-free; these are summaries for sync, not the final wording.
>
> **Updated 2026-06-04 (Decisions 25–26):** `risk tier` now denotes the **unified
> producer-model dial** (a spec-time judgment of warranted model strength = difficulty +
> stakes), **not** review depth; `complexity tier` is **folded into** it; review depth is
> **risk-invariant**. The `risk tier` / `complexity tier` bullets below describe the
> superseded two-axis model.

- **staging** — the factory-created integration branch; every task PR squash-merges here behind CI.
- **rollup** — the single `staging → develop` merge-commit PR at the end of a run, behind one full CI.
- **partial run** — terminal run state where the dependency-closed completed set was delivered and at
  least one task failed permanently (a _quality_ outcome); carries an explicit report of the failed
  task(s), their unmet acceptance criteria, and the dead surface left behind.
- **dead-surface scan** — deterministic unreferenced-export check (knip / ts-prune) run at rollup,
  scoped to the run's diff, report-only; enumerates dead-but-not-broken code a partial run leaves on
  `develop`.
- **paused run** — non-terminal: waiting out a 5h-burst quota threshold; auto-resumes.
- **suspended run** — non-terminal: persisted and exited (7d budget / long wait); resumes later and
  completes every task.
- **risk tier** — path-derived (judgment may raise) classifier setting **review depth**.
- **complexity tier** — spec-generator-judged (deterministic floor) classifier setting **executor
  model**.
- **gate machinery / TCB** — the quality-defining files the executor may not modify.
- **retry ladder** — the bounded, model-escalating, classified nuke-and-retry sequence above in-task
  recovery.
- **driver** — what runs the per-run control loop (adaptive-LLM-in-session | deterministic-Workflow).
- **mode / preset** — a named (driver × concurrency) pairing: Sequential / Balanced / Fast.
