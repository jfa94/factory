# Glossary

> Terms cover Factory v2 only. Retired v1 concepts are not listed; v1 history is
> preserved at the git tag `archive/v1-engine`.

```yaml
context: root
purpose: Autonomously turn a human-written PRD into one merged, quality-assured pull request with no human in the loop.
scope:
    in: PRD intake; spec generation; autonomous task execution; quality enforcement (gates + review/judgment); one PR per PRD; observed merge; self-healing retries and bounded repair
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
- **code anchor**: `agents/spec-generator.md`

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
- **definition**: One PRD converted into one integrated feature branch and one pull request. A Run is the unit a person starts and walks away from: its Tasks accumulate on the feature branch, and it ends with the whole PRD delivered in that single pull request, never partially.
- **invariants**:
    - A Run serves exactly one PRD, and a repository has at most one active Run.
    - A live Run completes only on an observed merge of its pull request; a no-ship Run ends with that pull request complete and ready for review.
    - A verified feature with no changes completes without opening an empty pull request.
    - A stopped Run stays parked until a person resumes it; partial delivery is never "complete".
- **examples**:
    - A PRD describing a new login flow becomes a Run of five Tasks on one feature branch; the live Run completes once its single pull request is observed merged.
    - Counter-example: four of five Tasks are accepted but the fifth keeps failing its repair passes — the Run parks, it is not complete, and nothing is delivered.
- **relationships**: owns many Tasks; serves one PRD; continued by Resume.
- **synonyms**: —
- **code anchor**: `src/feature/schema.ts:FeatureRunSchema`

### Task

- **type**: Entity
- **status**: accepted
- **definition**: One item of the Spec's sequential task list. Tasks run one at a time in the Run's single feature worktree and accumulate on its one feature branch; a Task opens no pull request of its own.
- **invariants**:
    - Tasks execute one at a time, in dependency order; a Task begins only after every Task it depends on has been accepted.
    - The Tasks in a Run form a dependency graph with no cycles; Tasks that touch the same file depend on the earlier owner.
    - A Task is accepted only after its quality obligations are met (tests-first, gates, review); accepted work is never reset.
- **examples**:
    - "Add the password-reset endpoint" depending on "Create the users table" — the endpoint Task runs after the table Task is accepted, on the same feature branch.
    - Counter-example: a Task that opens its own pull request — the Run delivers every Task through its one pull request.
- **relationships**: belongs to a Run; depends on other Tasks; carries a Risk Tier; subject to Automated Gates and Review.
- **synonyms**: —
- **code anchor**: `src/feature/schema.ts:FeatureTaskSchema`

## Run continuation & recovery

> A repository has **at most one active Run at any time**. An unfinished Run is never a finished outcome — it stays parked until a person resumes it. None of a Run's work reaches the shared codebase until the whole PRD is delivered; an unfinished Run's work stays on its feature branch, so continuing it never disturbs already-delivered work.

### Resume

- **type**: Operation (on a Run)
- **status**: accepted
- **definition**: Carrying an existing, unfinished Run forward from its persisted checkpoint. A Run can stop for benign reasons — a capacity window closed, a session ended, a question needs a person's answer — and resuming continues it toward delivering the whole PRD. When an attempt was interrupted, explicit recovery consumes its staged result if present, or retires the attempt and schedules a replacement, without discarding work.
- **invariants**:
    - Resume applies only to an unfinished Run; a delivered Run has nothing to resume.
    - Resume never resets or deletes accepted work, and never changes the Spec's acceptance criteria or quota policy.
- **examples**:
    - A Run pauses when a daily capacity window is exhausted; the next day Resume carries it on from the same point.
    - Counter-example: starting a fresh Run over the stalled one — an existing Run is resumed explicitly, never replaced.
- **relationships**: continues a Run; supplies answers to a parked Run's question.
- **synonyms**: —

## Quality & verification

### Review

- **type**: Domain Service
- **status**: accepted
- **definition**: The independent judgment of delivered work before it may ship. Every Task gets a quality review; each slice and the whole feature get the full panel of reviewers, each applying a current industry-standard quality practice. Every claim is independently verified before it reaches the Implementer. Review depth never depends on Risk Tier. Review is what makes shipping without a human watching trustworthy. The specific practices and reviewers are deliberately not fixed — they are expected to change as industry standards do.
- **invariants**:
    - A reviewer never judges work it authored.
    - Work passes review only when no claim survives independent verification; a confirmed claim returns the work to the Implementer, and the re-review judges that repair.
    - Review is risk-invariant — the same reviewers judge every boundary at the same depth; scrutiny is never narrowed for work deemed low-risk.
- **examples**:
    - A copy tweak and an authentication change face the same full panel — the merge gate never narrows.
    - Counter-example: skipping the silent-failure-hunter on a "routine" Task — the panel does not shrink with perceived risk.
- **relationships**: gates a Task's ship; panel is risk-invariant (Risk Tier never alters Review); complements Automated Gates.
- **synonyms**: —

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
- **definition**: The rule that the tests defining a Task's behavior must exist, must fail, and must be **committed before** any implementation is committed — making "tests first" impossible to bypass. Enforcement is by commit-ordering within the Task's commit range on the feature branch, not by inspecting the final diff. A test may fail by assertion or by importing a declared module that does not exist yet; tests the gate cannot run are delegated to the pull request's CI. It is the enforcement of the boundary between Test Writer and Implementer.
- **invariants**:
    - For a Task, the failing-test commit must precede the implementation commit; an implementation that lands before a failing test blocks the Task.
    - The rule is waived only by an explicit per-task exemption or a configured custom red-test command — never silently.
- **examples**:
    - An implementation commit with no preceding failing-test commit is blocked.
    - Counter-example: a task explicitly marked exempt in the Spec legitimately skips the gate.
- **relationships**: a specific Automated Gate; enforces the Test Writer → Implementer ordering.
- **synonyms**: —
- **code anchor**: `src/verifier/deterministic/strategies/tdd.ts`

## E2E Testing

### E2E Author

- **type**: Role
- **status**: accepted
- **definition**: The actor that explores the live app and writes a small committed suite of browser journeys proving the feature's key user paths work end-to-end. It runs once per feature on an `--e2e` Run and commits its journeys on the feature branch. It writes journeys; it never reviews its own work.
- **invariants**:
    - Runs once per feature, after every Task is implemented and reviewed.
    - Every journey it writes must be proven passing against the live app before it hands off; the engine then executes the suite independently.
- **examples**:
    - Explores a newly built checkout flow and commits one journey for the money path.
    - Counter-example: judging its own journey's failure as a false alarm and suppressing it — the engine's execution and the feature review judge the suite, not the author.
- **relationships**: serves a Run opted into `--e2e`; its suite is executed by the engine and its coverage judged by feature Review.
- **synonyms**: —
- **code anchor**: `agents/e2e-author.md`

## Risk & safety

### Risk Tier

- **type**: Value Object
- **status**: accepted
- **definition**: A judgment of how demanding a Task is — low, medium or high, from its difficulty and stakes — recorded at Spec time with a rationale. It is context, not a control: it is shown with its rationale in every brief that describes the Task, and the Spec Reviewer weights its scrutiny by it. It selects no producer model or effort, and it changes no gate or reviewer.
- **invariants**:
    - Every Task carries exactly one Risk Tier and a rationale that justifies it for that Task; a blanket tier across all Tasks is not a judgment and fails spec review.
    - Review and Automated Gates are identical across tiers.
- **examples**:
    - A change to credential hashing is tiered high because a flaw risks data loss; the Spec Reviewer checks it line by line against the repository.
    - Counter-example: every Task tiered medium with the same rationale — the Spec Reviewer blocks it.
- **relationships**: carried by a Task; justified by its rationale; checked by the Spec Reviewer; never alters Review or Automated Gates.
- **synonyms**: known in the codebase as "risk_tier".
- **code anchor**: `src/spec/schema.ts`

## Roles

> **Separation of duties** is a domain-wide invariant: every Role acts strictly within its own remit and never performs work that belongs to another. In particular, no Role ever reviews or vouches for work it authored itself. This non-overlap is what lets an unattended Run earn trust without a human. The roster below is canonical today but may evolve as best practices do.

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
