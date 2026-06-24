/**
 * Tests for CI build-env auto-detection. The pure scanner/merge tests inject a
 * fake {@link WorkflowSource} (fixture YAML strings — no disk). The
 * `applyGateEnvDetection` tests use a temp `$CLAUDE_PLUGIN_DATA` + on-disk
 * `.github/workflows` so the detect→merge→persist round-trip exercises real I/O,
 * mirroring configure.test.ts's harness.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectGateEnv,
  mergeDetectedGateEnv,
  applyGateEnvDetection,
  type WorkflowSource,
} from "./detect-gate-env.js";

/** A fake source backed by an in-memory `{ basename → text }` map. */
function fakeSource(files: Record<string, string>): WorkflowSource {
  return {
    listWorkflows: () => Object.keys(files).sort(),
    readWorkflow: (name) => files[name]!,
  };
}

// The real goodbyespy quality-gate.yml build step + a mutation step whose env is
// all `${{ }}` refs — the case the whole feature exists to handle.
const GOODBYESPY = `name: Quality Gate

on:
  pull_request:
    branches: [staging, develop]

concurrency:
  group: quality-\${{ github.head_ref }}
  cancel-in-progress: true

jobs:
  quality:
    name: Quality
    runs-on: ubuntu-latest
    steps:
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
        env:
          NEXT_PUBLIC_SUPABASE_URL: http://localhost:54321
          NEXT_PUBLIC_SUPABASE_KEY: ci-placeholder
          NEXT_SECRET_SUPABASE_KEY: ci-placeholder
      - run: pnpm deps:validate

  mutation-scope:
    name: Mutation Scope
    runs-on: ubuntu-latest
    steps:
      - name: Compute changed src files
        env:
          BASE_REF: \${{ github.base_ref }}
        run: |
          git fetch origin "$BASE_REF" --depth=50
          NEXT_PUBLIC_SUPABASE_URL: not-an-env-line
`;

describe("detectGateEnv — goodbyespy golden case", () => {
  const r = detectGateEnv(fakeSource({ "quality-gate.yml": GOODBYESPY }));

  it("captures exactly the three build placeholders", () => {
    expect(r.gateEnv).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      NEXT_PUBLIC_SUPABASE_KEY: "ci-placeholder",
      NEXT_SECRET_SUPABASE_KEY: "ci-placeholder",
    });
  });

  it("attributes provenance to the build step", () => {
    const url = r.detected.find((d) => d.key === "NEXT_PUBLIC_SUPABASE_URL")!;
    expect(url.job).toBe("quality");
    expect(url.step).toBe("pnpm build");
    expect(url.scope).toBe("step");
  });

  it("routes the `${{ }}` ref to skippedExpressionRefs, never to gateEnv", () => {
    expect(r.skippedExpressionRefs.map((s) => s.key)).toContain("BASE_REF");
    expect(r.gateEnv).not.toHaveProperty("BASE_REF");
  });

  it("does NOT harvest a `KEY: value` line inside a `run: |` block scalar", () => {
    // The mutation-scope run body contains a literal `NEXT_PUBLIC_SUPABASE_URL:` line;
    // it must come ONLY from the build step's env, not the block scalar.
    expect(r.detected.filter((d) => d.key === "NEXT_PUBLIC_SUPABASE_URL")).toHaveLength(1);
  });
});

describe("detectGateEnv — policy filters", () => {
  it("never emits a `${{ secrets.* }}` value (the non-negotiable)", () => {
    const r = detectGateEnv(
      fakeSource({
        "w.yml": `jobs:
  j:
    steps:
      - run: deploy
        env:
          API_TOKEN: \${{ secrets.API_TOKEN }}
`,
      }),
    );
    expect(r.gateEnv).toEqual({});
    expect(r.skippedExpressionRefs.map((s) => s.key)).toEqual(["API_TOKEN"]);
  });

  it("drops a secret-shaped literal value (defense-in-depth)", () => {
    const r = detectGateEnv(
      fakeSource({
        "w.yml": `jobs:
  j:
    steps:
      - run: x
        env:
          GH_PAT: ghp_0123456789abcdefghijklmnopqrstuvwxyz
          SAFE: placeholder
`,
      }),
    );
    expect(r.gateEnv).toEqual({ SAFE: "placeholder" });
    expect(r.droppedSecrets.map((s) => s.key)).toEqual(["GH_PAT"]);
  });
});

describe("detectGateEnv — scalar parsing", () => {
  it("captures a URL value with colons whole", () => {
    const r = detectGateEnv(
      fakeSource({
        "w.yml": `jobs:
  j:
    steps:
      - run: x
        env:
          URL: http://localhost:54321/v1
`,
      }),
    );
    expect(r.gateEnv.URL).toBe("http://localhost:54321/v1");
  });

  it("unwraps double- and single-quoted values, including '' escape", () => {
    const r = detectGateEnv(
      fakeSource({
        "w.yml": `jobs:
  j:
    steps:
      - run: x
        env:
          DQ: "hello world"
          SQ: 'it''s fine'
          HASH: "a # b"
`,
      }),
    );
    expect(r.gateEnv).toEqual({ DQ: "hello world", SQ: "it's fine", HASH: "a # b" });
  });

  it("strips a trailing ` #` comment on an unquoted value", () => {
    const r = detectGateEnv(
      fakeSource({
        "w.yml": `jobs:
  j:
    steps:
      - run: x
        env:
          PORT: 54321 # the ci port
`,
      }),
    );
    expect(r.gateEnv.PORT).toBe("54321");
  });
});

