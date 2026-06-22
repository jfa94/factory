/**
 * WS9 — hook I/O tests: stdin parse, deny/allow shapes, fail-closed, exit-code map.
 */
import { describe, it, expect } from "vitest";
import { EXIT } from "../shared/exit-codes.js";
import {
  allow,
  deny,
  isDeny,
  parseHookInput,
  HookInputError,
  emitPermissionDecision,
  emitBlockDecision,
  decisionToExitCode,
  filePathsOf,
  commandOf,
  toolNameOf,
  readHookInput,
} from "./hook-io.js";

describe("hook-io — parse", () => {
  it("empty/whitespace input → null (pass-through choice)", () => {
    expect(parseHookInput("")).toBeNull();
    expect(parseHookInput("   \n ")).toBeNull();
  });

  it("fail-closed: malformed JSON throws HookInputError (never a silent allow)", () => {
    expect(() => parseHookInput("{not json")).toThrow(HookInputError);
  });

  it("fail-closed: a JSON array/scalar is rejected (must be an object)", () => {
    expect(() => parseHookInput("[1,2]")).toThrow(HookInputError);
    expect(() => parseHookInput("42")).toThrow(HookInputError);
  });

  it("valid object parses", () => {
    const input = parseHookInput('{"tool_name":"Bash","tool_input":{"command":"ls"}}');
    expect(toolNameOf(input)).toBe("Bash");
    expect(commandOf(input)).toBe("ls");
  });

  it("readHookInput reads an injected stream", async () => {
    async function* gen() {
      yield '{"tool_name":';
      yield '"Write"}';
    }
    const input = await readHookInput(gen());
    expect(toolNameOf(input)).toBe("Write");
  });
});

describe("hook-io — file path extraction", () => {
  it("collects Edit/Write file_path and MultiEdit edits[].file_path, de-duped", () => {
    const input = parseHookInput(
      JSON.stringify({
        tool_name: "MultiEdit",
        tool_input: {
          file_path: "a.ts",
          edits: [{ file_path: "b.ts" }, { file_path: "a.ts" }, {}],
        },
      }),
    );
    expect(filePathsOf(input).sort()).toEqual(["a.ts", "b.ts"]);
  });
});

describe("hook-io — decisions", () => {
  it("allow/deny constructors + isDeny guard", () => {
    expect(isDeny(allow())).toBe(false);
    const d = deny("r", "detail");
    expect(isDeny(d)).toBe(true);
  });

  it("emitPermissionDecision writes the permissionDecision:deny shape on deny only", () => {
    let out = "";
    const payload = emitPermissionDecision(deny("blocked_x", "why"), (s) => (out += s));
    expect(payload).not.toBe("");
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe("blocked_x: why");
    // allow → no output
    let none = "";
    emitPermissionDecision(allow(), (s) => (none += s));
    expect(none).toBe("");
  });

  it("emitBlockDecision writes the legacy {decision:block} shape", () => {
    let out = "";
    emitBlockDecision(deny("r", "d"), (s) => (out += s));
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ decision: "block", reason: "r", detail: "d" });
  });

  it("decisionToExitCode: deny → ERROR(1), allow → OK(0)", () => {
    expect(decisionToExitCode(deny("x"))).toBe(EXIT.ERROR);
    expect(decisionToExitCode(allow())).toBe(EXIT.OK);
  });
});
