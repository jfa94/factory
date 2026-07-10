import {describe, it, expect} from 'vitest'
import {defaultConfig} from '../config/schema.js'
import {evaluate, type CircuitBreakerInput} from './circuit-breaker.js'

const CONFIG = defaultConfig() // maxConsecutiveFailures=3 (the FLOOR)

function input(over: Partial<CircuitBreakerInput> = {}): CircuitBreakerInput {
    return {cumulativeFailures: 0, totalTasks: 0, ...over}
}

describe('Circuit breaker — cumulative-failure trip', () => {
    it('does not trip below the cap', () => {
        expect(evaluate(input({cumulativeFailures: 2}), CONFIG)).toEqual({
            tripped: false,
        })
    })

    it('trips at the cap (>= maxConsecutiveFailures)', () => {
        const r = evaluate(input({cumulativeFailures: 3}), CONFIG)
        expect(r.tripped).toBe(true)
        if (r.tripped) {
            expect(r.reason).toMatch(/cumulative failures/)
        }
    })
})

describe('Circuit breaker — the arm discriminator (severity mapping for the caller)', () => {
    it('labels each trip with its arm: failures / fail-closed', () => {
        const failures = evaluate(input({cumulativeFailures: 3}), CONFIG)
        expect(failures).toMatchObject({tripped: true, arm: 'failures'})

        const failClosed = evaluate(input({cumulativeFailures: NaN}), CONFIG)
        expect(failClosed).toMatchObject({tripped: true, arm: 'fail-closed'})
    })
})

describe('Circuit breaker — proportional threshold (max of floor and ceil(0.15 × totalTasks))', () => {
    it('floor dominates at ≤20 tasks: ceil(0.15×20)=3, trips at 3 exactly as before', () => {
        expect(evaluate(input({cumulativeFailures: 2, totalTasks: 20}), CONFIG)).toEqual({
            tripped: false,
        })
        expect(evaluate(input({cumulativeFailures: 3, totalTasks: 20}), CONFIG).tripped).toBe(true)
    })

    it('30 tasks → threshold 5 (ceil(4.5)): 4 failures survive, 5 trips', () => {
        expect(evaluate(input({cumulativeFailures: 4, totalTasks: 30}), CONFIG)).toEqual({
            tripped: false,
        })
        const r = evaluate(input({cumulativeFailures: 5, totalTasks: 30}), CONFIG)
        expect(r).toMatchObject({tripped: true, arm: 'failures'})
    })

    it('40 tasks → threshold 6: 5 failures survive, 6 trips', () => {
        expect(evaluate(input({cumulativeFailures: 5, totalTasks: 40}), CONFIG)).toEqual({
            tripped: false,
        })
        expect(evaluate(input({cumulativeFailures: 6, totalTasks: 40}), CONFIG).tripped).toBe(true)
    })
})

describe('Circuit breaker — fail-closed on malformed inputs (treated as tripped)', () => {
    it('non-finite cumulativeFailures trips', () => {
        expect(evaluate(input({cumulativeFailures: NaN}), CONFIG).tripped).toBe(true)
        expect(evaluate(input({cumulativeFailures: Number.POSITIVE_INFINITY}), CONFIG).tripped).toBe(true)
    })

    it('negative cumulativeFailures trips', () => {
        expect(evaluate(input({cumulativeFailures: -1}), CONFIG).tripped).toBe(true)
    })

    it('malformed totalTasks trips with the fail-closed arm', () => {
        for (const totalTasks of [NaN, -1, Number.POSITIVE_INFINITY]) {
            expect(evaluate(input({totalTasks}), CONFIG)).toMatchObject({
                tripped: true,
                arm: 'fail-closed',
            })
        }
    })
})
