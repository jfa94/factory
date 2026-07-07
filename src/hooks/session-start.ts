/**
 * SessionStart compaction re-injection hook.
 *
 * The runner's protocol pointer (skills/pipeline-runner/SKILL.md) lives in
 * conversation context, which a mid-run compaction can drop — the runner then
 * stalls with no memory of the Iron Laws or how to resume THE LOOP. `hooks.json`
 * fires this ONLY on `matcher:"compact"` (startup/clear already re-load the skill
 * via the `/factory:run` invocation itself) and emits a small reminder block plus
 * a pointer to reload the authoritative skill.
 *
 * Output: EXIT.OK + `{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext}}`
 * on stdout — the harness contract for injecting text into the resumed session.
 */
import {EXIT, type ExitCode} from '../shared/exit-codes.js'
import {emitSessionStartContext} from './hook-io.js'

// ponytail: canonical source is skills/pipeline-runner/SKILL.md:14-24; this is a
// hardcoded digest so a mid-compaction session never loses the pointer even before
// the skill reloads. Keep in sync by hand if the runner's Iron Laws change.
export const FACTORY_HARNESS_REMINDER = `<FACTORY_HARNESS_REMINDER>
You are the factory pipeline runner. Iron Laws:
1. Never decide a transition — the only next action is what the last envelope said.
2. Spawn exactly what the manifest says; collect output verbatim.
3. Fail loud — an unknown envelope kind or unexpected error means STOP and surface it.
Re-load skills/pipeline-runner/SKILL.md before taking any pipeline action.
</FACTORY_HARNESS_REMINDER>`

/** Run the SessionStart hook end-to-end. No state read — the reminder is static. */
export function runSessionStart(_argv: string[] = [], deps: {emit?: (s: string) => void} = {}): ExitCode {
    emitSessionStartContext(FACTORY_HARNESS_REMINDER, deps.emit)
    return EXIT.OK
}
