import { describe, it, expect } from "vitest";
import {
  redactSecrets,
  detectSecrets,
  KNOWN_PUBLIC_TOKENS,
  SECRET_CONTENT_PATTERNS,
  SECRET_REDACTION_PATTERNS,
  REDACTION_TOKEN,
} from "./secret-patterns.js";

// Vectors re-authored as TS assertions from bin/tests/secret-patterns.sh
// (reference only — NOT treated as a behavioral oracle). Real tokens are
// assembled at runtime so this source file carries no committable secret.
const AKIA = "AKIA" + "IOSFODNN7EXAMPLE"; // matches AKIA[0-9A-Z]{16}
const GHP = "ghp_" + "A".repeat(36); // matches ghp_[A-Za-z0-9]{36}

describe("redactSecrets", () => {
  it("redacts an AWS access key", () => {
    const out = redactSecrets(`leak: ${AKIA} end`);
    expect(out).toContain(REDACTION_TOKEN);
    expect(out).not.toContain(AKIA);
  });

  it("leaves benign text byte-for-byte untouched", () => {
    const benign = "const total = items.length + 1";
    expect(redactSecrets(benign)).toBe(benign);
  });

  it("preserves JSON validity when a secret sits inside a string value", () => {
    const input = JSON.stringify({ results: [{ lines: `x=${AKIA}` }] });
    const out = redactSecrets(input);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).not.toContain(AKIA);
  });

  it("redacts multiple distinct secrets on one line", () => {
    const out = redactSecrets(`a ${AKIA} b ${GHP} c`);
    expect(out).not.toContain(AKIA);
    expect(out).not.toContain(GHP);
  });

  it("empty input yields empty output", () => {
    expect(redactSecrets("")).toBe("");
  });

  it("keeps a private_key JSON object valid while redacting the PEM marker", () => {
    // The quote-anchored detector is EXCLUDED from redaction so the JSON
    // structural quotes survive; the value-only PEM sibling still redacts.
    const input = '{"private_key": "-----BEGIN PRIVATE KEY-----"}';
    const out = redactSecrets(input);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out)).toHaveProperty("private_key");
    expect(out).not.toContain("BEGIN PRIVATE KEY");
  });

  it("excludes exactly the quote-anchored pattern from the redaction set", () => {
    const quoteAnchored = SECRET_CONTENT_PATTERNS.filter((p) => p.source.includes('"'));
    expect(quoteAnchored.map((p) => p.name)).toEqual(["json-private-key"]);
    expect(SECRET_REDACTION_PATTERNS.some((p) => p.source.includes('"'))).toBe(false);
    expect(SECRET_REDACTION_PATTERNS.length).toBe(SECRET_CONTENT_PATTERNS.length - 1);
  });
});

describe("detectSecrets", () => {
  it("names matching patterns (detection includes quote-anchored)", () => {
    const names = detectSecrets(`x=${AKIA}`);
    expect(names).toContain("aws-access-key-id");
  });
  it("returns [] for benign text", () => {
    expect(detectSecrets("just some code")).toEqual([]);
  });
});

// One positive vector PER pattern (assembled at runtime so this file carries no
// committable secret). Guards against a pattern silently regressing: every entry
// in SECRET_CONTENT_PATTERNS must detect, and every non-quote-anchored one must
// redact.
const A20 = "A".repeat(20);
const SAMPLES: ReadonlyArray<readonly [name: string, sample: string]> = [
  ["aws-access-key-id", "AKIA" + "IOSFODNN7EXAMPLE"],
  ["github-pat-classic", "ghp_" + "A".repeat(36)],
  ["github-server-token", "ghs_" + "A".repeat(36)],
  ["github-oauth-token", "gho_" + "A".repeat(36)],
  ["github-refresh-token", "ghr_" + "A".repeat(36)],
  ["anthropic-api-key", "sk-ant-api03-" + A20],
  ["openai-style-key", "sk-" + A20],
  ["slack-token", "xoxb-" + "A".repeat(10)],
  ["google-api-key", "AIza" + "A".repeat(35)],
  ["stripe-live-secret", "sk_live_" + A20],
  ["stripe-live-restricted", "rk_live_" + A20],
  ["jwt", "eyJ" + "A".repeat(10) + ".eyJ" + "A".repeat(10) + "." + "A".repeat(5)],
  ["aws-secret-access-key", "aws_secret_access_key=" + "A".repeat(40)],
  ["json-private-key", '"private_key": "-----BEGIN'],
  ["pem-private-key", "-----BEGIN PRIVATE KEY-----"],
  ["github-pat-fine-grained", "github_pat_" + "A".repeat(60)],
  ["openai-project-key", "sk-proj-" + "A".repeat(40)],
  ["nvidia-api-key", "nvapi-" + "A".repeat(40)],
  ["xai-api-key", "xai-" + "A".repeat(40)],
];

describe("table-driven coverage — every pattern detects, every redactable one redacts", () => {
  it("the sample table covers exactly SECRET_CONTENT_PATTERNS (no pattern untested)", () => {
    expect(new Set(SAMPLES.map(([n]) => n))).toEqual(
      new Set(SECRET_CONTENT_PATTERNS.map((p) => p.name)),
    );
  });

  for (const [name, sample] of SAMPLES) {
    const quoteAnchored = name === "json-private-key";
    it(`detects ${name}`, () => {
      expect(detectSecrets(sample)).toContain(name);
    });
    it(`${quoteAnchored ? "does NOT redact (quote-anchored)" : "redacts"} ${name}`, () => {
      const out = redactSecrets(sample);
      if (quoteAnchored) {
        // Excluded from redaction so JSON structural quotes survive; no other
        // pattern matches this fragment, so it is byte-for-byte unchanged.
        expect(out).toBe(sample);
        expect(out).not.toContain(REDACTION_TOKEN);
      } else {
        expect(out).toContain(REDACTION_TOKEN);
        expect(out).not.toContain(sample);
      }
    });
  }
});

describe("KNOWN_PUBLIC_TOKENS — published dev keys are not flagged", () => {
  it("detectSecrets returns [] for each public token", () => {
    for (const tok of KNOWN_PUBLIC_TOKENS) {
      expect(detectSecrets(tok)).toEqual([]);
    }
  });

  it("a generic JWT (not in the public list) still detects as jwt", () => {
    const genericJwt = "eyJ" + "A".repeat(10) + ".eyJ" + "A".repeat(10) + "." + "A".repeat(5);
    expect(detectSecrets(genericJwt)).toContain("jwt");
  });

  it("redactSecrets still redacts a public token (detection-only exclusion)", () => {
    const out = redactSecrets(KNOWN_PUBLIC_TOKENS[0]!);
    expect(out).toContain(REDACTION_TOKEN);
  });
});

describe("quantifier near-misses do NOT match (length floors are load-bearing)", () => {
  it("an AKIA with 15 trailing chars is below the {16} floor", () => {
    expect(detectSecrets("AKIA" + "IOSFODNN7EXAMP")).not.toContain("aws-access-key-id");
  });
  it("a ghp_ with 35 trailing chars is below the {36} floor", () => {
    expect(detectSecrets("ghp_" + "A".repeat(35))).not.toContain("github-pat-classic");
  });
  it("a bare sk- with 19 chars is below the openai {20,} floor", () => {
    expect(detectSecrets("sk-" + "A".repeat(19))).not.toContain("openai-style-key");
  });
});
