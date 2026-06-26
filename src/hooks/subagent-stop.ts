/**
 * WS9 — SubagentStop transcript→state seam (ports
 * `hooks/subagent-stop-transcript.sh` onto the NEW lean TaskState).
 *
 * The new schema dropped the ~12 ad-hoc per-task fields the bash hook wrote
 * (worktree, executor_status, reviewer_status, prior_branch, …). On the new
 * design the subagent→orchestrator hand-off is the structured PhaseResult/SpawnRequest
 * (group0-seams §3).
 *
 * This hook is now LOG-ONLY (observational). When a REVIEWER subagent stops it
 * parses the verdict and logs it loudly, but does NOT write to task.reviewers[].
 * The orchestrator delivers panel results through the `factory next-action` record
 * ({@link applyRecordReviews} in src/orchestrator/record.ts) — that is the single
 * sanctioned writer of task.reviewers[]. A hook-side write would create a second
 * writer that can poison crash-resume replay: if the hook writes reviewers[] after
 * the panel but before the `drive --results` record runs, a subsequent resume hits the verify
 * handler's derive branch ({@link src/orchestrator/handlers.ts} verify) with no holdout
 * evidence and no verify-then-fix → false advance to ship.
 *
 * Reviewer subagent role → ReviewerResult.reviewer name:
 *   implementation-reviewer → "implementation"; quality-reviewer → "quality";
 *   architecture-reviewer → "architecture"; security-reviewer → "security";
 *   silent-failure-hunter → "silent-failure"; type-design-reviewer → "type-design".
 *
 * The reviewer's verdict is parsed from the last assistant message's STATUS line
 * (DONE → approve; BLOCKED / anything else → blocked). A missing/unresolved
 * task_id is LOGGED LOUDLY (no silent state loss).
 *
 * CONSOLIDATION (A2 — supersedes `hooks/subagent-stop-gate.sh`): the bash gate's
 * PRODUCER validation (STATUS-line enforcement, zero-commits block, persisted
 * 2-attempt retry budget for test-writer/implementer) is deliberately NOT ported as
 * a hook. In the new design those properties are achieved STRUCTURALLY and more
 * robustly downstream: a no-op producer (zero commits) leaves the task branch ==
 * base, so the WS6 deterministic gates (tests + TDD gate) fail → the task never
 * advances → the escalation ladder (bounded retries, cap 4) retries then emits
 * a classified loud failure. The reviewer STATUS check survives here as
 * {@link parseVerdict} (absent STATUS ⇒ blocked, never a silent approve). The
 * warn-only artifact checks (missing spec.md/tasks.json/review files) move to the
 * WS12 telemetry sink. Net: one SubagentStop hook (this file) with one observational
 * job, instead of two bash hooks duplicating the phase machine.
 */
import { EXIT, type ExitCode } from "../shared/exit-codes.js";
import { createLogger } from "../shared/logging.js";
import { StateManager, PanelVerdictEnum } from "../core/state/index.js";
import type { DataDirOptions } from "../config/load.js";
import type { PanelVerdict } from "../types/index.js";
import { parseHookInput, readStdin, sessionIdOf, type HookInput } from "./hook-io.js";

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
  /** Override the StateManager (tests — read-only path only). */
  manager?: Pick<StateManager, "findActiveByOwner">;
  /** Read the transcript file at a path (tests inject; prod reads fs). */
  readTranscript?: (path: string) => Promise<string>;
  /** Explicit task id (e.g. from FACTORY_TASK_ID); else parsed from header. */
  explicitTaskId?: string;
}

/**
 * Core handler: given parsed input, resolve the reviewer + task and LOG the parsed
 * verdict loudly. Returns null (observational — no state write).
 *
 * The orchestrator delivers panel results through the `factory next-action` record
 * (applyRecordReviews) — that is the single sanctioned writer of task.reviewers[].
 * A hook-side write here would poison crash-resume replay via the verify handler's
 * derive branch.
 */
export async function handleSubagentStop(
  input: HookInput | null,
  deps: SubagentStopDeps = {},
): Promise<null> {
  if (!input) return null;
  const agentType =
    (input.agent_type as string | undefined) ?? (input.subagent_type as string | undefined) ?? "";
  if (agentType.length === 0) return null;

  const reviewer = reviewerNameOf(agentType);
  // Only reviewer roles carry a verdict to log; other roles' hand-off is the
  // structured PhaseResult — nothing observable here.
  if (reviewer === null) return null;

  const manager = deps.manager ?? new StateManager(deps);
  const sessionId = sessionIdOf(input);
  const run = sessionId !== undefined ? await manager.findActiveByOwner(sessionId) : null;
  if (run === null) {
    if (sessionId !== undefined) {
      log.warn(`no active run for session '${sessionId}' — reviewer '${reviewer}' result skipped`);
    }
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
    log.error(
      `could not resolve task_id for reviewer '${reviewer}' (run ${run.run_id}); ` +
        `verdict NOT persisted — orchestrator record is the single writer`,
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
  // Observational log only — no state write. The orchestrator record (`drive --results`) is
  // the single writer of task.reviewers[].
  log.info(
    `reviewer '${reviewer}' on task '${taskId}': ${verdict} (observational — orchestrator records reviews via the drive --results record)`,
  );
  return null;
}

/**
 * Run the SubagentStop hook end-to-end. Reads stdin, handles, returns OK. The
 * hook is fully observational — it never writes state, so it always returns OK
 * (even on a skipped log or malformed input, which is already logged). It must
 * never block the subagent from stopping.
 */
export async function runSubagentStop(
  _argv: string[] = [],
  deps: SubagentStopDeps & { readRaw?: () => Promise<string> } = {},
): Promise<ExitCode> {
  let input: HookInput | null;
  try {
    const raw = deps.readRaw ? await deps.readRaw() : await readStdin();
    input = parseHookInput(raw);
  } catch (err) {
    log.error(`malformed SubagentStop input: ${(err as Error).message}`);
    return EXIT.OK;
  }
  try {
    await handleSubagentStop(input, deps);
  } catch (err) {
    // Any error from the observational handler (e.g. state-read failure) is logged
    // and swallowed — the hook must never block the subagent from stopping.
    log.error(`SubagentStop handler error: ${(err as Error).message}`);
  }
  return EXIT.OK;
}
