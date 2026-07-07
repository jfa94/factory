/**
 * WS8 — structured producer PROMPT CONTEXT assembly (port of bin/pipeline-build-prompt
 * intent). PURE data assembly — no I/O, no agent spawn, no holdout-store access.
 *
 * HOLDOUT INTEGRITY (Decision 5 / Δ Y): the producer context is built ONLY from
 * the acceptance criteria the implementer is allowed to see. The holdout answer-key
 * lives outside the worktree and is enforced unreadable by WS9 holdout
 * confinement (src/hooks/holdout-guard); this module additionally NEVER opens or
 * imports the holdout store, and {@link buildProducerContext} takes the
 * already-stripped `visibleCriteria` as input — there is no parameter, field, or
 * code path here through which a holdout criterion could enter the prompt. The
 * defence is layered: WS9 confines reads; WS8 simply never asks for the key.
 *
 * Each rung's context CHANGES A VARIABLE (Decision 25):
 *   - rung 0/1: the base task context (rung 1 is the SAME context re-issued with a
 *     fresh agent slate — the "fresh context" change is the new spawn itself).
 *   - rung 2:   the base context PLUS the prior-failure "don't do this" summary,
 *     so the escalated model is steered away from the previous failure.
 *
 * FIX-FORWARD: when re-running the implementer to PATCH (not nuke), the confirmed
 * blockers (PanelRunResult.confirmedBlockers) are recorded in as concrete fix
 * instructions, so the implementer patches the specific verified misses.
 */
import type {Finding} from '../verifier/judgment/index.js'

/**
 * Structural subset of a confirmed-blocker `Finding` this module actually reads
 * (reviewer/file/line/description) — narrower than the full judgment {@link Finding}
 * so BOTH a live `PanelRunResult.confirmedBlockers` (`Finding[]`, from a fresh
 * verify) and a persisted `TaskState.fix_findings` (the lean `FixFinding[]` D5
 * carries across a fix-forward re-spawn) satisfy it directly — no conversion step.
 */
export type ConfirmedBlocker = Pick<Finding, 'reviewer' | 'file' | 'line' | 'description'>

/** A single confirmed-blocker fix instruction for the implementer's patch pass. */
export interface FixInstruction {
    /** The reviewer that raised it (audit). */
    readonly reviewer: string
    /** The cited file (if localised). */
    readonly file?: string
    /** The cited 1-based line (if localised). */
    readonly line?: number
    /** The human-facing description of what to fix. */
    readonly description: string
}

/** A prior-failure note injected on rung ≥ 2 ("don't do this"). */
export interface PriorFailureNote {
    /** Which rung the failure occurred on. */
    readonly rung: number
    /** A short summary of WHAT failed (e.g. "merge gate blocked by: security"). */
    readonly summary: string
}

/** Inputs to assemble a producer prompt context. */
export interface BuildProducerContextInput {
    /** Stable task id. */
    readonly taskId: string
    /** Short task title. */
    readonly title: string
    /** Task description. */
    readonly description: string
    /**
     * The acceptance criteria the producer is ALLOWED to see — already
     * holdout-stripped by the caller (WS9 owns the strip; this module never reads
     * the holdout key). Must NOT contain any withheld criterion.
     */
    readonly visibleCriteria: readonly string[]
    /** Files the task is scoped to (from the spec). */
    readonly files: readonly string[]
    /** The escalation rung this context is for (0 = starting). */
    readonly rung: number
    /**
     * Confirmed blockers to record in as fix instructions for a PATCH (fix-forward)
     * pass. Empty on a fresh attempt. Only CONFIRMED blockers (post WS7
     * verify-then-fix) belong here — never raw reviewer findings.
     */
    readonly confirmedBlockers?: readonly ConfirmedBlocker[]
    /**
     * Prior-failure notes to inject (rung ≥ 2). Empty on rung 0/1. Their PRESENCE
     * is the rung-2 "changed variable" (the injected context).
     */
    readonly priorFailures?: readonly PriorFailureNote[]
}

