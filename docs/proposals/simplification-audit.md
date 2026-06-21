# Simplification Audit & Recommendations

> Status: proposal. Produced 2026-06-21 from a 20-agent functionality census of every
> module. North star unchanged: **produce the highest-quality code with zero human
> intervention.** Target: move complexity _toward_ `superpowers` but land **mid-spectrum** —
> keep the deterministic quality engine, cut the accreted scaffolding around it.

## 1. Executive summary

The factory is **two things welded together**: a genuinely load-bearing deterministic
quality engine, and a thick layer of accreted scaffolding around it (a second execution
driver, dead/parallel code paths, inert config, observability sinks, and human-in-the-loop
prompts). The census confirms the split numerically — of **593 functionalities** across
20 modules, only **33 (5.6%)** are unnecessary complexity, but those 33 cluster into a
handful of cross-cutting patterns that account for the bulk of the "ancillary features that
introduce bugs" the brief calls out.

The single most important finding: **the quality core is not the problem.** The modules that
make lights-out quality possible — `core-state`, `stage-machine`, `git`, the `driver`
coroutine, the deterministic gate runner, the judgment panel — carry **zero or near-zero**
unnecessary-complexity items and are ~85–95% essential. The complexity that hurts lives in
the _periphery_: a second driver nobody needs two of, code paths that are tested but never
run, knobs that are documented but never read, and a Stop hook that can hold a session
hostage.

That means the caveat resolves cleanly. You do **not** have to choose between "mid-spectrum
simplicity" and "highest quality without humans." The cuts below remove ~3,000–3,500 lines
of engine TS (~12–14%) plus a much larger reduction in _modes, flags, and surface area_ —
**without touching a single quality mechanism.** The mental model collapses from "two ways
to run, three lifecycle modes, knobs that may or may not do anything, a stop hook that may
trap you" to "one driver, predictable stop, what-you-read-is-what-runs, knobs that work."

## 2. Module catalogue & functionality census

Catalogued from `docs/architecture/components.md`, then every functionality enumerated and
categorised by an independent agent per module. `C`=critical, `I`=important, `N`=nice-to-have,
`X`=unnecessary-complexity. LOC is approximate module footprint (TS + markdown + templates).

