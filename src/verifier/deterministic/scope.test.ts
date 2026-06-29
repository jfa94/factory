/**
 * WS6 — scope/path-matrix vectors. Ports the is_test_path matrix
 * (bin/tests/tdd-gate.sh case_is_test_path_unit + language cases) and the
 * mutation-scope filter (mutation-gate.sh T3a/T3b/T3c) as a HARD parity target.
 */
import { describe, expect, it } from "vitest";
import {
  diffScopedTestFiles,
  escapeStrykerGlob,
  isDocsPath,
  isMutableSrc,
  isTestPath,
  isVitestRunnable,
  mutationScope,
} from "./scope.js";

describe("isTestPath matrix (Δ N/O — ports is_test_path)", () => {
  it("classifies suffix patterns across languages as TEST", () => {
    const tests = [
      "foo.test.ts",
      "foo.test.tsx",
      "foo.test.js",
      "x.spec.ts",
      "pkg/foo_test.go",
      "tests/foo_test.py",
      "spec/foo_spec.rb",
      "src/FooTest.java",
      "src/FooTest.kt",
      "test/FooTests.cs",
      "Tests/FooTests.swift",
    ];
    for (const p of tests) expect(isTestPath(p), p).toBe(true);
  });

  it("classifies root + per-package test dirs as TEST", () => {
    const tests = [
      "tests/x.ts",
      "test/x.ts",
      "spec/x.rb",
      "__tests__/x.ts",
      "a/b/c/tests/d.ts",
      "packages/foo/tests/bar.ts",
      "packages/foo/test/bar.ts",
      "packages/foo/spec/x.rb",
      "apps/bar/__tests__/x.ts",
    ];
    for (const p of tests) expect(isTestPath(p), p).toBe(true);
  });

  it("classifies plain source as NOT-test (negative vectors)", () => {
    const notTests = ["src/foo.ts", "packages/foo/src/bar.ts", "apps/bar/lib/x.rb", "pkg/foo.go"];
    for (const p of notTests) expect(isTestPath(p), p).toBe(false);
  });
});

describe("isDocsPath (ports _is_docs_path)", () => {
  it("treats docs/* and *.md as docs", () => {
    expect(isDocsPath("docs/foo.md")).toBe(true);
    expect(isDocsPath("README.md")).toBe(true);
    expect(isDocsPath("docs/nested/guide.txt")).toBe(true);
    expect(isDocsPath("src/foo.ts")).toBe(false);
  });
});

describe("isMutableSrc + mutationScope (Δ O — ports mutation-gate T3a/b/c)", () => {
  it("T3c: mixed src+filtered → scope keeps mutable src, drops test/types/data/index", () => {
    const changed = [
      "src/foo.ts",
      "src/foo.test.ts",
      "src/bar.ts",
      "src/types/y.d.ts",
      "src/types/z.ts",
      "src/data/seed.ts",
      "src/index.ts",
      "src/feature/index.ts",
    ];
    const scope = mutationScope(changed);
    expect(scope).toContain("src/foo.ts");
    expect(scope).toContain("src/bar.ts");
    expect(scope).not.toContain("src/foo.test.ts");
    expect(scope).not.toContain("src/types/y.d.ts");
    expect(scope).not.toContain("src/types/z.ts");
    expect(scope).not.toContain("src/data/seed.ts");
    expect(scope).not.toContain("src/index.ts");
    expect(scope).not.toContain("src/feature/index.ts");
  });

  it("T3a: docs-only changes → empty scope (no-mutable-changes)", () => {
    expect(mutationScope(["docs/readme.md", "README.md"])).toEqual([]);
  });

  it("T3b: only test/d.ts/types/data/index changes → empty scope", () => {
    const changed = ["src/foo.test.ts", "src/types/x.d.ts", "src/data/y.ts", "src/index.ts"];
    expect(mutationScope(changed)).toEqual([]);
  });

  it("excludes files outside src/ and non-.ts files", () => {
    expect(isMutableSrc("lib/foo.ts")).toBe(false);
    expect(isMutableSrc("src/foo.js")).toBe(false);
    expect(isMutableSrc("src/foo.ts")).toBe(true);
  });

  it("de-duplicates while preserving order", () => {
    expect(mutationScope(["src/a.ts", "src/a.ts", "src/b.ts"])).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("escapeStrykerGlob (glob-literal escaping for --mutate CSV)", () => {
  it("escapes [ and ] (Next.js dynamic-route segments)", () => {
    // The externally-verified triggering case: src/app/feedback/[token]/actions.ts
    expect(escapeStrykerGlob("src/app/feedback/[token]/actions.ts")).toBe(
      "src/app/feedback/[[]token[]]/actions.ts",
    );
  });

  it("escapes spread params ([...slug])", () => {
    expect(escapeStrykerGlob("src/app/[...slug]/page.ts")).toBe("src/app/[[]...slug[]]/page.ts");
  });

  it("escapes route groups ((...))", () => {
    expect(escapeStrykerGlob("src/app/(marketing)/page.ts")).toBe(
      "src/app/[(]marketing[)]/page.ts",
    );
  });

  it("escapes parallel routes (@)", () => {
    expect(escapeStrykerGlob("src/app/@modal/default.ts")).toBe("src/app/[@]modal/default.ts");
  });

  it("leaves plain paths unchanged", () => {
    expect(escapeStrykerGlob("src/app/page.ts")).toBe("src/app/page.ts");
    expect(escapeStrykerGlob("src/lib/utils.ts")).toBe("src/lib/utils.ts");
  });
});

describe("isVitestRunnable (vitest-executable file predicate)", () => {
  it("returns true for JS/TS extensions vitest can execute", () => {
    const runnable = [
      "src/foo.test.ts",
      "src/foo.spec.tsx",
      "tests/bar.js",
      "tests/baz.mjs",
      "src/foo.cjs",
      "src/foo.jsx",
    ];
    for (const p of runnable) expect(isVitestRunnable(p), p).toBe(true);
  });

  it("returns false for non-JS test files vitest cannot execute", () => {
    const notRunnable = [
      "supabase/tests/x.test.sql",
      "pkg/foo_test.go",
      "src/FooTest.java",
      "tests/foo_test.py",
      "spec/foo_spec.rb",
    ];
    for (const p of notRunnable) expect(isVitestRunnable(p), p).toBe(false);
  });
});

describe("diffScopedTestFiles (Δ O diff-scoped unit)", () => {
  it("keeps only changed test files, de-duplicated", () => {
    const changed = ["src/foo.ts", "src/foo.test.ts", "src/foo.test.ts", "tests/x.ts"];
    expect(diffScopedTestFiles(changed)).toEqual(["src/foo.test.ts", "tests/x.ts"]);
  });
});
