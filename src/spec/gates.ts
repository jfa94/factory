/**
 * WS5 — the three DETERMINISTIC spec gates.
 *
 * These run independently of (and before) the LLM review: they are structural,
 * cheap, and not subject to a model's judgment. Each returns
 * `{ passed, blockers[] }`; a non-empty `blockers` array BLOCKS the spec.
 *
 *   1. verticalSliceGate  — flags a purely-horizontal decomposition (a spec
 *      sliced by layer, not by end-to-end feature).
 *   2. testabilityGate    — per-criterion testability: every acceptance criterion
 *      must map to ≥1 `tests_to_write` entry AND be actionable (not vague).
 *   3. traceabilityGate   — BIDIRECTIONAL PRD traceability (PRD = axiom): every
 *      task ladders to a PRD requirement AND every PRD requirement is covered by
 *      ≥1 acceptance criterion. An uncovered requirement BLOCKS.
 */
import type {Prd} from './gh.js'
import type {SpecTask} from './schema.js'
import {nonNull} from '../shared/index.js'

/** Result of a single gate. */
export interface GateResult {
    passed: boolean
    blockers: string[]
}

/** Combine multiple gate results conjunctively (all must pass). */
export function combineGates(...results: GateResult[]): GateResult {
    const blockers = results.flatMap((r) => r.blockers)
    return {passed: blockers.length === 0, blockers}
}

// ---------------------------------------------------------------------------
// 0. Specifiability gate (S9) — pre-generation, PRD-body-only
// ---------------------------------------------------------------------------

/** Minimum non-heading, non-blank PRD content (chars) for a specifiable body. */
const MIN_PRD_BODY_CHARS = 200

/** Heading text that counts as an acceptance-criteria-shaped section. */
const AC_SECTION_HEADING =
    /^(acceptance[ -]criteria|acceptance[ -]tests?|success[ -]criteria|definition[ -]of[ -]done)\b/i

/**
 * Deterministic pre-GENERATION refusal (S9, Decision 47): can this PRD body
 * support spec generation at all? Unlike gates 1–3 (which judge a GENERATED
 * spec), this runs in `resolveSpec` BEFORE any agent spawn — a refusal costs
 * zero agent turns. All three checks always run; the blocker list tells the
 * PRD author exactly what to add.
 */
