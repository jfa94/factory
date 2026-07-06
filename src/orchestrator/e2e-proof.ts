/**
 * The fail-first proof (Decision 39 D5) — the trust boundary every autonomously-
 * authored critical spec must cross before it is merged: RED on the base branch
 * (with its control assertion GREEN, proving the base app itself booted) and GREEN
 * on the authoring worktree. Used by both the author record leg (fresh specs) and
 * the adjudication record leg (rewritten specs).
 */
import {join} from 'node:path'
import {ensureStageWorktree} from './stage-helpers.js'
import {runE2e, DefaultPlaywrightTool, provisionWorktree, type E2eManifestEntry, type E2eSpecResult} from './deps.js'
import {CONTROL_TITLE_PREFIX} from './e2e-schemas.js'
import {e2eBaseProofWorktreePath, scrubbedE2eEnv, type BootConfig} from './e2e-paths.js'
import {DefaultE2eFileOps, errText, type E2eRunDeps} from './e2e-shared.js'

interface ProofVerdict {
    readonly ok: boolean
    readonly reason: string
}

/**
 * True iff at least one CONTROL spec ran and all of them passed. A critical spec
 * with NO control-titled assertion at all is NOT vacuously green — the authoring
 * contract requires one (see `buildAuthorPrompt`); without it there's no way to
 * tell "the base app didn't boot" apart from "the feature doesn't exist yet."
 */
function classifyBaseRun(specs: readonly E2eSpecResult[]): {
    hasControl: boolean
    controlGreen: boolean
    journeyRed: boolean
} {
    const control = specs.filter((s) => s.title.toLowerCase().startsWith(CONTROL_TITLE_PREFIX))
    const journey = specs.filter((s) => !s.title.toLowerCase().startsWith(CONTROL_TITLE_PREFIX))
    return {
        hasControl: control.length > 0,
        controlGreen: control.length > 0 && control.every((s) => s.status === 'passed'),
        journeyRed: journey.length > 0 && journey.every((s) => s.status === 'failed'),
    }
}

/**
 * Fail-first proof (Decision 5): each critical spec must be RED on the base branch
 * (with its control assertion GREEN — proving the base app itself booted) and GREEN
 * on the author's worktree (staging + the new spec). Guards against a green-but-
 * meaningless autonomously-authored assertion; nothing here is human-reviewed.
 */
export async function proveCriticals(
    deps: E2eRunDeps,
    runId: string,
    critical: readonly E2eManifestEntry[],
    authorWorktree: string,
    boot: BootConfig
): Promise<ProofVerdict> {
    const cfg = deps.config.e2e
    const files = deps.files ?? new DefaultE2eFileOps()
    const tool = deps.playwright ?? new DefaultPlaywrightTool()
    const wtPath = e2eBaseProofWorktreePath(deps.dataDir, runId)
    const base = `origin/${deps.config.git.baseBranch}`
    // No fetch (proves against the already-fetched base) and no retry-reset (specs are
    // re-copied in fresh each pass).
    await ensureStageWorktree(deps.git, {
        worktree: wtPath,
        ref: base,
        branch: `e2e-base-proof-${runId}`,
        resetIfExists: false,
        provision: () =>
            (deps.provision ?? provisionWorktree)({
                path: wtPath,
                setupCommand: deps.config.quality.setupCommand,
            }),
    })

    try {
        for (const entry of critical) {
            await files.copySpec(join(authorWorktree, entry.spec_path), join(wtPath, entry.spec_path))
            // runE2e THROWS on tooling-level failure (missing Playwright binary, empty/
            // truncated reporter output) — convert to a ProofVerdict so the caller's
            // failWithCleanup path persists the failure instead of an uncaught crash.
            let baseResult
            try {
                baseResult = await runE2e(
                    {
                        cwd: wtPath,
                        env: scrubbedE2eEnv(cfg, boot),
                        replaceEnv: true,
                        testDir: entry.spec_path,
                    },
                    tool
                )
            } catch (err) {
                return {
                    ok: false,
                    reason: `fail-first proof: e2e tooling error running '${entry.spec_path}' against the base app: ${errText(err)}`,
                }
            }
            const {hasControl, controlGreen, journeyRed} = classifyBaseRun(baseResult.specs)
            if (!hasControl) {
                return {
                    ok: false,
                    reason:
                        `fail-first proof: '${entry.spec_path}' has no "${CONTROL_TITLE_PREFIX}"-titled ` +
                        'assertion — cannot verify the base app booted (required by the authoring contract)',
                }
            }
            if (!controlGreen) {
                return {
                    ok: false,
                    reason:
                        `fail-first proof: base worktree unusable for '${entry.spec_path}' — ` +
                        'its control assertion failed against the unmodified base app',
                }
            }
            if (!journeyRed) {
                return {
                    ok: false,
                    reason:
                        `fail-first proof: '${entry.spec_path}' did not fail against the base app ` +
                        '(vacuous-pass risk) — rejected',
                }
            }
            let stagingResult
            try {
                stagingResult = await runE2e(
                    {
                        cwd: authorWorktree,
                        env: scrubbedE2eEnv(cfg, boot),
                        replaceEnv: true,
                        testDir: entry.spec_path,
                    },
                    tool
                )
            } catch (err) {
                return {
                    ok: false,
                    reason: `fail-first proof: e2e tooling error running '${entry.spec_path}' against staging: ${errText(err)}`,
                }
            }
            if (!stagingResult.ok) {
                return {
                    ok: false,
                    reason: `fail-first proof: '${entry.spec_path}' is still red against staging`,
                }
            }
        }
        return {ok: true, reason: ''}
    } finally {
        await deps.git.worktreeRemove([wtPath, '--force'])
    }
}
