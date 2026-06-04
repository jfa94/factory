/**
 * WS8 — the bounded NUKE-AND-RETRY OUTER loop: the producer escalation ladder
 * (Decision 22/25, Δ D). CAP = 2 extra attempts; each rung CHANGES A VARIABLE;
 * then a CLASSIFIED LOUD DROP.
 *
 * The ladder is the OUTER loop around the inner fix-forward loop (fix-forward.ts).
 * Its contract:
 *   - CLASSIFY-BEFORE-RETRY (Δ D): every failure is first run through
 *     {@link import("./classify.js").classifyFailure}. A deterministic / spec-
 *     defect / environmental failure routes STRAIGHT to a classified drop —
 *     `taskDropped(failureClass, reason)` — and does NOT burn a rung.
 *   - CHANGE A VARIABLE each rung (Decision 25): rung 1 = same dialed model +
 *     FRESH context; rung 2 = ESCALATED model (next tier up the producerModels
 *     map) + INJECTED prior-failure context. {@link assertRungChange} asserts the
 *     spawn differs from the previous rung's (a blind re-roll throws — it is a
 *     programming error, never silently allowed).
 *   - CAP = 2 (Δ): at most 2 escalating retries past rung 0. When the cap is
 *     exhausted with the floor still blocked, emit
 *     `taskDropped("capability-budget", reason)` — a LOUD + classified drop. A
 *     third retry never spawns.
 *   - EVERY terminal path is LOUD + classified (Decision 22): there is no silent
 *     return/advance; success is `advance(...)`, every failure is `taskDropped`.
 *
 * The ladder is driven against the injected {@link ProducerAgentRunner} + a
 * `verify` callback (the WS7 runPanel, injected so units test without a real
 * panel). It returns a {@link StageResult} the WS10 driver acts on. It NEVER
 * writes state.
 */
import {
  advance,
  taskDropped,
  type Config,
  type RiskTier,
  type StageResult,
  type TaskStage,
} from "../types/index.js";
import { dialForRung, type DialResult } from "./model-dial.js";
import {
  buildProducerContext,
  type ProducerContext,
  type PriorFailureNote,
} from "./prompt-context.js";
import { classifyFailure } from "./classify.js";
import { runFixForward, type FixForwardInput } from "./fix-forward.js";
import type { ProducerAgentRunner, ProducerOutcome } from "./agents.js";
import type { Finding } from "../verifier/judgment/finding.js";

/** The maximum number of escalating retries past the starting rung (Δ cap = 2). */
export const ESCALATION_CAP = 2;

/**
 * The default INNER fix-forward patch budget: how many times the producer may
 * PATCH the confirmed misses in-rung (re-spawn the executor over the specific
 * remaining blockers) before the OUTER ladder nukes + escalates the model
 * (Decision 27). 0 = nuke immediately on any miss; the WS10 driver may override.
 */
export const FIX_FORWARD_PATCH_BUDGET = 2;

/**
 * The verify pass the ladder runs after a producer attempt. Injected so units
 * test without WS7's real runPanel. Returns the confirmed blockers + the LOUD
 * verifier-error flag (the subset of PanelRunResult the ladder needs) — the WS10
 * driver wires the real runPanel into this.
 */
export interface VerifyPass {
  /** Run the verifier floor over the current producer output. */
  (): Promise<VerifyPassResult>;
}

/**
 * A STRUCTURAL (non-capability) floor failure the verify pass detected — a
 * deterministic gate the producer cannot fix as specified, or an environmental
 * blocker. CLASSIFY-BEFORE-RETRY (Δ D): when present, the ladder routes STRAIGHT
 * to a classified loud drop, NEVER burning an escalation rung. It is a strict
 * subset of {@link import("./classify.js").FailureSignal} so it feeds
 * {@link classifyFailure} directly. The WS10 driver populates this from the WS6
 * gate evidence (a structurally-unfixable gate) or an external-blocker probe.
 */
export type VerifyStructuralFailure =
  | {
      readonly kind: "gate-failure";
      readonly gate: string;
      readonly structurallyUnfixable: true;
      readonly reason: string;
    }
  | { readonly kind: "environmental"; readonly reason: string };

