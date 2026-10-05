import {access, realpath} from 'node:fs/promises'
import {at} from '../shared/assert.js'
import {deriveAllGatesVerdict} from '../verifier/deterministic/verdict.js'
import {join} from 'node:path'
import {z} from 'zod'
import {exec, type ExecResult} from '../shared/exec.js'
import {isEnoent} from '../shared/fs-errors.js'
import type {Config} from '../config/schema.js'
import {GateRunner} from '../verifier/deterministic/gate-runner.js'
import {defaultGateTools, type CommitInfo, type ProcResult} from '../verifier/deterministic/tools.js'
import {missingDeclaredModules, testEvidence, type TestEvidence} from './test-evidence.js'
import {diffScopedTestFiles} from '../verifier/deterministic/scope.js'
import {isVitestRunnable} from '../verifier/deterministic/strategies/test.js'
import {deriveTddVerdict, classifyCommit} from '../verifier/deterministic/tdd-classify.js'
import type {GateId} from '../verifier/deterministic/gate-id.js'
import {isTddExempt} from '../verifier/deterministic/tdd-exempt.js'
import {isDbPath} from '../verifier/deterministic/db-detect.js'
import {evaluate, type UsageSignal} from '../quota/index.js'
import {safeRepoPath} from '../spec/execution.js'
import {runSpecGates} from '../spec/gates.js'
import {provisionWorktree} from '../git/provision.js'
import {TransientFailure, type FeatureRuntime, type CheckResult, type DeliveryResult} from './ports.js'
import type {FeatureRun, Stage, Claim, FeatureSpec} from './schema.js'

const taggedTestsOnly = (commit: CommitInfo): boolean => commit.tagged && classifyCommit(commit.files) === 'test-only'
export type Command = (command: string, args: readonly string[], cwd: string) => Promise<ExecResult>
const PrSchema = z.object({
    number: z.number().int().positive(),
    url: z.string(),
    state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
    headRefOid: z.string(),
    baseRefName: z.string(),
})

export class LocalFeatureRuntime implements FeatureRuntime {
    constructor(
        readonly config: Config,
        readonly usage: UsageSignal,
        readonly command: Command = (name, args, cwd) => exec(name, args, {cwd, timeoutMs: 600_000})
    ) {}

    now(): string {
        return new Date().toISOString()
    }

    get ciWaitMinutes(): number {
        return this.config.git.rollupCiWaitMinutes
    }

    async checked(name: string, args: readonly string[], cwd: string, transient = false): Promise<string> {
        const result = await this.command(name, args, cwd)
        if (result.code !== 0 || result.truncated) {
            const message = `${name} ${args[0]} failed: ${result.stderr || result.stdout}`
            throw transient ? new TransientFailure(message) : new Error(message)
        }
        return result.stdout.trim()
    }

