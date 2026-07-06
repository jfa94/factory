import {describe, expect, it} from 'vitest'

import {SEGMENT_SPLIT_RE, basenameOf, unquote} from './token-helpers.js'

describe('SEGMENT_SPLIT_RE', () => {
    it('splits on shell separators and substitution openers', () => {
        expect('a && b || c; d | e'.split(SEGMENT_SPLIT_RE).map((s) => s.trim())).toEqual(['a', 'b', 'c', 'd', 'e'])
        expect('x $(y) `z`'.split(SEGMENT_SPLIT_RE).length).toBeGreaterThan(1)
    })
})

describe('unquote', () => {
    it('strips one layer of surrounding quotes', () => {
        expect(unquote('"a b"')).toBe('a b')
        expect(unquote("'a b'")).toBe('a b')
        expect(unquote(`"'x'"`)).toBe('x')
    })

    it('leaves bare and mismatched tokens alone', () => {
        expect(unquote('plain')).toBe('plain')
        expect(unquote('"open')).toBe('"open')
        expect(unquote('')).toBe('')
    })
})

describe('basenameOf', () => {
    it('returns the last /-separated component', () => {
        expect(basenameOf('/usr/bin/git')).toBe('git')
        expect(basenameOf('git')).toBe('git')
        expect(basenameOf('a/b/')).toBe('')
    })
})
