import {describe, it, expect} from 'vitest'

import {tildeShorten} from './paths.js'

describe('tildeShorten', () => {
    it('shortens a path under $HOME to the ~ form', () => {
        expect(tildeShorten('/Users/jo/.claude/plugins/data/factory-x', '/Users/jo')).toBe(
            '~/.claude/plugins/data/factory-x'
        )
    })

    it('returns $HOME itself as bare ~', () => {
        expect(tildeShorten('/Users/jo', '/Users/jo')).toBe('~')
    })

    it('leaves a path OUTSIDE $HOME absolute (no tilde)', () => {
        expect(tildeShorten('/var/lib/factory-x', '/Users/jo')).toBe('/var/lib/factory-x')
    })

    it("does not shorten when home is empty (avoids a bare '~' for every abs path)", () => {
        expect(tildeShorten('/var/lib/factory-x', '')).toBe('/var/lib/factory-x')
    })

    it('matches on a path-component boundary, not a sibling sharing the home string', () => {
        // "/Users/job" must NOT be treated as living under "/Users/jo".
        expect(tildeShorten('/Users/job/data', '/Users/jo')).toBe('/Users/job/data')
    })

    it('tolerates a trailing slash on home', () => {
        expect(tildeShorten('/Users/jo/x', '/Users/jo/')).toBe('~/x')
    })
})