/** The subset of a verify pass the ladder consumes (mirrors PanelRunResult). */
export interface VerifyPassResult {
  /** Confirmed blockers (post citation-verify + independent confirmation). */
  readonly confirmedBlockers: readonly Finding[];
  /** LOUD unresolved verifier error — never auto-ship. */
  readonly hadVerifierError: boolean;
  /**
   * A structural (non-capability) floor failure (Δ D). When present, the ladder
   * classifies it and drops immediately WITHOUT burning a rung — re-executing a
   * structurally-unfixable gate or an environmental blocker only wastes retries.
   * Absent on a normal pass (the blockers/error fields carry the result).
   */
  readonly structuralFailure?: VerifyStructuralFailure;
}

/** The task payload the ladder needs (holdout-stripped already). */
export interface LadderTask {
  readonly taskId: string;
  readonly title: string;
  readonly description: string;
  /** Holdout-STRIPPED criteria (WS9 strips; WS8 never reads the key). */
  readonly visibleCriteria: readonly string[];
  readonly files: readonly string[];
  /** The spec-time risk tier — the producer dial input (Decision 25). */
  readonly riskTier: RiskTier;
}

/** Dependencies the ladder is driven against. */
export interface LadderDeps {
  /** The injected producer-agent runner (fakeable). */
  readonly producer: ProducerAgentRunner;
  /** The injected verify pass (the WS7 runPanel, fakeable). */
  readonly verify: VerifyPass;
  /** The resolved config (the dial reads quota.producerModels). */
  readonly config: Config;
  /** Max producer agent turns (defaults to config.testWriter.maxTurns). */
  readonly maxTurns?: number;
  /** The per-task stage the ladder advances to on success (the verify stage). */
  readonly stage: TaskStage;
  /**
   * INNER fix-forward patch budget (defaults to {@link FIX_FORWARD_PATCH_BUDGET}):
   * how many in-rung executor PATCH passes are allowed before the OUTER ladder
   * nukes + escalates the model. 0 ⇒ nuke immediately on any miss.
   */
  readonly patchBudget?: number;
}

/**
 * Assert this rung's spawn CHANGED A VARIABLE versus the previous rung (Decision
 * 25 — "each rung changes a variable, never a blind re-roll"). The changed
 * variable is the MODEL or the injected CONTEXT (or both). A rung whose model
 * equals the previous AND whose context did not gain a prior-failure injection is
 * a blind re-roll — a LOUD programming error.
 *
 * Rung 1 changes the context (a fresh agent slate is the change; we treat rung 1
 * as a legitimate same-model fresh-context rung — the new spawn IS the change).
 * Rung ≥ 2 must escalate the model OR inject prior-failure context.
 */
export function assertRungChange(prev: DialResult | undefined, cur: DialResult): void {
  if (prev === undefined) return; // rung 0 has no predecessor.
  const modelChanged = cur.model !== prev.model;
  const contextChanged = cur.injectsPriorFailure && !prev.injectsPriorFailure;
  // Rung 1 (same model, no prior-failure yet) is a fresh-context re-attempt — the
  // spawn itself is the change. Only flag a TRUE re-roll: same model AND no new
  // context change AND not the first retry.
  const isFreshContextRung = cur.rung === 1 && !prev.injectsPriorFailure;
  if (!modelChanged && !contextChanged && !isFreshContextRung) {
    throw new Error(
      `ladder rung ${cur.rung} did not change a variable vs rung ${prev.rung} ` +
        `(model '${cur.model}' unchanged, no prior-failure context injected) — a blind re-roll is forbidden (D25)`,
    );
  }
}

/** Build the producer context for a rung, folding in any patch blockers + prior failures. */
function contextForRung(
  task: LadderTask,
  rung: number,
  dial: DialResult,
  confirmedBlockers: readonly Finding[],
  priorFailures: readonly PriorFailureNote[],
): ProducerContext {
  return buildProducerContext({
    taskId: task.taskId,
    title: task.title,
    description: task.description,
    visibleCriteria: task.visibleCriteria,
    files: task.files,
    rung,
    confirmedBlockers,
    // Only inject prior failures when the dial says this rung does so (rung ≥ 2).
    priorFailures: dial.injectsPriorFailure ? priorFailures : [],
  });
}

