# Glossary

```yaml
context: root
purpose: Autonomously turn a human-written PRD into merged, quality-assured pull requests with no human in the loop.
scope:
  in: PRD intake; spec generation; autonomous task execution; quality enforcement (gates + review/judgment); PR creation; recovery when auto-merge fails
  out: authoring the PRD; the GitHub merge mechanism itself; anything post-merge (deploy, release, production)
last-reviewed: 2026-06-01
```

Ubiquitous-language terms for the Dark Factory domain. Vocabulary only — no implementation details.

## Specification

### PRD

- **type**: Entity
- **status**: accepted
- **definition**: The human-written description of what should be built, in product terms rather than technical ones. It is the single input that seeds a Run, authored outside this domain by a person who need not know how the work will be carried out.
- **invariants**:
  - A PRD is authored outside this domain; the domain consumes it but never writes it.
  - Exactly one PRD seeds a given Run.
- **examples**:
  - "Users should be able to reset a forgotten password via an emailed link that expires in an hour."
  - Counter-example: a list of files to change and functions to add — that is implementation, not a PRD.
- **relationships**: seeds one Run; converted into a Spec by Spec Generation.
- **synonyms**: —
- **code anchor**: `skills/prd-to-spec/SKILL.md`

### Spec

- **type**: Entity
- **status**: accepted
- **definition**: The structured, machine-workable plan derived from a PRD: the full set of Tasks with their acceptance criteria and dependencies. Where the PRD says what is wanted in human terms, the Spec says what must be done in terms a coding actor can execute and be measured against.
- **invariants**:
  - Every Spec derives from exactly one PRD.
  - A Spec must be well-formed — a complete, acyclic set of Tasks — before any Task may begin.
  - Acceptance criteria in the Spec are the standard against which delivered work is judged.
- **examples**:
  - The password-reset PRD becomes a Spec of Tasks: create the table, add the token model, build the endpoint, wire the email — each with its own acceptance criteria.
  - Counter-example: a Spec whose Tasks reference one another in a cycle — it is invalid and no Task runs.
- **relationships**: derived from one PRD; enumerates the Run's Tasks; produced by Spec Generation; checked as part of Review.
- **synonyms**: —
- **code anchor**: `src/spec/gates.ts`

### Spec Generation

- **type**: Domain Service
- **status**: accepted
- **definition**: The act of turning a non-technical PRD into an executable Spec — decomposing the desired outcome into Tasks, giving each measurable acceptance criteria, and ordering them by dependency. It is treated as a quality lever in its own right: a sound Spec is a precondition for trustworthy output, not mere intake.
- **invariants**:
  - Produces exactly one Spec per PRD.
  - Its output is not trusted until validated as well-formed and independently checked.
- **examples**:
  - Reading a one-paragraph feature request and emitting a dependency-ordered set of Tasks with explicit acceptance criteria.
  - Counter-example: copying the PRD verbatim into a single Task with no acceptance criteria — that is not generation.
- **relationships**: consumes a PRD; produces a Spec; its product is subject to Review.
- **synonyms**: —
- **code anchor**: `agents/spec-generator.md`

## Core domain

### Run

- **type**: Aggregate Root
- **status**: accepted
- **definition**: One end-to-end attempt to satisfy a single PRD by autonomously producing and merging all the work it requires. A Run is the unit a person starts and walks away from; it succeeds only when the whole PRD has been delivered, never partially.
- **invariants**:
  - A Run serves exactly one PRD.
  - A Run is complete only when every one of its Tasks has merged — partial delivery is never "complete".
  - A Run may halt early when it judges further attempts unsafe (see Circuit Breaker), leaving it failed, not complete.
- **examples**:
  - A PRD describing a new login flow becomes a Run of five Tasks; the Run is complete once all five PRs have merged.
  - Counter-example: four of five Tasks merge but the fifth repeatedly fails — the Run is _failed/halted_, not complete.
