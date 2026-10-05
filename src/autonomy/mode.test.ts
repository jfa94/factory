import {describe, expect, it} from 'vitest'

import {isAutonomous} from './mode.js'

describe('isAutonomous', () => {
    it("is true only when FACTORY_AUTONOMOUS_MODE is exactly '1'", () => {
        expect(isAutonomous({FACTORY_AUTONOMOUS_MODE: '1'})).toBe(true)
    })

    it('is false when the var is unset', () => {
        expect(isAutonomous({})).toBe(false)
    })

    it('is false for any other truthy-looking value (no bypass)', () => {
        expect(isAutonomous({FACTORY_AUTONOMOUS_MODE: 'true'})).toBe(false)
        expect(isAutonomous({FACTORY_AUTONOMOUS_MODE: '0'})).toBe(false)
        expect(isAutonomous({FACTORY_AUTONOMOUS_MODE: ''})).toBe(false)
        expect(isAutonomous({FACTORY_AUTONOMOUS_MODE: ' 1'})).toBe(false)
    })
})
