/**
 * `src/ci` — CI workflow templating. Public seam: render the configured
 * `quality.gateEnv` into the managed quality-gate workflow (scaffold).
 */
export {injectGateEnvIntoWorkflow} from './inject-gate-env.js'
