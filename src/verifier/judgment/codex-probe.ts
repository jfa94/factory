/**
 * S5/C — the REAL Codex availability probe (replaces the hardcoded "no second
 * vendor" assumption). Runs `codex --version` through the frozen shared/exec.ts
 * seam, memoized per probe instance (and process-wide via {@link codexProbe}) —
 * availability does not flap mid-run, and repeated verify passes must not pay a
 * subprocess spawn each.
 *
 * {@link resolveCodexCrossVendor} is the config-aware entry: with NO
 * `codex.model` configured the resolution is a deterministic `absent` WITHOUT
 * shelling out — probing for a vendor we could never use is wasted exec and
 * makes default-config behavior machine-dependent.
 */
import { exec, type ExecResult } from "../../shared/index.js";
import { resolveCrossVendor, type CrossVendorResolution, type VendorProbe } from "./vendor.js";

/** Injectable exec shape (the frozen seam's signature, narrowed to what we call). */
export type ProbeExec = (
  command: string,
  args: readonly string[],
  opts: { timeoutMs: number },
) => Promise<ExecResult>;

/** `codex --version` must answer well within this; a hung binary is "absent". */
export const CODEX_PROBE_TIMEOUT_MS = 5_000;

/**
 * Build a memoized Codex {@link VendorProbe}. The first `available()` call runs
 * `codex --version`; every later call returns the same settled promise (a spawn
 * ENOENT rejection is memoized too — resolveCrossVendor maps it to absent).
 */
export function makeCodexProbe(run: ProbeExec = exec): VendorProbe {
  let memo: Promise<boolean> | undefined;
  return {
    vendor: "codex",
    available() {
      memo ??= run("codex", ["--version"], { timeoutMs: CODEX_PROBE_TIMEOUT_MS }).then(
        (r) => r.code === 0,
      );
      return memo;
    },
  };
}

/** The process-wide shared probe (one real `codex --version` per process). */
export const codexProbe: VendorProbe = makeCodexProbe();

/**
 * Resolve the cross-vendor slot from config (S5/C). No model configured ⇒
 * deterministic `absent` with no subprocess; otherwise defer to the frozen
 * {@link resolveCrossVendor} over the (memoized) probe.
 */
export async function resolveCodexCrossVendor(
  codexModel: string | undefined,
  probe: VendorProbe = codexProbe,
): Promise<CrossVendorResolution> {
  if (codexModel === undefined || codexModel.trim().length === 0) {
    return {
      status: "absent",
      reason: "no cross-vendor model configured (codex.model)",
    };
  }
  return resolveCrossVendor(codexModel, probe);
}
