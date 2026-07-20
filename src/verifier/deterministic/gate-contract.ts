/**
 * S7 (Decision 46) — the GATE CONTRACT: scaffold-time gate applicability,
 * committed into the target repo at `.factory/gates.json` (TCB-write-denied so
 * producers cannot weaken their own gates).
 *
 * The contract kills silent gate-skipping. Every gate id must appear with an
 * EXPLICIT decision: `{contracted: true}` (optionally with a stack-specific
 * `command` override — `deno test`, `deno check .`, …) or
 * `{contracted: false, reason}`. At gate time (gate-runner.ts):
 *   - an UNCONTRACTED gate skips cleanly (its reason is the audit trail);
 *   - a CONTRACTED gate whose strategy reports a TOOLING skip (missing binary /
 *     config / data) is converted to a LOUD FAIL ("contracted-but-unrunnable");
 *   - SCOPE skips (nothing in the diff for this gate to act on) stay excluded —
 *     they are properties of the task, not broken tooling.
 *
 * `command` is allowed ONLY on the gates that execute it (test/type/build/lint/
 * coverage) — a command on any other gate is rejected at parse so the key can
 * never be declared-but-not-wired (the `redTestCommand` cautionary tale this
 * contract replaces). A coverage override must itself write
 * `coverage/coverage-summary.json` (istanbul json-summary shape) — that file is
 * the measurement the gate parses (S8).
 */
/* eslint-disable security/detect-non-literal-fs-filename -- fs seam: paths are internal derived run/spec/state/repo paths, never external input; runtime write-danger is covered by the TCB write-deny hook */
import {readFile} from 'node:fs/promises'
import {createLogger} from '../../shared/index.js'
import {isEnoent} from '../../shared/fs-errors.js'
import {join} from 'node:path'
import {z} from 'zod'
import {runnerName, validateCommand, type CommandValidation} from '../../shared/command-allowlist.js'
import {GATE_IDS, type GateId} from './gate-id.js'

const log = createLogger('gate-contract')

/** Where the contract lives, relative to the target repo root / worktree. */
export const GATE_CONTRACT_REL = '.factory/gates.json'

/**
 * The mutation aggregator's CI context name — the literal the managed
 * quality-gate.yml job reports and the config baseline derivation filters
 * (src/config/schema.ts, D74 amendment).
 */
export const MUTATION_CHECK_CONTEXT = 'Mutation Testing'

/** The stacks the scaffold resolution table knows how to contract. */
export const GATE_CONTRACT_STACKS = ['npm', 'deno', 'custom'] as const
export type GateContractStack = (typeof GATE_CONTRACT_STACKS)[number]

/** Gates whose strategies EXECUTE a contracted `command` override. */
export const COMMAND_GATES: readonly GateId[] = ['test', 'type', 'build', 'lint', 'coverage'] as const

/**
 * The RUNNER policy for contracted gate commands (charset validation is the
 * shared allowlist's job). Deliberately modest: the stack runners the scaffold
 * resolution table emits + the bare well-known dev tools.
 */
export function isAllowedGateRunner(argv: readonly string[]): boolean {
    const runner = runnerName(argv)
    const a1 = argv[1]
    switch (runner) {
        case 'deno':
            return a1 === 'test' || a1 === 'check' || a1 === 'task' || a1 === 'lint' || a1 === 'fmt'
        case 'go':
            return a1 === 'test'
        case 'cargo':
            return a1 === 'test' || a1 === 'check' || a1 === 'build'
        case 'npm':
        case 'pnpm':
        case 'yarn':
            return a1 === 'run' && argv[2] !== undefined
        case 'vitest':
        case 'tsc':
        case 'eslint':
        case 'jest':
        case 'mocha':
        case 'pytest':
            return true
        default:
            return false
    }
}

/** Validate one contracted gate command (shared charset + the gate runner policy). */
export function validateGateCommand(command: string): CommandValidation {
    return validateCommand(command, isAllowedGateRunner)
}

