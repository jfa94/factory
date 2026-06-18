// esbuild → checked-in, self-contained bundles.
//
//   src/bin/factory.ts            → dist/factory.js
//   src/bin/factory-hook.ts       → dist/factory-hook.js
//   src/bin/shard-mutation-scope.ts → templates/.github/scripts/shard-mutation-scope.mjs
//
// The two dist bundles are full inlines (NO `external`) so they run at a user's
// site with no node_modules — zod + proper-lockfile get bundled in. A
// `#!/usr/bin/env node` banner + chmod 0755 makes them directly executable.
//
// The shard-mutation-scope bundle is the SCAFFOLD TEMPLATE the CI `mutation-scope`
// job runs (`node .github/scripts/shard-mutation-scope.mjs`). It bundles only the
// pure shard logic + node:fs, so it stays dependency-free for ubuntu's preinstalled
// node (the job has no `setup-node`/install). Generated from src so the tested TS is
// the single source of truth; the build-staleness test guards src↔template drift.
//
// All un-minified so the checked-in generated artifacts stay diff-reviewable.
// Exits non-zero on any build failure so `npm run verify` / CI catches it.
import { build } from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(repoRoot, "dist");

// Banner: shebang + a `require` shim. `proper-lockfile` (and other CJS deps) call
// `require` internally; an ESM bundle has none, so esbuild's `__require` stub
// throws "Dynamic require of X". Defining a real `require` via createRequire makes
// the stub (`typeof require !== "undefined"`) resolve those against node's module
// system. Required the moment the bundle pulls in StateManager (→ proper-lockfile).
const BANNER = [
  "#!/usr/bin/env node",
  "import { createRequire as __factoryCreateRequire } from 'node:module';",
  "const require = __factoryCreateRequire(import.meta.url);",
].join("\n");

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: BANNER },
  logLevel: "warning",
  sourcemap: false,
  minify: false,
};

const targets = [
  { entry: "src/bin/factory.ts", out: "dist/factory.js" },
  { entry: "src/bin/factory-hook.ts", out: "dist/factory-hook.js" },
];

// The scaffold template: a plain `#!/usr/bin/env node` shebang (no createRequire
// shim — it pulls in zero CJS deps) so it round-trips byte-for-byte for the
// staleness test and stays runnable as a bare node script in downstream CI.
export const SHARD_TEMPLATE = {
  entry: "src/bin/shard-mutation-scope.ts",
  out: "templates/.github/scripts/shard-mutation-scope.mjs",
};

/** Build a single esbuild target's bundle and return its options (used by the test). */
export function shardTemplateBuildOptions() {
  return {
    ...common,
    banner: { js: "#!/usr/bin/env node" },
    entryPoints: [resolve(repoRoot, SHARD_TEMPLATE.entry)],
    outfile: resolve(repoRoot, SHARD_TEMPLATE.out),
  };
}

async function main() {
  mkdirSync(distDir, { recursive: true });
  for (const t of targets) {
    await build({
      ...common,
      entryPoints: [resolve(repoRoot, t.entry)],
      outfile: resolve(repoRoot, t.out),
    });
    chmodSync(resolve(repoRoot, t.out), 0o755);
    process.stdout.write(`built ${t.out}\n`);
  }
  await build(shardTemplateBuildOptions());
  process.stdout.write(`built ${SHARD_TEMPLATE.out}\n`);
}

// Only build when run directly (`node scripts/build.mjs`); importing this module
// (the staleness test does, for `shardTemplateBuildOptions`) must not trigger a build.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    process.stderr.write((err?.stack ?? String(err)) + "\n");
    process.exit(1);
  });
}
