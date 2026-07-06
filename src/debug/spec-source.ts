/**
 * Report → spec adapter for `/factory:debug` (Decision 39 rebuild, Task 3).
 *
 * The existing spec pipeline (`resolveSpec`/`gateSpec`/`storeSpec` in
 * `src/spec/build.ts`) fetches a PRD via an injectable {@link GhClient}
 * keyed by a positive-integer "issue number," then runs the SAME
 * spec-generator ⇄ spec-reviewer loop regardless of where the PRD came from.
 * `/factory:debug` feeds that unchanged loop a SYNTHETIC "PRD" rendered from a
 * whole-scope review report (`AdjudicateWholeScopeResult.confirmedBlockers`,
 * `src/debug/review.ts`) instead of a real GitHub issue.
 *
 * This module owns exactly three things, and nothing else:
 *   1. {@link debugIssueNumber} — a synthetic issue-number scheme
 *      (`DEBUG_ISSUE_BASE + passNumber`) that can never collide with a real
 *      GitHub issue number (GitHub issue numbers never reach 2 billion).
 *   2. {@link ReportGhClient} — a network-free {@link GhClient} that returns a
 *      synthesized {@link Prd} instead of shelling out to `gh`.
 *   3. {@link buildDebugReport} / {@link wireDebugSpecDeps} — render the
 *      synthetic PRD body from confirmed blockers, and wire a
 *      `SpecBuildDeps` that swaps in `ReportGhClient` while reusing the SAME
 *      `SpecStore`/`dataDir` as real specs (debug specs are isolated from real
 *      PRD-issue specs purely by the synthetic issue-number range, never by a
 *      separate store).
 *
 * `resolveSpec`/`gateSpec`/`storeSpec` themselves are imported UNCHANGED from
 * `src/spec/build.ts` — this module never forks or reimplements them; only
 * the `SpecBuildDeps` passed in differs.
 */
import type {Config} from '../config/index.js'
import {loadConfig, resolveDataDir} from '../config/index.js'
import {defaultSpecBuildRoot} from '../core/state/paths.js'
import {SpecStore, type GhClient, type Prd, type SpecBuildDeps} from '../spec/index.js'
import type {Finding} from '../verifier/judgment/finding.js'

/**
 * Base of the synthetic issue-number range reserved for `/factory:debug`
 * "PRDs". Real GitHub issue numbers are always well under this (GitHub's own
 * issue/PR numbering is a per-repo monotonic counter that has never
 * approached 2 billion), so `DEBUG_ISSUE_BASE + passNumber` can never collide
 * with a real PRD-issue spec's lookup key in {@link SpecStore.resolveByIssue}.
 */
export const DEBUG_ISSUE_BASE = 2_000_000_000

/**
 * Derive the synthetic issue number for a debug pass. `passNumber` is
 * 1-based (pass 1, pass 2, …) so a rerun's revise passes never collide.
 *
 * @throws if `passNumber` is not a positive integer.
 */
export function debugIssueNumber(passNumber: number): number {
    if (!Number.isInteger(passNumber) || passNumber < 1) {
        throw new Error(`debugIssueNumber: passNumber must be a positive integer, got ${passNumber}`)
    }
    return DEBUG_ISSUE_BASE + passNumber
}

/**
 * A network-free {@link GhClient} that returns a synthesized {@link Prd} built
 * from a whole-scope review report, instead of shelling out to `gh`. The
 * `issueNumber`/`opts.repo` the caller passes are both IGNORED for content
 * purposes — `issueNumber` is echoed back into the returned `Prd` (so the
 * synthetic PRD is self-consistent with whatever key `resolveSpec` used to
 * fetch it), and `opts.repo` is accepted only to satisfy the {@link GhClient}
 * signature.
 */
export class ReportGhClient implements GhClient {
    constructor(private readonly report: {readonly title: string; readonly body: string}) {}

    fetchPrd(issueNumber: number, _opts?: {repo?: string}): Promise<Prd> {
        return Promise.resolve({
            issue_number: issueNumber,
            title: this.report.title,
            body: this.report.body,
            labels: ['factory-debug'],
            body_truncated: false,
        })
    }
}

/** Input to {@link buildDebugReport}. */
export interface BuildDebugReportInput {
    /** Confirmed blockers from `adjudicateWholeScope` (Task 1/2). */
    readonly confirmedBlockers: readonly Finding[]
    /** 1-based debug pass number (mirrors {@link debugIssueNumber}'s input). */
    readonly passNumber: number
    /** The diff base (git ref or empty-tree SHA) the whole-scope review scanned. */
    readonly base: string
}

