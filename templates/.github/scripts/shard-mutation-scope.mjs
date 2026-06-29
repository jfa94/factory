#!/usr/bin/env node

// src/bin/shard-mutation-scope.ts
import { readFileSync } from "node:fs";

// src/verifier/deterministic/scope.ts
function escapeStrykerGlob(p) {
  return p.replace(/[[\]{}()*?!+@|]/g, (c) => `[${c}]`);
}

// src/verifier/deterministic/shard.ts
function sloc(text) {
  let count = 0;
  let inBlockComment = false;
  let inImport = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (inImport) {
      if (line.includes(";")) inImport = false;
      continue;
    }
    if (line === "") continue;
    if (line.startsWith("//")) continue;
    if (line.startsWith("*")) continue;
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlockComment = true;
      continue;
    }
    if (/^import\b/.test(line) || /^export\b.*\bfrom\b/.test(line)) {
      if (!line.includes(";")) inImport = true;
      continue;
    }
    count++;
  }
  return count;
}
function shardByCost(files, weights, n) {
  const bins = Array.from({ length: Math.max(0, n) }, () => ({
    load: 0,
    files: []
  }));
  if (bins.length === 0) return [];
  const items = files.map((file, i) => {
    const w = weights[i];
    return { file, weight: typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 1 };
  });
  items.sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  for (const { file, weight } of items) {
    let lightest = bins[0];
    for (const bin of bins) {
      if (bin.load < lightest.load) lightest = bin;
    }
    lightest.files.push(file);
    lightest.load += weight;
  }
  return bins.map((b) => b.files.map(escapeStrykerGlob).join(","));
}

// src/bin/shard-mutation-scope.ts
var SHARD_COUNT = 4;
function weightOf(file) {
  try {
    return sloc(readFileSync(file, "utf8")) || 1;
  } catch {
    return 1;
  }
}
function main(scopeCsv) {
  const files = scopeCsv.split(",").map((f) => f.trim()).filter((f) => f !== "");
  const weights = files.map(weightOf);
  const shards = shardByCost(files, weights, SHARD_COUNT);
  process.stdout.write(JSON.stringify(shards) + "\n");
}
main(process.argv[2] ?? process.env.SCOPE ?? "");
export {
  SHARD_COUNT
};
