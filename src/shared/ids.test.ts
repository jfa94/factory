import { describe, it, expect } from "vitest";
import { isValidId, validateId, slugify, SLUG_MAX_LENGTH } from "./ids.js";

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
