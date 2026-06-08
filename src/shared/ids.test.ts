import { describe, it, expect } from "vitest";
import { isValidId, validateId, slugify, makeRunId, SLUG_MAX_LENGTH } from "./ids.js";

describe("isValidId / validateId", () => {
  it("accepts the documented charset and length", () => {
    expect(isValidId("run-20260604-120000")).toBe(true);
    expect(isValidId("task_1")).toBe(true);
    expect(isValidId("A".repeat(64))).toBe(true);
  });
  it("rejects empty, too-long, and bad-charset ids", () => {
    expect(isValidId("")).toBe(false);
    expect(isValidId("A".repeat(65))).toBe(false);
    expect(isValidId("has space")).toBe(false);
    expect(isValidId("slash/here")).toBe(false);
    expect(isValidId("dot.here")).toBe(false);
  });
  it("validateId returns the id when valid, throws when not", () => {
    expect(validateId("ok-1")).toBe("ok-1");
    expect(() => validateId("", "run-id")).toThrow(/run-id: empty/);
    expect(() => validateId("bad id", "task-id")).toThrow(/task-id: invalid/);
  });
});

describe("slugify", () => {
  it("lowercases, replaces non-alphanumerics, collapses and trims dashes", () => {
    expect(slugify("Checkout Redesign!")).toBe("checkout-redesign");
    expect(slugify("  Multiple   Spaces  ")).toBe("multiple-spaces");
    expect(slugify("a__b--c")).toBe("a-b-c");
    expect(slugify("---leading-trailing---")).toBe("leading-trailing");
  });
  it("caps length at SLUG_MAX_LENGTH", () => {
    const out = slugify("x".repeat(200));
    expect(out.length).toBe(SLUG_MAX_LENGTH);
  });
  it("returns empty string when there are no alphanumerics", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("makeRunId", () => {
  it("formats run-YYYYMMDD-HHMMSS in UTC, zero-padded", () => {
    // 2026-01-09T03:07:05Z → padded month/day/h/m/s.
    expect(makeRunId(new Date("2026-01-09T03:07:05.000Z"))).toBe("run-20260109-030705");
  });
  it("is timezone-stable (anchored to UTC, not local time)", () => {
    expect(makeRunId(new Date("2026-12-31T23:59:59.000Z"))).toBe("run-20261231-235959");
  });
  it("always produces a valid id", () => {
    expect(isValidId(makeRunId(new Date("2026-06-05T12:00:00.000Z")))).toBe(true);
  });
});
