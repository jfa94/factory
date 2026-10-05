/**
 * Agent and skill markdown is executable policy: dispatched agents read a brief and return the
 * identity-free result (`AgentResultSchema` in ./schema.ts); nothing from retired contracts.
 * Canary #4 observation 3: contradictory legacy contracts produced non-conforming JSON.
 */
import {readFileSync, readdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..')
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), 'utf8')

const SURFACES = [
    'skills/review-protocol/SKILL.md',
    'skills/database-design-review/SKILL.md',
    'agents/finding-verifier.md',
    'agents/implementer.md',
    'agents/test-writer.md',
    'agents/scribe.md',
    'agents/e2e-author.md',
    'agents/quality-reviewer.md',
    'agents/implementation-reviewer.md',
    'agents/silent-failure-hunter.md',
    'agents/systemic-failure-reviewer.md',
    'agents/database-design-reviewer.md',
    'agents/spec-reviewer.md',
    'agents/acceptance-evaluator.md',
]

const DISPATCHED = [
    'test-writer',
    'implementer',
    'scribe',
    'e2e-author',
    'spec-generator',
    'spec-reviewer',
    'finding-verifier',
    'acceptance-evaluator',
    'quality-reviewer',
    'implementation-reviewer',
    'silent-failure-hunter',
    'systemic-failure-reviewer',
    'database-design-reviewer',
]

const BANNED = [
    'STATUS:',
    'attempt_id',
    'head_sha',
    'spec_digest',
    'manifest',
    '--results',
    'origin/staging',
    '3-file',
    'prior_reviews',
]

const LEGACY = [
    'STATUS:',
    '--results',
    'holdout',
    'task branch',
    'dropped_by_cap',
    '"holds"',
    'blocking: true',
    'blocking: false',
    'status: "approve"',
    'verdict: "approve"',
    'severity: warning',
    'severity: info',
    'severity: error',
    '"description"',
]

const PATTERN_SENTENCE =
    'When a finding is one instance of a pattern, file every instance in the reviewed range in the same round; within at most 10 claims per reviewer prefer full pattern coverage over weaker unrelated findings.'

describe('v2 agent result contract', () => {
    it.each(SURFACES)('%s carries no v1 contract vocabulary', (rel) => {
        const text = read(rel)
        for (const token of LEGACY) {
            expect(text, `${rel} still mentions ${token}`).not.toContain(token)
        }
    })

    it('every dispatchable role has an agent with a Factory dispatch section', () => {
        for (const role of DISPATCHED) {
            expect(read(`agents/${role}.md`), role).toContain('## Factory dispatch')
        }
    })

    it('dispatched agents and runner skills carry no identity or retired vocabulary', () => {
        const surfaces = [
            ...DISPATCHED.map((role) => `agents/${role}.md`),
            'skills/pipeline-runner/SKILL.md',
            'skills/review-protocol/SKILL.md',
        ]
        for (const rel of surfaces) {
            for (const token of BANNED) {
                expect(read(rel), `${rel} still mentions ${token}`).not.toContain(token)
            }
        }
    })

    it('no agent or skill carries the letter-versus-spirit slogan', () => {
        const files = readdirSync(resolve(repoRoot, 'agents'))
            .map((name) => `agents/${name}`)
            .concat(
                readdirSync(resolve(repoRoot, 'skills'), {recursive: true, encoding: 'utf8'})
                    .filter((name) => name.endsWith('.md'))
                    .map((name) => `skills/${name}`)
            )
        for (const rel of files) {
            const text = read(rel).toLowerCase()
            expect(text, rel).not.toContain('violates the spirit')
            expect(text, rel).not.toContain('violating the letter')
        }
    })

    it('review-protocol defines the claims result, the pattern-coverage rule and whole-review rejection', () => {
        const skill = read('skills/review-protocol/SKILL.md').replace(/\s+/g, ' ')
        expect(skill).toContain('"severity": "important | critical"')
        expect(skill).toContain(PATTERN_SENTENCE)
        expect(skill).toContain('rejects the WHOLE review')
        expect(skill).toContain('RawReview')
        expect(skill).toContain('Refuted claims')
    })

    it('finding-verifier returns confirmations for a batch and blocks instead of emitting nothing', () => {
        const text = read('agents/finding-verifier.md')
        expect(text).toContain('confirmations')
        expect(text).toContain('"confirmed": false')
        expect(text).toContain('CONFIRM_BATCH')
        expect(text).toContain('up to two')
        expect(text).toContain('`status: "blocked"`')
    })

    it('producers document already-satisfied and the escalation statuses', () => {
        for (const rel of ['agents/implementer.md', 'agents/test-writer.md']) {
            const text = read(rel)
            expect(text, rel).toContain('already-satisfied')
            expect(text, rel).toContain('needs-context')
            expect(text, rel).toContain('spec-defect')
        }
        expect(read('agents/test-writer.md')).toContain('tests-only commit')
        expect(read('agents/implementer.md')).toContain('task checkpoint')
    })

    it('test-writer may prove RED by importing a declared new module, never a stub (decision 2)', () => {
        const text = read('agents/test-writer.md')
        expect(text).toContain('not-yet-existing module the task declares: import it by relative path')
        expect(text).toContain('and never create a stub')
        expect(text).not.toContain('a stub commit parks the run')
    })

    it('implementer strengthens a cited test in a tagged test-only commit (decision 6)', () => {
        const text = read('agents/implementer.md')
        expect(text).toContain('When repair feedback cites a test file (marked "strengthen this test")')
        expect(text).toContain('test-only commit')
        expect(text).toContain('Never remove, skip or loosen an assertion')
    })

    it('e2e-author blocks a feature with no user-facing surface (C8)', () => {
        const text = read('agents/e2e-author.md')
        expect(text.replace(/\s+/g, ' ')).toContain(
            'return `blocked` with the message "--e2e requested but the feature has no user-facing surface; rerun without --e2e"'
        )
        expect(text).not.toContain('no-UI verdict')
    })

    it('every panel reviewer returns claims per the review-protocol skill', () => {
        for (const role of [
            'quality-reviewer',
            'implementation-reviewer',
            'silent-failure-hunter',
            'systemic-failure-reviewer',
            'database-design-reviewer',
        ]) {
            const text = read(`agents/${role}.md`)
            expect(text, role).toContain('claims')
            expect(text, role).toContain('review-protocol')
        }
    })

    it('spec-reviewer distinguishes the engine spec-review attempt from generation review', () => {
        const text = read('agents/spec-reviewer.md')
        expect(text).toContain('Output contract — spec-review attempt')
        expect(text).toContain('feasible and preserves the requirements')
        expect(text).toContain('ReviewVerdict')
    })
})
