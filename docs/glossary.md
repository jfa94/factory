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
- **relationships**: belongs to a Run; depends on other Tasks; carries a Risk Tier; subject to Quality Gates, Holdout Validation, and Review.
- **synonyms**: —
- **code anchor**: `src/cli/subcommands/run-task.ts`

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
  - A copy tweak and an authentication change face the same full panel — the floor never narrows.
  - Counter-example: skipping the security reviewer on a "routine" Task — the panel does not shrink with perceived risk.
- **relationships**: gates a Task's ship; panel is risk-invariant (Risk Tier dials the producer, not Review); complements Quality Gates and Holdout Validation.
- **synonyms**: —
- **code anchor**: `src/verifier/judgment/panel-run.ts`

### Quality Gate

- **type**: Policy
- **status**: accepted
- **definition**: An automatic, impersonal pass/fail check a Task's work must clear before it can ship — covering objective dimensions such as test coverage, security, and mutation resistance. Gates encode non-negotiable minimums that need no judgment to apply.
- **invariants**:
  - A failing gate blocks the Task from shipping.
  - A gate that cannot complete blocks rather than passes — unverified work is never let through on the strength of an error.
- **examples**:
  - Test coverage below the configured floor blocks the Task; a gate that errors internally still blocks.
  - Counter-example: a gate reporting success because it failed to run — that contradicts what a gate is for.
- **relationships**: applies to a Task; objective counterpart to Review; the TDD Gate is one specific Quality Gate.
- **synonyms**: —
- **code anchor**: `src/verifier/deterministic/gate-runner.ts`

### TDD Gate

- **type**: Policy
- **status**: accepted
- **definition**: The rule that the tests defining a Task's behavior must exist, and must fail, before any implementation is written — making "tests first" impossible to bypass. It is the enforcement of the boundary between Test Writer and Implementer.
- **invariants**:
  - For a Task, failing tests must precede implementation; implementation that lands before a failing test blocks the Task.
  - The rule is waived only by an explicit per-task exemption or a configured custom red-test command — never silently.
- **examples**:
  - An implementation commit with no preceding failing-test commit is blocked.
  - Counter-example: a task explicitly marked exempt in the Spec legitimately skips the gate.
- **relationships**: a specific Quality Gate; enforces the Test Writer → Implementer ordering.
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

## Risk & safety

### Risk Tier

- **type**: Value Object
- **status**: accepted
- **definition**: A classification of how demanding a piece of work is — judged from its difficulty and stakes at Spec time — that dials how much production capability is spent on it. It is how the domain spends production effort in proportion to risk; verification scrutiny stays uniform regardless of tier.
- **invariants**:
  - Every Task carries exactly one Risk Tier.
  - The tier dials the producer (the capability attempting the work), never the verification floor — Review and Quality Gates are identical across tiers.
- **examples**:
  - A change to authentication is classified high-risk and is attempted with the strongest producer; a copy tweak is routine.
  - Counter-example: a demanding change classified routine — a misclassification that under-resources its production.
- **relationships**: carried by a Task; dials the producer; never alters Review or Quality Gates.
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
- **definition**: The single actor that drives a Run from start to finish — choosing which Task to advance next, walking each Task through its quality obligations, and taking responsibility when something happens off the expected path (for example, when an automatic merge cannot complete and someone must understand why and resolve it). It coordinates; it does not write tests, write implementation, or judge quality itself.
- **invariants**:
  - Exactly one Orchestrator drives a given Run.
  - The Orchestrator never authors Task work or quality judgments — those belong to other Roles.
- **examples**:
  - An automatic merge stalls on an unexpected conflict; the Orchestrator investigates and resolves it so the Run can finish.
  - Counter-example: the Orchestrator deciding a Task's code is "good enough" and skipping Review — that judgment is not in its remit.
- **relationships**: drives a Run; delegates to Test Writer and Implementer; submits work to Review.
- **synonyms**: —
- **code anchor**: `skills/pipeline-orchestrator/SKILL.md`

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
- **synonyms**: known in the codebase as "task-executor".
- **code anchor**: `agents/task-executor.md`
