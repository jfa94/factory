/**
 * WS4 — The injectable usage-signal seam + the default statusline-cache reader
 * (Decision 24; ports the fail-closed contract of `bin/pipeline-quota-check`).
 *
 * The pacer routes on a typed {@link UsageReading} discriminated union, never on
 * a thrown error: `unavailable` is a FIRST-CLASS value (the bash sentinel) that
 * the pacer maps to a clean halt. Every degraded-cache condition the bash script
 * routed to its sentinel — missing file, malformed JSON, missing fields,
 * missing/non-numeric `resets_at`, a cache > 3600s stale, a `resets_at` already
 * in the past — becomes `{ kind: "unavailable", reason }` here. Absence and
 * staleness NEVER open the gate.
 *
 * The {@link UsageSignal} interface lets units test the pacer with a fake, so no
 * statusline file is needed to exercise the decision logic.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseJson } from "../shared/json.js";
import { nowEpoch as defaultNowEpoch } from "../shared/time.js";
import { createLogger } from "../shared/logging.js";
import { resolveDataDir, type DataDirOptions } from "../config/load.js";

const log = createLogger("quota:usage");

/** Hard staleness ceiling, seconds. A cache older than this is a prior session. */
export const STALE_CEILING_SECONDS = 3600;
/** Soft staleness threshold, seconds. Older than this warns but is still usable. */
export const STALE_WARN_SECONDS = 120;

/** A specific, closed reason a reading is unavailable (matches the bash sentinels). */
export type UnavailableReason =
  | "usage-cache-missing"
  | "usage-cache-malformed"
  | "usage-cache-fields-missing"
  | "resets-at-missing"
  | "usage-cache-too-stale"
  | "five-hour-window-reset"
  | "seven-day-window-reset";

/** Per-window observation: current utilization (%) + the reset horizon (epoch s). */
export interface WindowUsage {
  /** Utilization percentage in [0, ∞); the bash truncates floats to int — we keep the number. */
  utilizationPct: number;
  /** Epoch SECONDS when this window resets. */
  resetsAtEpoch: number;
}

/**
 * A usage observation. `available` carries both windows + the capture time;
 * `unavailable` is the fail-closed sentinel the pacer halts on. This is a value,
 * not an exception — observability gaps are routed, not thrown.
 */
export type UsageReading =
  | {
      kind: "available";
      fiveHour: WindowUsage;
      sevenDay: WindowUsage;
      /** Epoch SECONDS the statusline cache was written. */
      capturedAt: number;
    }
  | { kind: "unavailable"; reason: UnavailableReason };

/** The seam the pacer consumes. Fakeable in units; the default reads the cache. */
export interface UsageSignal {
  read(): Promise<UsageReading>;
}

/**
 * Zod shape of `usage-cache.json` as written by `statusline-wrapper.sh`. Every
 * numeric is epoch SECONDS or a percentage. We accept the raw shape loosely
 * (numbers may be null/absent on a degraded cache) and map degradation to the
 * unavailable sentinel ourselves, rather than letting Zod throw — the bash
 * contract is "degraded ⇒ sentinel", not "degraded ⇒ crash".
 */
const RawWindowSchema = z
  .object({
    used_percentage: z.unknown().optional(),
    resets_at: z.unknown().optional(),
  })
  .passthrough();

const RawCacheSchema = z
  .object({
    five_hour: RawWindowSchema.optional(),
    seven_day: RawWindowSchema.optional(),
    captured_at: z.unknown().optional(),
  })
  .passthrough();

/** Coerce an unknown JSON scalar to a finite number, or null if not numeric. */
function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function unavailable(reason: UnavailableReason): UsageReading {
  return { kind: "unavailable", reason };
}

/**
 * Pure mapper: raw parsed cache JSON + `nowEpoch` → {@link UsageReading},
 * applying the full bash fail-closed ladder in order. Exported for direct unit
 * testing without touching the filesystem.
 */
