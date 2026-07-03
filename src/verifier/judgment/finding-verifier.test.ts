import { describe, it, expect, vi } from "vitest";
import { parseFinding, type Finding } from "./finding.js";
import {
  confirmBlocker,
  type FindingVerifierRunner,
  type VerifierVerdict,
} from "./finding-verifier.js";

const finding: Finding = parseFinding({
  reviewer: "quality-reviewer",
  severity: "critical",
  blocking: true,
  file: "src/app.ts",
  line: 3,
  quote: "const value = process(input)",
  claim: "unsanitised input reaches process()",
  description: "unsanitised input",
});

function runner(
  fn: (f: Finding) => Promise<VerifierVerdict>,
  identity = "codex",
): FindingVerifierRunner {
  return { identity, confirm: fn };
}

describe("WS7 verify-then-fix finding-verifier (D27)", () => {
  it("D27: a finding that survives confirmation is CONFIRMED (reaches the producer)", async () => {
    const out = await confirmBlocker(
      finding,
      runner(async () => ({ holds: true, note: "matched at line 3" })),
      "quality-reviewer",
    );
    expect(out.status).toBe("confirmed");
    if (out.status === "confirmed") expect(out.evidence.note).toMatch(/line 3/);
  });

  it("D27: a refuted finding is NOT forwarded", async () => {
    const out = await confirmBlocker(
      finding,
      runner(async () => ({ holds: false, note: "code already sanitises" })),
      "quality-reviewer",
    );
    expect(out.status).toBe("refuted");
  });

  it("D27 (bounded): the verifier runs EXACTLY ONCE per finding (no debate loop)", async () => {
    const spy = vi.fn(async () => ({ holds: true, note: "ok" }));
    await confirmBlocker(finding, runner(spy), "quality-reviewer");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("D27 (independence): the verifier identity must differ from the finder", async () => {
    await expect(
      confirmBlocker(
        finding,
        runner(async () => ({ holds: true, note: "ok" }), "quality-reviewer"),
        "quality-reviewer",
      ),
    ).rejects.toThrow(/INDEPENDENT/i);
  });

  it("D27 (loud error): a verifier error does NOT auto-confirm — it is unresolved", async () => {
    const out = await confirmBlocker(
      finding,
      runner(async () => {
        throw new Error("agent crashed");
      }),
      "quality-reviewer",
    );
    expect(out.status).toBe("error");
    if (out.status === "error") expect(out.reason).toMatch(/errored/i);
  });

  it("D27: a verifier error is never silently a refute either (distinct unresolved state)", async () => {
    const out = await confirmBlocker(
      finding,
      runner(async () => {
        throw new Error("boom");
      }),
      "quality-reviewer",
    );
    expect(out.status).not.toBe("confirmed");
    expect(out.status).not.toBe("refuted");
  });
});
