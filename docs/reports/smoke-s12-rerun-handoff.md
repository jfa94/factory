# S12 Phase A — clean re-run handoff (verify the D1 fix scores 1.0)

**Why this exists.** Phase A of the S12 smoke drove PRD #1 to merged PRs, but the
**docs stage suspended** on the scribe's own `STATUS: DONE_WITH_CONCERNS` and only
finished after a human `factory resume` — a second `human_touches` entry, so the
touch metric landed at **~2.0**, not the lights-out **1.0**. That bug (**D1**) is
fixed on `factory-plugin` `main` (v1.19.2, commits `a3cba09` + `674a548`, **unpushed**).
This handoff re-runs Phase A against the **installed** plugin to confirm the docs
stage now completes with **zero** intervention and check 8 scores exactly **1.0**.

Prior-run evidence (`run-20260704-134253`): `human_touches: [launch @13:42:53,
resume @14:23:23]`; `docs.status: done` only at 14:30:28 — i.e. after the forced
resume. That is the whole 2.0.

---

## Precondition A — ship the fix to the installed plugin

The smoke runs the **installed** plugin, not this working tree, so the fix has to be
pushed and pulled first.

```bash
# 1. Push the fix (2 commits: a3cba09 fix + 674a548 merge). Git only — does NOT
#    push the uncommitted 417-file strict sweep in the working tree.
git -C /Users/Javier/Projects/factory-plugin push origin main

# 2. In a Claude Code session, update the installed plugin (marketplace == this repo):
/plugin update factory

# 3. VERIFY the installed dist actually carries the fix (belt + suspenders — the last
#    smoke hit a stale-version gap). The installed path is under ~/.claude/plugins/;
#    the token below only exists in >= v1.19.2:
grep -rl 'DONE_WITH_CONCERNS' ~/.claude/plugins/*/factory*/dist/factory.js 2>/dev/null \
  || echo 'NOT UPDATED — installed plugin is still pre-1.19.2, do not run yet'
```

Do not proceed until the grep prints a path (installed plugin ≥ v1.19.2).

## Precondition B — tidy the toy repo (avoids a rescue touch)

The first run left drift in `/Users/Javier/Projects/factory-smoke-tipsplit`. If the
new run has to auto-rescue this, that rescue is a `human_touches` entry and the metric
can't reach 1.0. Start from a clean, origin-synced `develop`:

Observed leftover state (2026-07-04):

- HEAD is on `staging-run-20260704-143621` (a leftover staging branch), not `develop`.
- Local `develop` (`b3f1115`) has **diverged** from `origin/develop` (`242e7a5`).
- Stale branches: `factory/run-20260704-134253/T1..T6`, `staging-run-20260704-134253`,
  `staging-run-20260704-143621`, `docs-run-20260704-134253`, `worktree-purrfect-foraging-bengio`.

Recommended tidy (operator's call — the `reset --hard` discards the divergent local
`develop`; `origin/develop` is the PR-merged source of truth):

```bash
cd /Users/Javier/Projects/factory-smoke-tipsplit
git fetch origin --prune
git checkout develop && git reset --hard origin/develop   # clean integration base
git worktree prune
# delete the prior run's branches (all prior-run artifacts, safe to drop):
git branch -D staging-run-20260704-134253 staging-run-20260704-143621 \
  docs-run-20260704-134253 worktree-purrfect-foraging-bengio \
  factory/run-20260704-134253/T1 factory/run-20260704-134253/T2 \
  factory/run-20260704-134253/T3 factory/run-20260704-134253/T4 \
  factory/run-20260704-134253/T5 factory/run-20260704-134253/T6
git status   # clean tree, on develop == origin/develop
```

Leave the origin remote branches alone (harmless) and **leave PRD #2 open** (the junk
PRD — check 1b already passed; don't touch it).

## The re-run — fresh PRD, from a TOY-REPO session

PRD #1 is **closed** (consumed by the first run). Re-running `#1` won't work — its
code is already merged. File a **fresh** healthy PRD (a real incremental feature on
the now-non-empty repo — a stronger test than the greenfield first run). A ready body
is in the appendix.

`factory` resolves the target repo from `cwd`, so this **must** run from a Claude Code
session rooted in `/Users/Javier/Projects/factory-smoke-tipsplit` (not the
factory-plugin session).

```bash
# from the toy-repo session:
gh issue create -R jfa94/tipsplit-factory-smoke \
  --title 'PRD: Itemized bill splitting (per-person shares)' \
  --body-file <the appendix PRD>          # or paste the body in the UI
# note the new issue number, then drive it lights-out — ZERO intervention:
/factory:run <new#>
```

Let it run to a merged PR. Do **not** resume, recover, or touch it. If it stalls,
that's a finding — capture it (see failure triage) rather than nudging it.

## Success criteria (the point of the re-run)

1. **Docs stage completes without suspend** — the direct D1 regression check. Watch
   `factory state --summary`; `docs.status` should go `done` with no intervening
   `resume`.
2. **Touch metric = 1.0** — `factory score` shows `human_touches: [launch]` only
   (no `resume`/`recover`). `factory score --fleet` for the store-wide roll-up.