/**
 * What to do with a producer spawn's terminal outcome (Δ D classify-before-retry):
 *   - `proceed`  — `done`: run/continue the verify floor.
 *   - `drop`     — an IMMEDIATE classified drop (e.g. `blocked-escalate` ⇒
 *     spec-defect); carries the terminal {@link StageResult}.
 *   - `escalate` — a capability failure (`needs-context`/`error`): nuke + bump a
 *     rung; carries the reason for the prior-failure note.
 */
type ProducerAction =
  | { readonly kind: "proceed" }
  | { readonly kind: "drop"; readonly result: StageResult }
  | { readonly kind: "escalate"; readonly reason: string };

/** Classify a producer spawn outcome into a ladder action (Δ D). */
function handleProducerOutcome(outcome: ProducerOutcome): ProducerAction {
  if (outcome.status === "done") return { kind: "proceed" };
  const decision = classifyFailure({
    kind: "producer-status",
    status: outcome.status,
    reason: outcome.reason,
  });
  if (decision.action === "drop") {
    return { kind: "drop", result: taskDropped(decision.failureClass, decision.reason) };
  }
  return { kind: "escalate", reason: decision.reason };
}

/**
 * Run the producer escalation ladder for one task (Decision 22/25/27, Δ D).
 *
 * TWO nested loops:
 *
 * OUTER — the bounded NUKE-AND-RETRY (rungs 0..CAP). Each rung is a fresh start
 * that CHANGES A VARIABLE (rung 1 = same model + fresh context; rung 2 = escalated
 * model + injected prior-failure context); {@link assertRungChange} throws on a
 * blind re-roll. CAP exhausted ⇒ `taskDropped("capability-budget", …)`.
 *
 * INNER — the FIX-FORWARD patch loop (Decision 27, bounded by `patchBudget`).
 * After a `done` spawn, the verify floor runs; on confirmed misses the producer
 * is re-spawned to PATCH the SPECIFIC remaining blockers (fix instructions folded
 * in via prompt-context) — NOT nuked — re-verifying each pass. The inner loop ends
 * (and the OUTER ladder nukes + escalates) only when the patch budget is spent or
 * a pass makes no progress.
 *
 * CLASSIFY-BEFORE-RETRY (Δ D) gates BOTH loops: a producer `blocked-escalate`, a
 * structurally-unfixable gate, or an environmental blocker routes STRAIGHT to a
 * classified loud drop WITHOUT burning a rung. Only a capability failure (a
 * fixable miss, a verifier error, a `needs-context`/`error` producer) re-executes.
 *
 * EVERY terminal path is LOUD + classified — success is `advance(...)`, every
 * failure is `taskDropped(...)`; there is no silent return/advance.
 *
 * The one-shot producer REBUTTAL (D27) is a per-pass driver call kept out of the
 * cap accounting; it is driven through {@link runFixForward} (with an adjudicator +
 * ledger) by the WS10 driver, not re-implemented here.
 */