/**
 * The assembled, redaction-safe producer prompt context. A flat structured
 * record the WS10 runner hands to the agent prompt. Deliberately holds NO holdout
 * field. `injectedPriorFailure` is true IFF prior-failure notes were recorded in —
 * the machine-checkable proof the rung-2 context changed.
 */
export interface ProducerContext {
    readonly taskId: string
    readonly title: string
    readonly description: string
    /** The holdout-stripped criteria (exactly the input `visibleCriteria`). */
    readonly acceptanceCriteria: readonly string[]
    readonly files: readonly string[]
    readonly rung: number
    /** Fix instructions for a patch pass (empty on a fresh attempt). */
    readonly fixInstructions: readonly FixInstruction[]
    /** Prior-failure "don't do this" notes (empty on rung 0/1). */
    readonly priorFailures: readonly PriorFailureNote[]
    /** True IFF ≥1 prior-failure note was injected — the rung-2 context change. */
    readonly injectedPriorFailure: boolean
}

/** Map a confirmed-blocker {@link Finding} to a concrete {@link FixInstruction}. */
function toFixInstruction(f: ConfirmedBlocker): FixInstruction {
    const base: FixInstruction = {reviewer: f.reviewer, description: f.description}
    if (f.file !== undefined && f.line !== undefined) {
        return {...base, file: f.file, line: f.line}
    }
    if (f.file !== undefined) {
        return {...base, file: f.file}
    }
    return base
}

/**
 * Assemble the producer prompt context. Pure. Strips nothing itself (the caller
 * supplies already-visible criteria) but GUARANTEES the holdout key never enters
 * — there is no parameter or path for it.
 */
export function buildProducerContext(input: BuildProducerContextInput): ProducerContext {
    const fixInstructions = (input.confirmedBlockers ?? []).map(toFixInstruction)
    const priorFailures = input.priorFailures ?? []
    return {
        taskId: input.taskId,
        title: input.title,
        description: input.description,
        acceptanceCriteria: input.visibleCriteria,
        files: input.files,
        rung: input.rung,
        fixInstructions,
        priorFailures,
        injectedPriorFailure: priorFailures.length > 0,
    }
}

/**
 * Render a {@link ProducerContext} to the final producer agent prompt string
 * (3b(i)): the engine composes this at spawn time so the runner spawns
 * `agents[0].prompt` VERBATIM instead of dereferencing a `prompt_ref` and
 * re-assembling it. Includes the cd-sentence the runner used to hand-append
 * (pinning the worktree + branch discipline into the envelope itself).
 */
export function renderProducerPrompt(ctx: ProducerContext, worktree: string): string {
    const lines: string[] = [
        `Task ${ctx.taskId}: ${ctx.title}`,
        '',
        ctx.description,
        '',
        'Acceptance criteria:',
        ...ctx.acceptanceCriteria.map((c) => `- ${c}`),
    ]
    if (ctx.files.length > 0) {
        lines.push('', 'Scoped files:', ...ctx.files.map((f) => `- ${f}`))
    }
    if (ctx.fixInstructions.length > 0) {
        lines.push('', 'Confirmed blockers to fix (patch forward, do not nuke prior work):')
        for (const fi of ctx.fixInstructions) {
            const loc =
                fi.file !== undefined ? (fi.line !== undefined ? ` (${fi.file}:${fi.line})` : ` (${fi.file})`) : ''
            lines.push(`- [${fi.reviewer}]${loc} ${fi.description}`)
        }
    }
    if (ctx.priorFailures.length > 0) {
        lines.push('', "Prior failures — don't repeat these:")
        for (const pf of ctx.priorFailures) {
            lines.push(`- rung ${pf.rung}: ${pf.summary}`)
        }
    }
    lines.push(
        '',
        `Your working tree is ${worktree} (already checked out on the task branch). cd there; make ALL commits there.`
    )
    return lines.join('\n')
}
