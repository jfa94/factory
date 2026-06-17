/**
 * CLI arg validators — unit tests for the closed-vocabulary parsers.
 *
 * `parseShipMode` validates against {@link ShipModeEnum} (the single source of
 * truth), so these tests pin that the CLI's accepted set tracks the enum: every
 * enum member is accepted, anything else is a loud `UsageError`, and an absent
 * flag is `undefined` (not a default — `loadCliDeps` falls back to the run's
 * persisted `ship_mode`).
 */
import { describe, it, expect } from "vitest";

import { parseShipMode, isUsageError } from "./args.js";
import { ShipModeEnum } from "../core/state/index.js";

describe("parseShipMode", () => {
  it("accepts every member of ShipModeEnum (CLI set tracks the enum)", () => {
    for (const mode of ShipModeEnum.options) {
      expect(parseShipMode(mode)).toBe(mode);
    }
  });

  it("returns undefined for an absent flag (no hard-coded default here)", () => {
    expect(parseShipMode(undefined)).toBeUndefined();
  });

  it("throws a UsageError for an unknown value, naming the accepted set", () => {
    try {
      parseShipMode("merge-everything");
      throw new Error("expected parseShipMode to throw");
    } catch (err) {
      expect(isUsageError(err)).toBe(true);
      expect((err as Error).message).toContain("merge-everything");
      for (const mode of ShipModeEnum.options) {
        expect((err as Error).message).toContain(mode);
      }
    }
  });

  it("throws a UsageError when the flag is passed bare (boolean true)", () => {
    expect(() => parseShipMode(true)).toThrow();
    expect(
      isUsageError(
        (() => {
          try {
            parseShipMode(true);
          } catch (e) {
            return e;
          }
        })(),
      ),
    ).toBe(true);
  });
});
