/**
 * `factory run <create|resume>` — the run-lifecycle entrypoint (C6).
 *
 * Model A: the CLI never spawns an agent. `run create` resolves a DURABLE spec (by
 * stable issue number or explicit spec-id), creates a fresh run, SEEDS its task
 * rows from the spec, and emits the {@link RunState}; the in-session orchestrator
 * reads `run_id` and drives the run through the coroutine seam (`factory next` +
 * `factory drive`).
 *
 * `run resume` is the human-invoked resumable entrypoint (Decision 24, Δ F — v1 is
 * HUMAN relaunch only; the v2 scheduler would fire this same path). It re-reads the
 * LIVE quota window through the pure {@link planResume} seam and, when the binding
 * window has recovered, clears the checkpoint and returns the run to `running`;
 * otherwise it reports why resume did not proceed and leaves state untouched. A
 * terminal run is a LOUD error — there is nothing to resume.
 *
 * Seeding maps each {@link SpecTask} to a `pending` {@link TaskState} carrying ONLY
 * the producer dial (`risk_tier`) + the dependency edges — never `tdd_exempt` (that
 * is read from `spec/tasks.json` at runtime, never from `state.json`). Dangling,
 * self, cyclic, and duplicate dependency edges are caught LOUDLY at seed time rather
 * than surfacing later as a driver deadlock.
 */
import { EXIT, type ExitCode } from "../exit-codes.js";
import { parseArgs, isUsageError, UsageError, optionalString } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { loadConfig, resolveDataDir } from "../../config/index.js";
import { StateManager } from "../../core/state/index.js";
import { SpecStore, type SpecManifest } from "../../spec/index.js";
import { makeRunId, validateId } from "../../shared/ids.js";
import { nowEpoch } from "../../shared/time.js";
import { planResume, StatuslineUsageSignal, type UsageReading } from "../../quota/index.js";
import { isTerminalRunStatus } from "../../types/index.js";
import type { Config, RunState, RunStatus, TaskState } from "../../types/index.js";
import { finalizeRun } from "../../driver/index.js";
import { loadCliDeps } from "../wiring.js";
import {
  DefaultGitClient,
  DefaultGhClient,
  ensureStaging,
  provisionProtection,
  runStagingBranch,
  resolveRepo,
  splitRepoSlug,
  type GitClient,
  type GhClient,
} from "../../git/index.js";
import { readCurrentForCwd, type CurrentRunOverrides } from "../current.js";
import { requireAutonomousMode } from "../../autonomy/mode.js";
import { createLogger } from "../../shared/index.js";
import type { Subcommand } from "../main.js";

const log = createLogger("run");

const RUN_HELP = `factory run — create or resume a run

Usage:
  factory run create [--repo <owner/name>] (--issue <n> | --spec-id <id>) [--run-id <id>]
  factory run resume [--run <id>]
  factory run finalize [--run <id>] [--no-ship]

Actions:
  create     Resolve a durable spec, create a run, seed its tasks, emit the RunState.
  resume     Re-check the live quota window; clear the checkpoint if it has recovered.
  finalize   Build the partial report, file per-drop issues, ship the rollup, flip terminal.`;