| Module                          |  LOC |       C |       I |      N |      X | Essential?                                     |
| ------------------------------- | ---: | ------: | ------: | -----: | -----: | ---------------------------------------------- |
| `core-state`                    | 1469 |      19 |      17 |      5 |      0 | ~85% — the trust anchor (derive-don't-store)   |
| `stage-machine`                 |  370 |      16 |       2 |      1 |      0 | ~100% — closed vocab + invariants              |
| `git`                           | 2135 |      22 |       7 |      5 |      0 | ~95% — idempotent PR/merge, worktree lifecycle |
| `foundation` (shared/types/bin) | 1338 |      10 |       9 |      2 |      0 | ~90% — atomics/lock/exec substrate             |
| `verifier-holdout`              |  648 |       0 |      11 |      2 |      0 | ~100% _if feature kept_ (see §6)               |
| `driver`                        | 2840 |      27 |      11 |      6 |      2 | ~80% — the pipeline itself                     |
| `hooks`                         | 2580 |      30 |       9 |      3 |      1 | ~70% — security guards essential               |
| `verifier-deterministic`        | 2244 |      17 |       8 |      5 |      2 | ~60–65% — gate runner essential                |
| `cli`                           | 3967 |      19 |      18 |      7 |      2 | ~60–65% — coroutine seam essential             |
| `agents`                        | 1515 |      14 |       8 |      2 |      1 | ~90% — 11/13 spawned by name                   |
| `verifier-judgment`             |  858 |      12 |       7 |      4 |      2 | ~80% — anti-hallucination chain                |
| `spec`                          | 1261 |      14 |       6 |      2 |      2 | ~80% — gates + store                           |
| `producer`                      | 1217 |      13 |       7 |      4 |      1 | ~50% live / ~50% dead                          |
| `skills`                        | 1837 |      25 |      20 |      4 |      5 | ~75% — 5/6 skills essential                    |
| `commands`                      |  529 |      11 |       9 |      9 |      2 | ~40% essential, thin by design                 |
| `rescue`                        |  533 |       9 |       5 |      5 |      1 | ~80% core                                      |
| `config`                        |  490 |       5 |       8 |      5 |      4 | load-bearing minus dead sections               |
| `quota`                         |  676 |       6 |       5 |      3 |      4 | ~55–60% essential                              |
| `scoring`                       |  803 |       4 |       1 |      9 |      3 | ~32% essential (partial-report)                |
| `packaging`                     | 4109 |      14 |      17 |      5 |      1 | ~40% critical / ~35% workflow / ~25% redundant |
| **Total**                       |      | **287** | **185** | **88** | **33** |                                                |

Read the table top-to-bottom: the high-essential, zero-X modules at the top are the spine.
The bottom — `scoring`, `quota`, `config`, `packaging`, `commands` — is where complexity
concentrates relative to value.

## 3. The quality spine (DO NOT CUT)

To honour the caveat, fix the floor first. These are the mechanisms that make a machine,
not prose, the arbiter of quality — the reason this can be lights-out at all. Everything in
§5 is designed to leave every one of these intact:

- **`core-state` — derive-don't-store.** The schema holds no gate pass/fail booleans; every
  verdict is recomputed from ground truth. This is the structural reason an agent can't forge
  a quality pass. Closed enums + atomic/locked writes. **0 X items.**
- **`stage-machine`** — closed stage vocabulary + the two invariants (exhaustive dispatch,
  bounded finalize) that killed the bash predecessor's silent-advance/finalize-spin bugs.
- **`driver` coroutine** (`next` + `coroutine` + `fold` + `transitions`) — the deterministic
  control flow; ~2,200 LOC of heavily-tested logic shared verbatim by the driver(s).
- **`verifier-deterministic`** gate runner + strategies (test/tdd/coverage/mutation/sast/
  type/lint/build) — the machine-checkable floor between executor and ship.
- **`verifier-judgment`** panel + citation-verify + independent finding-verifier — the two
  anti-hallucination mechanisms (deterministic citation check + independent confirmation).
- **`git`** — idempotent PR create/merge, serial-merge lock, worktree base invariant (D12).
  **0 X items, ~95% essential.**
- **`hooks` security guards** — TCB write-deny, branch-protection, secret-guard. The
  executor-can't-corrupt-the-gates boundary.
- **`producer` live core** — `classify`, `model-dial`, `prompt-context`, `parseProducerStatus`.

This spine is ~15–17k LOC of TS. It is _why_ the factory can claim quality without a human,
and it is precisely what distinguishes mid-spectrum from superpowers. It stays.

## 4. Cross-cutting complexity patterns

The 33 X-items and the footgun inventory collapse into **eight recurring patterns**. Naming
them matters more than the line items, because each is a _class_ of bug/confusion:

1. **The two-driver architecture (`--mode workflow`).** The single largest accidental-
   complexity locus. It forces a second copy of envelope parsing (`scripts/factory-run-driver.js`
   keeps a _byte-for-byte inline copy_ of `workflow-envelope.ts` — drift silently reopens the
   envelope-corruption bug `run-20260616-134715`), an `FsArtifactStore` (haiku exec-agents
   can't share memory), a `mode==='workflow'` quota _bypass_ in the gate (unattended workflow
   runs have **no budget guard**), and an LLM exec-agent in the stdout transport path that
   "cannot be made trustworthy by prompt." The design doc itself admits Workflow's quota story
   is its weakest point. Spread across `driver`, `quota`, `core-state`, `commands`, `packaging`.

2. **The Stop-hook session-hostage** _(the named pain)._ `src/hooks/stop-gate.ts:110-129`
   emits `{decision:"block"}` while a `running` run has pending work — so if the pipeline is
   _stuck_ (quota-blocked, engine bug, spec failure), the owning session **cannot exit** except
   via the non-obvious `FACTORY_ALLOW_STOP=1`. Workflow mode _already_ bypasses this arm —
   proof it is not structurally necessary. It also spawned `factory run cancel` into existence
   purely as an escape hatch (a mutually load-bearing footgun pair), and degrades unsafely when
   `owner_session` is unknown (then it gates _every_ session, not just the owner).

3. **Dead/parallel code paths that pass tests but never run.** ~800–1,000 LOC that gives
   _false confidence_: `producer/runLadder` + `fix-forward.ts` (~360 LOC — the live driver
   re-expresses the ladder as persisted `escalation_rung` state and never calls these),
   `verifier-judgment/rebuttal.ts` (117 LOC, dead), `quota/router.ts:quotaGate` +
   `to-stage-result.ts` (~107 LOC, parallel to the live `quota-gate.ts`),
   `quota/circuit-breaker.ts` (97 LOC, **exported + tested + never called** — so a runaway run
   has no abort), `spec/runSpecPipeline` (parallel to the 3-action CLI),
   `verifier-deterministic/runGatesInCleanCheckout` (0 callers) + `GateMemo` (never achieves a
   cache hit), `scoring/readMetrics`, and the dead `ship` handler in `driver/handlers.ts`.

4. **Silently-inert features (false affordances).** Config/knobs that promise behaviour that
   doesn't exist: `config` `observability`/`dependencies`/`scribe` schema sections (never
   read), `git.stagingBranch` (documented no-op since Decision 33), **`tdd_exempt` (a
   documented opt-out that does nothing — `exemptReader` is never wired, so exempt tasks are
   still blocked)**, the coverage gate (no producer writes the coverage JSON it reads — likely
   always skips), and the cross-vendor verifier (`vendor.ts` detects Codex but `fold.ts` never
   switches the runner to it). These are worse than dead code: they invite operators to rely
   on behaviour that isn't there.