- **relationships**: owns many Tasks; serves one PRD; governed by the Circuit Breaker.
- **synonyms**: —
- **code anchor**: `src/core/state/manager.ts`

### Task

- **type**: Entity
- **status**: accepted
- **definition**: A single self-contained unit of work within a Run that results in exactly one merged pull request. Tasks are the steps a PRD is broken into so each can be implemented, quality-checked, and shipped independently.
- **invariants**:
  - Each Task produces exactly one pull request.
  - A Task may not begin until every Task it depends on has merged.
  - The set of Tasks in a Run forms a dependency graph with no cycles; independent Tasks may run at the same time.
  - A Task is only shippable after its quality obligations are met (tests-first, gates, review).
- **examples**:
  - "Add the password-reset endpoint" depending on "Create the users table" — the endpoint Task waits for the table Task to merge.
  - Counter-example: two Tasks that each claim to merge the same pull request — a Task owns one and only one.
- **relationships**: belongs to a Run; depends on other Tasks; carries a Risk Tier; subject to Automated Gates, Holdout Validation, and Review.
- **synonyms**: —
- **code anchor**: `src/core/state/schema.ts:TaskState`

## Run continuation & recovery

> A PRD has **at most one active Run at any time**. An unfinished Run is never a finished outcome — it is something a person continues, repairs, or replaces. These three terms name those three choices. None of a Run's work reaches the shared codebase until the whole PRD is delivered; an unfinished Run's work stays private to that attempt, so continuing, repairing, or replacing it never disturbs already-delivered work.

### Resume

- **type**: Operation (on a Run)
- **status**: accepted
- **definition**: Carrying an existing, unfinished Run forward from where it stopped. A Run can stop for benign reasons — a capacity window closed, a session ended — and resuming simply continues it toward delivering the whole PRD. Resume continues a Run only when continuation is genuinely possible; when the Run is wedged such that continuation alone cannot clear it, Resume defers to Rescue rather than forcing progress.
- **invariants**:
  - Resume applies only to an unfinished Run; a delivered or replaced Run has nothing to resume.
  - Resume never changes the work or the Run's state — it only continues it. Making a wedged Run continuable again is Rescue's job, not Resume's.
- **examples**:
  - A Run pauses when a daily capacity window is exhausted; the next day Resume carries it on from the same point.
  - Counter-example: a Run whose remaining work cannot proceed at all — Resume does not bulldoze it; it hands off to Rescue.
- **relationships**: continues a Run; defers to Rescue when continuation is impossible; the alternative to Supersede when an active Run already exists.
- **synonyms**: —

### Rescue

- **type**: Operation (on a Run)
- **status**: accepted
- **definition**: Recovering a Run that cannot simply be resumed — investigating why it is stuck and changing its state until it can continue, then carrying it on. Where Resume only moves a continuable Run forward, Rescue is allowed to repair: clearing wedged work, reconciling the Run's recorded state with what actually happened in the outside world, and reopening a Run that had given up. Repairs that only move things forward are done autonomously; any repair that would discard work is surfaced for a person's consent first.
- **invariants**:
  - Rescue is the only operation that repairs a Run's recorded state; Resume and a Run's own progress never do.
  - Rescue never discards work without explicit consent.
  - Rescue ends by continuing the Run — recovering a Run it then leaves stopped would not be recovery.
- **examples**:
  - A Run gave up after one Task repeatedly failed; Rescue reopens it, clears the wedged Task, and continues.
  - A Task's work in fact landed but the Run's record missed it; Rescue reconciles the record and carries on.
- **relationships**: repairs and then continues a Run; the escalation beyond Resume; bounded by the Circuit Breaker's notion of an unsafe Run.
- **synonyms**: recovery.

### Supersede

