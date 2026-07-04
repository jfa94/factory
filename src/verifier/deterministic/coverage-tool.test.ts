import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {exec} from '../../shared/index.js'
import {DefaultCoverageTool, type CoverageCommand} from './tools.js'

/** A `node -e` argv command that writes a valid summary with the given line pct. */
function writeSummaryCmd(linesPct: number): CoverageCommand {
    const script =
        `const fs=require('fs');fs.mkdirSync('coverage',{recursive:true});` +
        `fs.writeFileSync('coverage/coverage-summary.json',JSON.stringify({total:{` +
        `lines:{pct:${linesPct}},branches:{pct:80},functions:{pct:70},statements:{pct:85}}}))`
    return {kind: 'argv', argv: ['node', '-e', script]}
}

function nodeCmd(script: string): CoverageCommand {
    return {kind: 'argv', argv: ['node', '-e', script]}
}

describe('DefaultCoverageTool.measure', () => {
    let cwd: string
    const tool = new DefaultCoverageTool()

    beforeEach(async () => {
        cwd = await mkdtemp(path.join(tmpdir(), 'cov-tool-'))
    })

    afterEach(async () => {
        await rm(cwd, {recursive: true, force: true})
    })

    it('parses the summary the command wrote (happy path)', async () => {
        const result = await tool.measure(writeSummaryCmd(90), {cwd})
        expect(result).toEqual({
            kind: 'measured',
            summary: {lines: 90, branches: 80, functions: 70, statements: 85},
        })
    })

    it('maps a non-zero exit to command-failed carrying the streams', async () => {
        const result = await tool.measure(nodeCmd(`process.stderr.write('boom');process.exit(1)`), {
            cwd,
        })
        expect(result.kind).toBe('command-failed')
        if (result.kind === 'command-failed') {
            expect(result.proc.code).toBe(1)
            expect(result.proc.stderr).toContain('boom')
        }
    })

    it('reports summary-missing when the command succeeds without writing one', async () => {
        const result = await tool.measure(nodeCmd(''), {cwd})
        expect(result).toEqual({kind: 'summary-missing'})
    })

    it('reports summary-invalid on corrupt JSON', async () => {
        const script =
            `const fs=require('fs');fs.mkdirSync('coverage',{recursive:true});` +
            `fs.writeFileSync('coverage/coverage-summary.json','{{')`
        expect(await tool.measure(nodeCmd(script), {cwd})).toEqual({kind: 'summary-invalid'})
    })

    it('reports summary-invalid when a metric is missing', async () => {
        const script =
            `const fs=require('fs');fs.mkdirSync('coverage',{recursive:true});` +
            `fs.writeFileSync('coverage/coverage-summary.json',JSON.stringify({total:{lines:{pct:1}}}))`
        expect(await tool.measure(nodeCmd(script), {cwd})).toEqual({kind: 'summary-invalid'})
    })

    it('deletes a stale summary first — never judges from a prior measurement', async () => {
        await mkdir(path.join(cwd, 'coverage'), {recursive: true})
        await writeFile(
            path.join(cwd, 'coverage', 'coverage-summary.json'),
            JSON.stringify({
                total: {
                    lines: {pct: 1},
                    branches: {pct: 1},
                    functions: {pct: 1},
                    statements: {pct: 1},
                },
            }),
            'utf8'
        )
        const result = await tool.measure(nodeCmd(''), {cwd})
        expect(result).toEqual({kind: 'summary-missing'})
    })

    it('fails closed (127) on the vitest kind when no local bin resolves', async () => {
        const noBin = new DefaultCoverageTool(() => Promise.resolve(null))
        const result = await noBin.measure({kind: 'vitest', args: ['run']}, {cwd})
        expect(result.kind).toBe('command-failed')
        if (result.kind === 'command-failed') {
            expect(result.proc.code).toBe(127)
            expect(result.proc.stderr).toContain('vitest')
        }
    })

    it('throws on an empty argv command', async () => {
        await expect(tool.measure({kind: 'argv', argv: []}, {cwd})).rejects.toThrow(/empty command/)
    })
})

describe('DefaultCoverageTool.measureAtBase (real git)', () => {
    let repo: string
    const tool = new DefaultCoverageTool()

    /** Summary-writing command whose lines pct reflects the checked-out marker.txt
     *  and whose functions pct proves the node_modules symlink resolved. */
    const markerCmd = nodeCmd(
        `const fs=require('fs');` +
            `const m=fs.readFileSync('marker.txt','utf8').trim();` +
            `const lines=m==='base'?50:90;` +
            `const fn=fs.existsSync('node_modules/probe.txt')?100:0;` +
            `fs.mkdirSync('coverage',{recursive:true});` +
            `fs.writeFileSync('coverage/coverage-summary.json',JSON.stringify({total:{` +
            `lines:{pct:lines},branches:{pct:80},functions:{pct:fn},statements:{pct:85}}}))`
    )

    async function git(...args: string[]): Promise<string> {
        const r = await exec('git', args, {cwd: repo})
        if (r.code !== 0) {
            throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
        }
        return r.stdout.trim()
    }

    beforeEach(async () => {
        repo = await mkdtemp(path.join(tmpdir(), 'cov-base-'))
        await git('init', '-q')
        await git('config', 'user.email', 't@t.t')
        await git('config', 'user.name', 't')
        await writeFile(path.join(repo, 'marker.txt'), 'base\n', 'utf8')
        await git('add', '.')
        await git('commit', '-q', '-m', 'base')
        await writeFile(path.join(repo, 'marker.txt'), 'head\n', 'utf8')
        await git('add', '.')
        await git('commit', '-q', '-m', 'head')
        // Untracked deps dir — must be reachable in the base checkout via the symlink.
        await mkdir(path.join(repo, 'node_modules'), {recursive: true})
        await writeFile(path.join(repo, 'node_modules', 'probe.txt'), 'x', 'utf8')
    })

    afterEach(async () => {
        await rm(repo, {recursive: true, force: true})
    })

    it("measures the BASE tree in a detached worktree with head's node_modules, then cleans up", async () => {
        const baseSha = await git('rev-parse', 'HEAD~1')
        const result = await tool.measureAtBase(baseSha, markerCmd, {cwd: repo})
        expect(result).toEqual({
            kind: 'measured',
            // lines=50 proves the checkout is the BASE commit; functions=100 proves
            // the task worktree's node_modules was symlinked in.
            summary: {lines: 50, branches: 80, functions: 100, statements: 85},
        })
        const worktrees = await git('worktree', 'list', '--porcelain')
        expect(worktrees.split('\n\n').filter((b) => b.trim().length > 0)).toHaveLength(1)
    })

    it('throws on an unresolvable base sha (plumbing failure) and still cleans up', async () => {
        await expect(tool.measureAtBase('0'.repeat(40), markerCmd, {cwd: repo})).rejects.toThrow(/worktree add/)
        const worktrees = await git('worktree', 'list', '--porcelain')
        expect(worktrees.split('\n\n').filter((b) => b.trim().length > 0)).toHaveLength(1)
    })

    it('maps a command failure inside the base checkout to command-failed (not a throw)', async () => {
        const baseSha = await git('rev-parse', 'HEAD~1')
        const result = await tool.measureAtBase(
            baseSha,
            nodeCmd(`process.stderr.write('base broke');process.exit(2)`),
            {cwd: repo}
        )
        expect(result.kind).toBe('command-failed')
        if (result.kind === 'command-failed') {
            expect(result.proc.code).toBe(2)
            expect(result.proc.stderr).toContain('base broke')
        }
    })
})
