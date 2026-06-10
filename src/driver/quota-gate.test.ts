/**
 * Unit tests for the extracted {@link applyQuotaGate} module. Fixtures mirror
 * the quota-gate cases in loop.test.ts (same reading objects, same StateManager-
 * on-tmpdir harness) so behaviour is verifiable in isolation.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyQuotaGate } from "./quota-gate.js";
import type { QuotaGateDeps } from "./quota-gate.js";

import { StateManager } from "../core/state/manager.js";
import { fakeUsageSignal } from "../quota/usage-source.js";
import type { UsageReading } from "../quota/usage-source.js";
import { defaultConfig } from "../config/schema.js";

// ---------------------------------------------------------------------------
// fixtures (copied verbatim from loop.test.ts)
// ---------------------------------------------------------------------------

const RUN_ID = "run-quota-1";
/** Frozen epoch SECONDS — the unit the quota pacer windows are computed in. */
const NOW = 1_700_000_000;

/** Build a usage reading; both windows fresh + future-reset unless overridden. */
function reading(opts: {
  five: number;
  seven: number;
  fiveResets?: number;
  sevenResets?: number;
}): UsageReading {
  return {
    kind: "available",
    fiveHour: { utilizationPct: opts.five, resetsAtEpoch: opts.fiveResets ?? NOW + 18_000 },
    sevenDay: { utilizationPct: opts.seven, resetsAtEpoch: opts.sevenResets ?? NOW + 604_800 },
    capturedAt: NOW,
  };
}

const PROCEED = reading({ five: 0, seven: 0 });
const PAUSE_5H = reading({ five: 21, seven: 0 }); // hour-1 cap 20, 21 > 20 → pause
const SUSPEND_7D = reading({ five: 0, seven: 15 }); // day-1 cap 14, 15 > 14 → suspend
const UNAVAILABLE: UsageReading = { kind: "unavailable", reason: "usage-cache-missing" };

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

describe("applyQuotaGate", () => {
  let dataDir: string;
  let state: StateManager;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-quota-gate-"));
    state = new StateManager({
      dataDir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
    await state.create({
      run_id: RUN_ID,
      spec: { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 },
    });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function makeDeps(usage: UsageReading): QuotaGateDeps {
    return {
      state,
      usage: fakeUsageSignal(usage),
      config: defaultConfig(),
      now: () => NOW,
    };
  }

  // -------------------------------------------------------------------------

  it("proceed → null, state untouched", async () => {
    const stop = await applyQuotaGate(makeDeps(PROCEED), RUN_ID);
    expect(stop).toBeNull();
    // State must be untouched — status remains "running".
    const run = await state.read(RUN_ID);
    expect(run.status).toBe("running");
    expect(run.quota).toBeUndefined();
  });

  it("5h breach → persists paused checkpoint and returns scope 5h + horizon", async () => {
    const stop = await applyQuotaGate(makeDeps(PAUSE_5H), RUN_ID);
    expect(stop).not.toBeNull();
    expect(stop?.scope).toBe("5h");
    expect(stop?.resets_at_epoch).toBeTypeOf("number");
    expect(stop?.run.status).toBe("paused");
    // Confirm the patch was persisted.
    const run = await state.read(RUN_ID);
    expect(run.status).toBe("paused");
    expect(run.quota).toBeDefined();
  });

  it("7d breach → suspended + scope 7d", async () => {
    const stop = await applyQuotaGate(makeDeps(SUSPEND_7D), RUN_ID);
    expect(stop).not.toBeNull();
    expect(stop?.scope).toBe("7d");
    expect(stop?.resets_at_epoch).toBeTypeOf("number");
    expect(stop?.run.status).toBe("suspended");
    const run = await state.read(RUN_ID);
    expect(run.status).toBe("suspended");
  });

  it("unobservable reading → suspended + scope unavailable, no horizon", async () => {
    const stop = await applyQuotaGate(makeDeps(UNAVAILABLE), RUN_ID);
    expect(stop).not.toBeNull();
    expect(stop?.scope).toBe("unavailable");
    expect(stop?.resets_at_epoch).toBeUndefined();
    expect(stop?.run.status).toBe("suspended");
    const run = await state.read(RUN_ID);
    expect(run.status).toBe("suspended");
    expect(run.quota).toBeUndefined();
  });
});
