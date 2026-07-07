/**
 * Shared test fixtures for CLI + lifecycle tests (WS-D). Three builders, no module
 * state, a fresh temp dir per call. Moved/new test files use these; older files keep
 * their local helpers (opportunistic migration only — see the WS-D migration policy).
 *
 * Not imported by production code — the esbuild bundles never pull this in.
 */
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {StateManager} from '../core/state/manager.js'
import type {RunState} from '../types/index.js'

/** A fresh throwaway dir under the OS tmpdir. Callers own cleanup (`rm` in afterEach). */
export function makeTempDataDir(prefix = 'factory-test-'): Promise<string> {
    return mkdtemp(join(tmpdir(), prefix))
}

export interface SeedRunOpts {
    runId?: string
    repo?: string
    specId?: string
    issue?: number
    /** Applied over the freshly created run via `state.update` (status, tasks, quota, …). */
    patch?: (run: RunState) => RunState
}

/** Create a bare `running` run row (staging branch pinned as `staging-<runId>`). */
export async function seedRun(state: StateManager, opts: SeedRunOpts = {}): Promise<RunState> {
    const runId = opts.runId ?? 'run-1'
    const run = await state.create({
        run_id: runId,
        staging_branch: `staging-${runId}`,
        spec: {
            repo: opts.repo ?? 'acme/widgets',
            spec_id: opts.specId ?? '42-checkout',
            issue_number: opts.issue ?? 42,
        },
    })
    return opts.patch ? state.update(runId, opts.patch) : run
}

/** Minimal valid npm gate contract — the S7 `run create` precondition fixture. */
export const MINIMAL_GATES_JSON = JSON.stringify({
    version: 1,
    stack: 'npm',
    gates: {
        test: {contracted: true},
        tdd: {contracted: true},
        coverage: {contracted: false, reason: 'not wired yet'},
        mutation: {contracted: false, reason: 'waived via --waive mutation'},
        sast: {contracted: false, reason: 'no security command'},
        type: {contracted: true},
        lint: {contracted: false, reason: 'no eslint config'},
        build: {contracted: true},
    },
})

export interface SeedScaffoldRepoOpts {
    /** Write `.factory/gates.json` (default true). Pass a string to override the content. */
    gates?: boolean | string
    /** Write the two static `--e2e` prerequisites (package.json with @playwright/test + playwright.config.ts). */
    playwright?: boolean
}

/** Seed a directory with the scaffold artifacts the run-create preconditions probe for. */
export async function seedScaffoldRepo(dir: string, opts: SeedScaffoldRepoOpts = {}): Promise<void> {
    const gates = opts.gates ?? true
    if (gates !== false) {
        await mkdir(join(dir, '.factory'), {recursive: true})
        await writeFile(join(dir, '.factory', 'gates.json'), typeof gates === 'string' ? gates : MINIMAL_GATES_JSON)
    }
    if (opts.playwright === true) {
        await writeFile(
            join(dir, 'package.json'),
            JSON.stringify({name: 't', devDependencies: {'@playwright/test': '^1.0.0'}})
        )
        // testDir must be the TCB-covered literal — the S4 preflight refuses anything else.
        await writeFile(join(dir, 'playwright.config.ts'), "export default {testDir: './e2e'};\n")
    }
}
