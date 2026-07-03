import { describe, it, expect, vi } from "vitest";
import { parseFinding, isCitable } from "./finding.js";
import {
  confirmBlocker,
  type ClaimOnlyFinding,
  type FindingVerifierRunner,
  type VerifierVerdict,
} from "./finding-verifier.js";

const parsed = parseFinding({
  reviewer: "quality-reviewer",
  severity: "critical",
  blocking: true,
  file: "src/app.ts",
  line: 3,
  quote: "const value = process(input)",
  claim: "unsanitised input reaches process()",
  description: "unsanitised input",
});
if (!isCitable(parsed)) throw new Error("fixture must be citable");
const finding = parsed;

function runner(
  fn: (f: ClaimOnlyFinding) => Promise<VerifierVerdict>,
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

// S5/B2 — anti-anchoring: the independent verifier confirms the CLAIM, never the
// reviewer's reasoning chain. The projection is enforced both at the type level
// (`description?: never`) and at runtime (exactly six keys reach the runner).
describe("claim-only projection (S5/B2)", () => {
  it("the runner receives EXACTLY {reviewer,severity,claim,file,line,quote} — never description", async () => {
    let received: ClaimOnlyFinding | undefined;
    await confirmBlocker(
      finding,
      runner(async (f) => {
        received = f;
        return { holds: true, note: "ok" };
      }),
      "quality-reviewer",
    );
    expect(received).toBeDefined();
    expect(Object.keys(received!).sort()).toEqual([
      "claim",
      "file",
      "line",
      "quote",
      "reviewer",
      "severity",
    ]);
    expect(received).not.toHaveProperty("description");
    expect(received!.claim).toBe("unsanitised input reaches process()");
  });

  it("projects the CITED line (replay-verdict key, S5/A2) when the finding was grep-relocated", async () => {
    let received: ClaimOnlyFinding | undefined;
    await confirmBlocker(
      finding, // finding.line === 3 (relocated)
      runner(async (f) => {
        received = f;
        return { holds: true, note: "ok" };
      }),
      "quality-reviewer",
      9, // the reviewer's original cited line
    );
    expect(received!.line).toBe(9);
  });

  it("type-level leak guard: a full Finding (with description) is not assignable to ClaimOnlyFinding", () => {
    // @ts-expect-error — `description?: never` rejects any object carrying it.
    const leak: ClaimOnlyFinding = { ...finding };
    expect(leak).toBeDefined(); // the assertion is the compile error above
  });
});
