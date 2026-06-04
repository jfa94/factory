/**
 * WS4 — Maps a {@link QuotaDecision} to the FROZEN {@link QuotaCheckpoint} shape +
 * the matching {@link RunStatus} the driver must persist, and the resume-clearing
 * patch (Decision 24, Δ E/F).
 *
 * The WS1 cross-field invariant is "a quota checkpoint is present IFF the run is
 * paused|suspended". This module honors that BY CONSTRUCTION: it pairs the
 * checkpoint with the right status (`pause-5h` → `paused`, `suspend-7d` →
 * `suspended`) and {@link clearCheckpoint} returns `quota: undefined` paired with
 * `status: "running"`. The driver (WS10) owns the `StateManager.update` call; this
 * module only produces the typed patch — it never writes state.
 *
 * `proceed` and `unavailable-halt` are intentionally NOT checkpointable here:
 * `proceed` is a non-event (no patch), and `unavailable-halt` has no observed
 * reset horizon. {@link buildCheckpoint} narrows to the two checkpointable
 * decisions at the type level so a caller cannot ask for a checkpoint that the
 * invariant would reject.
 */
import { QuotaCheckpointSchema } from "../types/index.js";
import type { QuotaCheckpoint, RunStatus } from "../types/index.js";
import type { QuotaDecision } from "./pacer.js";

/** The two decisions that produce a persisted quota checkpoint. */
export type CheckpointableDecision = Extract<QuotaDecision, { kind: "pause-5h" | "suspend-7d" }>;

/** A typed state patch the driver merges into a run via StateManager.update. */
export interface CheckpointPatch {
  status: RunStatus;
  quota: QuotaCheckpoint;
}

/** A typed patch that clears the checkpoint on resume. */
export interface ClearCheckpointPatch {
  status: RunStatus;
  quota: undefined;
}

/**
 * Build the persist patch for a pause/suspend decision: the right status paired
 * with a validated {@link QuotaCheckpoint}. `pause-5h` → `paused`/binding `5h`;
 * `suspend-7d` → `suspended`/binding `7d`. The checkpoint is round-tripped through
 * {@link QuotaCheckpointSchema} so a malformed shape is a loud parse error here,
 * not a deferred failure when the driver persists it.
 */
export function buildCheckpoint(decision: CheckpointableDecision): CheckpointPatch {
  switch (decision.kind) {
    case "pause-5h":
      return {
        status: "paused",
        quota: QuotaCheckpointSchema.parse({
          binding_window: "5h",
          resets_at_epoch: decision.resetsAtEpoch,
        }),
      };
    case "suspend-7d":
      return {
        status: "suspended",
        quota: QuotaCheckpointSchema.parse({
          binding_window: "7d",
          resets_at_epoch: decision.resetsAtEpoch,
        }),
      };
  }
}

/**
 * The resume-clearing patch: returns the run to `running` and drops the quota
 * checkpoint, so the WS1 "quota present IFF paused|suspended" invariant holds
 * after resume. The driver merges this into the persisted run.
 */
export function clearCheckpoint(): ClearCheckpointPatch {
  return { status: "running", quota: undefined };
}