export function specifiabilityGate(body: string): GateResult {
    const blockers: string[] = []
    const lines = body.split(/\r?\n/).map((l) => l.trim())

    const content = lines.filter((l) => l.length > 0 && !/^#{1,6}\s/.test(l)).join('\n')
    if (content.length < MIN_PRD_BODY_CHARS) {
        blockers.push(
            `specifiability: PRD body is trivial (${content.length} chars of content, ` +
                `minimum ${MIN_PRD_BODY_CHARS}) — describe the problem, the desired behavior, and constraints`
        )
    }

    if (extractPrdRequirements(body).length === 0) {
        blockers.push(
            'specifiability: no extractable requirements — add bulleted requirements or ' +
                'normative (must/should) sentences outside Out-of-Scope/Non-Goals sections'
        )
    }

    const hasAcSection = lines.some((l) => {
        const heading = /^#{1,6}\s+(.*)$/.exec(l)
        return heading !== null && AC_SECTION_HEADING.test(nonNull(heading[1]).trim())
    })
    if (!hasAcSection) {
        blockers.push(
            'specifiability: no acceptance-criteria-shaped section — add an "## Acceptance Criteria" ' +
                '(or Definition of Done / Success Criteria) section stating verifiable outcomes'
        )
    }

    return {passed: blockers.length === 0, blockers}
}

// ---------------------------------------------------------------------------
// 1. Vertical-slice gate
// ---------------------------------------------------------------------------

/**
 * Words that signal a horizontal LAYER rather than a vertical feature slice. A
 * decomposition where (almost) every task title is a bare layer name is the
 * anti-pattern this gate flags.
 */
const HORIZONTAL_MARKERS = [
    'schema',
    'database',
    'migration',
    'model',
    'models',
    'backend',
    'frontend',
    'ui',
    'api layer',
    'data layer',
    'service layer',
    'controllers',
    'routes',
    'styling',
    'css',
    'types',
    'interfaces',
    'tests',
]

function looksHorizontal(title: string): boolean {
    const t = title.trim().toLowerCase()
    // A short, bare layer name (e.g. "Database schema", "Frontend") is the smell;
    // a title that merely mentions a layer inside a feature ("Add checkout API
    // route for cart") is fine, so require the layer marker to dominate a SHORT
    // title.
    if (t.split(/\s+/).length > 4) {
        return false
    }
    return HORIZONTAL_MARKERS.some((m) => t === m || t.startsWith(m + ' ') || t.endsWith(' ' + m))
}

/**
 * Flag a purely-horizontal decomposition. With a single task there is no
 * decomposition to judge (a one-task spec is trivially a slice). With ≥2 tasks,
 * if EVERY task looks like a bare horizontal layer, the spec is horizontal.
 */
export function verticalSliceGate(tasks: SpecTask[]): GateResult {
    if (tasks.length <= 1) {
        return {passed: true, blockers: []}
    }

    const horizontal = tasks.filter((t) => looksHorizontal(t.title))
    if (horizontal.length === tasks.length) {
        return {
            passed: false,
            blockers: [
                `vertical-slice: decomposition is purely horizontal — every task is a layer ` +
                    `(${horizontal.map((t) => t.task_id).join(', ')}); slice by end-to-end feature instead`,
            ],
        }
    }
    return {passed: true, blockers: []}
}

// ---------------------------------------------------------------------------
// 2. Per-criterion testability gate
// ---------------------------------------------------------------------------

/** Phrases that make a criterion non-actionable / unverifiable. */
const VAGUE_MARKERS = [
    'works well',
    'works correctly',
    'works properly',
    'as expected',
    'user-friendly',
    'easy to use',
    'intuitive',
    'fast enough',
    'performant',
    'good performance',
    'robust',
    'reliable',
    'handle errors gracefully',
    'looks good',
    'high quality',
    'etc.',
    'and so on',
]

/** Significant words shared between a criterion and a test description. */
function keywords(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length >= 4)
    )
}

function isVague(criterion: string): boolean {
    const c = criterion.trim().toLowerCase()
    if (c.length < 8) {
        return true
    }
    return VAGUE_MARKERS.some((m) => c.includes(m))
}

/**
 * A criterion is "covered" by a test if they share ≥1 significant keyword. This
 * is a deliberately conservative heuristic: it catches a criterion with NO
 * related test at all (the failure the gate exists to block) without demanding a
 * brittle exact mapping.
 */
function hasCoveringTest(criterion: string, tests: string[]): boolean {
    const ck = keywords(criterion)
    if (ck.size === 0) {
        return false
    }
    return tests.some((t) => {
        const tk = keywords(t)
        for (const w of ck) {
            if (tk.has(w)) {
                return true
            }
        }
        return false
    })
}

/**
 * Each acceptance criterion must (a) be actionable (not vague) and (b) map to ≥1
 * `tests_to_write` entry. A criterion failing either condition BLOCKS, cited by
 * task + criterion text.
 */
export function testabilityGate(tasks: SpecTask[]): GateResult {
    const blockers: string[] = []
    for (const task of tasks) {
        for (const criterion of task.acceptance_criteria) {
            if (isVague(criterion)) {
                blockers.push(`testability: task ${task.task_id} has a vague/non-actionable criterion: "${criterion}"`)
                continue
            }
            if (!hasCoveringTest(criterion, task.tests_to_write)) {
                blockers.push(
                    `testability: task ${task.task_id} criterion "${criterion}" has no covering tests_to_write entry`
                )
            }
        }
    }
    return {passed: blockers.length === 0, blockers}
}

// ---------------------------------------------------------------------------
// 3. Bidirectional PRD traceability gate (PRD = axiom)
// ---------------------------------------------------------------------------

/**
 * Headings whose section content is explicitly NOT a requirement — extracting
 * these would make the traceability gate demand the spec cover an exclusion
 * (or push the spec-generator to build it).
 */
