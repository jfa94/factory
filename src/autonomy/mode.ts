/**
 * Mandatory autonomous-mode gate — the single source of truth for the
 * autonomous signal.
 *
 * The factory pipeline is designed to run unattended: there is no opt-in and no
 * opt-out. A run may only START or RESUME from a session launched with the
 * autonomous merged settings (which set `FACTORY_AUTONOMOUS_MODE=1` via
 * `templates/settings.autonomous.json`, materialized by `factory autonomy
 * ensure`). `run create` / `run resume` call {@link requireAutonomousMode},
 * which throws {@link NotAutonomousError} — a typed error that bubbles uncaught
 * through the `runCommand` wrapper to `src/bin/factory.ts` (stderr + EXIT.ERROR),
 * mirroring `ProtectionMissingError`.
 *
 * The predicate is exactly `FACTORY_AUTONOMOUS_MODE === "1"` with no bypass flag,
 * so a CI that exports the var satisfies the same gate and nothing can opt out.
 */

/** The single autonomous-mode predicate: exactly `FACTORY_AUTONOMOUS_MODE === "1"`. */
export function isAutonomous(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FACTORY_AUTONOMOUS_MODE === "1";
}

/**
 * Thrown when the pipeline is asked to start or resume a run outside autonomous
 * mode. Mirrors `ProtectionMissingError` (src/git/protection.ts): a typed
 * `Error` subclass whose message names the exact recovery path; it bubbles
 * uncaught to the bin entrypoint, which prints it and exits non-zero.
 */
export class NotAutonomousError extends Error {
  constructor() {
    super(
      "Pipeline halted: not running in autonomous mode (FACTORY_AUTONOMOUS_MODE is unset).\n" +
        "The factory runs unattended and refuses to start or resume a run otherwise.\n" +
        "Run `factory autonomy ensure`, then relaunch the session with:\n" +
        "  claude --settings <merged-settings.json>\n" +
        "Check the current state any time with `factory autonomy status`.",
    );
    this.name = "NotAutonomousError";
  }
}

/** Refuse to proceed unless autonomous mode is active. */
export function requireAutonomousMode(env: NodeJS.ProcessEnv = process.env): void {
  if (!isAutonomous(env)) throw new NotAutonomousError();
}

/**
 * Why a preflight check reached its verdict — one label per {@link decideAutonomyPreflight}
 * table row, surfaced to the user so a halt explains itself.
 */
export type PreflightReason =
  | "not-autonomous"
  | "missing-settings"
  | "stale-version"
  | "unstamped"
  | "fresh"
  | "ci-raw-env"
  | "version-unknowable";

/**
 * The run-entry preflight verdict.
 *
 * Hard invariant: `regenerate === true ⟹ proceed === false`. A regenerate writes
 * settings the *running* session cannot load mid-flight; proceeding on them would
 * reintroduce false freshness. Regenerating always implies halt-for-relaunch.
 */
export interface PreflightDecision {
  readonly proceed: boolean;
  readonly regenerate: boolean;
  readonly reason: PreflightReason;
}

/**
 * Pure run-entry decision: given the autonomous signal, whether merged-settings
 * exist, and the plugin vs on-disk `_factoryVersion`, decide whether `/factory:run`
 * may proceed and whether the merged settings must be (re)scaffolded first.
 *
 * Total and IO-free — the CLI wrapper (`runAutonomyPreflight`) supplies the inputs
 * and acts on the verdict. See Decision 31.
 */
export function decideAutonomyPreflight(input: {
  autonomous: boolean;
  mergedSettingsPresent: boolean;
  pluginVersion: string | undefined;
  onDiskVersion: string | undefined;
}): PreflightDecision {
  const { autonomous, mergedSettingsPresent, pluginVersion, onDiskVersion } = input;

  // Not autonomous: this session can never make itself autonomous, so always
  // (re)scaffold the settings and halt for the relaunch.
  if (!autonomous) {
    return {
      proceed: false,
      regenerate: true,
      reason: mergedSettingsPresent ? "not-autonomous" : "missing-settings",
    };
  }

  // Autonomous with no settings file: the env was exported directly (CI / raw
  // env). Nothing to scaffold for the running session — proceed.
  if (!mergedSettingsPresent) {
    return { proceed: true, regenerate: false, reason: "ci-raw-env" };
  }

  // Autonomous with a settings file. Can we prove staleness?
  if (pluginVersion === undefined) {
    // Plugin version is unknowable, so a regenerate could not stamp one either:
    // regenerating would only churn. Proceed.
    return { proceed: true, regenerate: false, reason: "version-unknowable" };
  }
  if (onDiskVersion === undefined) {
    // A pre-versioning artifact (or hand-edited) — treat as stale.
    return { proceed: false, regenerate: true, reason: "unstamped" };
  }
  if (onDiskVersion !== pluginVersion) {
    return { proceed: false, regenerate: true, reason: "stale-version" };
  }
  return { proceed: true, regenerate: false, reason: "fresh" };
}
