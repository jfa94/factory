/**
 * WS9 — branch-protection adversarial tests (implemented body). Ports the bash
 * parse vectors; the exec seam (current-branch) is faked. Each destructive form
 * must block; the staging-in-orchestrator-worktree exception allows.
 */
import {describe, it, expect} from 'vitest'
import {decideBranchProtection, type BranchProtectionDeps} from './branch-protection.js'
import {parseHookInput, isDeny} from './hook-io.js'
import {captureStream} from '../cli/test-helpers.js'
import type {ExecResult} from '../shared/exec.js'

function bashInput(command: string) {
    return parseHookInput(JSON.stringify({tool_name: 'Bash', tool_input: {command}}))
}

/** deps with a faked current-branch resolver. */
function deps(currentBranch: string, extra: Partial<BranchProtectionDeps> = {}): BranchProtectionDeps {
    return {
        resolveCurrentBranch: () => Promise.resolve(currentBranch),
        cwd: '/work/repo',
        autonomousMode: false,
        ...extra,
    }
}

describe('branch-protection — destructive forms block', () => {
    const cases: [string, string, string][] = [
        ['plain push to protected', 'git push origin main', 'feature'],
        ['push HEAD:protected', 'git push origin HEAD:refs/heads/main', 'feature'],
        ['develop:main refspec', 'git push origin develop:main', 'feature'],
        ['--force to protected', 'git push --force origin main', 'feature'],
        ['-f to protected', 'git push -f origin develop', 'feature'],
        ['--force-with-lease to protected', 'git push --force-with-lease origin main', 'feature'],
        ['--force-if-includes to protected', 'git push --force-if-includes origin main', 'feature'],
        ['+refspec force to protected', 'git push origin +HEAD:main', 'feature'],
        ['push --delete protected', 'git push origin --delete main', 'feature'],
        ['branch -D protected', 'git branch -D develop', 'feature'],
        ['branch --delete protected', 'git branch --delete main', 'feature'],
        ['abs-path git push protected', '/usr/bin/git push origin main', 'feature'],
        ['env-prefix git push protected', 'GIT_PAGER=cat git push origin main', 'feature'],
        ['-C dir push protected', 'git -C /other push origin main', 'feature'],
        ['quoted ref push protected', 'git push origin "main"', 'feature'],
    ]

    for (const [label, command, current] of cases) {
        it(`blocks: ${label}`, async () => {
            const d = await decideBranchProtection(bashInput(command), deps(current))
            expect(isDeny(d)).toBe(true)
        })
    }

    it('blocks implicit push while ON a protected branch', async () => {
        const d = await decideBranchProtection(bashInput('git push'), deps('main'))
        expect(isDeny(d)).toBe(true)
    })

    it('blocks reset --hard while ON a protected branch (Check 6 gates on current)', async () => {
        const d = await decideBranchProtection(bashInput('git reset --hard HEAD~1'), deps('develop'))
        expect(isDeny(d)).toBe(true)
    })

    it('blocks --git-dir current-branch resolution for reset --hard', async () => {
        // The resolver is faked, but the parse must carry the subcommand+--hard.
        const d = await decideBranchProtection(bashInput('git --git-dir=/protected/.git reset --hard'), deps('main'))
        expect(isDeny(d)).toBe(true)
    })
})

