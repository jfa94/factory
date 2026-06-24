/**
 * Auto-detect the build-time env a repo's CI injects, to populate
 * {@link Config.quality}.`gateEnv` — so the verifier floor runs gates with CI
 * parity instead of crashing on a missing-env build (the false-negative floor
 * this whole feature exists to remove).
 *
 * Source of truth: `.github/workflows/*.yml` step- and job-level `env:` blocks —
 * the place a repo declares build env NAMES *and* safe placeholder VALUES together
 * (step env wins on a key collision). We never read `.env`/`.env.local` (real
 * secrets), only literal values committed in plaintext to a workflow.
 *
 * Parser: a hand-rolled line scanner (NO yaml dependency — the dist bundles inline
 * every dep and the surface we need is narrow). Its safety property is **bias to
 * MISS, never MIS-DETECT**: an UNQUOTED value opening with exotic YAML (an anchor
 * `&`, alias `*`, tag `!`, or flow collection `{`/`[`) is skipped, not emitted
 * mangled (see `isUndetectableScalar`); a QUOTED look-alike like `"[draft]"` is a
 * plain string and IS kept. The escape hatch for a miss is
 * `factory configure --set quality.gateEnv.X=…`.
 *
 * Policy filters drop an entry before it can reach `gateEnv`:
 *   1. any value containing `${{` (a GitHub expression ref — `${{ secrets.* }}`,
 *      `${{ matrix.* }}` — unusable and unsafe at gate time);
 *   2. any value `detectSecrets()` flags (defense-in-depth: gateEnv is documented
 *      "placeholders only — not a secret store");
 *   3. any reserved loader/path-injection KEY (`PATH`, `LD_PRELOAD`, `DYLD_*`, …) or
 *      a non-POSIX key name — reported under `droppedKeys`, never silent. A reserved
 *      key would hijack the gate subprocess (gateEnv merges OVER `process.env`);
 *   4. (structural) anything inside a `run: |` block scalar is never read as env.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { detectSecrets } from "../shared/secret-patterns.js";
import {
  loadConfig,
  readRawConfig,
  saveRawConfig,
  setAtPath,
  type ConfigValue,
  type DataDirOptions,
} from "../config/index.js";

// ── seam ────────────────────────────────────────────────────────────────────

/** The workflow-file read seam — injected so the scanner is pure + testable. */
export interface WorkflowSource {
  /** `.yml`/`.yaml` basenames under `.github/workflows`, sorted; `[]` if absent. */
  listWorkflows(): string[];
  /** Raw text of one workflow file by basename. */
  readWorkflow(name: string): string;
}

/** The real seam: reads `<root>/.github/workflows`. The only place `node:fs` runs. */
export class DefaultWorkflowSource implements WorkflowSource {
  constructor(private readonly root: string) {}
  private dir(): string {
    return join(this.root, ".github", "workflows");
  }
  listWorkflows(): string[] {
    const d = this.dir();
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .sort();
  }
  readWorkflow(name: string): string {
    return readFileSync(join(this.dir(), name), "utf8");
  }
}

// ── detection result ──────────────────────────────────────────────────────────

export type EnvScope = "step" | "job";

export interface DetectedVar {
  readonly key: string;
  readonly value: string; // literal, never contains "${{"
  readonly workflow: string;
  readonly job: string;
  readonly step: string;
  readonly scope: EnvScope;
}

interface DroppedRef {
  readonly key: string;
  readonly workflow: string;
  readonly job: string;
  readonly step: string;
}

/** Why a var was dropped on a KEY check (not a value check). */
export type DroppedKeyReason = "reserved" | "invalid-name";

