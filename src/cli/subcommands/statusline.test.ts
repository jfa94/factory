/**
 * Tests for `factory statusline` — the usage-cache.json WRITER (Prompt D).
 *
 * It ports the old `statusline-wrapper.sh`: read the CC statusline JSON payload
 * from stdin, persist `.rate_limits + {captured_at}` to `usage-cache.json`, and
 * pass the SAME payload through to `$FACTORY_ORIGINAL_STATUSLINE` (forwarding its
 * stdout). The end-to-end invariant: a cache it writes from a real payload must
 * read back through {@link StatuslineUsageSignal} as `{ kind: "available" }`.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStatusline } from "./statusline.js";
import { usageCachePath, StatuslineUsageSignal } from "../../quota/usage-source.js";
import { EXIT } from "../exit-codes.js";

/** A representative Claude Code statusline payload with rate_limits. */
function ccPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: { display_name: "Claude Opus 4.8" },
    workspace: { current_dir: "/Users/x/project" },
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: 9_000_000_000 },
      seven_day: { used_percentage: 13, resets_at: 9_000_000_000 },
    },
    ...overrides,
  });
}

/** An async-iterable single-chunk stdin stand-in. */
function stdinOf(text: string): AsyncIterable<string> {
  return (async function* () {
    if (text.length > 0) yield text;
  })();
}

describe("runStatusline (cache writer)", () => {
  let dataDir: string;
  const FIXED_NOW = 8_999_999_000; // < both resets_at, recent vs captured_at

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "factory-statusline-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.FACTORY_ORIGINAL_STATUSLINE;
  });

  it("writes a usage-cache.json the reader returns as available", async () => {
    const code = await runStatusline([], {
      dataDirOptions: { dataDir },
      now: () => FIXED_NOW,
      readStdin: () => Promise.resolve(ccPayload()),
    });
    expect(code).toBe(EXIT.OK);

    const file = usageCachePath(dataDir);
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.five_hour.used_percentage).toBe(42);
    expect(written.seven_day.resets_at).toBe(9_000_000_000);
    expect(written.captured_at).toBe(FIXED_NOW);

    // End-to-end: the reader must accept what the writer produced.
    const reading = await new StatuslineUsageSignal({ dataDir, now: () => FIXED_NOW }).read();
    expect(reading.kind).toBe("available");
    if (reading.kind === "available") {
      expect(reading.fiveHour.utilizationPct).toBe(42);
      expect(reading.sevenDay.resetsAtEpoch).toBe(9_000_000_000);
      expect(reading.capturedAt).toBe(FIXED_NOW);
    }
  });

  it("is a clean no-op (no throw, no cache) when payload lacks rate_limits", async () => {
    const code = await runStatusline([], {
      dataDirOptions: { dataDir },
      now: () => FIXED_NOW,
      readStdin: () => Promise.resolve(JSON.stringify({ model: { display_name: "Claude" } })),
    });
    expect(code).toBe(EXIT.OK);
    expect(existsSync(usageCachePath(dataDir))).toBe(false);
  });

  it("is a clean no-op for empty stdin", async () => {
    const code = await runStatusline([], {
      dataDirOptions: { dataDir },
      now: () => FIXED_NOW,
      readStdin: () => Promise.resolve(""),
    });
    expect(code).toBe(EXIT.OK);
    expect(existsSync(usageCachePath(dataDir))).toBe(false);
  });

  it("is a clean no-op for non-JSON stdin", async () => {
    const code = await runStatusline([], {
      dataDirOptions: { dataDir },
      now: () => FIXED_NOW,
      readStdin: () => Promise.resolve("not json at all {{{"),
    });
    expect(code).toBe(EXIT.OK);
    expect(existsSync(usageCachePath(dataDir))).toBe(false);
  });

  it("is a clean no-op when the data dir is unresolvable", async () => {
    // No dataDir override + empty env → resolveDataDir throws → no write, no throw.
    const code = await runStatusline([], {
      dataDirOptions: { env: {} },
      now: () => FIXED_NOW,
      readStdin: () => Promise.resolve(ccPayload()),
    });
    expect(code).toBe(EXIT.OK);
  });

  it("reads from the real stdin stream when no override is given", async () => {
    const code = await runStatusline([], {
      dataDirOptions: { dataDir },
      now: () => FIXED_NOW,
      stdin: stdinOf(ccPayload()),
    });
    expect(code).toBe(EXIT.OK);
    expect(existsSync(usageCachePath(dataDir))).toBe(true);
  });
});