const EXCLUDED_SECTION_HEADING = /^(out[ -]of[ -]scope|non[- ]?goals?|not doing|won'?t do)\b/i

/**
 * Extract atomic PRD requirements from the body. Heuristic: each markdown bullet
 * / numbered list item / "must|should|shall" sentence is a requirement. The PRD
 * is the AXIOM — every extracted requirement must be covered by ≥1 acceptance
 * criterion across the spec. Content under an exclusion heading (Out of Scope /
 * Non-Goals / …) is skipped until the next heading of equal or higher level.
 */
export function extractPrdRequirements(body: string): string[] {
    const lines = body.split(/\r?\n/)
    const reqs: string[] = []
    // ponytail: heading-level skip flag, not a markdown AST.
    let skipLevel: number | null = null
    for (const raw of lines) {
        const line = raw.trim()
        if (line.length === 0) {
            continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
            const level = nonNull(heading[1]).length
            if (skipLevel !== null && level <= skipLevel) {
                skipLevel = null
            }
            if (EXCLUDED_SECTION_HEADING.test(nonNull(heading[2]).trim())) {
                skipLevel = level
            }
            continue
        }
        if (skipLevel !== null) {
            continue
        }
        // Bullet / numbered list item.
        const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
        const bulletBody = bullet?.[1]
        if (bulletBody != null && bulletBody.trim().length > 0) {
            reqs.push(bulletBody.trim())
            continue
        }
        // Normative sentence.
        if (/\b(must|shall|should|need to|required to)\b/i.test(line) && !line.startsWith('#')) {
            reqs.push(line)
        }
    }
    return reqs
}

/** Does any acceptance criterion (across all tasks) cover this requirement? */
function requirementCovered(requirement: string, allCriteria: string[]): boolean {
    const rk = keywords(requirement)
    if (rk.size === 0) {
        return true
    } // nothing meaningful to cover
    return allCriteria.some((c) => {
        const ck = keywords(c)
        let shared = 0
        for (const w of rk) {
            if (ck.has(w)) {
                shared++
            }
        }
        // Require ≥2 shared significant keywords (or ≥1 when the requirement is tiny)
        // so an incidental single-word overlap doesn't count as coverage.
        return shared >= Math.min(2, rk.size)
    })
}

/** Does this task ladder to any PRD requirement? */
function taskLaddersToPrd(task: SpecTask, requirements: string[]): boolean {
    const text = [task.title, task.description, ...task.acceptance_criteria].join(' ')
    const tk = keywords(text)
    if (requirements.length === 0) {
        return false
    }
    return requirements.some((r) => {
        const rk = keywords(r)
        for (const w of rk) {
            if (tk.has(w)) {
                return true
            }
        }
        return false
    })
}

/**
 * BIDIRECTIONAL traceability (Δ — PRD = axiom):
 *   - forward:  every task must ladder to ≥1 PRD requirement (no orphan work);
 *   - backward: every PRD requirement must be covered by ≥1 acceptance criterion
 *     (no dropped requirement). An uncovered requirement BLOCKS.
 */
export function traceabilityGate(prd: Prd, tasks: SpecTask[]): GateResult {
    const requirements = extractPrdRequirements(prd.body)
    const allCriteria = tasks.flatMap((t) => t.acceptance_criteria)
    const blockers: string[] = []

    if (requirements.length === 0) {
        blockers.push(
            `traceability: PRD #${prd.issue_number} yielded no extractable requirements — ` +
                `cannot verify the spec covers it (PRD is the axiom)`
        )
        return {passed: false, blockers}
    }

    // Backward: PRD → criteria (the axiom direction).
    for (const req of requirements) {
        if (!requirementCovered(req, allCriteria)) {
            blockers.push(`traceability: PRD requirement has no covering acceptance criterion: "${req}"`)
        }
    }

    // Forward: task → PRD (no orphan work).
    for (const task of tasks) {
        if (!taskLaddersToPrd(task, requirements)) {
            blockers.push(`traceability: task ${task.task_id} ("${task.title}") does not ladder to any PRD requirement`)
        }
    }

    return {passed: blockers.length === 0, blockers}
}

/** Run all three deterministic gates conjunctively. */
export function runSpecGates(prd: Prd, tasks: SpecTask[]): GateResult {
    return combineGates(verticalSliceGate(tasks), testabilityGate(tasks), traceabilityGate(prd, tasks))
}
