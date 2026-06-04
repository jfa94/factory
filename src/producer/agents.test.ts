import { describe, it, expect } from "vitest";
import { parseProducerStatus } from "./agents.js";

describe("parseProducerStatus — closed outcome from the terminal STATUS line", () => {
  it("STATUS: DONE → done", () => {
    expect(parseProducerStatus("STATUS: DONE")).toEqual({ status: "done" });
  });

  it("STATUS: BLOCKED — escalate → blocked-escalate (spec-defect signal, Δ D)", () => {
    const o = parseProducerStatus("STATUS: BLOCKED — escalate: contradictory criteria");
    expect(o.status).toBe("blocked-escalate");
    if (o.status === "blocked-escalate") expect(o.reason).toContain("escalate");
  });

  it("STATUS: NEEDS_CONTEXT → needs-context (retry signal, not a drop)", () => {
    expect(parseProducerStatus("STATUS: NEEDS_CONTEXT").status).toBe("needs-context");
  });

  it("an unparseable / empty status → error (never silently 'done')", () => {
    expect(parseProducerStatus("garbage line").status).toBe("error");
    expect(parseProducerStatus("").status).toBe("error");
  });

  it("BLOCKED+escalate wins over a co-occurring DONE keyword (escalate signal precedence)", () => {
    expect(parseProducerStatus("DONE? no — BLOCKED, please escalate").status).toBe(
      "blocked-escalate",
    );
  });
});
