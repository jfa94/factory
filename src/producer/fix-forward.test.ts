import { describe, it, expect } from "vitest";
import { runFixForward } from "./fix-forward.js";
import { RebuttalLedger } from "../verifier/judgment/rebuttal.js";
import { FakeRebuttalAdjudicator, fakeFinding } from "./fakes.js";

describe("fix-forward inner loop (D27)", () => {
  it("a clear floor (no blockers, no error) → 'clear' (the ladder re-derives via runPanel)", async () => {
    const r = await runFixForward({ confirmedBlockers: [], hadVerifierError: false });
    expect(r.status).toBe("clear");
  });

  it("confirmed blockers → 'patch-required' carrying the remaining findings (PATCH forward, not nuke)", async () => {
    const f = fakeFinding();
    const r = await runFixForward({ confirmedBlockers: [f], hadVerifierError: false });
    expect(r.status).toBe("patch-required");
    if (r.status === "patch-required") expect(r.remaining).toHaveLength(1);
  });

  it("verifier-error is LOUD: never ships, returns 'verifier-error' even with zero blockers (D27)", async () => {
    const r = await runFixForward({ confirmedBlockers: [], hadVerifierError: true });
    expect(r.status).toBe("verifier-error");
  });

  it("verifier-error wins over blockers (still unresolved)", async () => {
    const r = await runFixForward({ confirmedBlockers: [fakeFinding()], hadVerifierError: true });
    expect(r.status).toBe("verifier-error");
  });
});

describe("fix-forward — ONE-SHOT producer rebuttal via WS7 (D27)", () => {
  it("an OVERTURNED rebuttal removes the finding; remaining empty → 'rebutted-overturned'", async () => {
    const f = fakeFinding({ file: "src/a.ts", line: 3, reviewer: "quality-reviewer" });
    const ledger = new RebuttalLedger();
    const r = await runFixForward({
      confirmedBlockers: [f],
      hadVerifierError: false,
      rebuttal: {
        finding: f,
        rebuttal: { argument: "this is intentional" },
        originalReviewer: "quality-reviewer",
      },
      adjudicator: new FakeRebuttalAdjudicator(true, "codex"),
      ledger,
    });
    expect(r.status).toBe("rebutted-overturned");
    if (r.status === "rebutted-overturned") expect(r.remaining).toHaveLength(0);
  });

  it("an UPHELD rebuttal keeps the finding → 'patch-required'", async () => {
    const f = fakeFinding();
    const r = await runFixForward({
      confirmedBlockers: [f],
      hadVerifierError: false,
      rebuttal: { finding: f, rebuttal: { argument: "nope" }, originalReviewer: f.reviewer },
      adjudicator: new FakeRebuttalAdjudicator(false, "codex"),
      ledger: new RebuttalLedger(),
    });
    expect(r.status).toBe("patch-required");
  });

  it("a SECOND rebuttal of the same finding THROWS (WS7-enforced single-shot) — WS8 surfaces it loudly, does not swallow", async () => {
    const f = fakeFinding();
    const ledger = new RebuttalLedger();
    const adjudicator = new FakeRebuttalAdjudicator(false, "codex");
    // first rebuttal consumes the single shot
    await runFixForward({
      confirmedBlockers: [f],
      hadVerifierError: false,
      rebuttal: { finding: f, rebuttal: { argument: "a" }, originalReviewer: f.reviewer },
      adjudicator,
      ledger,
    });
    // second rebuttal of the SAME finding via the SAME ledger throws out of WS7
    await expect(
      runFixForward({
        confirmedBlockers: [f],
        hadVerifierError: false,
        rebuttal: { finding: f, rebuttal: { argument: "b" }, originalReviewer: f.reviewer },
        adjudicator,
        ledger,
      }),
    ).rejects.toThrow(/EXACTLY ONE rebuttal/);
  });

  it("a non-independent adjudicator (identity == original reviewer) THROWS (WS7-enforced)", async () => {
    const f = fakeFinding({ reviewer: "security-reviewer" });
    await expect(
      runFixForward({
        confirmedBlockers: [f],
        hadVerifierError: false,
        rebuttal: {
          finding: f,
          rebuttal: { argument: "x" },
          originalReviewer: "security-reviewer",
        },
        adjudicator: new FakeRebuttalAdjudicator(true, "security-reviewer"),
        ledger: new RebuttalLedger(),
      }),
    ).rejects.toThrow(/INDEPENDENT/);
  });

  it("a rebuttal without an adjudicator+ledger THROWS (WS8 drives, does not adjudicate itself)", async () => {
    const f = fakeFinding();
    await expect(
      runFixForward({
        confirmedBlockers: [f],
        hadVerifierError: false,
        rebuttal: { finding: f, rebuttal: { argument: "x" }, originalReviewer: f.reviewer },
      }),
    ).rejects.toThrow();
  });
});
