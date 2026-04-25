# Agent & Skill Adherence Guide

How to structure agent prompts and skill files so the model actually follows the rules.

The default failure mode for an agent prompt is **drift**: the model reads the rules, agrees, then quietly does something easier. This guide catalogues the devices that prevent drift and the rules for when to use which.

## 1. When to apply this guide

Two file shapes exist:

- **Rigid**: agents and skills that enforce a discipline. The model must do _exactly_ what the file says — no creative interpretation. Examples: TDD executors, code reviewers, output-format enforcers, stage-machine orchestrators.
- **Flexible**: skills that teach a pattern. The model adapts principles to context.

This guide targets **rigid** files. Apply every relevant device. For flexible files, cherry-pick — too many caps and Iron Laws drown out the pattern.

The dial: more devices = stronger adherence + lower readability + harder to maintain. Pick the minimum set that locks in the behaviors that have actually drifted in practice.

## 2. The device catalogue

Each device below has: what it is, what it prevents, where it goes, an example, and the failure mode if you skip it.

### 2.1 `<EXTREMELY-IMPORTANT>` block

Top-of-file XML wrapper around the most load-bearing rule. The model attends harder to XML tags and shouty names than to plain headings.

**Prevents**: silent skipping of the one rule that, if violated, makes the rest of the file worthless.

**Where**: immediately after the YAML frontmatter, before any prose. One per file. If you have two, you have zero.

**Example**:

```
<EXTREMELY-IMPORTANT>
## Iron Law

NO NEW TESTS. NO PRODUCTION CODE WITHOUT A FAILING TEST ALREADY IN THE WORKTREE.

Tests were written in a prior phase. You DO NOT author the initial tests for this task. You ONLY write minimal implementation to satisfy the existing failing tests.

Violating the letter of this rule violates the spirit. No exceptions.
</EXTREMELY-IMPORTANT>
```

**If skipped**: the rule reads as one bullet among many, gets reordered when the model summarises, and becomes optional in practice.

### 2.2 Iron Laws section

Numbered, terse, declarative. 3–5 items. Each item is a hard prohibition or a hard requirement, not advice.

**Prevents**: rules-as-suggestions. "Hard Rules" works as a label too; pick one and stick with it.

**Where**: directly after the `<EXTREMELY-IMPORTANT>` block, or as the first body section if the EI block already contains a single law.

**Example**:

```
## Iron Laws

1. **Every step is a script call.** Validation, classification, state writes, quality gates, review dispatch — all live in the wrapper. You never perform them by prose.
2. **The wrapper owns the stage machine.** It returns an exit code and (on a designated code) a JSON spawn manifest. You react to codes; you do not invent stages.
3. **Reviewers judge code quality, not you.** Your job is to spawn them, parse verdicts, and feed the wrapper. You never form an opinion on whether the code is correct.
```

**Anti-pattern**: 12 Iron Laws. Anything past 5 is no longer iron — it is suggestion. Demote everything below importance threshold to a "Rules" section.

### 2.3 Letter = Spirit clause

One line, immediately after Iron Laws or inside the EI block: "Violating the letter of this rule violates the spirit. No exceptions."

**Prevents**: the model finding a clever loophole ("technically I didn't write a _new_ test, I extended an existing one") and convincing itself the spirit is satisfied.

**Where**: once per Iron Laws section. Repeat in EI block only if EI block stands alone without an Iron Laws section.

### 2.4 Red Flags table

Two-column table: `Thought` | `Reality`. Lists the rationalisations the model produces when about to break the rules, paired with the corrective truth.

**Prevents**: the model talking itself into drift. Naming the rationalisation in advance is the most reliable counter.

**Where**: after Iron Laws. Title `## Red Flags — STOP and re-read this prompt` or `## Red Flags`.

**Example**:

