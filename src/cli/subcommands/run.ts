/**
 * `factory run <create|resume|finalize|docs|cancel>` — the run-lifecycle entrypoint (C6).
 *
 * Model A: the CLI never spawns an agent. `run create` resolves a DURABLE spec (by
 * stable issue number or explicit spec-id), creates a fresh run, SEEDS its task
 * rows from the spec, and emits the {@link RunState}; the in-session runner
 * reads `run_id` and drives the run through the orchestrator seam (`factory next-task` +
 * `factory next-action`).
 *
 * `run resume` is the human-invoked resumable entrypoint (Decision 24, Δ F — v1 is
 * HUMAN relaunch only; the v2 scheduler would fire this same path). It re-reads the
 * LIVE quota window through the pure {@link planResume} seam and, when the binding
 * window has recovered, clears the checkpoint and returns the run to `running`;
 * otherwise it reports why resume did not proceed and leaves state untouched. A
 * terminal run is a LOUD error — there is nothing to resume.
 *
 * Seeding maps each {@link SpecTask} to a `pending` {@link TaskState} carrying ONLY
 * the dependency edges (a frozen denormalization for hot DAG traversal) — never the
 * `risk_tier` dial (read live from the spec via `specTaskOf`, derive-don't-store)
 * and never `tdd_exempt` (read from `spec/tasks.json` at runtime, never from
 * `state.json`). Dangling,
 * self, cyclic, and duplicate dependency edges are caught LOUDLY at seed time rather
 * than surfacing later as a orchestrator deadlock.
 */
import { EXIT, type ExitCode } from "../../shared/exit-codes.js";
import { parseArgs, isUsageError, UsageError, optionalString } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { loadConfig, resolveDataDir } from "../../config/index.js";
import { StateManager, seedTaskRows, assertAcyclic } from "../../core/state/index.js";
import { SpecStore, type SpecManifest } from "../../spec/index.js";
import { makeRunId, validateId } from "../../shared/ids.js";
import { nowEpoch, parseIso8601ToEpoch } from "../../shared/time.js";
import { planResume, StatuslineUsageSignal, type UsageReading } from "../../quota/index.js";
import { isTerminalRunStatus } from "../../types/index.js";
import type { Config, RunState, RunStatus, TaskState } from "../../types/index.js";
import {
  finalizeRun,
  runDocsEmit,
  runDocsRecord,
  DocsResultsSchema,
  runE2eEmit,
  runE2eRecord,
  E2eResultsSchema,
  readJsonInput,
} from "../../orchestrator/index.js";
import { loadCliDeps } from "../wiring.js";
import {
  DefaultGitClient,
  DefaultGhClient,
  ensureStaging,
  provisionProtection,
  runStagingBranch,
  resolveStagingBranch,
  resolveRepo,
  splitRepoSlug,
  type GitClient,
  type GhClient,
} from "../../git/index.js";
import { readCurrentForCwd, type CurrentRunOverrides } from "../current.js";
import { requireAutonomousMode } from "../../autonomy/mode.js";
import { createLogger } from "../../shared/index.js";
import type { Subcommand } from "../registry-types.js";

const log = createLogger("run");

const RUN_HELP = `factory run — create or resume a run

Usage:
  factory run create [--repo <owner/name>] (--issue <n> | --spec-id <id>) [--run-id <id>]
  factory run resume [--run <id>]
  factory run finalize [--run <id>] [--no-ship]
  factory run docs [--run <id>] [--results <path>]
  factory run e2e [--run <id>] [--results <path>]
  factory run cancel [--run <id>] [--cleanup] [--session-id <id>]

Actions:
  create     Resolve a durable spec, create a run, seed its tasks, emit the RunState.
  resume     Re-check the live quota window; clear the checkpoint if it has recovered.
  finalize   Build the run report, file per-failure issues, ship the rollup only when completed, flip terminal.
  docs       Emit the documentation-phase spawn request, or (with --results) record a scribe result.
  e2e        Emit the e2e-phase spawn request, or (with --results) record the e2e author's manifest.
  cancel     Abandon a live run (mark it failed; not resumable); --cleanup also tears down its branch.`;

const CREATE_HELP = `factory run create — create a run and seed its tasks from a durable spec

Usage:
  factory run create [--repo <owner/name>] (--issue <n> | --spec-id <id>) [--run-id <id>] [--new | --supersede | --resume] [--workflow] [--no-ship] [--ignore-quota] [--e2e] [--session-id <id>]

  --repo        OPTIONAL. Repo identity 'owner/name' (the first key of the spec store).
                Auto-derived from the 'origin' remote when omitted; an explicit value
                that disagrees with the remote fails loud.
  --issue       PRD issue number — the STABLE lookup key (reruns reuse the spec).
  --spec-id     Explicit '<issue>-<slug>' spec id (alternative to --issue).
  --run-id      Override the generated 'run-YYYYMMDD-HHMMSS' id (determinism/tests).
                A named id is an address: it forces a fresh imperative create.
  --new         Force a fresh run even if a live one already exists for this spec.
  --supersede   Terminate the active run for this spec, then create a fresh one.
  --resume      Continue the active run for this spec (full hand-off: forthcoming).
  --workflow    Run the parallel background Workflow runner. Default (no flag): session —
                the in-session, quota-paced runner loop.
  --no-ship     Open the rollup PR but never merge. Default (no flag): live — auto-merge
                each task into staging and merge the staging→develop rollup into develop.
                Persisted on the run so the workflow runner + resume + finalize read it
                without re-passing.
  --ignore-quota Bypass the weekly-quota hard stop AND the per-step quota pacer for this run.
                Persisted as ignore_quota:true so both orchestrators + orchestrators skip the gate
                without re-passing — lets create/--supersede proceed past a 7d-parked run.
  --e2e         Opt into the run-level e2e phase (Decision 39): after all tasks are terminal,
                author + run Playwright journeys against staging before docs/finalize; a
                mappable failing journey reopens its task with feedback. Persisted as e2e:true.
  --session-id  Owning Claude Code session id for the session-scoped Stop gate (Prompt J).
                Defaults to $CLAUDE_CODE_SESSION_ID; absent ⇒ owner-unknown (Stop gate unscoped).

Resolves the spec via the durable store (LOUD if none exists — generate one first).
On an ACTIVE run for this (repo, spec_id): exits CONFLICT (3) and reports it — pass
--resume to continue it or --supersede to replace it; --new (or an explicit --run-id)
forces a fresh run regardless. Seeds one pending task per spec task and emits the
RunState JSON (run_id is the top-level field).`;

