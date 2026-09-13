/* eslint-disable security/detect-non-literal-fs-filename -- validated spec/run storage paths */
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {parseArgs, optionalString, UsageError} from '../cli/args.js'
import {withUsageGuard, type Subcommand} from '../cli/registry-types.js'
import {emitJson, emitHelp} from '../cli/io.js'
import {EXIT} from '../shared/exit-codes.js'
import {loadConfig, resolveDataDir} from '../config/index.js'
import {StatuslineUsageSignal} from '../quota/index.js'
import {DefaultGitClient, resolveRepo} from '../git/index.js'
import {SpecStore} from '../spec/store.js'
import {RealGhClient} from '../spec/gh.js'
import {specDir} from '../core/state/paths.js'
import {repositorySnapshot} from '../spec/snapshot.js'
import {FeatureEngine} from './engine.js'
import {FeatureStore, renderLedger} from './store.js'
import {LocalFeatureRuntime} from './runtime.js'
import {digest, validateFeatureSpec} from './schema.js'
import {assertFeatureEnvironment} from './preflight.js'

const HELP = `Factory v2 — sequential feature delivery

factory spec resolve|gate|store --issue <n>
factory run create --issue <n> [--no-ship] [--e2e] [--ignore-quota]
factory next-action --run <id> --driver <session>
factory run stop --run <id>
factory resume --run <id> [--answer <text>] [--recover]
factory run cancel --run <id>
factory state --run <id> [--ledger]
factory state --list
factory debug create --base <ref> [--ignore-quota]

Agent results are written verbatim to the per-role paths in the execute envelope's
"staged"; next-action consumes them. --recover, after the previous agent has stopped,
consumes a complete staged result, redispatches missing roles, or retires the attempt.
Legacy runs are preserved but cannot execute. One active feature run per repository.
`

