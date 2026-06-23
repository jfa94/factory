/**
 * Unit tests for the extracted {@link applyQuotaGate} module. Fixtures mirror
 * the quota-gate cases in loop.test.ts (same reading objects, same StateManager-
 * on-tmpdir harness) so behaviour is verifiable in isolation.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
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
const SUSPEND_7D = reading({ five: 0, seven: 21 }); // day-1 cap 20, 21 > 20 → suspend
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

  it("proceed leaves a stale paused checkpoint intact (caller owns recovery)", async () => {
    // Seed the run as paused with a quota checkpoint (a prior pause that was not yet
    // cleared by the caller — the run-level coroutine clears it, the gate does not).
    const checkpoint = { binding_window: "5h" as const, resets_at_epoch: NOW + 3600 };
    await state.update(RUN_ID, (s) => ({
      ...s,
      status: "paused",
      quota: checkpoint,
    }));

    const stop = await applyQuotaGate(makeDeps(PROCEED), RUN_ID);

    // The gate proceeds (healthy reading → null).
    expect(stop).toBeNull();
    // The gate MUST NOT touch state on a proceed — paused status + checkpoint intact.
    const run = await state.read(RUN_ID);
    expect(run.status).toBe("paused");
    expect(run.quota).toEqual(checkpoint);
  });

  it("workflow mode → proceeds (null) without reading usage or touching state", async () => {
    const read = vi.fn(async (): Promise<UsageReading> => UNAVAILABLE);
    const deps: QuotaGateDeps = {
      state,
      usage: { read },
      config: defaultConfig(),
      now: () => NOW,
    };
    const stop = await applyQuotaGate(deps, RUN_ID, "workflow");
    expect(stop).toBeNull();
    // The pacer is fully skipped — the usage signal is never consulted.
    expect(read).not.toHaveBeenCalled();
    const run = await state.read(RUN_ID);
    expect(run.status).toBe("running");
    expect(run.quota).toBeUndefined();
  });

  it("explicit session mode still fail-closes on an unobservable reading", async () => {
    const stop = await applyQuotaGate(makeDeps(UNAVAILABLE), RUN_ID, "session");
    expect(stop?.scope).toBe("unavailable");
    expect(stop?.run.status).toBe("suspended");
  });

  it("ignoreQuota=true → proceeds (null) without reading usage or touching state", async () => {
    const read = vi.fn(async (): Promise<UsageReading> => UNAVAILABLE);
    const deps: QuotaGateDeps = {
      state,
      usage: { read },
      config: defaultConfig(),
      now: () => NOW,
    };
    // Even a would-be suspension reading returns null when ignoreQuota is set.
    const stop = await applyQuotaGate(deps, RUN_ID, "session", true);
    expect(stop).toBeNull();
    expect(read).not.toHaveBeenCalled();
    const run = await state.read(RUN_ID);
    expect(run.status).toBe("running");
    expect(run.quota).toBeUndefined();
  });
});
