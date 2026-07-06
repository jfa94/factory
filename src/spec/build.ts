/**
 * The DETERMINISTIC spec-build seam (Model A): resolve → gate → store.
 *
 * The spec pipeline needs two live agent spawns (spec-generator + spec-reviewer),
 * which a `factory` subprocess cannot do (no Agent tool). So the in-process
 * {@link import("./pipeline.js").runSpecPipeline} is split into three
 * runner-sequenced reporter actions; the in-session runner owns the
 * agent spawns AND the bounded regeneration loop, this module owns the
 * deterministic glue (resolveByIssue / PRD fetch / spec gates / review
 * adjudication / store.write). The `factory spec` subcommand
 * (`src/cli/subcommands/spec.ts`) is a thin CLI wrapper; `/factory:debug`
 * (`src/debug/spec-source.ts`) reuses these UNCHANGED with a synthetic-PRD
 * `SpecBuildDeps` — living here (not in the CLI) keeps that reuse from
 * creating a cli↔debug package cycle.
 *
 * State is threaded through a TRANSIENT scratch dir, `specBuildDir(scratchRoot,repo,issue)`,
 * rooted at the OS temp dir (`defaultSpecBuildRoot()`) — NOT the plugin dataDir the
 * durable stores use, since this holds only pre-validation agent output, never
 * durable state. It holds three files: `prd.json` (written by `resolve`),
 * `generated.json` (written by the runner after spawning the generator), and
 * `verdict.json` (written by the runner after spawning the reviewer). Every action
 * takes a (repo, issue) pair and recomputes the scratch dir, so the runner never
 * threads paths by hand — each envelope also echoes the concrete paths.
 *
 * Loop (runner-owned):
 *   resolve → reuse(pointer)  → DONE (go straight to `run create`)
 *           → generate(spawn) → [spawn generator → write generated.json] → gate
 *   gate    → revise(blockers)→ [re-spawn generator with blockers] → gate          (≤ max_iterations)
 *           → review(spawn)   → [spawn reviewer → write verdict.json] → store
 *   store   → revise(reason)  → [re-spawn generator] → gate                         (≤ max_iterations)
 *           → stored(pointer) → DONE (go to `run create`)
 *
 * Mirrors {@link import("./pipeline.js").runSpecPipeline} exactly (same
 * gates, same 56/60+floor adjudication, same request construction) — the only
 * difference is WHO drives the agent spawns and the loop.
 */
import {join} from 'node:path'
import {atomicWriteFile} from '../shared/atomic-write.js'
import {stringifyJson, readJsonFile} from '../shared/json.js'
import {specBuildDir} from '../core/state/paths.js'
import {makeSpecId, type SpecStore} from './store.js'
import type {GhClient, Prd} from './gh.js'
import {runSpecGates, specifiabilityGate} from './gates.js'
import {decideSpecReview, parseReviewVerdict} from './review.js'
import {
    parseGenerateResult,
    buildGenerateSpawn,
    buildReviewSpawn,
    buildReviseSpawn,
    type SpecSpawnSpec,
    type GenerateContext,
    type ReviseContext,
    type ReviewContext,
    type GenerateResult,
} from './agents.js'
import type {Config, SpecPointer} from '../types/index.js'
import {parseSpecManifest, type SpecManifest} from './schema.js'
import {nowIso} from '../shared/time.js'

/** Scratch file names threaded between the three actions. */
const PRD_FILE = 'prd.json'
const GENERATED_FILE = 'generated.json'
const VERDICT_FILE = 'verdict.json'

