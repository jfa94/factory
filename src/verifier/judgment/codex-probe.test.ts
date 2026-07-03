import { describe, it, expect, vi } from "vitest";
import type { ExecResult } from "../../shared/index.js";
import { resolveCrossVendor } from "./vendor.js";
import { makeCodexProbe, resolveCodexCrossVendor, CODEX_PROBE_TIMEOUT_MS } from "./codex-probe.js";

function execResult(code: number): ExecResult {
  return { stdout: "codex-cli 1.0.0", stderr: "", code, signal: null, truncated: false };
}

describe("S5/C codex probe", () => {
  it("codex --version exit 0 → available; the resolution is present with the configured model", async () => {
    const run = vi.fn(async () => execResult(0));
    const probe = makeCodexProbe(run);
    await expect(probe.available()).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith("codex", ["--version"], {
      timeoutMs: CODEX_PROBE_TIMEOUT_MS,
    });
    const res = await resolveCrossVendor("gpt-5-codex", probe);
    expect(res).toEqual({ status: "present", slot: { vendor: "codex", model: "gpt-5-codex" } });
  });

  it("nonzero exit → not available", async () => {
    const probe = makeCodexProbe(async () => execResult(127));
    await expect(probe.available()).resolves.toBe(false);
  });

  it("spawn ENOENT (missing binary) → resolveCrossVendor maps to absent-with-reason, never a crash", async () => {
    const probe = makeCodexProbe(async () => {
      throw new Error("spawn codex ENOENT");
    });
    const res = await resolveCrossVendor("gpt-5-codex", probe);
    expect(res.status).toBe("absent");
    if (res.status === "absent") expect(res.reason).toMatch(/ENOENT/);
  });

  it("memoizes: repeated available() calls run codex --version EXACTLY once", async () => {
    const run = vi.fn(async () => execResult(0));
    const probe = makeCodexProbe(run);
    await probe.available();
    await probe.available();
    await probe.available();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("resolveCodexCrossVendor with NO model is a deterministic absent WITHOUT shelling out", async () => {
    const run = vi.fn(async () => execResult(0));
    const res = await resolveCodexCrossVendor(undefined, makeCodexProbe(run));
    expect(res.status).toBe("absent");
    if (res.status === "absent") expect(res.reason).toMatch(/codex\.model/);
    expect(run).not.toHaveBeenCalled();
  });

  it("resolveCodexCrossVendor with a model defers to the probe", async () => {
    const res = await resolveCodexCrossVendor(
      "gpt-5-codex",
      makeCodexProbe(async () => execResult(0)),
    );
    expect(res.status).toBe("present");
  });
});