describe("runStatusline (passthrough)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "factory-statusline-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.FACTORY_ORIGINAL_STATUSLINE;
  });

  it("forwards the original statusline's stdout when FACTORY_ORIGINAL_STATUSLINE is set", async () => {
    process.env.FACTORY_ORIGINAL_STATUSLINE = "cat";
    let displayed = "";
    const payload = ccPayload();
    const code = await runStatusline([], {
      dataDirOptions: { dataDir },
      now: () => 8_999_999_000,
      readStdin: () => Promise.resolve(payload),
      writeStdout: (s) => {
        displayed += s;
      },
    });
    expect(code).toBe(EXIT.OK);
    // `cat` echoes its stdin back: the displayed statusline is the raw payload.
    expect(displayed).toBe(payload);
    // ... and the cache is still written alongside passthrough.
    expect(existsSync(usageCachePath(dataDir))).toBe(true);
  });

  it("emits empty stdout (no passthrough) when FACTORY_ORIGINAL_STATUSLINE is unset", async () => {
    let displayed = "sentinel";
    const code = await runStatusline([], {
      dataDirOptions: { dataDir },
      now: () => 8_999_999_000,
      readStdin: () => Promise.resolve(ccPayload()),
      writeStdout: (s) => {
        displayed = s;
      },
    });
    expect(code).toBe(EXIT.OK);
    expect(displayed).toBe("");
  });

  it("leaves the display empty (EXIT.OK) when the original command exits non-zero", async () => {
    // Exercises the `result.code !== 0` fail-soft branch (distinct from a spawn
    // failure): the chained command runs but fails — display degrades to empty.
    let displayed = "sentinel";
    const code = await runStatusline([], {
      dataDirOptions: { dataDir },
      now: () => 8_999_999_000,
      readStdin: () => Promise.resolve(ccPayload()),
      originalStatusline: "exit 3",
      writeStdout: (s) => {
        displayed = s;
      },
    });
    expect(code).toBe(EXIT.OK);
    expect(displayed).toBe("");
    // The cache is still written even though the passthrough failed.
    expect(existsSync(usageCachePath(dataDir))).toBe(true);
  });

  it("does not crash the statusline when the original command does not exist", async () => {
    process.env.FACTORY_ORIGINAL_STATUSLINE = "definitely-not-a-real-command-xyz";
    const code = await runStatusline([], {
      dataDirOptions: { dataDir },
      now: () => 8_999_999_000,
      readStdin: () => Promise.resolve(ccPayload()),
      writeStdout: () => {},
    });
    expect(code).toBe(EXIT.OK);
  });

  it("a timeout-killed original (code:null) degrades to an empty display, with a 3s timeout passed", async () => {
    // The hung-command guard (D2): a signal-killed result (`code: null`, as the 3s
    // timeout produces) takes the fail-soft branch. Inject an exec double so the
    // assertion is deterministic (no real sleep) and verify the timeout was set.
    let displayed = "sentinel";
    let seenTimeout: number | undefined;
    const code = await runStatusline([], {
      dataDirOptions: { dataDir },
      now: () => 8_999_999_000,
      readStdin: () => Promise.resolve(ccPayload()),
      originalStatusline: "sleep 9999",
      exec: (_cmd, _args, opts) => {
        seenTimeout = opts?.timeoutMs;
        return Promise.resolve({
          stdout: "",
          stderr: "",
          code: null, // killed by signal — what the timeout produces
          signal: "SIGTERM",
          truncated: false,
        });
      },
      writeStdout: (s) => {
        displayed = s;
      },
    });
    expect(code).toBe(EXIT.OK);
    expect(displayed).toBe("");
    expect(seenTimeout).toBe(3000);
    // The cache write is independent of the passthrough outcome.
    expect(existsSync(usageCachePath(dataDir))).toBe(true);
  });
});
