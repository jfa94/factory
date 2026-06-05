/**
 * WS9 — SubagentStop transcript→state seam (ports
 * `hooks/subagent-stop-transcript.sh` onto the NEW lean TaskState).
 *
 * The new schema dropped the ~12 ad-hoc per-task fields the bash hook wrote
 * (worktree, executor_status, reviewer_status, prior_branch, …). On the new
 * design the subagent→driver hand-off is the structured StageResult/SpawnManifest
 * (group0-seams §3), so this hook's job SHRINKS to its one durable
 * responsibility: when a REVIEWER subagent stops, append its
 * {@link ReviewerResult} to the task's `reviewers[]` via
 * {@link StateManager.updateTask} (atomic + locked — never a raw fs write). The
 * derive-don't-store floor (derivePanelVerdict) is then computed from those
 * results; we never store a floor boolean.
 *
 * Reviewer subagent role → ReviewerResult.reviewer name:
 *   implementation-reviewer → "implementation"; quality-reviewer → "quality";
 *   architecture-reviewer → "architecture"; security-reviewer → "security";
 *   silent-failure-hunter → "silent-failure"; type-design-reviewer → "type-design".
 *
 * The reviewer's verdict is parsed from the last assistant message's STATUS line
 * (DONE → approve; BLOCKED / anything else → blocked). A missing/unresolved
 * task_id is LOGGED LOUDLY and SKIPS the write (no silent state loss).
 *
 * CONSOLIDATION (A2 — supersedes `hooks/subagent-stop-gate.sh`): the bash gate's
 * PRODUCER validation (STATUS-line enforcement, zero-commits block, persisted
 * 2-attempt retry budget for test-writer/executor) is deliberately NOT ported as
 * a hook. In the new design those properties are achieved STRUCTURALLY and more
 * robustly downstream: a no-op producer (zero commits) leaves the task branch ==
 * base, so the WS6 deterministic gates (tests + TDD gate) fail → the task never
 * advances → the WS8 escalation ladder (bounded retries, cap 2) retries then emits
 * a classified loud drop. The reviewer STATUS check survives here as
 * {@link parseVerdict} (absent STATUS ⇒ blocked, never a silent approve). The
 * warn-only artifact checks (missing spec.md/tasks.json/review files) move to the
 * WS12 telemetry sink. Net: one SubagentStop hook (this file) with one durable
 * job, instead of two bash hooks duplicating the stage machine.
 */
import { EXIT, type ExitCode } from "../cli/exit-codes.js";
import { createLogger } from "../shared/logging.js";
import { StateManager } from "../core/state/index.js";
import { PanelVerdictEnum } from "../core/state/index.js";
import type { DataDirOptions } from "../config/load.js";
import type { PanelVerdict, ReviewerResult, RunState, TaskState } from "../types/index.js";
import { parseHookInput, type HookInput } from "./hook-io.js";

const log = createLogger("hook:subagent-stop");

/** Map a subagent role to the ReviewerResult.reviewer identity, or null if not a reviewer. */
export function reviewerNameOf(agentType: string): string | null {
  const t = agentType.replace(/^factory:/, "");
  switch (t) {
    case "implementation-reviewer":
      return "implementation";
    case "quality-reviewer":
      return "quality";
    case "architecture-reviewer":
      return "architecture";
    case "security-reviewer":
      return "security";
    case "silent-failure-hunter":
      return "silent-failure";
    case "type-design-reviewer":
      return "type-design";
    default:
      return null;
  }
}

/** Parse the STATUS line from a last-assistant-message into a panel verdict. */
export function parseVerdict(lastMessage: string | undefined): PanelVerdict {
  if (!lastMessage) return PanelVerdictEnum.enum.blocked;
  const m = lastMessage.match(/STATUS:\s+([A-Z_]+)/g);
  if (!m || m.length === 0) return PanelVerdictEnum.enum.blocked;
  const last = m[m.length - 1]!.replace(/STATUS:\s+/, "");
  // DONE (clean approve) → approve. Everything else (BLOCKED, NEEDS_CONTEXT, …)
  // → blocked. An unparseable/absent status is treated as blocked (fail-loud,
  // never silently approve — mirrors the bash default-to-BLOCKED).
  return last === "DONE" ? PanelVerdictEnum.enum.approve : PanelVerdictEnum.enum.blocked;
}

/** Derive the task_id from the inlined `[task:<id>]` header in the transcript text. */
export function taskIdFromHeader(transcriptText: string | undefined): string | null {
  if (!transcriptText) return null;
  const m = transcriptText.match(/\[task:([a-zA-Z0-9_-]+)\]/);
  return m ? m[1]! : null;
}

/** Options for {@link runSubagentStop} (injectable). */
export interface SubagentStopDeps extends DataDirOptions {
  /** Override the StateManager (tests). */
  manager?: Pick<StateManager, "readCurrent" | "updateTask">;
  /** Read the transcript file at a path (tests inject; prod reads fs). */
  readTranscript?: (path: string) => Promise<string>;
  /** Explicit task id (e.g. from FACTORY_TASK_ID); else parsed from header. */
  explicitTaskId?: string;
}

