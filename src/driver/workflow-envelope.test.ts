// src/driver/workflow-envelope.test.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DRIVE_KINDS, NEXT_KINDS, parseEnvelope, type EnvelopeKind } from "./workflow-envelope.js";

describe("NEXT_KINDS / DRIVE_KINDS (engine-derived)", () => {
  // The authoritative discriminants, copied from the engine unions:
  //   NextEnvelope  (src/driver/next.ts)      = tasks-ready | all-terminal | run-terminal | quota-blocked
  //   DriveEnvelope (src/driver/coroutine.ts) = spawn | terminal | quota-blocked
  // The sets themselves are derived from a `Record<Union["kind"], true>` mirror,
  // so omitting a kind is a compile error; this test pins the runtime values to
  // the same authoritative lists (catching an accidental EXTRA kind in the mirror).
  const NEXT_AUTHORITATIVE = ["tasks-ready", "all-terminal", "run-terminal", "quota-blocked"];
  const DRIVE_AUTHORITATIVE = ["spawn", "terminal", "quota-blocked"];

  it("NEXT_KINDS is exactly the NextEnvelope discriminants", () => {
    expect([...NEXT_KINDS].sort()).toEqual([...NEXT_AUTHORITATIVE].sort());
  });

  it("DRIVE_KINDS is exactly the DriveEnvelope discriminants", () => {
    expect([...DRIVE_KINDS].sort()).toEqual([...DRIVE_AUTHORITATIVE].sort());
  });

  it("the sets carry no duplicates or extras (size matches the authoritative list)", () => {
    expect(NEXT_KINDS.size).toBe(NEXT_AUTHORITATIVE.length);
    expect(DRIVE_KINDS.size).toBe(DRIVE_AUTHORITATIVE.length);
  });
});

describe("parseEnvelope — happy path", () => {
  it("parses a verbatim NextEnvelope and preserves every field", () => {
    const raw = JSON.stringify({
      kind: "tasks-ready",
      run_id: "run-1",
      data_dir: "/d",
      ship_mode: "pr",
      ready: ["T1", "T2"],
      cascade_dropped: [],
    });
    const env = parseEnvelope(raw, NEXT_KINDS, "next");
    expect(env.kind).toBe("tasks-ready");
    // Switching on the discriminant narrows to the per-variant payload type — the
    // C2 improvement (no bare `{ [field]: unknown }`). Inside this arm `env.ready`
    // and `env.cascade_dropped` are statically typed string[] / drop[].
    if (env.kind !== "tasks-ready") throw new Error("expected tasks-ready");
    // Bind to the concrete per-variant types — this is the type-level regression
    // guard: if C2 regressed to `{ [field]: unknown }` these annotations would be
    // `unknown`-source assignments and FAIL the build (not just pass at runtime).
    const ready: readonly string[] = env.ready;
    const cascadeDropped: readonly string[] = env.cascade_dropped;
    // Arrays survive as arrays (not stringified) — the corruption this guards against.
    expect(ready).toEqual(["T1", "T2"]);
    expect(cascadeDropped).toEqual([]);
    expect(env.run_id).toBe("run-1");
  });

  it("parses each known NextEnvelope kind", () => {
    for (const kind of NEXT_KINDS) {
      const env = parseEnvelope(JSON.stringify({ kind }), NEXT_KINDS, "next");
      expect(env.kind).toBe(kind);
    }
  });

  it("parses a verbatim DriveEnvelope spawn", () => {
    const raw = JSON.stringify({ kind: "spawn", run_id: "r", task_id: "T1", expects: "reviews" });
    const env = parseEnvelope(raw, DRIVE_KINDS, "drive");
    expect(env.kind).toBe("spawn");
    // Narrowing to the spawn arm exposes its typed `expects` field.
    if (env.kind !== "spawn") throw new Error("expected spawn");
    // Concrete-typed binding — bites at compile time if the narrowing regresses.
    const expects: string = env.expects;
    expect(expects).toBe("reviews");
  });
});

