/**
 * WS9 — PreToolUse guard for factory pipeline invariants, RE-TARGETED to the new
 * seam (ports `hooks/pretooluse-pipeline-guards.sh`).
 *
 * Only fires while a run is ACTIVE (runs/current resolves). Three invariants:
 *   (a) TEST-WRITER PHASE scope: while the active task stage is `tests`, an
 *       Edit/Write/MultiEdit to a NON-test path is blocked (the test-writer may
 *       commit only failing tests first — TDD).
 *   (b) NESTED-SHELL / hook-bypass denial while a run is active (shared
 *       {@link isNestedShellOrHookBypass}).
 *   (c) SHIP gating via DERIVE-DON'T-STORE (Δ V): `gh pr create`/`gh pr merge`
 *       are admitted only when the floor verdict DERIVED from ground truth
 *       passes. There is structurally NO stored gate boolean to read (WS1
 *       schema) — a forged `*_gate` field cannot satisfy the guard because the
 *       verdict comes from {@link deriveFloorVerdict}/{@link derivePanelVerdict},
 *       never from state.json.
 *
 * A dangling runs/current symlink fails CLOSED (deny) — corruption is never
 * silently allowed. No active run → pass through.
 */
import { EXIT, type ExitCode } from "../cli/exit-codes.js";
import { sep } from "node:path";
import { derivePanelVerdict, type GateEvidence } from "../core/state/index.js";
import { deriveFloorVerdict } from "../core/state/index.js";
import { TaskStageEnum } from "../core/stage-machine/index.js";
import {
  loadActiveRun,
  resolveActiveTask,
  isTestWriterPhase,
  BrokenRunStateError,
  type ActiveRun,
} from "./hook-context.js";
import { isNestedShellOrHookBypass } from "./shell-bypass.js";
import { isAutonomous } from "../autonomy/mode.js";
import type { DataDirOptions } from "../config/load.js";
import {
  allow,
  commandOf,
  deny,
  decisionToExitCode,
  emitPermissionDecision,
  filePathsOf,
  parseHookInput,
  toolNameOf,
  type HookDecision,
  type HookInput,
} from "./hook-io.js";

/** Options for {@link decidePipelineGuards} (injectable). */
export interface PipelineGuardsDeps extends DataDirOptions {
  cwd?: string;
  autonomousMode?: boolean;
  /**
   * Ground-truth gate evidence for the SHIP gating check (Δ V). Supplied by the
   * driver at guard time from a fresh gate run — NEVER read from state. Keyed by
   * task id. Absent → no deterministic-gate evidence (the floor then fails on
   * the empty set, which is the correct fail-closed behavior).
   */
  gateEvidence?: Record<string, readonly GateEvidence[]>;
  /** Override the active-run loader (tests). */
  loadRun?: (opts: DataDirOptions) => Promise<ActiveRun | null>;
}

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/** Is the path a test/fixture path (allowed during the test-writer phase)? */
export function isTestPath(p: string): boolean {
  const base = p.split(sep).pop() ?? p;
  if (/\.(test|spec)\./.test(base)) return true;
  if (/\.(test-helpers|test-utils)\./.test(base)) return true;
  const segments = p.split(sep);
  if (segments.includes("tests") || segments.includes("__tests__")) return true;
  if (segments.includes("fixtures")) return true;
  return false;
}

