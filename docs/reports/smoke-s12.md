# S12 — End-to-End Smoke Acceptance

**Session:** S12 (final redesign session). **Date started:** 2026-07-04.
**Status:** ⚙️ Setup complete — run phase pending (must run from the toy-repo session; see the runbook).

The acceptance bar for the whole 12-session redesign: **a PRD drives to a merged
PR with zero human touches beyond launch → touch metric exactly 1.0.**

---

## Fixture

| Thing         | Value                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toy repo      | `jfa94/tipsplit-factory-smoke` (**private**), local clone `/Users/Javier/Projects/factory-smoke-tipsplit`                                                                    |
| Stack         | npm + TypeScript (ESM) + vitest; a tip-splitting calculator library                                                                                                          |
| Baseline      | `src/version.ts` + test; `npm test` / `typecheck` / `build` / coverage all green pre-PRD                                                                                     |
| Branches      | `main` and `develop` synced at scaffold commit; **`develop` protected** (strict up-to-date, enforce_admins, no required checks)                                              |
| Gate contract | `.factory/gates.json` (stack npm): **contracted** = test, tdd, coverage, type, build; **waived** = mutation (no stryker), lint (no eslint installed), sast (no security cmd) |
| Config        | `maxParallelTasks: 2`                                                                                                                                                        |
| Healthy PRD   | issue **#1** — "Tip-splitting calculator core", 5 requirements, AC section, `buildReceipt` depends on 4 primitives (the dependency edge)                                     |
| Junk PRD      | issue **#2** — "Polish the library", deliberately unspecifiable (fails specifiability: <200 chars content, no AC section)                                                    |
| Data dir      | `$HOME/.claude/plugins/data/factory-jfa94` (auto-redirected; the smoke session inherits it)                                                                                  |

