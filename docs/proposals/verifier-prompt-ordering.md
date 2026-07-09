# Verifier Prompt Ordering — proposal

**Status:** **PROPOSED** (2026-07-09). Not implemented. The numbered Decision (D65) is written when
it is built, not now.
**Problem:** the finding-verifier's prompt is rendered by the runner, from the reviewer's **raw**
output, **before** the engine's deterministic citation filter has run. The agent body, the glossary,
and `docs/explanation/verifier.md` all described the opposite order.
**Scope:** replaces the `verifier_spec` template surface with an engine-composed per-finding
`AgentSpec`. Unblocks `Finding.extra_citations`. Deletes more than it adds.

---

## 1. The defect

`skills/pipeline-runner/SKILL.md:456-466`, step **3** of the verify round:

> for EACH finding that is `blocking:true` AND citable, spawn an INDEPENDENT finding-verifier using
> `manifest.verifier_spec` VERBATIM … Render `verifier_spec.prompt_template` by substituting EXACTLY
> `verifier_spec.interpolate_fields`.

Step **4** writes the results file; `factory next-action --results` then calls `runPanel`, which calls
`verifyCitations` (`src/verifier/judgment/panel-run.ts:98`). So the real wall-clock order is:

```
reviewers return raw JSON
      │
      ├─▶ runner renders N verifier prompts from the RAW findings      ← step 3
      ├─▶ N verifiers run and return {holds, note}
      │
      └─▶ factory next-action --results                                ← step 4
              ├─▶ verifyCitations: DROP hallucinated, RELOCATE miscounted, REDACT secrets
              └─▶ confirmBlocker: join each kept finding to its verdict by file:line
```

`src/core/phase-machine/spawn.ts:124-134` states the cause without flinching: _"A template, not a
per-finding spec — the finding set is only known after the panel returns."_ True today, and the whole
reason the template exists. But it is only true because the panel's output is not recorded before the
verifiers are spawned. Record it first and the finding set **is** known.

### Three consequences, each verified

1. **`agents/finding-verifier.md` asserted a fact about the past that never happened.** Before the
   companion commit, `:35-39` read _"Before you were spawned, a deterministic filter confirmed this
   finding's `quote` matched real source, and dropped every finding whose quote did not."_ No filter
   ran. Iron Law 3 then branched on states the verifier cannot observe — _"the quote contained a
   secret and was scrubbed to `[REDACTED]`"_ — because nothing had redacted it. Those statements are
   deleted; the agent body now tells the truth about its own position in the pipeline. **The
   correction is shipped. This proposal is what makes the original claim true.**

2. **`ClaimOnlyFinding` never reaches an LLM.** Its `description?: never` / `severity?: never` leak
   guards (`src/verifier/judgment/finding-verifier.ts`) protect a value that flows only into
   `makeReplayRunnerFactory`'s `confirm()` (`src/orchestrator/record.ts:339`), which reads exactly
   `finding.file` and `finding.line` to look up a pre-recorded verdict. Anti-anchoring is really
   enforced by the `interpolate_fields` whitelist plus prose in `pipeline-runner/SKILL.md` — a
   string array and a paragraph. The type is insurance against a future live runner, documented as
   such in `docs/glossary.md`.

3. **Every verifier spawn is unconditional.** A finding whose quote is fabricated still gets an
   Opus-pinned worktree subagent, whose verdict is then thrown away when `verifyCitations` drops the
   finding at record time. Wasted tokens, proportional to reviewer hallucination rate — which
   `citation_rate` (`factory score --reviewers`) will now measure.

### What it is not

**Not a secret-leak hole.** `redactSecrets` protects text the engine **persists or surfaces** —
reports, `state.json`, `fix_findings`. The verifier reads the same repository the reviewer read, with
the same tools. A quote it receives unredacted is a quote it could `Grep` for itself.

---

## 2. Design: split `verify` into two turns

`verify` becomes a coroutine with an emit/record split, exactly like the run-level e2e phase
(`src/orchestrator/e2e.ts:13-20`, three spawn sites discriminated by `expects`) and `docs.ts`. This
is not a new pattern in this engine; the verify phase is the last one that squeezes two agent
generations into a single turn.

**Turn 1** — unchanged panel spawn. `expects: 'reviews'`. The runner spawns the risk-invariant panel
and returns `{reviews: [...]}`.

**Turn 2** — the engine records the raw reviews, runs `verifyCitations` over the blocking findings,
and emits a _new_ spawn:

```jsonc
{
    "kind": "spawn",
    "expects": "verifications",
    "resume_phase": "verify",
    "agents": [
        {
            "role": "finding-verifier",
            "agent_type": "finding-verifier",
            "model": "…",
            "isolation": "worktree",
            "prompt": "<fully composed, verbatim>",
        },
        // one per KEPT finding
    ],
}
```

