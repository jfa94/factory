// src/orchestrator/workflow-envelope.test.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DRIVE_KINDS, NEXT_KINDS, parseEnvelope, type EnvelopeKind } from "./workflow-envelope.js";

describe("NEXT_KINDS / DRIVE_KINDS (engine-derived)", () => {
  // The authoritative discriminants, copied from the engine unions:
  //   NextTask  (src/orchestrator/next.ts)      = work | finalize | document | done | pause
  //   NextAction (src/orchestrator/orchestrator.ts) = spawn | terminal | quota-blocked
  // The sets themselves are derived from a `Record<Union["kind"], true>` mirror,
  // so omitting a kind is a compile error; this test pins the runtime values to
  // the same authoritative lists (catching an accidental EXTRA kind in the mirror).
  const NEXT_AUTHORITATIVE = ["work", "finalize", "document", "e2e", "done", "pause"];
  const DRIVE_AUTHORITATIVE = ["spawn", "done", "pause"];

  it("NEXT_KINDS is exactly the NextTask discriminants", () => {
    expect([...NEXT_KINDS].sort()).toEqual([...NEXT_AUTHORITATIVE].sort());
  });

  it("DRIVE_KINDS is exactly the NextAction discriminants", () => {
    expect([...DRIVE_KINDS].sort()).toEqual([...DRIVE_AUTHORITATIVE].sort());
  });

  it("the sets carry no duplicates or extras (size matches the authoritative list)", () => {
    expect(NEXT_KINDS.size).toBe(NEXT_AUTHORITATIVE.length);
    expect(DRIVE_KINDS.size).toBe(DRIVE_AUTHORITATIVE.length);
  });
});