**Toolchain note (load-bearing).** This machine's `npm` occasionally delegates to
pnpm; the fixture is pinned to real npm with a committed `package-lock.json`, and
`package.json` carries `allowScripts: {"esbuild@0.21.5": true}` +
`pnpm.onlyBuiltDependencies: ["esbuild"]` so a fresh install builds esbuild
(vitest's dep) without a manual approval prompt under **either** package manager.
If a gate ever fails with `ERR_PNPM_IGNORED_BUILDS` or a missing esbuild binary,
that is the toolchain flip, not a factory defect — re-run `npm rebuild esbuild`.

---

## Runbook (execute from a toy-repo session)

The smoke **cannot** run from the factory-plugin session: `factory` resolves the
target repo from `process.cwd()`, and the runner's `Agent({isolation:"worktree"})`
subagents root their worktrees at the invoking session's repo. Open a **new Claude
Code session rooted in `/Users/Javier/Projects/factory-smoke-tipsplit`** and drive
the run there. Paste the handoff prompt below into that session.

<details><summary>Handoff prompt</summary>

> You are driving the S12 end-to-end smoke of the Dark Factory plugin against this
> repo (`jfa94/tipsplit-factory-smoke`). Setup is done: PRD issue #1 is the healthy
> target, #2 is a junk/unspecifiable PRD, `maxParallelTasks=2`, `develop` is
> protected, `.factory/gates.json` contracts test/tdd/coverage/type/build.
>
> **Primary run (clean, lights-out):** run `/factory:run 1` and let it drive issue
> #1 all the way to a merged PR with **no intervention**. This run validates checks
> 1, 2, 5, 6, 7, 8, 9 below. Target: `factory score` touch metric **1.0** (launch
> the only touch).
>
> **Junk check (1b):** attempt a run/spec on issue #2 and confirm it is refused
> `unspecifiable` **before any agent spawns** (`factory spec resolve --issue 2` or
> `/factory:run 2`).
>
> **Fault-injection sub-experiments** (run AFTER the clean run so they don't spoil
> its 1.0 metric — each deliberately adds a human touch):
>
> - **Check 3 (pause/resume):** seed a near-limit `usage-cache.json` in the data dir
>   (or tighten the pacing threshold) so the next task parks with `run.quota`
>   written, confirm the run suspends, then `factory resume` and confirm it
>   continues. Verify `run.quota` is present at pause and cleared on resume (A2).
> - **Check 4 (self-heal):** force ONE task to fail (e.g. transiently break a test
>   command so a task fails `blocked-environmental`), let finalize conclude the run
>   `failed`, then run `factory recover --auto` ONCE and confirm it resets the
>   effective set and stamps `self_heal.attempts === 1` (or pages correctly if the
>   only fail is a dead-end).
> - **Check 6 (traceability, unmet requirement):** in a run where one PRD
>   requirement is deliberately left unimplemented, confirm the traceability phase
>   records a per-requirement verdict and the rollup is blocked.
>
> For every check, capture evidence (envelope JSON, `factory state --summary`,
> `factory score` / `score --fleet`, statusline output, PR/issue links) and fill in
> the checklist in `factory-plugin/docs/reports/smoke-s12.md`. Triage any defect on
> branch `redesign/s12-smoke-fixes` in the factory-plugin repo with the normal
> protocol (red-then-green, `npm run verify` green, merge `--no-ff`). Finish by
> writing the verdict and committing the report.

</details>

### Useful commands (from the toy-repo cwd)

```bash
# primary run (live: opens + merges the PR once the whole PRD is delivered)
/factory:run 1
# junk refusal (no agent spawn)
factory spec resolve --issue 2
# observe
factory state --summary
factory score            # per-run touch metric (target 1.0 for the clean run)
factory score --fleet    # store-wide roll-up
# statusline suffix (check 9)
echo '{"model":{"display_name":"x"},"workspace":{"current_dir":"'"$PWD"'"},"session_id":"s"}' | factory statusline
```

---

## The 10 checks

Fill each row with **PASS/FAIL + evidence** during the run.

| #   | Check                                                                                                                                                                                                                                  | Result     | Evidence                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------- |
| 1   | **Spec** — specifiability gate passes; spec + tasks.json generated for #1; junk #2 → `unspecifiable` refusal pre-run                                                                                                                   | 🟡 partial | Junk #2 **PASS** (see below); healthy-#1 spec-gen pending the run |
| 2   | **Parallelism** — two tasks genuinely in flight (two in-flight entries, overlapping bg agents); preflight lock holds (no spurious `assertBaseIsStagingTip` trips)                                                                      | ⬜         |                                                                   |
| 3   | **Pause/resume** — a forced quota pause parks with `run.quota` written (A2); `factory resume` clears + continues                                                                                                                       | ⬜         |                                                                   |
| 4   | **Self-heal** — one forced task failure → failed finalize → `factory recover --auto` runs ONCE → recovered or paged correctly; `self_heal.attempts === 1`                                                                              | ⬜         |                                                                   |
| 5   | **4-lens panel** — exactly 4 reviewers per task review wave; citation-verify + finding-verifier exercised; cross-vendor warn if Codex absent                                                                                           | ⬜         |                                                                   |
| 6   | **Traceability** — runs after tasks terminal, before finalize; per-requirement verdicts in report; one deliberately-unmet requirement → rollup blocked                                                                                 | ⬜         |                                                                   |
| 7   | **Ship** — merged PR(s); whole-PRD delivery; PRD #1 closed on complete                                                                                                                                                                 | ⬜         |                                                                   |
| 8   | **Metric** — run summary + `factory score --fleet`; clean lights-out run scores exactly **1.0** (launch the only touch). ⚠️ First run scored ~2.0 — docs-suspend defect **D1** forced a `resume`; fixed v1.19.2, clean re-run pending. | ⬜         |                                                                   |
| 9   | **Statusline** — suffix live during the run; gone >30 min after terminal                                                                                                                                                               | ⬜         |                                                                   |
| 10  | **Statusline-staleness (Unresolved Q1)** — watch whether the usage cache goes >1 h stale while idling on bg agents → benign fail-closed suspend; record what happened (do NOT build `--refresh-from` now)                              | ⬜         |                                                                   |

---

## Recorded so far (from the setup session)

**Check 1b — junk PRD refused pre-run (PASS).** `factory spec resolve --issue 2`
from the toy-repo cwd returned, with **no agent spawn** (the specifiability gate is
deterministic and runs before generation, Decision 47):

```json
{
    "kind": "unspecifiable",
    "repo": "jfa94/tipsplit-factory-smoke",
    "issue": 2,
    "blockers": [
        "specifiability: PRD body is trivial (154 chars of content, minimum 200) — …",
        "specifiability: no acceptance-criteria-shaped section — add an \"## Acceptance Criteria\" … section"
    ]
}
```

Both PRD bodies were also verified directly against `specifiabilityGate` before the
issues were filed: healthy #1 `passed: true`, junk #2 `passed: false`.

## Defects found

**D1 — docs stage suspended on the scribe's own documented `DONE_WITH_CONCERNS` status (fixed, v1.19.2).**

- **Symptom.** Phase A drove PRD #1 to merged PRs #5–#10 and passed traceability (13/13 met),
  then the docs stage **suspended** instead of completing. The run only finished after a human
  `factory resume` — a second `human_touches` entry, so the touch metric landed at **~2.0**, not
  the lights-out **1.0**. (Run `run-20260704-134253`: `status: completed`, `human_touches:
[launch, resume]`.)
- **Root cause.** Internal contract mismatch. `agents/scribe.md` documents
  `STATUS: DONE_WITH_CONCERNS` as a valid success-with-note, but `parseProducerStatus`
  (`src/producer/agents.ts`) matched DONE with `/^…DONE\b/` — and `_` is a word char, so the
  `\b` anchor misses `DONE_WITH_CONCERNS` → `error` → the docs handler (`src/orchestrator/docs.ts`)
  suspends. The scribe followed its contract exactly; the parser never implemented the token.
  **Not** caused by the concurrent strict-typecheck/lint sweep (runtime string-match in the
  built dist; tsconfig strictness has no effect on it).
- **Fix.** Anchor now also accepts the one documented variant
  (`/^…DONE(?:_WITH_CONCERNS)?\b/`); `DONE_SOMETHING_ELSE`, `NOT DONE`, `ABANDONED` still error.
  RED→GREEN unit test added. Commit `a3cba09`, merged `674a548` (`redesign/s12-smoke-fixes`,
  `--no-ff`), v1.19.2.
- **Re-run needed.** The affected run already completed via resume; a fresh Phase A run on
  ≥v1.19.2 is required to confirm the docs stage completes lights-out and check 8 scores 1.0.

## Quota-spend observations

_Spawns per task vs the predicted ~7; total spend across the run; any circuit-breaker or pacing behavior._

## Verdict

_Go / no-go on the redesign, once the checklist is complete._