/**
 * Where the repo's mutable source lives when no `roots` is contracted. The
 * historical assumption (`src/`) — repos with a different layout (e.g. Next.js
 * app-dir: `app/`, `components/`, `utils/`) MUST contract explicit roots or the
 * mutation gate silently never matches a file (the goodbyespy no-op).
 */
export const MUTATION_DEFAULT_ROOTS: readonly string[] = ['src'] as const

/** One path segment of a plain repo-relative directory path: no globs, no separators. */
const ROOT_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/

const RootsSchema = z
    .array(
        z
            .string()
            .refine((r) => r.split('/').every((seg) => ROOT_SEGMENT_RE.test(seg)), {
                message: 'mutation root must be a plain repo-relative directory path (no globs, no leading /)',
            })
            .refine((r) => r.split('/').every((seg) => seg !== '..' && seg !== '.'), {
                message: "mutation root must not contain '.' or '..' segments",
            })
    )
    .nonempty('mutation roots must name at least one directory')

const ContractedSchema = z
    .object({
        contracted: z.literal(true),
        /** Stack-specific command override; validated + only on {@link COMMAND_GATES}. */
        command: z.string().optional(),
        /** Mutable-source roots (mutation gate ONLY); defaults to {@link MUTATION_DEFAULT_ROOTS}. */
        roots: RootsSchema.optional(),
    })
    .strict()

const UncontractedSchema = z
    .object({
        contracted: z.literal(false),
        /** Why this gate is waived — required; the committed audit trail. */
        reason: z.string().min(1, 'uncontracted gate requires a non-empty reason'),
    })
    .strict()

const EntrySchema = z.discriminatedUnion('contracted', [ContractedSchema, UncontractedSchema])

/**
 * One CI setup step (Decision 73): rendered verbatim into the managed
 * quality-gate.yml's `# factory:setup` AND `# factory:mutation-setup` regions,
 * so env boot (e.g. `supabase start`) lives in the committed contract instead
 * of doomed hand edits to a managed file. Exactly one of `uses`/`run`; `with`
 * only accompanies `uses`.
 */
const SetupStepSchema = z
    .object({
        name: z.string().min(1).optional(),
        uses: z.string().min(1).optional(),
        with: z.record(z.string()).optional(),
        run: z.string().min(1).optional(),
    })
    .strict()
    .superRefine((step, issues) => {
        if ((step.uses === undefined) === (step.run === undefined)) {
            issues.addIssue({
                code: z.ZodIssueCode.custom,
                message: "setup step requires exactly one of 'uses' or 'run'",
            })
        }
        if (step.with !== undefined && step.uses === undefined) {
            issues.addIssue({
                code: z.ZodIssueCode.custom,
                message: "'with' is only allowed on a 'uses' step",
            })
        }
    })

export type SetupStep = z.infer<typeof SetupStepSchema>

/** One gate's contract entry. */
export type GateContractEntry = z.infer<typeof EntrySchema>

/**
 * The `.factory/gates.json` schema. ALL gate ids are REQUIRED keys — omitting a
 * gate is exactly the silent skip this contract exists to kill.
 */
