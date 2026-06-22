import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDocsApplicable } from "./docs-applicable.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "docs-app-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isDocsApplicable", () => {
  it("false when no /docs directory", async () => {
    expect(await isDocsApplicable(dir)).toBe(false);
  });

  it("true when /docs exists and no opt-out", async () => {
    await mkdir(join(dir, "docs"));
    expect(await isDocsApplicable(dir)).toBe(true);
  });

  it("true when /docs exists and package.json present without opt-out", async () => {
    await mkdir(join(dir, "docs"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    expect(await isDocsApplicable(dir)).toBe(true);
  });

  it("false when factory.docs.enabled === false", async () => {
    await mkdir(join(dir, "docs"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ factory: { docs: { enabled: false } } }),
    );
    expect(await isDocsApplicable(dir)).toBe(false);
  });

  it("true when factory.docs.enabled === true", async () => {
    await mkdir(join(dir, "docs"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ factory: { docs: { enabled: true } } }),
    );
    expect(await isDocsApplicable(dir)).toBe(true);
  });
});