export interface DetectResult {
  /** The merged map ready to feed `quality.gateEnv` (step-over-job, later-file-wins). */
  readonly gateEnv: Record<string, string>;
  /** Every literal var kept, with provenance (for the human report). */
  readonly detected: readonly DetectedVar[];
  /** Vars dropped because the value was a `${{ }}` expression ref. */
  readonly skippedExpressionRefs: readonly DroppedRef[];
  /** Vars dropped because the literal value looked like a real secret. */
  readonly droppedSecrets: readonly (DroppedRef & { match: string })[];
  /**
   * Vars dropped on a KEY check: a reserved loader/path-injection name (would
   * hijack the gate subprocess via `exec`'s gateEnv-over-process.env merge) or a
   * non-POSIX name (unusable as an env var). Reported, never silent.
   */
  readonly droppedKeys: readonly (DroppedRef & { reason: DroppedKeyReason })[];
  /** Workflow files skipped because they couldn't be parsed (never partial-emitted). */
  readonly warnings: readonly { workflow: string; message: string }[];
}

// ── scanner ───────────────────────────────────────────────────────────────────

/** One env entry the structural scanner extracted (pre-policy-filter). */
interface RawEnvEntry {
  key: string;
  value: string;
  job: string;
  step: string;
  scope: EnvScope;
}