/** One rendered finding line-group within its reviewer's section. */
function renderFinding(finding: Finding): string {
    const citation =
        finding.file !== undefined && finding.line !== undefined ? `${finding.file}:${finding.line}` : '(no citation)'
    return [`### [${finding.severity}] ${citation}`, '', `> ${finding.quote}`, '', finding.description].join('\n')
}

/**
 * Render `confirmedBlockers` as markdown grouped by reviewer, in the order
 * each reviewer first appears. This becomes the synthetic PRD `body` the
 * unchanged spec-generator agent reads, so it is deliberately prose — a
 * readable findings write-up, not a JSON dump — similar in spirit to a
 * human-written PRD issue body.
 */
function renderFindingsBody(confirmedBlockers: readonly Finding[]): string {
    const byReviewer = new Map<string, Finding[]>()
    for (const finding of confirmedBlockers) {
        const bucket = byReviewer.get(finding.reviewer)
        if (bucket) {
            bucket.push(finding)
        } else {
            byReviewer.set(finding.reviewer, [finding])
        }
    }

    const sections: string[] = []
    for (const [reviewer, findings] of byReviewer) {
        sections.push(`## ${reviewer}`, '', findings.map(renderFinding).join('\n\n'))
    }
    return sections.join('\n\n')
}

/**
 * Render one acceptance criterion per confirmed blocker. S9 (Decision 47): the
 * specifiability gate is UNIVERSAL — no debug bypass — so the synthetic PRD
 * carries a real AC section, which also hands the spec pipeline the exactly
 * right axiom for a debug pass: every confirmed finding is fixed.
 */
function renderAcceptanceCriteria(confirmedBlockers: readonly Finding[]): string {
    const bullets = confirmedBlockers.map((f) => {
        const citation = f.file !== undefined && f.line !== undefined ? `${f.file}:${f.line}` : '(no citation)'
        return `- The finding at ${citation} (${f.severity}, ${f.reviewer}) is fixed.`
    })
    return ['## Acceptance Criteria', '', ...bullets].join('\n')
}

/**
 * Build the synthetic "PRD" a debug pass feeds into the unchanged spec
 * pipeline: `title` names the pass + blocker count, `body` is a markdown
 * write-up of every confirmed blocker (reviewer, severity, file:line, quote,
 * description — grouped by reviewer) with a header naming the scan base. This
 * must give the spec-generator agent ENOUGH signal to author a real spec, not
 * merely a serialized findings dump.
 */
export function buildDebugReport(input: BuildDebugReportInput): {
    readonly title: string
    readonly body: string
} {
    const {confirmedBlockers, passNumber, base} = input
    const title = `factory debug pass ${passNumber} — ${confirmedBlockers.length} blocking finding(s)`

    const header = [
        `# Factory Debug Pass ${passNumber}`,
        '',
        `Scan base: \`${base}\``,
        '',
        `${confirmedBlockers.length} blocking finding(s) confirmed by the whole-scope review panel. ` +
            'Each finding below is a citation-verified, independently-confirmed blocker (reviewer, ' +
            "severity, exact file:line, the quoted offending code, and the reviewer's description). " +
            'Treat this as the PRD: derive tasks that fix every finding below.',
    ].join('\n')

    const body =
        confirmedBlockers.length === 0
            ? `${header}\n\n(no confirmed blockers)`
            : `${header}\n\n${renderFindingsBody(confirmedBlockers)}\n\n${renderAcceptanceCriteria(confirmedBlockers)}`

    return {title, body}
}

/**
 * Wire a debug-specific `SpecBuildDeps`, mirroring `wireDeps()` in
 * `src/cli/subcommands/spec.ts`. Debug specs reuse the SAME
 * `SpecStore`/`dataDir` as real PRD-issue specs — isolation from real specs
 * comes from the synthetic issue-number range ({@link DEBUG_ISSUE_BASE}), not
 * from a separate store. `gh` is swapped for a {@link ReportGhClient} seeded
 * with the rendered report so the unchanged `resolveSpec`/`gateSpec`/`storeSpec`
 * never touch the network. The generate/review scratch root is the OS temp dir
 * ({@link defaultSpecBuildRoot}), same as the real spec CLI — it is transient
 * pre-validation agent output, not durable state, so it does not share `dataDir`.
 */
export function wireDebugSpecDeps(
    report: {readonly title: string; readonly body: string},
    dataDirOverride?: string
): SpecBuildDeps {
    const dataDir = dataDirOverride ?? resolveDataDir({})
    const config: Config = loadConfig({dataDir})
    return {
        store: new SpecStore({dataDir}),
        gh: new ReportGhClient(report),
        config,
        scratchRoot: defaultSpecBuildRoot(),
    }
}