// Boundary-aware so a prefixed/compound command cannot evade the ship gate:
// `cd /r && gh pr create`, `true; gh pr create`, `GH=1 gh pr create`, `a | gh …`
// all match. Mirrors the sibling guards' boundary discipline (secret/holdout)
// rather than the anchor-only `^\s*` which only catches a bare leading command.
// Fail-closed: a harmless `echo gh pr create` also matches, which is the safe
// direction for a deny-gate.
const GH_PR_CREATE_RE = /(^|[\s&;|(])gh\s+pr\s+create\b/;
const GH_PR_MERGE_RE = /(^|[\s&;|(])gh\s+pr\s+merge\b/;

/** Detect a `gh pr create` command (anywhere in a compound command). */
function isGhPrCreate(cmd: string): boolean {
  return GH_PR_CREATE_RE.test(cmd);
}
/** Detect a `gh pr merge` command (anywhere in a compound command). */
function isGhPrMerge(cmd: string): boolean {
  return GH_PR_MERGE_RE.test(cmd);
}

/**
 * Decide the pipeline-invariant verdict for a hook input. Resolves the active
 * run; pure thereafter. Throwing loaders (BrokenRunStateError) are mapped to a
 * fail-closed deny by the caller — but this function rethrows so the run-level
 * loud failure is visible; {@link runPipelineGuards} catches it.
 */
export async function decidePipelineGuards(
  input: HookInput | null,
  deps: PipelineGuardsDeps = {},
): Promise<HookDecision> {
  const loadRun = deps.loadRun ?? loadActiveRun;
  const active = await loadRun(deps);
  if (active === null) return allow(); // no active run → pass through

  const { run } = active;
  const tool = toolNameOf(input);
  const cmd = commandOf(input);

  // (b) nested-shell / hook-bypass while a run is active.
  if (cmd.length > 0 && isNestedShellOrHookBypass(cmd)) {
    return deny(
      "nested_shell_denied",
      `nested-shell or hook-bypass not allowed while a pipeline run is active: ${cmd}`,
    );
  }

  const activeTask = resolveActiveTask(run);

  // (a) test-writer-phase write-scope.
  if (WRITE_TOOLS.has(tool) && isTestWriterPhase(activeTask)) {
    for (const target of filePathsOf(input)) {
      if (!isTestPath(target)) {
        return deny(
          "test_writer_scope",
          `Test-writer phase: only test files allowed. Detected write to '${target}'. ` +
            `Move implementation code to the GREEN (exec) phase.`,
        );
      }
    }
  }

  // (c) ship gating via derive-don't-store.
  if (tool === "Bash" && (isGhPrCreate(cmd) || isGhPrMerge(cmd))) {
    // Resolve the task this ship op is for.
    const task = activeTask?.task;
    if (!task) {
      // Cannot attribute → fail closed in autonomous mode (a ship op must be
      // attributable to a task whose floor we can derive).
      const autonomous = deps.autonomousMode ?? isAutonomous();
      if (autonomous) {
        return deny(
          "ship_unattributable",
          "gh pr create/merge cannot run without an attributable task whose verifier floor can be derived",
        );
      }
      return allow();
    }

    const evidence = deps.gateEvidence?.[task.task_id] ?? [];
    if (isGhPrCreate(cmd)) {
      // PR create requires the full verifier floor (gates + panel) to PASS,
      // DERIVED from ground truth — never a stored boolean.
      const floor = deriveFloorVerdict(task, evidence);
      if (!floor.passed) {
        return deny(
          "ship_floor_not_met",
          `gh pr create for task '${task.task_id}' blocked: derived verifier floor did not pass ` +
            `(gates+panel; verdict is derived from ground truth, not a stored gate boolean).`,
        );
      }
    } else {
      // PR merge requires the panel floor (unanimous approve) AND a recorded PR
      // number. The CI-green signal is ground truth supplied as gate evidence.
      const panel = derivePanelVerdict(task);
      if (!panel.passed) {
        return deny(
          "ship_panel_not_met",
          `gh pr merge for task '${task.task_id}' blocked: derived panel verdict did not pass.`,
        );
      }
      if (task.pr_number === undefined) {
        return deny(
          "ship_no_pr",
          `gh pr merge for task '${task.task_id}' blocked: no recorded pr_number.`,
        );
      }
      const ci = deriveFloorVerdict(task, evidence);
      if (!ci.passed) {
        return deny(
          "ship_ci_not_green",
          `gh pr merge for task '${task.task_id}' blocked: derived CI/floor verdict did not pass.`,
        );
      }
    }
  }

  return allow();
}

/**
 * Run the pipeline-invariant guard end-to-end. A broken runs/current symlink or
 * malformed stdin fails CLOSED (deny). Injectable `readRaw` for tests.
 */
export async function runPipelineGuards(
  _argv: string[] = [],
  deps: PipelineGuardsDeps & { readRaw?: () => Promise<string> } = {},
): Promise<ExitCode> {
  let input: HookInput | null;
  try {
    const raw = deps.readRaw ? await deps.readRaw() : await readAllStdin();
    input = parseHookInput(raw);
  } catch {
    const decision = deny("malformed_hook_input", "pipeline-guards: unparseable hook input");
    emitPermissionDecision(decision);
    return EXIT.ERROR;
  }
  let decision: HookDecision;
  try {
    decision = await decidePipelineGuards(input, deps);
  } catch (err) {
    if (err instanceof BrokenRunStateError) {
      decision = deny("broken_pipeline_state", err.message);
    } else {
      // Corrupt state.json or any other loud failure → fail closed.
      decision = deny("pipeline_guard_error", (err as Error).message);
    }
    emitPermissionDecision(decision);
    return EXIT.ERROR;
  }
  emitPermissionDecision(decision);
  return decisionToExitCode(decision);
}

/** Re-export for stage identification in callers/tests. */
export { TaskStageEnum };

/** Read all of process.stdin as utf-8. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}
