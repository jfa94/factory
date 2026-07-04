# CLI Reference

The `factory` CLI is the deterministic engine — it owns ALL pipeline control
flow and exposes exactly ONE seam, the **orchestrator** (`next-task` + `next-action`). Every
subcommand prints exactly one JSON document to stdout (or `--summary` human text
for `state`); `--help` on any subcommand prints its contract. The binary is
`dist/factory.js`, reached on `PATH` as `factory` via the `bin/factory` shim.

Subcommands are **reporters** (read-only; emit an envelope), **the orchestrator** (`next-task`
records nothing; `next-action --results` records an agent spawn's output into ONE state
step; `run docs --results` records a scribe spawn's output likewise), or **writers** (one
state mutation). `run create`, `run finalize`, `run cancel`, `scaffold`, and the
orchestrators' (`next-action` ship / `run docs` record) side effects perform actions (state and/or
GitHub side effects). The orchestrator seams spawn nothing themselves — they emit a spawn request
the runner spawns from (see [Model A](../explanation/model-a.md)).

Run/spec state is read from and written to `$CLAUDE_PLUGIN_DATA`.

## Global behavior

- No args / `--help` / `-h` → prints the registry, exits `0`.
- Unknown subcommand → stderr message, exits `2` (USAGE).
- A subcommand's own usage error → exits `2`; any other error → exits `1`.
- `run create` against an already-active run → exits `3` (CONFLICT) — see
  [`run create`](#run-create).

See [exit-codes.md](./exit-codes.md).

---

## `config-defaults`

Reporter. Prints the fully resolved config (defaults + any `config.json` overlay)
as JSON. Doubles as a smoke test of the config loader.

```
factory config-defaults
```

## `configure`

Inspect or edit the persisted config overlay. Every edit round-trips through the
schema before it touches disk; an invalid value is a loud error, never persisted.
Writes are a sparse overlay, so future default changes stay visible.

```
factory configure                          # print the resolved config
factory configure --get <key.path>         # print one resolved value
factory configure --set <key.path=value>   # set (repeatable), validate, persist
factory configure --unset <key.path>       # revert a key to its default (repeatable)
factory configure --detect-gate-env        # auto-detect CI build env → gap-fill quality.gateEnv
```

Values parse as JSON when possible (numbers, booleans, arrays), else as a bare
string. `--get` cannot be combined with `--set`/`--unset`. Example:
`factory configure --set quality.holdoutPercent=25`. Keys are in
[configuration.md](./configuration.md).

`--detect-gate-env` scans `.github/workflows/*.yml` for every step/job-level `env:`
literal (`applyGateEnvDetection`, `src/ci/detect-gate-env.ts`) and **gap-fills**
`quality.gateEnv` from `process.cwd()` — the operator always wins (an existing key is
never overwritten; a detected value that differs is reported as a conflict). It is
**mutually exclusive** with `--get`/`--set`/`--unset` (combining them is a usage error),
writes the overlay only when there are new keys, and prints a `DetectReport`:
`{ detected, written, skipped, conflicts, skippedExpressionRefs, droppedSecrets, droppedKeys,
warnings, sources, gateEnv }`. Entries are failed — never silently — for: a `${{ }}` expression
ref (`skippedExpressionRefs`), a secret-shaped value (`droppedSecrets`), a reserved loader/path-injection
KEY (`PATH`, `NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`) or a non-POSIX KEY name
(`droppedKeys`, with `reason: "reserved"` / `"invalid-name"`), and anything inside a `run: |` block
scalar. Detection is biased to MISS (block-style space-indented YAML only — an _unquoted_ exotic-YAML
value is skipped, never mangled; a _quoted_ look-alike is kept); the escape hatch for a miss is
`--set quality.gateEnv.<KEY>=<value>`. `scaffold` runs the same detection automatically (see
[`scaffold`](#scaffold)).

## `scaffold`

Action. Prepares a target repo for the pipeline: idempotently copies the CI net
(`.github/workflows/quality-gate.yml`) and, for Node packages, the gate configs
(`.stryker.config.json`, `.dependency-cruiser.cjs`, `eslint.config.mjs`); ensures
the `.gitignore` guard; and probes branch protection on `develop` (the integration
base) — **refusing loudly** when `develop` is not protected, unless `--provision` is
set. Per-run `staging-<run-id>` branches are minted at [`run create`](#run-create);
scaffold no longer creates or protects a shared `staging` branch.

Before writing any template, scaffold **auto-detects the repo's CI build env** (the same
detection as [`configure --detect-gate-env`](#configure)) and gap-fills `quality.gateEnv`.
This runs FIRST by design: `quality-gate.yml` is a managed template scaffold overwrites, so
detecting first captures the repo author's CI env into the durable config overlay before the
managed file clobbers the author's workflow. The resolved `quality.gateEnv` is then **rendered
back into the managed `quality-gate.yml`** scaffold writes — `injectGateEnvIntoWorkflow`
(`src/ci/inject-gate-env.ts`) replaces the template's `# factory:gate-env` marker with a real
`env:` block — so one config drives both the local merge gate and this repo's GitHub CI. Drift
is measured against the _rendered_ template, so an injected managed file stays byte-identical
across re-runs. An unparseable workflow is surfaced loudly (`log.warn` + a `warnings` entry),
never swallowed.

```
factory scaffold [--repo <owner/name>] [--provision]
```

| Flag                  | Required | Notes                                                                                                                                                        |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--repo <owner/name>` | no       | Target GitHub repo (used for the protection probe). Auto-derived from the `origin` remote when omitted; an explicit value that disagrees with it fails loud. |
| `--provision`         | no       | Write branch protection if missing (default: refuse).                                                                                                        |

Emits a `ScaffoldReport`: `{ repo, files_created, files_present, files_updated,
protection, settings, gateEnv? }`. SEED gate configs are scaffold-once / project-owned — an
existing one is reported under `files_present`, never flagged (no `files_outdated`). The
optional `gateEnv` field is the CI build-env detection `DetectReport`; it is included whenever a
key was detected **or any anomaly surfaced** (a parse `warnings` entry, or an expression-ref /
secret / key fail), so a malformed workflow is never silently swallowed. It is **omitted** only
for a clean brand-new repo (no workflows, nothing to report), keeping that report unchanged.

## `spec <resolve|gate|store>`

Reporter. The deterministic spec-build seam. The spec pipeline needs two agent
spawns (spec-generator + spec-reviewer), which the runner owns; the CLI owns
the deterministic glue. State is threaded through a transient scratch dir
(`spec-build/<repo>/<issue>/{prd,generated,verdict}.json`). Each action takes
`--repo` + `--issue` and emits one envelope naming the next step.

```
factory spec resolve --repo <owner/name> --issue <n> [--supersede]
factory spec gate    --repo <owner/name> --issue <n>
factory spec store   --repo <owner/name> --issue <n>
```

- **resolve** — reuse an existing spec for the issue (`{kind:"reuse", pointer}`),
  else fetch the PRD and emit the generate spawn (`{kind:"generate", spawn,
prd_path, generated_path, max_iterations}`). Before emitting `generate`, a
  **deterministic specifiability gate** ([Decision 47](../explanation/decisions.md#decision-47--spec-hardening-specifiability-gate-prd-traceability-approve-spec-park))
  screens the raw PRD body (≥200 non-heading chars, ≥1 extractable requirement, an
  acceptance-criteria-style heading). A PRD that fails is refused loud and terminal —
  `{kind:"unspecifiable", prd_path, blockers}` on stdout **and exit `1`** (the exit
  enum is frozen; the envelope `kind` is the machine discriminator) — before any agent
  spawn, so an unspecifiable PRD costs zero agent turns. `resolve` also persists a
  **durable PRD snapshot** (`prd.json`) beside the spec: `reuse` backfills it once via
  `gh` when a pre-Decision-47 spec lacks it, and `store` writes it on first
  generation. The traceability phase audits this snapshot, never a re-fetch. - `--supersede` — delete the durable spec dir for the issue (`SpecStore.deleteByIssue`,
  idempotent) **before** the reuse check, so resolve always falls through to
  `generate` and the runner regenerates the spec from the PRD. The runner's
  `/factory:run --supersede` forwards this flag into Phase 1 so a superseding run
  does not inherit the same broken spec it is trying to escape. Deletion is
  mandatory — regenerating without deleting risks two dirs for one issue, which
  `resolveByIssue` treats as a store-integrity error.
- **gate** — run the deterministic spec gates over the generator output; emit
  `{kind:"revise", source:"gate", blockers, spawn, …}` on a block, else the review spawn
  (`{kind:"review", spawn, verdict_path, …}`).
- **store** — adjudicate the review (single 56/60 threshold + any-dimension floor);
  emit `{kind:"revise", source:"review", blockers, spawn, …}` on NEEDS_REVISION, else
  persist and emit `{kind:"stored", pointer}`.

The runner loops generate ⇄ review (bounded by `max_iterations`) until
`reuse` or `stored`.

**Revise carries the prior spec — incremental patch, not a re-author.** A `revise`
envelope is symmetric with `generate`/`review`: it carries its own apex-pinned `spawn`
request (`buildReviseSpawn`, `src/spec/agents.ts`) whose `context` embeds the PRIOR
spec (`prior_spec_md` + `prior_tasks`) alongside the `review_feedback` blockers to clear.
The runner spawns the generator straight from `env.spawn.context` — it does **not**
hand-assemble context at the prompt layer. The generator applies the minimal edits needed
to clear the blockers and re-emits the full `GenerateResult`, preserving everything else.
This closes a regression where the re-spawned generator, given only the PRD + blocker
strings in a fresh context, re-authored from scratch and failed previously-satisfied
requirements and traceability lines. `store`'s revise reads `prd.json` from the scratch
dir (durable across the loop) to rebuild that context.

The three spawn `context` shapes are typed in `src/spec/agents.ts` (`GenerateContext`,
`ReviseContext extends GenerateContext`, `ReviewContext`) so the builders return precise
`SpecSpawnSpec<C>` types and a missing/typo'd revise-context key is a compile error. Adding
the `<C>` type parameter does not change the serialized JSON (the revise `spawn` field itself
is new — see above). The revise envelope's `blockers` is `readonly`; the
invariant is that `spawn.context.review_feedback` is derived from `blockers` at the single
construction site. The prior-spec fields are also untrusted: because `prior_spec_md` /
`prior_tasks` derive from the untrusted PRD, the `spec-generator`'s Untrusted Input Contract
treats them and `review_feedback` as data to patch, never directives to obey.

## `run <create|resume|finalize|traceability|docs|e2e-assess|e2e|cancel>`

### `run create`

Action. Resolves a durable spec, creates a fresh run, seeds one `pending` task per
spec task, cuts + GitHub-protects the run's `staging-<run-id>` integration branch
from `develop` (Decision 33), and emits `{kind:"created", run}`. Seeding copies only dependency edges (`depends_on`); neither `risk_tier` nor
`tdd_exempt` is persisted — both read live from the spec (Decision 25). Duplicate, self, dangling, or cyclic dependency edges fail
loudly at seed time.

```
factory run create [--repo <owner/name>] (--issue <n> | --spec-id <id>) [--run-id <id>]
                   [--new] [--supersede | --resume] [--no-ship] [--e2e]
                   [--approve-spec] [--ignore-quota] [--session-id <id>]
```

| Flag                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--repo <owner/name>` | **Optional.** Repo identity (the first key of the spec store). Auto-derived from the `origin` remote when omitted; an explicit value that disagrees with the remote fails loud.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--issue <n>`         | PRD issue number — the stable lookup key. One of `--issue`/`--spec-id`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--spec-id <id>`      | Explicit `<issue>-<slug>` spec id. Mutually exclusive with `--issue`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--run-id <id>`       | Override the generated `run-YYYYMMDD-HHMMSS` id (determinism/tests). A named id forces a fresh create.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--new`               | Force a fresh run, bypassing the active-run conflict scan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--supersede`         | If an active run exists for this spec, mark it `superseded`, delete its `staging-<run-id>` branch (auto-closing its task PRs), then create a fresh run. Emits `{kind:"superseded", run, supersededId}`. Mutually exclusive with `--resume`. **Run-level only** — `run create` does not touch the durable spec; the runner regenerates it by forwarding `--supersede` into Phase 1's [`spec resolve`](#spec-resolvegatestore) (skipped when `--spec-id` is used).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `--resume`            | If an active run exists, do not create — return the conflict (exit `3`) so the caller hands off to [`resume`](#resume). Mutually exclusive with `--supersede`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--no-ship`           | Open the task/rollup PRs but never merge. **Default (omit): live** — serial-merge each task into the run's `staging-<run-id>` branch and the rollup into develop. Persisted as `ship_mode` so the runner + resume + finalize read it without re-passing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--e2e`               | Opt into the run-level **e2e phase** ([Decision 39](../explanation/decisions.md#decision-39--e2e-is-a-run-level-engine-phase-criticality-is-persistence-not-a-tag), overhauled by [Decision 40](../explanation/decisions.md#decision-40--e2e-overhaul-zero-knowledge-ux-via-assessment-adjudication-and-plain-language)): a run-start **e2e-assessment** resolves boot config + machinery before any task, then after every task is terminal, author + run Playwright journeys against the integrated staging app before docs/finalize; a mappable failing journey reopens its task with feedback, an unmappable pre-existing failure is **adjudicated**. Persisted as `e2e: true`. **Create-only + immutable on resume**, exactly like `--no-ship` — rejected loud if paired with `--resume`. **Eagerly checks three static prerequisites at create time** — `package.json`, a `@playwright/test` dependency, and a `playwright.config.ts` — and fails loud if any is missing; `e2e.startCommand`/`e2e.baseURL` are optional overrides, not requirements (the assessment resolves them). See [Run with end-to-end tests](../guides/run-with-e2e.md). |
| `--approve-spec`      | **Create-only opt-in, default OFF** ([Decision 47](../explanation/decisions.md#decision-47--spec-hardening-specifiability-gate-prd-traceability-approve-spec-park)). Creates the run in full (staging cut, tasks seeded), then parks it `suspended` for human spec sign-off **before any agent runs** — ONE state write, **no quota checkpoint** (a non-quota suspend never writes one). The `created`/`superseded` envelope gains `spec_approval: {spec_path, note}` naming the `spec.md` to review; exit stays `0`. `factory resume` **is** the sign-off (`planResume` clears non-quota suspends unconditionally). Rejected loud if paired with `--resume`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--ignore-quota`      | Bypass the weekly-quota hard stop **and** the per-step quota pacer for this run. Persisted as `ignore_quota: true` so both orchestrators + runners skip the gate without re-passing. Lets create/supersede proceed even when the existing run is 7d-parked. Operator override for a mistaken suspend / manual reset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--session-id <id>`   | Owning Claude Code session id for the session-scoped Stop gate. Defaults to `$CLAUDE_CODE_SESSION_ID`. **Always required — no exemption (Decision 42)**: an ownerless run is rejected as a usage error (the Stop hook finalizes via `findActiveByOwner`, which can never match an ownerless run).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Autonomy gate (mandatory, no opt-out):** `run create` HALTS loud (`NotAutonomousError`,
exit 1) unless the session is autonomous (`FACTORY_AUTONOMOUS_MODE=1`). The pipeline runs
unattended by design; `/factory:run` calls [`factory autonomy preflight`](#autonomy-preflight)
first, which auto-scaffolds and prints the `claude --settings <merged-settings.json>` relaunch
command when needed (`ensure`/`status` remain the manual primitives). See
[Decision 29](../explanation/decisions.md#decision-29-autonomy-is-mandatory--enforced-in-the-engine-no-opt-out)
and [Decision 31](../explanation/decisions.md#decision-31-run-entry-preflight-auto-scaffolds-autonomous-settings).

Loud error if no spec exists for the issue — generate one first. `run create` also
**preflights the durable PRD snapshot** ([Decision 47](../explanation/decisions.md#decision-47--spec-hardening-specifiability-gate-prd-traceability-approve-spec-park)):
the end-of-run traceability phase audits `prd.json`, so a spec that predates the
snapshot fails create loud with the backfill remedy (`factory spec resolve --issue <n>`,
or `--supersede` to regenerate) rather than a full-run-cost failure. The in-protocol
`spec resolve` always backfills first; this guards the off-protocol `--spec-id` path.
The runner (the in-session event loop) drives up to `maxParallelTasks` ready tasks
concurrently (see [Run the pipeline](../guides/run-the-pipeline.md)).

**Active-run conflict (Decision 35 — no silent reuse).** A PRD has at most one active
run at a time. `run create` does **not** reuse an existing run: when a non-terminal
run already exists for this `(repo, spec_id)`, it exits `3` (CONFLICT) and emits
`{kind:"exists", existing:{run_id, status}}`. Two escapes resolve the conflict:

- `--supersede` — mark the old run `superseded`, delete its `staging-<run-id>` branch
    - PRs, and create a fresh run (`{kind:"superseded", run, supersededId}`).
- `--resume` — return the conflict so the caller hands off to [`resume`](#resume).

`--new` (or an explicit `--run-id`) bypasses the conflict scan and forces a fresh
run unconditionally. The scan→create is serialized under a per-`(repo, spec_id)` lock
so two concurrent same-spec creates cannot both mint an orphan. `--resume` simply
reports the conflict (`kind:"exists"`) for the caller to hand off to [`resume`](#resume);
it does **not** validate the create-time `--no-ship` flag against the live
run — flag-compatibility belongs to the resume hand-off, not a premature gate here, so a
resumed run keeps its own persisted dials regardless. Emits `{kind:"created", run}` on
the fresh-create path.

**Weekly-quota hard stop (distinct from the generic conflict).** When the existing run
is **weekly-parked** — `status === "suspended"` _and_ `quota.binding_window === "7d"` —
`run create` blocks **every** new-run attempt for the spec (the default path, `--new`,
and `--supersede` alike), not just a bare re-create. It exits `3` (CONFLICT) and emits a
distinct envelope: `{kind:"pause", scope:"7d", run_id, status, reason,
resets_at_epoch?}`. The caller must treat this as a hard stop — report the reason and
reset horizon and tell the operator to `factory resume` after the window resets, NOT offer
the supersede/resume choice. Three carve-outs: a **5h pause** and an **`unavailable`
suspend** (no `binding_window`) are never blocked; the **`--resume` intent** falls through
to the ordinary `kind:"exists"` conflict (the `resume` door re-checks the live window); and
**`--ignore-quota`** overrides the block, letting create/supersede proceed. See
[Quota pacing — the weekly-quota hard stop](../explanation/quota-pacing.md#the-weekly-quota-hard-stop-on-run-create).

### `run resume`

Thin CLI alias of the top-level [`resume`](#resume) command, kept for one release.
Prefer `factory resume`.

```
factory run resume [--run <id>]
```

### `run finalize`

Action. Turns an all-terminal run into its shipped outcome, in resume-safe order:
build the report (`report.md`), emit telemetry, then — **when the run failed** —
post ONE comment on the originating PRD issue listing every failed task (deduped via
a hidden run marker, Decision 36; the PRD stays open), or — **only when the run
completed** (Decision 34: develop receives whole PRDs only) — forward-reconcile
`develop` into the run branch (no force-push), open + CI-gate + (in `live` mode)
squash-merge the `staging-<run-id> → develop` rollup, comment on + close the
originating PRD issue, and delete the per-run branch; finally flip the run terminal
**last**. A `failed` run leaves `develop` untouched, the PRD open, and keeps its
branch for rescue. Loud if any task is still non-terminal. Idempotent (a re-entered
finalize posts no duplicate comment).

```
factory run finalize [--run <id>] [--no-ship]
```

Ship mode defaults to the run's **persisted `ship_mode`** (set at `run create`); no flag
is needed. `--no-ship` overrides it to no-merge for THIS finalize only (opens the
`staging-<run-id> → develop` rollup PR but never merges). Emits
`{kind:"finalized", run, report, rollup?, failure_comment_posted}`.

A **failed traceability phase** ([`run traceability`](#run-traceability), Decision 47)
overrides the terminal status to `failed` here: finalize blocks the rollup, leaves
`develop` untouched, and the PRD comment carries an "Unmet PRD requirements" block —
the same "never ship silently" path a failed e2e phase takes.

### `run traceability`

Orchestrator (emit + record), symmetric with [`run docs`](#run-docs): the run-level
**PRD-traceability phase** ([Decision 47](../explanation/decisions.md#decision-47--spec-hardening-specifiability-gate-prd-traceability-approve-spec-park)),
scheduled once per **non-debug** run **between the e2e phase and docs**, on every
prospectively-`completed` run (`+1 Opus` per run). The CLI **never spawns the auditor** —
a runner does.

```
factory run traceability [--run <id>] [--results <path>]
```

- **Emit** (no `--results`): reads the durable PRD snapshot (`prd.json`), extracts its
  numbered requirements (LOUD if none — the specifiability gate should have refused such a
  PRD), fetches `origin/<baseBranch>` + the staging tip, prepares a **detached, read-only**
  auditor worktree at `worktrees/<run-id>/.trace` (under `worktrees/`, not `runs/`, so the
  TCB `data-runs` write-deny does not fire; no branch to GC), and returns a `spawn` request
  `{kind:"spawn", run_id, worktree, base_ref, staging_branch, model:"opus", max_turns, prompt}`.
  The prompt embeds the requirements as the **axiom** and directs the `traceability-auditor`
  agent (`agents/traceability-auditor.md`) to judge ONLY the whole-PRD diff
  (`git diff base_ref..HEAD`) and resulting tree — never task statuses or review verdicts.
  Idempotent on resume; a crash-retry resets the worktree to the staging tip.
- **Record** (`--results <path>`): reads the auditor's
  `{status:"<STATUS line>", verdicts:[{index, verdict:"met|partial|unmet", evidence}]}`
  envelope. On a `DONE` status it enforces **semantic coverage** (exactly one verdict per
  requirement `1..n`, LOUD on a gap/dup), persists one row per requirement (keyed by
  requirement **text**, not index) in the run-state `traceability` phase marker, removes the
  worktree, then concludes:
    - `{kind:"done", run_id}` — no `unmet` verdict (a `partial` **passes** the gate but
      surfaces as a `traceability_gaps` row in the report). The run proceeds to docs.
    - `{kind:"failed", run_id, reason}` — any `unmet` verdict. A verdict is judgment, **not
      retried**; finalize condemns the run (rollup blocked), and the report/PRD comment carry
      the unmet requirements.

    A **crashed/non-`DONE` auditor** increments `attempts` and, below `MAX_TRACE_ATTEMPTS` (2),
    suspends the run for a retry (`{kind:"suspend", …}`) **without** a quota checkpoint (resumable
    via `/factory:resume`); at the cap it concludes `{kind:"failed", …}` — the **anti-docs delta**:
    docs at cap degrades to best-effort-done, but the delivery gate never ships an unaudited run.

`next-task` schedules `traceability` after e2e and before docs, so a failed audit never
reaches the docs or rollup steps. Debug runs skip the phase (their review⇄fix loop IS their
traceability).

### `run docs`

Orchestrator (emit + record), symmetric with [`next-action`](#next-action): the engine-owned
documentation phase ([Decision 37](../explanation/decisions.md#decision-37--documentation-is-an-engine-phase-before-finalize)).
The CLI **never spawns scribe** — a runner does.

```
factory run docs [--run <id>] [--results <path>]
```

- **Emit** (no `--results`): prepares a docs worktree on a `docs-<run-id>` branch off
  the run's `staging-<run-id>` tip and returns a `DocsAction` spawn request
  `{kind:"spawn", run_id, worktree, base_ref, staging_branch, docs_branch, model, max_turns, prompt}`.
  `base_ref` is `origin/<baseBranch>` (the whole-PRD diff base); the prompt directs
  scribe to `cd` into the worktree, diff `base_ref..HEAD`, update `/docs`, and commit
  **in the worktree without pushing**. Idempotent on resume — an existing worktree from
  a prior failed attempt is reused, not re-created.
- **Record** (`--results <path>`): reads a `{status:"<scribe STATUS line>"}` JSON file. On
  `STATUS: DONE`, fast-forward/merges `docs-<run-id>` into `staging-<run-id>`, pushes the
  staging branch (scribe's commit, if any, rides along), removes the worktree, marks the
  `docs` phase `done`, and returns `{kind:"done", run_id}`. On any non-`DONE` status,
  increments the `docs.attempts` counter and writes a `failed` docs marker. While
  `attempts < MAX_DOCS_ATTEMPTS` (2) it transitions the run to **suspended** (the staging
  branch + worktree are kept for retry) and returns `{kind:"suspend", run_id, reason}`;
  once the cap is hit it treats docs as best-effort and returns `{kind:"done", run_id}`
  so the run finalizes `completed` without a docs commit rather than suspend-looping.

The runner runs `run docs` only when [`next-task`](#next-task) emits `document`. `next-task`
withholds `finalize` until the `docs` phase is `done`, so `run finalize` never
ships a half-documented rollup.

### `run e2e-assess`

Orchestrator (emit + record), symmetric with [`run docs`](#run-docs)/[`run e2e`](#run-e2e):
the **run-start e2e-assessment** phase ([Decision 40 D3](../explanation/decisions.md#decision-40--e2e-overhaul-zero-knowledge-ux-via-assessment-adjudication-and-plain-language)),
scheduled once per `--e2e` run **before any task executes**. The CLI **never spawns the
e2e-assessor** — a runner does. A run created without `--e2e` never reaches it.

```
factory run e2e-assess [--run <id>] [--results <path>]
```

- **Emit** (no `--results`): prepares an assessor worktree on an `e2e-assess-<run-id>` branch
  off the run's `staging-<run-id>` tip and returns a `spawn` request. The prompt directs the
  `e2e-assessor` (pinned to **opus**) to do three jobs in one spawn: (a) **coverage forecast**
  — map each EXISTING committed spec this run's tasks touch to `{spec_path, task_ids,
expectation}` rows (`needs-update` vs `should-still-pass`), pre-routing later suite failures
  for [`run e2e`](#run-e2e)'s adjudication; (b) **machinery** — resolve the real boot config
  (start command + base URL), write it into the repo's `playwright.config.ts` (D10 single
  source of truth), and author seed/auth support (`e2e/support/`, `e2e/auth.setup.ts`) when
  the app needs it, validating by booting + logging in; (c) **verdict**.
- **Record** (`--results <path>`): reads the assessor's verdict — `ok` | `degraded` (auth-only
  gap → a named warning, coverage degrades to logged-out) | `boot-impossible` |
  `machinery-impossible`. Persists the forecast + resolved boot config on run state as
  `e2e_assessment`. Both `-impossible` verdicts fail the run **loud in plain language** (every
  non-terminal task is swept `blocked-environmental` and the run heads straight to finalize →
  `failed`). Retry contract mirrors the author's: a deliberate `-impossible` verdict is FINAL
  (no retry); only a **crash** or a guard violation (stray files / bogus forecast rows) earns
  the one automatic re-spawn (`attempts`, cap 2), after which it becomes the same loud fail.

`next-task` schedules `e2e-assess` before the first task, so a boot/machinery-impossible
assessment fails the run before any task work is spent. See
[Run with end-to-end tests](../guides/run-with-e2e.md).

### `run e2e`

Orchestrator (emit + record), symmetric with [`run docs`](#run-docs): the engine-owned
end-to-end phase on an `--e2e` run ([Decision 39](../explanation/decisions.md#decision-39--e2e-is-a-run-level-engine-phase-criticality-is-persistence-not-a-tag),
overhauled by [Decision 40](../explanation/decisions.md#decision-40--e2e-overhaul-zero-knowledge-ux-via-assessment-adjudication-and-plain-language)),
ordered after the run-start [`e2e-assess`](#run-e2e-assess) phase and immediately **before**
the docs phase. The CLI **never spawns the e2e-author** — a runner does. Only ever runs when
`next-task` schedules the e2e stage; a run created without `--e2e` never reaches it.

```
factory run e2e [--run <id>] [--results <path>]
```

The phase does two distinct kinds of work, so a single subcommand covers both — the
returned envelope's `kind` tells the runner whether an agent is needed:

- **Emit** (no `--results`): on the **first** entry (`e2e_phase` unset) it prepares an
  author worktree on an `e2e-<run-id>` branch off the run's `staging-<run-id>` tip and
  returns a `spawn` request
  `{kind:"spawn", run_id, worktree, base_ref, staging_branch, e2e_branch, throwaway_dir, model, max_turns, prompt}`.
  The prompt directs the `e2e-author` to boot the app with the **resolved boot config**
  (`resolveBootConfig` = `e2e.startCommand`/`e2e.baseURL` override ?? the values the run-start
  assessment wrote into `playwright.config.ts`, D10), explore each user-facing task, author
  **critical** journey specs into the worktree's `e2e.testDir` (committed) plus **throwaway**
  specs into `throwaway_dir` (out-of-repo, never committed), self-validate them green against
  staging, and return a manifest of `{task_ids, spec_path, kind, title}` rows (`title` is the
  human-readable journey name, D12) — **without pushing**. On a **re-entry** (after a reopened
  task settles back to terminal) it does not spawn — it re-runs the already-authored suite
  mechanically and returns a conclusive `done` | `failed` | `reopen` | `suspend`. A crashed or
  unparseable author earns ONE automatic re-spawn (`author_attempts`, D5) before the phase
  fails; a deliberate BLOCKED/NEEDS_CONTEXT verdict fails fast. If the boot config cannot be
  resolved at all it returns `{kind:"suspend", …}` and suspends the run.
- **Record** (`--results <path>`): reads the e2e-author's
  `{status:"<STATUS line>", manifest:[{task_ids, spec_path, kind, title}]}` envelope
  (`E2eResultsSchema`). Any non-`DONE` author status fails the whole e2e phase (no
  re-author retry loop). Before proceeding it validates the manifest: every `spec_path` is
  guarded against traversal/absolute paths, and every `task_id` is checked against
  `run.tasks` (an unknown id fails loud rather than silently vanishing at reopen time). It
  then enforces the **trust boundary** (D6) — a name-only diff of the author branch against
  staging requires every changed file under `<testDir>/` to be a declared **critical** manifest
  entry (carve-out: the assessment-owned `e2e/support/**` and `e2e/auth.setup.ts`), and rejects
  any changed path outside `<testDir>/` (the branch is merged unreviewed, so a stray edit to
  application source aborts the phase).
  On `DONE` it runs the **fail-first proof** on every critical spec (red against the base
  branch with its `control:` assertion green; green against staging), merges only the proven
  critical specs into `staging-<run-id>`, then runs the full suite and applies the
  disposition. Authored specs execute under a **scrubbed, allowlisted env** (PATH/HOME plus
  the `FACTORY_E2E_*`/`BASE_URL` boot vars — never the full inherited `process.env`).

Both paths converge on the same suite-run decision, which returns one of:

- `{kind:"done", run_id}` — every critical spec is present and `passed`/`flaky` (a residual
  throwaway red becomes an advisory line in the report, never a blocker); the phase is
  marked `done` and the run proceeds to docs/finalize.
- `{kind:"reopen", run_id, task_ids, reason}` — a mappable failure; the named tasks are
  reset to `pending` carrying the failure as `e2e_feedback` (reusing the `resetTaskRow`
  rescue primitive). **The run status stays `running`** — only task rows reset. A critical
  **miss** (spec absent from results, or `failed`/`skipped` — not just red) reopens; pass 1
  additionally reopens for any mappable throwaway failure; pass 2+ reopens only for
  critical. The e2e phase re-fires once the reopened tasks settle.
- `{kind:"adjudicate", run_id, ...}` — a critical failure that **no manifest entry maps to a
  task** (a pre-existing committed spec, not authored this run). Rather than failing the run
  outright, the phase routes it through **adjudication** (D7) using the assessment's
  affected-specs forecast: a `should-still-pass` spec → reopen the mapped task; a `needs-update`
  spec → the adjudicator rewrites it to the new behavior; an **unforecast** spec → the
  adjudicator rules **regression** (fail loud, cited) vs **intentional-change** (rewrite +
  fail-first re-proof + merge + suite re-run). The in-flight adjudication is tracked by a cursor
  on `e2e_phase.adjudication`; each spec may be adjudicated **at most once per run**
  (`adjudication_counts`) — a spec failing again after its one adjudication is a regression.
- `{kind:"failed", run_id, reason}` — an adjudicated-**regression** verdict, a **tooling
  failure** (nonzero exit / reporter `errors[]` with no spec marked failed — never attributed
  to a task), an exhausted `e2e.reopenCap`, a rejected fail-first proof, a manifest referencing
  an unknown `task_id` or unsafe `spec_path`, an author branch violating the trust boundary, or
  a non-`DONE` author status. The docs phase is then skipped. A failed verdict is not permanent
  — `factory rescue apply --reset-e2e` (only once the underlying cause no longer applies) clears
  it, preserving the manifest + reopen counts (and dropping any live adjudication cursor), so
  the phase re-enters on the next pass.
- `{kind:"suspend", run_id, reason}` — the boot config could not be resolved (no config
  override and no assessment-resolved value); resumable via `/factory:resume`.

`next-task` schedules e2e before docs, so a failed e2e phase never reaches the docs or
rollup steps. See [Run with end-to-end tests](../guides/run-with-e2e.md).

### `run cancel`

Action. **Abandons a live run** so its owning session can stop — the in-session escape
from the Stop gate (Decision 35 addendum). Marks the run terminal by reusing `failed`,
via `state.finalize` **directly** (NOT the `run finalize` ship path): no rollup CI, no
merge, no PRD close. Because `finalize` validates only that the _target_ status is
terminal — never the task statuses — a run with a task still `executing` is cancellable
(the same mechanism `--supersede` uses). Idempotent for `failed`; a run already terminal
as `completed`/`superseded` is a loud error. A cancelled run is **not resumable** — start
fresh with `/factory:run`.

```
factory run cancel [--run <id>] [--cleanup] [--session-id <id>]
```

| Flag                | Notes                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--run <id>`        | The run to cancel. Default: the active run THIS session owns (`findActiveByOwner`, robust to a detached `runs/current`), then the current run for the checkout. Loud if none resolves. |
| `--cleanup`         | Also tear down the run's PINNED `staging-<run-id>` branch + its task PRs (protection first, then the branch — GitHub blocks deleting a protected ref). **Default (omit): leave them.** |
| `--session-id <id>` | Owning session id used to locate the run when `--run` is omitted. Defaults to `$CLAUDE_CODE_SESSION_ID`.                                                                               |

Unlike `run create`/`resume`, cancel has **no autonomy gate** — it is the documented exit
from the Stop gate and must work from any session. Emits `{kind:"cancelled", run, cleaned_up}`.

## `resume`

Action (Decision 35 — a top-level verb, distinct from `run`/`rescue`/`debug`).
Re-checks the live quota window and resumes a paused/suspended run if the binding
window recovered. Reads nothing else; leaves state untouched when blocked. A terminal
run is a loud error (nothing to resume). `factory run resume` is a thin alias of this
command. Unsure whether the run needs resume or rescue? Use
[`recover`](#recover) — it routes for you (resume IS its route 3).

```
factory resume [--run <id>] [--ignore-quota]
```

Subject to the same mandatory autonomy gate as `run create` (halts loud unless
`FACTORY_AUTONOMOUS_MODE=1`).

`--ignore-quota` persists `ignore_quota: true` on the run **before** the resume plan
runs, so `planResume` force-clears the checkpoint regardless of the live window reading,
and subsequent steps stay un-paced. It is a `boolean` operator override (a mistaken
suspend / manual reset), NOT a ship flag — unlike `--no-ship` (rejected
loud on resume), it combines freely. See
[Quota pacing — `--ignore-quota`](../explanation/quota-pacing.md#--ignore-quota--the-per-run-pacing-override).

`--run` defaults to **this repo's current run** — resolved from the caller's
checkout (`origin` remote → `<dataDir>/current/<repoKey>`), falling back to the
legacy global pointer when the repo can't be derived (see
[Per-repo current](#per-repo-current-run-resolution)). Emits one of:

- `{kind:"resumed", run}` — window recovered (or the run was already running).
- `{kind:"pause", run_id, status, reason, resets_at_epoch?}` — not
  recovered; state untouched.

## `state`

Reporter (read-only). Prints run state.

```
factory state                 # current run's state.json (JSON)
factory state <run-id>        # that run's state.json (JSON)
factory state --summary       # compact human summary
```

No current run is not an error: prints `{"current": null}` (or `no current run`
with `--summary`) and exits `0`. State corruption is loud.

With no `<run-id>`, the current run is resolved **per repo** from the caller's
checkout — see below. `score`, `rescue`, and `resume` resolve the same way.

### Per-repo current run resolution

The human reporters/actions that default to "the current run" (`state`, `score`,
`rescue`, `resume`) resolve it **per repo** from the shell's cwd, so two runs
in two different checkouts don't shadow each other:

1. derive the repo from the checkout's `origin` remote;
2. read `<dataDir>/current/<repoKey>` → that repo's current run;
3. if the repo can't be derived (no `origin`), fall back to the legacy global
   `runs/current` (the repo-less "most recent") — degrade-safe, never an error.

`--run <id>` always wins over this resolution; `next-action` ignores it entirely
(always requires `--run`). `next-task` is the one exception — it stays on the global
`runs/current` + `--assert-owner` mechanism (see [`next-task`](#the-orchestrator-next-task--next-action)),
because the runner always passes `--run` to it explicitly. This is CLI ergonomics
only: the hooks no longer read the global pointer at all (Decision 30), so
concurrency-correctness does not depend on it.

## The orchestrator (`next-task` + `next-action`)

The orchestrator is the engine's single control-flow seam. `next-task` is the **run-level**
orchestrator (which task is ready); `next-action` is the **task-level** orchestrator (run one task's
deterministic steps until it needs agents). The runner — the in-session event
loop (see [Run the pipeline](../guides/run-the-pipeline.md))
— alternates them: `next-task` to pick a task, `next-action` to advance it, spawn the agents
the request names, then `next-action --results` to record their output back. Neither orchestrator
spawns anything itself.

The six retired single-step writers — `run-task`, `advance`, `fail`,
`record-producer`, `record-holdout`, `record-reviews` — collapsed into the orchestrator.
Their record logic now runs inside `next-action --results` (`src/orchestrator/record.ts`); the
producer / holdout / reviews records are no longer separate CLI calls.

## `next-task`

Reporter (run-level orchestrator). One run-loop step: terminal check, quota gate
(persisting a pause/suspend checkpoint on breach), stale-checkpoint clear on
recovery, transitive cascade-fail of tasks blocked on an unsatisfiable dependency,
then the ready set. Writes only on a quota breach or a cascade-fail; otherwise
read-only. Throws LOUD on a dependency deadlock.

```
factory next-task [--run <id>]                          # defaults to runs/current
factory next-task --assert-owner <session>              # loud-assert runs/current ownership
```

`--assert-owner <session>` is an opt-in guard for a `next-task` that adopts
`runs/current` rather than passing `--run`, defending against a concurrent
`run create` having redirected `runs/current` onto a foreign run: it throws loud
if the resolved run's persisted `owner_session` disagrees with `<session>`.
Degrades safe (no assertion) when either side is unknown.

Manual `factory next-task` never needs it. It runs only on the `runs/current` path;
the explicit `--run <id>` path bypasses it.

Every envelope also carries the self-resolved run context (`run_id`, canonical
`data_dir`, `ship_mode`) so a caller adopts them from the first `next-task`.

Emits one of:

- `{ kind:"work", run_id, ready:[...], cascade_failed:[...], max_parallel }` — ready
  tasks, **in-flight first** (crash-resume finishes started work before opening
  new), then pending in spec order. `max_parallel` is the config's
  `maxParallelTasks` — the runner drives at most that many tasks in flight.
- `{ kind:"traceability", run_id, data_dir, ship_mode }` — all tasks are terminal and
  the run will complete (non-debug), but the PRD-traceability audit has not concluded
  (Decision 47). Ordered **after the e2e phase, before `document`**. The runner runs
  [`factory run traceability`](#run-traceability); a `failed` audit routes straight to
  `finalize` (which condemns the run), so `document` never runs on a condemned run.
- `{ kind:"document", run_id, data_dir, ship_mode }` — all tasks are terminal
  and the run will complete, but `/docs` needs updating first. The runner runs
  `factory run docs`, which emits a scribe spawn request; the runner spawns the scribe
  agent and records the docs commit onto the staging branch. `next-task` emits
  `finalize` only after that record.
- `{ kind:"finalize", run_id, cascade_failed:[...] }` — nothing left to
  schedule and the docs phase (when applicable) is already `done`; the runner
  calls `factory run finalize` next. `cascade_failed` is this-invocation-only.
- `{ kind:"done", run_id, run_status }` — the run is already terminal.
- `{ kind:"pause", run_id, scope, reason, resets_at_epoch? }` — a quota
  window blocked; the checkpoint is persisted.

## `next-action`

The per-task orchestrator (the engine seam). Resumes at the task's
persisted `phase` cursor, optionally records the previous spawn's agent results
(`--results`), then runs every deterministic phase it can until it needs agents or
the task is terminal. Emits ONE JSON `NextAction`.

```
factory next-action --run <id> --task <id> [--results <file>] [--ship-mode <mode>]
```

`--ship-mode` (`no-merge` | `live`) is the internal-seam override the runner passes
machine-side; omit it to honor the run's persisted `ship_mode` (users never type it —
the user-facing knob is `--no-ship` on `run create`/`run finalize`). Emits one of:

- `{ kind:"spawn", run_id, task_id, phase, result_key, request, holdout?, expects, worktree, base_ref }`
  — the agents to run (`request.agents`) and what to feed back. Each agent carries
  `{ role, model, max_turns, prompt_ref, isolation, effort? }`; `effort` (the `Agent`
  reasoning level) appears only on a high producer-escalation rung once the model
  dial has climbed to its ceiling (see [producer-ladder](../explanation/producer-ladder.md))
  and is omitted otherwise so the agent inherits the spawn default. `phase` is one of
  `tests | exec | verify` (preflight only advances; ship never spawns). `expects`
  is `producer-status` (tests/exec — one producer agent) or `reviews` (verify —
  the four-reviewer panel); a `holdout` accompanies `verify` when a holdout answer
  key was withheld. `worktree` is the task working tree the agents commit in.
  `base_ref` is the per-run staging base that worktree forked from
  (`origin/staging-<run-id>`); the panel and holdout validator diff against THIS, never
  a bare `origin/staging` (which namespace-collides after a repo branch rename). Its
  branch is resolved via `resolveStagingBranch(run_id, run.staging_branch)` — the name
  pinned in `RunState` at create ([state model](./state-model.md#runstate)), not
  recomputed — so it stays fixed to the branch already pushed to origin even if the
  naming scheme changes mid-run.
- `{ kind:"done", run_id, task_id, outcome }` — the task is `done` or a
  classified `failed`.
- `{ kind:"pause", run_id, task_id, scope, reason, resets_at_epoch? }`.

**The `--results` record.** `--results <file>` feeds back exactly what the previous
spawn envelope's `expects` named, and records it into ONE state step (advance, bump
the producer rung, or terminal). The file MUST echo the envelope's `result_key`
verbatim:

```
expects=producer-status → { "result_key": {…}, "producer": { "status": "<STATUS line>" } }
expects=reviews         → { "result_key": {…}, "holdout"?: { "raw": "<validator output>" },
                            "reviews": { reviews, verifications, crossVendorAbsent? } }
```

The record is **at-least-once delivery, exactly-once application**: the `result_key`
(`{phase, rung}`) is validated against the live cursor before any mutation, so a
stale or duplicate delivery is rejected LOUD rather than double-recorded. On a
rejection, re-invoke **without** `--results` to re-derive the current spawn
envelope (re-invoking without results is idempotent). When that re-derived spawn
matches a recorded `spawn_in_flight` checkpoint — i.e. a previous spawn for the
same `(phase, rung)` was emitted but never recorded (a stop in the post-spawn /
pre-record window) — the orchestrator first resets the shared task worktree to the
checkpoint's `tip_sha`, discarding the abandoned producer's partial commits before
re-spawning clean ([state model](./state-model.md#spawn_in_flight--idempotent-re-spawn-checkpoint)).
The `reviews` record runs the
full verify merge gate internally — re-runs the deterministic gates, re-derives the
persisted holdout evidence, citation-verifies the reviews against the worktree,
and confirms each surviving blocker via the supplied `verifications` (a kept
citable blocker with no recorded verdict fails closed). Holdout is recorded **before**
reviews. A refused live merge re-routes the task through `exec` to re-sync, bounded
by a persisted per-task budget (`merge_resyncs`).

## `score`

Reporter (read-only). Resolves the run + its spec, derives the partial report, and
emits the compact `RunSummary`.

```
factory score [--run <id>]
factory score --fleet
```

Emits `{ kind:"score", summary }`. The summary carries the S11 touch metric:
`touches` (length of the run's `human_touches` ledger) and `touch_metric`
(derived, never stored: `(completed ? 1 : 0) / touches` — `launch` counts, so a
clean lights-out run scores exactly `1.0`). Legacy runs without the ledger report
both as `null`.

`--fleet` reports the metric across **every** run in the store: emits
`{ kind:"fleet-score", runs:[{run_id, status, touches, metric}], aggregate }`
where `aggregate = sum(completed) / sum(touches)` over runs carrying the ledger
(`null` when none do). Malformed run dirs warn + skip (tolerant `listRuns`).

## `recover`

**The primary repair verb** (S10, Decision 48). Self-routing: scans the run and
does whatever a stalled run needs — nothing, resume, rescue-apply + reopen, or
page a human. `resume` and `rescue` remain as the underlying primitives /
flag-rich escape hatch; start with `recover`.

```
factory recover [--run <id>] [--auto] [--dry-run]
```

Routes (resolved in order) and their envelopes — all `EXIT.OK`:

| Route | Condition                | Envelope                                                                                                                                                                                                                                               |
| ----- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | no run resolves          | `{kind:"nothing", reason:"no-run"}`                                                                                                                                                                                                                    |
| 2     | `completed`/`superseded` | `{kind:"nothing", …}` + a `--recheck-rollup` hint when `rollup_pending` (stays human-asserted)                                                                                                                                                         |
| 3     | parked + clean scan      | resume via the normal quota gate → `{kind:"resumed"}` or `{kind:"pause"}`, each with a **derived** `awaiting` cause (`quota`/`e2e`/`docs`/`traceability`/`spec-approval`/`unknown` — never stored)                                                     |
| 4     | resettable work          | rescue-apply + reopen (+ the resume gate if a park survives) → `{kind:"rescued", reset, reopened, reconcile, resume?}`; `reconcile:true` when the git probe flags drift — the command doc then spawns `rescue-reconciler`; the CLI never spawns agents |
| 5     | dead-ends only           | `{kind:"page", dead_ends, hints}` with per-task `rescue apply --task <id> --include-dead-ends` hints                                                                                                                                                   |

`--dry-run` emits the scan + chosen route, writes nothing (subsumes `rescue scan`).

`--auto` is the runner's bounded self-heal (fired ONCE after a failed finalize;
mutually exclusive with `--dry-run`). It resets only the _effective_ auto-safe set
(resettable tasks that stay actionable post-reset — never dead-ends, e2e resets,
rollup rechecks, or git drift) and stamps `self_heal {attempts, last_at}` — the
sanctioned stored-event exception. It requires `attempts === 0`; a blocked auto
(`attempts > 0`, empty effective set, or dead-ends only) emits `{kind:"page"}`
and posts ONE deduped PRD comment. `--auto` never appends a human touch.

## `rescue <scan|apply>`

The flag-rich **escape hatch** under [`recover`](#recover) — reach for it when
you need to name exact tasks, include dead-ends, reset e2e, or recheck a rollup.
`rescue scan` is equivalent to `recover --dry-run`. The `/factory:rescue` command
pairs these subcommands with the `rescue-reconciler` agent (git/GitHub drift
repair) before handing off to [`resume`](#resume) — see
[Rescue a stalled run](../guides/rescue-a-stalled-run.md).

### `rescue scan`

Reporter (read-only). Classifies every task and reports what a re-drive would do.

```
factory rescue scan [--run <id>]
```

Emits a `RescueScan`: `{ run_id, run_status, counts, resettable, dead_ends,
needs_rescue, e2e_failed, e2e_assessment_failed, rollup_pending, would_deadlock, summary, tasks }`.
Dispositions: `shipped`, `runnable`, `stuck` (crashed in-flight), `recoverable`
(`blocked-environmental` fail), `dead-end` (`spec-defect`/`capability-budget` fail).
Default-resettable = `stuck ∪ recoverable`. `e2e_failed` is `true` iff
`run.e2e_phase.status === "failed"` and `e2e_assessment_failed` is `true` iff
`run.e2e_assessment.status === "failed"` (the run-start assessment, Decision 40 D3) — both
fold into `needs_rescue` so a run stuck ONLY on a failed e2e phase or assessment (every task
`done`, `resettable` empty) still scans as needing rescue, not "nothing to do". Both are
cleared by `apply --reset-e2e`.
`rollup_pending` is `true` iff `run.rollup?.merged === false` — a `completed` run whose
staging→develop rollup was **armed but never landed** (e.g. the "auto-armed" branch-policy
fallback, D3). It also folds into `needs_rescue` (from a purely durable-state check, no live
GitHub call) but is **never auto-recovered** — only `apply --recheck-rollup` acts on it.

The scan also appends a read-only `work` field — a git-grounded recoverable-work survey
(`assessWork`, `src/rescue/assess.ts`):

```
"work": {
  "base_ref": "origin/staging-<run-id>",
  "base_resolved": true,
  "tasks": [
    { "task_id", "branch", "branch_exists", "commits_ahead", "pr_number?" }
  ]
}
```

One entry per **non-shipped branched** task (`done` and branchless tasks are skipped),
in `run.tasks` order. `commits_ahead` counts the commits the local `factory/<run>/<task>`
branch carries above the run's staging base (`origin/staging-<run-id>`), so a failed task
that got far before failing shows a high count vs an empty one. `commits_ahead` is `null`
(not `0`) when the base or branch is unresolvable — `0` means "branch exists but adds
nothing"; `null` means "nothing to count against". `base_resolved: false` (a deleted
staging branch) nulls every count. This is **evidence only** — nothing here reuses or
deletes a commit; resume still re-cuts a reset branch from staging and redoes the work.
Backed by new `GitClient.refExists`/`commitsAhead` (`src/git/git-client.ts`).

### `rescue apply`

Writer. Resets the resettable tasks to `pending` and reopens a terminal run.

```
factory rescue apply [--run <id>] [--task <id>]... [--include-dead-ends] [--reset-e2e] [--recheck-rollup]
```

| Flag                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--task <id>`         | Reset exactly this task (repeatable). Overrides the default set; a `done` task is a loud error, a `pending` one is skipped; a named dead-end IS reset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--include-dead-ends` | Also reset dead-end fails. Use only after the root cause is fixed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--reset-e2e`         | Clears a `failed` e2e-phase verdict so it re-enters, **and** drops a `failed` run-start `e2e_assessment` (Decision 40 D3) so the assessment re-runs. A post-authoring e2e-phase failure keeps its manifest + reopen counts + `adjudication_counts` and drops any live `adjudication` cursor; a pre-authoring failure (empty manifest) drops `e2e_phase` entirely so the author re-spawns. Use only once the underlying cause no longer applies — alone sufficient to reopen a terminal run even when no task is resettable. The phase repair is **decoupled from reopening**: it also fires on a **non-terminal** run (e.g. a crash between e2e's `markFailed` and finalize left the run `running`), so the documented recovery never silently no-ops. |
| `--recheck-rollup`    | Reopens a `completed` run whose rollup **armed but never landed** (`rollup_pending`) so a re-drive re-enters `finalizeRun` and its `rollup()` resume-guard picks up the now-merged PR (PRD-close + branch-GC). Use only after confirming the queued merge landed — alone sufficient to reopen a terminal run, and its repair likewise applies on a non-terminal run. Reopen only: `apply` never mutates the `rollup` pointer, only `finalizeRun` does.                                                                                                                                                                                                                                                                                                 |

Default (no `--task`): resets `stuck` + `recoverable`, leaving dead-ends failed;
reopens a terminal run to `running` when it reset work (or when `--reset-e2e` clears
a failed e2e phase, or `--recheck-rollup` targets an armed-not-landed rollup).
Idempotent. Emits `{ run_id, run_status, reset, reopened, skipped }`.

## `autonomy <ensure|status|preflight>`

Autonomous mode is **mandatory** for a run (`run create`/`resume` halt without it —
[Decision 29](../explanation/decisions.md#decision-29-autonomy-is-mandatory--enforced-in-the-engine-no-opt-out)). These verbs set it up and check it. `preflight` is the **run-entry composer** `/factory:run` calls; `ensure`/`status` are the manual primitives.

### `autonomy ensure`

Writer (default verb). Materializes the merged settings file an autonomous (headless) relaunch
runs under. Merges `templates/settings.autonomous.json` with your existing
user settings into `${CLAUDE_PLUGIN_DATA}/merged-settings.json`: placeholders
(`${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}`) substituted, `env.CLAUDE_PLUGIN_DATA`
baked, `permissions.allow` unioned (template wins on other keys), and the
`statusLine` wired to `factory statusline`. If your own (non-factory) `statusLine`
is present it is preserved by chaining it through `FACTORY_ORIGINAL_STATUSLINE`;
a stale chain value is failed. Then prints the relaunch command.

```
factory autonomy ensure [--user-settings <path>]
```

| Flag                     | Required | Notes                                                                   |
| ------------------------ | -------- | ----------------------------------------------------------------------- |
| `--user-settings <path>` | no       | Override the user-settings source (default: `~/.claude/settings.json`). |

Prints a human-readable relaunch message to stdout that includes the command
`claude --settings <merged-settings.json>` — not a `{kind:…}` envelope.

### `autonomy status`

Reporter. Reports whether the current session satisfies the autonomy gate. **Exits 0
when autonomous, 1 when not — and never throws** (it is the diagnostic you run precisely
when the gate has halted you).

```
factory autonomy status [--json]
```

| Flag     | Required | Notes                                          |
| -------- | -------- | ---------------------------------------------- |
| `--json` | no       | Emit the machine-readable payload (see below). |

`--json` emits `{ autonomous, envSet, mergedSettingsPresent, mergedSettingsPath }`:
`autonomous` is the gate predicate (`FACTORY_AUTONOMOUS_MODE === "1"`); `envSet`
distinguishes an unset var from a wrong value; `mergedSettingsPresent`/`mergedSettingsPath`
report whether the `ensure` output exists and where.

### `autonomy preflight`

Composer — the run-entry check `/factory:run` (and `/factory:debug`) calls at the top of
setup ([Decision 31](../explanation/decisions.md#decision-31-run-entry-preflight-auto-scaffolds-autonomous-settings)).
It restores the old auto-scaffold convenience: rather than merely halting and telling you to
run `ensure` yourself, it **decides** whether the run may proceed and (re)scaffolds for you
when it can't.

```
factory autonomy preflight [--user-settings <path>]
```

The verdict is a pure function of three inputs — is this session autonomous, does
`merged-settings.json` exist, and does its stamped `_factoryVersion` match the installed
plugin version:

| Autonomous? | Settings file | Version           | Outcome                                                       |
| ----------- | ------------- | ----------------- | ------------------------------------------------------------- |
| no          | (any)         | (any)             | **regenerate + halt** (`missing-settings` / `not-autonomous`) |
| yes         | absent        | —                 | **proceed** (`ci-raw-env` — env exported directly)            |
| yes         | present       | match             | **proceed** (`fresh`)                                         |
| yes         | present       | differ            | **regenerate + halt** (`stale-version`)                       |
| yes         | present       | unstamped         | **regenerate + halt** (`unstamped`)                           |
| yes         | present       | plugin unknowable | **proceed** (`version-unknowable` — no churn)                 |

On a halt it delegates to `ensure` (the single writer path) to (re)materialize the settings,
prints the same `claude --settings <merged-settings.json>` relaunch block plus a one-line
reason, and **exits 1**. On proceed it writes nothing and **exits 0**. Like `status`, it is
infallible on the decision path (an unresolvable data/root dir degrades to a halt-with-message,
never a throw). The relaunch itself is irreducible — Claude Code reads settings only at launch,
so a running session can never make _itself_ autonomous; preflight automates the scaffold, not
the relaunch. The mandatory-autonomy engine gate (`requireAutonomousMode`, Decision 29) stays as
the correctness backstop behind it.

| Flag                     | Required | Notes                                                             |
| ------------------------ | -------- | ----------------------------------------------------------------- |
| `--user-settings <path>` | no       | Override the user-settings source passed through to a regenerate. |

## `statusline`

Side-effecting passthrough — NOT a machine subcommand. Wire it as the Claude Code
`statusLine.command`. Claude Code pipes a JSON payload to stdin on every statusline
tick; this subcommand:

1. reads the whole stdin payload (may be empty / non-JSON),
2. if it carries `.rate_limits`, atomically persists `rate_limits + {captured_at}`
   to `${CLAUDE_PLUGIN_DATA}/usage-cache.json` — the ONLY producer of the cache the
   quota pacer (`StatuslineUsageSignal`) reads,
3. passes the SAME payload through to `$FACTORY_ORIGINAL_STATUSLINE` (if set) and
   forwards ITS stdout as the displayed statusline (with a 3s timeout).

```
factory statusline
```

IO contract: stdout is the DISPLAYED statusline text (passthrough), never a
`{kind:…}` envelope. Fail-soft invariant: the statusline fires constantly and must
never crash — every degraded condition (empty/non-JSON stdin, no `rate_limits`,
unresolvable data dir, a broken/slow original command) is a clean no-op returning
exit 0. Diagnostics go to stderr; a cache-write failure is additionally surfaced
inline in the displayed text (`[factory: usage-cache …]`) so a silently stale
quota cache is visible.

**Run-progress suffix (S11, [Decision 49](../explanation/decisions.md#decision-49--observability-touch-metric--statusline-progress--score---fleet)).**
When a current run exists, the displayed text gains a suffix
` [factory <done>/<total> <phase> <run_id> <status>]` — shipped/total task counts,
the first in-flight task's phase, the run id, and the run status. It reads the
global `runs/current` symlink straight through to `state.json` with a plain
`JSON.parse` (never `parseRunState`): a torn concurrent write, schema mismatch, or
missing pointer degrades to **no suffix**, never a throw. Terminal runs
(`completed`/`failed`/`superseded`) linger for **30 minutes** past `ended_at`, then
the suffix disappears. Set `FACTORY_STATUSLINE_PROGRESS=0` to suppress the suffix
entirely (the usage-cache write is unaffected). Known limit: under two concurrent
runs in different repos the global pointer shows the most recent writer (a
statusline tick has no cwd to key a per-repo pointer from).

## `debug <start|review|spec|seed|finalize>`

The `/factory:debug` whole-scope review⇄fix loop: review the CURRENT state of a
checkout (not a PRD), convert adjudicated findings into a fix spec, run the fix
tasks through the normal task pipeline, and repeat for a bounded number of passes.

```
factory debug start [--base <ref> | --full] [--no-ship] [--author-e2e] [--max-passes <n>] [--session-id <id>]
factory debug review --emit --run <id>
factory debug review --record --run <id> --results <path>
factory debug spec resolve|gate|store --run <id>
factory debug seed --run <id>
factory debug finalize --run <id> [--no-ship]
```

| Action     | What it does                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `start`    | Cut the debug staging branch from the target's HEAD, mint the run id, emit the pass-1 review scope. |
| `review`   | `--emit` spawns the whole-scope review panel; `--record` adjudicates its output.                    |
| `spec`     | Thin pass-through to `factory spec resolve\|gate\|store` fed a synthetic PRD.                       |
| `seed`     | Create (pass 1) or append (pass > 1) the run's tasks from the resolved spec.                        |
| `finalize` | Turn an all-terminal debug run into its shipped outcome.                                            |

The in-session runner drives the agent spawns AND the bounded review⇄fix loop;
each action emits ONE JSON envelope naming the next step. Scratch JSON lives in
`<dataDir>/debug/<run-id>/{session.json,pass-<n>/findings.{json,md}}`. A debug
run resumed via `factory resume` answers `{ kind:"debug-resume", run_id, run }` —
continue it with `factory debug`, not the PRD pipeline.
