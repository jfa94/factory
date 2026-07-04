/**
 * WS4 — Maps a {@link QuotaDecision} to the FROZEN {@link QuotaCheckpoint} shape +
 * the matching {@link RunStatus} the orchestrator must persist, and the resume-clearing
 * patch (Decision 24, Δ E/F).
 *
 * The WS1 cross-field invariant is "a quota checkpoint is present IFF the run is
 * paused|suspended". This module honors that BY CONSTRUCTION: it pairs the
 * checkpoint with the right status (`pause-5h` → `paused`, `suspend-7d` →
 * `suspended`) and {@link clearCheckpoint} returns `quota: undefined` paired with
 * `status: "running"`. The orchestrator (WS10) owns the `StateManager.update` call; this
 * module only produces the typed patch — it never writes state.
 *
 * `proceed` is intentionally NOT checkpointable (a non-event, no patch).
 * `unavailable-halt` gets its own builder ({@link buildUnavailableCheckpoint}):
 * it has no observed reset horizon, but it IS quota-caused, and the invariant
 * `run.quota` present ⇔ quota-caused stop is what lets planResume distinguish it
 * from a non-quota suspend (docs/e2e phase park), which carries no checkpoint
 * and clears unconditionally.
 */
import {QuotaCheckpointSchema} from '../types/index.js'
import type {QuotaCheckpoint, RunStatus} from '../types/index.js'
import type {QuotaDecision} from './pacer.js'

/** The two decisions that produce a persisted quota checkpoint. */
export type CheckpointableDecision = Extract<QuotaDecision, {kind: 'pause-5h' | 'suspend-7d'}>

/** A typed state patch the orchestrator merges into a run via StateManager.update. */
export interface CheckpointPatch {
    status: RunStatus
    quota: QuotaCheckpoint
}

/** A typed patch that clears the checkpoint on resume. */
export interface ClearCheckpointPatch {
    status: RunStatus
    quota: undefined
}

/**
 * Build the persist patch for a pause/suspend decision: the right status paired
 * with a validated {@link QuotaCheckpoint}. `pause-5h` → `paused`/binding `5h`;
 * `suspend-7d` → `suspended`/binding `7d`. The checkpoint is round-tripped through
 * {@link QuotaCheckpointSchema} so a malformed shape is a loud parse error here,
 * not a deferred failure when the orchestrator persists it.
 */
export function buildCheckpoint(decision: CheckpointableDecision): CheckpointPatch {
    switch (decision.kind) {
        case 'pause-5h':
            return {
                status: 'paused',
                quota: QuotaCheckpointSchema.parse({
                    binding_window: '5h',
                    resets_at_epoch: decision.resetsAtEpoch,
                }),
            }
        case 'suspend-7d':
            return {
                status: 'suspended',
                quota: QuotaCheckpointSchema.parse({
                    binding_window: '7d',
                    resets_at_epoch: decision.resetsAtEpoch,
                }),
            }
    }
}

/**
 * The persist patch for an unobservable usage signal: suspended with a
 * `binding_window:"unavailable"` checkpoint (no reset horizon — resume rechecks
 * the live signal like any window).
 */
export function buildUnavailableCheckpoint(): CheckpointPatch {
    return {
        status: 'suspended',
        quota: QuotaCheckpointSchema.parse({binding_window: 'unavailable'}),
    }
}

/**
 * The resume-clearing patch: returns the run to `running` and drops the quota
 * checkpoint, so the WS1 "quota present IFF paused|suspended" invariant holds
 * after resume. The orchestrator merges this into the persisted run.
 */
export function clearCheckpoint(): ClearCheckpointPatch {
    return {status: 'running', quota: undefined}
}
