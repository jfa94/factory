/**
 * Canonical basenames for the gate tools' config files — the SINGLE source of
 * truth shared by the mutation gate's applicability check
 * (`STRYKER_CONFIGS`, src/verifier/deterministic/strategies/mutation.ts) and the
 * TCB write-protection denylist (`GATE_CONFIG_BASENAMES`, src/hooks/tcb.ts).
 *
 * WHY ONE LIST (jfa94/factory#11): those two sets were hand-maintained and had
 * drifted — the TCB protected only 3 Stryker basenames while Stryker's own
 * discovery loads any of 16. An executor could therefore `Write` an UNPROTECTED
 * sibling (e.g. `stryker.config.mjs`) that Stryker discovers and loads ahead of
 * the protected config. Because the `.js`/`.mjs`/`.cjs` variants are EXECUTABLE
 * JavaScript that Stryker imports and runs inside the trusted gate-of-record
 * process, that is arbitrary code execution at gate time — not mere config
 * weakening. Deriving both sets from this one list (with a drift-guard test that
 * pins write-protection ⊇ this list) makes that bypass class structurally
 * impossible to reintroduce.
 *
 * This module is a ZERO-DEPENDENCY leaf so it inlines cleanly into BOTH the CLI
 * bundle (dist/factory.js) and the hook bundle (dist/factory-hook.js). Import it
 * DIRECTLY (not via the shared/index.js barrel) to keep the hook bundle lean.
 */

/**
 * Every basename Stryker's `findConfigFile()` will load (first-existing wins).
 * Mirrors Stryker core's `SUPPORTED_CONFIG_FILE_NAMES`, the cartesian product
 *   {'', '.'} × {'.conf', '.config'} × {'json', 'js', 'mjs', 'cjs'}
 * = 16 names. ALL must be write-protected: the executable variants run arbitrary
 * JS in the gate process, and any variant can shadow the scaffolded
 * `.stryker.config.json` depending on discovery order.
 */
export const STRYKER_CONFIG_BASENAMES: readonly string[] = [
  "stryker.conf.json",
  "stryker.conf.js",
  "stryker.conf.mjs",
  "stryker.conf.cjs",
  "stryker.config.json",
  "stryker.config.js",
  "stryker.config.mjs",
  "stryker.config.cjs",
  ".stryker.conf.json",
  ".stryker.conf.js",
  ".stryker.conf.mjs",
  ".stryker.conf.cjs",
  ".stryker.config.json",
  ".stryker.config.js",
  ".stryker.config.mjs",
  ".stryker.config.cjs",
] as const;
