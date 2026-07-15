/**
 * WS10 — the orchestrator's PUBLIC barrel.
 *
 * The Model-A orchestrator engine: the deterministic SEAM the CLI/runner drives —
 * the per-task orchestrator ({@link nextAction}), the run-level orchestrator ({@link nextTask}), the
 * record cores, the quota gate, and the finalize coordinator — plus the reporter
 * dependency-bundle types those callers wire against. `deps.ts` stays INTERNAL (it
 * is the orchestrator's own deep-import barrel); consumers import the frozen seams from
 * `src/types` and each domain barrel, and the orchestrator-specific shapes from here.
 */

// -- the run FINALIZE coordinator (rollup + report + issues; WS12) ------------
export {finalizeRun} from './finalize.js'
export type {FinalizeRunDeps, FinalizeRunResult} from './finalize.js'

// -- the shared deterministic transition logic (the orchestrators build on these) ------
export {failTask, applyProducerOutcome, type TransitionDeps, type TaskOutcome, type TaskStep} from './transitions.js'

// -- shared reporter helpers --------------------------------------------------
export {specTaskOf, shipBody} from './handlers.js'

// -- dependency-bundle types (the reporter deps the orchestrators + CLI wire) ----------
export type {ShipMode, HandlerDeps} from './types.js'

// -- docs applicability check ------------------------------------------------
export {isDocsApplicable} from './docs-applicable.js'

// -- design-system discovery for implementer UI prompts ---------------------
export {findDesignSystemDocs, isFrontendPath} from './design-system.js'

// -- record input reader (record cores themselves are consumed via deep './record.js' imports) --
export {readJsonInput} from './record.js'

// -- drive results schema (factory next-action --results input) --------------------
export {DriveResultsSchema, parseDriveResults, type DriveResults} from './results.js'

// -- quota gate (shared by both orchestrators) ----------------------------------------
export {applyQuotaGate, quotaStopFields, type QuotaGateDeps, type QuotaStop} from './quota-gate.js'

// -- per-task orchestrator (factory next-action seam) ----------------------------
export {
    nextAction,
    holdoutSidecar,
    MERGE_RESYNC_CAP,
    type OrchestratorDeps,
    type NextAction,
    type HoldoutSpawn,
    type DriveExpects,
} from './orchestrator.js'

// -- run-level orchestrator (factory next-task seam) --------------------------------------
export {nextTask, type NextTask} from './next.js'

// -- docs phase emit + record orchestrators (factory run docs seam) -----------------
export {
    runDocsEmit,
    runDocsRecord,
    docsWorktreePath,
    DocsResultsSchema,
    type DocsRunDeps,
    type DocsAction,
    type DocsResults,
} from './docs.js'

// -- traceability phase emit + record orchestrators (factory run traceability seam, S9/D47) --
export {
    runTraceabilityEmit,
    runTraceabilityRecord,
    traceWorktreePath,
    MAX_TRACE_ATTEMPTS,
    TraceabilityResultsSchema,
    type TraceabilityRunDeps,
    type TraceabilityAction,
    type TraceabilityResults,
} from './traceability.js'

// -- e2e phase emit + record orchestrators (factory run e2e seam, Decision 39) -----------------
export {
    runE2eEmit,
    runE2eRecord,
    CONTROL_TITLE_PREFIX,
    E2eResultsSchema,
    type E2eRunDeps,
    type E2eAction,
    type E2eAuthorResults,
} from './e2e.js'

// -- e2e assessment emit + record orchestrators (factory run e2e-assess seam, Decision 40) ------
export {
    runAssessmentEmit,
    runAssessmentRecord,
    assessmentWorktreePath,
    MAX_ASSESS_ATTEMPTS,
    AssessmentResultsSchema,
    type AssessmentRunDeps,
    type AssessmentAction,
    type AssessmentResults,
} from './assessment.js'
