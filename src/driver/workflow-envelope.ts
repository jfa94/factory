// src/driver/workflow-envelope.ts
/**
 * The DETERMINISTIC parse + kind-guard that the workflow driver applies
 * to a `factory next` / `factory drive` envelope after it crosses the haiku
 * exec-agent boundary back into Workflow JS.
 *
 * WHY THIS EXISTS — the workflow boundary corruption (root cause, run
 * `run-20260616-134715`):
 *   The Workflow sandbox has no fs / Bash / Node — a CLI's stdout can only return
 *   to the JS through an `agent()` return value. The old contract handed the agent
 *   the TYPED envelope under a loose schema (`additionalProperties:true`,
 *   `required:["kind"]`) and asked it to "return that JSON object verbatim as your
 *   structured output." Re-emitting a typed object invited the model to re-key it:
 *     {kind:"tasks-ready", ready:["T1","T2"], …}
 *       →  {kind:"factory-envelope", kind_type:"tasks-ready",
 *           ready:"[\"T1\",\"T2\"]" (stringified), cascade_dropped:"[]"}
 *   The loose schema caught none of it; the run mis-drove and died at the JS kind
 *   guard with `unknown envelope kind 'factory-envelope'`.
 *
 * THE FIX — reduce what crosses the boundary to ONE opaque string the model
 *   COPIES (schema `{raw}` + "return stdout verbatim"), then `JSON.parse` and
 *   kind-guard HERE, in the engine, deterministically. {@link parseEnvelope} is
 *   that guard. Session mode never touches this path (it shells out directly; no
 *   LLM in the data flow).
 *
 * SOURCE-OF-TRUTH / DELIBERATE MIRROR: the Workflow runtime cannot `import` or
 *   `require` a sibling module (it injects 8 readonly globals and nothing else),
 *   so `scripts/factory-run-driver.js` INLINES a byte-identical copy of
 *   {@link parseEnvelope} + the kind sets below. This module is the tested source
 *   of truth; the workflow's inline copy carries a comment pointing back here.
 *   Keep the two in lockstep — a drift is a silent re-introduction of the bug.
 */
import type { NextEnvelope } from "./next.js";
import type { DriveEnvelope } from "./coroutine.js";

/**
 * The authoritative kind sets, DERIVED from the engine's envelope unions so they
 * cannot silently drift. Each set's membership is the key set of a
 * `Record<Union["kind"], true>` — the typechecker forces EVERY union member to be
 * a key, so OMITTING a kind (e.g. adding a new {@link NextEnvelope} variant and
 * forgetting to list it) is a compile error (TS2741, "missing property"). The
 * runtime values come from `Object.keys` of that record, so the engine union is
 * the single source of truth for both the type AND the runtime set.
 *
 * (`satisfies T[]` alone — the prior idiom — only asserted each element was
 * assignable, NOT exhaustiveness: a bogus kind erred, but a missing one stayed
 * green. The `Record` mirror closes that hole.)
 */
const NEXT_KIND_MIRROR: Record<NextEnvelope["kind"], true> = {
  "tasks-ready": true,
  "all-terminal": true,
  "run-terminal": true,
  "quota-blocked": true,
};
const DRIVE_KIND_MIRROR: Record<DriveEnvelope["kind"], true> = {
  spawn: true,
  terminal: true,
  "quota-blocked": true,
};

export const NEXT_KINDS: ReadonlySet<NextEnvelope["kind"]> = new Set(
  Object.keys(NEXT_KIND_MIRROR) as NextEnvelope["kind"][],
);
export const DRIVE_KINDS: ReadonlySet<DriveEnvelope["kind"]> = new Set(
  Object.keys(DRIVE_KIND_MIRROR) as DriveEnvelope["kind"][],
);

export type EnvelopeKind = NextEnvelope["kind"] | DriveEnvelope["kind"];

/** Every engine envelope variant — the typed contract the engine serializes. */
export type EngineEnvelope = NextEnvelope | DriveEnvelope;

