# Artifact Storage Architecture — proposal

**Status:** **Mostly DEFERRED (2026-06-03), adversarially reviewed — see §0.** Not a plan; no implementation implied.
**Outcome:** The full storage re-architecture is **deferred** alongside the executor-confinement architecture it fed into (see `executor-confinement.md` → **Outcome**). The §0 verdict (location ≠ security boundary) is _why_: zoning delivers coherence, not security, and the security holes it was meant to close are better closed by three targeted fixes. **The only piece of this doc that graduates to "do now" is the per-spec re-key** (storage §6 → confinement fix #3: key the spec by `(repo, spec-id)` not `<run>`). This doc is retained as the artifact inventory + the analysis that produced the fixes. Read `executor-confinement.md` first.
**Companion:** operationalises Deltas **A/B** (TCB) of `design-intent-and-redesign.md` — that doc says _what_ the trust boundary should be; this doc says _where every artifact physically lives_ to make it real.
**Grounding:** the artifact inventory was produced by an adversarially-verified sweep (28 agents; 178 raw records → ~40 distinct artifacts; 18 contested claims resolved against code). Load-bearing `file:line` cites are kept inline; the rest live in the sweep result.

---

## 0. Adversarial review verdict (read this first)

Three independent critics — architecture, security/red-team, completeness — each grounded in code, were turned loose on this draft. **The organizing principle survives; the enforcement story did not.** The headline:

> This proposal answers _"where should each artifact live?"_ But on a single-uid host with `Bash(*)`, **where a file lives barely changes who can touch it.** Storage zoning is the right lever for **coherence + dedup (P1, P4)** and the _wrong_ lever for **the security goals (P2, P3)**. Location _selects_ which artifacts need protection; it does not _provide_ it.

Three verified reasons location ≠ boundary here:

1. **One grant covers every zone.** `settings.autonomous.json:19-21` grants `Read/Edit/Write(${CLAUDE_PLUGIN_DATA}/**)`. `config/`, `vault/`, `gates/` all sit under that glob — moving a file between them changes access by **zero**. The boundary needs the _grant_ narrowed; §4/§5 never touch it.
2. **The protected writes never go through Edit/Write tools.** Every `gates/` artifact is written by a **shell redirect** (`subagent-stop-transcript.sh:195`, `stages.sh:875,1318`); executor tampering would be `Bash` `echo >` too. A hook matching `Edit|Write` fires on neither. The only deny that binds under `Bash(*)` is **Bash-command-target parsing** (the shape the scribe guard already uses) — not adopted here.
3. **No role reaches a PreToolUse hook.** `FACTORY_SUBAGENT_ROLE is never exported` (`stages.sh:1848`, `pretooluse-pipeline-guards.sh:194`). "Edit/Write-deny _for executor + reviewer roles_" is unwritable at write-time.

And the hole **bigger than storage** — why perfect zoning is still insufficient:

> **The verdict is a forgeable boolean.** `pipeline-state task-write <run> <task> quality_gate.ok true` writes verbatim — `_validate_task_field_value` (`pipeline-state:61-99`) enum-checks only `status/stage/risk_tier/holdout`; the gate booleans hit the `*) return 0` default, and **no guard matches `task-write`**. The ship checklist is _derived_ from those fields, so an executor clears every gate by writing five state fields. Moving the evidence files changes nothing. The fix is architectural, not locational: **derive verdicts from ground-truth artifacts at gate time; never trust a stored boolean.**

### Corrections to specific claims

| §        | Claim as written                                                      | Verified reality                                                                                                                                                                                                                                    | Status                             |
| -------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| §3       | only `state.json`/`ship_checklist` are "genuinely executor-immutable" | `task-write` forges any gate field; `state.json` is in no deny-list and the `.claude` guard `exit 0`s plugin-data                                                                                                                                   | **False — reverse it**             |
| §3/§4/§8 | boundary "enforced at the hook layer" via Edit/Write-deny by role     | no role at hook layer; writes are shell redirects; needs Bash-target parsing + grant-narrowing                                                                                                                                                      | **Mechanism wrong**                |
| §7       | **L2 recommended** (never materialised, orchestrator-injected)        | orchestrator reads criteria from `vault/` (same path executor can `cat`, `pipeline-holdout-validate:49`); criteria are a _subset of `acceptance_criteria` the executor already holds_; reviewer prompt → `scratch/` + transcripts read-allow-listed | **Refuted — only L3 holds**        |
| §8/§5    | config→`config/` write-deny "closes P3"                               | `write-protection.sh:31-35` reads its _own blocklist from config.json_ (circular); `CLAUDE_PLUGIN_DATA=/tmp/x pipeline-gate` redirects the loader to attacker config (`pipeline-lib.sh:21-77` honors out-of-tree paths)                             | **Doesn't close P3**               |
| §6       | spec store "kills P1 by construction"                                 | trades ref-staleness for cache/fetch-staleness unless fail-closed; hash-and-seal needs a named TCB actor or a gaming generator reports hash(B) for content A                                                                                        | **Overstated**                     |
| §6       | "retire the `spec-handoff` branch"                                    | it is the _only_ cross-worktree transport (generator in `isolation:worktree`; orchestrator `git show`s the ref); a plugin-data write isn't visible across the boundary                                                                              | **Can't retire — keep**            |
| §6       | `spec-id = <prd-issue-number>`                                        | collides across repos (factory is multi-repo); plugin-data store makes in-flight runs _unrecoverable_ on a wipe (today the spec is durable in git on staging)                                                                                       | **Key needs repo discriminator**   |
| §9/§4    | "replace the `runs/current` symlink"                                  | the symlink is the **hook-activation keystone**: `pretooluse-pipeline-guards.sh:65` does `[[ -L ]] \|\| exit 0` — remove it and **every Bash invariant turns off**                                                                                  | **Keystone — port atomically**     |
| §6       | pin `(spec-id, version)` instead of `.spec.path`                      | `.spec.path` is read as a _filesystem path_ in the hot path (`stages.sh:78,88,127-128`) and baked into the test-writer bootstrap; a bare tuple → silent empty spec on resume                                                                        | **Needs materialize-to-path shim** |
| §10      | migration "semi-centralised, mostly mechanical"                       | no shared path constructor; `.state/$run_id` built inline ~17×; `pipeline-score`, the `pipeline-cleanup` archive writer (hardcoded `reviews/`+`holdouts/`), `pipeline-rescue-apply` read old paths and are unlisted                                 | **Blast radius understated**       |

### What this does to the proposal

- **Keep:** the diagnosis (P1–P4 are real), the _organizing_ value of trust-class zoning (coherence, dedup, audit clarity), and the spec store's _goal_ (kill regeneration).
- **Demote:** zoning from "security control" to "hygiene + precondition." It delivers P2/P3 only when paired with the primitives below.
- **Add — the actual security work, none of it locational:**
    1. **Derive-don't-store verdicts** + guard `task-write` of `*_gate*`/`security_gate*`/`coverage*` fields. _(highest severity)_
    2. **Recompute executor-produced gate evidence in TCB space** — the coverage gate reads `cov_after` from `$wt/coverage/...` in the executor's _own_ worktree (`stages.sh:699`); re-run coverage on the _committed_ code orchestrator-side. The ladder has no class for "executor-produced evidence a gate must trust" — same gap as the holdout, only noticed for the holdout.
    3. **Harden `CLAUDE_PLUGIN_DATA` resolution** — abort on an env value that disagrees with the canonical dir, instead of honoring out-of-tree paths.
    4. **Narrow `Bash(*)` or accept best-effort (Q-C1)** — without this, every write/read-deny is bypassable and the trust ladder is decorative. This is now the _gating_ decision, not a footnote.
- **Holdout:** go **L3 (off-host) or call it advisory** — L2 leaks the secret and the secret is derivable anyway.

The body below is the original draft, **uncorrected inline except where flagged `(see §0)`**, so the discussion can start from the decisions this verdict surfaces (§12, reframed).

---

## 1. The problem

Three concrete pain points motivated this, and the sweep confirmed a fourth (the TCB hole):

- **P1 — Spec/tasks are run-keyed but logically spec-keyed.** `spec.md`/`tasks.json` are regenerated and re-committed to `<target-repo>/.state/<run-id>/` on `origin/staging` _every run_. Two runs over the same PRD ⇒ two full regenerations. Hard to reference later (buried per-run on a transient branch). Plus a verified **stale-spec window**: `pipeline-branch:183-186` only `log_warn`s on a failed `git push origin staging`; the downstream `ls-remote` check (`SKILL.md:306`) verifies the ref _exists_, not that it's _fresh_; `stages.sh:127-128` checks `spec.md` _exists_, not its content — so executors can silently run against a stale spec.
- **P2 — The holdout secret is executor-readable.** Decision 5 ("plugin data inaccessible from worktrees") is **factually wrong**. `templates/settings.autonomous.json:19` grants `Read(${CLAUDE_PLUGIN_DATA}/**)`; the `.claude/` PreToolUse guard explicitly _allows_ plugin-data paths (`:149`); `write-protection.sh` blocks only Edit/Write, not Read. A worktree-isolated executor can `cat` its own `holdouts/<task>.json`. Integrity is procedural (the orchestrator, not the executor, spawns the reviewer), **not enforced**.
- **P3 — Gate config sits where the executor can reach it.** All five gate thresholds (`mutationScoreTarget`, `holdoutPercent`, `coverageRegressionTolerancePct`, `securityCommand`, `redTestCommand`) read exclusively from `${CLAUDE_PLUGIN_DATA}/config.json` — which has **no `write-protection.sh` entry**. The executor can edit the thresholds that judge it. This is the maximal Delta-B violation.
- **P4 — Layout incoherence.** `runs/<run-id>/.state/<run-id>/` double-nests the run-id; the same relative name `.state/<run-id>` is reused for the _target-repo staging_ path (a totally different physical root) — a documented audit-confusion source. Reviewer outputs (gate inputs) are intermingled with throwaway prompts. Two audit logs (`audit.jsonl` tamper-evident vs `.claude/tool-audit.jsonl` cwd-relative, no chain) are conflated.

The unifying diagnosis: **artifacts are placed ad hoc.** Gate config sits next to executor scratch; a secret sits in a "supposedly inaccessible" dir that's actually readable; a durable reusable contract is buried in run-keyed transient dirs.

---

## 2. Organizing principle

> **Location is a function of trust-class first, identity-key second.**

Every artifact is classified on two axes that _determine where it must live_:

1. **Trust class** — who is allowed to read/write it (this picks the _zone_, and the zone carries an **enforced** boundary, not a convention).
2. **Identity key** — what the artifact is naturally _about_ (global / spec / run / task / per-spawn) — this picks the _path within_ the zone.

(Lifecycle — ephemeral / durable / two-phase — and consumer-set are secondary; they affect retention and sub-pathing, not the zone.)

The key shift from today: **a single artifact's location is derived, not chosen.** If it's a gate input the executor must not forge → TCB zone, full stop. If it's an answer key → vault zone, full stop.

---

## 3. The trust ladder

Four classes, ordered most→least protected. The point of the redesign is that **each boundary is enforced at the hook layer**, because `Bash(*)` (Decision 17) means tool-permission allow-lists alone do not bind a determined executor.

| Class       | Executor can read? | Executor can write? | Examples                                                                                                                                                                                                                                               | Enforcement                                                                                                                 |
| ----------- | ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **VAULT**   | **no**             | **no**              | holdout withheld criteria; any answer-key whose disclosure defeats a gate                                                                                                                                                                              | secret not materialised in an executor-readable path (orchestrator-injected / CI-evaluated) + hook Read-deny on the subtree |
| **TCB**     | yes                | **no**              | `state.json`, `ship_checklist.json`, authoritative gate thresholds, reviewer/gate outputs that drive APPROVE/REJECT, coverage-before baseline, the audit chain, active-run pointer, `merged-settings.json`, `statusline-wrapper.sh`, branch protection | writes only via `pipeline-state`/hooks under lock; hook Edit/Write-deny on the subtree for executor + reviewer roles        |
| **WORKING** | yes                | yes (own lane only) | the task worktree code (its branch), prompts it consumes, throwaway scratch                                                                                                                                                                            | per-spawn worktree isolation; cross-lane path scoping                                                                       |
| **PUBLIC**  | n/a (GitHub)       | via PR only         | branches, PRs, PRD issue                                                                                                                                                                                                                               | branch protection + `ship_checklist` gate on `gh pr create` (already present)                                               |

**The hard-prevent is the VAULT and TCB write-deny.** Today only `state.json`/`ship_checklist` are genuinely executor-immutable (via `pipeline-state` + `pretooluse-pipeline-guards`). The redesign extends that same discipline to **config thresholds** (P3) and adds the **VAULT** for secrets (P2).

---

## 4. Storage zones (physical layout)

Reorganise `${CLAUDE_PLUGIN_DATA}` so the top-level _is_ the trust map:

```
${CLAUDE_PLUGIN_DATA}/
  config/                       TCB   authoritative gate thresholds (was config.json)      ← hook Edit/Write-deny
  session/                      TCB   merged-settings.json, statusline-wrapper.sh          ← hook Edit/Write-deny (these define perms / are executed)
  cache/                        cache usage-cache.json, hook-errors.log
  specs/<spec-id>/<version>/    SPEC  spec.md, tasks.json, meta.json                       ← immutable once written (content-addressed)
  vault/<run-id>/<task-id>/     VAULT holdout withheld criteria                            ← hook Read+Write-deny (or off-host)
  runs/<run-id>/
    state.json                  TCB
    active                      TCB   this run's liveness record (PID/heartbeat)
    journal/                    audit.jsonl (TCB, hash-chain) · metrics.jsonl (obs) · *.log
    gates/<task-id>/            TCB   reviewer .md, codex.json, ship_checklist.json, coverage-before.json, holdout verdict
    scratch/<task-id>/          WORK  prompts, ci.json, validated.json, transient
    locks/                            state.lock, run-tracker.lock
  archive/<run-id>/             TCB   terminal snapshot: state.json + journal/ + gates/
  pipeline.lock                       global orchestrator-instance mutex
```

Changes vs today, each tied to a finding:

- **Kill the double-nest** `runs/<run-id>/.state/<run-id>/` → `runs/<run-id>/{gates,scratch}/<task-id>/`. (P4)
- **Split run artifacts by trust:** `gates/` (TCB, write-denied — these are gate _inputs_) vs `scratch/` (WORKING). Today reviewer outputs (gate inputs) and throwaway prompts share `.state/<run-id>/`. (P4)
- **VAULT** is its own top-level with a hook Read-deny. (P2)
- **`config.json` → `config/` with hook Edit/Write-deny.** (P3)
- **Spec store** `specs/<spec-id>/<version>/`, content-addressed and reused across runs. (P1)
- **`journal/`** co-locates the two log streams under one explicit live→archive lifecycle (kept as separate files — see §9). (P4)
- **`active` record replaces the `runs/current` symlink** as the liveness keystone (see §9).

---

## 5. Master artifact → zone table

Every distinct artifact from the sweep, with its proposed home. "→" marks a move.

| Artifact                                                                         | Today                           | Key                  | Class                       | Proposed                                                               |
| -------------------------------------------------------------------------------- | ------------------------------- | -------------------- | --------------------------- | ---------------------------------------------------------------------- |
| `state.json`                                                                     | `runs/<run>/`                   | run                  | TCB                         | unchanged                                                              |
| current-run pointer                                                              | `runs/current` symlink          | global               | TCB                         | → `runs/<run>/active` record + index (§9)                              |
| `audit.jsonl` (hash chain)                                                       | `runs/<run>/`                   | run                  | TCB                         | → `runs/<run>/journal/`                                                |
| `metrics.jsonl`                                                                  | `runs/<run>/`                   | run                  | obs                         | → `runs/<run>/journal/`                                                |
| `transcript-errors.log`, `missed-artifacts.jsonl`                                | `runs/<run>/`                   | run                  | log                         | → `runs/<run>/journal/`                                                |
| `hook-errors.log`                                                                | `${PLUGIN_DATA}/`               | global               | log                         | → `cache/`                                                             |
| `state.lock`, `.run-tracker.lock`                                                | `runs/<run>/`                   | run                  | ctrl                        | → `runs/<run>/locks/`                                                  |
| `pipeline.lock`                                                                  | `${PLUGIN_DATA}/`               | global               | ctrl                        | unchanged                                                              |
| `.scribe_active`                                                                 | `runs/<run>/`                   | run                  | TCB-sentinel                | → `runs/<run>/` (keep at run root)                                     |
| `.active-spawn.json`                                                             | `runs/<run>/`                   | run→**per-spawn**    | ctrl                        | → per-spawn marker keyed by `task+role` (retire single-file overwrite) |
| **holdout criteria**                                                             | `runs/<run>/holdouts/`          | task                 | **VAULT**                   | → `vault/<run>/<task>/` (read-denied) + see §7                         |
| holdout verdict (pass/fail)                                                      | `state.quality_gates.holdout`   | task                 | TCB                         | unchanged (verdict stays in TCB state)                                 |
| `.review.<role>.md`                                                              | `.state/<run>/`                 | task                 | TCB (gate input)            | → `runs/<run>/gates/<task>/`                                           |
| `.review.holdout-reviewer.md`                                                    | `.state/<run>/`                 | task                 | TCB (gate input)            | → `runs/<run>/gates/<task>/`                                           |
| `reviews/<task>_round_N.json`                                                    | `runs/<run>/reviews/`           | task                 | TCB (gate input)            | → `runs/<run>/gates/<task>/`                                           |
| `.review.codex.json`                                                             | `.state/<run>/`                 | task                 | TCB (gate input)            | → `runs/<run>/gates/<task>/`                                           |
| `coverage-before.json`                                                           | `.state/<run>/`                 | task                 | TCB (gate input)            | → `runs/<run>/gates/<task>/`                                           |
| `ship_checklist.json`                                                            | `.tasks/`                       | task                 | TCB (gates `gh pr create`)  | → `runs/<run>/gates/<task>/`                                           |
| `<role>-prompt.md`, `RUN.scribe-prompt.md`                                       | `.state/<run>/`                 | task/run             | WORKING                     | → `runs/<run>/scratch/<task>/prompts/`                                 |
| `ci.json` (wait-pr scratch)                                                      | `.state/<run>/`                 | task                 | WORKING                     | → `runs/<run>/scratch/<task>/`                                         |
| `validated.json`                                                                 | staging worktree                | run                  | scratch                     | → `runs/<run>/scratch/`                                                |
| `.tasks/<task>.json` snapshot                                                    | (unconfirmed)                   | task                 | —                           | drop/consolidate into `state.json`                                     |
| **`config.json`** (thresholds)                                                   | `${PLUGIN_DATA}/`               | global               | **TCB**                     | → `config/` (Edit/Write-denied)                                        |
| `merged-settings.json`                                                           | `${PLUGIN_DATA}/`               | global               | TCB                         | → `session/` (Edit/Write-denied — defines perms)                       |
| `statusline-wrapper.sh`                                                          | `${PLUGIN_DATA}/`               | global               | TCB                         | → `session/` (Edit/Write-denied — executed)                            |
| `usage-cache.json`                                                               | `${PLUGIN_DATA}/`               | global               | cache                       | → `cache/`                                                             |
| `archive/<run>/`                                                                 | `archive/`                      | run                  | TCB snapshot                | unchanged                                                              |
| **`spec.md` / `tasks.json`**                                                     | repo `.state/<run>/` on staging | **spec** (today run) | TCB (contract)              | → `specs/<spec-id>/<ver>/` (§6)                                        |
| `.spec.*` state fields                                                           | `state.json`                    | run                  | TCB                         | → pin `(spec-id, version)` not `handoff_ref` (§6)                      |
| `spec-handoff/<run>` branch                                                      | git                             | run                  | transport                   | retire or demote to pure transport (§6)                                |
| `.claude/tool-audit.jsonl`                                                       | repo cwd                        | run                  | weak log                    | consolidate into `journal/` or drop (§9)                               |
| `package.json:.factory.*`                                                        | repo                            | global               | config (non-threshold)      | unchanged                                                              |
| `quality-gate.yml`, `.stryker.config.json`, `.dependency-cruiser.cjs`, scaffolds | repo                            | global               | TCB-adjacent (committed CI) | unchanged — **already correct**                                        |
| branches, PRs, PRD issue, branch protection                                      | git/GitHub                      | mixed                | PUBLIC/TCB                  | unchanged (naming hygiene: namespace task branch per-run)              |
| templates / contracts / schemas                                                  | plugin source                   | global               | read-only                   | unchanged                                                              |

Two principles fall out and are worth stating: (a) **the committed CI config is already in the right place** — immutable execution config (`.stryker`, `quality-gate.yml`) belongs in the target repo where the executor can only touch it via a reviewed PR; (b) **the only mutable gate config (`config.json`) is the one in the wrong place** — fixing it (→ `config/`, write-denied) closes P3 without disturbing the rest.

---

## 6. Deep dive A — the spec store (spec-keyed, versioned, pinned)

**Key.** `spec-id = <prd-key>` where `prd-key` is the PRD issue number, or a content hash of the PRD body for issueless specs. **Version** = content hash of the generated `spec.md`+`tasks.json`. Path `specs/<spec-id>/<version>/` is therefore **content-addressed and immutable**.

**Reuse.** A run records `(spec-id, version)` in `state.spec`. A new run over the same PRD:

- if the PRD content hash is unchanged _and_ the operator opts into reuse → skip the spec-generator **and** the spec-review gate entirely; pin the existing latest version.
- else → generate a new version (the store is append-only; old versions remain referenceable).

Reuse is **opt-in**, not automatic: a better generator/prompt should be able to force regeneration even for an unchanged PRD. (Open question Q-S1.)

**Freshness — kills P1's stale window by construction.** Downstream reads `specs/<spec-id>/<pinned-version>/`. The path _is_ the content hash, so there is no "stale ref" failure mode: a run reads exactly the immutable version it pinned, or fails loudly if that path is absent. The handoff-branch + per-run staging-commit + `ls-remote`-exists dance is replaced by a single write to the content-addressed store and a hash assertion on read.

**Canonical location — the real decision (Q-S2).** The store needs durability + referenceability. Options:

- **D1 — git, dedicated `factory/specs` orphan branch.** Durable, diffable, code-reviewable, travels with the repo; does _not_ pollute the product line (`develop`/`main`). Con: a second long-lived branch to manage.
- **D2 — plugin-data only**, with the spec mirrored to the PRD issue as a comment for human reference. Con: plugin-data is machine-local — not durable across machines or a data wipe.
- **D3 — git canonical (D1) + plugin-data cache.** Durability of git, locality of cache. Con: a cache to invalidate. **(lean)**

**Trust.** Spec is the contract being implemented → executor-immutable. The executor reads it; cannot change it (committed/content-addressed).

---

## 7. Deep dive B — the holdout hard-prevent (closing P2 / Q12)

The honest constraint: on a **single-user, single-uid host**, a process (executor) running as that user can read any file that user can read; POSIX perms cannot separate it, and `Bash(*)` bypasses tool allow-lists. So "make the file unreadable via hooks" is _best-effort_, never airtight. The robust boundary is therefore not "lock the file" but **"don't put the secret where the executor runs."** A spectrum:

| Level                  | Mechanism                                                                                                                                                                                                                                                                                                                                                                                          | Defeats whom                                               | Cost                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------- |
| **L0 (today)**         | path-separation + "don't pass the path" convention                                                                                                                                                                                                                                                                                                                                                 | nobody (executor has Read)                                 | —                               |
| **L1**                 | hook **Read-deny** on `vault/**` (Read tool + best-effort Bash-read patterns)                                                                                                                                                                                                                                                                                                                      | casual; `Bash` evasion (subst, `<`, base64) still possible | low                             |
| **L2** _(refuted, §0)_ | claimed: secret never materialised in an executor-readable path — orchestrator injects criteria into the reviewer prompt. **Reality:** orchestrator reads them from `vault/` (`pipeline-holdout-validate:49`, same path executor can `cat`); criteria are a _subset of `acceptance_criteria` the executor already holds_ (derivable); reviewer prompt → `scratch/` + transcripts read-allow-listed | **nobody** (secret is on-host and derivable)               | low–med                         |
| **L3 (airtight)**      | evaluate holdout in **CI / a separate uid** — the executor's host never contains the secret; verdict returns via TCB state                                                                                                                                                                                                                                                                         | active adversary with arbitrary shell on the executor host | high (LLM-in-CI, API key in CI) |

**Recommendation — revised (§0):** L2 is **refuted** — the secret is on the executor's host (read-deny is best-effort under `Bash(*)`) _and_ derivable from `acceptance_criteria` the executor already holds, so withholding is cosmetic. The only level that holds is **L3 (off-host/CI eval)**; absent that, the holdout gate is **advisory, not a hard gate** and should be labelled so. Q-H1 is now "L3 or advisory," not "L2 vs L3." This still honours Q12's _tamper_ half (below) — but the _read_ half is not "best-effort," it is open.

**Tamper — only _half_ closed by relocation (revised, §0):**

- Relocating the withheld-criteria **file** out of executor-writable space _does_ close the "overwrite to `withheld_count:0` ⇒ vacuous pass" hole. Good.
- **But the verdict itself is _not_ tamper-proof:** `state.quality_gates.holdout` is enum-checked yet `"pass"` is an accepted value, and `pipeline-state task-write … quality_gates.holdout '"pass"'` writes it directly — no guard matches `task-write`. So the categorical break needs the `task-write` field-guard + derived verdict from §0, not relocation.

**Also:** fix Decision 5's text (stale path `${PLUGIN_DATA}/holdouts/` and the false "inaccessible" claim). False confidence is itself a hazard.

---

## 8. Deep dive C — config → TCB

`config.json` holds the _mutable_ gate thresholds (the rest of gate config is correctly immutable-in-repo). Move it to `config/` and add a `write-protection.sh` / hook **Edit/Write-deny**. Reads stay open (gates legitimately read thresholds). **This does _not_ close P3 on its own (see §0):** (a) `write-protection.sh:31-35` reads its _own_ blocklist from `config.json` — circular; an executor empties the list first. (b) `CLAUDE_PLUGIN_DATA=/tmp/x pipeline-gate` points the loader at attacker config without touching the protected file (`pipeline-lib.sh:21-77` honors out-of-tree roots). Closing P3 requires the blocklist bootstrapped from immutable plugin source (not config), `CLAUDE_PLUGIN_DATA` resolution that aborts on disagreement, and ultimately Q-C1.

Residual, surfaced honestly: while `Bash(*)` stands, hook-deny on writes is best-effort against creative Bash. The airtight end-state is **mediated access** — the executor never touches plugin-data directly; only TCB `pipeline-*` scripts do — which is only enforceable if `Bash(*)` is narrowed (revisits Decision 17) or config is read from a place the executor's host doesn't hold writable. Flagged as Q-C1 / ADR candidate.

---

## 9. Secondary fixes folded in

- **Run journal lifecycle made explicit.** `audit.jsonl` (TCB, hash-chained, never trimmed) and `metrics.jsonl` (observability, trimmable) stay **separate files** (different trust models — do **not** merge) but co-locate under `runs/<run>/journal/` and are modelled as one artifact with two phases: _live_ in `runs/`, _durable_ in `archive/`. Stops reports flip-flopping between "ephemeral" and "durable."
- **Consolidate the two audit logs.** The repo `.claude/tool-audit.jsonl` (cwd-relative, no hash chain, executor-influenceable, committable) either moves into `journal/` under the same chain discipline, or is dropped in favour of the tamper-evident `audit.jsonl`. Two logs with different integrity guarantees is a trap.
- **Replace the `current` symlink keystone — _with care_ (see §0).** Today every hook resolves the active run through one global symlink; failure modes are nasty (dangling ⇒ fail-closed-all-hooks; `status=running` forever after a crash; asymmetric post-rename checks between `pipeline-init` and `pipeline-state ensure-current`). **The symlink is also the hook _activation_ keystone:** `pretooluse-pipeline-guards.sh:65` does `[[ -L … ]] || exit 0` — drop the symlink and **every Bash invariant turns off.** Any replacement (active-run record validated by PID/heartbeat) must port that activation predicate _and_ preserve fail-closed-on-corruption, landed atomically with the hook change and gated by a test that asserts the guard still fires. This is a security-path change, not a pure reliability tidy-up.
- **Per-spawn marker.** `.active-spawn.json` is run-keyed but semantically per-spawn; its single-file overwrite is the root of the (currently mitigated) parallel-attribution risk. Key it by the `[task:<id>]` header the transcript already carries; retire the legacy file.

---

## 10. Migration / blast radius (honest)

- **Path derivation is semi-centralised** (`pipeline-lib.sh` helpers, `_prompt_path`, `pipeline-init:51`), so most moves are mechanical edits to path constructors + their readers: `pipeline-init`, `pipeline-state`, `pipeline-run-task[-stages]`, `pipeline-build-prompt`, `pipeline-holdout-validate`, `pipeline-cleanup`, and the hooks that resolve `runs/current`. Non-trivial but bounded.
- **New enforcement** (vault Read-deny, config Write-deny) is genuinely new and must be tested against the `Bash(*)` bypass, not just the Read/Write tools — this is the part most likely to be wrong.
- **Spec store** is the largest behavioural change: rewires the spec-generator handoff, the orchestrator extract, the run-task spec read, _and_ `archive`/`cleanup`/`resume` (which currently assume run-keyed spec paths). Content-addressing + pinning must land together with the freshness assertion or the stale window just moves.
- **Backward-compat:** `archive/` of in-flight/old runs, and `resume` reading pre-migration `state.json`, need a read-shim or a clean-cutover decision (Q-M1).

---

## 11. Out of scope (found during the sweep — separate hardening track)

Reliability issues the sweep surfaced that are **not** storage-location problems and should not bloat this proposal: no wall-clock/cost-ceiling auto-abort (only token quota / human stop a runaway); `require_plugin_data()` defined-but-never-called (foreign-plugin-data leak can slip through `|| true` sourcing); reviewer worktrees lack the `checkout -B origin/staging` fallback that protects test-writer/executor (depend entirely on session-start `baseRef:head`); resume re-uses a stored worktree path without existence validation; `pipeline-state ensure-current` lacks `pipeline-init`'s post-rename sanity check; crashed run stuck `status=running` with no stale detection. **Recommend a companion reliability pass.**

---

## 12. Open questions

Reframed by §0. The first three are now _security-defining_ — they decide whether any of this delivers P2/P3, and they're independent of storage layout. Resolve them before the layout details.

**Security-defining (resolve first):**

- **Q-V1 (headline)** Verdict integrity: the `task-write` forge clears every gate regardless of file location. Do we (a) guard `pipeline-state task-write` of `*_gate*`/`security_gate*`/`coverage*` fields **and** derive verdicts from ground-truth artifacts at gate time, or (b) accept stored booleans as best-effort? Nothing else matters until this lands.
- **Q-V2** Executor-produced evidence: the coverage gate reads `cov_after` from the executor's own worktree (`stages.sh:699`); same for any test/mutation output. Recompute orchestrator-side on the _committed_ code, or trust + spot-check? (The trust ladder needs a 5th treatment for "executor-produced evidence a gate must trust.")
- **Q-C1 (now gating, not a footnote)** Narrow `Bash(*)` (revisit Decision 17) to a `pipeline-*` write-allowlist (mediated access) — without it every write/read-deny is best-effort and the ladder is decorative — or accept best-effort + `CLAUDE_PLUGIN_DATA` hardening only?
- **Q-H1 (revised)** Holdout: **L3 (off-host/CI) or downgrade to advisory?** L2 is refuted (secret on-host _and_ derivable). No middle option survives.

**Spec store:**

- **Q-S1** Reuse: opt-in only, or auto-reuse on unchanged PRD hash? What invalidates a cached spec besides PRD content (generator version? a `--regen` flag)?
- **Q-S2 (now correctness, not preference)** Canonical store: multi-repo collision + wipe-unrecoverability of in-flight runs force **git-canonical** (D1 orphan branch / D3 git+cache) over D2 plugin-data. Confirm D3, or D1? And: the `spec-handoff` branch **stays** as the cross-worktree transport (can't retire); content-addressing happens _after_ the orchestrator extracts.
- **Q-S3 (new)** Spec key needs a repo discriminator (`<repo-slug>/<issue>` or `<remote-url-hash>/<issue>`) — which?

**Migration:**

- **Q-M1** Blast radius is wider than §10 admitted (`pipeline-score`, the `pipeline-cleanup` archive writer, `pipeline-rescue-apply` rehydrate, state-embedded _absolute_ review paths). Read-shim for old runs/archives, or clean cutover (abandon in-flight runs)? And: land the path-helper refactor _first_ (no-op), prove single-sourcing, _then_ move.

---

## 13. ADR candidates

1. **Verdicts are derived, not stored** (gate booleans recomputed from ground-truth artifacts at gate time; `task-write` of gate fields guarded) — the load-bearing one; reverses the current "trust the stored boolean" model.
2. **Enforcement is Bash-target mediation, not tool-permission denies** (the boundary that actually binds under `Bash(*)`; storage zoning _selects_ what to mediate) — surprising vs the intuitive "deny the path" mental model.
3. **Trust-class-first storage zoning** (location is hygiene + a precondition, paired with #1/#2 to deliver security) — real trade-off vs ad-hoc placement.
4. **Spec store: content-addressed + git-canonical + pinned, handoff branch kept as transport** — changes the spec lifecycle; reversal is costly.
5. **Holdout off the executor host (L3) or advisory** — security-load-bearing threat-model trade-off.
6. _(if Q-C1 lands that way)_ **Narrowing `Bash(*)`** — revisits Decision 17; the enabler for #2 being airtight rather than best-effort.