const RESUME_HELP = `factory run resume — re-check quota and resume a paused/suspended run

Usage:
  factory run resume [--run <id>]

  --run   The run to resume (defaults to runs/current).

Emits ONE JSON envelope:
  { kind:"resumed", run }                              — window recovered (or already running)
  { kind:"pause", run_id, status, reason, … }  — window has not recovered (state untouched)

A terminal run is a loud error (nothing to resume).`;

const FINALIZE_HELP = `factory run finalize — turn an all-terminal run into its shipped outcome

Usage:
  factory run finalize [--run <id>] [--no-ship]

  --run       The run to finalize (defaults to runs/current).
  --no-ship   Open the rollup PR but never merge it — overrides the run's persisted ship
              mode for THIS finalize only. Default: honor the persisted ship_mode (live
              merges the staging→develop rollup; no-merge opens it only).

Builds the deterministic partial-run report (report.md), emits run.finalized
telemetry, on a failed run comments the failed tasks on the PRD issue (deduped),
opens + CI-gates + (when shipping live) squash-merges the staging→develop rollup,
then flips the run terminal — in that resume-safe order. LOUD if any task is still
non-terminal.

Emits ONE JSON envelope:
  { kind:"finalized", run, report, rollup?, failure_comment_posted }`;

const CANCEL_HELP = `factory run cancel — abandon a live run (mark it failed; not resumable)

Usage:
  factory run cancel [--run <id>] [--cleanup] [--session-id <id>]

  --run         The run to cancel. Default: the active run THIS session owns
                (--session-id / $CLAUDE_CODE_SESSION_ID), else runs/current.
  --cleanup     Also tear down the run's staging branch + task PRs (like --supersede).
                Default: leave them in place for manual handling.
  --session-id  Owning session id used to locate the run when --run is omitted
                (defaults to $CLAUDE_CODE_SESSION_ID).

The explicit abandon verb: marks the run 'failed' via the one sanctioned state writer —
works even with a task still executing (no rollup CI, no ship). Idempotent; a run already
terminal as completed/superseded is a LOUD error. NOT resumable (cancelled is terminal) —
start a fresh run instead. (A session no longer needs this to stop: the Stop hook lets a
session end and leaves the run resumable; cancel is for deliberately discarding a run.)

Emits ONE JSON envelope:
  { kind:"cancelled", run, cleaned_up }`;

// ---------------------------------------------------------------------------
// Seeding (pure)
// ---------------------------------------------------------------------------

/**
 * Map a durable {@link SpecManifest} to the run's initial `pending` task rows.
 * Each task carries ONLY dependency edges (`depends_on`); neither `risk_tier` nor
 * `tdd_exempt` is persisted — both read live from the spec (Decision 25). LOUD on a duplicate task id, an unsafe id charset, a self-dependency,
 * a dangling dependency, or a dependency cycle — all are spec-integrity defects
 * that would otherwise deadlock the orchestrator.
 */