describe('branch-protection — allowed forms pass', () => {
    it('push to a non-protected branch passes', async () => {
        const d = await decideBranchProtection(bashInput('git push origin feature/x'), deps('feature/x'))
        expect(isDeny(d)).toBe(false)
    })

    it('reset --hard on a disposable branch passes', async () => {
        const d = await decideBranchProtection(bashInput('git reset --hard HEAD~1'), deps('feature/x'))
        expect(isDeny(d)).toBe(false)
    })

    it('soft reset on protected is NOT blocked (--hard only)', async () => {
        const d = await decideBranchProtection(bashInput('git reset --soft HEAD~1'), deps('main'))
        expect(isDeny(d)).toBe(false)
    })

    it('non-git command passes', async () => {
        const d = await decideBranchProtection(bashInput('ls -la'), deps('main'))
        expect(isDeny(d)).toBe(false)
    })

    it('staging exception: push to staging ALLOWED inside an orchestrator worktree', async () => {
        const d = await decideBranchProtection(
            bashInput('git push origin staging'),
            deps('staging', {
                autonomousMode: true,
                cwd: '/work/.claude/worktrees/orchestrator-abc',
            })
        )
        expect(isDeny(d)).toBe(false)
    })

    it('staging exception does NOT apply outside an orchestrator worktree', async () => {
        const d = await decideBranchProtection(
            bashInput('git push origin staging'),
            deps('staging', {autonomousMode: true, cwd: '/work/repo'})
        )
        expect(isDeny(d)).toBe(true)
    })

    it('staging exception: reset --hard ON staging ALLOWED inside an orchestrator worktree (Check 6)', async () => {
        const d = await decideBranchProtection(
            bashInput('git reset --hard HEAD~1'),
            deps('staging', {
                autonomousMode: true,
                cwd: '/work/.claude/worktrees/orchestrator-abc',
            })
        )
        expect(isDeny(d)).toBe(false)
    })

    it('staging reset --hard exception does NOT apply outside an orchestrator worktree (Check 6)', async () => {
        const d = await decideBranchProtection(
            bashInput('git reset --hard HEAD~1'),
            deps('staging', {autonomousMode: true, cwd: '/work/repo'})
        )
        expect(isDeny(d)).toBe(true)
    })
})

describe('branch-protection — nested-shell denial (autonomous)', () => {
    it('denies a nested shell in autonomous mode', async () => {
        const d = await decideBranchProtection(
            bashInput("bash -c 'git push origin feature'"),
            deps('feature', {autonomousMode: true})
        )
        expect(isDeny(d)).toBe(true)
    })
})

describe('branch-protection — default current-branch resolver (WS9)', () => {
    async function captureStderr<T>(fn: () => Promise<T>): Promise<{result: T; stderr: string}> {
        const saved = process.env.FACTORY_LOG_LEVEL
        process.env.FACTORY_LOG_LEVEL = 'info' // force warn-level through
        const cap = captureStream(process.stderr)
        try {
            const result = await fn()
            return {result, stderr: cap.read()}
        } finally {
            cap.restore()
            if (saved === undefined) {
                delete process.env.FACTORY_LOG_LEVEL
            } else {
                process.env.FACTORY_LOG_LEVEL = saved
            }
        }
    }

    /** deps that exercise the REAL default resolver via an injected exec seam. */
    function execDeps(exec: BranchProtectionDeps['exec']): BranchProtectionDeps {
        return {exec, cwd: '/work/repo', autonomousMode: false}
    }

    function execResult(over: Partial<ExecResult>): ExecResult {
        return {stdout: '', stderr: '', code: 0, signal: null, truncated: false, ...over}
    }

    it('warns when current-branch resolution THROWS (git missing / EACCES), then fails open', async () => {
        const throwingExec = () => {
            throw new Error('spawn git ENOENT')
        }
        const {result, stderr} = await captureStderr(() =>
            decideBranchProtection(bashInput('git push'), execDeps(throwingExec))
        )
        // A thrown resolver cannot prove the branch is protected → fail open (no block)…
        expect(isDeny(result)).toBe(false)
        // …but LOUDLY, so a silently-unguarded push is detectable.
        expect(stderr).toMatch(/\[WARN\]/)
        expect(stderr).toMatch(/current-branch resolution failed/)
    })

    it('does NOT warn on a detached HEAD (non-zero exit is expected), and fails open', async () => {
        // git symbolic-ref exits 128 on a detached HEAD — expected, benign, silent.
        const detachedExec = () =>
            Promise.resolve(execResult({code: 128, stderr: 'fatal: ref HEAD is not a symbolic ref'}))
        const {result, stderr} = await captureStderr(() =>
            decideBranchProtection(bashInput('git push'), execDeps(detachedExec))
        )
        expect(isDeny(result)).toBe(false)
        expect(stderr).not.toMatch(/current-branch resolution failed/)
    })

    it('resolves the current branch from exit-0 stdout and blocks a protected push', async () => {
        const onMain = () => Promise.resolve(execResult({code: 0, stdout: 'main\n'}))
        const {result, stderr} = await captureStderr(() =>
            decideBranchProtection(bashInput('git push'), execDeps(onMain))
        )
        expect(isDeny(result)).toBe(true) // standing on main → implicit push denied
        expect(stderr).not.toMatch(/current-branch resolution failed/)
    })
})
