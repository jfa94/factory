/**
 * WS6 — testing-scope matrix path classification (Δ O).
 *
 * THE single source of truth for "is this a test path?" and "is this a mutable
 * source file?", shared by the tdd, mutation, and test strategies. Ported VERBATIM
 * from the bash gate-math oracle so the classification is byte-for-byte the same:
 *   - {@link isTestPath} ← `is_test_path` in bin/pipeline-lib.sh:940 (the suffix +
 *     directory matrix: *.test.<ext>, *.spec.<ext>, *_test.<ext>, *Test.<ext>,
 *     *Tests.<ext>, *_spec.rb, and tests/|test/|spec/|__tests__/ at root AND
 *     per-package).
 *   - {@link isMutableSrc} ← the mutation-gate exclusion filter
 *     (bin/pipeline-mutation-gate:91-92 + quality-gate.yml): src/**\/*.ts MINUS
 *     `\.(test|spec|d)\.ts$`, `/types/`, `/data/`, `/index\.ts$`.
 *
 * Pure string functions — no I/O, deterministic. The mutation-scope COMPUTATION
 * ({@link mutationScope}) takes the already-diffed file list (the git probe owns
 * the `diff --diff-filter=AM origin/<base>...HEAD` shell-out) and applies the
 * glob + exclusion filter, mirroring CI exactly.
 */

/**
 * Classify a path as a test file. Ported from `is_test_path`
 * (bin/pipeline-lib.sh:940). Covers suffix patterns across ts/tsx/js/jsx/mjs/cjs/
 * py/rb/go/rs (`.test.`/`.spec.`), Go/Python/Ruby/Elixir `_test.`, Java/Kotlin/PHP
 * `*Test.`, Swift/C# `*Tests.`, RSpec `*_spec.rb`, and the directory patterns
 * tests/ test/ spec/ __tests__/ at the repo root and nested per-package.
 */
export function isTestPath(file: string): boolean {
  // Suffix-based: .test.<ext> / .spec.<ext>
  if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs)$/.test(file)) return true;
  // Suffix-based: _test.<ext> (Go, Python, Ruby, Elixir)
  if (/_test\.(go|py|rb|exs)$/.test(file)) return true;
  // Suffix-based: *Test.<ext> (Java, Kotlin, PHP)
  if (/Test\.(java|kt|php)$/.test(file)) return true;
  // Suffix-based: *Tests.<ext> (Swift, C#)
  if (/Tests\.(swift|cs)$/.test(file)) return true;
  // Suffix-based: *_spec.rb (RSpec)
  if (/_spec\.rb$/.test(file)) return true;
  // Directory-based — root layout (no leading dir).
  if (/^(tests|test|spec|__tests__)\//.test(file)) return true;
  // Directory-based — nested / per-package (monorepo) layout.
  if (/\/(tests|test|spec|__tests__)\//.test(file)) return true;
  return false;
}

/**
 * Classify a path as a documentation file. Ported from `_is_docs_path`
 * (bin/pipeline-tdd-gate:39): `docs/*` or any `*.md`. Used by the TDD gate so a
 * docs-only commit is NOT classified as impl.
 */
export function isDocsPath(file: string): boolean {
  if (/^docs\//.test(file)) return true;
  if (file.endsWith(".md")) return true;
  return false;
}

/**
 * Is `file` a MUTABLE source file for the mutation gate? Ported from the
 * mutation-gate scope filter (bin/pipeline-mutation-gate:91-92): it must match
 * `src/**\/*.ts` AND NOT match the exclusions `\.(test|spec|d)\.ts$`, `/types/`,
 * `/data/`, `/index\.ts$`.
 *
 * Note this is INDEPENDENT of {@link isTestPath} — the mutation gate uses its own
 * narrower exclusion regex (it also drops `*.d.ts`, `types/`, `data/`, and any
 * `index.ts`, which the TDD test-path matrix does not).
 */
export function isMutableSrc(file: string): boolean {
  // Must be under src/ and a .ts file (the `:(glob)src/**/*.ts` pathspec).
  if (!/^src\/.*\.ts$/.test(file)) return false;
  // Exclusions: .test.ts / .spec.ts / .d.ts, /types/, /data/, index.ts (any dir).
  if (/\.(test|spec|d)\.ts$/.test(file)) return false;
  if (file.includes("/types/")) return false;
  if (file.includes("/data/")) return false;
  if (/(^|\/)index\.ts$/.test(file)) return false;
  return true;
}

/**
 * Compute the blob-scoped mutation rollup scope (Δ O) from the AM-diffed file
 * list. Applies {@link isMutableSrc} to each path and returns the survivors,
 * de-duplicated and order-preserving. Mirrors CI's scope computation EXACTLY (the
 * git probe produced `changedFiles` via `diff --diff-filter=AM origin/<base>...HEAD`).
 *
 * An EMPTY result means "no mutable changes" — the mutation strategy treats that
 * as a SKIP, never a pass-by-default.
 */
export function mutationScope(changedFiles: readonly string[]): string[] {
  return filterDedup(changedFiles, isMutableSrc);
}

/**
 * Diff-scoped unit-test file set (Δ O): the changed files that ARE test files.
 * Order-preserving + de-duplicated. The test strategy uses this to scope the unit
 * run to the changed tests.
 */
export function diffScopedTestFiles(changedFiles: readonly string[]): string[] {
  return filterDedup(changedFiles, isTestPath);
}

/**
 * Escape glob metacharacters in a literal file path so Stryker's `--mutate`
 * matcher treats it as a literal, not a glob. git-diff paths are always literal;
 * Next.js dynamic-route segments (`[token]`, `[...slug]`), route groups (`(...)`),
 * and parallel routes (`@`) would otherwise glob-expand to zero files →
 * "No tests were executed" → exit 1. Char-class wrapping (`[` → `[[]`, `]` → `[]]`,
 * …) is the portable glob-literal idiom Stryker's matcher honors; backslash-escaping
 * does NOT work (tested — still zero files).
 */
export function escapeStrykerGlob(p: string): string {
  return p.replace(/[[\]{}()*?!+@|]/g, (c) => `[${c}]`);
}

/** Keep the files matching `keep`, de-duplicated and order-preserving. */
function filterDedup(files: readonly string[], keep: (file: string) => boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of files) {
    if (!keep(f)) continue;
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}