export function seedTasksFromSpec(request: SpecManifest): Record<string, TaskState> {
  const ctx = { context: "run create", specLabel: `spec ${request.spec_id}` };
  const tasks = seedTaskRows(request.tasks, ctx);
  assertAcyclic(tasks, ctx);
  return tasks;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Git/gh deps needed to cut + protect the per-run staging branch (Decision 33).
 * Passed from `runCreate` into `createRunFromManifest` after all deps are wired.
 * Absent on the bare `createRun` (direct-API) path so existing unit tests that
 * call `createRun` directly continue to work without fakes.
 */
export interface RunStagingDeps {
  readonly gitClient: GitClient;
  readonly ghClient: GhClient;
  readonly config: Config;
  readonly targetRoot: string;
  readonly owner: string;
  readonly repo: string;
}

/**
 * Selects the durable spec to run — EXACTLY one of the two keys, never both,
 * never neither. The `?: never` padding makes the XOR a genuine TYPE constraint:
 * a bare `{ issue } | { specId }` only forbids NEITHER (a both-keys object still
 * structurally satisfies `{ issue: number }`), so each arm explicitly forbids the
 * OTHER key. Both illegal states (neither / both) are now compile errors, not just
 * runtime checks. {@link resolveSpec} discriminates on the VALUE
 * (`opts.specId !== undefined`), not `"specId" in opts` — the `?: never` padding keeps
 * the unused key structurally present, so the `in` test would not discriminate cleanly.
 */
export type SpecSelector =
  | { readonly issue: number; readonly specId?: never }
  | { readonly specId: string; readonly issue?: never };

/**
 * The run-creation intent — exactly one of the mutually-exclusive lifecycle modes
 * (Decision 35). Modeled as a discriminated union so illegal combinations
 * (force+supersede, supersede+resume, …) are UN-REPRESENTABLE at compile time — the
 * same illegal-states-unrepresentable discipline {@link SpecSelector} uses for
 * issue/spec-id — replacing three independent booleans whose XOR was only runtime-checked.
 *
 *  - `"default"`   : resolve-or-report — an active run is returned as kind:"exists" (CONFLICT).
 *  - `"fresh"`     : `--new` / an explicit `--run-id` — always create, even if a run exists.
 *  - `"supersede"` : Decision 35 — terminate the active run + create a fresh one. Requires
 *                    `stagingDeps` (the gh client must be wired) to delete the old branch.
 *  - `"resume"`    : signal intent to continue the active run; currently reported as
 *                    kind:"exists" (the caller hand-off is Task 4.2).
 */
export type RunIntent =
  | { readonly intent?: "default" }
  | { readonly intent: "fresh" }
  | { readonly intent: "supersede" }
  | { readonly intent: "resume" };

/** Resolved options for {@link createRun} — {@link SpecSelector} + {@link RunIntent} + run metadata. */
export type CreateRunOptions = SpecSelector &
  RunIntent & {
    readonly repo: string;
    readonly runId: string;
    readonly mode?: RunState["mode"];
    readonly shipMode?: RunState["ship_mode"];
    /**
     * The owning Claude Code session id (Prompt J — session-scoped Stop gate),
     * stamped once onto the run so the Stop hook can session-scope its block. Absent
     * when the launching session id could not be resolved (best-effort).
     */
    readonly ownerSession?: RunState["owner_session"];
    /** When true, persist `ignore_quota: true` on the run (from `--ignore-quota`). */
    readonly ignoreQuota?: boolean;
    /** When true, persist `e2e: true` on the run (from `--e2e`) — opts into the e2e phase. */
    readonly e2e?: boolean;
    /**
     * When true, persist `debug: true` on the run — a `/factory:debug` session
     * (Decision 39, Task 6). No CLI flag on `run create`; only the debug driver
     * (`factory debug seed`) ever passes this.
     */
    readonly debug?: boolean;
  };

/**
 * Resolve the durable spec named by `opts` — by explicit spec-id when given, else
 * by the stable issue number. LOUD if no spec exists yet (a run cannot be created
 * without one). Shared by {@link createRun} (imperative) and {@link resolveOrCreateRun}
 * (resolve-or-reuse) so the spec is resolved exactly once on each path.
 */
async function resolveSpec(specStore: SpecStore, opts: CreateRunOptions): Promise<SpecManifest> {
  // The selector is a discriminated union — these two arms are exhaustive (no
  // neither/both case can reach here, so no defensive fallback is needed). Narrow
  // on the VALUE (`specId !== undefined`): the `?: never` padding keeps the unused
  // key structurally present, so `"specId" in opts` would not discriminate cleanly.
  if (opts.specId !== undefined) {
    return specStore.read(opts.repo, opts.specId);
  }
  const resolved = await specStore.resolveByIssue(opts.repo, opts.issue);
  if (resolved === null) {
    throw new Error(
      `run create: no spec for issue #${opts.issue} in ${opts.repo} — generate one first`,
    );
  }
  return resolved;
}

/**
 * Create the run from an already-resolved request and seed its tasks — the
 * imperative core. Creates the run (status `running`), then records in the seeded
 * task rows via the one sanctioned write path; returns the seeded {@link RunState}.
 *
 * When `stagingDeps` is supplied (always from `runCreate`; absent on the bare
 * `createRun` direct-API path), cuts `staging-<run-id>` from `develop` and
 * provisions GitHub branch protection on it (Decision 33). The cut + protect runs
 * AFTER the run state row is persisted so `run.run_id` is guaranteed to exist.
 */
async function createRunFromManifest(
  state: StateManager,
  specStore: SpecStore,
  request: SpecManifest,
  opts: CreateRunOptions,
  stagingDeps?: RunStagingDeps,
): Promise<RunState> {
  // Decision 24: workflow mode disables quota pacing. Warn ONCE here — at opt-in
  // (run creation) — not on every step; the gate then proceeds silently.
  if (opts.mode === "workflow") {
    log.warn(
      "workflow mode: quota pacing disabled — relying on hard rate-limit errors; long runs may exhaust limits",
    );
  }
  const seeded = seedTasksFromSpec(request);
  // Decision 33 hardening: compute the per-run staging branch ONCE and PIN it on the
  // row, so every later base-ref resolution reads this exact name (never a recompute
  // that a mid-run naming-scheme change could desync). Reused below for the actual cut.
  const branch = runStagingBranch(opts.runId);
  await state.create({
    run_id: opts.runId,
    spec: specStore.toPointer(request),
    staging_branch: branch,
    // v1 orchestrator seam drives tasks strictly one at a time — the execution-mode dial is fixed.
    execution_mode: "sequential",
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.shipMode !== undefined ? { ship_mode: opts.shipMode } : {}),
    ...(opts.ownerSession !== undefined ? { owner_session: opts.ownerSession } : {}),
    ...(opts.ignoreQuota === true ? { ignore_quota: true } : {}),
    ...(opts.e2e === true ? { e2e: true } : {}),
    ...(opts.debug === true ? { debug: true } : {}),
  });
  const run = await state.update(opts.runId, (s) => ({ ...s, tasks: seeded }));

  // Decision 33: cut + protect the per-run staging branch AFTER the run row exists.
  if (stagingDeps !== undefined) {
    await ensureStaging({
      gitClient: stagingDeps.gitClient,
      stagingBranch: branch,
      baseBranch: stagingDeps.config.git.baseBranch,
      cwd: stagingDeps.targetRoot,
    });
    await provisionProtection({
      ghClient: stagingDeps.ghClient,
      owner: stagingDeps.owner,
      repo: stagingDeps.repo,
      branch,
      requiredChecks: stagingDeps.config.git.requiredStatusChecks,
      provision: true,
    });
  }

  return run;
}

/**
 * Resolve the durable spec, create the run, and seed its tasks — the testable
 * IMPERATIVE core of `run create` (always creates; clobbers loudly via
 * {@link StateManager.create} if `runId` already exists). Reuse semantics live in
 * {@link resolveOrCreateRun}; this stays unconditional so callers that name a run
 * id (determinism/tests) get a predictable create.
 *
 * INTENTIONALLY omits `stagingDeps` — this bare direct-API export creates the run
 * row WITHOUT cutting/protecting a `staging-<run-id>` branch. Every production run
 * goes through `runCreate`, which supplies `stagingDeps`. Do NOT route a real run
 * through here expecting a staging branch (Decision 33).
 */
export async function createRun(
  state: StateManager,
  specStore: SpecStore,
  opts: CreateRunOptions,
): Promise<RunState> {
  return createRunFromManifest(state, specStore, await resolveSpec(specStore, opts), opts);
}

/**
 * Outcome of {@link resolveOrCreateRun} — a discriminated union (Decision 35).
 *
 * - `"created"`: no active run existed (or `--supersede` cleared it) and a fresh run
 *   was minted. `.run` is the new {@link RunState}.
 * - `"exists"`: an active run exists and no `--supersede`/`--resume` flag was given.
 *   The CALLER decides what to do; `runCreate` fails loud with an actionable message.
 *   `.existing` is the live {@link RunState}.
 * - `"superseded"`: `--supersede` was given; the old run was marked `superseded` and
 *   its branch deleted, then a fresh run was created. `.run` is the new run;
 *   `.supersededId` is the old run's id.
 */
export type ResolveOrCreateResult =
  | { readonly kind: "created"; readonly run: RunState }
  | { readonly kind: "exists"; readonly existing: RunState }
  | { readonly kind: "superseded"; readonly run: RunState; readonly supersededId: string }
  /**
   * A weekly-quota (7d) park is active and `--ignore-quota` was not passed. Creating
   * or superseding is blocked until the window resets or `--ignore-quota` overrides.
   * The `--resume` intent is never blocked here (it falls through to the live-gated
   * `/factory:resume` path, which re-checks the window on the fresh session).
   */
  | { readonly kind: "pause"; readonly existing: RunState };