```
| Thought                                       | Reality                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| "I'll add a better test while I'm here"       | Forbidden. REFACTOR after green only.                                            |
| "The existing test is wrong, let me fix it"   | Report it. STATUS: BLOCKED — test requires revision. Do NOT edit it.             |
| "I'll write code first and tests will follow" | Tests already exist. Implement against them.                                     |
```

**Quality bar for rows**: each row must be a rationalisation a model has actually produced (or would plausibly produce) on this task. Generic "I'll cut corners" rows are noise.

**Sizing**: 4–8 rows. More than 8 → the table itself becomes scannable-but-unread.

### 2.5 Decision digraph

Graphviz DOT block representing the control flow the agent must follow. Doublecircle for entry/exit, diamond for branches, box for actions.

**Prevents**: the agent inventing a shortcut that skips a node.

**Where**: at the start of the procedure section, before the prose steps. Reserve for files where the control flow is non-trivial — at least 2 branch points and 4 nodes. Don't dot-graph a linear procedure.

**Caution**: DOT is read by the model fine, but only the model sees the structure — humans need the graph rendered. Keep the prose explanation alongside.

### 2.6 Verification Checklist + "can't check all" closer

End-of-file `- [ ]` checklist tied to the Iron Laws and acceptance criteria for the agent's own output. Closer line: "Can't check every box? STATUS: BLOCKED with the reason." (or equivalent).

**Prevents**: the model declaring `STATUS: DONE` while having silently skipped a step.

**Where**: as the penultimate section, before the Final Status Block / Output Format.

**Example**:

```
## Verification Checklist (MUST pass before STATUS: DONE)

- [ ] Ran tests before writing any code and observed the RED tests fail
- [ ] Wrote the minimum code to make RED tests pass
- [ ] Ran tests after implementation and confirmed pass
- [ ] Did NOT modify any test files from the RED commit
- [ ] Output pristine (no warnings / errors)
- [ ] Committed impl with the task tag

Can't check every box? STATUS: BLOCKED with the reason.
```

**Quality bar**: each box must be a _behavior to verify_, not a _concept to remember_. "Understood the rules" is not a checkbox; "Ran tests and observed RED" is.

### 2.7 STATUS / Output Format block

Final, exact-format output requirement — terminating sentinel the harness parses.

**Prevents**: the model writing prose where the harness expects structured output.

**Where**: last section of the file. Must be exhaustive — list every legal output and the semantics of each.

**Wrap in EI tag** when the harness will hard-fail on malformed output. If a parser anchors on a specific block (e.g. `## Verdict`), the format requirement is load-bearing — escalate it.

### 2.8 CAPS for prohibitions

Use sparingly. CAPS works when surrounded by lower-case prose; constant CAPS is illegible.

**Where**:

- `NEVER`, `MUST`, `DO NOT` at the start of a rule.
- Whole-line caps inside the EI block (one or two lines max).
- Section headings stay sentence-case ("Iron Laws", not "IRON LAWS").

**Anti-pattern**: caps in the middle of paragraphs. "The function MUST validate input before CALLING the sink and SHOULD log failures" is unreadable.

### 2.9 "No exceptions" loophole-naming list

When the model is likely to argue an edge case justifies bending a rule, pre-empt by listing the would-be exceptions and rejecting each.

**Where**: under the Iron Law it qualifies, or as a `### No exceptions` subsection.

**Example**:

```
### No exceptions
- "The test was already passing" — verify it actually fails first; if it doesn't, the test is wrong, report BLOCKED.
- "I only added a docstring, not real code" — still impl-without-test, still forbidden.
- "Refactor doesn't count as new code" — if it changes runtime behavior, it counts.
```

Use only when an Iron Law has known exception-shaped rationalisations.

### 2.10 Final Rule / Bottom Line

One line at the very end (after the Output Format), restating the file's core in 6–10 words.

**Prevents**: long-tail forgetting — the last thing the model reads tends to stick.

**Example pattern**: "Quote the diff → cite the line → ship the verdict block." or "Tests first. Implementation second. Nothing in between."