describe("parseEnvelope — corrupt kind (the re-key failure)", () => {
  it("throws naming the offending kind value when re-keyed to 'factory-envelope'", () => {
    // The exact corruption seen in run-20260616-134715.
    const raw = JSON.stringify({
      kind: "factory-envelope",
      kind_type: "tasks-ready",
      ready: '["T1","T2"]',
      cascade_dropped: "[]",
    });
    expect(() => parseEnvelope(raw, NEXT_KINDS, "next")).toThrow(/factory-envelope/);
  });

  it("throws naming the context (next) and the allowed kinds", () => {
    const raw = JSON.stringify({ kind: "factory-envelope" });
    expect(() => parseEnvelope(raw, NEXT_KINDS, "next")).toThrow(/next/);
    expect(() => parseEnvelope(raw, NEXT_KINDS, "next")).toThrow(/tasks-ready/);
  });

  it("rejects a valid Drive kind handed to a Next call site (wrong set)", () => {
    const raw = JSON.stringify({ kind: "spawn" });
    expect(() => parseEnvelope(raw, NEXT_KINDS, "next")).toThrow(/spawn/);
  });

  it("rejects a missing kind", () => {
    const raw = JSON.stringify({ run_id: "r", ready: [] });
    expect(() => parseEnvelope(raw, NEXT_KINDS, "next")).toThrow();
  });

  it("rejects a non-string kind", () => {
    const raw = JSON.stringify({ kind: 42 });
    expect(() => parseEnvelope(raw, NEXT_KINDS, "next")).toThrow();
  });

  it("missing kind surfaces the raw payload and names the real failure modes (not just 're-key')", () => {
    // The exact misattribution from run-20260620-085154: the engine crashed with EMPTY
    // stdout (an --expect-mode mismatch) and the exec-agent FABRICATED a kindless object.
    // The error must show the bytes and name fabrication/swallowed-exit, not blame a re-key.
    const raw = JSON.stringify({ error: "expect-mode mismatch: session != workflow", run_id: "r" });
    expect(() => parseEnvelope(raw, NEXT_KINDS, "next")).toThrow(/raw was:/);
    expect(() => parseEnvelope(raw, NEXT_KINDS, "next")).toThrow(/expect-mode mismatch/);
    expect(() => parseEnvelope(raw, NEXT_KINDS, "next")).toThrow(/fabricated|swallowed/);
  });

  it("unknown kind surfaces the raw payload too (legible corruption, not bare blame)", () => {
    const raw = JSON.stringify({ kind: "factory-envelope", ready: '["T1","T2"]' });
    expect(() => parseEnvelope(raw, NEXT_KINDS, "next")).toThrow(/raw was:/);
    expect(() => parseEnvelope(raw, NEXT_KINDS, "next")).toThrow(/T1/);
  });
});

describe("parseEnvelope — garbage / non-JSON", () => {
  it("throws on non-JSON garbage, surfacing the offending text", () => {
    expect(() => parseEnvelope("not json at all", NEXT_KINDS, "next")).toThrow();
  });

  it("throws on empty string", () => {
    expect(() => parseEnvelope("", NEXT_KINDS, "next")).toThrow();
  });

  it("throws on a JSON primitive (string) — not an object", () => {
    expect(() => parseEnvelope(JSON.stringify("tasks-ready"), NEXT_KINDS, "next")).toThrow();
  });

  it("throws on a JSON array — not an object", () => {
    expect(() => parseEnvelope(JSON.stringify(["tasks-ready"]), NEXT_KINDS, "next")).toThrow();
  });

  it("throws on JSON null", () => {
    expect(() => parseEnvelope("null", NEXT_KINDS, "next")).toThrow();
  });

  it("throws on a non-string raw input (defensive)", () => {
    // The workflow hands env.raw; if the schema were violated and raw arrived as
    // a non-string, the guard must still fail loud rather than JSON.parse-coerce.
    expect(() => parseEnvelope(undefined as unknown as string, NEXT_KINDS, "next")).toThrow();
  });
});