/**
 * Parse one verbatim-copied CLI stdout string and assert its `kind` discriminant
 * is one the engine actually emits. FAILS LOUD — naming the offending value — on:
 * non-string input, non-JSON / empty text, a non-object (primitive/array/null)
 * top level, a missing or non-string `kind`, or a `kind` outside `knownKinds`.
 *
 * Generic over the kind set: passing {@link NEXT_KINDS} narrows the return to the
 * `NextEnvelope` variants, {@link DRIVE_KINDS} to the `DriveEnvelope` variants, so
 * a caller can `switch (env.kind)` and get the right per-variant PAYLOAD type
 * instead of a bare `{ [field]: unknown }`. The narrowing is a single documented
 * cast at the `return` (see there): the engine is the TRUSTED producer of a
 * well-formed {@link EngineEnvelope}, and only the `kind` discriminant — the exact
 * field the exec-agent re-keys — is re-validated at this boundary; the payload
 * shape is the engine's typed contract, not re-checked here.
 *
 * Over-wideness caveat: `"quota-blocked"` is the ONE kind shared by both unions,
 * so for that single variant `Extract` returns BOTH the Next and Drive payload
 * shapes (a `NEXT_KINDS` call could surface the Drive quota-blocked member). Every
 * non-shared kind narrows to its exact variant. This is harmless — the cast still
 * yields a genuine engine value — and only matters if a caller reads
 * quota-blocked-specific fields without re-narrowing by union.
 *
 * @param raw        the agent's verbatim stdout echo (`env.raw`).
 * @param knownKinds {@link NEXT_KINDS} or {@link DRIVE_KINDS} for the call site.
 * @param context    "next" | "drive" — named in the error so a corruption points
 *                   at the boundary it crossed.
 */
export function parseEnvelope<K extends EnvelopeKind>(
  raw: string,
  knownKinds: ReadonlySet<K>,
  context: "next" | "drive",
): Extract<EngineEnvelope, { kind: K }> {
  if (typeof raw !== "string") {
    throw new Error(
      `${context}: envelope raw must be a string, got ${typeof raw} — the exec-agent did not ` +
        `return {raw: "<stdout>"}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const preview = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
    throw new Error(
      `${context}: exec-agent stdout was not valid JSON (${detail}) — raw was: ${JSON.stringify(
        preview,
      )}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${context}: envelope must be a JSON object, got ${
        Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed
      } — ${JSON.stringify(parsed)}`,
    );
  }
  const env = parsed as Record<string, unknown>;
  if (typeof env.kind !== "string") {
    throw new Error(
      `${context}: envelope has no string 'kind' (got ${JSON.stringify(env.kind)}) — the ` +
        `exec-agent re-keyed the engine envelope instead of copying stdout verbatim`,
    );
  }
  // `knownKinds` is typed `ReadonlySet<K>`; widen for the membership test since
  // `env.kind` is still an unvalidated `string` here (this IS the validation). The
  // cast is TS-only — the inline JS mirror in the workflow runs `knownKinds.has(...)`
  // verbatim, so runtime behavior stays byte-identical.
  if (!(knownKinds as ReadonlySet<string>).has(env.kind)) {
    throw new Error(
      `${context}: unknown envelope kind '${env.kind}' (expected one of ` +
        `${[...knownKinds].map((k) => `'${k}'`).join(", ")}) — the exec-agent corrupted the ` +
        `engine envelope at the workflow boundary`,
    );
  }
  // DOCUMENTED CAST: `kind` is now a verified member of `knownKinds`, so the value
  // is one of the `Extract<EngineEnvelope, { kind: K }>` variants. We assert the
  // PAYLOAD shape (not re-validated above) on the strength of the engine being the
  // trusted producer — the only corruption this boundary defends against is the
  // exec-agent re-keying `kind`, which the membership check already caught.
  return env as Extract<EngineEnvelope, { kind: K }>;
}