export function readingFromCache(raw: unknown, nowEpoch: number): UsageReading {
  const parsed = RawCacheSchema.safeParse(raw);
  if (!parsed.success) {
    return unavailable("usage-cache-malformed");
  }
  const cache = parsed.data;

  // Freshness: a non-numeric captured_at coerces to 0 (bash does the same), which
  // then trips the >3600s ceiling — fail-closed, never proceed on unknown age.
  const capturedAt = asFiniteNumber(cache.captured_at) ?? 0;
  const age = nowEpoch - capturedAt;
  if (age > STALE_CEILING_SECONDS) {
    return unavailable("usage-cache-too-stale");
  }
  if (age > STALE_WARN_SECONDS) {
    log.warn(`usage-cache.json is ${age}s old (>${STALE_WARN_SECONDS}s) — data may be stale`);
  }

  const fivePct = asFiniteNumber(cache.five_hour?.used_percentage);
  const sevenPct = asFiniteNumber(cache.seven_day?.used_percentage);
  if (fivePct === null || sevenPct === null) {
    return unavailable("usage-cache-fields-missing");
  }

  const fiveResets = asFiniteNumber(cache.five_hour?.resets_at);
  const sevenResets = asFiniteNumber(cache.seven_day?.resets_at);
  if (fiveResets === null || sevenResets === null) {
    return unavailable("resets-at-missing");
  }

  // Post-reset stale guard: a resets_at already in the past means the cache
  // reflects a previous window (Claude Code only refreshes rate_limits on its own
  // API responses). Treat as unavailable so the gate fails closed.
  if (fiveResets <= nowEpoch) {
    return unavailable("five-hour-window-reset");
  }
  if (sevenResets <= nowEpoch) {
    return unavailable("seven-day-window-reset");
  }

  return {
    kind: "available",
    fiveHour: { utilizationPct: fivePct, resetsAtEpoch: fiveResets },
    sevenDay: { utilizationPct: sevenPct, resetsAtEpoch: sevenResets },
    capturedAt,
  };
}

/** Path to the statusline usage cache inside a data dir. */
export function usageCachePath(dataDir: string): string {
  return join(dataDir, "usage-cache.json");
}

/** Options for {@link StatuslineUsageSignal}. */
export interface StatuslineUsageOptions extends DataDirOptions {
  /** Injectable clock (epoch seconds) for deterministic tests. */
  now?: () => number;
}

/**
 * The default {@link UsageSignal}: reads `${dataDir}/usage-cache.json` (lock-free)
 * and maps it through {@link readingFromCache}. Any read/parse failure becomes the
 * appropriate unavailable sentinel — this reader NEVER throws on a degraded cache.
 */
export class StatuslineUsageSignal implements UsageSignal {
  private readonly opts: StatuslineUsageOptions;

  constructor(opts: StatuslineUsageOptions = {}) {
    this.opts = opts;
  }

  async read(): Promise<UsageReading> {
    const now = (this.opts.now ?? defaultNowEpoch)();
    let dataDir: string;
    try {
      dataDir = resolveDataDir(this.opts);
    } catch {
      // No data dir resolvable → the cache cannot exist. Fail closed.
      return unavailable("usage-cache-missing");
    }

    const file = usageCachePath(dataDir);
    if (!existsSync(file)) {
      log.warn(`usage-cache.json not found at ${file}; emitting unavailable sentinel`);
      return unavailable("usage-cache-missing");
    }

    let raw: unknown;
    try {
      raw = parseJson<unknown>(readFileSync(file, "utf8"), file);
    } catch {
      log.warn(`usage-cache.json is malformed at ${file}; emitting unavailable sentinel`);
      return unavailable("usage-cache-malformed");
    }

    return readingFromCache(raw, now);
  }
}

/** A fixed-reading fake {@link UsageSignal} for unit tests. */
export function fakeUsageSignal(reading: UsageReading): UsageSignal {
  return { read: async () => reading };
}
