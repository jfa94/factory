/**
 * WS2 — Phase vocabulary for the per-task phase machine.
 *
 * THE FROZEN PHASE SEAM. Two CLOSED enums name the universe of phases:
 *   - {@link TaskPhaseEnum} — the per-task order `preflight → tests → exec →
 *     verify → ship`.
 *   - {@link RunPhaseEnum} — the run-level `finalize` step, kept SEPARATE from the
 *     per-task order because it runs ONCE, after every task is terminal, and is
 *     terminal itself (no spin — see engine.ts / result.ts).
 *
 * GREENFIELD: the retired bash phase names (`preexec_tests`, `postexec`,
 * `postreview`, `finalize-run`) in `bin/pipeline-run-task-phases.sh` /
 * `skills/pipeline-runner/reference/phase-taxonomy.md` are consulted for the
 * transition shape ONLY — they are RENAMED here (`tests`/`exec`/`verify`/`ship`/
 * `finalize`), never ported. Human-gate phases are gone (Decision 5).
 */
import { z } from "zod";
import { TaskStatusEnum, type TaskStatus } from "../state/index.js";
import { TASK_PHASES } from "../../types/phases-vocab.js";

/**
 * The per-task phases, in execution order. CLOSED set — a value outside it is a
 * LOUD parse error (mirrors the WS1 closed-enum discipline). Renamed from the
 * bash taxonomy: `preexec_tests→tests`, `postexec→exec`, `postreview→verify`.
 */
export const TaskPhaseEnum = z.enum(TASK_PHASES);
export type TaskPhase = z.infer<typeof TaskPhaseEnum>;

/**
 * The run-level phase(s). Deliberately a separate enum from {@link TaskPhaseEnum}:
 * `finalize` is not part of the per-task order and must never be reachable by
 * `nextPhase` walking past `ship`.
 */
export const RunPhaseEnum = z.enum(["finalize"]);
export type RunPhase = z.infer<typeof RunPhaseEnum>;

/**
 * The canonical per-task phase order. `nextPhase` walks this; the engine and both
 * runners (v1 session, v2 Workflow) share it so the transition logic has ONE home.
 */
export const TASK_PHASE_ORDER: readonly TaskPhase[] = TASK_PHASES;

/**
 * The phase that follows `s` in {@link TASK_PHASE_ORDER}, or `null` when `s` is the
 * last phase (`ship`) — i.e. the task is past its per-task phases and the next
 * thing is a terminal result, not another phase.
 */
export function nextPhase(s: TaskPhase): TaskPhase | null {
  const i = TASK_PHASE_ORDER.indexOf(s);
  if (i < 0) {
    // Unreachable for a validly-typed TaskPhase; loud if a bad value is forced in.
    throw new Error(`nextPhase: '${s}' is not a known task phase`);
  }
  const next = TASK_PHASE_ORDER[i + 1];
  return next ?? null;
}

/**
 * The WS1 {@link TaskStatus} a task is IN-FLIGHT under while a given phase runs.
 * The engine returns phases; the CALLER (orchestrator) uses this to keep the persisted
 * WS1 status in lockstep — the engine never writes state.
 *
 *   - `preflight` → `pending`   (not yet producing)
 *   - `tests`     → `executing` (producer: test-writer)
 *   - `exec`      → `executing` (producer: implementer)
 *   - `verify`    → `reviewing` (merge gate in flight)
 *   - `ship`      → `shipping`  (PR open / merging)
 *
 * Note these are IN-FLIGHT statuses; terminal statuses (`done`/`failed`) come
 * from a `task-terminal` result, not from a phase.
 */
export function phaseToInFlightStatus(s: TaskPhase): TaskStatus {
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
