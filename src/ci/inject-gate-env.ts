/**
 * Render the resolved `quality.gateEnv` INTO the managed `quality-gate.yml` so one
 * config is the single source of truth for both the factory's local merge gate and
 * the repo's GitHub CI. `factory scaffold` genericized the shipped CI template (a
 * shared plugin template can't carry one project's placeholders), leaving the build
 * step with a marker comment; this fills that marker with a real `env:` block.
 *
 * Operates on the TEMPLATE text (which still carries the marker), so it is a pure,
 * deterministic, idempotent render — applied every scaffold as part of producing the
 * managed file (scaffold compares the rendered template against the target for drift,
 * so an injected file stays byte-identical across re-runs).
 */

/** The marker line the build step carries; replaced in place by the `env:` block. */
const SENTINEL = "# factory:gate-env";

/**
 * Replace the `# factory:gate-env` marker line in `text` with a real `env:` block
 * rendered from `gateEnv`, preserving the marker's indentation. Empty `gateEnv` →
 * the marker is left untouched (no env to inject). No marker found (e.g. already
 * injected, or a non-template workflow) → `text` unchanged. Keys are POSIX-validated
 * upstream (the detector + schema), so they need no quoting; values are quoted via
 * `JSON.stringify` (a valid YAML double-quoted scalar for placeholder strings).
 *
 * ponytail: JSON.stringify quoting is correct for the placeholder strings gateEnv
 * holds; exotic YAML chars in a value aren't a real concern for CI placeholders.
 */
export function injectGateEnvIntoWorkflow(text: string, gateEnv: Record<string, string>): string {
  const keys = Object.keys(gateEnv).sort();
  if (keys.length === 0) return text;

  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.trim() === SENTINEL);
  if (idx === -1) return text;

  const indent = lines[idx]!.match(/^[ \t]*/)![0];
  const block = [
    `${indent}env:`,
    ...keys.map((k) => `${indent}  ${k}: ${JSON.stringify(gateEnv[k]!)}`),
  ];
  lines.splice(idx, 1, ...block);
  return lines.join("\n");
}