- **type**: Operation (relates two Runs over one PRD)
- **status**: accepted
- **definition**: Starting a fresh Run for a PRD that already has an active, unfinished Run, where the new Run replaces the old. The replaced Run is abandoned whole — none of its work is delivered — and only the new attempt continues. Superseding is the deliberate choice to start over rather than continue (Resume) or repair (Rescue) the existing attempt.
- **invariants**:
  - At most one active Run exists for a PRD at any time; superseding preserves that by abandoning the prior Run as it begins the new one.
  - A superseded Run delivers none of its work — the PRD is left as if that attempt had not run.
  - Only an unfinished Run can be superseded; a delivered Run is complete, not replaceable.
- **examples**:
  - A Run on the login PRD stalls overnight; the next morning the author deliberately starts over — the stalled Run is superseded and the fresh Run takes its place.
  - Counter-example: continuing the stalled Run instead — that is Resume, not Supersede; nothing is abandoned.
- **relationships**: replaces one Run with another over the same PRD; the alternative to Resume and Rescue; enforces the one-active-Run-per-PRD invariant.
- **synonyms**: replace, start over.

## Quality & verification

### Review

- **type**: Domain Service
- **status**: accepted
- **definition**: The independent judgment of a Task's delivered work before it may ship, carried out by a fixed panel of reviewers, each applying a current industry-standard quality practice. The panel is risk-invariant: every reviewer judges every Task at the same depth, whatever its Risk Tier. Review is what makes shipping without a human watching trustworthy. The specific practices and reviewers are deliberately not fixed — they are expected to change as industry standards do.
- **invariants**:
  - A reviewer never judges work it authored.
  - A Task ships only with unanimous approval; if any reviewer asks for changes, the work returns to the Implementer, who must account for every raised blocker before re-review.
  - The panel is risk-invariant — the same reviewers judge every Task at the same depth; scrutiny is never narrowed for work deemed low-risk.
- **examples**:
  - A copy tweak and an authentication change face the same full panel — the merge gate never narrows.
  - Counter-example: skipping the security reviewer on a "routine" Task — the panel does not shrink with perceived risk.
- **relationships**: gates a Task's ship; panel is risk-invariant (Risk Tier dials the producer, not Review); complements Automated Gates and Holdout Validation.
- **synonyms**: —
- **code anchor**: `src/verifier/judgment/panel-run.ts`

### Automated Gate

- **type**: Policy
- **status**: accepted
- **definition**: An automatic, impersonal pass/fail check a Task's work must clear before it can ship — covering objective dimensions such as test coverage, security, and mutation resistance. Gates encode non-negotiable minimums that need no judgment to apply.
- **invariants**:
  - A failing gate blocks the Task from shipping.
  - A gate that cannot complete blocks rather than passes — unverified work is never let through on the strength of an error.
- **examples**:
  - Test coverage below the configured floor blocks the Task; a gate that errors internally still blocks.
  - Counter-example: a gate reporting success because it failed to run — that contradicts what a gate is for.
- **relationships**: applies to a Task; objective counterpart to Review; the TDD Gate is one specific Automated Gate.
- **synonyms**: —
- **code anchor**: `src/verifier/deterministic/gate-runner.ts`

### TDD Gate

- **type**: Policy
- **status**: accepted
- **definition**: The rule that the tests defining a Task's behavior must exist, must fail, and must be **committed before** any implementation is committed — making "tests first" impossible to bypass. Enforcement is by commit-ordering on the Task's own branch, not by inspecting the final diff. It is the enforcement of the boundary between Test Writer and Implementer.
- **invariants**:
  - For a Task, the failing-test commit must precede the implementation commit; an implementation that lands before a failing test blocks the Task.
  - The rule is waived only by an explicit per-task exemption or a configured custom red-test command — never silently.
- **examples**:
  - An implementation commit with no preceding failing-test commit is blocked.
  - Counter-example: a task explicitly marked exempt in the Spec legitimately skips the gate.
- **relationships**: a specific Automated Gate; enforces the Test Writer → Implementer ordering.
- **synonyms**: —
- **code anchor**: `src/verifier/deterministic/strategies/tdd.ts`

### Holdout Validation

