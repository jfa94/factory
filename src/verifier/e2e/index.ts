/**
 * `src/verifier/e2e` — the e2e runner seam (Decision 39). The ONE addressable
 * import surface for the run-level e2e coroutine (src/orchestrator/e2e.ts) and any
 * future debug consumer. Deep-importing `src/verifier/e2e/runner.ts` is a smell;
 * import here.
 */
export {
    runE2e,
    parseE2eReport,
    resolveLocalPlaywrightBin,
    DefaultPlaywrightTool,
    type E2eRunOpts,
    type E2eSpecStatus,
    type E2eSpecResult,
    type E2eResults,
    type E2eProcResult,
    type PlaywrightTool,
    type LocalPlaywrightResolver,
} from './runner.js'