    async prepare(root: string, worktree: string, branch: string, base: string): Promise<void> {
        try {
            await access(join(worktree, '.git'))
        } catch (error) {
            if (!isEnoent(error)) {
                throw error
            }
            const exists = await this.command('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], root)
            if (exists.code !== 0 && exists.code !== 1) {
                throw new Error('cannot inspect feature branch')
            }
            await this.checked(
                'git',
                exists.code === 0
                    ? ['worktree', 'add', worktree, branch]
                    : ['worktree', 'add', '-b', branch, worktree, base],
                root
            )
        }
        const actual = await this.checked('git', ['symbolic-ref', '--short', 'HEAD'], worktree)
        if (actual !== branch || !(await this.ancestor(worktree, base, await this.head(worktree)))) {
            throw new Error('existing feature worktree has a different branch/base; preserved for inspection')
        }
        await this.provision(worktree)
    }

    private async provision(path: string): Promise<void> {
        try {
            await provisionWorktree({path, setupCommand: this.config.quality.setupCommand})
        } catch (error) {
            throw new TransientFailure(
                `worktree setup failed: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    head(worktree: string): Promise<string> {
        return this.checked('git', ['rev-parse', 'HEAD'], worktree)
    }
    async clean(worktree: string): Promise<boolean> {
        return (await this.checked('git', ['status', '--porcelain'], worktree)) === ''
    }
    async ancestor(worktree: string, ancestor: string, head: string): Promise<boolean> {
        const result = await this.command('git', ['merge-base', '--is-ancestor', ancestor, head], worktree)
        if (result.code !== 0 && result.code !== 1) {
            throw new Error(`cannot check Git ancestry: ${result.stderr}`)
        }
        return result.code === 0
    }

    async exempt(run: FeatureRun): Promise<boolean> {
        let pkg: unknown = null
        const tracked = await this.checked(
            'git',
            ['ls-tree', '--name-only', run.spec.base_sha, '--', 'package.json'],
            run.worktree
        )
        if (tracked) {
            pkg = JSON.parse(await this.checked('git', ['show', `${run.spec.base_sha}:package.json`], run.worktree))
        }
        const task = at(run.spec.tasks, Math.min(run.task_index, run.spec.tasks.length - 1))
        return isTddExempt(task.task_id, run.spec.tasks, pkg)
    }

    async testsOnly(run: FeatureRun): Promise<boolean> {
        const task = at(run.spec.tasks, Math.min(run.task_index, run.spec.tasks.length - 1))
        const commits = await defaultGateTools().git.commits(run.task_base_sha, task.task_id, {cwd: run.worktree})
        return commits.every(taggedTestsOnly)
    }

    async checks(run: FeatureRun, stage: Stage): Promise<CheckResult> {
        const task = at(run.spec.tasks, Math.min(run.task_index, run.spec.tasks.length - 1))
        const full = stage === 'slice-check' || stage === 'feature-check'
        const gates: GateId[] =
            stage === 'tests'
                ? ['test']
                : full
                  ? ['test', 'type', 'lint', 'build', 'coverage', 'mutation', 'sast']
                  : ['test', 'type', 'lint']
        const tools = defaultGateTools()
        const baseRef =
            stage === 'slice-check'
                ? run.slice_base_sha
                : stage === 'feature-check'
                  ? await this.featureBase(run)
                  : run.task_base_sha
        const context = {
            runId: run.run_id,
            taskId: task.task_id,
            worktree: run.worktree,
            baseRef,
            config: this.config,
            full,
        }
        const outputs: ProcResult[] = []
        const testResult = await new GateRunner().run({
            ...context,
            // task-check runs the whole suite so an unrelated regression is repaired here, not parked later.
            full: full || stage === 'task-check',
            gates: ['test'],
            tools: {
                ...tools,
                vitest: {
                    run: async (files, options) => {
                        const output = await tools.vitest.run(files, options)
                        outputs.push(output)
                        return output
                    },
                },
                command: {
                    run: async (command, options) => {
                        const output = await tools.command.run(command, options)
                        outputs.push(output)
                        return output
                    },
                },
            },
        })
        // Only the tests stage may delegate: tests vitest cannot run (pgTAP, Go) are left to the PR's CI.
        const delegated =
            stage === 'tests' &&
            outputs.length === 0 &&
            testResult.skipped.some((row) => row.reason === 'no-vitest-runnable-tests-in-scope')
        if (!delegated && outputs.length !== 1) {
            throw new Error('test gate did not execute exactly one test command')
        }
        const tests: TestEvidence = delegated ? {executed: 0, assertionFailure: false} : testEvidence(at(outputs, 0))
        const result = await new GateRunner().run({
            ...context,
            tools,
            gates: gates.filter((gate) => gate !== 'test'),
        })
        const report: CheckResult = {
            passed: deriveAllGatesVerdict([...testResult.evidence, ...result.evidence]).passed,
            observed: tests.executed + result.evidence.length,
            details: [...testResult.report, ...result.report, {executed_tests: tests.executed}].map((item) =>
                JSON.stringify(item)
            ),
        }
        if (stage === 'tests') {
            if (delegated) {
                const files = diffScopedTestFiles(await tools.git.changedFiles(run.task_base_sha, {cwd: run.worktree}))
                report.red = 'delegated-to-ci'
                report.details.push(`Delegated to CI: ${files.filter((file) => !isVitestRunnable(file)).join(', ')}`)
            } else if (!report.passed && tests.executed > 0 && tests.assertionFailure) {
                report.red = 'assertion'
            } else if (
                tests.loadFailures !== undefined &&
                (await missingDeclaredModules(
                    tests.loadFailures,
                    // Vitest prints realpaths (macOS /private/tmp); the worktree is engine-derived.
                    // eslint-disable-next-line security/detect-non-literal-fs-filename
                    await realpath(run.worktree),
                    task.files,
                    async (path) =>
                        (await this.checked(
                            'git',
                            ['ls-tree', '--name-only', run.task_base_sha, '--', path],
                            run.worktree
                        )) !== ''
                ))
            ) {
                report.red = 'missing-declared-module'
            }
        }
        if ((stage === 'tests' || stage === 'task-check') && !run.candidate_satisfied && !(await this.exempt(run))) {
            const commits = await tools.git.commits(run.task_base_sha, task.task_id, {cwd: run.worktree})
            if (stage === 'tests') {
                if (!(commits.length > 0 && commits.every(taggedTestsOnly))) {
                    delete report.red
                }
            } else {
                const verdict = deriveTddVerdict(commits, false)
                report.passed &&= verdict.ok
                report.details.push(`Unsquashed task TDD: ${JSON.stringify(verdict)}`)
            }
        }
        if (stage === 'feature-check' && run.e2e) {
            const output = await this.command('pnpm', ['exec', 'playwright', 'test', '--reporter=json'], run.worktree)
            if (output.truncated) {
                throw new Error('E2E evidence was truncated')
            }
            const parsed = z
                .object({
                    stats: z.object({
                        expected: z.number(),
                        unexpected: z.number(),
                        skipped: z.number(),
                        flaky: z.number(),
                    }),
                })
                .parse(JSON.parse(output.stdout))
            report.observed++
            report.passed &&=
                output.code === 0 &&
                parsed.stats.expected > 0 &&
                parsed.stats.unexpected === 0 &&
                parsed.stats.skipped === 0
            report.details.push(`E2E: ${JSON.stringify(parsed.stats)}`)
        }
        return report
    }

    async snapshot(run: FeatureRun, id: string, head: string): Promise<string> {
        const target = join(run.root, '.claude', 'worktrees', `review-${run.run_id}-${id}`)
        await this.checked('git', ['worktree', 'add', '--detach', target, head], run.root)
        try {
            await this.provision(target)
        } catch (error) {
            // The snapshot was never handed out; removing it keeps retries from leaving orphans.
            await this.checked('git', ['worktree', 'remove', '--force', target], run.root)
            throw error
        }
        return target
    }
    async removeSnapshot(run: FeatureRun, path: string): Promise<void> {
        await this.checked('git', ['worktree', 'remove', '--force', path], run.root)
    }
    featureBase(run: FeatureRun): Promise<string> {
        return this.checked('git', ['merge-base', 'HEAD', `${run.remote}/${run.base_branch}`], run.worktree)
    }

    async citation(worktree: string, claim: Claim): Promise<boolean> {
        if (
            !safeRepoPath(claim.file) ||
            !(await this.checked('git', ['ls-tree', '--name-only', 'HEAD', '--', claim.file], worktree))
        ) {
            return false
        }
        const source = await this.checked('git', ['show', `HEAD:${claim.file}`], worktree)
        return source
            .split('\n')
            .slice(Math.max(0, claim.line - 3), claim.line + 2)
            .join('\n')
            .includes(claim.quote)
    }
    async databaseChanged(run: FeatureRun, base: string): Promise<boolean> {
        return (await this.checked('git', ['diff', '--name-only', `${base}...HEAD`], run.worktree))
            .split('\n')
            .some(isDbPath)
    }
    async quota(run: FeatureRun): Promise<string | undefined> {
        if (run.ignore_quota) {
            return undefined
        }
        const decision = evaluate(await this.usage.read(), this.config, Date.now() / 1000)
        return decision.kind === 'proceed' ? undefined : decision.reason
    }

    async reconcileBase(run: FeatureRun): Promise<'unchanged' | 'merged' | 'conflict'> {
        await this.checked('git', ['fetch', run.remote, run.base_branch], run.worktree, true)
        const base = await this.checked('git', ['rev-parse', `${run.remote}/${run.base_branch}`], run.worktree)
        if (await this.ancestor(run.worktree, base, await this.head(run.worktree))) {
            return 'unchanged'
        }
        const result = await this.command('git', ['merge', '--no-edit', base], run.worktree)
        if (result.code === 0) {
            return 'merged'
        }
        const conflicts = await this.checked('git', ['diff', '--name-only', '--diff-filter=U'], run.worktree)
        if (conflicts) {
            return 'conflict'
        }
        throw new Error(`base integration failed: ${result.stderr || result.stdout}`)
    }
    async noChanges(run: FeatureRun): Promise<boolean> {
        const result = await this.command(
            'git',
            ['diff', '--quiet', `${run.remote}/${run.base_branch}`, 'HEAD'],
            run.worktree
        )
        if (result.code !== 0 && result.code !== 1) {
            throw new Error('cannot compare feature tree with base')
        }
        return result.code === 0
    }

    async deliver(run: FeatureRun): Promise<DeliveryResult> {
        const head = await this.head(run.worktree)
        const list = async () =>
            z
                .array(PrSchema)
                .parse(
                    JSON.parse(
                        await this.checked(
                            'gh',
                            [
                                'pr',
                                'list',
                                '--repo',
                                run.repo,
                                '--head',
                                run.branch,
                                '--base',
                                run.base_branch,
                                '--state',
                                'all',
                                '--json',
                                'number,url,state,headRefOid,baseRefName',
                            ],
                            run.worktree,
                            true
                        )
                    )
                )
        let prs = await list()
        if (prs.length > 1) {
            throw new Error('multiple feature PRs exist; refusing ambiguous delivery')
        }
        let pr = prs[0]
        if (pr?.state === 'MERGED') {
            if (pr.headRefOid !== head) {
                throw new Error('merged PR did not contain the reviewed HEAD')
            }
            return {kind: 'merged', number: pr.number, url: pr.url, head}
        }
        if (pr?.state === 'CLOSED') {
            throw new Error('feature PR was closed without merge; work preserved')
        }
        await this.checked('git', ['push', '-u', run.remote, `HEAD:refs/heads/${run.branch}`], run.worktree, true)
        if (!pr) {
            await this.checked(
                'gh',
                [
                    'pr',
                    'create',
                    '--repo',
                    run.repo,
                    '--head',
                    run.branch,
                    '--base',
                    run.base_branch,
                    '--title',
                    run.spec.prd.title,
                    '--body',
                    `Implements #${run.spec.prd.issue_number}.\n\nFactory run ${run.run_id}; reviewed HEAD ${head}.\nSpec ${run.spec_digest}.`,
                ],
                run.worktree,
                true
            )
        }
        prs = await list()
        pr = prs[0]
        if (!pr) {
            throw new TransientFailure('feature PR identity is missing after push')
        }
        if (prs.length !== 1) {
            throw new Error('feature PR identity is ambiguous after push')
        }
        if (pr.headRefOid !== head) {
            return {
                kind: 'pending',
                number: pr.number,
                url: pr.url,
                head,
                reason: 'waiting for GitHub to observe the reviewed HEAD',
            }
        }
        if (pr.state === 'CLOSED') {
            throw new Error('feature PR was closed without merge; work preserved')
        }
        if (pr.state === 'MERGED') {
            return {kind: 'merged', number: pr.number, url: pr.url, head}
        }
        if (run.ship_mode === 'no-ship' || run.debug) {
            return {kind: 'review', number: pr.number, url: pr.url, head}
        }
        const checkResult = await this.command(
            'gh',
            ['pr', 'checks', String(pr.number), '--repo', run.repo, '--required', '--json', 'bucket,name'],
            run.worktree
        )
        if (checkResult.truncated || ![0, 1, 8].includes(checkResult.code ?? -1)) {
            throw new TransientFailure(`cannot read required checks: ${checkResult.stderr}`)
        }
        // Right after PR creation gh reports "no checks reported" with empty stdout; that is pending, not evidence.
        const checks = z
            .array(z.object({bucket: z.string(), name: z.string()}))
            .parse(checkResult.stdout.trim() ? JSON.parse(checkResult.stdout) : [])
        if (checks.some((check) => ['fail', 'cancel'].includes(check.bucket))) {
            return {kind: 'failed', number: pr.number, url: pr.url, head, reason: JSON.stringify(checks)}
        }
        if (checks.length === 0 || checks.some((check) => check.bucket !== 'pass')) {
            return {
                kind: 'pending',
                number: pr.number,
                url: pr.url,
                head,
                reason: 'required checks are missing or pending',
            }
        }
        await this.checked(
            'gh',
            ['pr', 'merge', String(pr.number), '--repo', run.repo, '--squash', '--auto', '--match-head-commit', head],
            run.worktree,
            true
        )
        const updated = (await list())[0]
        if (updated?.headRefOid !== head) {
            throw new Error('PR changed during merge request')
        }
        return {kind: updated.state === 'MERGED' ? 'merged' : 'pending', number: updated.number, url: updated.url, head}
    }

    async mergedDelivery(run: FeatureRun): Promise<DeliveryResult | undefined> {
        const prs = z
            .array(PrSchema)
            .parse(
                JSON.parse(
                    await this.checked(
                        'gh',
                        [
                            'pr',
                            'list',
                            '--repo',
                            run.repo,
                            '--head',
                            run.branch,
                            '--base',
                            run.base_branch,
                            '--state',
                            'merged',
                            '--json',
                            'number,url,state,headRefOid,baseRefName',
                        ],
                        run.worktree,
                        true
                    )
                )
            )
        if (prs.length === 0) {
            return undefined
        }
        if (prs.length !== 1 || at(prs, 0).headRefOid !== (await this.head(run.worktree))) {
            throw new Error('merged PR differs from the reviewed feature HEAD')
        }
        const pr = at(prs, 0)
        return {kind: 'merged', number: pr.number, url: pr.url, head: pr.headRefOid}
    }

    validateRepair(run: FeatureRun, spec: FeatureSpec): Promise<void> {
        const gates = runSpecGates(run.spec.prd, spec.tasks)
        if (!gates.passed) {
            return Promise.reject(new Error(gates.blockers.join('; ')))
        }
        return Promise.resolve()
    }
}