`AgentSpec.prompt` is already the engine-composed, spawn-verbatim contract for every producer
(`docs/reference/engine-vocabulary.md:73-77`). The verifier is the lone exception. This proposal
removes the exception rather than special-casing it.

**Turn 3** — the runner posts `{verifications: [...]}`; the engine joins each verdict to its kept
finding and derives the merge gate. `confirmBlocker`'s file:line join, the fail-closed
missing-verdict → `status: 'error'` path, and `deriveMergeGateVerdict` are untouched.

### Where the raw reviews live between turns

The ephemeral `runs/<run-id>/` directory, **not** `state.json`. They are turn-scoped scratch, not
run state; persisting them durably would be a derive-don't-store violation and would bloat the state
document with text nothing reads after the gate derives.

---

## 3. What it deletes

| Deleted                                                                                                                                                     | Why                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `VerifierSpecSchema.prompt_template`, `.interpolate_fields` (`src/core/phase-machine/spawn.ts:140-141`)                                                     | No template survives; the prompt is composed.                                                         |
| `VERIFIER_PROMPT_TEMPLATE`, `VERIFIER_INTERPOLATE_FIELDS` (`src/verifier/judgment/panel.ts:82,168-169`)                                                     | Same.                                                                                                 |
| `pipeline-runner/SKILL.md:456-466` rendering paragraph                                                                                                      | The runner stops rendering anything. It spawns `agents[]` verbatim, as it already does for producers. |
| The anti-anchoring rule, currently duplicated in `pipeline-runner/SKILL.md`, `review-protocol/SKILL.md`, `engine-vocabulary.md:83-89`, and `cli.md:677-679` | The rule becomes a TypeScript function that builds a prompt from a `ClaimOnlyFinding`. One home.      |
| The glossary's "the type is not currently the enforced boundary" invariant                                                                                  | It becomes the boundary.                                                                              |

`ClaimOnlyFinding`'s `?: never` guards stay and finally enforce something: the prompt is built from
that projection in TypeScript, so `description` cannot reach the verifier without a compile error.
Today it cannot reach it because a string array happens not to name it.

## 4. What it enables

**`extra_citations`** — the follow-up that produced this proposal. `Finding` gains
`extra_citations?: {file, line, quote}[]`. The systemic-failure-reviewer requires ≥2 verbatim anchors
per finding (`agents/systemic-failure-reviewer.md:28-51`), and today its 2nd+ anchors survive only as
prose inside `description` — the one field anti-anchoring forbids passing. So its verifier judges a
cross-file, cross-stage claim through a single-file keyhole.

Under this design the extras are citation-verified, relocated, and redacted like the primary, then
rendered into the composed prompt. A bad extra is dropped; the finding survives on its primary
citation. Roughly 20 lines: a schema field, a loop in `verifyCitations`, a `join` in the prompt
builder. Against the current ordering it is unimplementable — the field is an array, and
`interpolate_fields` is a flat scalar whitelist substituted by an LLM.

**No wasted verifier spawns.** Citation-verify runs before the fan-out, so a fabricated citation
costs a `Grep`, not an Opus worktree subagent.

## 5. Costs and risks

- **One extra round-trip per verify round.** The panel and the verifiers no longer overlap. They
  never truly overlapped — the runner already blocks on the panel before rendering — so the cost is
  one `factory next-action` call, not one agent generation.
- **Crash-resume across the new boundary.** The engine must be idempotent between "reviews recorded"
  and "verifications recorded". The existing `result_key: {phase, rung}` guard covers phase-level
  replay; a turn discriminator (`expects`) must be added to it, or a second `--results` post of the
  same shape could be misrouted. This is the one place the design can go wrong quietly, and it needs
  a test that posts `reviews` twice.
- **Raw reviews must survive a runner restart** mid-verify, or the round restarts from the panel
  spawn. Restarting from the panel is correct-but-expensive; that is the acceptable failure mode, and
  the reason the reviews go to `runs/<run-id>/` rather than being held in memory.

## 6. Sequencing

Ships **after** the funnel telemetry (`citation_rate` / `confirm_rate`, landed alongside the agent-body
correction). Two reasons, in order:

1. `citation_rate` measures exactly the waste this proposal eliminates — how many verifier spawns are
   burned on findings citation-verify will drop.
2. `confirm_rate`, read per-lens, falsifies or confirms the premise behind `extra_citations`. If the
   systemic-failure-reviewer's `confirm_rate` is **not** materially below the other lenses', then its
   verifiers are not being starved by the single-citation keyhole, and `extra_citations` should be
   dropped from this proposal's scope. The ordering fix stands on its own either way — the agent body
   should not have to lie about when it runs.