- **type**: Policy
- **status**: accepted
- **definition**: A guard against work that is tailored to the visible target rather than genuinely correct. A subset of the acceptance criteria is withheld from the Implementer and verified independently after the fact; passing only the criteria it could see is not enough.
- **invariants**:
  - The withheld criteria are never revealed to the actor producing the work.
  - Validation against the withheld criteria is performed independently of that actor.
- **examples**:
  - Two of eight acceptance criteria are held back; the work passes the six it saw but fails a hidden one and is rejected.
  - Counter-example: "validating" against criteria the Implementer was shown — it proves nothing about overfitting.
- **relationships**: applies to a Task; draws criteria from the Spec; complements Review.
- **synonyms**: —
- **code anchor**: `src/verifier/holdout/validate.ts`

## E2E Testing

### E2E Phase

- **type**: Process
- **status**: accepted
- **definition**: A Run-level stage, opted into via `--e2e`, that authors and runs browser journeys against the integrated staging app once every Task is terminal, so a feature can be checked end-to-end rather than only unit-by-unit. It runs immediately before documentation.
- **invariants**:
  - Only runs on a Run that opted in at creation; the choice cannot change on Resume.
  - Never marks the Run itself failed or complete directly — it can only reopen a Task or hand off to the next stage.
- **examples**:
  - A Run with `--e2e` reaches "every Task terminal" and the phase authors + runs journeys before the docs stage fires.
  - Counter-example: a Run without `--e2e` skips this stage entirely and proceeds straight to docs.
- **relationships**: follows Task completion; precedes documentation; produces the E2E Reopen Loop; consumes the Fail-first Proof and the E2E Runner.
- **synonyms**: —
- **code anchor**: `src/orchestrator/e2e.ts`

### E2E Author

- **type**: Role
- **status**: accepted
- **definition**: The actor that explores the live staging app and writes browser journeys proving features work end-to-end — a Critical (Persisted) E2E Spec for load-bearing paths, a Throwaway E2E Spec for everything else it judges user-facing. It writes specs; it never reviews or reopens work.
- **invariants**:
  - Runs at most once per E2E Phase entry; a later pass in the same Reopen Loop reruns its specs rather than re-inventing them.
  - Every spec it writes must be proven passing against the live app before it hands off.
- **examples**:
  - Explores a newly-shipped checkout flow, writes one Critical spec for the money path and a Throwaway spec covering the rest of the Task's acceptance criteria.
  - Counter-example: judging its own spec's failure as a false alarm and suppressing it — that call belongs to the E2E Phase's disposition logic, not the author.
- **relationships**: serves the E2E Phase; produces Critical and Throwaway E2E Specs; its output is checked by the Fail-first Proof.
- **synonyms**: —
- **code anchor**: `agents/e2e-author.md`

### Critical (Persisted) E2E Spec

- **type**: Value Object
- **status**: accepted
- **definition**: A browser journey the E2E Author judged load-bearing enough to keep permanently — committed into the target repository rather than discarded at the end of the Run. Where a spec is stored is what marks it Critical; nothing else does.
- **invariants**:
  - Lives inside the repository's committed E2E test directory, never anywhere ephemeral.
  - Must pass the Fail-first Proof before it is ever committed.
  - Only the E2E Author may add or change one; no other Role may touch it.
- **examples**:
  - A checkout journey is committed as a Critical spec, so it keeps gating every future `--e2e` Run and every pull request afterward.
  - Counter-example: a one-off spec for a minor settings toggle, discarded at Run end — that belongs in the Throwaway tier instead.
- **relationships**: authored by the E2E Author; verified by the Fail-first Proof; executed by the E2E Runner; joined to its Task by the E2E Reopen Loop's manifest.
- **synonyms**: Critical Spec, Persisted Spec
- **code anchor**: `src/orchestrator/e2e.ts`

### Throwaway E2E Spec

- **type**: Value Object
- **status**: accepted
- **definition**: A browser journey the E2E Author writes for a single Task's user-facing behavior, kept only for the duration of the current Run and discarded once it ends.
- **invariants**:
  - Never committed to the target repository.
  - Covers at most the Run currently in progress; it has no bearing on any future Run.
