import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpecStore, makeSpecId } from "./store.js";
import { specDir } from "../core/state/paths.js";
import { parseSpecManifest, type SpecManifest } from "./schema.js";
import { SpecPointerSchema } from "../types/index.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ws5-store-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function manifest(over: Partial<SpecManifest> = {}): SpecManifest {
  return parseSpecManifest({
    spec_id: "123-checkout",
    issue_number: 123,
    slug: "checkout",
    repo: "owner/name",
    generated_at: "2026-06-04T00:00:00.000Z",
    tasks: [
      {
        task_id: "task_1",
        title: "Add checkout",
        description: "checkout flow",
        files: ["src/checkout.ts"],
        acceptance_criteria: ["returns 201"],
        tests_to_write: ["returns 201"],
        depends_on: [],
        risk_tier: "medium",
        risk_rationale: "payment",
      },
    ],
    ...over,
  });
}

describe("makeSpecId — issue is the stable key, slug via shared slugify", () => {
  it("spec-id construction: makeSpecId(123,'Checkout Redesign') === '123-checkout-redesign'", () => {
    expect(makeSpecId(123, "Checkout Redesign")).toBe("123-checkout-redesign");
  });
  it("rejects a non-positive issue", () => {
    expect(() => makeSpecId(0, "x")).toThrow();
  });
  it("rejects a slug with no usable characters", () => {
    expect(() => makeSpecId(1, "!!!")).toThrow();
  });
});

describe("SpecStore.write — durable bare-array tasks.json + pointer", () => {
  it("writes spec.md + a BARE tasks.json array and returns a SpecPointer", async () => {
    const store = new SpecStore({ dataDir });
    const m = manifest();
    const pointer = await store.write(m, "# Checkout spec");

    const dir = specDir(dataDir, m.repo, m.spec_id);
    expect(await readFile(join(dir, "spec.md"), "utf8")).toBe("# Checkout spec");

    const tasksRaw = JSON.parse(await readFile(join(dir, "tasks.json"), "utf8"));
    expect(Array.isArray(tasksRaw)).toBe(true); // BARE array, not {tasks:[...]}
    expect(tasksRaw[0].task_id).toBe("task_1");

    expect(SpecPointerSchema.parse(pointer)).toEqual({
      repo: "owner/name",
      spec_id: "123-checkout",
      issue_number: 123,
    });
  });
});

describe("SpecStore.resolveByIssue — Δ X reuse-by-issue-number", () => {
  it("Δ X: returns an existing manifest for a known issue number", async () => {
    const store = new SpecStore({ dataDir });
    await store.write(manifest(), "# spec");

    const found = await store.resolveByIssue("owner/name", 123);
    expect(found).not.toBeNull();
    expect(found!.spec_id).toBe("123-checkout");
    expect(found!.tasks[0]!.task_id).toBe("task_1");
  });

  it("Δ X: looks up by ISSUE NUMBER even when the slug would differ", async () => {
    const store = new SpecStore({ dataDir });
    // Stored slug is "checkout"; a rerun would never re-derive it — issue is the key.
    await store.write(manifest({ spec_id: "123-checkout", slug: "checkout" }), "# spec");
    const found = await store.resolveByIssue("owner/name", 123);
    expect(found!.spec_id).toBe("123-checkout");
  });

  it("returns null when no spec exists for the issue", async () => {
    const store = new SpecStore({ dataDir });
    expect(await store.resolveByIssue("owner/name", 999)).toBeNull();
  });

  it("returns null when the repo dir does not exist", async () => {
    const store = new SpecStore({ dataDir });
    expect(await store.resolveByIssue("nobody/nothing", 1)).toBeNull();
  });

  it("does not confuse issue 12 with issue 123 (exact issue match)", async () => {
    const store = new SpecStore({ dataDir });
    await store.write(manifest({ spec_id: "123-checkout", issue_number: 123 }), "# spec");
    expect(await store.resolveByIssue("owner/name", 12)).toBeNull();
  });

  it("throws loudly on two dirs for the same issue (store-integrity defect)", async () => {
    const store = new SpecStore({ dataDir });
    await store.write(manifest({ spec_id: "123-checkout" }), "# spec");
    await store.write(manifest({ spec_id: "123-checkout-v2", slug: "checkout-v2" }), "# spec");
    await expect(store.resolveByIssue("owner/name", 123)).rejects.toThrow(/multiple specs/);
  });

  it("rejects a non-positive issue number", async () => {
    const store = new SpecStore({ dataDir });
    await expect(store.resolveByIssue("owner/name", 0)).rejects.toThrow();
  });
});

describe("SpecStore.read — round-trips through the durable store", () => {
  it("reconstructs the manifest from the on-disk bare array + sidecar", async () => {
    const store = new SpecStore({ dataDir });
    const m = manifest();
    await store.write(m, "# spec");
    const read = await store.read("owner/name", "123-checkout");
    expect(read.issue_number).toBe(123);
    expect(read.slug).toBe("checkout");
    expect(read.generated_at).toBe("2026-06-04T00:00:00.000Z");
    expect(read.tasks).toEqual(m.tasks);
  });

  it("fails loud on a corrupt durable spec rather than treating it as a miss", async () => {
    const store = new SpecStore({ dataDir });
    const dir = specDir(dataDir, "owner/name", "123-broken");
    await mkdir(dir, { recursive: true });
    // Write an invalid tasks.json (legacy risk value) + a sidecar.
    await writeFile(
      join(dir, "tasks.json"),
      JSON.stringify([{ task_id: "x", risk_tier: "security" }]),
    );
    await writeFile(
      join(dir, "spec.meta.json"),
      JSON.stringify({ issue_number: 123, slug: "broken", repo: "owner/name", generated_at: "t" }),
    );
    await expect(store.resolveByIssue("owner/name", 123)).rejects.toThrow();
  });
});