/**
 * Supersede an active run (Decision 35): tear down its protection (GitHub blocks
 * deleting a protected ref) + `staging-<run-id>` branch (auto-closing its task PRs),
 * THEN mark it `superseded`. Terminal write is LAST — the resume-safe convention
 * {@link finalizeRun} uses: a teardown throw (401/403/5xx; already-gone 404/422 is
 * tolerated by the gh client) leaves the old run NON-terminal, so `findActiveBySpec`
 * still resolves it and re-running `run --supersede` retries the whole step idempotently,
 * leaving NO orphaned protected branch. (Finalizing FIRST would strand it: a terminal
 * `superseded` run is excluded from the active scan, so nothing ever re-tears its branch
 * down — rescue scopes out branch GC.) This is the DELIBERATE inverse of {@link runCancel},
 * which finalizes FIRST because its priority is releasing the Stop gate even if teardown
 * fails; supersede has no gate, so a clean, recoverable replacement wins.
 */
async function supersedeRun(
  state: StateManager,
  existing: RunState,
  stagingDeps: RunStagingDeps,
): Promise<void> {
  // Resolve the PINNED branch: superseding must tear down the branch the run actually
  // cut, not a recompute that a mid-run naming change could have desynced (Decision 33).
  const branch = resolveStagingBranch(existing.run_id, existing.staging_branch);
  await stagingDeps.ghClient.deleteProtection(stagingDeps.owner, stagingDeps.repo, branch);
  await stagingDeps.ghClient.deleteRemoteBranch(stagingDeps.owner, stagingDeps.repo, branch);
  await state.finalize(existing.run_id, "superseded"); // terminal LAST (resume-safe)
}

/**
 * Resolve the spec, then (unless `opts.intent === "fresh"`) inspect the active run for
 * this `(repo, spec_id)` and return a discriminated result (Decision 35):
 *
 * - `{ kind: "created" }` — no active run; a fresh run was created.
 * - `{ kind: "exists" }` — an active run exists and no flag was given; the CALLER
 *   decides. `runCreate` fails loud with an actionable message here.
 * - `{ kind: "superseded" }` — `--supersede` given; the old run was finalized +
 *   its branch deleted, then a fresh run was created.
 *
 * The scan→create is serialized under a per-(repo, spec_id) lock so two concurrent
 * same-spec creates can't both observe "no active run" and mint two orphan runs —
 * the per-run clobber guard in {@link StateManager.create} only catches a same
 * run_id collision, not a same-spec one.
 *
 * `stagingDeps` is forwarded to {@link createRunFromManifest} on the fresh-create
 * path to cut + protect the per-run staging branch (Decision 33), and is required
 * by the `--supersede` path to delete the old run's branch.
 */
