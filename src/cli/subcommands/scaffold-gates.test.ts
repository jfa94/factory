/**
 * Unit tests for scaffold-time gate-contract resolution (S7, Decision 46):
 * stack detection (deno-first), the deno build-task probe (incl. jsonc
 * comment-stripping), and the floor/waiver refusals — against temp dirs, no
 * gh/git fakes needed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStack, resolveGateContract } from "./scaffold-gates.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "factory-gates-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("detectStack", () => {
  it("empty dir → custom", () => {
    expect(detectStack(root)).toBe("custom");
  });

  it("package.json → npm", async () => {
    await writeFile(join(root, "package.json"), "{}", "utf8");
    expect(detectStack(root)).toBe("npm");
  });

  it("deno.json wins over a coexisting package.json (deno-first)", async () => {
    await writeFile(join(root, "package.json"), "{}", "utf8");
    await writeFile(join(root, "deno.json"), "{}", "utf8");
    expect(detectStack(root)).toBe("deno");
  });

  it("deno.jsonc alone → deno", async () => {
    await writeFile(join(root, "deno.jsonc"), "{}", "utf8");
    expect(detectStack(root)).toBe("deno");
  });
});

describe("resolveGateContract — deno build-task probe", () => {
  it("a build task contracts `deno task build`", async () => {
    await writeFile(
      join(root, "deno.json"),
      JSON.stringify({ tasks: { build: "deno run -A build.ts" } }),
      "utf8",
    );
    const c = await resolveGateContract({ targetRoot: root, waiveMutation: false });
    expect(c.gates.build).toEqual({ contracted: true, command: "deno task build" });
  });

  it("no build task → waived-by-stack (deno check covers compilation)", async () => {
    await writeFile(join(root, "deno.json"), JSON.stringify({ tasks: { dev: "x" } }), "utf8");
    const c = await resolveGateContract({ targetRoot: root, waiveMutation: false });
    expect(c.gates.build.contracted).toBe(false);
    if (!c.gates.build.contracted) {
      expect(c.gates.build.reason).toMatch(/waived-by-stack.*deno check/);
    }
  });

  it("deno.jsonc: comments are stripped for the probe, https:// values survive", async () => {
    await writeFile(
      join(root, "deno.jsonc"),
      `{
  // the build entrypoint
  /* block comment */
  "tasks": { "build": "deno run -A build.ts" },
  "imports": { "std/": "https://deno.land/std/" }
}`,
      "utf8",
    );
    const c = await resolveGateContract({ targetRoot: root, waiveMutation: false });
    expect(c.gates.build).toEqual({ contracted: true, command: "deno task build" });
  });

  it("an unparseable deno.json fails LOUD (never silently waives build)", async () => {
    await writeFile(join(root, "deno.json"), "{ tasks: ", "utf8");
    await expect(resolveGateContract({ targetRoot: root, waiveMutation: false })).rejects.toThrow(
      /not parseable/,
    );
  });
});

describe("resolveGateContract — refusals", () => {
  it("custom stack refuses naming the npm/deno remedies", async () => {
    await expect(resolveGateContract({ targetRoot: root, waiveMutation: false })).rejects.toThrow(
      /custom.*package\.json.*deno\.json/s,
    );
  });

  it("npm with a broken package.json fails loud", async () => {
    await writeFile(join(root, "package.json"), "{ nope", "utf8");
    await expect(resolveGateContract({ targetRoot: root, waiveMutation: false })).rejects.toThrow(
      /package\.json is not valid JSON/,
    );
  });
});
