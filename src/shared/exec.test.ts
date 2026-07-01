import { describe, it, expect } from "vitest";
import { exec, execOrThrow, ExecError } from "./exec.js";

// Uses `node` itself as the subject — a guaranteed-present binary, so no
// external CLI dependency in the test.
const NODE = process.execPath;

describe("exec", () => {
  it("captures stdout and a zero exit code", async () => {
    const r = await exec(NODE, ["-e", "process.stdout.write('hello')"]);
    expect(r.stdout).toBe("hello");
    expect(r.code).toBe(0);
    expect(r.signal).toBeNull();
  });

  it("captures stderr and a non-zero exit WITHOUT throwing", async () => {
    const r = await exec(NODE, ["-e", "process.stderr.write('boom');process.exit(3)"]);
    expect(r.stderr).toBe("boom");
    expect(r.code).toBe(3);
  });

  it("does not run through a shell by default (argv is literal)", async () => {
    // If a shell interpreted this, `;` would split it. With shell:false the
    // whole string is one literal argv element echoed verbatim.
    const r = await exec(NODE, ["-e", "process.stdout.write(process.argv[1])", "a;b c"]);
    expect(r.stdout).toBe("a;b c");
  });

  it("passes stdin via input", async () => {
    const r = await exec(
      NODE,
      ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d))"],
      { input: "piped-in" },
    );
    expect(r.stdout).toBe("piped-in");
  });

  it("rejects with ENOENT for a missing binary", async () => {
    await expect(exec("this-binary-does-not-exist-xyz", [])).rejects.toThrow();
  });

  it("merges env overrides over process.env", async () => {
    const r = await exec(NODE, ["-e", "process.stdout.write(process.env.FACTORY_TEST_VAR||'')"], {
      env: { FACTORY_TEST_VAR: "set-by-test" },
    });
    expect(r.stdout).toBe("set-by-test");
  });

  it("envMode:'replace' uses ONLY the passed env — no ambient process.env leaks through (Decision 39 W5 scrub)", async () => {
    const r = await exec(NODE, ["-e", "process.stdout.write(String(process.env.PATH))"], {
      env: { FACTORY_TEST_VAR: "set-by-test" },
      envMode: "replace",
    });
    // PATH is near-universally present in the parent's process.env; under a plain
    // merge it would leak through unasked. Replace mode must NOT admit it — the
    // child sees exactly the passed env, nothing ambient.
    expect(r.stdout).toBe("undefined");
  });

  it("envMode:'replace' still honors an explicitly-passed var", async () => {
    const r = await exec(NODE, ["-e", "process.stdout.write(process.env.FACTORY_TEST_VAR||'')"], {
      env: { FACTORY_TEST_VAR: "set-by-test" },
      envMode: "replace",
    });
    expect(r.stdout).toBe("set-by-test");
  });
});

describe("execOrThrow", () => {
  it("resolves on success", async () => {
    const r = await execOrThrow(NODE, ["-e", "process.stdout.write('ok')"]);
    expect(r.stdout).toBe("ok");
  });
  it("throws ExecError carrying the result on non-zero exit", async () => {
    try {
      await execOrThrow(NODE, ["-e", "process.exit(7)"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExecError);
      expect((e as ExecError).result.code).toBe(7);
    }
  });
});