- **examples**:
  - A Task adding a settings toggle gets a Throwaway spec that exercises it once, then is discarded when the Run finishes.
  - Counter-example: a spec meant to keep gating every future Run — that is a Critical spec, not a Throwaway one.
- **relationships**: authored by the E2E Author; joined to its Task by the E2E Reopen Loop's manifest; not subject to the Fail-first Proof.
- **synonyms**: Ephemeral Spec
- **code anchor**: `src/orchestrator/e2e.ts`

### Fail-first Proof

- **type**: Policy
- **status**: accepted
- **definition**: A check that a Critical (Persisted) E2E Spec actually proves something, run before the spec is ever committed — the end-to-end analogue of the TDD Gate's red-then-green discipline, standing in for the human review an autonomously-written assertion never gets. The spec must fail against the codebase as it stood before the feature existed and pass against it with the feature integrated.
- **invariants**:
  - A spec that already passes before the feature exists is rejected as proving nothing.
  - A spec that still fails after the feature is proven working is rejected as unusable.
- **examples**:
  - A checkout spec fails against the pre-feature codebase and passes once the feature is integrated — it clears the proof and may be committed.
  - Counter-example: a spec that passes even without the feature (e.g., it never actually exercises the new behavior) — rejected as vacuous.
- **relationships**: gates a Critical (Persisted) E2E Spec; performed by the E2E Runner; enforced within the E2E Phase.
- **synonyms**: —
- **code anchor**: `src/orchestrator/e2e.ts`

### E2E Reopen Loop

- **type**: Process
- **status**: accepted
- **definition**: The mechanism by which a failing E2E journey sends its Task back to the start of the implementation work, carrying feedback about what went wrong, rather than leaving the Run to fail outright. The failing spec is traced back to the Task(s) it covers, and that Task is reopened.
- **invariants**:
  - A failing journey can only be traced back to a Task it was explicitly linked to when authored; an untraceable failure cannot be silently ignored.
  - A Task may be reopened this way only a bounded number of times before the Run is failed outright instead.
- **examples**:
  - A checkout journey fails; the Task that implemented checkout is reopened with a note describing the failure, and its implementation work restarts.
  - Counter-example: a Throwaway spec that keeps failing on a later pass after already reopening once — later passes reopen only for Critical failures, so this one instead becomes an advisory note.
- **relationships**: triggered by the E2E Phase; consumes the E2E Author's manifest; bounded per Task.
- **synonyms**: —
- **code anchor**: `src/orchestrator/e2e.ts`

### E2E Runner

- **type**: Policy
- **status**: accepted
- **definition**: The mechanism that actually executes browser journeys and reports which passed, failed, or were flaky (failed, then passed on a retry). A flaky result is reported but never treated as a real failure.
- **invariants**:
  - Never falls back to a network-fetched tool if the expected local one is missing — a missing tool is reported as a failure, not silently worked around.
  - A flaky result never triggers the E2E Reopen Loop.
- **examples**:
  - A journey fails once, then passes on an automatic retry — reported as flaky, and the Run proceeds without reopening anything.
  - Counter-example: a journey that fails on every attempt — a real failure, eligible for the E2E Reopen Loop.
- **relationships**: performs the Fail-first Proof; executes Critical and Throwaway E2E Specs; used by the E2E Phase.
- **synonyms**: —
- **code anchor**: `src/verifier/e2e/runner.ts`

## Risk & safety

### Risk Tier

- **type**: Value Object
- **status**: accepted
- **definition**: A classification of how demanding a piece of work is — judged from its difficulty and stakes at Spec time — that dials how much production capability is spent on it. It is how the domain spends production effort in proportion to risk; verification scrutiny stays uniform regardless of tier.
- **invariants**:
  - Every Task carries exactly one Risk Tier.
  - The tier dials the producer (the capability attempting the work), never the merge gate — Review and Automated Gates are identical across tiers.