3. PR(s) merged; the fresh PRD **closed on complete**.

## Evidence → smoke report

Fill `factory-plugin/docs/reports/smoke-s12.md`:

- Checks **1, 2, 5, 6, 7, 8, 9** — this clean run supplies them (spec-gen, parallelism,
  4-lens panel, traceability, ship, metric, statusline). Record PASS/FAIL + evidence
  (envelope JSON, `factory score`, PR links).
- Under **Defects found → D1**, change the "Re-run needed" line to the confirmed result
  (e.g. "Re-run `run-<id>`: docs `done` with no resume; touch metric **1.0** — D1
  closed").
- Update the **check 8** row (drop the ⚠️ once 1.0 is observed).

The fault-injection sub-experiments (checks **3, 4, 6-unmet, 10**) each deliberately
add a touch — run them **after** this clean run so they don't spoil its 1.0. They're
described in the runbook + Handoff prompt already inside `smoke-s12.md`.

## Failure triage

- **Docs suspends again** → the fix isn't live. Re-check Precondition A step 3 (installed
  dist has `DONE_WITH_CONCERNS`); confirm `/factory:run` used the installed plugin, not a
  stale cache.
- **Metric > 1.0 but docs was fine** → something else forced a touch (a rescue from
  leftover drift, or a real second defect). Read `human_touches` in the run's
  `state.json` under `~/.claude/plugins/data/factory-jfa94/runs/<run-id>/` — the `kind`
  of the extra entry names the cause. A `recover`/`rescue` kind ⇒ Precondition B wasn't
  clean; a second `resume` ⇒ a new defect to triage on `redesign/s12-smoke-fixes`.

---

## Appendix — the fresh healthy PRD body

Paste as the issue body (passes specifiability: >200 chars of content + an
`## Acceptance Criteria` section; has a dependency edge like #1's `buildReceipt`).

```markdown
Add itemized splitting so a bill can be divided by what each person ordered, not
just evenly. Builds on the existing `parseAmount`, `formatCents`, and `applyTip`
primitives already in the repo.

## Requirements

1. `parseLineItem(line: string): { name: string; cents: number }` — parse
   `"Alice: $12.50"` into a name and integer cents. Reuse `parseAmount` for the
   amount; throw a clear error on a missing colon, empty name, or unparseable amount.
2. `subtotalOf(items: LineItem[]): number` — sum the item cents, exact integer.
3. `allocateTip(items: LineItem[], tipCents: number): number[]` — split a tip across
   items in proportion to each item's share, half-up, remainder-preserving so the
   allocations sum EXACTLY to `tipCents` (largest-remainder distribution).
4. `splitBill(lines: string[], tipCents: number): PersonTotal[]` — end-to-end: parse
   each line, allocate the tip, return `{ name, subtotalCents, tipCents, totalCents }`
   per person. Depends on `parseLineItem`, `subtotalOf`, and `allocateTip` — this is
   the dependency edge.

## Acceptance Criteria

- Cent conservation: `sum(totalCents) === subtotalOf(items) + tipCents` for any input.
- `allocateTip` uses half-up rounding and distributes leftover cent(s)
  deterministically, never dropping or inventing cents.
- `parseLineItem` throws on malformed input (no colon, empty name, bad amount).
- Empty `lines` → empty result; `tipCents === 0` → every per-person `tipCents` is 0.
- Every public function is pure, total, and has behavioral tests.
```

---

## Paste-ready prompt for the toy-repo session

> You are driving a clean re-run of **Phase A** of the S12 smoke for the Dark Factory
> plugin, against this repo (`jfa94/tipsplit-factory-smoke`). Goal: confirm the D1 fix
> (docs stage accepting `DONE_WITH_CONCERNS`, v1.19.2) lets a PRD drive to a merged PR
> **lights-out** — `factory score` touch metric **exactly 1.0** (launch the only touch).
>
> Preconditions are already handled OUTSIDE this session (factory-plugin `main` pushed,
> `/plugin update factory` done, installed dist verified ≥ v1.19.2). **Verify the toy
> repo is a clean base first:** `git fetch origin --prune`, be on `develop` reset to
> `origin/develop`, no leftover `staging-run-*` / `factory/run-*` / `docs-run-*` branches,
> tree clean. Leave PRD #2 (junk) open and untouched.
>
> PRD #1 is closed/consumed — **file a fresh healthy PRD** (body below), then
> `/factory:run <new#>` and let it run to a merged PR with **zero** intervention (no
> resume/recover — if it stalls, capture the finding instead of nudging).
>
> Fresh PRD body:
> [paste the appendix PRD markdown above]
>
> Success: docs stage reaches `done` with no `resume`; `factory score` shows
> `human_touches: [launch]` only; the PRD closes on complete. Capture evidence
> (envelope JSON, `factory score` / `score --fleet`, PR links, statusline) and fill
> checks 1, 2, 5, 6, 7, 8, 9 in `factory-plugin/docs/reports/smoke-s12.md`, update the
> D1 "Re-run needed" line to the confirmed result, and drop the ⚠️ on check 8. Run the
> fault-injection sub-experiments (checks 3, 4, 6-unmet, 10) only AFTER this clean run.
