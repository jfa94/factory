// src/driver/results.test.ts
import { describe, expect, it } from "vitest";
import { parseDriveResults } from "./results.js";

describe("parseDriveResults", () => {
  it("parses a producer result", () => {
    const r = parseDriveResults({
      result_key: { stage: "tests", rung: 0 },
      producer: { status: "STATUS: DONE" },
    });
    expect(r.producer?.status).toBe("STATUS: DONE");
    expect(r.reviews).toBeUndefined();
    expect(r.result_key).toEqual({ stage: "tests", rung: 0 });
  });

  it("parses a verify result with holdout + reviews + crossVendorAbsent", () => {
    const r = parseDriveResults({
      result_key: { stage: "verify", rung: 1 },
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
    expect(r.result_key).toEqual({ stage: "verify", rung: 1 });
  });

  it("rejects missing result_key on an empty object", () => {
    expect(() => parseDriveResults({})).toThrow();
  });

  it("rejects an object with result_key but neither producer nor reviews", () => {
    expect(() => parseDriveResults({ result_key: { stage: "tests", rung: 0 } })).toThrow(
      /producer|reviews/,
    );
  });

  it("rejects unknown keys loudly", () => {
    expect(() =>
      parseDriveResults({
        result_key: { stage: "tests", rung: 0 },
        producer: { status: "STATUS: DONE" },
        extra: 1,
      }),
    ).toThrow();
  });

  it("rejects producer and reviews together", () => {
    expect(() =>
      parseDriveResults({
        result_key: { stage: "tests", rung: 0 },
        producer: { status: "STATUS: DONE" },
        reviews: { reviews: [{}], verifications: [] },
      }),
    ).toThrow(/exactly one/);
  });

  it("rejects holdout without reviews", () => {
    expect(() =>
      parseDriveResults({
        result_key: { stage: "tests", rung: 0 },
        producer: { status: "STATUS: DONE" },
        holdout: { raw: "x" },
      }),
    ).toThrow(/accompany/);
  });

  it("rejects unknown key inside verifications[0].verdicts[0]", () => {
    expect(() =>
      parseDriveResults({
        result_key: { stage: "verify", rung: 0 },
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
        result_key: { stage: "verify", rung: 0 },
        reviews: { reviews: [], verifications: [] },
      }),
    ).toThrow();
  });

  it("rejects missing result_key", () => {
    expect(() => parseDriveResults({ producer: { status: "STATUS: DONE" } })).toThrow();
  });

  it("rejects result_key with stage 'preflight'", () => {
    expect(() =>
      parseDriveResults({
        result_key: { stage: "preflight", rung: 0 },
        producer: { status: "STATUS: DONE" },
      }),
    ).toThrow();
  });

  it("rejects result_key with stage 'ship'", () => {
    expect(() =>
      parseDriveResults({
        result_key: { stage: "ship", rung: 0 },
        producer: { status: "STATUS: DONE" },
      }),
    ).toThrow();
  });

  it("rejects result_key with negative rung", () => {
    expect(() =>
      parseDriveResults({
        result_key: { stage: "tests", rung: -1 },
        producer: { status: "STATUS: DONE" },
      }),
    ).toThrow();
  });

  it("rejects result_key with non-integer rung", () => {
    expect(() =>
      parseDriveResults({
        result_key: { stage: "tests", rung: 1.5 },
        producer: { status: "STATUS: DONE" },
      }),
    ).toThrow();
  });
});