const CREATE_HELP = `factory run create — create a run and seed its tasks from a durable spec

Usage:
  factory run create [--repo <owner/name>] (--issue <n> | --spec-id <id>) [--run-id <id>] [--new] [--workflow] [--no-ship] [--session-id <id>]

  --repo        OPTIONAL. Repo identity 'owner/name' (the first key of the spec store).
                Auto-derived from the 'origin' remote when omitted; an explicit value
                that disagrees with the remote fails loud.
  --issue       PRD issue number — the STABLE lookup key (reruns reuse the spec).
  --spec-id     Explicit '<issue>-<slug>' spec id (alternative to --issue).
  --run-id      Override the generated 'run-YYYYMMDD-HHMMSS' id (determinism/tests).
                A named id is an address: it forces a fresh imperative create.
  --new         Force a fresh run even if a live one already exists for this spec.
  --workflow    Run the parallel background Workflow driver. Default (no flag): session —
                the in-session, quota-paced orchestrator loop.
  --no-ship     Open the rollup PR but never merge. Default (no flag): live — auto-merge
                each task into staging and merge the staging→develop rollup into develop.
                Persisted on the run so the workflow driver + resume + finalize read it
                without re-passing.
  --session-id  Owning Claude Code session id for the session-scoped Stop gate (Prompt J).
                Defaults to $CLAUDE_CODE_SESSION_ID; absent ⇒ owner-unknown (Stop gate unscoped).

Resolves the spec via the durable store (LOUD if none exists — generate one first).
IDEMPOTENT: with the auto-generated id, a repeated create returns the existing
non-terminal run for this (repo, spec_id) — when its mode/ship intent matches — instead
of spawning an orphan; pass --new (or a --run-id) to force a fresh run. Seeds one pending
task per spec task and emits the RunState JSON (run_id is the top-level field).`;

const RESUME_HELP = `factory run resume — re-check quota and resume a paused/suspended run

Usage:
  factory run resume [--run <id>]

  --run   The run to resume (defaults to runs/current).

Emits ONE JSON envelope:
  { kind:"resumed", run }                              — window recovered (or already running)
  { kind:"still-blocked", run_id, status, reason, … }  — window has not recovered (state untouched)

A terminal run is a loud error (nothing to resume).`;

const FINALIZE_HELP = `factory run finalize — turn an all-terminal run into its shipped outcome

Usage:
  factory run finalize [--run <id>] [--no-ship]

  --run       The run to finalize (defaults to runs/current).
  --no-ship   Open the rollup PR but never merge it — overrides the run's persisted ship
              mode for THIS finalize only. Default: honor the persisted ship_mode (live
              merges the staging→develop rollup; no-merge opens it only).

Builds the deterministic partial-run report (report.md), emits run.finalized
telemetry, files ONE GitHub issue per dropped task (deduped), opens + CI-gates +
(when shipping live) squash-merges the staging→develop rollup, then flips the run
terminal — in that resume-safe order. LOUD if any task is still non-terminal.

Emits ONE JSON envelope:
  { kind:"finalized", run, report, rollup?, issues_filed }`;

// ---------------------------------------------------------------------------
// Seeding (pure)
// ---------------------------------------------------------------------------

/**
 * Map a durable {@link SpecManifest} to the run's initial `pending` task rows.
 * Each task carries ONLY the producer dial + dependency edges; `tdd_exempt` is
 * deliberately NOT copied (it is read from the spec at runtime, never persisted to
 * run state). LOUD on a duplicate task id, an unsafe id charset, a self-dependency,
 * a dangling dependency, or a dependency cycle — all are spec-integrity defects
 * that would otherwise deadlock the driver.
 */
export function seedTasksFromSpec(manifest: SpecManifest): Record<string, TaskState> {
  const ids = new Set(manifest.tasks.map((t) => t.task_id));
  const tasks: Record<string, TaskState> = {};

  for (const t of manifest.tasks) {
    validateId(t.task_id, "task-id");
    if (tasks[t.task_id] !== undefined) {
      throw new Error(`run create: duplicate task id '${t.task_id}' in spec ${manifest.spec_id}`);
    }
    for (const dep of t.depends_on) {
      if (dep === t.task_id) {
        throw new Error(
          `run create: task '${t.task_id}' depends on itself in spec ${manifest.spec_id}`,
        );
      }
      if (!ids.has(dep)) {
        throw new Error(
          `run create: task '${t.task_id}' depends on unknown task '${dep}' in spec ${manifest.spec_id}`,
        );
      }
    }
    tasks[t.task_id] = {
      task_id: t.task_id,
      status: "pending",
      depends_on: [...t.depends_on],
      risk_tier: t.risk_tier,
      escalation_rung: 0,
      reviewers: [],
      merge_resyncs: 0,
    };
  }

  assertAcyclic(tasks, manifest.spec_id);
  return tasks;
}