export const GateContractSchema = z
    .object({
        version: z.literal(1),
        stack: z.enum(GATE_CONTRACT_STACKS),
        gates: z
            .object(Object.fromEntries(GATE_IDS.map((id) => [id, EntrySchema])) as Record<GateId, typeof EntrySchema>)
            .strict(),
        /** CI env-boot steps rendered into the managed workflow (Decision 73). */
        setup_steps: z.array(SetupStepSchema).optional(),
        /**
         * Extra required CI contexts for this repo's develop branch, merged into
         * BOTH protection profiles (run + baseline) — additive-only per-repo
         * required checks (e.g. outsidey's `pgTAP`). `'Mutation Testing'` is
         * rejected here — it has its own switch below.
         */
        requiredChecks: z
            .array(z.string().min(1, 'requiredChecks entries must be non-empty'))
            .refine((cs) => !cs.includes(MUTATION_CHECK_CONTEXT), {
                message: `'${MUTATION_CHECK_CONTEXT}' is managed by the profiles — use requireMutationAtRest instead`,
            })
            .optional(),
        /**
         * Keep `'Mutation Testing'` required on develop's BASELINE profile too
         * (at rest, between runs) instead of the default run-profile-only.
         */
        requireMutationAtRest: z.boolean().optional(),
    })
    .strict()
    .superRefine((contract, issues) => {
        for (const id of GATE_IDS) {
            const entry = contract.gates[id]
            if (entry.contracted && entry.roots !== undefined && id !== 'mutation') {
                issues.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['gates', id, 'roots'],
                    message: `gate '${id}' does not use mutable-source roots (allowed on: mutation)`,
                })
            }
            if (!entry.contracted || entry.command === undefined) {
                continue
            }
            if (!COMMAND_GATES.includes(id)) {
                issues.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['gates', id, 'command'],
                    message: `gate '${id}' does not execute a command override (allowed on: ${COMMAND_GATES.join(', ')})`,
                })
                continue
            }
            const v = validateGateCommand(entry.command)
            if (!v.ok) {
                issues.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['gates', id, 'command'],
                    message: `${v.reason}: ${v.detail}`,
                })
            }
        }
    })

export type GateContract = z.infer<typeof GateContractSchema>

/**
 * The result of loading a contract from a repo root / worktree. Both non-ok
 * states are structural for the GateRunner: `absent` (worktree cut from a commit
 * without the contract) and `invalid` (committed-but-broken) each fail LOUD —
 * a sweep never runs without a valid contract.
 */
export type GateContractLoad =
    | {readonly state: 'ok'; readonly contract: GateContract}
    | {readonly state: 'absent'}
    | {readonly state: 'invalid'; readonly error: string}

/** Load + validate `<root>/.factory/gates.json`. Never throws. */
export async function loadGateContract(rootAbs: string): Promise<GateContractLoad> {
    let raw: string
    try {
        raw = await readFile(join(rootAbs, GATE_CONTRACT_REL), 'utf8')
    } catch (err) {
        if (isEnoent(err)) {
            return {state: 'absent'}
        }
        return {state: 'invalid', error: `unreadable: ${(err as Error).message}`}
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch (err) {
        return {state: 'invalid', error: `not JSON: ${(err as Error).message}`}
    }
    const result = GateContractSchema.safeParse(parsed)
    if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        return {state: 'invalid', error: issues}
    }
    return {state: 'ok', contract: result.data}
}

/**
 * The gates EVERY stack resolver contracts unconditionally (`resolveNpm` /
 * `resolveDeno` in scaffold-gates.ts). If a committed contract leaves one of these
 * `contracted:false`, an operator hand-edited the contract to drop a floor gate —
 * the one misconfig TCB write-protection can't catch (it guards the file's
 * writability, not its content). `run create` warns on each such gate.
 */
export const DEFAULT_GATES: readonly GateId[] = ['test', 'tdd', 'type'] as const

/**
 * `build` is a floor gate for emit-producing stacks (npm), but deno legitimately
 * waives it (`deno check` covers compilation, there is no emit step). So it is a
 * default gate for every stack EXCEPT deno — folded into the warning set per-stack
 * so a normal deno contract never false-warns.
 */
function defaultGatesForStack(stack: GateContractStack): readonly GateId[] {
    return stack === 'deno' ? DEFAULT_GATES : [...DEFAULT_GATES, 'build']
}

/** One gate the runner will NOT enforce because its contract entry is `contracted:false`. */
export interface SkippedGate {
    readonly id: GateId
    readonly reason: string
}

/** The enumerated "gates in force" for a contract, plus operator-misconfig warnings. */
export interface GatesInForce {
    readonly contracted: readonly GateId[]
    readonly skipped: readonly SkippedGate[]
    /** One line per DEFAULT_GATES id that is NOT contracted (a dropped floor gate). */
    readonly warnings: readonly string[]
}

/**
 * Enumerate which gates a contract puts in force, and warn when a DEFAULT_GATES
 * floor gate is missing. Pure — derived entirely from the loaded contract.
 */