/**
 * Append a reviewer's result to the task's reviewers[] (replacing any prior
 * result from the same reviewer — last-writer-wins per reviewer, idempotent
 * under re-runs). The verdict/blocker coherence required by the schema
 * (approve ⇒ 0 blockers; blocked ⇒ ≥1) is satisfied here.
 */
function appendReviewer(task: TaskState, result: ReviewerResult): TaskState {
  const others = task.reviewers.filter((r) => r.reviewer !== result.reviewer);
  return { ...task, reviewers: [...others, result] };
}

/**
 * Core handler: given parsed input, resolve the reviewer + task and write the
 * ReviewerResult through StateManager. Returns the updated RunState, or null when
 * the subagent is not a reviewer / no active run / task_id unresolved (logged).
 */
export async function handleSubagentStop(
  input: HookInput | null,
  deps: SubagentStopDeps = {},
): Promise<RunState | null> {
  if (!input) return null;
  const agentType =
    (input.agent_type as string | undefined) ?? (input.subagent_type as string | undefined) ?? "";
  if (agentType.length === 0) return null;

  const reviewer = reviewerNameOf(agentType);
  // Only reviewer roles produce a persisted artifact in the new design. Other
  // roles' hand-off is the structured StageResult — nothing to write here.
  if (reviewer === null) return null;

  const manager = deps.manager ?? new StateManager(deps);
  const run = await manager.readCurrent();
  if (run === null) {
    log.warn(`no active run (runs/current absent) — reviewer '${reviewer}' result skipped`);
    return null;
  }

  // Resolve task_id: explicit > inlined header > single in-flight reviewing task.
  let taskId = deps.explicitTaskId ?? process.env.FACTORY_TASK_ID ?? "";
  if (taskId.length === 0) {
    const transcriptPath =
      (input.agent_transcript_path as string | undefined) ??
      (input.transcript_path as string | undefined);
    let transcriptText: string | undefined;
    if (transcriptPath && deps.readTranscript) {
      try {
        transcriptText = await deps.readTranscript(transcriptPath);
      } catch {
        transcriptText = undefined;
      }
    }
    const fromHeader =
      taskIdFromHeader(transcriptText) ?? taskIdFromHeader(input.last_assistant_message);
    if (fromHeader) taskId = fromHeader;
  }
  if (taskId.length === 0) {
    // Single reviewing task fallback.
    const reviewing = Object.values(run.tasks).filter((t) => t.status === "reviewing");
    if (reviewing.length === 1) taskId = reviewing[0]!.task_id;
  }

  if (taskId.length === 0) {
    // FAIL-LOUD: no silent state loss. Log and skip the write.
    log.error(
      `could not resolve task_id for reviewer '${reviewer}' (run ${run.run_id}); ` +
        `reviewer result NOT persisted — no silent state loss`,
    );
    return null;
  }

  if (!run.tasks[taskId]) {
    log.error(
      `resolved task_id '${taskId}' is not in run ${run.run_id}; reviewer '${reviewer}' result skipped`,
    );
    return null;
  }

  const verdict = parseVerdict(input.last_assistant_message);
  const result: ReviewerResult = {
    reviewer,
    verdict,
    // Schema coherence: approve ⇒ 0; blocked ⇒ ≥1. We do not have a verified
    // count from the transcript here, so a blocked verdict records the minimum 1.
    confirmed_blockers: verdict === PanelVerdictEnum.enum.blocked ? 1 : 0,
  };

  // ALL writes route through StateManager (atomic + locked), never raw fs.
  return manager.updateTask(run.run_id, taskId, (task) => appendReviewer(task, result));
}

/**
 * Run the SubagentStop hook end-to-end. Reads stdin, handles, returns OK. A
 * SubagentStop hook is observational — it returns OK even on a skipped write
 * (the loud log is the signal), and OK on malformed input AFTER logging (it must
 * not block the subagent from stopping). The one hard failure is a state write
 * error, which propagates as ERROR so the orchestrator notices lost state.
 */
export async function runSubagentStop(
  _argv: string[] = [],
  deps: SubagentStopDeps & { readRaw?: () => Promise<string> } = {},
): Promise<ExitCode> {
  let input: HookInput | null;
  try {
    const raw = deps.readRaw ? await deps.readRaw() : await readAllStdin();
    input = parseHookInput(raw);
  } catch (err) {
    log.error(`malformed SubagentStop input: ${(err as Error).message}`);
    return EXIT.OK; // observational hook: do not block the stop.
  }
  try {
    await handleSubagentStop(input, deps);
    return EXIT.OK;
  } catch (err) {
    log.error(`SubagentStop state write failed: ${(err as Error).message}`);
    return EXIT.ERROR;
  }
}

/** Read all of process.stdin as utf-8. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}