/** The single JSON document each `factory spec` action emits — the runner's contract. */
export type SpecBuildEnvelope =
    | {
          /** An existing spec for this issue was reused (Δ X) — no generation needed. */
          readonly kind: 'reuse'
          readonly repo: string
          readonly issue: number
          readonly pointer: SpecPointer
      }
    | {
          /**
           * Deterministic pre-generation refusal (S9, Decision 47) — the PRD cannot
           * support spec generation. TERMINAL: the runner spawns NOTHING and stops
           * loud; `blockers` tells the PRD author exactly what to add. Zero agent cost.
           */
          readonly kind: 'unspecifiable'
          readonly repo: string
          readonly issue: number
          /** Scratch prd.json — already written, kept as an inspection aid. */
          readonly prd_path: string
          readonly blockers: readonly string[]
      }
    | {
          /** No spec yet — spawn the generator, then write `generated_path` and call `gate`. */
          readonly kind: 'generate'
          readonly repo: string
          readonly issue: number
          readonly spawn: SpecSpawnSpec<GenerateContext>
          readonly prd_path: string
          readonly generated_path: string
          /** The runner's bound on the generate/review loop (config.spec.maxRegenIterations). */
          readonly max_iterations: number
      }
    | {
          /** Gates passed — spawn the reviewer, then write `verdict_path` and call `store`. */
          readonly kind: 'review'
          readonly repo: string
          readonly issue: number
          readonly spawn: SpecSpawnSpec<ReviewContext>
          readonly generated_path: string
          readonly verdict_path: string
      }
    | {
          /** The spec needs revision (gate blockers OR a sub-threshold review) — patch + re-gate. */
          readonly kind: 'revise'
          readonly repo: string
          readonly issue: number
          readonly source: 'gate' | 'review'
          readonly reason: string
          readonly blockers: readonly string[]
          /**
           * The generator re-spawn, carrying the PRIOR spec + blockers so the agent patches
           * it rather than re-authoring from the PRD (symmetric with `generate`/`review`).
           * Invariant: `spawn.context.review_feedback` is built from `blockers` at the single
           * construction site below — the two never diverge.
           */
          readonly spawn: SpecSpawnSpec<ReviseContext>
          readonly generated_path: string
      }
    | {
          /** PASS — the spec is durably stored; the runner proceeds to `run create`. */
          readonly kind: 'stored'
          readonly repo: string
          readonly issue: number
          readonly pointer: SpecPointer
      }

/** The deps the testable cores need (injected in tests; production-wired by the CLI). */
export interface SpecBuildDeps {
    readonly store: SpecStore
    readonly gh: GhClient
    readonly config: Config
    /**
     * Root for the transient generate/review scratch files (NOT the plugin dataDir —
     * `store`/`config` already carry their own dataDir closure independently).
     * Production wiring points this at {@link defaultSpecBuildRoot} (the OS temp
     * dir); tests pass their own isolated tmp root for cleanup/collision safety.
     */
    readonly scratchRoot: string
}

