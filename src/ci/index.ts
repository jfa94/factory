/**
 * `src/ci` — CI workflow templating. Public seam: render the managed quality-gate
 * workflow from a repo's gate contract (Decision 53) and inject the configured
 * `quality.gateEnv` into it (scaffold).
 */
export {injectGateEnvIntoWorkflow} from './inject-gate-env.js'
export {renderQualityGate, type RenderQualityGateOpts} from './render-quality-gate.js'
