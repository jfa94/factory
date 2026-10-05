/** Test-only fixture: a minimal valid one-task v2 run (never imported by production code). */
import {readFile} from 'node:fs/promises'
import {digest, validateFeatureSpec, type FeatureAction, type FeatureRun} from './schema.js'

/** Read the brief a role's two-line execute prompt names (the first role when none is given). */
export async function readBrief(action: FeatureAction, role?: string): Promise<string> {
    if (action.kind !== 'execute') {
        throw new Error(`expected execute, got ${JSON.stringify(action)}`)
    }
    const prompt = role === undefined ? Object.values(action.prompts)[0] : action.prompts[role]
    const path = /Read your brief at (.+) and follow it;/.exec(prompt ?? '')?.[1]
    if (path === undefined) {
        throw new Error(`prompt names no brief: ${prompt}`)
    }
    return readFile(path, 'utf8')
}

export function featureRunFixture(overrides: Partial<FeatureRun> = {}): FeatureRun {
    const sha = 'a'.repeat(40)
    const spec = validateFeatureSpec({
        version: 2,
        revision: 1,
        base_sha: sha,
        contracts: {},
        prd: {issue_number: 1, title: 'Value', body: '- Return a value.', labels: [], body_truncated: false},
        spec_md: 'Return a value.',
        tasks: [
            {
                task_id: 'value',
                slice_id: 'slice',
                requirement_ids: ['R1'],
                title: 'Return value',
                description: 'Return the requested value.',
                files: ['value.ts'],
                acceptance_criteria: ['Return a value.'],
                tests_to_write: ['Assert the value.'],
                depends_on: [],
                risk_tier: 'low',
                risk_rationale: 'Local value',
            },
        ],
    })
    return {
        version: 2,
        run_id: 'run',
        repo: 'acme/widgets',
        root: '/repo',
        branch: 'factory/1-run',
        worktree: '/repo/.claude/worktrees/feature-run',
        base_branch: 'develop',
        remote: 'origin',
        ship_mode: 'no-ship',
        debug: false,
        e2e: false,
        ignore_quota: true,
        spec,
        spec_digest: digest(spec),
        status: 'running',
        stage: 'implement',
        task_index: 0,
        accepted_sha: sha,
        task_base_sha: sha,
        slice_base_sha: sha,
        attempts: {},
        checkpoints: [],
        answers: [],
        feedback: [],
        claims: [],
        confirmed_claims: [],
        candidate_satisfied: false,
        delivery: {},
        audit: [],
        ...overrides,
    }
}