5. **Over-built observability / scoring.** `scoring` is 803 LOC of which only ~253
   (`partial-report.ts`, which builds the rollup PR body + per-drop issues) is critical.
   `dead-surface.ts` (~230 LOC) wraps the deprecated `ts-prune`, is report-only, gates nothing.
   `telemetry` is write-only with no consumer. `RunSummary` re-rolls data already in the
   report. The two `settings.autonomous.json` `PostToolUse` hooks (per-file vitest + tool-audit
   JSONL) add latency to every agent write with no circuit breaker.

6. **Autonomy preflight / version-staleness scaffolding.** `cli/subcommands/autonomy.ts`
   (~350 LOC) forces a **manual session relaunch on every plugin version bump** — purely to
   refresh a settings file the pipeline never reads after launch. The hard gate
   (`requireAutonomousMode`) already provides the correctness backstop. This actively fights
   the unattended-overnight use case.

7. **Human-in-the-loop prompts inside a lights-out pipeline.** `AskUserQuestion` gates that
   block indefinitely with no timeout when nobody's watching: the run-conflict three-way
   prompt (`pipeline-orchestrator` / `commands/run.md`), the rescue dead-end prompt
   (`rescue-protocol`), and the debug quota prompts. The design brief explicitly marks all of
   these "scaffolding to retire."

8. **Duplicated security/utility logic that can diverge.** `settings.autonomous.json` inline
   bash guards duplicate the typed, tested TS hooks (a security-regression surface — the two
   can never stay in sync); `isTestPath` has two definitions with _different_ semantics
   (`scope.ts` oracle vs `pipeline-guards.ts` ad-hoc) so the hook guard and the TDD gate
   disagree on what a test file is; nested-shell denial is duplicated across three guards with
   slightly different activation conditions.

## 5. Recommendations (sequenced)

Ordered by (value × safety). Phases 0–1 are near-zero-risk and remove most of the footguns;
Phase 3 is the biggest single simplification; Phase 5 needs your decision (§6).

### Phase 0 — Honesty pass: every feature works or is removed (do first; these are _bugs_)

Not complexity cuts — **correctness**. The audit flags these as features that silently don't
work. Verify each (these are dynamic-behaviour claims), then fix-or-remove. No silent-inert
middle state allowed to remain.

