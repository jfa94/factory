import {describe, it, expect} from 'vitest'
import {nowIso, nowEpoch, parseIso8601ToEpoch, epochToIso} from './time.js'

describe('time helpers', () => {
    it('nowIso is a Z-suffixed ISO-8601 string', () => {
        expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+|)Z$/)
    })

    it('parseIso8601ToEpoch returns epoch SECONDS', () => {
        // 2021-01-01T00:00:00Z == 1609459200 epoch seconds.
        expect(parseIso8601ToEpoch('2021-01-01T00:00:00Z')).toBe(1609459200)
    })

    it('epochToIso round-trips with parseIso8601ToEpoch', () => {
        const epoch = 1609459200
        expect(parseIso8601ToEpoch(epochToIso(epoch))).toBe(epoch)
    })

    it('nowEpoch is within a second of Date.now/1000', () => {
        const a = nowEpoch()
        const b = Math.floor(Date.now() / 1000)
        expect(Math.abs(a - b)).toBeLessThanOrEqual(1)
    })

    it('throws loudly on an unparseable timestamp', () => {
        expect(() => parseIso8601ToEpoch('not-a-date')).toThrow(/unparseable/)
    })
})
