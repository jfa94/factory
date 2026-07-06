import {describe, expect, it} from 'vitest'

import {isEnoent} from './fs-errors.js'

describe('isEnoent', () => {
    it('true for an ENOENT errno error', () => {
        const err = Object.assign(new Error('gone'), {code: 'ENOENT'})
        expect(isEnoent(err)).toBe(true)
    })

    it('false for other errno codes', () => {
        const err = Object.assign(new Error('denied'), {code: 'EACCES'})
        expect(isEnoent(err)).toBe(false)
    })

    it('false for plain errors and non-errors', () => {
        expect(isEnoent(new Error('no code'))).toBe(false)
        expect(isEnoent('ENOENT')).toBe(false)
        expect(isEnoent(null)).toBe(false)
        expect(isEnoent(undefined)).toBe(false)
    })
})