describe("EnvelopeKind type", () => {
  it("accepts the union of both kind sets at compile time", () => {
    const k: EnvelopeKind = "spawn";
    expect(DRIVE_KINDS.has(k)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Drift guard — the inline copy in scripts/factory-run-driver.js MUST stay
// behaviorally identical to the TS source of truth above. The Workflow runtime
// cannot import this module (it injects readonly globals and nothing else), so the
// driver script INLINES parseEnvelope + the kind sets as a deliberate byte-for-byte
// mirror with NO compile-time link. This test reconstructs the SHIPPED JS bytes in
// isolation (the script has top-level side effects, so it can't just be imported) and
// runs the same input battery through both implementations — any divergence (a kind
// added to one set only, an edited branch, a changed message) fails HERE, where the
// vitest coverage lives, instead of silently re-opening the boundary corruption.
// ---------------------------------------------------------------------------
describe("inline workflow-driver mirror stays in lockstep (drift guard)", () => {
  const driverSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../scripts/factory-run-driver.js"),
    "utf8",
  );

  const nextSetSrc = /const NEXT_KINDS = (new Set\(\[[^\]]*\]\))/.exec(driverSrc)?.[1];
  const driveSetSrc = /const DRIVE_KINDS = (new Set\(\[[^\]]*\]\))/.exec(driverSrc)?.[1];
  const fnStart = driverSrc.indexOf("function parseEnvelope(");
  // The inline function ends at the next top-level declaration; slicing to that anchor
  // is robust to the braces/template-literals inside the function body.
  const fnEnd = driverSrc.indexOf("\nconst STATUS_OUT", fnStart);

  it("the inline definitions are present (extraction sanity)", () => {
    expect(nextSetSrc, "inline NEXT_KINDS not found").not.toBeUndefined();
    expect(driveSetSrc, "inline DRIVE_KINDS not found").not.toBeUndefined();
    expect(fnStart, "inline parseEnvelope not found").toBeGreaterThanOrEqual(0);
    expect(fnEnd, "STATUS_OUT anchor not found").toBeGreaterThan(fnStart);
  });

  if (nextSetSrc === undefined || driveSetSrc === undefined || fnStart < 0 || fnEnd <= fnStart) {
    // Extraction failed — the sanity test above reports it; nothing more to compare.
    return;
  }

  // Reconstruct the inline copies (the body refs only JSON/Error/Array/String globals).
  const jsNext = new Function(`return ${nextSetSrc};`)() as Set<string>;
  const jsDrive = new Function(`return ${driveSetSrc};`)() as Set<string>;
  const jsParse = new Function(`return (${driverSrc.slice(fnStart, fnEnd).trim()});`)() as (
    raw: unknown,
    knownKinds: ReadonlySet<string>,
    context: string,
  ) => unknown;

  it("inline NEXT_KINDS matches the TS source of truth", () => {
    expect([...jsNext].sort()).toEqual([...NEXT_KINDS].sort());
  });

  it("inline DRIVE_KINDS matches the TS source of truth", () => {
    expect([...jsDrive].sort()).toEqual([...DRIVE_KINDS].sort());
  });

  type Probe = { name: string; raw: unknown; set: "next" | "drive" };
  const PROBES: Probe[] = [
    {
      name: "valid tasks-ready",
      raw: JSON.stringify({ kind: "tasks-ready", ready: ["T1"], cascade_dropped: [] }),
      set: "next",
    },
    { name: "valid run-terminal", raw: JSON.stringify({ kind: "run-terminal" }), set: "next" },
    { name: "valid spawn", raw: JSON.stringify({ kind: "spawn", task_id: "T1" }), set: "drive" },
    { name: "valid terminal", raw: JSON.stringify({ kind: "terminal" }), set: "drive" },
    {
      name: "shared quota-blocked (next)",
      raw: JSON.stringify({ kind: "quota-blocked" }),
      set: "next",
    },
    { name: "non-string raw", raw: 42, set: "next" },
    { name: "invalid JSON", raw: "{ not json", set: "next" },
    { name: "empty string", raw: "", set: "next" },
    { name: "array top-level", raw: "[1,2,3]", set: "next" },
    { name: "json null", raw: "null", set: "next" },
    { name: "json primitive string", raw: JSON.stringify("tasks-ready"), set: "next" },
    { name: "missing kind", raw: JSON.stringify({ run_id: "r" }), set: "next" },
    { name: "non-string kind", raw: JSON.stringify({ kind: 7 }), set: "next" },
    {
      name: "unknown kind (re-key)",
      raw: JSON.stringify({ kind: "factory-envelope", ready: '["T1"]' }),
      set: "next",
    },
    { name: "drive kind to next set", raw: JSON.stringify({ kind: "spawn" }), set: "next" },
    { name: "next kind to drive set", raw: JSON.stringify({ kind: "tasks-ready" }), set: "drive" },
    {
      name: "long payload (preview truncation branch)",
      raw: JSON.stringify({ kind: "z".repeat(300) }),
      set: "next",
    },
  ];

  type Outcome = { ok: true; value: unknown } | { ok: false; message: string };
  const call = (
    fn: (raw: unknown, k: ReadonlySet<string>, c: string) => unknown,
    raw: unknown,
    k: ReadonlySet<string>,
    c: string,
  ): Outcome => {
    try {
      return { ok: true, value: fn(raw, k, c) };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  };

  // For EVERY branch, the inline JS copy must produce the IDENTICAL outcome (return
  // value, or thrown message verbatim) as the TS parseEnvelope.
  it.each(PROBES)("identical outcome for: $name", ({ raw, set }) => {
    const tsSet = (set === "next" ? NEXT_KINDS : DRIVE_KINDS) as ReadonlySet<string>;
    const jsSet = set === "next" ? jsNext : jsDrive;
    const ts = call(
      (r, k, c) =>
        parseEnvelope(r as string, k as ReadonlySet<EnvelopeKind>, c as "next" | "drive"),
      raw,
      tsSet,
      set,
    );
    const js = call(jsParse, raw, jsSet, set);
    expect(js.ok).toBe(ts.ok);
    if (ts.ok && js.ok) expect(js.value).toEqual(ts.value);
    else if (!ts.ok && !js.ok) expect(js.message).toBe(ts.message);
  });
});
