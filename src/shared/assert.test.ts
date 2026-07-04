import {describe, it, expect} from 'vitest'
import {nonNull, at, getOrThrow} from './assert.js'

describe('nonNull', () => {
    it('returns the value when present', () => {
        expect(nonNull(0)).toBe(0)
        expect(nonNull('')).toBe('')
        expect(nonNull(false)).toBe(false)
    })
    it('throws on null and undefined', () => {
        expect(() => {
            nonNull(null)
        }).toThrow(/unexpected nullish/)
        expect(() => {
            nonNull(undefined)
        }).toThrow(/unexpected nullish/)
    })
    it('uses the caller message', () => {
        expect(() => {
            nonNull(null, 'no widget')
        }).toThrow('no widget')
    })
})

describe('at', () => {
    it('returns the element at an in-range index', () => {
        expect(at(['a', 'b'], 1)).toBe('b')
    })
    it('throws with a located message when out of range', () => {
        expect(() => at(['a'], 3)).toThrow(/index 3 out of range \(length 1\)/)
    })
})

describe('getOrThrow', () => {
    it('returns the mapped value', () => {
        expect(getOrThrow(new Map([['k', 42]]), 'k')).toBe(42)
    })
    it('throws when the key is absent', () => {
        expect(() => getOrThrow(new Map<string, number>(), 'missing')).toThrow(/missing map key/)
    })
})
