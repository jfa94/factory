/**
 * Decision 67 — the anti-ratcheting disposition ledger for review⇄fix rounds.
 *
 * A fresh-context panel reviewer has no memory of prior rounds, so a claim the
 * independent finding-verifier REFUTED in round N gets blindly re-raised in
 * round N+1, re-refuted, re-raised… never converging. This module composes the
 * per-round dismissed claims ({@link composeDispositions}), folds them across
 * rounds with a dedupe + cap ({@link appendDispositions} — containment only,
 * NEVER a gate), and renders them as a challengeable input document
 * ({@link renderDispositionLedger}) the orchestrator/runner appends to panel
 * reviewer prompts.
 *
 * Anti-anchoring boundary: the ledger goes to PANEL REVIEWERS only — never to a
 * finding-verifier (which must confirm independently, not be told what was
 * already dismissed). A reviewer with NEW evidence re-raises by prefixing its
 * finding description with "CHALLENGES PRIOR DISPOSITION:" — prose-only
 * convention, no Finding schema change; a challenged finding then survives or
 * dies on its own verifier confirmation like any other.
 */
import type {ReviewDisposition} from '../../core/state/index.js'
import type {Finding, RawReview} from './finding.js'
import type {AdjudicatedReviewer} from './panel-run.js'

/** Ledger size ceiling — oldest entries beyond it are dropped (bloat containment). */
export const DISPOSITION_CAP = 30

const collapseWs = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Fingerprint for cross-round dedupe: file + normalized quote + normalized claim. */
function fingerprintOf(d: ReviewDisposition): string {
    return `${d.file ?? ''}|${collapseWs(d.quote)}|${collapseWs(d.claim).toLowerCase()}`
}

function toDisposition(
    f: Finding,
    disposition: ReviewDisposition['disposition'],
    round: number,
    note?: string
): ReviewDisposition {
    return {
        reviewer: f.reviewer,
        disposition,
        ...(f.file !== undefined ? {file: f.file} : {}),
        ...(f.line !== undefined ? {line: f.line} : {}),
        quote: f.quote,
        claim: f.claim,
        ...(note !== undefined ? {note} : {}),
        round,
    }
}

/**
 * Compose THIS round's dispositions from the raw reviews + adjudicated panel:
 * refuted blockers (verifier-dismissed, with the refutation reason) and
 * non-blocking findings (advisory by the reviewer's own severity call).
 * Citation-DROPPED blockers are deliberately absent — they were never
 * adjudicated on merit, only on a bad quote; suppressing them would let a
 * mis-cited real defect vanish from every later round.
 */
export function composeDispositions(
    reviews: readonly RawReview[],
    adjudicated: readonly AdjudicatedReviewer[],
    round: number
): ReviewDisposition[] {
    const refuted = adjudicated.flatMap((a) =>
        a.refuted.map(({finding, reason}) => toDisposition(finding, 'refuted', round, reason))
    )
    const nonBlocking = reviews.flatMap((r) =>
        r.findings.filter((f) => !f.blocking).map((f) => toDisposition(f, 'non-blocking', round))
    )
    return [...refuted, ...nonBlocking]
}

/**
 * Fold a new round's dispositions onto the prior ledger: dedupe by fingerprint
 * (latest round wins — a re-adjudication updates the entry) and keep only the
 * newest {@link DISPOSITION_CAP} entries. Containment only — this function
 * never decides what gates; the merge gate remains verifier-derived.
 */
export function appendDispositions(
    prior: readonly ReviewDisposition[] | undefined,
    next: readonly ReviewDisposition[],
    cap: number = DISPOSITION_CAP
): ReviewDisposition[] {
    const byFingerprint = new Map<string, ReviewDisposition>()
    for (const d of [...(prior ?? []), ...next]) {
        byFingerprint.set(fingerprintOf(d), d)
    }
    return [...byFingerprint.values()].sort((a, b) => a.round - b.round).slice(-cap)
}

/**
 * Render the ledger as the challengeable input document appended VERBATIM to
 * panel reviewer prompts (never to a finding-verifier). Returns `undefined`
 * when there is nothing to render so callers can omit the field entirely.
 */
export function renderDispositionLedger(entries: readonly ReviewDisposition[] | undefined): string | undefined {
    if (entries === undefined || entries.length === 0) {
        return undefined
    }
    const lines = entries.map((d) => {
        const where = d.file !== undefined ? ` ${d.file}${d.line !== undefined ? `:${d.line}` : ''}` : ''
        const note = d.note !== undefined ? ` — ${collapseWs(d.note)}` : ''
        return `- [${d.disposition}, round ${d.round}, ${d.reviewer}]${where} — "${collapseWs(d.claim)}"${note}`
    })
    return [
        '## Previously adjudicated findings (input document — NOT shared belief-state)',
        '',
        'The claims below were dismissed in a prior review round: `refuted` means an',
        'independent verifier checked the claim against the code and it did not hold;',
        '`non-blocking` means it was raised advisory-only. Do NOT re-raise one as a new',
        'blocking finding on the same evidence. ONLY if you have NEW evidence that a',
        'disposition is wrong, raise the finding with its description prefixed',
        '"CHALLENGES PRIOR DISPOSITION:" and cite the new evidence. This list says',
        'nothing about the rest of the diff — review everything else with fresh eyes.',
        '',
        ...lines,
    ].join('\n')
}