describe("detectGateEnv — precedence + multi-file", () => {
  it("step env wins over job env on a key collision (both in `detected`)", () => {
    const r = detectGateEnv(
      fakeSource({
        "w.yml": `jobs:
  j:
    env:
      X: job-level
    steps:
      - run: x
        env:
          X: step-level
`,
      }),
    );
    expect(r.gateEnv.X).toBe("step-level");
    expect(r.detected.map((d) => d.value).sort()).toEqual(["job-level", "step-level"]);
  });

  it("two workflows colliding → deterministic last-sorted-file wins", () => {
    const r = detectGateEnv(
      fakeSource({
        "a.yml": `jobs:
  j:
    steps:
      - run: x
        env:
          X: from-a
`,
        "b.yml": `jobs:
  j:
    steps:
      - run: x
        env:
          X: from-b
`,
      }),
    );
    expect(r.gateEnv.X).toBe("from-b"); // b sorts after a
  });
});

describe("detectGateEnv — malformed isolation", () => {
  it("skips a tab-indented file with a warning, keeps the good file's vars", () => {
    const r = detectGateEnv(
      fakeSource({
        "bad.yml": "jobs:\n\tj:\n\t\tsteps:\n", // tab indentation
        "good.yml": `jobs:
  j:
    steps:
      - run: x
        env:
          OK: yes-value
`,
      }),
    );
    expect(r.gateEnv).toEqual({ OK: "yes-value" });
    expect(r.warnings.map((w) => w.workflow)).toEqual(["bad.yml"]);
  });

  it("returns empty everything for no workflows", () => {
    const r = detectGateEnv(fakeSource({}));
    expect(r.gateEnv).toEqual({});
    expect(r.detected).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("mergeDetectedGateEnv — gap-fill classification", () => {
  it("writes absent keys, skips equal keys, reports differing keys as conflicts", () => {
    const raw = {};
    const current = { KEPT: "ci", SAME: "v" };
    const detected = { NEW: "n", SAME: "v", KEPT: "DIFFERENT" };
    const m = mergeDetectedGateEnv(raw, current, detected, { NEW: "w.yml", KEPT: "w.yml" });

    expect(m.written).toEqual(["NEW"]);
    expect(m.skipped).toEqual(["SAME"]);
    expect(m.conflicts).toEqual([
      { key: "KEPT", configured: "ci", detected: "DIFFERENT", source: "w.yml" },
    ]);
    // Only the written leaf is staged into the overlay — operator value untouched.
    expect(m.raw).toEqual({ quality: { gateEnv: { NEW: "n" } } });
  });

  it("is a no-op merge (no written) when every detected key already matches", () => {
    const m = mergeDetectedGateEnv({}, { A: "1" }, { A: "1" }, {});
    expect(m.written).toEqual([]);
    expect(m.raw).toEqual({});
  });
});

describe("applyGateEnvDetection — detect → persist → report", () => {
  let dataDir: string;
  let repoRoot: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-ci-data-"));
    repoRoot = await mkdtemp(join(tmpdir(), "factory-ci-repo-"));
    prevEnv = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevEnv;
    await rm(dataDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  const writeWorkflow = async (text: string) => {
    const dir = join(repoRoot, ".github", "workflows");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "quality-gate.yml"), text, "utf8");
  };

  it("detects into an empty config → sparse overlay, populated gateEnv", async () => {
    await writeWorkflow(GOODBYESPY);
    const report = await applyGateEnvDetection(repoRoot);

    expect(report.written.sort()).toEqual([
      "NEXT_PUBLIC_SUPABASE_KEY",
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_SECRET_SUPABASE_KEY",
    ]);
    expect(report.gateEnv.NEXT_PUBLIC_SUPABASE_URL).toBe("http://localhost:54321");

    const overlay = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
    expect(overlay).toEqual({
      quality: {
        gateEnv: {
          NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
          NEXT_PUBLIC_SUPABASE_KEY: "ci-placeholder",
          NEXT_SECRET_SUPABASE_KEY: "ci-placeholder",
        },
      },
    });
  });

  it("preserves an operator-set key as a conflict, never overwrites it", async () => {
    await writeFile(
      join(dataDir, "config.json"),
      JSON.stringify({
        quality: { gateEnv: { NEXT_PUBLIC_SUPABASE_URL: "https://operator.example" } },
      }),
      "utf8",
    );
    await writeWorkflow(GOODBYESPY);
    const report = await applyGateEnvDetection(repoRoot);

    expect(report.conflicts.map((c) => c.key)).toEqual(["NEXT_PUBLIC_SUPABASE_URL"]);
    expect(report.gateEnv.NEXT_PUBLIC_SUPABASE_URL).toBe("https://operator.example");
    expect(report.written.sort()).toEqual(["NEXT_PUBLIC_SUPABASE_KEY", "NEXT_SECRET_SUPABASE_KEY"]);
  });

  it("is idempotent: a second run writes nothing and leaves the overlay byte-identical", async () => {
    await writeWorkflow(GOODBYESPY);
    await applyGateEnvDetection(repoRoot);
    const first = await readFile(join(dataDir, "config.json"), "utf8");

    const second = await applyGateEnvDetection(repoRoot);
    expect(second.written).toEqual([]);
    expect(second.skipped.length).toBe(3);
    expect(await readFile(join(dataDir, "config.json"), "utf8")).toBe(first);
  });

  it("writes no config when there are no workflows", async () => {
    const report = await applyGateEnvDetection(repoRoot);
    expect(report.written).toEqual([]);
    expect(report.gateEnv).toEqual({});
    expect(existsSync(join(dataDir, "config.json"))).toBe(false);
  });
});