**Where**: literal last line. Skip if Output Format block is itself short and memorable.

### 2.11 `<SUBAGENT-STOP>` guard (skills only)

When a skill is loaded by both the main loop and subagents, but the procedure only applies to the main loop, prepend:

```
<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill.
</SUBAGENT-STOP>
```

**Where**: inside the skill body, immediately after frontmatter. Not relevant to agent files (agents are subagents).

## 3. Decision matrix — which devices for which file

| File class                                        | EI block | Iron Laws | Letter=Spirit | Red Flags | Digraph | Checklist | Output Block | CAPS | Loophole list | Final Rule |
| ------------------------------------------------- | -------- | --------- | ------------- | --------- | ------- | --------- | ------------ | ---- | ------------- | ---------- |
| Executor agent (writes code under TDD discipline) | ✅       | ✅        | ✅            | ✅        | ◯       | ✅        | ✅           | ✅   | ◯             | ◯          |
| Reviewer agent (adversarial code review)          | ✅       | ✅        | ✅            | ✅        | ✗       | ✅        | ✅           | ✅   | ◯             | ✅         |
| Spec/planning agent (PRD → spec, spec validation) | ✅       | ✅        | ✅            | ✅        | ✗       | ✅        | ✅           | ◯    | ✗             | ◯          |
| Diagnostic agent (rescue, triage)                 | ◯        | ✅        | ◯             | ✅        | ◯       | ◯         | ✅           | ◯    | ✗             | ◯          |
| Doc-writing agent                                 | ✗        | ✅        | ◯             | ◯         | ✗       | ◯         | ✅           | ✗    | ✗             | ✗          |
| Orchestrator skill (drives a stage machine)       | ◯        | ✅        | ◯             | ✅        | ✅      | ◯         | ✅           | ◯    | ◯             | ◯          |
| Protocol skill (defines output contract)          | ✅       | ✅        | ✅            | ✅        | ✗       | ✗         | ✅           | ✅   | ◯             | ✅         |
| Discipline skill (TDD, debugging, etc.)           | ✅       | ✅        | ✅            | ✅        | ◯       | ✅        | ✗            | ✅   | ◯             | ◯          |
| Recovery skill                                    | ◯        | ✅        | ◯             | ✅        | ◯       | ◯         | ✗            | ◯    | ✗             | ◯          |

Legend: ✅ required, ◯ optional (use if drift observed), ✗ omit (would be noise).

The matrix is a starting point, not a contract. If a file has a single dominant failure mode, lean harder on the device that addresses it — even if the matrix says optional.

## 4. Frontmatter rules

- `description`: third-person, action-first, includes the trigger condition. "Reviews code changes for security vulnerabilities…" not "I review code changes…".
- `whenToUse`: avoid as a separate field. Fold into `description`. Two fields invite drift between them.
- `tools`: list explicitly. No wildcard. Fewer is better — read-only review agents need only `Read`, `Grep`, `Glob`.
- `model`: pick deliberately. Lower-tier model for mechanical executors, higher-tier for reasoning-heavy reviewers and test authors.
- `maxTurns`: tighten. High caps mask runaway loops.
- `isolation: worktree` on agents that mutate the repo, when the harness supports it.

**No workflow summaries in frontmatter.** Frontmatter is metadata, not a TOC. Description should not list the steps of the procedure — that lives in the body and drifts independently otherwise.

## 5. Worked transformations

Three before/after examples. Each is a recurring shape; the same patterns apply across peers in the same file class.

### 5.1 Output-contract skill where the parser silently drops malformed findings

Symptom: a verbatim-quote rule is one of seven plain-prose rules. The harness drops findings that violate it — load-bearing rule presented as one rule among many.

**Before**:

```
## Rules

1. Zero implementation context. ...
2. Assume it's wrong until proven correct. ...
3. Never suggest "looks good" without evidence. ...
4. Only BLOCKING findings trigger REQUEST_CHANGES. ...
5. Do NOT modify code. ...
6. Every finding MUST quote a real diff line. The harness drops findings whose verbatim text doesn't appear in the diff ...
```

