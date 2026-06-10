/**
 * `factory run <create|resume>` — the run-lifecycle entrypoint (C6).
 *
 * Model A: the CLI never spawns an agent. `run create` resolves a DURABLE spec (by
 * stable issue number or explicit spec-id), creates a fresh run, SEEDS its task
 * rows from the spec, and emits the {@link RunState}; the in-session orchestrator
 * reads `run_id` and drives task-by-task via `run-task` + the `record-*` writers.
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
import { parseArgs, isUsageError, UsageError, parseShipMode } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { loadConfig, resolveDataDir } from "../../config/index.js";
import { StateManager } from "../../core/state/index.js";
import { SpecStore, type SpecManifest } from "../../spec/index.js";
import { makeRunId, validateId } from "../../shared/ids.js";
import { nowEpoch } from "../../shared/time.js";
import { planResume, StatuslineUsageSignal, type UsageReading } from "../../quota/index.js";
import { isTerminalRunStatus } from "../../types/index.js";
import type { Config, Driver, RunState, RunStatus, TaskState } from "../../types/index.js";
import { finalizeRun } from "../../driver/index.js";
import { loadCliDeps } from "../wiring.js";
import type { Subcommand } from "../main.js";

const RUN_HELP = `factory run — create or resume a run

Usage:
  factory run create --repo <owner/name> (--issue <n> | --spec-id <id>) [--driver <d>] [--run-id <id>]
  factory run resume [--run <id>]
  factory run finalize [--run <id>] [--ship-mode <mode>]

Actions:
  create     Resolve a durable spec, create a run, seed its tasks, emit the RunState.
  resume     Re-check the live quota window; clear the checkpoint if it has recovered.
  finalize   Build the partial report, file per-drop issues, ship the rollup, flip terminal.`;

const CREATE_HELP = `factory run create — create a run and seed its tasks from a durable spec

Usage:
  factory run create --repo <owner/name> (--issue <n> | --spec-id <id>) [--driver <d>] [--run-id <id>]

  --repo      Repo identity 'owner/name' (the first key of the spec store).
  --issue     PRD issue number — the STABLE lookup key (reruns reuse the spec).
  --spec-id   Explicit '<issue>-<slug>' spec id (alternative to --issue).
  --driver    sequential | balanced (default: balanced).
  --run-id    Override the generated 'run-YYYYMMDD-HHMMSS' id (determinism/tests).

Resolves the spec via the durable store (LOUD if none exists — generate one first),
creates the run, seeds one pending task per spec task, and emits the RunState JSON.`;

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
  factory run finalize [--run <id>] [--ship-mode <mode>]

  --run         The run to finalize (defaults to runs/current).
  --ship-mode   live | no-merge (default: no-merge — opens the rollup PR, never merges).

Builds the deterministic partial-run report (report.md), emits run.finalized
telemetry, files ONE GitHub issue per dropped task (deduped), opens + CI-gates +
(in live mode) squash-merges the staging→develop rollup, then flips the run
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

/** Resolved options for {@link createRun} (exactly one of issue/specId is set). */
export interface CreateRunOptions {
  readonly repo: string;
  readonly issue?: number;
  readonly specId?: string;
  readonly driver: Driver;
  readonly runId: string;
}

/**
 * Resolve the durable spec, create the run, and seed its tasks — the testable core
 * of `run create`. Resolves by explicit spec-id when given, else by the stable
 * issue number (LOUD if no spec exists yet — a run cannot be created without one).
 * Creates the run (status `running`), then folds in the seeded task rows via the
 * one sanctioned write path; returns the seeded {@link RunState}.
 */
export async function createRun(
  state: StateManager,
  specStore: SpecStore,
  opts: CreateRunOptions,
): Promise<RunState> {
  let manifest: SpecManifest;
  if (opts.specId !== undefined) {
    manifest = await specStore.read(opts.repo, opts.specId);
  } else if (opts.issue !== undefined) {
    const resolved = await specStore.resolveByIssue(opts.repo, opts.issue);
    if (resolved === null) {
      throw new Error(
        `run create: no spec for issue #${opts.issue} in ${opts.repo} — generate one first`,
      );
    }
    manifest = resolved;
  } else {
    // Guarded by the command layer; defensive for direct callers.
    throw new UsageError("run create requires --issue or --spec-id");
  }

  const seeded = seedTasksFromSpec(manifest);
  await state.create({
    run_id: opts.runId,
    spec: specStore.toPointer(manifest),
    driver: opts.driver,
  });
  return state.update(opts.runId, (s) => ({ ...s, tasks: seeded }));
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

function parseDriver(raw: string | boolean | undefined): Driver {
  if (raw === undefined) return "balanced";
  if (raw === "sequential" || raw === "balanced") return raw;
  throw new UsageError(`unknown --driver '${String(raw)}' (expected sequential | balanced)`);
}

function parseIssue(raw: string | boolean | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new UsageError("--issue requires a value");
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--issue must be a positive integer, got '${raw}'`);
  }
  return n;
}

/** Coerce a flag to a non-empty string, treating a bare boolean flag as absent. */
function optionalString(raw: string | boolean | undefined): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

async function runCreate(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv);
  if (args.flag("help") === true) {
    emitLine(CREATE_HELP);
    return EXIT.OK;
  }

  const repo = args.requireFlag("repo");
  const driver = parseDriver(args.flag("driver"));
  const issue = parseIssue(args.flag("issue"));
  const specId = optionalString(args.flag("spec-id"));
  if (issue === undefined && specId === undefined) {
    throw new UsageError("run create requires --issue <n> or --spec-id <id>");
  }
  if (issue !== undefined && specId !== undefined) {
    throw new UsageError("run create: pass exactly one of --issue or --spec-id");
  }
  const runId = optionalString(args.flag("run-id")) ?? makeRunId();
  validateId(runId, "run-id");

  const dataDir = resolveDataDir({});
  const state = new StateManager({ dataDir });
  const specStore = new SpecStore({ dataDir });
  const run = await createRun(state, specStore, {
    repo,
    driver,
    runId,
    ...(issue !== undefined ? { issue } : {}),
    ...(specId !== undefined ? { specId } : {}),
  });
  emitJson(run);
  return EXIT.OK;
}

async function runResume(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv);
  if (args.flag("help") === true) {
    emitLine(RESUME_HELP);
    return EXIT.OK;
  }

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
): Promise<string> {
  const explicit = optionalString(args.flag("run"));
  if (explicit !== undefined) return explicit;
  const current = await state.readCurrent();
  if (current === null) {
    throw new UsageError(`run ${action}: no --run given and no current run`);
  }
  return current.run_id;
}

async function runFinalize(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv);
  if (args.flag("help") === true) {
    emitLine(FINALIZE_HELP);
    return EXIT.OK;
  }

  const shipMode = parseShipMode(args.flag("ship-mode"));
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