| Item                               | Location                                                            | Action                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tdd_exempt` inert                 | `verifier-deterministic/tdd-exempt.ts`, `driver/{handlers,fold}.ts` | Wire `DefaultExemptReader` into `GateContext` (~5–10 lines) **or** remove the option                                                                                                             |
| **Ship gate may always block**     | `hooks/pipeline-guards.ts` ship arm                                 | **Verify:** `gateEvidence` can't be injected through the `hooks.json` subprocess → floor derives from empty evidence → `gh pr create` blocked. If confirmed, this is critical — re-home the gate |
| Coverage gate never fires          | `verifier-deterministic` coverage strategy                          | Nothing writes `coverage/*-summary.json`. Wire a producer/scaffold step or document as opt-in                                                                                                    |
| Cross-vendor verifier not switched | `verifier-judgment/vendor.ts` + `fold.ts`                           | Wire the Codex runner switch **or** collapse to a single `log.warn`                                                                                                                              |
| `isTestPath` divergence            | `hooks/pipeline-guards.ts` vs `verifier/deterministic/scope.ts`     | Delete the local copy; import the `scope.ts` oracle                                                                                                                                              |

### Phase 1 — Delete dead/parallel code (zero behaviour change, removes false test confidence)

Pure subtraction, ~1,900 LOC + their tests. What you read becomes what runs.

- `producer`: delete `runLadder`, `runFixForward`, the inner patch loop, `FIX_FORWARD_*`,
  the rebuttal clause (~360 LOC). Keep `agents.ts`, `classify.ts`, `model-dial.ts`,
  `prompt-context.ts`. (1217 → ~450 non-test LOC.)
- `verifier-judgment`: delete `rebuttal.ts` + the unreachable rebuttal branch (~150 LOC).
- `quota`: delete `router.ts:quotaGate` + `to-stage-result.ts` (~107 LOC). **Decide
  `circuit-breaker.ts`:** wire it into `next.ts`/`coroutine.ts` (it's the _only_ runaway-abort
  mechanism) or delete it — do not leave it exported-but-dead.
- `spec`: delete `runSpecPipeline` (keep `buildManifest`).
- `verifier-deterministic`: delete `runGatesInCleanCheckout` (0 callers); remove the `GateMemo`
  caching layer (never hits) or wire a shared memo.
- `scoring`: delete `dead-surface.ts` (~230 LOC, deprecated tool, gates nothing), `telemetry`,
  `readMetrics`, and collapse `RunSummary` into `partial-report.ts`. (803 → ~280 LOC, ~−65%.)
- `driver`: delete the dead `ship` handler in `handlers.ts:305-317` (route all ship through
  `shipTask`).
- `config`: delete the `observability`, `dependencies`, `scribe` schema sections and the
  `git.stagingBranch` no-op key.

### Phase 2 — Kill the session-hostage (the named pain)

- Remove the **block arm** of `decideStop` (`stop-gate.ts:110-129`); keep **only**
  finalize-on-stop. A stuck run stays resumable via `factory resume` — a dangling run is
  strictly better than a trapped session.
- This makes `factory run cancel` redundant → remove it (resolves the load-bearing footgun
  pair). The `owner_session` unsafe-degradation footgun loses its blast radius (no block arm →
  no hostage even when owner is unknown).

### Phase 3 — Retire `--mode workflow` (largest single simplification)

One driver = one way to run = the mental model halves. Removes the worst drift footgun (the
byte-copy `parseEnvelope`) and the untrusted-LLM-in-transport path.

- Delete `scripts/factory-run-driver.js` (463), `driver/workflow-envelope.ts` (~160), the
  `FsArtifactStore` requirement, the `mode==='workflow'` quota bypass, and the `RunMode`/`mode`
  branches in `core-state` + `commands`.
- **Trade-off (your call, §6):** this gives up background/parallel execution. The in-session
  orchestrator loop provides equivalent autonomous capability; the design doc concedes the
  Workflow substrate is immature (concurrency, quota, exec-agent wrapping all unfinished).

### Phase 4 — Retire human-in-the-loop scaffolding (the design's own "to retire" list)

- Remove the **autonomy preflight + `_factoryVersion` staleness** machinery
  (`autonomy.ts`, ~250 LOC). Keep `ensure` (initial setup) + `status` (diagnostics); rely on
  the hard `requireAutonomousMode` gate.
- Replace the three `AskUserQuestion` gates with deterministic defaults: run-conflict →
  auto-resume-if-active (supersede only on explicit re-`--issue`); rescue dead-end →
  always route through the diagnostic agent.
- **Quarantine `/factory:debug`** (command + skill): it references six retired bash bins, is
  documented broken in CLAUDE.md, and duplicates the quota ladder + autonomy gate in an
  _interactive_ tool where neither belongs. Delete it or split it into a separate plugin
  (~400 markdown LOC + the CLI surface it implies). It is orthogonal to PRD→PR delivery.
- Remove the `settings.autonomous.json` inline bash guards + `PostToolUse` observability hooks;
  rely solely on the typed plugin hooks (higher fidelity, fail-closed, tested).

### Minor cleanups (do alongside any phase)

- `cli`: drop the `factory resume` top-level alias (duplicate of `factory run resume`),
  `config-defaults` (covered by `configure`), `state --summary`, statusline chaining.
- `producer`: move `FakeVendorProbe` out of producer fakes (it's a judgment-layer type).
- `agents`: remove `scribe`'s version-bump side-effect (Phase 4 of scribe.md) — couples docs
  with release management and writes outside run state.
- `verifier-holdout`: if kept, merge the two near-identical stores (answer-key + verdict) into
  one record (~−80 LOC).

## 6. Unresolved questions (your decision — I did not auto-cut these)

These are genuine judgment calls where the audit is split or the trade-off is yours:

1. **`--mode workflow` (Phase 3):** retire it for one-driver simplicity, or keep background/
   parallel execution? _Recommendation: retire_ — it's the biggest win and the substrate is
   admittedly immature, but it's the one cut that removes a capability.
2. **Holdout gate (whole feature, ~648 LOC + one agent spawn/task):** keep, or cut? It prevents
   the producer being "taught to the test" on 100% of criteria, but the marginal gain over a
   6-reviewer panel that already checks spec alignment is debatable. _Recommendation: keep for
   now_ — it's clean, 0 X-items, and it's quality machinery (the spine), not scaffolding.
3. **`type-design-reviewer`:** weakest panel member (future-bug prevention, overlaps
   quality/implementation reviewers); cutting saves one apex-model turn per task. Keep the
   risk-invariant floor intact, or trim the panel to 5?
4. **`circuit-breaker` (Phase 1):** wire it (gain runaway-abort safety) or delete it? Leaving
   it dead is the only non-option.
5. **`no-merge` mode** (`git/rollup.ts`, `driver/ship.ts`): cutover scaffolding — retire now or
   keep as a dev escape hatch?
6. **Delivery of this doc:** written to `docs/proposals/simplification-audit.md`. Want it
   tracked as an epic / split into issues, or kept as a single proposal?

## 7. Where "the middle" lands

Pure LOC-midpoint between this repo (~25k engine TS) and superpowers (~0.5k) is the **wrong**
target — you can't reach it without deleting the quality mechanism, which violates the caveat.
The right axis is **operational complexity**, and these phases move it decisively:

| Dimension                        | Today                            | After Phases 0–4                |
| -------------------------------- | -------------------------------- | ------------------------------- |
| Ways to run                      | 2 drivers (session + workflow)   | **1 driver**                    |
| Stop behaviour                   | can trap the session             | **always exits; run resumable** |
| Code you read vs. code that runs | ~1k LOC dead/parallel            | **what you read is what runs**  |
| Config knobs                     | several do nothing               | **every knob works**            |
| Entry-point friction             | relaunch on version bump         | **none**                        |
| Engine TS                        | ~25.4k LOC                       | **~22k LOC (~−13%)**            |
| Lights-out blockers              | stop-hook, 3× prompts, preflight | **none**                        |

The engine stays a real ~16–17k-LOC deterministic core — unmistakably **not** superpowers,
squarely mid-spectrum — but the _surface a person has to hold in their head_ shrinks far more
than the LOC number suggests. That is the simplification the brief is asking for: same
quality guarantee, far fewer ways for the periphery to surprise you.
