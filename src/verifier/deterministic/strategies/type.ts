/**
 * WS6 — type-check gate strategy. `tsc --noEmit`; observed = exit 0.
 */
import type {GateStrategy} from '../strategy.js'
import type {GateTools} from '../tools.js'
import {procStrategy} from './proc-strategy.js'

export const typeStrategy: GateStrategy<GateTools> = procStrategy('type', 'tsc --noEmit', (tools, opts) =>
    tools.tsc.typecheck(opts)
)