**After**:

```
<EXTREMELY-IMPORTANT>
## Iron Law

EVERY FINDING MUST QUOTE A REAL DIFF LINE.

Each finding carries a Verbatim field — an exact 10+-character substring copied verbatim from the diff. The harness DROPS findings whose verbatim text is not in the diff. Fabricating a quote is worse than omitting the finding.

Violating the letter of this rule violates the spirit. No exceptions.
</EXTREMELY-IMPORTANT>

## Iron Laws

1. **Zero implementation context.** You know NOTHING about how this code was written.
2. **Assume it's wrong** until proven correct.
3. **No PASS without file:line evidence.** "Looks good" alone is not a finding.
4. **Only BLOCKING findings trigger REQUEST_CHANGES.**
5. **Do NOT modify code.** You report; the Actor fixes.

## Red Flags — STOP and re-read this prompt

| Thought | Reality |
| --- | --- |
| "Code looks fine, I'll APPROVE" | Cite the file:line you verified. No citation = no APPROVE. |
| "I'll describe the issue without quoting" | Harness drops it. Quote 10+ chars verbatim or drop the finding. |
| "The diff is obvious; quoting is busywork" | The quote is parser input, not commentary. Required. |
| "I'll paraphrase the line, close enough" | Substring match is exact. Paraphrase fails the parser. |
| "More findings = better review" | Signal/noise. Drop everything below 5/10 likelihood × impact. |
| "I'm uncertain — flag it as BLOCKING just in case" | Mark UNCERTAIN. Fabricated blockers waste review cycles. |
```

The Output-format block at the end gets wrapped in `<EXTREMELY-IMPORTANT>` since the parser hard-fails without it. Final Rule line at the literal end: "Quote the diff → cite the line → ship the verdict block."

### 5.2 Reviewer agent with "Critical Principles" and "Hard Rules" duplication

Symptom: same idea labelled twice, evidence-quote requirement is principle #2.

**Transformation**:

- Top-level `<EXTREMELY-IMPORTANT>` wrapping evidence-quote + structured-reasoning template (e.g. PREMISE/EVIDENCE/TRACE/CONCLUSION) as the _one_ law that, if skipped, makes everything else worthless.
- "Critical Principles" → `## Iron Laws`, evidence-quote moves to #1.
- New `## Red Flags` table after Iron Laws. Rows target the rationalisations specific to reviewer drift: surface-level approval ("I see auth, must be fine"), trusting diff context without reading the file, applying general OWASP knowledge instead of code-traced findings, treating test presence as test coverage, padding thin reviews.
- "Hard Rules" merges into Iron Laws — drop the duplication.
- Self-verification list moves to the end as the canonical Verification Checklist with "drop the finding" closer.
- Output Format wrapped in `<EXTREMELY-IMPORTANT>`.

### 5.3 Spec-alignment reviewer where evidence-quote requirement is implicit

Symptom: agent expected to map acceptance criteria to code, but the requirement to _cite_ code is unstated.

**Transformation**:

- `<EXTREMELY-IMPORTANT>`: "Every acceptance criterion must be answered with a verbatim code citation OR a missing-evidence finding."
- Iron Laws:
  1. ONE CRITERION = ONE CITATION OR ONE BLOCKER.
  2. NO APPROVE WITHOUT TRACING THE END-TO-END USER PATH.
  3. NO BLOCKERS FOR OUT-OF-SCOPE CONCERNS — note as NON-BLOCKING.
- Red Flags rows: "Tests pass so the criterion is met" / "Code looks similar to the spec, good enough" / "I'll just summarise instead of quoting" / "This concern is important even if out of scope".
- Required final block (acceptance-criteria table + verdict) wrapped in `<EXTREMELY-IMPORTANT>`.

## 6. Anti-patterns — when NOT to add devices