/**
 * LOUD-fail on a dependency cycle (DFS with a recursion stack). The driver would
 * otherwise reach a deadlock — no ready, no blocked, no terminal — and throw at
 * drive time; catching it at seed time names the offending task instead.
 */
function assertAcyclic(tasks: Record<string, TaskState>, specId: string): void {
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();

  const visit = (id: string, trail: string[]): void => {
    const mark = state.get(id);
    if (mark === DONE) return;
    if (mark === VISITING) {
      throw new Error(
        `run create: dependency cycle in spec ${specId}: ${[...trail, id].join(" → ")}`,
      );
    }
    state.set(id, VISITING);
    for (const dep of tasks[id]?.depends_on ?? []) {
      visit(dep, [...trail, id]);
    }
    state.set(id, DONE);
  };

  for (const id of Object.keys(tasks)) visit(id, []);
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
 * runtime checks. {@link resolveSpec} switches on `"specId" in opts`.
 */
export type SpecSelector =
  | { readonly issue: number; readonly specId?: never }
  | { readonly specId: string; readonly issue?: never };

/** Resolved options for {@link createRun} — {@link SpecSelector} plus run metadata. */
export type CreateRunOptions = SpecSelector & {
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
  /**
   * Skip the resolve-or-reuse scan in {@link resolveOrCreateRun} and always create
   * a fresh run, even when a live run already exists for this spec (the `--new`
   * escape hatch). Ignored by {@link createRun}, which is unconditionally imperative.
   */
  readonly force?: boolean;
  /**
   * Decision 35: mark the existing active run `superseded`, delete its
   * `staging/<run-id>` branch (which auto-closes its task PRs), and create a fresh
   * run. Requires `stagingDeps` to be present (the gh client must be wired).
   */
  readonly supersede?: boolean;
  /**
   * Pass-through for Task 4.2: signal that the caller intends to RESUME the active
   * run rather than create a new one. {@link resolveOrCreateRun} validates flag
   * compatibility via {@link assertReusableFlags} and returns `{ kind: "exists" }`;
   * Task 4.2 upgrades the caller to handle this case.
   */
  readonly resume?: boolean;
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
 * Create the run from an already-resolved manifest and seed its tasks — the
 * imperative core. Creates the run (status `running`), then folds in the seeded
 * task rows via the one sanctioned write path; returns the seeded {@link RunState}.
 *
 * When `stagingDeps` is supplied (always from `runCreate`; absent on the bare
 * `createRun` direct-API path), cuts `staging/<run-id>` from `develop` and
 * provisions GitHub branch protection on it (Decision 33). The cut + protect runs
 * AFTER the run state row is persisted so `run.run_id` is guaranteed to exist.
 */
async function createRunFromManifest(
  state: StateManager,
  specStore: SpecStore,
  manifest: SpecManifest,
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
  const seeded = seedTasksFromSpec(manifest);
  await state.create({
    run_id: opts.runId,
    spec: specStore.toPointer(manifest),
    // v1 coroutine seam drives tasks strictly one at a time — the driver dial is fixed.
    driver: "sequential",
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.shipMode !== undefined ? { ship_mode: opts.shipMode } : {}),
    ...(opts.ownerSession !== undefined ? { owner_session: opts.ownerSession } : {}),
  });
  const run = await state.update(opts.runId, (s) => ({ ...s, tasks: seeded }));

  // Decision 33: cut + protect the per-run staging branch AFTER the run row exists.
  if (stagingDeps !== undefined) {
    const branch = runStagingBranch(run.run_id);
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
 * row WITHOUT cutting/protecting a `staging/<run-id>` branch. Every production run
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
  | { readonly kind: "superseded"; readonly run: RunState; readonly supersededId: string };

/**
 * Guard the reuse path against a SILENT intent drop: a repeated `run create` resolves
 * its mode + ship intent from `--workflow`/`--no-ship` (or their defaults), but a reused
 * run keeps its ORIGINAL mode/ship_mode (the reuse returns the existing state verbatim).
 * Silently driving a run under an intent the caller did not ask for (`live` vs `no-merge`
 * opens/merges PRs differently; `workflow` disables quota pacing) is dangerous, so
 * HARD-FAIL with actionable guidance instead. A field left `undefined` (the direct-API
 * path, never the CLI — which always resolves both) signals "no intent" and never diverges.
 */
function assertReusableFlags(existing: RunState, opts: CreateRunOptions): void {
  if (opts.mode !== undefined && opts.mode !== existing.mode) {
    throw new UsageError(
      `run create: run '${existing.run_id}' already exists with mode='${existing.mode}', ` +
        `but this invocation resolves to mode='${opts.mode}' — pass --new for a fresh run, ` +
        `or set/clear --workflow to match the existing run`,
    );
  }
  if (opts.shipMode !== undefined && opts.shipMode !== existing.ship_mode) {
    throw new UsageError(
      `run create: run '${existing.run_id}' already exists with ship_mode='${existing.ship_mode}', ` +
        `but this invocation resolves to ship_mode='${opts.shipMode}' — pass --new for a fresh run, ` +
        `or set/clear --no-ship to match the existing run`,
    );
  }
}

/**
 * Supersede an active run (Decision 35): mark it `superseded` (durable intent
 * FIRST, so a crash mid-cleanup leaves a recoverable orphan branch, never a
 * running run with no branch), then tear down protection (GitHub blocks deleting
 * a protected ref) and delete `staging/<run-id>` (which auto-closes its task PRs).
 */
async function supersedeRun(
  state: StateManager,
  existing: RunState,
  stagingDeps: RunStagingDeps,
): Promise<void> {
  const branch = runStagingBranch(existing.run_id);
  await state.finalize(existing.run_id, "superseded");
  await stagingDeps.ghClient.deleteProtection(stagingDeps.owner, stagingDeps.repo, branch);
  await stagingDeps.ghClient.deleteRemoteBranch(stagingDeps.owner, stagingDeps.repo, branch);
}

/**
 * Resolve the spec, then (unless `opts.force`) inspect the active run for this
 * `(repo, spec_id)` and return a discriminated result (Decision 35):
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
  const manifest = await resolveSpec(specStore, opts);
  if (opts.force === true) {
    return {
      kind: "created",
      run: await createRunFromManifest(state, specStore, manifest, opts, stagingDeps),
    };
  }
  const pointer = specStore.toPointer(manifest);
  return state.withSpecLock(pointer.repo, pointer.spec_id, async () => {
    const existing = await state.findActiveBySpec(pointer.repo, pointer.spec_id);
    if (existing !== null) {
      if (opts.supersede === true) {
        if (stagingDeps === undefined) {
          throw new UsageError("run create --supersede requires the CLI gh deps");
        }
        const supersededId = existing.run_id;
        await supersedeRun(state, existing, stagingDeps);
        return {
          kind: "superseded",
          run: await createRunFromManifest(state, specStore, manifest, opts, stagingDeps),
          supersededId,
        };
      }
      if (opts.resume === true) {
        assertReusableFlags(existing, opts);
        return { kind: "exists", existing };
      }
      return { kind: "exists", existing };
    }
    return {
      kind: "created",
      run: await createRunFromManifest(state, specStore, manifest, opts, stagingDeps),
    };
  });
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

/** The single JSON document `factory run resume` emits — the orchestrator's contract. */
export type RunResumeEnvelope =
  | { readonly kind: "resumed"; readonly run: RunState }
  | {
      readonly kind: "still-blocked";
      readonly run_id: string;
      readonly status: RunStatus;
      readonly reason: string;
      readonly resets_at_epoch?: number;
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
): Promise<RunResumeEnvelope> {
  const run = await state.read(runId);
  if (isTerminalRunStatus(run.status)) {
    throw new Error(`run resume: run '${runId}' is terminal (${run.status}); nothing to resume`);
  }

  const plan = planResume(run, reading, config, nowEpochSec);
  switch (plan.kind) {
    case "not-resumable":
      // Non-terminal but not paused/suspended ⇒ already running: idempotent re-entry.
      return { kind: "resumed", run };
    case "resume": {
      const updated = await state.update(runId, (s) => ({
        ...s,
        status: plan.clear.status,
        quota: plan.clear.quota,
      }));
      return { kind: "resumed", run: updated };
    }
    case "still-blocked": {
      const d = plan.decision;
      // planResume only emits still-blocked for a non-proceed decision; narrow
      // defensively so the `proceed` arm (which has no reason) is unreachable.
      if (d.kind === "proceed") {
        return { kind: "resumed", run };
      }
      const base = {
        kind: "still-blocked",
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
 * orchestrator/command can pass it deterministically) over the `CLAUDE_CODE_SESSION_ID`
 * env var that Claude Code sets for Bash-tool invocations. Returns `undefined` when
 * neither is available — owner-unknown is a supported (degraded-but-safe) state in
 * which the Stop gate falls back to its unscoped behavior.
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
  const args = parseArgs(argv, { booleans: ["new", "workflow", "no-ship", "supersede", "resume"] });
  if (args.flag("help") === true) {
    emitLine(CREATE_HELP);
    return EXIT.OK;
  }
  // Mandatory autonomous-mode gate: the pipeline runs unattended, no opt-out.
  // A run can only be born in the foreground orchestrator session (which has the
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
  // Resolve-or-reuse is the default for the natural (auto-id) invocation — a repeat
  // returns the live run, never an orphan. `--new` OR an explicit `--run-id` opts
  // into an imperative fresh create: a named id is an address (determinism/tests),
  // not a reuse request, so it never silently resolves to a different run.
  const force = args.flag("new") === true || explicitRunId !== undefined;
  const supersede = args.flag("supersede") === true;
  const resume = args.flag("resume") === true;
  if (supersede && resume) {
    throw new UsageError("run create: pass at most one of --supersede / --resume");
  }

  const dataDir = resolveDataDir(
    overrides.dataDir !== undefined ? { dataDir: overrides.dataDir } : {},
  );
  const config = loadConfig(overrides.dataDir !== undefined ? { dataDir } : {});
  const state = new StateManager({ dataDir });
  const specStore = new SpecStore({ dataDir });
  // Decision 33: build the staging deps bundle (git + gh + config + root + repo
  // coords) so createRunFromManifest can cut + protect staging/<run-id> from develop.
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
      ...(force ? { force } : {}),
      ...(supersede ? { supersede } : {}),
      ...(resume ? { resume } : {}),
    },
    stagingDeps,
  );
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
  const args = parseArgs(argv);
  if (args.flag("help") === true) {
    emitLine(RESUME_HELP);
    return EXIT.OK;
  }
  // Mandatory autonomous-mode gate (see runCreate): resume re-activates a run and
  // runs in the foreground `/factory:run resume` session, which has the env.
  requireAutonomousMode();

  const dataDir = resolveDataDir({});
  const config = loadConfig({ dataDir });
  const state = new StateManager({ dataDir });
  const runId = await resolveRunId(state, args, "resume");

  const reading = await new StatuslineUsageSignal({ dataDir }).read();
  const envelope = await applyResume(state, runId, reading, config, nowEpoch());
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
  const { run, report, rollup, issuesFiled } = await finalizeRun(deps, runId);
  emitJson({
    kind: "finalized",
    run,
    report,
    ...(rollup !== undefined ? { rollup } : {}),
    issues_filed: issuesFiled,
  });
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
    default:
      throw new UsageError(`unknown run action '${action}' (expected create | resume | finalize)`);
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
