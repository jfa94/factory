// src/driver/workflow-envelope.test.ts
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
    // Arrays survive as arrays (not stringified) — the corruption this guards against.
    expect(env.ready).toEqual(["T1", "T2"]);
    expect(env.cascade_dropped).toEqual([]);
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
    expect(env.expects).toBe("reviews");
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
