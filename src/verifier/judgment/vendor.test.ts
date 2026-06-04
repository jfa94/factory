import { describe, it, expect } from "vitest";
import { resolveCrossVendor, type VendorProbe } from "./vendor.js";

function probe(impl: () => Promise<boolean>, vendor = "codex"): VendorProbe {
  return { vendor, available: impl };
}

describe("WS7 cross-vendor slot (Δ U LOUD-when-absent)", () => {
  it("Δ U: probe present + model configured → slot resolved", async () => {
    const res = await resolveCrossVendor(
      "gpt-5-codex",
      probe(async () => true),
    );
    expect(res.status).toBe("present");
    if (res.status === "present") {
      expect(res.slot.vendor).toBe("codex");
      expect(res.slot.model).toBe("gpt-5-codex");
    }
  });

  it("Δ U: probe absent → explicit {absent, reason} the caller MUST handle", async () => {
    const res = await resolveCrossVendor(
      "gpt-5-codex",
      probe(async () => false),
    );
    expect(res.status).toBe("absent");
    if (res.status === "absent") {
      expect(res.reason).toMatch(/not available/i);
    }
  });

  it("Δ U: probe available but NO model configured → absent (never invent a model)", async () => {
    const res = await resolveCrossVendor(
      undefined,
      probe(async () => true),
    );
    expect(res.status).toBe("absent");
    if (res.status === "absent") expect(res.reason).toMatch(/no model is configured/i);
  });

  it("Δ U: empty model string → absent (not silently treated as configured)", async () => {
    const res = await resolveCrossVendor(
      "   ",
      probe(async () => true),
    );
    expect(res.status).toBe("absent");
  });

  it("Δ U edge: probe throws/ENOENT → absent-with-reason, NOT a crash", async () => {
    const res = await resolveCrossVendor(
      "gpt-5-codex",
      probe(async () => {
        throw new Error("spawn codex ENOENT");
      }),
    );
    expect(res.status).toBe("absent");
    if (res.status === "absent") expect(res.reason).toMatch(/ENOENT/);
  });

  it("Δ U: absence is never the SAME shape as presence (no boolean a caller can ignore)", async () => {
    const absent = await resolveCrossVendor(
      "gpt-5-codex",
      probe(async () => false),
    );
    // The union forces a status check; there is no `.slot` on the absent branch.
    expect("slot" in absent).toBe(false);
    expect("reason" in absent).toBe(true);
  });
});
