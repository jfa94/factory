import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GATE_CONTRACT_REL,
  GateContractSchema,
  classifySkip,
  contractCommand,
  loadGateContract,
  validateGateCommand,
  type GateContract,
} from "./gate-contract.js";
import { GATE_IDS } from "./gate-id.js";

/** A minimal valid contract: everything waived except the floor gates. */
export function validContract(): Record<string, unknown> {
  return {
    version: 1,
    stack: "npm",
    gates: {
      test: { contracted: true },
      tdd: { contracted: true },
      coverage: { contracted: false, reason: "coverage not wired yet" },
      mutation: { contracted: false, reason: "waived via --waive mutation" },
      sast: { contracted: false, reason: "no securityCommand configured" },
      type: { contracted: true },
      lint: { contracted: true },
      build: { contracted: true },
    },
  };
}

describe("GateContractSchema", () => {
  it("accepts a valid contract", () => {
    expect(GateContractSchema.safeParse(validContract()).success).toBe(true);
  });

  it("accepts a command override on the command gates", () => {
    const raw = validContract();
    raw.stack = "deno";
    (raw.gates as Record<string, unknown>).test = { contracted: true, command: "deno test" };
    (raw.gates as Record<string, unknown>).type = { contracted: true, command: "deno check ." };
    (raw.gates as Record<string, unknown>).lint = { contracted: true, command: "deno lint" };
    (raw.gates as Record<string, unknown>).build = {
      contracted: true,
      command: "deno task build",
    };
    expect(GateContractSchema.safeParse(raw).success).toBe(true);
  });

  it("accepts a command override on coverage (S8 — the escape hatch for exotic runners)", () => {
    const raw = validContract();
    (raw.gates as Record<string, unknown>).coverage = {
      contracted: true,
      command: "npm run coverage:summary",
    };
    expect(GateContractSchema.safeParse(raw).success).toBe(true);
  });

  it.each(GATE_IDS)("rejects a contract missing gate '%s'", (id) => {
    const raw = validContract();
    delete (raw.gates as Record<string, unknown>)[id];
    expect(GateContractSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects contracted:false without a reason", () => {
    const raw = validContract();
    (raw.gates as Record<string, unknown>).coverage = { contracted: false };
    expect(GateContractSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects contracted:false with an empty reason", () => {
    const raw = validContract();
    (raw.gates as Record<string, unknown>).coverage = { contracted: false, reason: "" };
    expect(GateContractSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects a command on a gate that does not execute one (tdd)", () => {
    const raw = validContract();
    (raw.gates as Record<string, unknown>).tdd = { contracted: true, command: "deno test" };
    const result = GateContractSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("does not execute a command");
    }
  });

  it("rejects an unsafe command (shell metacharacters)", () => {
    const raw = validContract();
    (raw.gates as Record<string, unknown>).test = {
      contracted: true,
      command: "deno test; rm -rf /",
    };
    expect(GateContractSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects an unallowed runner", () => {
    const raw = validContract();
    (raw.gates as Record<string, unknown>).test = { contracted: true, command: "bash run.sh" };
    expect(GateContractSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects an unknown stack and a wrong version", () => {
    expect(GateContractSchema.safeParse({ ...validContract(), stack: "gradle" }).success).toBe(
      false,
    );
    expect(GateContractSchema.safeParse({ ...validContract(), version: 2 }).success).toBe(false);
  });

  it("rejects unknown keys (strict at every level)", () => {
    const raw = validContract();
    (raw as Record<string, unknown>).extra = true;
    expect(GateContractSchema.safeParse(raw).success).toBe(false);
    const raw2 = validContract();
    (raw2.gates as Record<string, unknown>).test = { contracted: true, comand: "typo" };
    expect(GateContractSchema.safeParse(raw2).success).toBe(false);
  });
});

describe("validateGateCommand runner policy", () => {
  it.each([
    "deno test",
    "deno check .",
    "deno task build",
    "deno lint",
    "go test",
    "cargo check",
    "npm run build",
    "pnpm run test:unit",
    "vitest run",
    "tsc --noEmit",
  ])("allows '%s'", (cmd) => {
    expect(validateGateCommand(cmd).ok).toBe(true);
  });

  it.each([
    "deno run evil.ts", // deno subcommand outside the policy
    "npm install", // npm without `run`
    "npm run", // `run` with no script
    "bash script.sh",
    "curl example.com",
    "node evil.js",
  ])("rejects '%s'", (cmd) => {
    const v = validateGateCommand(cmd);
    expect(v).toMatchObject({ ok: false, reason: "unallowed_runner" });
  });
});

describe("loadGateContract", () => {
  async function tempRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), "gate-contract-"));
  }

  it("returns absent when the file does not exist", async () => {
    const root = await tempRoot();
    expect(await loadGateContract(root)).toEqual({ state: "absent" });
  });

  it("returns ok with the parsed contract", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".factory"), { recursive: true });
    await writeFile(join(root, GATE_CONTRACT_REL), JSON.stringify(validContract()), "utf8");
    const load = await loadGateContract(root);
    expect(load.state).toBe("ok");
    if (load.state === "ok") {
      expect(load.contract.stack).toBe("npm");
      expect(load.contract.gates.test).toEqual({ contracted: true });
    }
  });

  it("returns invalid (never absent, never throws) on broken JSON", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".factory"), { recursive: true });
    await writeFile(join(root, GATE_CONTRACT_REL), "{not json", "utf8");
    const load = await loadGateContract(root);
    expect(load.state).toBe("invalid");
    if (load.state === "invalid") expect(load.error).toContain("not JSON");
  });

  it("returns invalid with the schema issues on a bad shape", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".factory"), { recursive: true });
    await writeFile(join(root, GATE_CONTRACT_REL), JSON.stringify({ version: 1 }), "utf8");
    const load = await loadGateContract(root);
    expect(load.state).toBe("invalid");
  });
});