export async function resolveOrCreateRun(
  state: StateManager,
  specStore: SpecStore,
  opts: CreateRunOptions,
  stagingDeps?: RunStagingDeps,
): Promise<ResolveOrCreateResult> {
  // Resolve first (LOUD if no spec) — also yields the (repo, spec_id) scan key.
  const request = await resolveSpec(specStore, opts);
  if (opts.intent === "fresh") {
    return {
      kind: "created",
      run: await createRunFromManifest(state, specStore, request, opts, stagingDeps),
    };
  }
  const pointer = specStore.toPointer(request);
  return state.withSpecLock(pointer.repo, pointer.spec_id, async () => {
    const existing = await state.findActiveBySpec(pointer.repo, pointer.spec_id);
    if (existing !== null) {
      // Weekly quota is a hard wall: a 7d-parked run can't be created-fresh or
      // superseded without --ignore-quota. The `binding_window === "7d"` guard
      // targets only the weekly park — NOT the `unavailable-halt` suspend (quota:
      // undefined) or a 5h pause. The `--resume` intent falls through to the
      // `kind:"exists"` caller path, which hands off to `factory resume` (that
      // re-checks the LIVE window on the fresh session).
      const weeklyParked =
        existing.status === "suspended" && existing.quota?.binding_window === "7d";
      if (weeklyParked && !opts.ignoreQuota && opts.intent !== "resume") {
        return { kind: "pause", existing };
      }

      if (opts.intent === "supersede") {
        if (stagingDeps === undefined) {
          throw new UsageError("run create --supersede requires the CLI gh deps");
        }
        const supersededId = existing.run_id;
        await supersedeRun(state, existing, stagingDeps);
        return {
          kind: "superseded",
          run: await createRunFromManifest(state, specStore, request, opts, stagingDeps),
          supersededId,
        };
      }
      // --resume currently reports the live run (kind:"exists"); the full continue-the-run
      // hand-off is the caller's job (Task 4.2). No flag-compatibility assert here — that
      // belongs with the resume implementation, not a premature gate (review #3).
      return { kind: "exists", existing };
    }
    return {
      kind: "created",
      run: await createRunFromManifest(state, specStore, request, opts, stagingDeps),
    };
  });
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

/** The single JSON document `factory run resume` emits — the runner's contract. */
export type ResumeResult =
  | { readonly kind: "resumed"; readonly run: RunState }
  | {
      readonly kind: "pause";
      readonly run_id: string;
      readonly status: RunStatus;
      readonly reason: string;
      readonly resets_at_epoch?: number;
    }
  | {
      /**
       * A `debug:true` run resolved through the plain `resume` action. The plain
       * runner loop's `planResume`/quota-recheck path is NOT for a debug run — it
       * loops multiple review⇄fix passes on ONE run instead of finalizing as soon as
       * tasks go terminal (Decision 39, deferred to the debug driver). Returning this
       * distinct kind, before any quota/planResume logic runs, signals the caller (a
       * human or `/factory:debug`) to re-enter the debug SKILL rather than drive the
       * run through the ordinary resume path. Minimal by design: only the CALLER-facing
       * envelope, not the debug-resume UX itself (that lands with the debug driver).
       */
      readonly kind: "debug-resume";
      readonly run_id: string;
      readonly run: RunState;
    };

/**
 * The testable core of `run resume`. Reads the run (LOUD if terminal — nothing to
 * resume), then routes through the pure {@link planResume} seam against a FRESH
 * usage reading:
 *   - a non-paused/suspended (i.e. already `running`) run is an idempotent re-entry
 *     → `resumed` with the unchanged state;
 *   - a recovered window clears the checkpoint (status→running, quota→undefined) and
 *     returns the updated state;
 *   - an over-curve / unobservable window is `still-blocked` (fail-closed) and
 *     leaves state exactly as persisted.
 */
export async function applyResume(
  state: StateManager,
  runId: string,
  reading: UsageReading,
  config: Config,
  nowEpochSec: number,
  /** Pre-write snapshot of `updated_at` — callers that stamp the run before calling
   * (e.g. `--ignore-quota` persists `ignore_quota:true`) must pass the value they
   * captured BEFORE the write so idle time is computed against the real pause epoch,
   * not the stamp time. Omit when there is no preceding write. */
  priorUpdatedAt?: string,
): Promise<ResumeResult> {
  const run = await state.read(runId);
  if (isTerminalRunStatus(run.status)) {
    throw new Error(`run resume: run '${runId}' is terminal (${run.status}); nothing to resume`);
  }
  // Decision 39: a debug run is not a plain resume — it loops multiple review⇄fix
  // passes on this run instead of finalizing once tasks go terminal, so the debug
  // driver (not planResume/the quota recheck) must drive it. Return early, LOUD and
  // distinct, before any quota/planResume logic runs or touches state.
  if (run.debug) {
    return { kind: "debug-resume", run_id: runId, run };
  }

  const plan = planResume(run, reading, config, nowEpochSec);
  switch (plan.kind) {
    case "not-resumable":
      // Non-terminal but not paused/suspended ⇒ already running: idempotent re-entry.
      return { kind: "resumed", run };
    case "resume": {
      // Accumulate the idle gap into paused_minutes so the runtime breaker deducts
      // real suspend/pause time from the wall-clock ceiling on the next evaluation.
      // Use priorUpdatedAt when a caller stamped updated_at before calling us (e.g.
      // --ignore-quota write), otherwise fall back to the run's own timestamp.
      const idleMinutes = Math.max(
        0,
        Math.floor((nowEpochSec - parseIso8601ToEpoch(priorUpdatedAt ?? run.updated_at)) / 60),
      );
      const updated = await state.update(runId, (s) => ({
        ...s,
        status: plan.clear.status,
        quota: plan.clear.quota,
        paused_minutes: (s.paused_minutes ?? 0) + idleMinutes,
      }));
      return { kind: "resumed", run: updated };
    }
    case "pause": {
      const d = plan.decision;
      // NB: two distinct `.kind` unions are in play here — the OUTER `plan.kind`
      // (ResumePlan: not-resumable | resume | still-blocked, switched above) and this
      // INNER `d.kind` (QuotaDecision: proceed | pause-5h | suspend-7d | unavailable-halt).
      // planResume only ever pairs `still-blocked` with a NON-proceed QuotaDecision, so
      // `proceed` is not expected here — but this is a DEFENSIVE TYPE NARROW, not dead
      // code: without it the compiler cannot prove `d.reason` (below) exists, since the
      // `proceed` arm of QuotaDecision carries no `reason`. The guard discharges that.
      if (d.kind === "proceed") {
        return { kind: "resumed", run };
      }
      const base = {
        kind: "pause",
        run_id: runId,
        status: run.status,
        reason: d.reason,
      } as const;
      // pause-5h / suspend-7d carry a reset horizon; unavailable-halt does not.
      return "resetsAtEpoch" in d ? { ...base, resets_at_epoch: d.resetsAtEpoch } : base;
    }
  }
}

// ---------------------------------------------------------------------------
// Flag parsing + command wiring
// ---------------------------------------------------------------------------

function parseIssue(raw: string | boolean | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new UsageError("--issue requires a value");
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--issue must be a positive integer, got '${raw}'`);
  }
  return n;
}

/**
 * Resolve the owning Claude Code session id to stamp onto the run (Prompt J —
 * session-scoped Stop gate). Precedence: an explicit `--session-id` flag (the
 * runner/command can pass it deterministically) over the `CLAUDE_CODE_SESSION_ID`
 * env var that Claude Code sets for Bash-tool invocations. Returns `undefined` when
 * neither is available. Session-mode `run create` rejects an undefined result (the Stop
 * hook resolves the session's own run via `findActiveByOwner`, which requires an owner);
 * workflow-mode creates are exempt.
 */
export function resolveOwnerSession(
  flag: string | boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return optionalString(flag) ?? optionalString(env.CLAUDE_CODE_SESSION_ID);
}

/**
 * Test seam for {@link runCreate}: inject the git seam + gh client + cwd + data dir
 * so the `--repo` auto-derive path (Prompt G) and the staging cut + protect
 * (Decision 33) are exercised with fakes and a temp data dir. Production passes
 * none of these (real clients, real `process.cwd()`, env-resolved data dir).
 */
export interface RunCreateOverrides {
  readonly gitClient?: GitClient;
  readonly ghClient?: GhClient;
  readonly cwd?: string;
  readonly dataDir?: string;
}

export async function runCreate(
  argv: string[],
  overrides: RunCreateOverrides = {},
): Promise<ExitCode> {
  const args = parseArgs(argv, {
    booleans: ["new", "workflow", "no-ship", "supersede", "resume", "ignore-quota", "e2e"],
  });
  if (args.flag("help") === true) {
    emitLine(CREATE_HELP);
    return EXIT.OK;
  }
  // Mandatory autonomous-mode gate: the pipeline runs unattended, no opt-out.
  // A run can only be born in the foreground runner session (which has the
  // env), so gating create here halts non-autonomous runs at the source.
  requireAutonomousMode();

  // --repo is OPTIONAL (Prompt G): auto-derive from the origin remote when omitted,
  // and fail LOUD if an explicit value disagrees with the remote.
  const cwd = overrides.cwd ?? process.cwd();
  const gitClient = overrides.gitClient ?? new DefaultGitClient();
  const repoSlug = await resolveRepo({
    explicit: optionalString(args.flag("repo")),
    cwd,
    gitClient,
  });
  const issue = parseIssue(args.flag("issue"));
  const specId = optionalString(args.flag("spec-id"));
  // Collapse the two CLI flags into the exactly-one SpecSelector here, at the
  // command boundary, so the rest of create works with the type-enforced invariant.
  let selector: SpecSelector;
  if (issue !== undefined && specId !== undefined) {
    throw new UsageError("run create: pass exactly one of --issue or --spec-id");
  } else if (issue !== undefined) {
    selector = { issue };
  } else if (specId !== undefined) {
    selector = { specId };
  } else {
    throw new UsageError("run create requires --issue <n> or --spec-id <id>");
  }
  const explicitRunId = optionalString(args.flag("run-id"));
  const runId = explicitRunId ?? makeRunId();
  validateId(runId, "run-id");
  // Terse boolean overrides over the no-flag defaults (session + live). Both resolve to
  // a CONCRETE value so the reuse guard can compare the caller's intent against an
  // existing run — a bare re-create of a `--workflow`/`--no-ship` run must not silently
  // reuse it under the (different) default intent.
  const mode: RunState["mode"] = args.flag("workflow") === true ? "workflow" : "session";
  const shipMode: RunState["ship_mode"] = args.flag("no-ship") === true ? "no-merge" : "live";
  const ownerSession = resolveOwnerSession(args.flag("session-id"));
  // Session-mode runs must be owned: the Stop hook resolves the session's own run via
  // findActiveByOwner, which never matches an ownerless run. Workflow-mode runs are
  // exempt — the Workflow runner owns finalization, not the interactive session.
  if (ownerSession === undefined && mode === "session") {
    throw new UsageError(
      "run create: session-mode runs require an owning session id " +
        "(pass --session-id <id> or set CLAUDE_CODE_SESSION_ID). " +
        "Workflow-mode runs are exempt (the Workflow runner owns finalization).",
    );
  }
  // Exactly-one-of the lifecycle flags → the typed intent. --new and an explicit
  // --run-id both mean "fresh" (a named id is an address — determinism/tests — not a
  // reuse request, so it never silently resolves to a different run). On an ACTIVE run,
  // the "default" intent reports it as kind:"exists" (CONFLICT) — never a silent reuse.
  const fresh = args.flag("new") === true || explicitRunId !== undefined;
  const supersede = args.flag("supersede") === true;
  const resume = args.flag("resume") === true;
  // --workflow/--no-ship/--e2e are CREATE-ONLY selectors; --resume continues a run
  // whose mode + ship_mode + e2e are already fixed (all immutable post-create). The combo is
  // incoherent and is the ROOT CAUSE of the `run --resume --workflow` incident: the flag
  // rode the resume hand-off and launched a workflow runner against a session-mode run.
  // Reject it loud here, before any orchestrator launches. (No expressiveness lost: the only
  // case where `--resume --workflow` would create anything — no active run exists —
  // is identical to a bare `--workflow`, which the default intent already creates fresh.)
  if (
    resume &&
    (args.flag("workflow") === true || args.flag("no-ship") === true || args.flag("e2e") === true)
  ) {
    throw new UsageError(
      "run create: --workflow/--no-ship/--e2e are create-only and cannot combine with --resume — " +
        "a resumed run keeps the mode/ship_mode/e2e it was created with. Drop the flag to continue " +
        "the existing run, or use --supersede to start fresh in that mode.",
    );
  }
  const picked = [supersede && "supersede", resume && "resume", fresh && "fresh"].filter(
    Boolean,
  ) as RunIntent["intent"][];
  if (picked.length > 1) {
    throw new UsageError("run create: pass at most one of --new / --supersede / --resume");
  }
  const intent: NonNullable<RunIntent["intent"]> = picked[0] ?? "default";
  const ignoreQuota = args.flag("ignore-quota") === true;
  const e2e = args.flag("e2e") === true;
  const hasDataDirOverride = overrides.dataDir !== undefined;

  const dataDir = resolveDataDir(hasDataDirOverride ? { dataDir: overrides.dataDir } : {});
  const config = loadConfig(hasDataDirOverride ? { dataDir } : {});
  const state = new StateManager({ dataDir });
  const specStore = new SpecStore({ dataDir });
  // Decision 33: build the staging deps bundle (git + gh + config + root + repo
  // coords) so createRunFromManifest can cut + protect staging-<run-id> from develop.
  const ghClient = overrides.ghClient ?? new DefaultGhClient();
  const { owner, repo } = splitRepoSlug(repoSlug);
  const stagingDeps: RunStagingDeps = {
    gitClient,
    ghClient,
    config,
    targetRoot: cwd,
    owner,
    repo,
  };
  const result = await resolveOrCreateRun(
    state,
    specStore,
    {
      repo: repoSlug,
      runId,
      ...selector,
      mode,
      shipMode,
      ...(ownerSession !== undefined ? { ownerSession } : {}),
      ...(ignoreQuota ? { ignoreQuota } : {}),
      ...(e2e ? { e2e } : {}),
      intent,
    },
    stagingDeps,
  );
  if (result.kind === "pause") {
    const r = result.existing;
    const resets = r.quota?.resets_at_epoch;
    emitJson({
      kind: "pause",
      scope: "7d",
      run_id: r.run_id,
      status: r.status,
      reason: `weekly quota window has not reset; run '${r.run_id}' is parked until the 7d window resets`,
      ...(resets !== undefined ? { resets_at_epoch: resets } : {}),
    });
    emitError(
      `run create: run '${r.run_id}' is parked on a weekly quota (7d) — ` +
        `resume after the window resets with /factory:resume, or pass --ignore-quota to override`,
    );
    return EXIT.CONFLICT;
  }
  if (result.kind === "exists") {
    emitJson({
      kind: "exists",
      existing: { run_id: result.existing.run_id, status: result.existing.status },
    });
    emitError(
      `run create: active run '${result.existing.run_id}' already exists — ` +
        `pass --resume to continue it or --supersede to replace it`,
    );
    return EXIT.CONFLICT;
  }
  if (result.kind === "created") {
    emitJson({ kind: "created", run: result.run });
    return EXIT.OK;
  }
  // kind === "superseded"
  emitJson({ kind: "superseded", run: result.run, supersededId: result.supersededId });
  return EXIT.OK;
}

async function runResume(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: ["workflow", "no-ship", "ignore-quota", "e2e"] });
  if (args.flag("help") === true) {
    emitLine(RESUME_HELP);
    return EXIT.OK;
  }
  // --workflow/--no-ship/--e2e select mode/ship/e2e at CREATE; a resumed run keeps them
  // all as born (immutable). Silently ignoring these flags here is the quieter twin of
  // the create-side footgun — reject loud so neither path can ever imply a mode on resume.
  // The orchestrator is chosen from the run's persisted `mode`.
  if (
    args.flag("workflow") === true ||
    args.flag("no-ship") === true ||
    args.flag("e2e") === true
  ) {
    throw new UsageError(
      "run resume: --workflow/--no-ship/--e2e are not valid on resume — a run keeps the " +
        "mode/ship_mode/e2e it was created with. Resume drives the run in its persisted mode.",
    );
  }
  // Mandatory autonomous-mode gate (see runCreate): resume re-activates a run and
  // runs in the foreground `/factory:run resume` session, which has the env.
  requireAutonomousMode();

  const dataDir = resolveDataDir({});
  const config = loadConfig({ dataDir });
  const state = new StateManager({ dataDir });
  const runId = await resolveRunId(state, args, "resume");

  // Capture updated_at BEFORE any write so the idle-time calculation in applyResume
  // uses the real pause epoch, not the timestamp we're about to stamp.
  const { updated_at: priorUpdatedAt } = await state.read(runId);

  // --ignore-quota: persist on the run BEFORE applyResume so planResume short-circuits
  // to resume regardless of the live reading. Persisting also prevents re-suspension on
  // subsequent steps (both orchestrators read run.ignore_quota via the gate).
  if (args.flag("ignore-quota") === true) {
    await state.update(runId, (s) => ({ ...s, ignore_quota: true }));
  }

  const reading = await new StatuslineUsageSignal({ dataDir }).read();
  const envelope = await applyResume(state, runId, reading, config, nowEpoch(), priorUpdatedAt);
  emitJson(envelope);
  return EXIT.OK;
}

/**
 * Resolve `runId` from `--run`, falling back to `runs/current` (LOUD if neither is
 * available — the shared head of `resume`/`finalize`, which both default to the
 * active run).
 */
async function resolveRunId(
  state: StateManager,
  args: ReturnType<typeof parseArgs>,
  action: string,
  overrides: CurrentRunOverrides = {},
): Promise<string> {
  const explicit = optionalString(args.flag("run"));
  if (explicit !== undefined) return explicit;
  const current = await readCurrentForCwd(state, overrides);
  if (current === null) {
    throw new UsageError(`run ${action}: no --run given and no current run`);
  }
  return current.run_id;
}

async function runFinalize(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: ["no-ship"] });
  if (args.flag("help") === true) {
    emitLine(FINALIZE_HELP);
    return EXIT.OK;
  }

  // --no-ship forces no-merge for THIS finalize; otherwise honor the run's persisted
  // ship_mode (loadCliDeps falls back to it — never a hard-coded default).
  const shipMode: RunState["ship_mode"] | undefined =
    args.flag("no-ship") === true ? "no-merge" : undefined;
  const dataDir = resolveDataDir({});
  const state = new StateManager({ dataDir });
  const runId = await resolveRunId(state, args, "finalize");

  const deps = await loadCliDeps({
    dataDir,
    runId,
    ...(shipMode !== undefined ? { shipMode } : {}),
  });
  const { run, report, rollup, failureCommentPosted } = await finalizeRun(deps, runId);
  emitJson({
    kind: "finalized",
    run,
    report,
    ...(rollup !== undefined ? { rollup } : {}),
    failure_comment_posted: failureCommentPosted,
  });
  return EXIT.OK;
}

const DOCS_HELP = `factory run docs [--run <id>] [--results <path>]

Emit the documentation-phase spawn request, or (with --results) record a scribe
result: publish the docs commit onto staging and mark the phase done, or suspend
the run on failure. The CLI never spawns scribe — a orchestrator does.`;

async function runDocs(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: [] });
  if (args.flag("help") === true) {
    emitLine(DOCS_HELP);
    return EXIT.OK;
  }
  const dataDir = resolveDataDir({});
  const state = new StateManager({ dataDir });
  const runId = await resolveRunId(state, args, "docs");
  const deps = await loadCliDeps({ dataDir, runId });

  const resultsPath = args.flag("results");
  if (typeof resultsPath === "string" && resultsPath.length > 0) {
    let results;
    try {
      results = DocsResultsSchema.parse(await readJsonInput<unknown>(resultsPath));
    } catch (err) {
      throw new UsageError(
        `--results ${resultsPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    emitJson(await runDocsRecord(deps, runId, results));
  } else if (resultsPath !== undefined) {
    throw new UsageError("--results requires a file path");
  } else {
    emitJson(await runDocsEmit(deps, runId));
  }
  return EXIT.OK;
}

const E2E_HELP = `factory run e2e [--run <id>] [--results <path>]

Emit the e2e-phase spawn request (author or run-suite, Decision 39), or (with
--results) record the e2e-author's manifest: prove + commit critical journeys,
run the full suite against staging, and either mark the phase done, reopen a
mappable failing task with feedback, or fail the run. The CLI never spawns the
e2e author — a orchestrator does.`;

async function runE2ePhase(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: [] });
  if (args.flag("help") === true) {
    emitLine(E2E_HELP);
    return EXIT.OK;
  }
  const dataDir = resolveDataDir({});
  const state = new StateManager({ dataDir });
  const runId = await resolveRunId(state, args, "e2e");
  const deps = await loadCliDeps({ dataDir, runId });

  const resultsPath = args.flag("results");
  if (typeof resultsPath === "string" && resultsPath.length > 0) {
    let results;
    try {
      results = E2eResultsSchema.parse(await readJsonInput<unknown>(resultsPath));
    } catch (err) {
      throw new UsageError(
        `--results ${resultsPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    emitJson(await runE2eRecord(deps, runId, results));
  } else if (resultsPath !== undefined) {
    throw new UsageError("--results requires a file path");
  } else {
    emitJson(await runE2eEmit(deps, runId));
  }
  return EXIT.OK;
}

/**
 * Test seam for {@link runCancel}: inject the gh client (the `--cleanup` teardown),
 * the git client + cwd (current-run repo resolution), and the data dir. Production
 * passes none (real clients, real `process.cwd()`, env-resolved data dir).
 */
export interface RunCancelOverrides {
  readonly ghClient?: GhClient;
  readonly gitClient?: GitClient;
  readonly cwd?: string;
  readonly dataDir?: string;
}

/**
 * Resolve the run `cancel` abandons. Precedence: explicit `--run`; else the single
 * active run THIS session owns ({@link StateManager.findAllActiveByOwner} — robust to a
 * detached/repointed `runs/current`, the exact stuck-session condition); else the
 * current run for the checkout. LOUD if none resolves — and LOUD (demanding `--run`)
 * when the session owns ≥2 live runs: guessing which to abandon could finalize the
 * WRONG run, so ambiguity is surfaced, never silently fallen through to the pointer.
 *
 * Unlike {@link resolveRunId} (resume/finalize), the owner-scan is interposed BEFORE
 * the current-pointer fallback: a trapped session always knows its own session id but
 * may have lost the pointer, so the owned run must win. Explicit `--run` stays a
 * deliberate operator override with NO ownership check — the cross-session escape
 * hatch a crashed owner's run needs (single-operator local trust model), consistent
 * with how `resume`/`finalize` honor `--run`.
 */
async function resolveCancelRunId(
  state: StateManager,
  args: ReturnType<typeof parseArgs>,
  sessionId: string | undefined,
  overrides: CurrentRunOverrides = {},
): Promise<string> {
  const explicit = optionalString(args.flag("run"));
  if (explicit !== undefined) return explicit;
  if (sessionId !== undefined) {
    const owned = await state.findAllActiveByOwner(sessionId);
    if (owned.length === 1) return owned[0]!.run_id;
    if (owned.length >= 2) {
      const ids = owned.map((r) => r.run_id).join(", ");
      throw new UsageError(
        `run cancel: session '${sessionId}' owns ${owned.length} live runs (${ids}); ` +
          `pass --run <id> to choose which to cancel`,
      );
    }
    // owned.length === 0 → fall through to the current pointer (the run for this checkout).
  }
  const current = await readCurrentForCwd(state, overrides);
  if (current === null) {
    throw new UsageError("run cancel: no --run given and no owned/current run to cancel");
  }
  return current.run_id;
}

/**
 * `factory run cancel` — explicitly abandon a live run (Decision 35). Marks the run
 * `failed` DIRECTLY via {@link StateManager.finalize} — NOT {@link finalizeRun}: cancel must
 * not attempt rollup CI / ship of a partial run. `finalize` validates only that the TARGET
 * status is terminal (it does not inspect task statuses), so a run with a task still
 * `executing` is cancellable — the exact mechanism `--supersede` already uses. Idempotent for
 * `failed`; an already completed/superseded run hits the loud "already terminal" guard.
 *
 * NO {@link requireAutonomousMode}: cancel is a terminal/cleanup op that must work from ANY
 * session (including a non-autonomous one), like `finalize` — not a run-starter. It is NOT
 * required to let a session stop (the Stop hook no longer blocks on pending work); it is the
 * verb for deliberately discarding a run you do not intend to resume.
 */
export async function runCancel(
  argv: string[],
  overrides: RunCancelOverrides = {},
): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: ["cleanup"] });
  if (args.flag("help") === true) {
    emitLine(CANCEL_HELP);
    return EXIT.OK;
  }

  const dataDir = resolveDataDir(
    overrides.dataDir !== undefined ? { dataDir: overrides.dataDir } : {},
  );
  const state = new StateManager({ dataDir });
  const sessionId = resolveOwnerSession(args.flag("session-id"));
  const currentOverrides: CurrentRunOverrides = {
    ...(overrides.gitClient !== undefined ? { gitClient: overrides.gitClient } : {}),
    ...(overrides.cwd !== undefined ? { cwd: overrides.cwd } : {}),
  };
  const runId = await resolveCancelRunId(state, args, sessionId, currentOverrides);

  // Mark terminal via the one sanctioned writer (the CLI bypasses the TCB write-deny
  // hook by design — it guards Edit/Write tools, not the engine's own fs writes).
  const run = await state.finalize(runId, "failed");

  const cleanup = args.flag("cleanup") === true;
  // Resolve the PINNED branch (Decision 33) so any teardown targets the branch the run
  // actually cut, never a recompute a mid-run rename could have desynced.
  const branch = resolveStagingBranch(run.run_id, run.staging_branch);
  let cleanedUp = false;
  let cleanupError: string | undefined;
  if (cleanup) {
    // Reuse the supersede teardown: protection FIRST (GitHub blocks deleting a protected
    // ref), then delete staging-<run-id> (auto-closing its task PRs). Repo coords come from
    // the run's OWN spec pointer — cancel needs no cwd/--repo.
    const ghClient = overrides.ghClient ?? new DefaultGhClient();
    const { owner, repo } = splitRepoSlug(run.spec.repo);
    try {
      await ghClient.deleteProtection(owner, repo, branch);
      await ghClient.deleteRemoteBranch(owner, repo, branch);
      cleanedUp = true;
    } catch (err) {
      // The run is ALREADY failed — cancel's PRIMARY contract (abandon) is met. A genuine
      // teardown throw (401/403/5xx; already-gone 404/422 is
      // tolerated upstream by the gh client) must NOT fail the abandon: surface it LOUD
      // and exit OK. Retry is safe — deleteProtection/deleteRemoteBranch tolerate an
      // already-gone branch and finalize is idempotent for `failed`.
      cleanupError = err instanceof Error ? err.message : String(err);
    }
  }

  emitJson({
    kind: "cancelled",
    run,
    cleaned_up: cleanedUp,
    ...(cleanupError !== undefined ? { cleanup_error: cleanupError } : {}),
  });
  if (cleanupError !== undefined) {
    emitError(
      `run ${run.run_id} cancelled (marked failed), but --cleanup did NOT finish for staging ` +
        `branch '${branch}': ${cleanupError}. The branch may still exist — re-run ` +
        `\`factory run cancel --run ${run.run_id} --cleanup\` to retry the teardown.`,
    );
  } else {
    emitError(
      `run ${run.run_id} cancelled (marked failed)` +
        (cleanup
          ? `; staging branch '${branch}' + its task PRs torn down.`
          : `; staging branch '${branch}' left in place — delete it manually or re-run with --cleanup.`),
    );
  }
  return EXIT.OK;
}

async function run(argv: string[]): Promise<ExitCode> {
  const action = argv[0];
  if (action === undefined || action === "--help" || action === "-h") {
    emitLine(RUN_HELP);
    return EXIT.OK;
  }
  const rest = argv.slice(1);
  switch (action) {
    case "create":
      return runCreate(rest);
    case "resume":
      return runResume(rest);
    case "finalize":
      return runFinalize(rest);
    case "docs":
      return runDocs(rest);
    case "e2e":
      return runE2ePhase(rest);
    case "cancel":
      return runCancel(rest);
    default:
      throw new UsageError(
        `unknown run action '${action}' (expected create | resume | finalize | docs | e2e | cancel)`,
      );
  }
}

export const runCommand: Subcommand = {
  describe: "Create or resume a run (create resolves+seeds a spec; resume re-checks quota)",
  run: async (argv) => {
    try {
      return await run(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`run: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  },
};

/** Top-level `factory resume` — alias-equivalent of `run resume` (Decision 35). */
export const resumeCommand: Subcommand = {
  describe: "Resume a paused/suspended run (re-check quota; clear a recovered checkpoint)",
  run: async (argv) => {
    try {
      return await runResume(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`resume: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  },
};
