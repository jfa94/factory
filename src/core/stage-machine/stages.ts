/**
 * WS2 — Stage vocabulary for the per-task stage machine.
 *
 * THE FROZEN STAGE SEAM. Two CLOSED enums name the universe of stages:
 *   - {@link TaskStageEnum} — the per-task order `preflight → tests → exec →
 *     verify → ship`.
 *   - {@link RunStageEnum} — the run-level `finalize` step, kept SEPARATE from the
 *     per-task order because it runs ONCE, after every task is terminal, and is
 *     terminal itself (no spin — see engine.ts / result.ts).
 *
 * GREENFIELD: the retired bash stage names (`preexec_tests`, `postexec`,
 * `postreview`, `finalize-run`) in `bin/pipeline-run-task-stages.sh` /
 * `skills/pipeline-orchestrator/reference/stage-taxonomy.md` are consulted for the
 * transition shape ONLY — they are RENAMED here (`tests`/`exec`/`verify`/`ship`/
 * `finalize`), never ported. Human-gate stages are gone (Decision 5).
 */
import { z } from "zod";
import { TaskStatusEnum, type TaskStatus } from "../state/index.js";

/**
 * The per-task stages, in execution order. CLOSED set — a value outside it is a
 * LOUD parse error (mirrors the WS1 closed-enum discipline). Renamed from the
 * bash taxonomy: `preexec_tests→tests`, `postexec→exec`, `postreview→verify`.
 */
export const TaskStageEnum = z.enum(["preflight", "tests", "exec", "verify", "ship"]);
export type TaskStage = z.infer<typeof TaskStageEnum>;

/**
 * The run-level stage(s). Deliberately a separate enum from {@link TaskStageEnum}:
 * `finalize` is not part of the per-task order and must never be reachable by
 * `nextStage` walking past `ship`.
 */
export const RunStageEnum = z.enum(["finalize"]);
export type RunStage = z.infer<typeof RunStageEnum>;

/**
 * The canonical per-task stage order. `nextStage` walks this; the engine and both
 * drivers (v1 session, v2 Workflow) share it so the transition logic has ONE home.
 */
export const TASK_STAGE_ORDER: readonly TaskStage[] = [
  "preflight",
  "tests",
  "exec",
  "verify",
  "ship",
] as const;

/**
 * The stage that follows `s` in {@link TASK_STAGE_ORDER}, or `null` when `s` is the
 * last stage (`ship`) — i.e. the task is past its per-task stages and the next
 * thing is a terminal result, not another stage.
 */
export function nextStage(s: TaskStage): TaskStage | null {
  const i = TASK_STAGE_ORDER.indexOf(s);
  if (i < 0) {
    // Unreachable for a validly-typed TaskStage; loud if a bad value is forced in.
    throw new Error(`nextStage: '${s}' is not a known task stage`);
  }
  const next = TASK_STAGE_ORDER[i + 1];
  return next ?? null;
}

/**
 * The WS1 {@link TaskStatus} a task is IN-FLIGHT under while a given stage runs.
 * The engine returns stages; the CALLER (driver) uses this to keep the persisted
 * WS1 status in lockstep — the engine never writes state.
 *
 *   - `preflight` → `pending`   (not yet producing)
 *   - `tests`     → `executing` (producer: test-writer)
 *   - `exec`      → `executing` (producer: executor)
 *   - `verify`    → `reviewing` (merge gate in flight)
 *   - `ship`      → `shipping`  (PR open / merging)
 *
 * Note these are IN-FLIGHT statuses; terminal statuses (`done`/`dropped`) come
 * from a `task-terminal` result, not from a stage.
 */
export function stageToInFlightStatus(s: TaskStage): TaskStatus {
  switch (s) {
    case "preflight":
      return TaskStatusEnum.enum.pending;
    case "tests":
      return TaskStatusEnum.enum.executing;
    case "exec":
      return TaskStatusEnum.enum.executing;
    case "verify":
      return TaskStatusEnum.enum.reviewing;
    case "ship":
      return TaskStatusEnum.enum.shipping;
  }
}
