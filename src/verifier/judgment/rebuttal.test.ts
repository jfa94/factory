import { describe, it, expect, vi } from "vitest";
import { parseFinding, type Finding } from "./finding.js";
import {
  adjudicateRebuttal,
  RebuttalLedger,
  type AdjudicationVerdict,
  type ProducerRebuttal,
  type RebuttalAdjudicator,
} from "./rebuttal.js";

const finding: Finding = parseFinding({
  reviewer: "security-reviewer",
  severity: "critical",
  blocking: true,
  file: "src/app.ts",
  line: 3,
  quote: "const value = process(input)",
  description: "unsanitised input",
});

const rebuttal: ProducerRebuttal = { argument: "process() sanitises internally, see L10" };

function adjudicator(
  fn: (f: Finding, r: ProducerRebuttal) => Promise<AdjudicationVerdict>,
  identity = "codex",
): RebuttalAdjudicator {
  return { identity, adjudicate: fn };
}

describe("WS7 producer rebuttal (D27 rebuttal clause)", () => {
  it("D27: a successful rebuttal OVERTURNS the blocker", async () => {
    const out = await adjudicateRebuttal(
      finding,
      rebuttal,
      adjudicator(async () => ({ overturn: true, note: "confirmed sanitisation" })),
      "security-reviewer",
      new RebuttalLedger(),
    );
    expect(out.status).toBe("overturned");
  });

  it("D27: a failed rebuttal UPHOLDS the blocker", async () => {
    const out = await adjudicateRebuttal(
      finding,
      rebuttal,
      adjudicator(async () => ({ overturn: false, note: "no sanitisation found" })),
      "security-reviewer",
      new RebuttalLedger(),
    );
    expect(out.status).toBe("upheld");
  });

  it("D27 (independence): the adjudicator must NOT be the original reviewer", async () => {
    await expect(
      adjudicateRebuttal(
        finding,
        rebuttal,
        adjudicator(async () => ({ overturn: true, note: "x" }), "security-reviewer"),
        "security-reviewer",
        new RebuttalLedger(),
      ),
    ).rejects.toThrow(/INDEPENDENT/i);
  });

  it("D27 (exactly once): a SECOND rebuttal of the same finding is refused", async () => {
    const ledger = new RebuttalLedger();
    const spy = vi.fn(async () => ({ overturn: false, note: "no" }));
    await adjudicateRebuttal(finding, rebuttal, adjudicator(spy), "security-reviewer", ledger);
    await expect(
      adjudicateRebuttal(finding, rebuttal, adjudicator(spy), "security-reviewer", ledger),
    ).rejects.toThrow(/EXACTLY ONE/i);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("D27 (single shot): the adjudicator is called exactly once per rebuttal", async () => {
    const spy = vi.fn(async () => ({ overturn: true, note: "ok" }));
    await adjudicateRebuttal(
      finding,
      rebuttal,
      adjudicator(spy),
      "security-reviewer",
      new RebuttalLedger(),
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("D27 (loud error): adjudicator error UPHOLDS the blocker (safe default)", async () => {
    const out = await adjudicateRebuttal(
      finding,
      rebuttal,
      adjudicator(async () => {
        throw new Error("adjudicator crashed");
      }),
      "security-reviewer",
      new RebuttalLedger(),
    );
    expect(out.status).toBe("upheld");
    expect(out.note).toMatch(/errored/i);
  });

  it("D27: the ledger marks the finding rebutted even when adjudication errors (no retry loophole)", async () => {
    const ledger = new RebuttalLedger();
    await adjudicateRebuttal(
      finding,
      rebuttal,
      adjudicator(async () => {
        throw new Error("boom");
      }),
      "security-reviewer",
      ledger,
    );
    expect(ledger.hasRebutted(finding)).toBe(true);
  });
});
