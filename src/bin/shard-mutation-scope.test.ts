/**
 * Build-staleness guard: the checked-in scaffold template
 * `templates/.github/scripts/shard-mutation-scope.mjs` is GENERATED from
 * `src/bin/shard-mutation-scope.ts` by scripts/build.mjs. This test re-bundles in
 * memory and asserts byte-equality with the committed artifact, so any drift
 * between the tested TS source and the shipped template fails CI (you forgot to
 * re-run `npm run build`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type BuildOptions } from "esbuild";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");

// build.mjs is plain JS (run by node directly, never compiled) — import it
// dynamically with an explicit shape rather than a static untyped import.
async function loadBuildModule(): Promise<{
  SHARD_TEMPLATE: { entry: string; out: string };
  shardTemplateBuildOptions: () => BuildOptions;
}> {
  // @ts-expect-error build.mjs is plain JS run by node directly — no .d.ts exists.
  return (await import("../../scripts/build.mjs")) as never;
}

describe("shard-mutation-scope template", () => {
  it("checked-in template matches a fresh esbuild of the source", async () => {
    const { SHARD_TEMPLATE, shardTemplateBuildOptions } = await loadBuildModule();
    const result = await build({ ...shardTemplateBuildOptions(), write: false });
    const generated = result.outputFiles?.[0]?.text ?? "";
    const committed = readFileSync(resolve(repoRoot, SHARD_TEMPLATE.out), "utf8");
    expect(generated).toBe(committed);
  });
});
