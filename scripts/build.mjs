// esbuild → two checked-in, self-contained, executable bundles.
//
//   src/bin/factory.ts       → dist/factory.js
//   src/bin/factory-hook.ts  → dist/factory-hook.js
//
// Both are full inlines (NO `external`) so they run at a user's site with no
// node_modules — zod + proper-lockfile get bundled in. A `#!/usr/bin/env node`
// banner + chmod 0755 makes them directly executable. Kept un-minified so the
// checked-in generated artifact stays diff-reviewable.
//
// Exits non-zero on any build failure so `npm run verify` / CI catches it.
import { build } from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(repoRoot, "dist");

const SHEBANG = "#!/usr/bin/env node";

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: SHEBANG },
  logLevel: "warning",
  sourcemap: false,
  minify: false,
};

const targets = [
  { entry: "src/bin/factory.ts", out: "dist/factory.js" },
  { entry: "src/bin/factory-hook.ts", out: "dist/factory-hook.js" },
];

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
}

main().catch((err) => {
  process.stderr.write((err?.stack ?? String(err)) + "\n");
  process.exit(1);
});
