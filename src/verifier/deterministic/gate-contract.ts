/**
 * S7 (Decision 46) — the GATE CONTRACT: scaffold-time gate applicability,
 * committed into the target repo at `.factory/gates.json` (TCB-write-denied so
 * producers cannot weaken their own gates).
 *
 * The contract kills silent gate-skipping. Every gate id must appear with an
 * EXPLICIT decision: `{contracted: true}` (optionally with a stack-specific
 * `command` override — `deno test`, `deno check .`, …) or
 * `{contracted: false, reason}`. At gate time (gate-runner.ts):
 *   - an UNCONTRACTED gate skips cleanly (its reason is the audit trail);
 *   - a CONTRACTED gate whose strategy reports a TOOLING skip (missing binary /
 *     config / data) is converted to a LOUD FAIL ("contracted-but-unrunnable");
 *   - SCOPE skips (nothing in the diff for this gate to act on) stay excluded —
 *     they are properties of the task, not broken tooling.
 *
 * `command` is allowed ONLY on the gates that execute it (test/type/build/lint)
 * — a command on any other gate is rejected at parse so the key can never be
 * declared-but-not-wired (the `redTestCommand` cautionary tale this contract
 * replaces).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  runnerName,
  validateCommand,
  type CommandValidation,
} from "../../shared/command-allowlist.js";
import { GATE_IDS, type GateId } from "./gate-id.js";

/** Where the contract lives, relative to the target repo root / worktree. */
export const GATE_CONTRACT_REL = ".factory/gates.json";

/** The stacks the scaffold resolution table knows how to contract. */
export const GATE_CONTRACT_STACKS = ["npm", "deno", "custom"] as const;
export type GateContractStack = (typeof GATE_CONTRACT_STACKS)[number];

/** Gates whose strategies EXECUTE a contracted `command` override. */
export const COMMAND_GATES: readonly GateId[] = ["test", "type", "build", "lint"] as const;

/**
 * The RUNNER policy for contracted gate commands (charset validation is the
 * shared allowlist's job). Deliberately modest: the stack runners the scaffold
 * resolution table emits + the bare well-known dev tools.
 */
export function isAllowedGateRunner(argv: readonly string[]): boolean {
  const runner = runnerName(argv);
  const a1 = argv[1];
  switch (runner) {
    case "deno":
      return a1 === "test" || a1 === "check" || a1 === "task" || a1 === "lint" || a1 === "fmt";
    case "go":
      return a1 === "test";
    case "cargo":
      return a1 === "test" || a1 === "check" || a1 === "build";
    case "npm":
    case "pnpm":
    case "yarn":
      return a1 === "run" && argv[2] !== undefined;
    case "vitest":
    case "tsc":
    case "eslint":
    case "jest":
    case "mocha":
    case "pytest":
      return true;
    default:
      return false;
  }
}

/** Validate one contracted gate command (shared charset + the gate runner policy). */
export function validateGateCommand(command: string): CommandValidation {
  return validateCommand(command, isAllowedGateRunner);
}

const ContractedSchema = z
  .object({
    contracted: z.literal(true),
    /** Stack-specific command override; validated + only on {@link COMMAND_GATES}. */
    command: z.string().optional(),
  })
  .strict();

const UncontractedSchema = z
  .object({
    contracted: z.literal(false),
    /** Why this gate is waived — required; the committed audit trail. */
    reason: z.string().min(1, "uncontracted gate requires a non-empty reason"),
  })
  .strict();

const EntrySchema = z.discriminatedUnion("contracted", [ContractedSchema, UncontractedSchema]);

/** One gate's contract entry. */
export type GateContractEntry = z.infer<typeof EntrySchema>;

/**
 * The `.factory/gates.json` schema. ALL gate ids are REQUIRED keys — omitting a
 * gate is exactly the silent skip this contract exists to kill.
 */
export const GateContractSchema = z
  .object({
    version: z.literal(1),
    stack: z.enum(GATE_CONTRACT_STACKS),
    gates: z
      .object(
        Object.fromEntries(GATE_IDS.map((id) => [id, EntrySchema])) as Record<
          GateId,
          typeof EntrySchema
        >,
      )
      .strict(),
  })
  .strict()
  .superRefine((contract, issues) => {
    for (const id of GATE_IDS) {
      const entry = contract.gates[id];
      if (!entry.contracted || entry.command === undefined) continue;
      if (!COMMAND_GATES.includes(id)) {
        issues.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["gates", id, "command"],
          message: `gate '${id}' does not execute a command override (allowed on: ${COMMAND_GATES.join(", ")})`,
        });
        continue;
      }
      const v = validateGateCommand(entry.command);
      if (!v.ok) {
        issues.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["gates", id, "command"],
          message: `${v.reason}: ${v.detail}`,
        });
      }
    }
  });

export type GateContract = z.infer<typeof GateContractSchema>;

/**
 * The result of loading a contract from a repo root / worktree. `absent` is the
 * legacy pre-contract state (runner warns + keeps today's skip semantics);
 * `invalid` is structural — a committed-but-broken contract must fail LOUD,
 * never degrade to legacy.
 */
export type GateContractLoad =
  | { readonly state: "ok"; readonly contract: GateContract }
  | { readonly state: "absent" }
  | { readonly state: "invalid"; readonly error: string };

/** Load + validate `<root>/.factory/gates.json`. Never throws. */
export async function loadGateContract(rootAbs: string): Promise<GateContractLoad> {
  let raw: string;
  try {
    raw = await readFile(join(rootAbs, GATE_CONTRACT_REL), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "invalid", error: `unreadable: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { state: "invalid", error: `not JSON: ${(err as Error).message}` };
  }
  const result = GateContractSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { state: "invalid", error: issues };
  }
  return { state: "ok", contract: result.data };
}

/**
 * The skip-taxonomy split (Decision 46). SCOPE skips are properties of the TASK
 * (nothing in the diff for the gate to act on) — legitimate, excluded from the
 * conjunction even under a contract. TOOLING skips mean the gate COULD NOT RUN
 * (missing binary/config/data) — on a contracted gate that is a loud fail.
 * Unknown reasons classify as tooling (fail-closed): a new skip reason must be
 * added here deliberately to earn scope-exclusion.
 */
const SCOPE_SKIP_REASONS: ReadonlySet<string> = new Set([
  "no-vitest-runnable-tests-in-scope",
  "no-mutable-changes",
]);

export type SkipClass = "scope" | "tooling";

export function classifySkip(reason: string): SkipClass {
  return SCOPE_SKIP_REASONS.has(reason) ? "scope" : "tooling";
}