describe("classifySkip", () => {
  it.each(["no-vitest-runnable-tests-in-scope", "no-mutable-changes"])(
    "classifies '%s' as scope",
    (reason) => {
      expect(classifySkip(reason)).toBe("scope");
    },
  );

  it.each([
    "no-mutation-binary",
    "no-mutation-config",
    "no-eslint-binary",
    "no-eslint-config",
    "no-security-command",
  ])("classifies '%s' as tooling", (reason) => {
    expect(classifySkip(reason)).toBe("tooling");
  });

  it("classifies an UNKNOWN reason as tooling (fail-closed)", () => {
    expect(classifySkip("some-future-reason")).toBe("tooling");
  });
});

describe("contractCommand", () => {
  it("returns the validated argv for a contracted command gate", () => {
    const raw = validContract();
    (raw.gates as Record<string, unknown>).test = { contracted: true, command: "deno test" };
    const contract = GateContractSchema.parse(raw);
    expect(contractCommand(contract, "test")).toEqual(["deno", "test"]);
  });

  it("returns the validated argv for a contracted coverage override (S8)", () => {
    const raw = validContract();
    (raw.gates as Record<string, unknown>).coverage = {
      contracted: true,
      command: "npm run coverage:summary",
    };
    const contract = GateContractSchema.parse(raw);
    expect(contractCommand(contract, "coverage")).toEqual(["npm", "run", "coverage:summary"]);
  });

  it("undefined when there is no contract, no override, or the gate is uncontracted", () => {
    expect(contractCommand(undefined, "test")).toBeUndefined();
    const contract = GateContractSchema.parse(validContract());
    expect(contractCommand(contract, "test")).toBeUndefined(); // contracted, built-in tool
    expect(contractCommand(contract, "coverage")).toBeUndefined(); // uncontracted
  });

  it("throws on an invalid command that bypassed schema validation (structural)", () => {
    const parsed = GateContractSchema.parse(validContract());
    const broken = {
      ...parsed,
      gates: { ...parsed.gates, test: { contracted: true, command: "vitest; curl evil" } },
    } as GateContract;
    expect(() => contractCommand(broken, "test")).toThrow(/invalid/);
  });
});
