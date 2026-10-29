#!/usr/bin/env node
/* eslint-disable security/detect-non-literal-fs-filename -- Reads Git paths constrained to validated repository roots; preserves the source annotation. */

// src/bin/shard-mutation-scope.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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
var SHARD_COUNT = 8;
var HUNK_PADDING = 2;
var readUtf8 = (path) => {
  return readFileSync(path, "utf8");
};
var EXCLUDE_FILE = ".factory/mutation-exclude.json";
var EXCLUDED = [
  /\.(?:test|spec)\.tsx?$/,
  /\.d\.ts$/,
  /(?:^|\/)types\//,
  /(?:^|\/)data\//,
  /(?:^|\/)index\.ts$/,
  /(?:^|\/)(?:types|[^/]+-types)\.ts$/,
  /(?:^|\/)app\/(?:robots|sitemap)\.ts$/
];
function isMutablePath(path, excluded = /* @__PURE__ */ new Set()) {
  return /\.tsx?$/.test(path) && !excluded.has(path) && EXCLUDED.every((pattern) => !pattern.test(path));
}
function loadExcluded(readText = readUtf8) {
  let text;
  try {
    text = readText(EXCLUDE_FILE);
  } catch (cause) {
    if (cause.code === "ENOENT") {
      return /* @__PURE__ */ new Set();
    }
    throw new Error(`mutation scope: cannot read ${EXCLUDE_FILE}`, { cause });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`mutation scope: ${EXCLUDE_FILE} is not valid JSON`, { cause });
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`mutation scope: ${EXCLUDE_FILE} must be a JSON array of path strings`);
  }
  const bad = parsed.find(
    (entry) => entry !== entry.trim() || entry.includes("\\") || !/\.tsx?$/.test(entry) || /[*?]/.test(entry) || entry.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
  if (bad !== void 0) {
    throw new Error(
      `mutation scope: ${EXCLUDE_FILE} entry ${JSON.stringify(bad)} must be a repo-relative file path like src/a.ts`
    );
  }
  return new Set(parsed);
}
function isQuarantined(path, readText) {
  try {
    return readText(path).startsWith("// Stryker disable all");
  } catch (cause) {
    throw new Error(`mutation scope: cannot read ${path}`, { cause });
  }
}
function parseDiffToRanges(diffText) {
  const patterns = [];
  let file = null;
  let isNew = false;
  let hunks = [];
  const flush = () => {
    if (file === null || !isMutablePath(file)) {
      return;
    }
    if (isNew) {
      patterns.push(file);
      return;
    }
    hunks.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of hunks) {
      const last = merged.at(-1);
      if (last !== void 0 && start <= last[1] + 1) {
        last[1] = Math.max(last[1], end);
      } else {
        merged.push([start, end]);
      }
    }
    for (const [start, end] of merged) {
      patterns.push(`${file}:${start}-${end}`);
    }
  };
  for (const line of diffText.split("\n")) {
    const headerMarker = " b/";
    const headerIndex = line.startsWith("diff --git a/") ? line.lastIndexOf(headerMarker) : -1;
    if (headerIndex !== -1) {
      flush();
      file = line.slice(headerIndex + headerMarker.length);
      isNew = false;
      hunks = [];
      continue;
    }
    if (line.startsWith("new file mode")) {
      isNew = true;
      continue;
    }
    const newSide = line.startsWith("@@ ") ? line.split(" ")[2] : void 0;
    if (newSide === void 0 || !newSide.startsWith("+") || file === null || isNew) {
      continue;
    }
    const [startText, lengthText] = newSide.slice(1).split(",", 2);
    const start = Number.parseInt(startText ?? "1", 10);
    const length = lengthText === void 0 ? 1 : Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length)) {
      continue;
    }
    const end = length === 0 ? start + HUNK_PADDING : start + length - 1 + HUNK_PADDING;
    hunks.push([Math.max(1, start - HUNK_PADDING), Math.max(1, end)]);
  }
  flush();
  return patterns;
}
function filterMutablePatterns(patterns, readText = readUtf8, excluded = /* @__PURE__ */ new Set()) {
  return patterns.filter((pattern) => {
    const path = pattern.split(":", 1)[0] ?? "";
    return isMutablePath(path, excluded) && !isQuarantined(path, readText);
  });
}
function parseFullFileList(fileList, readText = readUtf8, excluded = /* @__PURE__ */ new Set()) {
  return filterMutablePatterns(
    fileList.split("\n").map((path) => path.trim()).filter(Boolean),
    readText,
    excluded
  );
}
function defaultGit(args) {
  return execFileSync("git", [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
function assertRoots(roots) {
  if (roots.length === 0 || roots.some(
    (root) => root === "" || root.startsWith("/") || root.split("/").some((part) => part === "" || part === "." || part === "..") || !/^[A-Za-z0-9._/-]+$/.test(root)
  )) {
    throw new Error("mutation roots must be non-empty relative directory paths");
  }
}
function pathspecs(roots) {
  assertRoots(roots);
  return roots.flatMap((root) => [`:(glob)${root}/**/*.ts`, `:(glob)${root}/**/*.tsx`]);
}
function diffScope(baseRef, roots, git = defaultGit, readText, excluded) {
  if (baseRef === "") {
    throw new Error("diff mode requires a base ref");
  }
  const diff = git(["diff", "-U0", "--diff-filter=AMR", `${baseRef}...HEAD`, "--", ...pathspecs(roots)]);
  return filterMutablePatterns(parseDiffToRanges(diff), readText, excluded);
}
function fullScope(roots, git = defaultGit, readText, excluded) {
  const files = git(["ls-files", "--", ...pathspecs(roots)]);
  return parseFullFileList(files, readText, excluded);
}
function shardScope(patterns) {
  return shardByHash([...patterns], SHARD_COUNT);
}
function usage() {
  throw new Error("usage: shard-mutation-scope.mjs diff <base-ref> <root...> | full <root...>");
}
function run(args) {
  const [mode, ...rest] = args;
  if (mode === "diff") {
    const [baseRef, ...roots] = rest;
    return shardScope(diffScope(baseRef ?? "", roots, defaultGit, readUtf8, loadExcluded()));
  }
  if (mode === "full") {
    return shardScope(fullScope(rest, defaultGit, readUtf8, loadExcluded()));
  }
  return usage();
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.stdout.write(JSON.stringify(run(process.argv.slice(2))) + "\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  }
}
export {
  EXCLUDE_FILE,
  HUNK_PADDING,
  SHARD_COUNT,
  diffScope,
  filterMutablePatterns,
  fullScope,
  isMutablePath,
  loadExcluded,
  parseDiffToRanges,
  parseFullFileList,
  run,
  shardScope
};
