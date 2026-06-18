import { describe, expect, it } from "vitest";

import {
  decideAutonomyPreflight,
  isAutonomous,
  NotAutonomousError,
  requireAutonomousMode,
} from "./mode.js";

describe("isAutonomous", () => {
  it("is true only when FACTORY_AUTONOMOUS_MODE is exactly '1'", () => {
    expect(isAutonomous({ FACTORY_AUTONOMOUS_MODE: "1" })).toBe(true);
  });

  it("is false when the var is unset", () => {
    expect(isAutonomous({})).toBe(false);
  });

  it("is false for any other truthy-looking value (no bypass)", () => {
    expect(isAutonomous({ FACTORY_AUTONOMOUS_MODE: "true" })).toBe(false);
    expect(isAutonomous({ FACTORY_AUTONOMOUS_MODE: "0" })).toBe(false);
    expect(isAutonomous({ FACTORY_AUTONOMOUS_MODE: "" })).toBe(false);
    expect(isAutonomous({ FACTORY_AUTONOMOUS_MODE: " 1" })).toBe(false);
  });
});

describe("requireAutonomousMode", () => {
  it("returns void without throwing when autonomous", () => {
    expect(() => requireAutonomousMode({ FACTORY_AUTONOMOUS_MODE: "1" })).not.toThrow();
  });

  it("throws NotAutonomousError when not autonomous", () => {
    expect(() => requireAutonomousMode({})).toThrow(NotAutonomousError);
  });

  it("names the actionable recovery path in the halt message", () => {
    let caught: unknown;
    try {
      requireAutonomousMode({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotAutonomousError);
    const message = (caught as Error).message;
    expect(message).toContain("factory autonomy ensure");
    expect(message).toContain("claude --settings");
  });
});

describe("decideAutonomyPreflight", () => {
  it("not autonomous + no file → halt + regenerate (missing-settings)", () => {
    expect(
      decideAutonomyPreflight({
        autonomous: false,
        mergedSettingsPresent: false,
        pluginVersion: "1.0.0",
        onDiskVersion: undefined,
      }),
    ).toEqual({ proceed: false, regenerate: true, reason: "missing-settings" });
  });

  it("not autonomous + file present → halt + regenerate (not-autonomous)", () => {
    expect(
      decideAutonomyPreflight({
        autonomous: false,
        mergedSettingsPresent: true,
        pluginVersion: "1.0.0",
        onDiskVersion: "1.0.0",
      }),
    ).toEqual({ proceed: false, regenerate: true, reason: "not-autonomous" });
  });

  it("autonomous + no file → proceed without regenerate (ci-raw-env)", () => {
    expect(
      decideAutonomyPreflight({
        autonomous: true,
        mergedSettingsPresent: false,
        pluginVersion: "1.0.0",
        onDiskVersion: undefined,
      }),
    ).toEqual({ proceed: true, regenerate: false, reason: "ci-raw-env" });
  });

  it("autonomous + file + versions differ → halt + regenerate (stale-version)", () => {
    expect(
      decideAutonomyPreflight({
        autonomous: true,
        mergedSettingsPresent: true,
        pluginVersion: "1.0.0",
        onDiskVersion: "0.9.0",
      }),
    ).toEqual({ proceed: false, regenerate: true, reason: "stale-version" });
  });

  it("autonomous + file + versions equal → proceed without regenerate (fresh)", () => {
    expect(
      decideAutonomyPreflight({
        autonomous: true,
        mergedSettingsPresent: true,
        pluginVersion: "1.0.0",
        onDiskVersion: "1.0.0",
      }),
    ).toEqual({ proceed: true, regenerate: false, reason: "fresh" });
  });

  it("autonomous + file present but unstamped → halt + regenerate (unstamped)", () => {
    expect(
      decideAutonomyPreflight({
        autonomous: true,
        mergedSettingsPresent: true,
        pluginVersion: "1.0.0",
        onDiskVersion: undefined,
      }),
    ).toEqual({ proceed: false, regenerate: true, reason: "unstamped" });
  });

  it("autonomous + file + plugin version unknowable → proceed without regenerate (version-unknowable)", () => {
    expect(
      decideAutonomyPreflight({
        autonomous: true,
        mergedSettingsPresent: true,
        pluginVersion: undefined,
        onDiskVersion: "1.0.0",
      }),
    ).toEqual({ proceed: true, regenerate: false, reason: "version-unknowable" });
  });

  it("invariant: regenerate === true ⟹ proceed === false (across the whole input space)", () => {
    const bools = [true, false];
    const versions: Array<string | undefined> = [undefined, "0.9.0", "1.0.0"];
    for (const autonomous of bools) {
      for (const mergedSettingsPresent of bools) {
        for (const pluginVersion of versions) {
          for (const onDiskVersion of versions) {
            const decision = decideAutonomyPreflight({
              autonomous,
              mergedSettingsPresent,
              pluginVersion,
              onDiskVersion,
            });
            if (decision.regenerate) {
              expect(decision.proceed).toBe(false);
            }
          }
        }
      }
    }
  });
});
