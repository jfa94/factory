/**
 * WS7 — DETERMINISTIC citation-verify filter (Δ K / Decision 27 evidence bar).
 *
 * THE RULE: a finding survives only if its `quote` substring-matches REAL source
 * at `file:line ±2` (a window of the cited line ± two source lines). Any finding
 * whose quote is absent from that window — wrong file, past EOF, off by more than
 * two lines, or simply hallucinated — is DROPPED. Uncitable findings (no
 * file:line) are dropped too: they cannot be machine-verified.
 *
 * This is a hard divergence from the bash `validate_findings`, which did a FULL-
 * LINE match against the unified DIFF. We deliberately do a SUBSTRING match in a
 * ±2-line window against the SOURCE (a {@link SourceReader}), per the spec — the
 * bash behaviour is reference detail only, not an oracle.
 *
 * Properties:
 *   - PURE: no I/O. The source is read through the injected {@link SourceReader},
 *     so units run without a filesystem and the function is deterministic — the
 *     same findings + same source always yield the same kept/dropped split.
 *   - LOUD-by-construction: nothing is silently coerced; a dropped finding is
 *     RETURNED in `dropped[]` with a reason, never discarded without a trace.
 *   - REDACTION (Δ K): when `redact` is on, retained finding text (quote +
 *     description) is run through the frozen `redactSecrets` before it can be
 *     surfaced/persisted, so a secret a reviewer pasted into a finding never
 *     leaks downstream.
 */
import { redactSecrets } from "../../shared/secret-patterns.js";
import { isCitable, type Finding } from "./finding.js";

/**
 * Reads source so the filter can check a quote against real code. Injected so the
 * unit tests never touch the filesystem. `readLines(file)` returns the file's
 * lines (0-based array, no trailing newline) or `null` if the file does not exist
 * — a missing file means every citation into it is unverifiable (dropped).
 */
export interface SourceReader {
  readLines(file: string): readonly string[] | null;
}

/** The ±N-line window the quote is matched within. The spec's rule is ±2. */
export const CITATION_WINDOW = 2 as const;

/** Why a finding was dropped (audit trail; never silent). */
export type DropReason =
  | "uncitable" // no file:line
  | "file-not-found" // SourceReader returned null
  | "line-out-of-range" // cited line past EOF / < 1 even after windowing
  | "quote-not-in-window"; // quote does not substring-match within ±2

/** A dropped finding paired with the machine-checkable reason it was dropped. */
export interface DroppedFinding {
  readonly finding: Finding;
  readonly reason: DropReason;
}

/** The result of one citation-verify pass. No verdict is computed here. */
export interface CitationVerifyResult {
  /** Findings whose quote was confirmed against real source (possibly redacted). */
  readonly kept: readonly Finding[];
  /** Findings dropped, each with its reason. */
  readonly dropped: readonly DroppedFinding[];
  /** Per-finding audit line (kept|dropped + reason) for the report. */
  readonly audit: readonly string[];
}

/** Options for {@link verifyCitations}. */
export interface VerifyCitationsOptions {
  /**
   * Redact secrets from RETAINED finding text before it is surfaced/persisted
   * (Δ K, gated by `quality.securityRedactFindings`). Defaults to `true` — the
   * safe default; a caller must opt OUT explicitly.
   */
  readonly redact?: boolean;
}

/** Redact a finding's free text (quote + description) in place-by-copy. */
function redactFinding(f: Finding): Finding {
  return { ...f, quote: redactSecrets(f.quote), description: redactSecrets(f.description) };
}

/**
 * Does `quote` substring-match any line within `line ±2` (1-based) of `lines`?
 * Returns the specific {@link DropReason} when it does NOT, or `null` when it
 * matches. The window is clamped to the file bounds; if the cited line is itself
 * past EOF (no in-range line exists) that is `line-out-of-range`.
 */
function checkQuote(quote: string, line: number, lines: readonly string[]): DropReason | null {
  // 1-based cited line → 0-based index. Window is [line-2, line+2] (1-based),
  // clamped to [1, lines.length].
  const lo = Math.max(1, line - CITATION_WINDOW);
  const hi = Math.min(lines.length, line + CITATION_WINDOW);
  if (lo > hi) {
    // No line in the window exists at all (e.g. cited line 9999 in a 3-line file,
    // or an empty file) — the citation cannot point at real code.
    return "line-out-of-range";
  }
  for (let n = lo; n <= hi; n++) {
    // `noUncheckedIndexedAccess`: the index is provably in [lo-1, hi-1] ⊆ bounds,
    // but the type is `string | undefined`; guard rather than non-null-assert.
    const text = lines[n - 1];
    if (text !== undefined && text.includes(quote)) return null;
  }
  return "quote-not-in-window";
}

/**
 * Run the deterministic citation-verify filter over `findings`. Pure: all source
 * access goes through `source`. See module header for the rule.
 */
export function verifyCitations(
  findings: readonly Finding[],
  source: SourceReader,
  options: VerifyCitationsOptions = {},
): CitationVerifyResult {
  const redact = options.redact ?? true;
  const kept: Finding[] = [];
  const dropped: DroppedFinding[] = [];
  const audit: string[] = [];

  for (const f of findings) {
    if (!isCitable(f)) {
      dropped.push({ finding: f, reason: "uncitable" });
      audit.push(`DROP uncitable: ${f.reviewer} — ${f.description}`);
      continue;
    }
    const lines = source.readLines(f.file);
    if (lines === null) {
      dropped.push({ finding: f, reason: "file-not-found" });
      audit.push(`DROP file-not-found ${f.file}:${f.line}: ${f.reviewer}`);
      continue;
    }
    const reason = checkQuote(f.quote, f.line, lines);
    if (reason !== null) {
      dropped.push({ finding: f, reason });
      audit.push(`DROP ${reason} ${f.file}:${f.line}: ${f.reviewer}`);
      continue;
    }
    const retained = redact ? redactFinding(f) : f;
    kept.push(retained);
    audit.push(`KEEP ${f.file}:${f.line}: ${f.reviewer}`);
  }

  return { kept, dropped, audit };
}
