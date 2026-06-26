/**
 * WS12 — rescue PUBLIC barrel.
 *
 * Two seams: the PURE read-only {@link scanRun} diagnostic (its classification is
 * the input the runner + the rescue-diagnostic agent reason over) and the
 * single {@link applyRescue} writer (resets resettable tasks → reopens a terminal
 * run). The CLI `factory rescue scan|apply` subcommand is the thin wrapper over
 * these; the rescue-diagnostic LLM agent (markdown, runner-spawned) consumes
 * `scan` and drives `apply --task …` — the CLI never spawns it (Model A).
 */
export { scanRun } from "./scan.js";
export type { RescueScan, RescueTaskLine, RescueDisposition } from "./scan.js";

export { assessWork } from "./assess.js";
export type { WorkProbe, WorkAssessment, TaskWork } from "./assess.js";

export { applyRescue } from "./apply.js";
export type { RescueApplyOptions, RescueApplyResult } from "./apply.js";