- **examples**:
  - A change to authentication is classified high-risk and is attempted with the strongest producer; a copy tweak is routine.
  - Counter-example: a demanding change classified routine — a misclassification that under-resources its production.
- **relationships**: carried by a Task; dials the producer; never alters Review or Automated Gates.
- **synonyms**: known in the codebase as "risk_tier".
- **code anchor**: `src/spec/schema.ts`

### Circuit Breaker

- **type**: Policy
- **status**: accepted
- **definition**: A safety rule that halts a Run when persisting looks futile or unsafe — for example after too many consecutive failures — so that a malfunctioning Run stops itself rather than burning effort or causing harm while unattended.
- **invariants**:
  - Once tripped, the Run halts and cannot be considered complete.
  - Tripping reflects accumulated failure signals, not a single transient failure.
- **examples**:
  - Several consecutive Task failures trip the breaker and stop the Run.
  - Counter-example: one flaky failure that the next attempt recovers from does not trip it.
- **relationships**: governs a Run; safeguard for unattended operation.
- **synonyms**: —
- **code anchor**: `src/quota/circuit-breaker.ts`

## Roles

> **Separation of duties** is a domain-wide invariant: every Role acts strictly within its own remit and never performs work that belongs to another. In particular, no Role ever reviews or vouches for work it authored itself. This non-overlap is what lets an unattended Run earn trust without a human. The roster below is canonical today but may evolve as best practices do.

### Orchestrator

- **type**: Role
- **status**: accepted
- **definition**: The single actor that decides how a Run proceeds from start to finish — choosing which Task to advance next, walking each Task through its quality obligations, and deciding what must happen when something lands off the expected path (for example, when an automatic merge cannot complete and someone must understand why and resolve it). It decides and emits the work to be done; a thin **runner** merely carries those decisions out, spawning the agents each one names. The Orchestrator coordinates; it does not write tests, write implementation, or judge quality itself.
- **invariants**:
  - Exactly one Orchestrator decides a given Run.
  - The Orchestrator never authors Task work or quality judgments — those belong to other Roles; the runner that executes its decisions holds no judgment of its own.
- **examples**:
  - An automatic merge stalls on an unexpected conflict; the Orchestrator determines the recovery and the runner carries it out so the Run can finish.
  - Counter-example: the Orchestrator deciding a Task's code is "good enough" and skipping Review — that judgment is not in its remit.
- **relationships**: drives a Run; delegates to Test Writer and Implementer; submits work to Review.
- **synonyms**: —
- **code anchor**: `src/orchestrator/`

### Test Writer

- **type**: Role
- **status**: accepted
- **definition**: The actor that captures a Task's expected behavior as failing tests _before_ any implementation exists, fixing the target the implementation must later hit. It defines what "working" means; it never makes the tests pass itself.
- **invariants**:
  - Writes tests before any implementation for the Task exists, and those tests must genuinely fail first.
  - Never writes the implementation under test.
- **examples**:
  - For a password-reset Task, writes tests asserting an expired token is rejected — and confirms they fail before any code is written.
  - Counter-example: writing a test plus the code to satisfy it in one step — that crosses into the Implementer's remit.
- **relationships**: serves a Task; hands a failing test suite to the Implementer; its precedence is enforced by the TDD Gate.
- **synonyms**: —
- **code anchor**: `agents/test-writer.md`

### Implementer

- **type**: Role
- **status**: accepted
- **definition**: The actor that writes the smallest implementation that makes the pre-written failing tests pass, and no more. It satisfies the target the Test Writer set; it does not get to move that target.
- **invariants**:
  - Writes implementation only against tests that already exist and already failed.
  - Never authors its own tests and never reviews its own output.
- **examples**:
  - Implements token-expiry checking until the Test Writer's failing tests go green.
  - Counter-example: adding new tests to cover behavior it just wrote — that belongs to the Test Writer.
- **relationships**: serves a Task; consumes the Test Writer's failing tests; its output is subject to Review.
- **synonyms**: —
- **code anchor**: `agents/implementer.md`
