/**
 * 3b(ii) — compose the codex cross-vendor quality-reviewer's full prompt, spawned
 * VERBATIM by the runner (`codex exec ... "<cross_vendor.prompt>"`, fixed flags
 * stay runner-side per the plan). Mirrors the SAME charter + contract the
 * Claude-side quality-reviewer gets (`agents/quality-reviewer.md` +
 * `skills/review-protocol/SKILL.md`), read from the plugin root so it works from
 * any target-repo cwd — plus the worktree/base-ref pointer the protocol already
 * tells every reviewer to `git diff` themselves (review-protocol/SKILL.md:20-27).
 */
/* eslint-disable security/detect-non-literal-fs-filename -- pluginRoot is engine-resolved (CLAUDE_PLUGIN_ROOT/inference), never external input */
import {readFile} from 'node:fs/promises'
import path from 'node:path'

export interface ComposeCrossVendorPromptInput {
    /** The plugin root (`resolvePluginRoot()`), containing `agents/` and `skills/`. */
    readonly pluginRoot: string
    /** The base ref the reviewer diffs against. */
    readonly baseRef: string
    /** The worktree the reviewer inspects. */
    readonly worktree: string
    /**
     * D68 — the rendered disposition ledger (renderDispositionLedger), appended as
     * a final section when a prior round dismissed claims. The codex reviewer is a
     * PANEL reviewer, so it gets the same challengeable input document the
     * Claude-side panel gets. Omitted ⇒ byte-identical prompt to before D68.
     */
    readonly priorDispositions?: string
}

export async function composeCrossVendorPrompt(input: ComposeCrossVendorPromptInput): Promise<string> {
    const [charter, contract] = await Promise.all([
        readFile(path.join(input.pluginRoot, 'agents', 'quality-reviewer.md'), 'utf8'),
        readFile(path.join(input.pluginRoot, 'skills', 'review-protocol', 'SKILL.md'), 'utf8'),
    ])
    return [
        charter.trim(),
        '',
        contract.trim(),
        '',
        `Task worktree: \`${input.worktree}\`. Base ref: \`${input.baseRef}\`. Inspect the change with \`git -C ${input.worktree} diff ${input.baseRef}..HEAD\`.`,
        ...(input.priorDispositions !== undefined ? ['', input.priorDispositions] : []),
    ].join('\n')
}
