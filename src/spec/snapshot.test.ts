import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {describe, expect, it} from 'vitest'
import {execOrThrow} from '../shared/exec.js'
import {defaultConfig} from '../config/schema.js'
import {repositorySnapshot} from './snapshot.js'

describe('committed repository contract snapshot', () => {
    it('reads the current remote base contracts and ignores working-tree changes', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'feature-snapshot-'))
        const root = join(dir, 'repo'),
            remote = join(dir, 'remote.git')
        const git = async (...args: string[]) => (await execOrThrow('git', args, {cwd: root})).stdout.trim()
        try {
            await mkdir(root)
            await git('init', '-b', 'develop')
            await git('init', '--bare', remote)
            await git('config', 'user.name', 'Fixture')
            await git('config', 'user.email', 'fixture@example.invalid')
            await git('config', 'commit.gpgsign', 'false')
            await git('remote', 'add', 'origin', remote)
            await mkdir(join(root, 'docs', 'contracts'), {recursive: true})
            await writeFile(join(root, 'AGENTS.md'), 'Committed instructions\n')
            await writeFile(join(root, 'docs/contracts/value.md'), 'Value contract\n')
            await writeFile(join(root, 'unrelated.txt'), 'Not a contract\n')
            await git('add', '.')
            await git('commit', '-m', 'baseline contracts')
            await git('push', '-u', 'origin', 'develop')
            const base = await git('rev-parse', 'HEAD')
            await writeFile(join(root, 'AGENTS.md'), 'Uncommitted changed instructions\n')
            expect(await repositorySnapshot(root, defaultConfig())).toEqual({
                base_sha: base,
                contracts: {'AGENTS.md': 'Committed instructions', 'docs/contracts/value.md': 'Value contract'},
            })
        } finally {
            await rm(dir, {recursive: true})
        }
    }, 30_000)
})
