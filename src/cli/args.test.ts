/** CLI arg helpers — unit tests. */
import {describe, it, expect} from 'vitest'

import {optionalString} from './args.js'

describe('optionalString', () => {
    it('returns a non-empty string flag unchanged', () => {
        expect(optionalString('owner/name')).toBe('owner/name')
    })

    it('treats an empty string as absent (→ undefined)', () => {
        expect(optionalString('')).toBeUndefined()
    })

    it('treats a bare boolean flag as absent (→ undefined)', () => {
        // `--repo` with no value parses to `true`; that is NOT a usable string.
        expect(optionalString(true)).toBeUndefined()
        expect(optionalString(false)).toBeUndefined()
    })

    it('treats a missing flag as absent (→ undefined)', () => {
        expect(optionalString(undefined)).toBeUndefined()
    })
})
