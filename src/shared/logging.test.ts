import {afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest'
import {createLogger} from './logging.js'

describe('createLogger — env-driven threshold + stderr-only sink', () => {
    let stderrSpy: MockInstance
    let stdoutSpy: MockInstance
    const savedLevel = process.env.FACTORY_LOG_LEVEL
    const savedQuiet = process.env.FACTORY_QUIET

    beforeEach(() => {
        delete process.env.FACTORY_LOG_LEVEL
        delete process.env.FACTORY_QUIET
        stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
        stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    })

    afterEach(() => {
        vi.restoreAllMocks()
        if (savedLevel === undefined) {
            delete process.env.FACTORY_LOG_LEVEL
        } else {
            process.env.FACTORY_LOG_LEVEL = savedLevel
        }
        if (savedQuiet === undefined) {
            delete process.env.FACTORY_QUIET
        } else {
            process.env.FACTORY_QUIET = savedQuiet
        }
    })

    function written(): string {
        return stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    }

    it('default threshold: info/warn/error emit, debug does not', () => {
        const log = createLogger('t')
        log.debug('d')
        log.info('i')
        log.warn('w')
        log.error('e')
        const out = written()
        expect(out).not.toContain('[DEBUG]')
        expect(out).toContain('[INFO] t: i')
        expect(out).toContain('[WARN] t: w')
        expect(out).toContain('[ERROR] t: e')
    })

    it('FACTORY_QUIET=1: only errors get through', () => {
        process.env.FACTORY_QUIET = '1'
        const log = createLogger('t')
        log.info('i')
        log.warn('w')
        log.error('e')
        const out = written()
        expect(out).not.toContain('[INFO]')
        expect(out).not.toContain('[WARN]')
        expect(out).toContain('[ERROR] t: e')
    })

    it('FACTORY_LOG_LEVEL=silent: nothing emits, not even errors', () => {
        process.env.FACTORY_LOG_LEVEL = 'silent'
        const log = createLogger('t')
        log.debug('d')
        log.info('i')
        log.warn('w')
        log.error('e')
        expect(written()).toBe('')
    })

    it('FACTORY_LOG_LEVEL beats FACTORY_QUIET, and an unknown level falls back to info', () => {
        process.env.FACTORY_LOG_LEVEL = 'debug'
        process.env.FACTORY_QUIET = '1'
        const log = createLogger('t')
        log.debug('d')
        expect(written()).toContain('[DEBUG] t: d')

        stderrSpy.mockClear()
        delete process.env.FACTORY_QUIET
        process.env.FACTORY_LOG_LEVEL = 'bogus'
        log.debug('d2')
        log.info('i2')
        const out = written()
        expect(out).not.toContain('[DEBUG]')
        expect(out).toContain('[INFO] t: i2')
    })

    it('everything goes to stderr, never stdout', () => {
        const log = createLogger('t')
        log.info('i')
        log.error('e')
        expect(stderrSpy.mock.calls.length).toBeGreaterThan(0)
        expect(stdoutSpy).not.toHaveBeenCalled()
    })

    it("child('x') prefixes the scope", () => {
        const log = createLogger('parent').child('x')
        log.info('m')
        expect(written()).toContain('[INFO] parent:x: m')
    })
})
