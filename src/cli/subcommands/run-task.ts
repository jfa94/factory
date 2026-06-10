/**
 * `factory run-task --run <id> --task <id> --stage <stage>` — the SINGLE-STEP
 * deterministic reporter (Task C / Model A).
 *
 * This is the seam the in-session orchestrator drives: it runs EXACTLY ONE stage's
 * deterministic work and emits ONE JSON envelope ({@link RunTaskEnvelope}) to
 * stdout — never spawning an agent, never (for the report stages) writing run state.
 * The orchestrator reads the envelope, performs any `spawn-agents` itself, and folds
 * the agent outcomes back via the `record-*` state-write subcommands.
 *
 *   preflight | tests | exec | verify  → pure REPORT (artifacts only, no run state):
 *       runStage → the {@link makeStageHandlers} reporter → {stage_result}. `verify`
 *       additionally surfaces a `sidecar` holdout-validate spawn (the holdout-
 *       validator is out-of-band — not in the closed SpawnRole set — so it cannot
 *       ride the panel manifest) when an answer key was withheld AND the panel is
 *       being spawned this round.
 *   ship                               → the ONE deterministic terminal stage with
 *       no agent→record cycle, so it ACTS: {@link shipTask} opens the PR idempotently,
 *       records branch/pr_number, optionally serial-merges (live), and on a clean
 *       `done` writes the terminal status via {@link completeTask}. A refused live
 *       merge emits a `wait-retry` the orchestrator re-routes (back to exec) — no
 *       `done` is written.
 */
import { EXIT, type ExitCode } from "../exit-codes.js";
import { parseArgs, isUsageError, UsageError, parseShipMode } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { loadCliDeps, type CliDeps } from "../wiring.js";
import { makeStageHandlers, shipTask, completeTask, taskWorktreePath } from "../../driver/index.js";
import { resolveReviewModel } from "../../verifier/judgment/index.js";
import { buildHoldoutPrompt } from "../../verifier/holdout/index.js";
import { runStage, TASK_STAGE_ORDER } from "../../types/index.js";
import type { StageContext, StageResult, TaskStage, TaskState } from "../../types/index.js";
import type { Subcommand } from "../main.js";

const HELP = `factory run-task — run one deterministic stage step and report (Model A)

Usage:
  factory run-task --run <id> --task <id> --stage <stage> [--ship-mode <mode>]

Stages: ${TASK_STAGE_ORDER.join(" | ")}
Ship modes: no-merge (default) | live

Emits ONE JSON envelope to stdout:
  { run_id, task_id, stage, stage_result, sidecar? }

preflight|tests|exec|verify report only (no run-state writes); the orchestrator
performs any spawn and folds outcomes via the record-* subcommands. ship is the
one stage that writes state (branch/pr_number and, on a clean done, status).`;

/** The out-of-band holdout-validator spawn the orchestrator runs alongside the panel. */
export interface HoldoutSidecar {
  readonly kind: "holdout-validate";
  readonly task_id: string;
  /** The worktree the validator inspects (the diff is here, not its own cwd). */
  readonly worktree: string;
  /** Fixed review model (risk-invariant, like the panel — D26). */
  readonly model: string;
  readonly max_turns: number;
  /** The ready-to-run validator prompt (carries the withheld criteria). */
  readonly prompt: string;
}

/** The single JSON document `factory run-task` emits — the orchestrator's contract. */
export interface RunTaskEnvelope {
  readonly run_id: string;
  readonly task_id: string;
  readonly stage: TaskStage;
  readonly stage_result: StageResult;
  /** Present only on a `verify` round that spawns the panel with a withheld key. */
  readonly sidecar?: HoldoutSidecar;
}

/** Validate the `--stage` flag against the closed task-stage set. */
function parseStage(raw: string): TaskStage {
  if ((TASK_STAGE_ORDER as readonly string[]).includes(raw)) {
    return raw as TaskStage;
  }
  throw new UsageError(`unknown --stage '${raw}' (expected one of ${TASK_STAGE_ORDER.join(", ")})`);
}

/** Resolve the live task row from the freshly-read run snapshot (LOUD if absent). */
function taskOf(deps: CliDeps, taskId: string): TaskState {
  const task = deps.run.tasks[taskId];
  if (task === undefined) {
    throw new Error(`run-task: run '${deps.run.run_id}' has no task '${taskId}'`);
  }
  return task;
}

/**
 * Build the holdout-validate sidecar IFF an answer key was withheld for this task.
 * Returns undefined for a degenerate (withheld-0) split — verify folds no holdout.
 */
async function holdoutSidecar(deps: CliDeps, taskId: string): Promise<HoldoutSidecar | undefined> {
  if (!(await deps.holdout.has(deps.run.run_id, taskId))) {
    return undefined;
  }
  const record = await deps.holdout.get(deps.run.run_id, taskId);
  const worktree = taskWorktreePath(deps.dataDir, deps.run.run_id, taskId);
  return {
    kind: "holdout-validate",
    task_id: taskId,
    worktree,
    model: resolveReviewModel(deps.config),
    max_turns: deps.config.review.maxTurnsDeep,
    prompt: buildHoldoutPrompt(record, worktree),
  };
}

async function run(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: [] });
  if (args.flag("help") === true) {
    emitLine(HELP);
    return EXIT.OK;
  }

  const runId = args.requireFlag("run");
  const taskId = args.requireFlag("task");
  const stage = parseStage(args.requireFlag("stage"));
  const shipMode = parseShipMode(args.flag("ship-mode"));

  const deps = await loadCliDeps({ runId, ...(shipMode !== undefined ? { shipMode } : {}) });
  const task = taskOf(deps, taskId);
  const ctx: StageContext = { run: deps.run, task, attempt: task.escalation_rung + 1 };

  const envelope = await reportStage(deps, ctx, stage, taskId);
  emitJson(envelope);
  return EXIT.OK;
}

/** Dispatch one stage to its result (+ any sidecar), applying ship's state writes. */
export async function reportStage(
  deps: CliDeps,
  ctx: StageContext,
  stage: TaskStage,
  taskId: string,
): Promise<RunTaskEnvelope> {
  const base = { run_id: deps.run.run_id, task_id: taskId, stage } as const;

  if (stage === "ship") {
    const stage_result = await shipTask(deps, ctx);
    // ship is terminal-by-construction: on a clean `done`, write the status here
    // (the one report stage that mutates run state — no agent→record cycle). A
    // refused live merge returns wait-retry; leave the task open for a re-sync.
    if (stage_result.kind === "task-terminal" && stage_result.outcome.outcome === "done") {
      await completeTask(deps, deps.run.run_id, taskId);
    }
    return { ...base, stage_result };
  }

  const handlers = makeStageHandlers(deps);
  const stage_result = await runStage(stage, ctx, handlers);

  if (stage === "verify" && stage_result.kind === "spawn-agents") {
    const sidecar = await holdoutSidecar(deps, taskId);
    if (sidecar !== undefined) {
      return { ...base, stage_result, sidecar };
    }
  }
  return { ...base, stage_result };
}

export const runTaskCommand: Subcommand = {
  describe: "Run one deterministic stage step (Model A reporter) and emit a JSON envelope",
  run: async (argv) => {
    try {
      return await run(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`run-task: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  },
};