describe("parseEnvelope — happy path", () => {
  it("parses a verbatim NextTask and preserves every field", () => {
    const raw = JSON.stringify({
      kind: "work",
      run_id: "run-1",
      data_dir: "/d",
      ship_mode: "pr",
      ready: ["T1", "T2"],
      cascade_failed: [],
    });
    const env = parseEnvelope(raw, NEXT_KINDS, "next");
    expect(env.kind).toBe("work");
    // Switching on the discriminant narrows to the per-variant payload type — the
    // C2 improvement (no bare `{ [field]: unknown }`). Inside this arm `env.ready`
    // and `env.cascade_failed` are statically typed string[] / fail[].
    if (env.kind !== "work") throw new Error("expected work");
    // Bind to the concrete per-variant types — this is the type-level regression
    // guard: if C2 regressed to `{ [field]: unknown }` these annotations would be
    // `unknown`-source assignments and FAIL the build (not just pass at runtime).
    const ready: readonly string[] = env.ready;
    const cascadeFailed: readonly string[] = env.cascade_failed;
    // Arrays survive as arrays (not stringified) — the corruption this guards against.
    expect(ready).toEqual(["T1", "T2"]);
    expect(cascadeFailed).toEqual([]);
    expect(env.run_id).toBe("run-1");
  });

  it("parses each known NextTask kind", () => {
    for (const kind of NEXT_KINDS) {
      const env = parseEnvelope(JSON.stringify({ kind }), NEXT_KINDS, "next");
      expect(env.kind).toBe(kind);
    }
  });

  it("parses a verbatim NextAction spawn", () => {
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
      kind_type: "work",
      ready: '["T1","T2"]',
      cascade_failed: "[]",
    });
    expect(() => parseEnvelope(raw, NEXT_KINDS, "next")).toThrow(/factory-envelope/);
  });

  it("throws naming the context (next) and the allowed kinds", () => {
    const raw = JSON.stringify({ kind: "factory-envelope" });
    expect(() => parseEnvelope(raw, NEXT_KINDS, "next")).toThrow(/next/);
    expect(() => parseEnvelope(raw, NEXT_KINDS, "next")).toThrow(/work/);
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
    expect(() => parseEnvelope(JSON.stringify("work"), NEXT_KINDS, "next")).toThrow();
  });

  it("throws on a JSON array — not an object", () => {
    expect(() => parseEnvelope(JSON.stringify(["work"]), NEXT_KINDS, "next")).toThrow();
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

describe("parseEnvelope — markdown-fence tolerance (blocker #9 backstop)", () => {
  // A flaky exec-agent may wrap the verbatim stdout in a ```json … ``` block despite
  // the "no fences" instruction. The deterministic guard strips a FULLY-WRAPPING fence
  // so the most common LLM-output flake doesn't fail the run — defense-in-depth behind
  // the sonnet model upgrade.
  const json = JSON.stringify({ kind: "work", ready: ["T1", "T2"], cascade_failed: [] });

  it("strips a ```json fence and parses the inner envelope", () => {
    const env = parseEnvelope("```json\n" + json + "\n```", NEXT_KINDS, "next");
    expect(env.kind).toBe("work");
    if (env.kind !== "work") throw new Error("expected work");
    expect(env.ready).toEqual(["T1", "T2"]); // arrays survive, not stringified
  });

  it("strips a bare ``` fence (no language tag)", () => {
    const env = parseEnvelope("```\n" + json + "\n```", NEXT_KINDS, "next");
    expect(env.kind).toBe("work");
  });

  it("tolerates surrounding whitespace/newlines around a fenced payload", () => {
    const env = parseEnvelope("  \n```json\n" + json + "\n```\n  ", NEXT_KINDS, "next");
    expect(env.kind).toBe("work");
  });

  it("does NOT mangle an unfenced envelope whose string VALUE contains a ``` run", () => {
    // A review finding can quote a code fence; the strip is anchored to the WHOLE
    // string, so a ``` inside a value (the payload starts with `{`) is never touched.
    const raw = JSON.stringify({ kind: "spawn", task_id: "T1", note: "fence ``` here" });
    const env = parseEnvelope(raw, DRIVE_KINDS, "drive");
    expect(env.kind).toBe("spawn");
    expect((env as { note?: string }).note).toBe("fence ``` here");
  });

  it("a fenced block wrapping NON-JSON still throws loud (no silent pass)", () => {
    expect(() => parseEnvelope("```json\nnot json at all\n```", NEXT_KINDS, "next")).toThrow();
  });

  it("recovers a fence with a non-json language tag (```js, ```text, etc.)", () => {
    // The strip drops the ENTIRE opening fence line (``` + any tag) up to the first
    // newline, so a mislabeled fence still recovers — not just ``` / ```json. The old
    // regex hard-coded `(?:json)?` and left every other tag fenced-then-failing.
    for (const tag of ["js", "javascript", "text", "sh", "python"]) {
      const env = parseEnvelope("```" + tag + "\n" + json + "\n```", NEXT_KINDS, "next");
      expect(env.kind, `tag=${tag}`).toBe("work");
    }
  });

  it("an unclosed, whitespace-heavy fence fails loud and fast (ReDoS guard)", () => {
    // The prior /^```(?:json)?\s*([\s\S]*?)\s*```$/ backtracked for SECONDS on this
    // input (dueling \s* runs over an unterminated body). The string-ops strip is O(n):
    // it throws immediately. A hang would surface here as a vitest timeout, not a pass.
    const pathological = "```json" + " ".repeat(5000);
    expect(() => parseEnvelope(pathological, NEXT_KINDS, "next")).toThrow();
  });
});

describe("EnvelopeKind type", () => {
  it("accepts the union of both kind sets at compile time", () => {
    const k: EnvelopeKind = "spawn";
    expect(DRIVE_KINDS.has(k)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Drift guard — the inline copy in scripts/factory-run-runner.js MUST stay
// behaviorally identical to the TS source of truth above. The Workflow runtime
// cannot import this module (it injects readonly globals and nothing else), so the
// orchestrator script INLINES parseEnvelope + the kind sets as a deliberate byte-for-byte
// mirror with NO compile-time link. This test reconstructs the SHIPPED JS bytes in
// isolation (the script has top-level side effects, so it can't just be imported) and
// runs the same input battery through both implementations — any divergence (a kind
// added to one set only, an edited branch, a changed message) fails HERE, where the
// vitest coverage lives, instead of silently re-opening the boundary corruption.
// ---------------------------------------------------------------------------
describe("inline workflow-orchestrator mirror stays in lockstep (drift guard)", () => {
  const driverSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../scripts/factory-run-runner.js"),
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
      raw: JSON.stringify({ kind: "work", ready: ["T1"], cascade_failed: [] }),
      set: "next",
    },
    { name: "valid run-terminal", raw: JSON.stringify({ kind: "done" }), set: "next" },
    { name: "valid spawn", raw: JSON.stringify({ kind: "spawn", task_id: "T1" }), set: "drive" },
    { name: "valid terminal", raw: JSON.stringify({ kind: "done" }), set: "drive" },
    {
      name: "shared quota-blocked (next)",
      raw: JSON.stringify({ kind: "pause" }),
      set: "next",
    },
    { name: "non-string raw", raw: 42, set: "next" },
    { name: "invalid JSON", raw: "{ not json", set: "next" },
    { name: "empty string", raw: "", set: "next" },
    { name: "array top-level", raw: "[1,2,3]", set: "next" },
    { name: "json null", raw: "null", set: "next" },
    { name: "json primitive string", raw: JSON.stringify("work"), set: "next" },
    { name: "missing kind", raw: JSON.stringify({ run_id: "r" }), set: "next" },
    { name: "non-string kind", raw: JSON.stringify({ kind: 7 }), set: "next" },
    {
      name: "unknown kind (re-key)",
      raw: JSON.stringify({ kind: "factory-envelope", ready: '["T1"]' }),
      set: "next",
    },
    { name: "drive kind to next set", raw: JSON.stringify({ kind: "spawn" }), set: "next" },
    { name: "next kind to drive set", raw: JSON.stringify({ kind: "work" }), set: "drive" },
    {
      name: "long payload (preview truncation branch)",
      raw: JSON.stringify({ kind: "z".repeat(300) }),
      set: "next",
    },
    {
      name: "fenced ```json wrapper (strip branch)",
      raw: "```json\n" + JSON.stringify({ kind: "work", ready: ["T1"] }) + "\n```",
      set: "next",
    },
    {
      name: "bare ``` fenced wrapper (strip branch)",
      raw: "```\n" + JSON.stringify({ kind: "spawn", task_id: "T1" }) + "\n```",
      set: "drive",
    },
    { name: "fenced non-json (strip then fail)", raw: "```json\nnot json\n```", set: "next" },
    {
      name: "internal ``` in value (anchor must NOT fire)",
      raw: JSON.stringify({ kind: "done", note: "fence ``` here" }),
      set: "drive",
    },
    {
      name: "non-json lang-tag fence (```js strip branch)",
      raw: "```js\n" + JSON.stringify({ kind: "spawn", task_id: "T1" }) + "\n```",
      set: "drive",
    },
    {
      name: "whitespace-padded fence (trim branch)",
      raw: "  \n```json\n" + JSON.stringify({ kind: "work", ready: ["T1"] }) + "\n```\n  ",
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
