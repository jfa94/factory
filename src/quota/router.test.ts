import {describe, it, expect} from 'vitest'
import {defaultConfig} from '../config/schema.js'
import {selectProducerModel} from './router.js'

const CONFIG = defaultConfig()

describe('D25/D26 router risk-invariance — selectProducerModel varies ONLY the producer dial', () => {
    it('each risk tier selects its configured producer model', () => {
        expect(selectProducerModel('low', CONFIG)).toBe(CONFIG.quota.producerModels.low)
        expect(selectProducerModel('medium', CONFIG)).toBe(CONFIG.quota.producerModels.medium)
        expect(selectProducerModel('high', CONFIG)).toBe(CONFIG.quota.producerModels.high)
    })

    it('keeps a real ceiling: high is a distinct, stronger default than low/medium', () => {
        // The default dial intentionally collapses low+medium onto sonnet (low defaults to
        // sonnet, not haiku — even low-risk work is code generation), while `high` stays a
        // distinct opus ceiling. Per-tier movement across all three is exercised by the
        // config-override tests in model-dial.test.ts.
        const defaults = new Set([
            selectProducerModel('low', CONFIG),
            selectProducerModel('medium', CONFIG),
            selectProducerModel('high', CONFIG),
        ])
        expect(defaults.size).toBe(2) // low===medium (sonnet); high (opus) distinct
        expect(selectProducerModel('high', CONFIG)).not.toBe(selectProducerModel('medium', CONFIG))
    })
})
