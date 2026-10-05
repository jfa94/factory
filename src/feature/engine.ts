import {randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {type FeatureStore, type Staged} from './store.js'
import {ResultRejected, TransientFailure, type FeatureRuntime} from './ports.js'
import {
    VERSION,
    REPAIR_PASSES,
    CONFIRM_BATCH,
    IdSchema,
    digest,
    terminal,
    validateFeatureSpec,
    type FeatureRun,
    type FeatureSpec,
    type FeatureAction,
    type FeatureResult,
    type Stage,
    type Attempt,
} from './schema.js'
import {parseGenerateResult} from '../spec/agents.js'
import {acceptanceIds, currentTask, renderBrief} from './brief.js'

const PANEL = ['quality-reviewer', 'implementation-reviewer', 'silent-failure-hunter', 'systemic-failure-reviewer']
const PRODUCERS: readonly Stage[] = ['tests', 'implement', 'docs', 'e2e-author', 'spec-repair']
/** Rejections a role may receive before the next one parks the run. */
const REISSUES = 2
const TRANSIENT_LIMIT = 5

export class FeatureEngine {
    constructor(
        readonly store: FeatureStore,
        readonly runtime: FeatureRuntime
    ) {}

    async create(input: {
        runId: string
        repo: string
        root: string
        spec: FeatureSpec
        baseBranch: string
        remote: string
        shipMode?: FeatureRun['ship_mode']
        ignoreQuota?: boolean
        e2e?: boolean
        debug?: boolean
        ownerSession?: string
        startSha?: string
    }): Promise<FeatureRun> {
        return this.store.withRepo(input.repo, async () => {
            const id = IdSchema.parse(input.runId)
            const spec = validateFeatureSpec(input.spec)
            // A corrupt run is skipped by list() but its directory still blocks the id.
            if (await this.store.exists(id)) {
                throw new Error(`run ${id} already exists`)
            }
            const runs = await this.store.list()
            const active = runs.find((run) => run.repo === input.repo && !terminal(run))
            if (active) {
                throw new Error(`repository already has active run ${active.run_id}; resume or cancel it`)
            }
            const run: FeatureRun = {
                version: VERSION,
                run_id: id,
                repo: input.repo,
                root: input.root,
                branch: `factory/${spec.prd.issue_number}-${id}`,
                worktree: join(input.root, '.claude', 'worktrees', `feature-${id}`),
                base_branch: input.baseBranch,
                remote: input.remote,
                ship_mode: input.shipMode ?? 'live',
                ignore_quota: input.ignoreQuota ?? false,
                debug: input.debug ?? false,
                e2e: input.e2e ?? false,
                ...(input.ownerSession !== undefined && input.ownerSession !== ''
                    ? {owner_session: input.ownerSession}
                    : {}),
                spec,
                spec_digest: digest(spec),
                status: 'running',
                stage: 'prepare',
                task_index: 0,
                accepted_sha: input.startSha ?? spec.base_sha,
                task_base_sha: spec.base_sha,
                slice_base_sha: spec.base_sha,
                attempts: {},
                checkpoints: [],
                answers: [],
                feedback: [],
                claims: [],
                confirmed_claims: [],
                candidate_satisfied: false,
                delivery: {},
                audit: [],
            }
            this.audit(run, 'created', {base_sha: spec.base_sha})
            await this.store.write(run)
            return run
        })
    }

    async advance(id: string, driver: string): Promise<FeatureAction> {
        if (!driver.trim()) {
            throw new Error('next-action requires a driver session identity')
        }
        const initial = await this.store.read(id)
        return this.store.withRepo(initial.repo, async () => {
            let run = await this.store.read(id)
            if (terminal(run)) {
                return this.terminal(run)
            }
            if (run.status === 'parked') {
                return this.parked(run)
            }
            const failures = run.transient_failures ?? 0
            delete run.transient_failures
            try {
                if (run.in_flight) {
                    // The staged file's existence is the submission: no driver hand-off is needed,
                    // so a fresh driver consumes a previous driver's finished attempt.
                    const staged = await this.store.staged(id, run.in_flight)
                    if ('missing' in staged) {
                        const invalid = Object.entries(staged.invalid)
                        if (invalid.length) {
                            throw new ResultRejected(
                                invalid.map(([role]) => role),
                                invalid.map(([role, why]) => `${role}: ${why}`).join('; ')
                            )
                        }
                        const roles = run.in_flight.redispatch
                        if (roles) {
                            delete run.in_flight.redispatch
                            await this.store.write(run)
                            return await this.execute(run, {...run.in_flight, roles})
                        }
                        return this.wait(
                            run,
                            `awaiting ${staged.missing.join(', ')} for ${run.in_flight.id}; do not spawn it twice`
                        )
                    }
                    const recorded = structuredClone(run)
                    const attempt = run.in_flight
                    await this.accept(recorded, staged.result)
                    run = recorded
                    await this.store.write(run)
                    if (await this.removeSnapshot(run, attempt)) {
                        await this.store.write(run)
                    }
                    if ((run.status as string) === 'parked') {
                        return this.parked(run)
                    }
                }
                const quota = run.ignore_quota ? undefined : await this.runtime.quota(run)
                if (quota !== undefined) {
                    run.status = 'waiting'
                    run.stop_reason = {kind: 'quota', message: quota.reason}
                    await this.store.write(run)
                    return this.wait(run, quota.reason, quota.seconds)
                }
                run.status = 'running'
                delete run.stop_reason
                for (let step = 0; step < 12; step++) {
                    const action = await this.step(run, driver)
                    await this.store.write(run)
                    if (action) {
                        return action
                    }
                }
                return this.wait(run, 'checkpoint saved; advance again', 0)
            } catch (error) {
                if (error instanceof ResultRejected) {
                    return this.rejected(run, error)
                }
                const message = error instanceof Error ? error.message : String(error)
                if (error instanceof TransientFailure && failures + 1 < TRANSIENT_LIMIT) {
                    run.transient_failures = failures + 1
                    run.status = 'waiting'
                    run.stop_reason = {kind: 'environment', message}
                    this.audit(run, 'transient failure', {count: failures + 1, message})
                    await this.store.write(run)
                    return this.wait(run, `transient failure ${failures + 1}/${TRANSIENT_LIMIT}: ${message}`)
                }
                this.park(run, 'environment', message)
                await this.store.write(run)
                return this.parked(run)
            }
        })
    }

    /** Move the rejected files aside and re-issue their roles, or park once a role exhausts its re-issues. */
    private async rejected(run: FeatureRun, error: ResultRejected): Promise<FeatureAction> {
        const attempt = run.in_flight
        if (attempt === undefined) {
            throw new Error(`result rejected without an active attempt: ${error.message}`)
        }
        const rejections = (run.rejections ??= {})
        for (const role of error.roles) {
            const reasons = (rejections[role] ??= [])
            reasons.push(error.message)
            await this.store.rejectStaged(run.run_id, attempt, role, reasons.length)
        }
        this.audit(run, 'result rejected', {
            attempt: attempt.id,
            roles: error.roles,
            reason: error.message,
            fresh_snapshot: error.freshSnapshot,
        })
        const exhausted = error.roles.find((role) => (rejections[role]?.length ?? 0) > REISSUES)
        if (exhausted !== undefined) {
            this.park(
                run,
                'producer',
                `${exhausted}: result rejected ${REISSUES + 1} times: ${rejections[exhausted]?.join('; ')}`
            )
            await this.store.write(run)
            return this.parked(run)
        }
        if (error.freshSnapshot) {
            delete run.in_flight
            await this.store.write(run)
            if (await this.removeSnapshot(run, attempt)) {
                await this.store.write(run)
            }
            return this.wait(run, `result rejected (${error.message}); a fresh attempt is issued next`, 0)
        }
        const roles = [...new Set([...(attempt.redispatch ?? []), ...error.roles])]
        delete attempt.redispatch
        await this.store.write(run)
        return this.execute(run, {...attempt, roles})
    }

    async stop(id: string): Promise<FeatureRun> {
        return this.mutate(id, (run) => {
            if (terminal(run)) {
                throw new Error('terminal run cannot be stopped')
            }
            this.park(run, 'operator', 'Explicit stop; resume is required even after quota recovery')
            return run
        })
    }

    /** The session driving next-action or resume becomes the owner the Stop hook and guards follow. */
    async own(id: string, session: string): Promise<void> {
        const settled = (run: FeatureRun): boolean => terminal(run) || run.owner_session === session
        if (settled(await this.store.read(id))) {
            return
        }
        await this.mutate(id, (run) => {
            if (!settled(run)) {
                this.audit(run, 'owner session changed', {from: run.owner_session ?? null, to: session})
                run.owner_session = session
            }
            return run
        })
    }

    async resume(
        id: string,
        options: {answer?: string; recover?: boolean; cancel?: boolean; ship?: 'live' | 'no-ship'} = {}
    ): Promise<FeatureRun> {
        let retired: Attempt | undefined
        const resumed = await this.mutate(id, async (initial) => {
            let run = initial
            if (terminal(run)) {
                throw new Error('terminal run requires a fresh run')
            }
            if (options.cancel === true) {
                run.status = 'cancelled'
                this.audit(run, 'cancelled; branch and work preserved', {})
                return
            }
            if (options.ship !== undefined) {
                if (run.ship_mode !== 'local') {
                    throw new Error('--ship only authorizes delivery for a local run')
                }
                run.ship_mode = options.ship
                this.audit(run, 'delivery authorized', {ship_mode: options.ship})
            }
            if (options.answer !== undefined) {
                if (run.question === undefined || !options.answer.trim()) {
                    throw new Error('answer requires a pending question and nonempty text')
                }
                const task = this.task(run)
                run.answers.push({
                    task_id: task.task_id,
                    question: run.question,
                    answer: options.answer,
                    at: this.runtime.now(),
                })
                delete run.question
            } else if (run.question !== undefined) {
                throw new Error(`answer required: ${run.question}`)
            }
            if (run.in_flight) {
                if (options.recover !== true) {
                    throw new Error('attempt still leased; stop its agent, then resume --recover')
                }
                const attempt = run.in_flight
                let staged: Staged | Error
                try {
                    staged = await this.store.staged(id, attempt)
                } catch (error) {
                    staged = error instanceof Error ? error : new Error(String(error))
                }
                if (!(staged instanceof Error) && 'missing' in staged) {
                    if (staged.missing.length < attempt.roles.length) {
                        // Same attempt, same snapshot: only the missing roles run again.
                        attempt.redispatch = staged.missing
                        this.audit(run, 'partial result retained; missing roles redispatched', {
                            attempt: attempt.id,
                            missing: staged.missing,
                        })
                    } else {
                        this.audit(run, 'interrupted attempt retired; work retained', attempt)
                        delete run.in_flight
                        retired = attempt
                    }
                } else {
                    const recovered = structuredClone(run)
                    recovered.status = 'running'
                    delete recovered.stop_reason
                    try {
                        if (staged instanceof Error) {
                            throw staged
                        }
                        await this.accept(recovered, staged.result)
                        run = recovered
                        retired = attempt
                        this.audit(run, 'durable result recovered', attempt.id)
                        if (run.status === 'parked') {
                            return run
                        }
                    } catch (error) {
                        const reason = error instanceof Error ? error.message : String(error)
                        this.audit(run, 'invalid durable result retired; evidence and work retained', {
                            attempt,
                            reason,
                        })
                        run.feedback = [...run.feedback, `Previous result rejected: ${reason}`]
                        delete run.in_flight
                        retired = attempt
                    }
                }
            }
            run.status = 'running'
            delete run.stop_reason
            delete run.wait_since
            delete run.rejections
            delete run.transient_failures
            this.audit(run, 'resumed', options)
            return run
        })
        if (retired === undefined) {
            return resumed
        }
        // Only once the retirement is written: a crash before it must still find the snapshot.
        const attempt = retired
        return this.store.withRepo(resumed.repo, async () => {
            const run = await this.store.read(id)
            if (await this.removeSnapshot(run, attempt)) {
                await this.store.write(run)
            }
            return run
        })
    }

    private async mutate(
        id: string,
        fn: (run: FeatureRun) => undefined | FeatureRun | Promise<undefined | FeatureRun>
    ): Promise<FeatureRun> {
        const initial = await this.store.read(id)
        return this.store.withRepo(initial.repo, async () => {
            let run = await this.store.read(id)
            run = (await fn(run)) ?? run
            await this.store.write(run)
            return run
        })
    }

    /** Identity is the staged path; check the attempt still matches the spec, record, then journal. */
    private async accept(run: FeatureRun, result: FeatureResult): Promise<void> {
        const attempt = run.in_flight
        if (attempt?.spec_digest !== run.spec_digest) {
            throw new Error('stale or duplicate result; inspect the persisted attempt')
        }
        await this.record(run, result)
        delete run.rejections
        await this.store.recordResult(run.run_id, attempt.id, result)
    }

    /**
     * Remove a retired review snapshot (never a producer's feature worktree). Returns true when it
     * audited a refusal or failure the caller must persist; removal never blocks the run.
     */
    private async removeSnapshot(run: FeatureRun, attempt: Attempt | undefined): Promise<boolean> {
        if (attempt === undefined || PRODUCERS.includes(attempt.stage)) {
            return false
        }
        const prefix = join(run.root, '.claude', 'worktrees', `review-${run.run_id}-`)
        try {
            if (!attempt.worktree.startsWith(prefix) || attempt.worktree.includes('..')) {
                throw new Error(`refusing to remove ${attempt.worktree}: outside ${prefix}*`)
            }
            await this.runtime.removeSnapshot(run, attempt.worktree)
            return false
        } catch (error) {
            this.audit(run, 'snapshot removal failed', {
                attempt: attempt.id,
                worktree: attempt.worktree,
                reason: error instanceof Error ? error.message : String(error),
            })
            return true
        }
    }

    private task(run: FeatureRun) {
        return currentTask(run)
    }

    private audit(run: FeatureRun, event: string, details: unknown): void {
        run.audit.push({at: this.runtime.now(), event, stage: run.stage, head_sha: run.accepted_sha, details})
    }

    private park(run: FeatureRun, kind: NonNullable<FeatureRun['stop_reason']>['kind'], message: string): void {
        run.status = 'parked'
        run.stop_reason = {kind, message}
        this.audit(run, 'parked', run.stop_reason)
    }
    private parked(run: FeatureRun): FeatureAction {
        return {kind: 'park', run_id: run.run_id, reason: run.stop_reason?.message ?? 'parked'}
    }
    private wait(run: FeatureRun, reason: string, seconds = 60): FeatureAction {
        return {kind: 'wait', run_id: run.run_id, reason, retry_after_seconds: seconds}
    }
    private terminal(run: FeatureRun): FeatureAction {
        return {kind: 'terminal', run_id: run.run_id, status: run.status, delivery: run.delivery}
    }

    private repair(run: FeatureRun, boundary: Stage, feedback: string[]): void {
        const scope = boundary.startsWith('slice')
            ? `slice:${this.task(run).slice_id}`
            : boundary.startsWith('feature') || boundary === 'acceptance' || boundary === 'deliver'
              ? 'feature'
              : boundary.startsWith('spec')
                ? 'spec'
                : `task:${this.task(run).task_id}`
        const used = run.attempts[scope] ?? 0
        run.feedback = feedback
        if (used >= REPAIR_PASSES) {
            this.park(
                run,
                scope === 'spec' ? 'spec' : 'producer',
                `${scope}: ${REPAIR_PASSES} repair passes exhausted: ${feedback.join('; ')}`
            )
            return
        }
        run.attempts[scope] = used + 1
        run.after_confirm = boundary
        run.stage = scope === 'spec' ? 'spec-repair' : 'implement'
        this.audit(run, 'repair scheduled', {scope, pass: used + 1, feedback})
    }

    /** Scope the next review at `boundary` to the repair; a repeat repair keeps the first base so the diff spans every round. */
    private rereview(
        run: FeatureRun,
        boundary: NonNullable<FeatureRun['rereview']>['boundary'],
        base: string,
        claims: NonNullable<FeatureRun['rereview']>['claims']
    ): void {
        run.rereview = {boundary, base: run.rereview?.boundary === boundary ? run.rereview.base : base, claims}
    }

    private async reviewBase(run: FeatureRun): Promise<string> {
        if (run.rereview?.boundary === run.stage) {
            return run.rereview.base
        }
        if (run.stage === 'task-review') {
            return run.task_base_sha
        }
        if (run.stage === 'slice-review') {
            return run.slice_base_sha
        }
        if (run.stage === 'feature-review' || run.stage === 'acceptance') {
            // After an upstream merge the feature range starts at the merge-base, not the spec base.
            return this.runtime.featureBase(run)
        }
        return run.spec.base_sha
    }

    private async spawn(run: FeatureRun, driver: string): Promise<FeatureAction> {
        const id = randomUUID()
        const producer = PRODUCERS.includes(run.stage)
        const head = await this.runtime.head(run.worktree)
        if (!(await this.runtime.ancestor(run.worktree, run.accepted_sha, head))) {
            throw new Error('accepted commits are missing; work preserved for inspection')
        }
        const base = await this.reviewBase(run)
        let roles: string[]
        if (run.stage === 'task-review') {
            roles = ['quality-reviewer']
        } else if (run.stage === 'slice-review' || run.stage === 'feature-review') {
            roles = [...PANEL]
            if (await this.runtime.databaseChanged(run, base)) {
                roles.push('database-design-reviewer')
            }
        } else if (run.stage === 'confirm') {
            roles = ['finding-verifier']
        } else if (run.stage === 'acceptance') {
            roles = ['acceptance-evaluator']
        } else if (run.stage === 'spec-review') {
            roles = ['spec-reviewer']
        } else {
            roles = [
                run.stage === 'tests'
                    ? 'test-writer'
                    : run.stage === 'e2e-author'
                      ? 'e2e-author'
                      : run.stage === 'spec-repair'
                        ? 'spec-generator'
                        : run.stage === 'docs'
                          ? 'scribe'
                          : 'implementer',
            ]
        }
        const worktree = producer ? run.worktree : await this.runtime.snapshot(run, id, head)
        const attempt: Attempt = {
            id,
            driver,
            stage: run.stage,
            head_sha: head,
            base_sha: base,
            spec_digest: run.spec_digest,
            worktree,
            roles,
            issued_at: this.runtime.now(),
        }
        run.in_flight = attempt
        this.audit(run, 'attempt issued', attempt)
        return this.execute(run, attempt)
    }

    private async execute(run: FeatureRun, attempt: Attempt): Promise<FeatureAction> {
        const staged = await this.store.stage(run.run_id, attempt, attempt.roles)
        const prompts: Record<string, string> = {}
        for (const role of attempt.roles) {
            const path = await this.store.writeBrief(run.run_id, attempt, role, renderBrief(run, attempt, role))
            prompts[role] = [
                `Factory pipeline-runner dispatch for ${run.repo}, as role ${role}.`,
                `Read your brief at ${path} and follow it; your final reply is the JSON result it specifies.`,
            ].join('\n')
        }
        return {kind: 'execute', run_id: run.run_id, attempt, staged, prompts}
    }

    private async record(run: FeatureRun, result: FeatureResult): Promise<void> {
        const attempt = run.in_flight
        if (attempt === undefined) {
            throw new Error('result has no active attempt')
        }
        const head = await this.runtime.head(run.worktree)
        if (!PRODUCERS.includes(attempt.stage) && head !== attempt.head_sha) {
            throw new Error('result HEAD differs from the reviewed/produced tree')
        }
        if (!(await this.runtime.ancestor(run.worktree, run.accepted_sha, head))) {
            throw new Error('producer removed accepted commits')
        }
        const producer = PRODUCERS.includes(attempt.stage)
        if (['done', 'already-satisfied'].includes(result.status) && !(await this.runtime.clean(run.worktree))) {
            const message = 'uncommitted work remains; preserve it and finish the attempt'
            throw producer ? new ResultRejected(attempt.roles, message) : new Error(message)
        }
        if (
            !producer &&
            ((await this.runtime.head(attempt.worktree)) !== attempt.head_sha ||
                !(await this.runtime.clean(attempt.worktree)))
        ) {
            throw new ResultRejected(
                attempt.roles,
                'review snapshot was modified; independent evidence is invalid',
                true
            )
        }
        delete run.in_flight
        this.audit(run, 'result recorded', result)
        if (result.status === 'needs-context') {
            run.question = result.message ?? 'Provide missing implementation context'
            this.park(run, 'context', run.question)
            return
        }
        if (result.status === 'spec-defect') {
            this.repair(run, 'spec-repair', [result.message ?? 'spec contradicts repository contracts'])
            return
        }
        if (result.status === 'blocked') {
            this.park(run, 'environment', result.message ?? 'agent reported a blocked environment')
            return
        }
        if (result.status === 'already-satisfied') {
            // The tests stage may commit passing tests that pin already-delivered behavior before
            // reporting; implement must leave the task checkpoint untouched.
            if (run.stage !== 'tests' && (run.stage !== 'implement' || head !== run.task_base_sha)) {
                throw new ResultRejected(attempt.roles, 'already-satisfied requires an unchanged task checkpoint')
            }
            if (run.stage === 'tests' && !(await this.runtime.testsOnly(run))) {
                // A test-writer cannot undo an implementation commit by adding commits (a revert
                // classifies as impl too), so a repair pass would only burn budget: park now.
                const message =
                    'already-satisfied at the tests stage requires only tagged test-only commits since the task checkpoint; an implementation commit cannot be repaired by the test-writer'
                run.feedback = [message]
                this.park(run, 'producer', message)
                return
            }
            run.candidate_satisfied = true
            run.stage = 'task-check'
            return
        }
        switch (run.stage) {
            case 'tests': {
                const red = await this.runtime.checks(run, 'tests')
                if (head === run.task_base_sha || red.red === undefined) {
                    this.repair(run, 'tests', [
                        'test-writer must commit task tests that demonstrably fail by assertion, or by importing a declared task module absent at the task base',
                        ...red.details,
                    ])
                    if (run.status !== 'parked') {
                        run.stage = 'tests'
                    }
                } else {
                    this.audit(run, 'red observed', {kind: red.red, details: red.details})
                    run.stage = 'implement'
                }
                break
            }
            case 'implement':
                run.stage =
                    run.after_confirm?.startsWith('slice') === true
                        ? 'slice-check'
                        : ['feature-check', 'feature-review', 'acceptance', 'deliver'].includes(run.after_confirm ?? '')
                          ? 'feature-check'
                          : 'task-check'
                delete run.after_confirm
                break
            case 'docs':
                run.stage = run.e2e ? 'e2e-author' : 'feature-check'
                break
            case 'e2e-author':
                run.stage = 'feature-check'
                break
            case 'task-review':
            case 'slice-review':
            case 'feature-review': {
                const reviews = result.reviews
                // The store binds one row per role from the staged path; a role without claims is absent.
                const absent = attempt.roles.filter((role) => reviews?.some((row) => row.reviewer === role) !== true)
                if (absent.length) {
                    throw new ResultRejected(
                        absent,
                        'reviewer result has no claims array; return "claims": [] when clean'
                    )
                }
                const claims = (reviews ?? []).flatMap((review) => review.claims)
                const invalid: typeof claims = []
                for (const claim of claims) {
                    if (!(await this.runtime.citation(attempt.worktree, claim))) {
                        invalid.push(claim)
                    }
                }
                if (invalid.length) {
                    throw new ResultRejected(
                        [...new Set(invalid.map((claim) => claim.reviewer))],
                        `invalid citation for ${invalid.map((claim) => `${claim.id} (${claim.file}:${claim.line})`).join(', ')}; quote must be exact source within two lines of line`
                    )
                }
                run.claims = claims
                this.audit(run, 'review recorded', reviews)
                if (run.claims.length) {
                    run.after_confirm = run.stage
                    run.stage = 'confirm'
                } else {
                    await this.reviewPassed(run, run.stage)
                }
                break
            }
            case 'confirm': {
                const votes = result.confirmations ?? []
                const batch = run.claims.slice(0, CONFIRM_BATCH)
                if (
                    votes.length !== batch.length ||
                    new Set(votes.map((v) => v.id)).size !== votes.length ||
                    batch.some((c) => !votes.some((v) => v.id === c.id))
                ) {
                    throw new ResultRejected(
                        attempt.roles,
                        `independent confirmation is incomplete; return exactly one confirmation for each of ${batch.map((c) => c.id).join(', ')}`
                    )
                }
                this.audit(run, 'findings confirmed', {claims: batch, votes})
                run.claims = run.claims.slice(batch.length)
                run.confirmed_claims.push(
                    ...batch.filter((claim) => votes.find((vote) => vote.id === claim.id)?.confirmed === true)
                )
                if (run.claims.length) {
                    break // next attempt confirms the following batch on a fresh snapshot
                }
                const blockers = run.confirmed_claims
                run.confirmed_claims = []
                const boundary = run.after_confirm
                if (boundary === undefined) {
                    throw new Error('confirmation has no review boundary')
                }
                delete run.after_confirm
                if (blockers.length) {
                    if (boundary === 'task-review' || boundary === 'slice-review' || boundary === 'feature-review') {
                        this.rereview(
                            run,
                            boundary,
                            attempt.head_sha,
                            blockers.map(({file, line, claim}) => ({file, line, claim}))
                        )
                    }
                    this.repair(
                        run,
                        boundary,
                        blockers.map((claim) => `${claim.file}:${claim.line}: ${claim.claim}`)
                    )
                } else {
                    await this.reviewPassed(run, boundary)
                }
                break
            }
            case 'acceptance': {
                const rows = result.acceptance ?? []
                const expected = acceptanceIds(run)
                if (
                    rows.length !== expected.length ||
                    new Set(rows.map((row) => row.id)).size !== rows.length ||
                    expected.some((id) => !rows.some((row) => row.id === id))
                ) {
                    throw new ResultRejected(
                        attempt.roles,
                        `acceptance evidence must cover every requested criterion exactly once: ${expected.join(', ')}`
                    )
                }
                const unmet = rows.filter((row) => !row.met)
                if (unmet.length) {
                    const boundary = run.candidate_satisfied ? 'task-review' : 'acceptance'
                    this.rereview(
                        run,
                        run.candidate_satisfied ? 'task-review' : 'feature-review',
                        attempt.head_sha,
                        unmet.map((row) => ({claim: `${row.id}: ${row.evidence}`}))
                    )
                    run.candidate_satisfied = false
                    this.repair(
                        run,
                        boundary,
                        unmet.map((row) => `${row.id}: ${row.evidence}`)
                    )
                } else if (run.candidate_satisfied) {
                    run.candidate_satisfied = false
                    await this.acceptTask(run)
                } else {
                    run.verified_feature = {head_sha: head, spec_digest: run.spec_digest}
                    run.stage = 'deliver'
                }
                break
            }
            case 'spec-repair': {
                let spec: FeatureSpec
                try {
                    const repair = parseGenerateResult(result.repaired_spec)
                    spec = validateFeatureSpec({
                        version: VERSION,
                        revision: run.spec.revision + 1,
                        base_sha: run.spec.base_sha,
                        prd: run.spec.prd,
                        contracts: run.spec.contracts,
                        spec_md: repair.specMd,
                        tasks: repair.tasks,
                    })
                    for (const [index, checkpoint] of run.checkpoints.entries()) {
                        if (
                            spec.tasks[index]?.task_id !== checkpoint.task_id ||
                            digest(spec.tasks.find((t) => t.task_id === checkpoint.task_id)) !==
                                digest(run.spec.tasks.find((t) => t.task_id === checkpoint.task_id))
                        ) {
                            throw new Error('spec repair cannot change or reorder the accepted task prefix')
                        }
                    }
                    await this.runtime.validateRepair(run, spec)
                } catch (error) {
                    throw new ResultRejected(attempt.roles, error instanceof Error ? error.message : String(error))
                }
                run.repaired_spec = spec
                run.stage = 'spec-review'
                break
            }
            case 'spec-review':
                if (!run.repaired_spec) {
                    throw new Error('missing proposed spec repair')
                }
                run.spec = run.repaired_spec
                run.spec_digest = digest(run.spec)
                delete run.repaired_spec
                run.task_index = run.checkpoints.length
                run.task_base_sha = head
                run.stage = run.task_index >= run.spec.tasks.length ? 'docs' : 'tests'
                break
            case 'prepare':
            case 'task-check':
            case 'slice-check':
            case 'feature-check':
            case 'deliver':
                throw new Error(`stage ${run.stage} does not accept agent results`)
        }
    }

    private async acceptTask(run: FeatureRun): Promise<void> {
        const head = await this.runtime.head(run.worktree)
        const task = this.task(run)
        run.checkpoints.push({task_id: task.task_id, head_sha: head, spec_digest: run.spec_digest})
        run.accepted_sha = head
        delete run.rereview
        const next = run.spec.tasks[run.task_index + 1]
        if (next?.slice_id !== task.slice_id) {
            run.stage = 'slice-check'
        } else {
            run.task_index++
            run.task_base_sha = head
            run.stage = 'tests'
        }
        this.audit(run, 'task accepted', task.task_id)
    }

    private async reviewPassed(run: FeatureRun, boundary: Stage): Promise<void> {
        if (run.rereview?.boundary === boundary) {
            delete run.rereview
        }
        if (boundary === 'task-review') {
            if (run.candidate_satisfied) {
                run.stage = 'acceptance'
            } else {
                await this.acceptTask(run)
            }
        } else if (boundary === 'slice-review') {
            delete run.rereview
            run.accepted_sha = await this.runtime.head(run.worktree)
            run.task_index++
            run.task_base_sha = run.accepted_sha
            run.slice_base_sha = run.accepted_sha
            run.stage = run.task_index >= run.spec.tasks.length ? 'docs' : 'tests'
        } else {
            run.stage = 'acceptance'
        }
    }

    private async step(run: FeatureRun, driver: string): Promise<FeatureAction | undefined> {
        if (run.status === 'parked') {
            return this.parked(run)
        }
        if (run.stage === 'prepare') {
            await this.runtime.prepare(run.root, run.worktree, run.branch, run.accepted_sha)
            run.stage = run.debug ? 'feature-check' : 'tests'
            return
        }
        if (run.stage === 'tests' && (await this.runtime.exempt(run))) {
            run.stage = 'implement'
            return
        }
        if (run.stage === 'tests' && (await this.runtime.head(run.worktree)) === run.task_base_sha) {
            const baseline = await this.runtime.checks(run, 'tests')
            this.audit(run, 'pre-test baseline checked', baseline)
            if (!baseline.passed) {
                this.park(
                    run,
                    'environment',
                    'baseline tests already fail; restore a green baseline before writing task tests'
                )
                return this.parked(run)
            }
        }
        if (['task-check', 'slice-check', 'feature-check'].includes(run.stage)) {
            const result = await this.runtime.checks(run, run.stage)
            this.audit(run, 'checks executed', result)
            if (!result.passed || result.observed === 0) {
                this.repair(
                    run,
                    run.stage,
                    result.details.length ? result.details : ['checks produced no passing evidence']
                )
            } else {
                // The repair that carried this feedback has passed its checks; later prompts must not re-cite it.
                run.feedback = []
                run.stage =
                    run.stage === 'task-check'
                        ? 'task-review'
                        : run.stage === 'slice-check'
                          ? 'slice-review'
                          : 'feature-review'
            }
            return
        }
        if (run.stage === 'deliver') {
            const merged = await this.runtime.mergedDelivery(run)
            if (merged) {
                run.status = 'completed'
                run.delivery = {pr_number: merged.number, url: merged.url, head_sha: merged.head, outcome: 'merged'}
                this.audit(run, 'merge confirmed', merged)
                return this.terminal(run)
            }
            const reconciliation = await this.runtime.reconcileBase(run)
            if (reconciliation === 'merged') {
                delete run.wait_since
                delete run.rereview // base integration requires full verification
                run.stage = 'feature-check'
                this.audit(run, 'base integrated; full verification required', {})
                return
            }
            if (reconciliation === 'conflict') {
                this.repair(run, 'deliver', [
                    'resolve the active merge conflict; preserve both accepted feature work and current base',
                ])
                return
            }
            const head = await this.runtime.head(run.worktree)
            if (run.verified_feature?.head_sha !== head || run.verified_feature.spec_digest !== run.spec_digest) {
                delete run.wait_since
                run.stage = 'feature-check'
                this.audit(run, 'delivery HEAD requires full verification', {head})
                return
            }
            if (await this.runtime.noChanges(run)) {
                run.status = 'completed'
                run.delivery = {outcome: 'no-change', head_sha: await this.runtime.head(run.worktree)}
                this.audit(run, 'no-change completion', run.delivery)
                return this.terminal(run)
            }
            if (run.ship_mode === 'local') {
                // Every gate has passed; nothing has left the machine. Delivery waits for resume --ship.
                this.park(run, 'authorization', 'verified feature awaits delivery; resume --ship live|no-ship')
                return this.parked(run)
            }
            const result = await this.runtime.deliver(run)
            run.delivery = {pr_number: result.number, url: result.url, head_sha: result.head}
            this.audit(run, 'delivery observed', result)
            if (result.kind === 'merged' || result.kind === 'review') {
                run.status = result.kind === 'merged' ? 'completed' : 'ready-for-review'
                run.delivery.outcome = result.kind === 'merged' ? 'merged' : 'review'
                return this.terminal(run)
            }
            if (result.kind === 'failed') {
                this.repair(run, 'deliver', [result.reason ?? 'required PR checks failed'])
                return
            }
            run.status = 'awaiting-merge'
            run.wait_since ??= this.runtime.now()
            if (Date.parse(this.runtime.now()) - Date.parse(run.wait_since) > this.runtime.ciWaitMinutes * 60_000) {
                this.park(run, 'ci', 'CI/merge wait deadline reached; work preserved, resume to recheck')
                return this.parked(run)
            }
            run.stop_reason = {kind: 'ci', message: result.reason ?? 'waiting for required CI and merge'}
            return this.wait(run, run.stop_reason.message)
        }
        return this.spawn(run, driver)
    }
}
