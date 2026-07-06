/**
 * Shared vocabulary of the e2e coroutine's modules (author / proof / suite / facade):
 * the deps + action types, the injectable file ops, the phase-marker writers, and the
 * manifest-join predicates. No stage logic lives here — see `e2e.ts` (the facade) for
 * the coroutine's shape and Decision 39/40 rationale.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- fs on internal derived paths (run/spec/state/repo/data dirs), never external input; runtime write-danger is covered by the TCB write-deny hook */
import {copyFile, mkdir, writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'
import type {StageDone, StageFailed, StageSpawnBase, StageSuspend} from './stage-helpers.js'
import type {
    Config,
    GitClient,
    StateManager,
    SpecManifest,
    E2ePhase,
    E2eManifestEntry,
    PlaywrightTool,
    E2eSpecResult,
    ProvisionWorktreeFn,
} from './deps.js'
import {nowIso, createLogger} from '../shared/index.js'

const log = createLogger('e2e')

/** File operations the e2e coroutine needs beyond git — injectable (unit tests fake it). */
export interface E2eFileOps {
    /** Copies one spec file across worktrees for the fail-first proof. */
    copySpec(from: string, to: string): Promise<void>
    /** Writes a generated Playwright config (e.g. the throwaway-suite config). */
    writeConfig(path: string, contents: string): Promise<void>
}

export class DefaultE2eFileOps implements E2eFileOps {
    async copySpec(from: string, to: string): Promise<void> {
        await mkdir(dirname(to), {recursive: true})
        await copyFile(from, to)
    }
    async writeConfig(path: string, contents: string): Promise<void> {
        await mkdir(dirname(path), {recursive: true})
        await writeFile(path, contents)
    }
}

export interface E2eRunDeps {
    readonly state: StateManager
    readonly git: GitClient
    readonly config: Config
    readonly dataDir: string
    /** The run's durable spec — task list + acceptance criteria for the author prompt. */
    readonly spec: SpecManifest
    /** Injectable Playwright wrapper (tests fake this; production uses the real CLI). */
    readonly playwright?: PlaywrightTool
    /** Injectable spec-file copy for the fail-first proof (tests fake this). */
    readonly files?: E2eFileOps
    /** Injectable worktree provisioner (tests fake this; production runs `npm ci`-equivalent). */
    readonly provision?: ProvisionWorktreeFn
}

export type E2eAction =
    | (StageSpawnBase & {
          readonly kind: 'spawn'
          /** Which results shape the runner records back (D7) — author manifest vs adjudication verdicts. */
          readonly expects: 'author-results'
          readonly base_ref: string
          readonly e2e_branch: string
          readonly throwaway_dir: string
      })
    | (StageSpawnBase & {
          readonly kind: 'spawn'
          readonly expects: 'adjudication-results'
          readonly adjudicate_branch: string
      })
    | StageDone
    | StageFailed
    | {
          readonly kind: 'reopen'
          readonly run_id: string
          readonly task_ids: readonly string[]
          readonly reason: string
      }
    | StageSuspend

/**
 * The facade's `runE2eEmit`, threaded into the record legs as a callback so the
 * crash-retry paths (`retryAuthorOrFail` / `retryAdjudicatorOrFail`) can re-enter
 * the emit dispatch without an author/suite → facade import cycle.
 */
export type EmitFn = (deps: E2eRunDeps, runId: string) => Promise<E2eAction>

// Apex-pinned (Decision 40): the author runs once per run, no human reviews its
// assertions, and they gate the run — same rationale as the spec-generator pin (Decision 21).
export const E2E_AUTHOR_MODEL = 'opus'
// D5 (Decision 40): a crashed/unparseable author earns ONE automatic re-spawn —
// mirrors the assessment coroutine's MAX_ASSESS_ATTEMPTS. Deliberate verdicts
// (blocked-escalate, needs-context) are FINAL and never retry.
export const MAX_AUTHOR_ATTEMPTS = 2
// ponytail: 90 (docs' 60 + a 50% margin) — live MCP exploration burns more turns
// than a diff read; bump if the author routinely hits the ceiling.
export const E2E_AUTHOR_MAX_TURNS = 90

export function errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

/** The zero-value `e2e_phase` shape (no manifest authored yet, no reopens spent). Every
 * writer spreads this under `s.e2e_phase ??` so a first write never has to restate it. */
export function defaultE2ePhase(): Pick<E2ePhase, 'manifest' | 'reopen_counts'> {
    return {manifest: [], reopen_counts: {}}
}

export async function markDone(
    deps: E2eRunDeps,
    runId: string,
    opts: {attempts: number; advisory?: string | undefined}
): Promise<void> {
    await deps.state.update(runId, (s) => ({
        ...s,
        e2e_phase: {
            ...(s.e2e_phase ?? defaultE2ePhase()),
            status: 'done' as const,
            reason: undefined,
            advisory: opts.advisory,
            attempts: opts.attempts,
            ended_at: nowIso(),
        },
    }))
}

export async function markFailed(deps: E2eRunDeps, runId: string, reason: string, attempts?: number): Promise<void> {
    await deps.state.update(runId, (s) => ({
        ...s,
        e2e_phase: {
            ...(s.e2e_phase ?? defaultE2ePhase()),
            status: 'failed' as const,
            reason,
            advisory: undefined,
            attempts: attempts ?? s.e2e_phase?.attempts,
            ended_at: nowIso(),
        },
    }))
    log.warn(`run '${runId}': e2e phase failed — ${reason}`)
}

/** One join hit: a failed spec + the manifest entry that names it, or `undefined` if unmapped. */
export function findEntry(manifest: readonly E2eManifestEntry[], spec: E2eSpecResult): E2eManifestEntry | undefined {
    return manifest.find((e) => specPathMatches(spec.file, e.spec_path))
}

/** Bidirectional suffix match — the Playwright reporter's `file` and the assessment
 * map's `spec_path` may each carry or lack the testDir prefix. The SINGLE join predicate
 * for both the manifest (findEntry / criticalMisses) and assessment sides — a one-directional
 * variant here false-misses a passing prefixed critical and reopens an all-green suite to death. */
export function specPathMatches(file: string, specPath: string): boolean {
    return file === specPath || file.endsWith(`/${specPath}`) || specPath.endsWith(`/${file}`)
}

/** A tooling-level failure (nonzero exit / reporter `errors[]`) that no individual spec's
 * status explains — unattributable to any task, so the run fails outright rather than
 * absorbing it into a critical-miss reopen. */
export function unattributableToolingFailure(r: {
    readonly ok: boolean
    readonly specs: readonly E2eSpecResult[]
}): boolean {
    return !r.ok && r.specs.every((s) => s.status !== 'failed')
}
