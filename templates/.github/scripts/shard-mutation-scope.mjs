#!/usr/bin/env node

// src/verifier/deterministic/scope.ts
function escapeStrykerGlob(p) {
  return p.replace(/[[\]{}()*?!+@|]/g, (c) => `[${c}]`);
}

// src/verifier/deterministic/shard.ts
function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function shardByHash(files, n) {
  const bins = Array.from({ length: Math.max(0, n) }, () => []);
  if (bins.length === 0) {
    return [];
  }
  for (const file of files) {
    bins[fnv1a(file) % bins.length]?.push(file);
  }
  return bins.map((b) => b.map(escapeStrykerGlob).join(","));
}

// src/bin/shard-mutation-scope.ts
var SHARD_COUNT = 4;
function main(scopeCsv) {
  const files = scopeCsv.split(",").map((f) => f.trim()).filter((f) => f !== "");
  const shards = shardByHash(files, SHARD_COUNT);
  process.stdout.write(JSON.stringify(shards) + "\n");
}
main(process.argv[2] ?? process.env.SCOPE ?? "");
export {
  SHARD_COUNT
};