/** Unwrap a YAML scalar value: strip a single trailing comment + quotes. */
function parseScalar(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('"')) {
    // double-quoted: read to the closing unescaped quote, resolving \" and \\.
    let out = "";
    for (let i = 1; i < s.length; i++) {
      const c = s[i]!;
      if (c === "\\" && i + 1 < s.length) {
        const n = s[i + 1]!;
        out += n === "n" ? "\n" : n === "t" ? "\t" : n; // covers \" \\ and the common escapes
        i++;
        continue;
      }
      if (c === '"') return out;
      out += c;
    }
    return out; // unterminated — return what we have
  }
  if (s.startsWith("'")) {
    // single-quoted: '' is a literal quote.
    let out = "";
    for (let i = 1; i < s.length; i++) {
      const c = s[i]!;
      if (c === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return out;
      }
      out += c;
    }
    return out;
  }
  // unquoted: a ` #` (whitespace + hash) starts a trailing comment.
  const m = s.match(/\s#/);
  return (m ? s.slice(0, m.index) : s).trim();
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/;
const isBlockScalar = (v: string | undefined): boolean =>
  v === "|" || v === ">" || /^[|>][+-]?$/.test(v ?? "");

/**
 * Loader / path-injection env names that must NEVER be sourced from a workflow:
 * `exec` merges gateEnv OVER `process.env` (src/shared/exec.ts), so one of these
 * would hijack the binary resolution / dynamic linker of every gate subprocess.
 * Deliberately NARROW — these have no legitimate build-placeholder use, so the
 * drop is pure safety. NODE_OPTIONS (`--max-old-space-size`) and GIT_* are legit
 * build/identity vars and are NOT denied (denylisting them re-introduces a
 * false-negative gate; see the over-acceptance finding).
 */
const RESERVED_ENV_KEYS = new Set(["PATH", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"]);
const isReservedEnvKey = (key: string): boolean =>
  RESERVED_ENV_KEYS.has(key) || key.startsWith("DYLD_");

/** A portable POSIX env-var name — anything else is unusable as a gate env var. */
const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A RAW (pre-`parseScalar`) env value whose first char opens exotic YAML the line
 * scanner can't safely resolve — an anchor `&`, alias `*`, tag `!`, or flow
 * collection `{`/`[`. Emitting the verbatim text would MANGLE it, violating the
 * "bias to miss, never mis-detect" property, so the entry is skipped (a deliberate
 * miss). Checked on the RAW value BEFORE quote-stripping: a QUOTED look-alike
 * (`"[draft]"`, `'!important'`, `"*.example.com"`) is a plain string `parseScalar`
 * resolves fine, so only UNQUOTED values are skipped.
 */
function isUndetectableScalar(rawValue: string): boolean {
  const s = rawValue.trim();
  if (s.startsWith('"') || s.startsWith("'")) return false;
  const first = s[0];
  return first !== undefined && "&*!{[".includes(first);
}

/**
 * Structurally extract every step/job-level `env:` entry from one workflow's text.
 * Throws {@link MalformedWorkflow} on a structural impossibility (tab indentation)
 * so the caller skips the file with a warning rather than emitting a guess.
 */
class MalformedWorkflow extends Error {}

interface ScanState {
  jobsIndent: number | null;
  jobKeyIndent: number | null;
  currentJob: string;
  currentStep: string;
  stepKeyIndent: number | null; // key-indent of the step we're inside
  stepLabelFromName: boolean;
  blockIndent: number | null; // inside a `key: |` block scalar
  envIndent: number | null; // inside an `env:` mapping
  envScope: EnvScope;
}

/** Process one (de-dashed) `key: value` line, mutating scan state. */
function processKey(s: ScanState, c: string, ind: number): void {
  const m = c.match(KEY_LINE);
  if (!m) return;
  const key = m[1]!;
  const val = m[2];
  const empty = val === undefined || val.trim() === "";

  if (s.jobsIndent === null && key === "jobs" && empty) {
    s.jobsIndent = ind;
    return;
  }
  // Job names: bare mapping keys at the first level under `jobs:`.
  if (s.jobsIndent !== null && ind > s.jobsIndent && empty) {
    if (s.jobKeyIndent === null) s.jobKeyIndent = ind;
    if (ind === s.jobKeyIndent) {
      s.currentJob = key;
      s.currentStep = "";
      s.stepKeyIndent = null;
      // not a return — a `jobs:`-child literally named `env` is implausible
    }
  }

  const inStep = s.stepKeyIndent !== null && ind === s.stepKeyIndent;
  if (key === "name" && inStep) {
    if (val !== undefined) {
      s.currentStep = parseScalar(val);
      s.stepLabelFromName = true;
    }
    return;
  }
  if (key === "run" && inStep) {
    if (isBlockScalar(val)) s.blockIndent = ind;
    else if (!s.stepLabelFromName && val !== undefined) s.currentStep = parseScalar(val);
    return;
  }
  if (key === "env" && empty) {
    s.envIndent = ind;
    s.envScope = inStep ? "step" : "job";
    return;
  }
  if (isBlockScalar(val)) s.blockIndent = ind; // any other block scalar — skip its body
}

function scanWorkflow(text: string): RawEnvEntry[] {
  const entries: RawEnvEntry[] = [];
  const s: ScanState = {
    jobsIndent: null,
    jobKeyIndent: null,
    currentJob: "",
    currentStep: "",
    stepKeyIndent: null,
    stepLabelFromName: false,
    blockIndent: null,
    envIndent: null,
    envScope: "step",
  };

  for (const rawLine of text.split("\n")) {
    if (rawLine.trim() === "") continue; // blank — never ends a block
    const lead = rawLine.match(/^[ \t]*/)![0];
    if (lead.includes("\t")) throw new MalformedWorkflow("tab in indentation");
    const indent = lead.length;
    const content = rawLine.slice(indent);
    if (content.startsWith("#")) continue; // full-line comment

    // 1. Inside a block scalar: skip its body (this is what stops `run: |` bodies
    //    being mis-read as env). The block ends at the first line indented <= the key.
    if (s.blockIndent !== null) {
      if (indent > s.blockIndent) continue;
      s.blockIndent = null;
    }

    // 2. Inside an env mapping: deeper lines are entries; a dedent closes it.
    if (s.envIndent !== null) {
      if (indent > s.envIndent) {
        const km = content.match(KEY_LINE);
        if (km) {
          const inlineVal = km[2];
          if (isBlockScalar(inlineVal)) {
            s.blockIndent = indent; // multi-line env value — skip its body, drop the entry
            continue;
          }
          if (
            inlineVal !== undefined &&
            inlineVal.trim() !== "" &&
            !isUndetectableScalar(inlineVal)
          ) {
            entries.push({
              key: km[1]!,
              value: parseScalar(inlineVal),
              job: s.currentJob,
              step: s.currentStep,
              scope: s.envScope,
            });
          }
        }
        continue;
      }
      s.envIndent = null; // fall through to re-process this (shallower) line
    }

    // 3. A mapping list item `- key: …` opens a step; re-process the inline
    //    content as a key at indent+2.
    const listM = content.match(/^-\s+(.*)$/);
    if (listM) {
      const rest = listM[1]!;
      if (KEY_LINE.test(rest)) {
        s.stepKeyIndent = indent + 2;
        s.currentStep = "";
        s.stepLabelFromName = false;
        processKey(s, rest, indent + 2);
      }
      continue; // a scalar list item (e.g. `- staging`) is not a step
    }

    processKey(s, content, indent);
  }
  return entries;
}

// ── detection (policy + merge across files) ──────────────────────────────────

const provenance = (v: { workflow: string; job: string; step: string }): string =>
  `${v.workflow}${v.job ? ` › ${v.job}` : ""}${v.step ? ` › ${v.step}` : ""}`;

const scopeRank = (s: EnvScope): number => (s === "job" ? 0 : 1);

/** Scan every workflow, apply the three policy filters, merge with precedence. */
export function detectGateEnv(source: WorkflowSource): DetectResult {
  const gateEnv: Record<string, string> = {};
  const detected: DetectedVar[] = [];
  const skippedExpressionRefs: DroppedRef[] = [];
  const droppedSecrets: (DroppedRef & { match: string })[] = [];
  const droppedKeys: (DroppedRef & { reason: DroppedKeyReason })[] = [];
  const warnings: { workflow: string; message: string }[] = [];

  for (const workflow of source.listWorkflows()) {
    let raw: RawEnvEntry[];
    try {
      raw = scanWorkflow(source.readWorkflow(workflow));
    } catch (err) {
      if (err instanceof MalformedWorkflow) {
        warnings.push({ workflow, message: err.message });
        continue; // never partial-emit from a file we couldn't structurally parse
      }
      throw err;
    }
    const kept: DetectedVar[] = [];
    for (const e of raw) {
      const ref = { key: e.key, workflow, job: e.job, step: e.step };
      if (e.value.includes("${{")) {
        skippedExpressionRefs.push(ref);
        continue;
      }
      const hits = detectSecrets(e.value);
      if (hits.length > 0) {
        droppedSecrets.push({ ...ref, match: hits.join(", ") });
        continue;
      }
      // Key checks (after the value checks): a reserved loader/path-injection name
      // would hijack the gate subprocess; a non-POSIX name is unusable as an env var.
      if (isReservedEnvKey(e.key)) {
        droppedKeys.push({ ...ref, reason: "reserved" });
        continue;
      }
      if (!POSIX_ENV_NAME.test(e.key)) {
        droppedKeys.push({ ...ref, reason: "invalid-name" });
        continue;
      }
      const dv: DetectedVar = { ...ref, value: e.value, scope: e.scope };
      detected.push(dv);
      kept.push(dv);
    }
    // Within a file, apply job scope before step scope so step env wins on a key
    // collision; across files, later (sorted) files win.
    for (const dv of [...kept].sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope))) {
      gateEnv[dv.key] = dv.value;
    }
  }
  return { gateEnv, detected, skippedExpressionRefs, droppedSecrets, droppedKeys, warnings };
}

// ── merge into the config overlay (gap-fill, operator wins) ───────────────────

export interface GateEnvConflict {
  readonly key: string;
  readonly configured: string;
  readonly detected: string;
  readonly source: string;
}

export interface GateEnvMerge {
  /** The overlay with WRITTEN keys applied via `setAtPath` (other keys untouched). */
  readonly raw: Record<string, unknown>;
  readonly written: string[];
  readonly skipped: string[];
  readonly conflicts: GateEnvConflict[];
}

/**
 * Classify each detected key against the current resolved `gateEnv`:
 *   - absent           → WRITTEN (staged into the overlay)
 *   - present, equal   → SKIPPED (idempotent re-run)
 *   - present, differs → CONFLICT (operator value preserved, reported)
 * Pure — never overwrites an operator-set value (the overlay can't tell an
 * operator edit from a prior detect, so every existing value is treated as owned).
 */
export function mergeDetectedGateEnv(
  raw: Record<string, unknown>,
  current: Record<string, string>,
  detected: Record<string, string>,
  sources: Record<string, string>,
): GateEnvMerge {
  let next = raw;
  const written: string[] = [];
  const skipped: string[] = [];
  const conflicts: GateEnvConflict[] = [];
  for (const key of Object.keys(detected).sort()) {
    const value = detected[key]!;
    if (!(key in current)) {
      next = setAtPath(next, ["quality", "gateEnv", key], value as ConfigValue);
      written.push(key);
    } else if (current[key] === value) {
      skipped.push(key);
    } else {
      conflicts.push({
        key,
        configured: current[key]!,
        detected: value,
        source: sources[key] ?? "",
      });
    }
  }
  return { raw: next, written, skipped, conflicts };
}

// ── orchestration (detect → merge → persist → report) ─────────────────────────

export interface DetectReport {
  readonly detected: Record<string, string>;
  readonly written: string[];
  readonly skipped: string[];
  readonly conflicts: GateEnvConflict[];
  readonly skippedExpressionRefs: { key: string; source: string }[];
  readonly droppedSecrets: { key: string; source: string; match: string }[];
  readonly droppedKeys: { key: string; source: string; reason: DroppedKeyReason }[];
  readonly warnings: { workflow: string; message: string }[];
  /** Provenance per detected key: `workflow › job › step`. */
  readonly sources: Record<string, string>;
  /** The resolved `quality.gateEnv` after the merge. */
  readonly gateEnv: Record<string, string>;
}

/**
 * Detect CI build env at `root`, gap-fill it into `quality.gateEnv`, and return a
 * report. Writes the overlay ONLY when there are new keys (empty detection / all
 * already-set → no disk write). Shared by `configure --detect-gate-env` (ambient
 * data dir) and `scaffold` (which threads its resolved `dataDir` via `dataOpts` so
 * the injectable scaffold core stays pure of the global env).
 */
export async function applyGateEnvDetection(
  root: string,
  dataOpts: DataDirOptions = {},
): Promise<DetectReport> {
  const result = detectGateEnv(new DefaultWorkflowSource(root));
  const sources: Record<string, string> = {};
  for (const v of result.detected) sources[v.key] = provenance(v);

  const current = loadConfig(dataOpts).quality.gateEnv;
  const merge = mergeDetectedGateEnv(readRawConfig(dataOpts), current, result.gateEnv, sources);
  if (merge.written.length > 0) await saveRawConfig(merge.raw, dataOpts);

  const gateEnv: Record<string, string> = { ...current };
  for (const key of merge.written) gateEnv[key] = result.gateEnv[key]!;

  return {
    detected: result.gateEnv,
    written: merge.written,
    skipped: merge.skipped,
    conflicts: merge.conflicts,
    skippedExpressionRefs: result.skippedExpressionRefs.map((r) => ({
      key: r.key,
      source: provenance(r),
    })),
    droppedSecrets: result.droppedSecrets.map((r) => ({
      key: r.key,
      source: provenance(r),
      match: r.match,
    })),
    droppedKeys: result.droppedKeys.map((r) => ({
      key: r.key,
      source: provenance(r),
      reason: r.reason,
    })),
    warnings: [...result.warnings],
    sources,
    gateEnv,
  };
}
