/**
 * Agent and skill markdown is executable policy: it must describe the v2 result envelope
 * (`ResultSchema`/`ClaimSchema` in ./schema.ts and the engine prompt) and nothing from the
 * retired v1 contracts. Canary #4 observation 3: agents emitted non-conforming JSON because
 * markdown carried contradictory legacy contracts alongside the v2 one.
 */
import {readFileSync} from 'node:fs'
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

    it('every surface names the v2 envelope identity fields', () => {
        // Panel reviewers inherit the envelope from the injected review-protocol skill.
        const owners = [
            'skills/review-protocol/SKILL.md',
            'agents/finding-verifier.md',
            'agents/implementer.md',
            'agents/test-writer.md',
            'agents/scribe.md',
            'agents/e2e-author.md',
            'agents/spec-reviewer.md',
        ]
        for (const rel of owners) {
            const text = read(rel)
            expect(text, rel).toContain('attempt_id')
            expect(text, rel).toContain('spec_digest')
            expect(text, rel).toContain('head_sha')
        }
    })

    it('review-protocol defines the reviews rows, the pattern-coverage rule and whole-review rejection', () => {
        const skill = read('skills/review-protocol/SKILL.md').replace(/\s+/g, ' ')
        expect(skill).toContain('"reviews": [')
        expect(skill).toContain('reviews:[')
        expect(skill).toContain('"severity": "important | critical"')
        expect(skill).toContain(PATTERN_SENTENCE)
        expect(skill).toContain('rejects the WHOLE review')
        expect(skill).toContain('prior_reviews')
        expect(skill).toContain('RawReview')
        expect(skill).toContain('git -C <taskWorktree> diff <baseRef>..HEAD')
    })

    it('finding-verifier returns confirmations for a batch and blocks instead of emitting nothing', () => {
        const text = read('agents/finding-verifier.md')
        expect(text).toContain('confirmations')
        expect(text).toContain('"confirmed": false')
        expect(text).toContain('CONFIRM_BATCH')
        expect(text).toContain('up to two')
        expect(text).toContain('`status: "blocked"`')
    })

    it('producers document already-satisfied and the real final HEAD', () => {
        for (const rel of ['agents/implementer.md', 'agents/test-writer.md']) {
            const text = read(rel)
            expect(text, rel).toContain('already-satisfied')
            expect(text, rel).toContain('git rev-parse HEAD')
            expect(text, rel).toContain('needs-context')
            expect(text, rel).toContain('spec-defect')
        }
        expect(read('agents/test-writer.md')).toContain('tests-only commit')
        expect(read('agents/implementer.md')).toContain('task checkpoint')
    })

    it('every panel reviewer names its RawReview row inside the envelope', () => {
        for (const role of [
            'quality-reviewer',
            'implementation-reviewer',
            'silent-failure-hunter',
            'systemic-failure-reviewer',
            'database-design-reviewer',
        ]) {
            const text = read(`agents/${role}.md`)
            expect(text, role).toContain(`"reviewer": "${role}"`)
            expect(text, role).toContain('claims')
        }
    })

    it('spec-reviewer distinguishes the engine spec-review attempt from generation review', () => {
        const text = read('agents/spec-reviewer.md')
        expect(text).toContain('Output contract — spec-review attempt')
        expect(text).toContain('feasible and preserves the requirements')
        expect(text).toContain('ReviewVerdict')
    })
})
