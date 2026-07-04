/**
 * `src/ci` — CI-config introspection. Public seam: detect the build-time env a
 * repo's CI workflow injects and gap-fill it into `quality.gateEnv` for verifier
 * floor parity. See {@link applyGateEnvDetection}.
 */
export {
    detectGateEnv,
    mergeDetectedGateEnv,
    applyGateEnvDetection,
    DefaultWorkflowSource,
    type WorkflowSource,
    type EnvScope,
    type DetectedVar,
    type DroppedKeyReason,
    type DetectResult,
    type GateEnvConflict,
    type GateEnvMerge,
    type DetectReport,
} from './detect-gate-env.js'
export {injectGateEnvIntoWorkflow} from './inject-gate-env.js'