export async function runLadder(task: LadderTask, deps: LadderDeps): Promise<StageResult> {
  const maxTurns = deps.maxTurns ?? deps.config.testWriter.maxTurns;
  const patchBudget = Math.max(0, deps.patchBudget ?? FIX_FORWARD_PATCH_BUDGET);
  const priorFailures: PriorFailureNote[] = [];
  let prevDial: DialResult | undefined;
  let lastReason = "no producer attempt was made";

  for (let rung = 0; rung <= ESCALATION_CAP; rung++) {
    const dial = dialForRung(task.riskTier, rung, deps.config);
    // CHANGE-A-VARIABLE invariant: a blind re-roll throws (D25).
    assertRungChange(prevDial, dial);
    prevDial = dial;

    // (1) FRESH attempt for this rung (the nuke): executor on the dialed model, no
    // fix instructions; prior-failure context injected on rung ≥ 2 (the change).
    const fresh = await deps.producer.run({
      role: "executor",
      model: dial.model,
      maxTurns,
      context: contextForRung(task, rung, dial, [], priorFailures) as unknown as Record<
        string,
        unknown
      >,
    });
    const freshAction = handleProducerOutcome(fresh);
    if (freshAction.kind === "drop") return freshAction.result;
    if (freshAction.kind === "escalate") {
      lastReason = freshAction.reason;
      priorFailures.push({ rung, summary: `producer ${fresh.status}: ${freshAction.reason}` });
      continue; // OUTER: nuke + escalate the model.
    }

    // (2) INNER FIX-FORWARD loop (D27): patch the confirmed misses in-rung, bounded
    // by patchBudget + progress. Every non-return exit escalates the OUTER rung.
    let prevRemaining = Number.POSITIVE_INFINITY;
    for (let patch = 0; patch <= patchBudget; patch++) {
      const verifyResult = await deps.verify();

      // (2a) CLASSIFY-BEFORE-RETRY (Δ D): a STRUCTURAL floor failure — a
      // structurally-unfixable gate or an environmental blocker — drops
      // immediately and does NOT burn a rung.
      if (verifyResult.structuralFailure !== undefined) {
        const decision = classifyFailure(verifyResult.structuralFailure);
        if (decision.action === "drop") {
          return taskDropped(decision.failureClass, decision.reason);
        }
        // Structural signals always classify as a drop; a retry would be a
        // classify bug. Fall through to fix-forward rather than silently loop.
      }

      const fix = await runFixForward({
        confirmedBlockers: verifyResult.confirmedBlockers,
        hadVerifierError: verifyResult.hadVerifierError,
      } satisfies FixForwardInput);

      if (
        fix.status === "clear" ||
        (fix.status === "rebutted-overturned" && fix.remaining.length === 0)
      ) {
        // Floor passed — SUCCESS. Advance to the next per-task stage.
        return advance(nextOrSelf(deps.stage));
      }

      if (fix.status === "verifier-error") {
        // LOUD + unresolved → escalate the OUTER rung (a fresh verify pass). It is
        // a retryable capability failure, never a silent advance.
        lastReason = classifyFailure({
          kind: "verifier-error",
          reason: "panel verifier error (unresolved)",
        }).reason;
        priorFailures.push({ rung, summary: lastReason });
        break; // → OUTER escalate.
      }

      // fix.status is `patch-required` | `rebutted-overturned` (remaining > 0):
      // PATCH FORWARD in-rung, provided we have budget AND are making progress.
      const remaining = fix.remaining;
      const madeProgress = remaining.length < prevRemaining;
      if (patch >= patchBudget || !madeProgress) {
        lastReason =
          `floor blocked by ${remaining.length} confirmed blocker(s)` +
          (patch > 0 ? ` after ${patch} in-rung patch(es)` : "");
        priorFailures.push({ rung, summary: lastReason });
        break; // inner budget/progress spent → OUTER nuke + escalate.
      }
      prevRemaining = remaining.length;

      // Re-spawn the executor to PATCH the SPECIFIC remaining confirmed blockers
      // (fix-forward, NOT nuke): same rung/model, fix instructions folded in.
      const patchOutcome = await deps.producer.run({
        role: "executor",
        model: dial.model,
        maxTurns,
        context: contextForRung(task, rung, dial, remaining, priorFailures) as unknown as Record<
          string,
          unknown
        >,
      });
      const patchAction = handleProducerOutcome(patchOutcome);
      if (patchAction.kind === "drop") return patchAction.result;
      if (patchAction.kind === "escalate") {
        lastReason = patchAction.reason;
        priorFailures.push({
          rung,
          summary: `producer ${patchOutcome.status}: ${patchAction.reason}`,
        });
        break; // → OUTER escalate.
      }
      // patchAction.kind === "proceed" → loop: re-verify the patched output.
    }
    // Every inner-loop exit that did not return is an escalation → next rung.
  }

  // CAP exhausted with the floor still blocked → LOUD + classified drop.
  return taskDropped(
    "capability-budget",
    `producer escalation ladder exhausted after ${ESCALATION_CAP} retries: ${lastReason}`,
  );
}

/** The stage to advance to on success (mirror the WS7 verify→ship edge). */
function nextOrSelf(stage: TaskStage): TaskStage {
  return stage === "verify" ? "ship" : stage;
}