export function featureCommand(name: string): Subcommand {
    return {
        describe: `Feature ${name} (v2)`,
        run: withUsageGuard(`factory ${name}`, async (argv) => {
            if (['rescue', 'reconcile', 'score', 'miss'].includes(name)) {
                throw new UsageError(
                    `${name} is retired for v2; inspect state --run <id> --ledger and use resume explicitly`
                )
            }
            const allowed =
                name === 'run' && argv[0] === 'create'
                    ? ['issue', 'repo', 'run-id', 'no-ship', 'e2e', 'ignore-quota']
                    : name === 'debug'
                      ? ['base', 'repo', 'run-id', 'ignore-quota']
                      : name === 'resume'
                        ? ['run', 'answer', 'recover']
                        : name === 'next-action' || name === 'next-task'
                          ? ['run', 'driver']
                          : name === 'state'
                            ? ['run', 'list', 'ledger']
                            : ['run']
            const args = parseArgs(argv, {
                booleans: ['no-ship', 'e2e', 'ignore-quota', 'recover', 'list', 'ledger'],
                allowed,
            })
            if (
                name === 'run' &&
                !['create', 'stop', 'cancel'].includes(args.positionals[0] ?? '') &&
                args.positionals.length > 0
            ) {
                throw new UsageError('run supports create, stop and cancel; resume is a top-level command')
            }
            if (args.has('help') || args.has('h')) {
                emitHelp(HELP)
                return EXIT.OK
            }
            const dataDir = resolveDataDir()
            const config = loadConfig({dataDir})
            const store = new FeatureStore(dataDir)
            const runtime = new LocalFeatureRuntime(config, new StatuslineUsageSignal({dataDir}))
            const engine = new FeatureEngine(store, runtime)
            const operation = args.positionals[0]
            const ownerSession = process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CLAUDE_SESSION_ID
            if (name === 'state' && args.has('list')) {
                emitJson(await store.list())
                return EXIT.OK
            }
            if ((name === 'run' || name === 'debug') && operation === 'create') {
                const root = await runtime.checked('git', ['rev-parse', '--show-toplevel'], process.cwd())
                const repo = await resolveRepo({
                    gitClient: new DefaultGitClient(),
                    cwd: root,
                    explicit: optionalString(args.flag('repo')),
                })
                const runId = optionalString(args.flag('run-id')) ?? randomUUID()
                if (name === 'debug') {
                    const base = await runtime.checked('git', ['rev-parse', args.requireFlag('base')], root)
                    const head = await runtime.head(root)
                    if (!(await runtime.clean(root))) {
                        throw new Error('commit or stash working changes before creating a debug checkpoint')
                    }
                    const files = (await runtime.checked('git', ['diff', '--name-only', `${base}...${head}`], root))
                        .split('\n')
                        .filter(Boolean)
                    if (!files.length) {
                        throw new Error('debug requires a nonempty committed diff')
                    }
                    const spec = validateFeatureSpec({
                        version: 2,
                        revision: 1,
                        base_sha: base,
                        contracts: {},
                        prd: {
                            issue_number: 1,
                            title: 'Focused debug review',
                            body: '- Resolve independently verified defects while preserving intended behavior.',
                            labels: [],
                            body_truncated: false,
                        },
                        spec_md: `Review ${base}...${head}; repair only independently confirmed defects.`,
                        tasks: [
                            {
                                task_id: 'debug',
                                slice_id: 'debug',
                                requirement_ids: ['R1'],
                                title: 'Repair verified defects',
                                description: 'Preserve documented behavior and repair confirmed defects.',
                                files,
                                acceptance_criteria: ['Confirmed defects are fixed and regression tests pass.'],
                                tests_to_write: ['Regression tests for confirmed defects'],
                                depends_on: [],
                                risk_tier: 'high',
                                risk_rationale: 'Existing implementation review',
                                tdd_exempt: true,
                            },
                        ],
                    })
                    const run = await engine.create({
                        runId,
                        repo,
                        root,
                        spec,
                        baseBranch: config.git.baseBranch,
                        remote: 'origin',
                        shipMode: 'no-ship',
                        debug: true,
                        ignoreQuota: args.has('ignore-quota'),
                        startSha: head,
                    })
                    emitJson(run)
                    return EXIT.OK
                }
                const issue = Number(args.requireFlag('issue'))
                if (!Number.isSafeInteger(issue) || issue <= 0) {
                    throw new UsageError('--issue must be a positive integer')
                }
                const specData = join(dataDir, 'v2')
                const manifest = await new SpecStore({dataDir: specData}).resolveByIssue(repo, issue)
                if (!manifest) {
                    throw new Error('generate and review a fresh v2 spec first')
                }
                const spec = validateFeatureSpec(
                    JSON.parse(await readFile(join(specDir(specData, repo, manifest.spec_id), 'feature.json'), 'utf8'))
                )
                const currentPrd = await new RealGhClient().fetchPrd(issue, {repo})
                const snapshot = await repositorySnapshot(root, config)
                if (
                    digest(currentPrd) !== digest(spec.prd) ||
                    snapshot.base_sha !== spec.base_sha ||
                    digest(snapshot.contracts) !== digest(spec.contracts)
                ) {
                    throw new Error('PRD or base changed after spec review; regenerate against the current repository')
                }
                await assertFeatureEnvironment(spec, repo, config)
                emitJson(
                    await engine.create({
                        runId,
                        repo,
                        root,
                        spec,
                        baseBranch: config.git.baseBranch,
                        remote: 'origin',
                        shipMode: args.has('no-ship') ? 'no-ship' : 'live',
                        e2e: args.has('e2e'),
                        ignoreQuota: args.has('ignore-quota'),
                        ...(ownerSession !== undefined && ownerSession !== '' ? {ownerSession} : {}),
                    })
                )
                return EXIT.OK
            }
            const id = args.requireFlag('run')
            if (name === 'next-action' || name === 'next-task') {
                emitJson(await engine.advance(id, args.requireFlag('driver')))
                return EXIT.OK
            }
            if (name === 'resume') {
                emitJson(
                    await engine.resume(id, {
                        ...(args.has('answer') ? {answer: args.requireFlag('answer')} : {}),
                        recover: args.has('recover'),
                    })
                )
                return EXIT.OK
            }
            if (name === 'run' && operation === 'stop') {
                emitJson(await engine.stop(id))
                return EXIT.OK
            }
            if (name === 'run' && operation === 'cancel') {
                emitJson(await engine.resume(id, {cancel: true}))
                return EXIT.OK
            }
            if (['state', 'statusline'].includes(name)) {
                const run = await store.read(id)
                if (args.has('ledger')) {
                    const staged = run.in_flight ? await store.stagedPresent(id, run.in_flight) : undefined
                    process.stdout.write(renderLedger(run, {now: runtime.now(), ...(staged ? {staged} : {})}))
                } else {
                    emitJson(run)
                }
                return EXIT.OK
            }
            throw new UsageError(`unsupported ${name} operation; see --help`)
        }),
    }
}
