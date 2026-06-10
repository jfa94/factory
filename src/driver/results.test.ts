// src/driver/results.test.ts
import { describe, expect, it } from "vitest";
import { parseDriveResults } from "./results.js";

describe("parseDriveResults", () => {
  it("parses a producer result", () => {
    const r = parseDriveResults({ producer: { status: "STATUS: DONE" } });
    expect(r.producer?.status).toBe("STATUS: DONE");
    expect(r.reviews).toBeUndefined();
  });

  it("parses a verify result with holdout + reviews + crossVendorAbsent", () => {
    const r = parseDriveResults({
      holdout: { raw: '{"criteria":[]}' },
      reviews: {
        reviews: [{ reviewer: "quality-reviewer", verdict: "approve", findings: [] }],
        verifications: [
          {
            reviewer: "quality-reviewer",
            verdicts: [{ file: "a.ts", line: 3, holds: true, note: "n" }],
          },
        ],
        crossVendorAbsent: { reason: "no second vendor" },
      },
    });
    expect(r.reviews?.reviews).toHaveLength(1);
    expect(r.holdout?.raw).toContain("criteria");
  });

  it("rejects an empty object (must carry producer or reviews)", () => {
    expect(() => parseDriveResults({})).toThrow(/producer|reviews/);
  });

  it("rejects unknown keys loudly", () => {
    expect(() => parseDriveResults({ producer: { status: "STATUS: DONE" }, extra: 1 })).toThrow();
  });

  it("rejects producer and reviews together", () => {
    expect(() =>
      parseDriveResults({
        producer: { status: "STATUS: DONE" },
        reviews: { reviews: [{}], verifications: [] },
      }),
    ).toThrow(/exactly one/);
  });

  it("rejects holdout without reviews", () => {
    expect(() =>
      parseDriveResults({ producer: { status: "STATUS: DONE" }, holdout: { raw: "x" } }),
    ).toThrow(/accompany/);
  });

  it("rejects unknown key inside verifications[0].verdicts[0]", () => {
    expect(() =>
      parseDriveResults({
        reviews: {
          reviews: [{ reviewer: "quality-reviewer", verdict: "approve", findings: [] }],
          verifications: [
            {
              reviewer: "quality-reviewer",
              verdicts: [{ file: "a.ts", line: 1, holds: true, note: "n", sneaky: 1 }],
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("rejects reviews.reviews: [] (min 1)", () => {
    expect(() =>
      parseDriveResults({
        reviews: { reviews: [], verifications: [] },
      }),
    ).toThrow();
  });
});
