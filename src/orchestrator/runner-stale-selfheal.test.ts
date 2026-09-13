/** Runner instructions are executable policy; guard the v2 recovery contract. */
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..')
const skill = readFileSync(resolve(repoRoot, 'skills/pipeline-runner/SKILL.md'), 'utf8')

describe('v2 runner recovery protocol', () => {
    it('uses persisted attempt identities for dispatch and result submission', () => {
        expect(skill).toContain('save the attempt identity before dispatch')
        expect(skill).toContain('--driver <session> --results <file>')
    })
    it('never dispatches an outstanding attempt twice', () => {
        expect(skill).toContain('never dispatch it twice')
        expect(skill).toContain('retry_after_seconds')
    })
    it('requires evidence that the previous worker stopped before recovery', () => {
        expect(skill).toContain('first establish that it has stopped')
        expect(skill).toContain('factory resume --run <id> --recover')
    })
    it('preserves interrupted work instead of resetting a task branch', () => {
        expect(skill).toContain('retires its lease while retaining')
        expect(skill).toContain('Do not reset')
        expect(skill).toContain('Do not create task branches')
    })
    it('rejects late results instead of reassigning their identity', () => {
        expect(skill).toContain('do not relabel it as a new attempt')
    })
    it('stops on a park even when quota recovers', () => {
        expect(skill).toContain('Explicit resume is')
        expect(skill).toContain('required, even if quota recovers')
    })
    it('reloads the persisted ledger and retains answers on resume', () => {
        expect(skill).toContain('factory state --run <id> --ledger')
        expect(skill).toContain('Answers remain in the ledger')
    })
})
