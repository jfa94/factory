/**
 * Cost-aware mutation sharding (the balancer behind the CI `mutation-scope` job).
 *
 * The factory CI splits a PR's changed mutable-source files across N parallel
 * Stryker shards. The original template split round-robin by file COUNT
 * (`i % N`), which is blind to per-file mutation cost and systematically
 * overloaded the low-index shard (remainder skew + `git diff` sorting the heavy
 * foundational modules early). This module replaces that with **LPT
 * (Longest-Processing-Time) greedy bin-packing** weighted by a cheap cost proxy.
 *
 * Pure string/number functions — no I/O, deterministic. {@link sloc} is the
 * weight proxy; {@link shardByCost} is the weight-agnostic packer (a better
 * signal — e.g. prior-run mutant counts — can drop straight in). The CLI shim
 * (`src/bin/shard-mutation-scope.ts`, bundled to the scaffold template) is the
 * only I/O layer: it reads each scoped file and feeds its sloc here.
 */

/**
 * Source-lines-of-code: physical lines MINUS blank lines, comment-only lines
 * (`//`, `/* … *​/` blocks, ` * …` JSDoc continuations), and import / re-export
 * statements (single- and multi-line). A weight proxy for mutant count that —
 * unlike raw line count — does not over-weight this codebase's heavily-JSDoc'd
 * foundational modules (the very files the balancer is trying to spread out).
 *
 * Deliberately a heuristic, not a parser: weights only need to rank files, so a
 * line straddling code and a `*​/` is allowed to count as a comment.
 */
export function sloc(text: string): number {
  let count = 0;
  let inBlockComment = false;
  let inImport = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();

    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue; // the whole line is comment
    }
    if (inImport) {
      // Multi-line import/export — terminates at the statement's `;`.
      if (line.includes(";")) inImport = false;
      continue;
    }

    if (line === "") continue;
    if (line.startsWith("//")) continue;
    if (line.startsWith("*")) continue; // JSDoc continuation
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlockComment = true;
      continue;
    }
    if (/^import\b/.test(line) || /^export\b.*\bfrom\b/.test(line)) {
      // Opens a (possibly multi-line) import/export-from; skip until terminated.
      if (!line.includes(";")) inImport = true;
      continue;
    }

    count++;
  }
  return count;
}

/**
 * Split `files` across `n` shards by **LPT greedy bin-packing**: sort by weight
 * descending (ties broken by path ascending — deterministic, so identical inputs
 * always yield identical assignments and per-shard incremental caches don't churn
 * gratuitously), then assign each file to the currently-lightest shard.
 *
 * `weights[i]` is the cost of `files[i]`; a missing/`NaN` weight defaults to `1`.
 * Returns EXACTLY `n` comma-joined CSV strings (the `mutation` matrix is static
 * `[1..n]` and indexes the result positionally), so an empty input yields `n`
 * empty strings. Mirrors the CSV the workflow feeds to `stryker run --mutate`.
 */
export function shardByCost(
  files: readonly string[],
  weights: readonly number[],
  n: number,
): string[] {
  const bins: { load: number; files: string[] }[] = Array.from({ length: Math.max(0, n) }, () => ({
    load: 0,
    files: [],
  }));
  if (bins.length === 0) return [];

  const items = files.map((file, i) => {
    const w = weights[i];
    return { file, weight: typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 1 };
  });
  // Heaviest first; stable tie-break by path keeps assignment deterministic.
  items.sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  for (const { file, weight } of items) {
    let lightest = bins[0]!;
    for (const bin of bins) {
      if (bin.load < lightest.load) lightest = bin;
    }
    lightest.files.push(file);
    lightest.load += weight;
  }

  return bins.map((b) => b.files.join(","));
}
