/**
 * S1/3c self-heal regression guard — `next.ts` has emitted `work.stale` since the
 * stall-TTL landed, but nothing in `skills/pipeline-runner/SKILL.md` (the runner
 * protocol) ever consumed it: no `stale` branch in the `work` case, and no
 * non-completion wake source (a silently-dead spawn produces no completion event,
 * so the runner would never re-observe `work.stale` to act on it). Both gaps are
 * fixed in the SAME markdown (the runner has no compiled surface the typechecker
 * sees), so this scans it the same way `review-base-ref.test.ts` guards its own
 * protocol fact — a grep-guard is the only thing that catches a regression here.
 */
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {describe, expect, it} from 'vitest'

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..')
const skill = readFileSync(resolve(repoRoot, 'skills/pipeline-runner/SKILL.md'), 'utf8')

describe('runner protocol wires the S1/3c stall-TTL self-heal', () => {
    it('the work case consumes env.stale (not just env.ready)', () => {
        expect(skill).toContain('env.stale')
    })

    it('a stale task is stopped and re-driven WITHOUT --results (idempotent reset+respawn)', () => {
        expect(skill).toContain('TaskStop each tracked agent id')
        expect(skill).toMatch(/next-action --run <run_id> --task <task>\s+# WITHOUT --results/)
    })

    it('a still-running spawn is never killed on a stale flag (false-positive guard)', () => {
        expect(skill).toContain('check TaskList for whether its tracked agent task-ids are still')
        expect(skill).toContain('false positive')
    })

    // Decision 66: the HARD band — hung spawns are killed even if alive, before the
    // advisory stale handling; the engine bounds the loop via SPAWN_REDRIVE_CAP.
    it('the work case consumes env.hung and kills a hung spawn even if alive (no liveness check)', () => {
        expect(skill).toContain('env.hung')
        expect(skill).toContain('EVEN IF STILL RUNNING')
    })

    it('a hung task is re-driven WITHOUT --results and its over-cap failure is reported', () => {
        // Two re-drive sites (hung + stale) share the exact command shape.
        const redrives = skill.match(/next-action --run <run_id> --task <task>\s+# WITHOUT --results/g)
        expect(redrives?.length).toBeGreaterThanOrEqual(2)
        expect(skill).toContain('SPAWN_REDRIVE_CAP')
    })

    it('the runner arms a non-completion heartbeat sized to the configured TTL', () => {
        expect(skill).toContain('CronCreate')
        expect(skill).toContain('stallTtlMinutes')
    })

    it('compaction/resume recovery re-arms the heartbeat (session-scoped cron jobs do not survive it)', () => {
        expect(skill).toContain('re-arm the heartbeat')
    })
})