- **Iron Law inflation.** Adding a 6th, 7th, 8th Iron Law dilutes the first five. If a rule is genuinely subordinate, demote it to "Rules" or remove it.
- **EI tag overuse.** One EI block per file. Two means neither is extreme.
- **Red Flags as a brain dump.** Every row must be a rationalisation a model has actually produced (or would plausibly produce _on this specific task_). "Don't be lazy" is not a Red Flag row.
- **CAPS in paragraphs.** Caps lose force when surrounded by more caps. Reserve them for line starts and one-line EI lines.
- **Digraph for linear flows.** A digraph with no branches is just an ordered list with extra steps.
- **Verification Checklist that restates the Iron Laws.** The checklist is for the agent's _output_, not for re-reading the rules. "Understood the rules" is not a behavior to verify.
- **Final Rule that contradicts the Iron Laws.** The final line is the last word the model reads. If it summarises imperfectly, it overrides the body. Quote-test it against the laws before shipping.
- **"Clever" Red Flags rows referencing the agent's name or in-jokes.** Rationalisations are universal cognitive shortcuts; they should read as such.
- **Frontmatter as TOC.** Listing the procedure in the description guarantees the description and the body diverge.

## 7. Application protocol

For each rigid file:

1. Read the file.
2. Identify the file class from section 3 and load the matrix row.
3. Apply every device marked ✅; consider every ◯ based on observed drift.
4. Preserve all existing technical content — transformation is structural, not content removal. Rules get reorganised, escalated, or re-framed, never deleted.
5. Self-verify against the matrix row. If a required device is missing, fix before moving on.

When applying across many files, dispatching a fresh subagent per _tier_ (group of files in the same class) gives context isolation while preserving cross-file consistency within the tier. One subagent per individual file fragments style; one subagent for everything bleeds context. Per-tier is the middle ground.

**Subagent prompt template**:

```
You are restructuring N agent/skill files to apply adherence devices defined in
<path-to-this-guide>. You have read-write access to the listed target files only.

REFERENCE: Read <path-to-this-guide> in full before any edit.

EXEMPLAR: <path-to-canonical-exemplar-file>. Do NOT modify. Read for structure.

TARGETS: <list of file paths in this tier>

For each target file:
1. Read the file.
2. Identify the file class and load section 3's matrix row.
3. Apply every device marked ✅; consider every ◯ based on the file's failure mode.
4. Preserve all existing technical content. Transformation is structural — no
   rules removed, only reorganised, escalated, or re-framed.
5. After editing each file, self-verify against the matrix row. If a required
   device is missing, fix before moving to the next file.

CONSTRAINTS:
- Frontmatter: drop any `whenToUse` field, fold into `description`. No workflow summaries.
- Cross-file consistency within the tier: peer files should share Red Flags row
  patterns where the failure modes overlap.

OUTPUT: brief diff summary per file plus self-check results. End with
STATUS: DONE if all targets pass self-check, STATUS: BLOCKED — <reason> otherwise.
```

## 8. Author review checklist

Before merging a file restructured under this guide, verify:

- [ ] EI block present where the matrix requires it; contains exactly one law.
- [ ] Iron Laws ≤ 5 items; each is a hard prohibition or hard requirement.
- [ ] Letter=Spirit clause present and not parroted in multiple places.
- [ ] Red Flags rows are real rationalisations, not generic ones.
- [ ] Verification Checklist verifies _behaviors_, not _concepts_.
- [ ] Output Format / STATUS block is the literal last section (or second-to-last if a Final Rule line follows).
- [ ] Frontmatter has no `whenToUse` and no workflow summary.
- [ ] CAPS used at line starts and EI block only.
- [ ] No new device added without observed drift justifying it.

Can't check every box? The file is not done.

## 9. Bottom Line

Devices compound. EI block + Iron Laws + Red Flags + Verification Checklist together produce adherence; any one alone produces partial drift. Apply the matrix. Trust the exemplars.