/** Resolve the three scratch paths for a (repo, issue) build. */
function scratchPaths(
    scratchRoot: string,
    repo: string,
    issue: number
): {
    prdPath: string
    generatedPath: string
    verdictPath: string
} {
    const dir = specBuildDir(scratchRoot, repo, issue)
    return {
        prdPath: join(dir, PRD_FILE),
        generatedPath: join(dir, GENERATED_FILE),
        verdictPath: join(dir, VERDICT_FILE),
    }
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

/**
 * Reuse-or-begin: on a store hit return the pointer (Δ X — never regen); else fetch
 * the PRD, persist it to the scratch dir, and emit the apex-pinned generate spawn.
 *
 * Pass `regenerate: true` (from `--supersede`) to delete any existing durable spec
 * before the reuse check, forcing Phase 1 to regenerate from the PRD. Deletion is
 * mandatory — regen without delete risks two dirs for the same issue, which
 * `resolveByIssue` treats as a store-integrity error.
 */
export async function resolveSpec(
    deps: SpecBuildDeps,
    repo: string,
    issue: number,
    {regenerate = false}: {regenerate?: boolean} = {}
): Promise<SpecBuildEnvelope> {
    if (regenerate) {
        await deps.store.deleteByIssue(repo, issue)
    }
    const existing = await deps.store.resolveByIssue(repo, issue)
    if (existing) {
        return {kind: 'reuse', repo, issue, pointer: deps.store.toPointer(existing)}
    }

    const prd = await deps.gh.fetchPrd(issue, {repo})
    const {prdPath, generatedPath} = scratchPaths(deps.scratchRoot, repo, issue)
    await atomicWriteFile(prdPath, stringifyJson(prd))

    // S9 (Decision 47): deterministic specifiability refusal BEFORE any agent
    // spawn — an unspecifiable PRD never costs an apex generator turn.
    const specifiability = specifiabilityGate(prd.body)
    if (!specifiability.passed) {
        return {
            kind: 'unspecifiable',
            repo,
            issue,
            prd_path: prdPath,
            blockers: specifiability.blockers,
        }
    }

    return {
        kind: 'generate',
        repo,
        issue,
        spawn: buildGenerateSpawn(prd),
        prd_path: prdPath,
        generated_path: generatedPath,
        max_iterations: deps.config.spec.maxRegenIterations,
    }
}

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

/**
 * Run the deterministic spec gates against the generator's output. On a block, emit
 * `revise` (the runner re-spawns the generator with the blockers). On a pass,
 * emit the apex-pinned review spawn. `generated.json` is UNTRUSTED agent output, so
 * it is parsed loudly via {@link parseGenerateResult}.
 */
export async function gateSpec(deps: SpecBuildDeps, repo: string, issue: number): Promise<SpecBuildEnvelope> {
    const {prdPath, generatedPath, verdictPath} = scratchPaths(deps.scratchRoot, repo, issue)
    const prd = await readJsonFile<Prd>(prdPath)
    const generated = parseGenerateResult(await readJsonFile(generatedPath))

    const gates = runSpecGates(prd, generated.tasks)
    if (!gates.passed) {
        return {
            kind: 'revise',
            repo,
            issue,
            source: 'gate',
            reason: 'deterministic spec gates blocked the spec',
            blockers: gates.blockers,
            // review_feedback derives from these same blockers — single source, no divergence.
            spawn: buildReviseSpawn(prd, generated, gates.blockers),
            generated_path: generatedPath,
        }
    }

    return {
        kind: 'review',
        repo,
        issue,
        spawn: buildReviewSpawn(prd, generated),
        generated_path: generatedPath,
        verdict_path: verdictPath,
    }
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

/**
 * Adjudicate the reviewer verdict (single 56/60 threshold + any-dimension floor,
 * Δ I) against the generator output. On NEEDS_REVISION emit `revise`; on PASS build
 * the durable request and persist it, returning the run-facing pointer. Both
 * `generated.json` and `verdict.json` are UNTRUSTED agent output → parsed loudly.
 */
export async function storeSpec(deps: SpecBuildDeps, repo: string, issue: number): Promise<SpecBuildEnvelope> {
    const {prdPath, generatedPath, verdictPath} = scratchPaths(deps.scratchRoot, repo, issue)
    const generated = parseGenerateResult(await readJsonFile(generatedPath))
    const verdict = parseReviewVerdict(await readJsonFile(verdictPath))

    const decision = decideSpecReview(verdict, {
        passReviewThreshold: deps.config.spec.passReviewThreshold,
        dimensionFloor: deps.config.spec.dimensionFloor,
    })
    if (decision.decision === 'NEEDS_REVISION') {
        const blockers = verdict.blockers.length > 0 ? verdict.blockers : [decision.reason]
        // The revise spawn embeds the PRD (written by `resolve`, durable for the loop) so the
        // generator patches the prior spec against the reviewer's blockers, not re-derives it.
        const prd = await readJsonFile<Prd>(prdPath)
        return {
            kind: 'revise',
            repo,
            issue,
            source: 'review',
            reason: decision.reason,
            blockers,
            spawn: buildReviseSpawn(prd, generated, blockers),
            generated_path: generatedPath,
        }
    }

    const request = buildManifest(repo, issue, generated)
    // S9: snapshot the PRD durably beside the spec — the traceability stage reads
    // it at finalize time (no gh re-fetch; scratch prd.json is transient).
    const prd = await readJsonFile<Prd>(prdPath)
    const pointer = await deps.store.write(request, generated.specMd, prd)
    return {kind: 'stored', repo, issue, pointer}
}

/**
 * Build the durable request from a passing generate result. Exported so the
 * `factory spec store` CLI seam produces a request IDENTICALLY to any in-process
 * caller (one source of truth for slug re-derivation + spec-id construction).
 */
export function buildManifest(repo: string, issueNumber: number, generated: GenerateResult): SpecManifest {
    const specId = makeSpecId(issueNumber, generated.slug)
    // Re-derive the canonical slug from the spec_id so the request slug always
    // matches the path segment (the generator's raw slug is sanitized by makeSpecId).
    const slug = specId.replace(/^\d+-/, '')
    return parseSpecManifest({
        spec_id: specId,
        issue_number: issueNumber,
        slug,
        repo,
        generated_at: nowIso(),
        tasks: generated.tasks,
    })
}
