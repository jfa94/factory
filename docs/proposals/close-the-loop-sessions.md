# Close the Loop — Session Plan

> **Status:** Execution plan for the Close-the-Loop program proposed in
> [design-review-2026-07-07.md](./design-review-2026-07-07.md), grouped into seven
> independently-runnable sessions, each with one theme. Amended with the
> **run-create incident of 2026-07-07** (PRD #288), which adds Session 1 as a new,
> urgent stall class the review had missed: creation atomicity.
>
> Run order: **1 first** (unblocks PRD #288). 2 and 3 are independent of everything.
> 4 → 5 → 6 are a dependency chain. 7 any time after 1.

---

## Incident addendum — the run-create crash (2026-07-07)

`factory run create --issue 288` crashed (exit 2) and left a half-created run that
_looked completable_. Four distinct defects, verified at line level:

| #   | Defect                                                              | Where                                                                           | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Pointer-liveness check crashes on an unparseable old-schema run     | `manager.ts:470-492` (`pointCurrentAt` → `readCurrentForRepo` → `guardedParse`) | `current/<repo-key>` still named a schema-v2 run (`run-20260630-095544`); the v3-only `guardedParse` throws `UsageError`. But a run this engine cannot parse cannot be owned by a live session of this engine — "unparseable" is _stale_, not _live_. Precedent already in-repo: `listRuns` (manager.ts:298) tolerates corrupt entries loudly so "a single corrupt historical run must not brick `run create`". `pointCurrentAt` is the missed twin. |
| B2  | Run creation is two writes, and the pointer write sits between them | `lifecycle.ts:207-225` + `manager.ts:214`                                       | `state.create()` writes `state.json` with `tasks: {}`, then `pointCurrentAt` fires _inside_ `create()` (after the write), then a **second** `state.update()` seeds tasks + launch touch. B1's throw landed in the gap → valid, `running`, zero-task run; staging branch + protection already pushed (deliberately pre-state, Decision 33 rollback-safe — that half is correct).                                                                      |
| B3  | Vacuous all-terminal on an empty task map → `finalize`              | `next.ts` all-terminal gate                                                     | `every(terminal)` over `{}` is vacuously true; `next-task` returned `finalize` for a run that shipped nothing. The engine's own principle — `deriveAllGatesVerdict` **fails on the empty set, never default-open** — was never applied here.                                                                                                                                                                                                         |
| B4  | Rescue scan blind to the never-seeded class                         | `scan.ts`                                                                       | Scan classifies existing task rows; empty map → `needs_rescue: false, total: 0`. Silently healthy-looking wreckage.                                                                                                                                                                                                                                                                                                                                  |

Wreckage recovery (operator runbook, before or after Session 1):
`factory run cancel --run run-20260707-110034 --cleanup` (deletes the orphaned
`staging-run-20260707-110034` branch + protection; the state parses fine, so cancel
works today) — then, once Session 1 lands, re-run `factory run create --issue 288`
(the spec is durable and reused; Phase 1 does not re-run). The stale v2 run
`run-20260630-095544` should be swept (Session 1e) or its pointer will keep biting.

---

## Session 1 — Run-create integrity 🔥 (unblocks PRD #288)

**Theme: a run is born whole or not at all; an empty run never passes anything.**

| Item | Scope                                                                                                                                                                                                                                                                                                                                                                      | Key files                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1a   | **Atomic seeding**: `StateManager.create()` accepts `tasks` (+ `human_touches`); `createRunFromManifest` passes the seeded map in the create payload; delete the follow-up `state.update()` (lifecycle.ts:219-225). One write births a complete run. The B1 throw then leaves a _whole_ run addressable via `--run`, exactly as `pointCurrentAt`'s comment already claims. | `core/state/manager.ts`, `orchestrator/lifecycle.ts` |
| 1b   | **Pointer-liveness tolerance**: in `pointCurrentAt` only, an unparseable/old-schema pointer target classifies as _stale_ → repoint + loud warning (mirror `listRuns`' tolerate-loudly precedent). `read()`/`readCurrent()`/`readCurrentForRepo()` keep their loud contracts for every other caller.                                                                        | `core/state/manager.ts`                              |
| 1c   | **Empty-set guard in `next-task`**: a `running` run with zero tasks → loud `UsageError` naming the run as half-created, never a vacuous `finalize`. Same rule as `deriveAllGatesVerdict`.                                                                                                                                                                                  | `orchestrator/next.ts`                               |
| 1d   | **Scan flags the class**: `rescue scan` reports `empty_task_map: true` → folded into `needs_rescue`.                                                                                                                                                                                                                                                                       | `rescue/scan.ts`                                     |
| 1e   | **Stale-run sweep**: extend `rescue gc` (D55) to sweep unparseable old-schema run dirs (and their pointers), killing the root cause of B1 at the source.                                                                                                                                                                                                                   | `rescue/gc`                                          |

Acceptance: a regression test reproducing the exact incident (v2 state behind the
per-repo pointer + `run create`) passes end-to-end; create is provably single-write
(fakes assert one state write); `next-task` on an empty-task run throws; scan flags
it; `npm run verify` green.

Deliberately skipped: a parse-level "running ⇒ tasks non-empty" schema invariant —
with 1a the state can no longer legitimately exist, and the invariant would brick
reading (thus cancelling/gc-ing) existing wreckage. Add only if a second incident
shows reads need it.

---

## Session 2 — Verifier & TCB integrity

**Theme: close the self-documented holes in the gate machinery.**

- **2a (S1)** Holdout verdict store keyed by `(task, rung)` instead of task —
  a stale prior-rung holdout verdict must not survive an escalation bump
  (`handlers.ts:385`, self-documented gap).
- **2b (S2)** GateRunner ↔ CI-render cross-check test: for the same gate contract,
  the rendered `quality-gate.yml` enumerates exactly the gates the runner enforces.
  Kills the local-green ≠ CI-green drift class.
- **2c (S3)** "Gates in force" enumeration in `run create` output + run report;
  warn when a default-set gate is absent from the contract (operator misconfig is
  the one hole TCB protection can't cover).
- **2d (S4)** `run create` preflight refuses an autonomous `--e2e` run whose
  resolved `e2e.testDir` is nonstandard (the `tcb.ts:218` known gap, closed
  fail-closed without circular config trust).
- **2e (S5, optional)** Citation-verify content-anchored fallback: before dropping
  a finding whose quote misses at `file:line ± 2`, try matching the quoted snippet
  anywhere in the cited file.

---

## Session 3 — Runner hardening (P4)

**Theme: the runner carries zero pipeline logic and survives compaction.**

- **3a** Port the SessionStart/compaction re-injection hook (the acknowledged
  known gap in CLAUDE.md): re-inject the Iron Laws + runner-protocol pointer after
  compaction. Cheapest stall-reducer in the program.
- **3b** Move the three remaining hand-assembled prompts into engine envelopes:
  producer prompt composition (`prompt_ref` + ProducerContext), the codex `exec`
  cross-vendor command line, and the finding-verifier spawn (prompt + agent type +
  model — SKILL.md:414 admits it is "runner-chosen type not carried by an
  envelope"). The runner becomes pure spawn-verbatim/collect.
- **3c** Engine-side stall TTL: `next-task` flags an in-flight task whose
  `spawn_in_flight` is older than a TTL with no recorded results and instructs the
  runner to re-drive it (idempotent re-spawn machinery already exists).

---

## Session 4 — Deterministic reconcile, read side (P1a)

**Theme: the engine can see GitHub truth; scan stops being state-only.**

- **4a** New `reconcile` module behind the existing single I/O seam
  (`gh-client.ts`): gather facts — PR state by head branch, merged-SHA vs recorded
  state, staging-branch existence/tip, rollup PR state (incl. landed auto-armed
  rollups).
- **4b** `rescue scan` consumes it: drift classes reported per task
  (merged-but-unrecorded, closed-unmerged, branch-missing, stale `pr_number`,
  rollup-landed) — closing scan's self-documented blind spot (`scan.ts:25-29`).
- **4c** `factory reconcile` reporter subcommand (read-only envelope; no writes
  yet).

No behavior change to any write path — this session is pure observability, safe to
land independently, and the prerequisite for Sessions 5 and 6.

---

## Session 5 — Autonomous repair, write side (P1b + P3)

**Theme: forward-only repairs happen without a human; destructive ones still ask.**

- **5a** Forward-only adoption under the state lock: record a merged-but-unrecorded
  PR as `done`; route a landed auto-armed rollup to the finalize resume-guard;
  re-push a missing branch; refresh a stale `pr_number` before any rescue reset may
  touch that task. Destructive divergence (force, delete, un-ship) still only
  surfaces.
- **5b** Auto-invocation: at `next-task` when a task wedges in `shipping`, at every
  resume, and before any rescue reset.
- **5c (P3)** Raise the self-heal bound: `self_heal.attempts === 0` → `< 3` (or
  D45-style proportional — decide in-session), autonomy routed by the safety class,
  every cycle ledgered; destructive stays consent-gated. Auto-repairs never append
  to `human_touches` (D49 precedent).
- **5d** Demote `rescue-reconciler`: the LLM agent shrinks to the
  genuinely-ambiguous residue; delete it if the residue is empty after a few weeks
  of 4b telemetry.

---

## Session 6 — Scheduled wake & sentinel (P2) — DROPPED, replaced by the in-session 5h wait (Decision 62, v1.33.0)

**Original theme: parked is a state the system leaves by itself.**

The launchd-sentinel spike below (6a–6d: scheduled/cron session, park-armed wake,
sentinel heartbeat, `--auto`/`auto_wake` ledger) was built then judged "way too janky
and unnecessarily complex" and reverted whole. It is **replaced by an in-session 5h
quota wait** (Decision 62): the pre-Decision-42 behavior, restored as a runner-protocol
change only. A `scope "5h"` pause TaskStops in-flight agents and WAITs (ends the turn
without stopping the session); the runner's existing heartbeat (`CronCreate`, every
`stallTtlMinutes`) re-drives REFILL, and `factory next-task` self-clears `paused`→`running`
on a fresh proceed. Self-bounded (a 5h window resets by `resets_at_epoch` ≤5h). `7d`
suspends and `unavailable` halts still STOP → a human `/factory:resume`. No engine
code/timer/config/ledger. This covers the _live-session_ case only; a DEAD session
(process gone) still needs a human relaunch — the sentinel was the watchdog for that,
and that gap is accepted as the price of dropping the apparatus.

The retired sub-steps, for the record:

- ~~**6a** Spike scheduled/cron Claude Code sessions (fallback `launchd` timer).~~
- ~~**6b** Park-armed wake at `resets_at_epoch`/TTL running `/factory:resume`.~~
- ~~**6c** Sentinel heartbeat (30–60 min) — watchdog for dead runner sessions.~~
- ~~**6d** Ledger: auto-resume/auto-reconcile never count as `human_touches`.~~

---

## Session 7 — Outer loop & cleanups (P5 + S6 + S7)

**Theme: the factory measures whether bad code escapes, and sheds legacy pointers.**

- **7a (P5)** Defect-escape ledger: `factory escape --run <id> --task <id> --note …`
  (or PRD-label convention); `factory score` reports escapes/run and
  escapes/reviewer-lens.
- **7b (P5)** Repeatable reviewer-value analysis from `metrics.jsonl`
  (confirmed-blocker yield per lens, send-back rates) so panel composition stays
  evidence-driven (the D43 analysis, made a command instead of an archaeology).
- **7c (S6)** Flip `review.requireCrossVendor` to `block` in the maintainer's own
  config (after Session 5 lands — a Codex outage under `block` is itself a stall
  source until self-repair exists).
- **7d (S7)** Nuke the legacy global `runs/current` pointer: migrate the no-cwd
  consumers (statusline, `hook-context.loadActiveRun`, `next-task` fallback) to
  per-repo resolution, delete the global symlink. This incident is the argument:
  pointer targets outlive engine schema versions.
- **7e (S8, decision point)** E2E default-on for repos with a committed Playwright
  config — only take this after Sessions 1–6 hold, since the e2e phase is itself a
  stall surface.

---

## Dependency graph

```
Session 1 (urgent, independent)
Session 2 (independent)
Session 3 (independent)
Session 4 ──► Session 5 ──► Session 6
Session 7 (after 1; 7c after 5)
```