export function enumerateGatesInForce(contract: GateContract): GatesInForce {
    const contracted: GateId[] = []
    const skipped: SkippedGate[] = []
    for (const id of GATE_IDS) {
        const entry = contract.gates[id]
        if (entry.contracted) {
            contracted.push(id)
        } else {
            skipped.push({id, reason: entry.reason})
        }
    }
    const skippedById = new Map(skipped.map((s) => [s.id, s.reason]))
    const warnings = defaultGatesForStack(contract.stack)
        .filter((id) => skippedById.has(id))
        .map(
            (id) =>
                `default-set gate '${id}' is not contracted: ${skippedById.get(id) ?? ''} — the merge gate will not enforce it`
        )
    return {contracted, skipped, warnings}
}

/**
 * The skip-taxonomy split (Decision 46). SCOPE skips are properties of the TASK
 * (nothing in the diff for the gate to act on) — legitimate, excluded from the
 * conjunction even under a contract. TOOLING skips mean the gate COULD NOT RUN
 * (missing binary/config/data) — on a contracted gate that is a loud fail.
 * Unknown reasons classify as tooling (fail-closed): a new skip reason must be
 * added here deliberately to earn scope-exclusion.
 */
const SCOPE_SKIP_REASONS: ReadonlySet<string> = new Set(['no-vitest-runnable-tests-in-scope', 'no-mutable-changes'])

export type SkipClass = 'scope' | 'tooling'

export function classifySkip(reason: string): SkipClass {
    return SCOPE_SKIP_REASONS.has(reason) ? 'scope' : 'tooling'
}

/**
 * Resolve gate `id`'s contracted command override as a validated argv, or
 * undefined when there is no contract / no override. Throws on an invalid
 * command — the loader's schema already rejects those, so reaching one here
 * means a contract bypassed validation (structural, loud).
 */
/**
 * The mutation gate's mutable-source roots: the contracted `roots` when present,
 * else {@link MUTATION_DEFAULT_ROOTS}. Shared by the local gate's scope filter and
 * the CI render so the two enforcers can never disagree on where source lives.
 */
export function mutationRoots(contract: GateContract | undefined): readonly string[] {
    const entry = contract?.gates.mutation
    if (entry !== undefined && entry.contracted && entry.roots !== undefined) {
        return entry.roots
    }
    return MUTATION_DEFAULT_ROOTS
}

/** The contract's per-repo branch-protection extras (defaults: none). */
export interface RequiredCheckExtras {
    readonly requiredChecks: readonly string[]
    readonly requireMutationAtRest: boolean
}

export function requiredCheckExtras(contract: GateContract | undefined): RequiredCheckExtras {
    return {
        requiredChecks: contract?.requiredChecks ?? [],
        requireMutationAtRest: contract?.requireMutationAtRest ?? false,
    }
}

/**
 * Load the repo's branch-protection extras from its committed contract. NEVER
 * throws: absent → no extras; invalid → no extras + a LOUD warn. Deliberate —
 * the de-escalation paths (finalize/supersede/cancel) call this and a failed
 * de-escalate is worse than a missing extra check.
 */
export async function loadRequiredCheckExtras(rootAbs: string): Promise<RequiredCheckExtras> {
    const load = await loadGateContract(rootAbs)
    if (load.state === 'invalid') {
        log.warn(`${GATE_CONTRACT_REL} at ${rootAbs} is invalid — per-repo required checks ignored: ${load.error}`)
    }
    return requiredCheckExtras(load.state === 'ok' ? load.contract : undefined)
}

export function contractCommand(contract: GateContract | undefined, id: GateId): readonly string[] | undefined {
    const entry = contract?.gates[id]
    if (entry === undefined || !entry.contracted || entry.command === undefined) {
        return undefined
    }
    const v = validateGateCommand(entry.command)
    if (!v.ok) {
        throw new Error(`gate contract: gate '${id}' command invalid (${v.reason}: ${v.detail})`)
    }
    return v.argv
}
