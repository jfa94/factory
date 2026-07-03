/**
 * WS9 — TCB hardcoded-denylist tests (Δ W / §4 / D1). Each test names the
 * delta/decision it keys to.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTcbProtected, buildTcbRules, canonicalizePath, TCB_DENY } from "./tcb.js";
import {
  STRYKER_CONFIG_BASENAMES,
  DEPENDENCY_CRUISER_CONFIG_BASENAMES,
} from "../shared/gate-config-names.js";

describe("tcb — hardcoded denylist (Δ W)", () => {
  let repoRoot: string;
  let dataDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "tcb-repo-"));
    dataDir = mkdtempSync(join(tmpdir(), "tcb-data-"));
    mkdirSync(join(repoRoot, ".github", "workflows"), { recursive: true });
    mkdirSync(join(repoRoot, "hooks"), { recursive: true });
    mkdirSync(join(repoRoot, "docs", "factory", "1-x"), { recursive: true });
    mkdirSync(join(dataDir, "runs", "run-1", "holdouts"), { recursive: true });
    mkdirSync(join(dataDir, "specs", "owner-name", "1-x"), { recursive: true });
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  const ctx = () => ({ repoRoot, dataDir });

  it("Δ W: matches .github/workflows/** (CI/gate machinery)", () => {
    const p = join(repoRoot, ".github", "workflows", "quality-gate.yml");
    writeFileSync(p, "x");
    const m = isTcbProtected(p, ctx());
    expect(m?.rule.category).toBe("ci-workflows");
  });

  it("Δ W: matches gate config by basename (.stryker.config.json, .dependency-cruiser.cjs)", () => {
    for (const name of [".stryker.config.json", ".dependency-cruiser.cjs"]) {
      const p = join(repoRoot, name);
      writeFileSync(p, "x");
      expect(isTcbProtected(p, ctx())?.rule.category).toBe("gate-config");
    }
  });

  // jfa94/factory#11 drift guard: EVERY Stryker-discoverable config basename must
  // be write-protected, else an implementer could create an unprotected sibling that
  // Stryker loads ahead of the scaffolded config (the .js/.mjs/.cjs variants are
  // executable JS run inside the gate). Behavioral — pins protection ⊇ discovery
  // set even if the wiring is later refactored.
  it("Δ W: tcb-stryker-discovery — every Stryker discovery basename is gate-config protected", () => {
    for (const name of STRYKER_CONFIG_BASENAMES) {
      const p = join(repoRoot, name);
      writeFileSync(p, "x");
      expect(isTcbProtected(p, ctx())?.rule.category).toBe("gate-config");
    }
  });

  // jfa94/factory#11 (same gap class): dependency-cruiser's discovery loads the
  // first-existing of `.dependency-cruiser.{json,js,cjs,mjs}`; the .js/.cjs/.mjs
  // variants are executable JS run in the arch/lint gate. Every discoverable
  // basename must be write-protected.
  it("Δ W: tcb-depcruise-discovery — every dependency-cruiser discovery basename is gate-config protected", () => {
    for (const name of DEPENDENCY_CRUISER_CONFIG_BASENAMES) {
      const p = join(repoRoot, name);
      writeFileSync(p, "x");
      expect(isTcbProtected(p, ctx())?.rule.category).toBe("gate-config");
    }
  });

  it("Δ W: matches hooks/** (the guard hooks)", () => {
    const p = join(repoRoot, "hooks", "write-protection.sh");
    writeFileSync(p, "x");
    expect(isTcbProtected(p, ctx())?.rule.category).toBe("hooks");
  });

  it("Decision 39: matches e2e/** (committed critical e2e suite)", () => {
    const p = join(repoRoot, "e2e", "checkout.spec.ts");
    mkdirSync(join(repoRoot, "e2e"), { recursive: true });
    writeFileSync(p, "x");
    expect(isTcbProtected(p, ctx())?.rule.category).toBe("e2e-suite");
  });

  it("Decision 39: the e2e deny is context-free (fires even without a wired repo dir)", () => {
    // Like .github/workflows/** and docs/factory/**, component-anchored and
    // unconditional — an implementer touching e2e/** is denied even before a
    // repoRoot is wired into ctx.
    const p = join(repoRoot, "e2e", "checkout.spec.ts");
    mkdirSync(join(repoRoot, "e2e"), { recursive: true });
    writeFileSync(p, "x");
    expect(isTcbProtected(p)?.rule.category).toBe("e2e-suite");
  });

  it("Decision 39: a non-e2e path (e.g. src/e2e-helper.ts) is NOT protected", () => {
    // Scoped to the e2e/** directory, not any path containing the substring "e2e".
    const p = join(repoRoot, "src", "e2e-helper.ts");
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(p, "x");
    expect(isTcbProtected(p, ctx())).toBeNull();
  });

  it("Δ Y: matches the holdout store under <dataDir>/runs/**", () => {
    const p = join(dataDir, "runs", "run-1", "holdouts", "answers.json");
    writeFileSync(p, "x");
    expect(isTcbProtected(p, ctx())?.rule.category).toBe("data-runs");
  });

  it("Δ X: matches the durable spec store under <dataDir>/specs/**", () => {
    const p = join(dataDir, "specs", "owner-name", "1-x", "tasks.json");
    writeFileSync(p, "x");
    expect(isTcbProtected(p, ctx())?.rule.category).toBe("data-specs");
  });

  it("SecA: matches <dataDir>/config.json (operator config — protects setupCommand shell vector)", () => {
    // An implementer that can write config.json could inject a quality.setupCommand
    // that runs arbitrary shell at provision time. This closes the Edit/Write vector;
    // the Bash-redirect residual is tracked in the executor-confinement epic.
    const p = join(dataDir, "config.json");
    writeFileSync(p, "{}");
    expect(isTcbProtected(p, ctx())?.rule.category).toBe("data-config");
  });

  it("SecA: a non-config file at dataDir root is NOT protected (scoped exactly to config.json)", () => {
    const p = join(dataDir, "other.json");
    writeFileSync(p, "{}");
    expect(isTcbProtected(p, ctx())).toBeNull();
  });

  it("F-specloc: ADVERSARIAL — an implementer write to docs/factory/<spec-id>/tasks.json is DENIED", () => {
    // The in-repo reviewable spec copy is implementer-immutable, exactly like
    // .github/workflows/** — an implementer that could edit it would weaken its own
    // acceptance criteria. Mirrors the ci-workflows deny.
    const p = join(repoRoot, "docs", "factory", "1-x", "tasks.json");
    writeFileSync(p, "x");
    expect(isTcbProtected(p, ctx())?.rule.category).toBe("docs-factory");
  });

  it("F-specloc: the docs/factory deny is context-free (fires even without a wired repo/data dir)", () => {
    // Like .github/workflows/**, the rule is component-anchored and unconditional:
    // it does not need ctx to fire, so a Bash absolute-path write is still denied.
    const p = join(repoRoot, "docs", "factory", "1-x", "spec.md");
    writeFileSync(p, "x");
    expect(isTcbProtected(p)?.rule.category).toBe("docs-factory");
  });

  it("F-specloc: a non-factory docs path (e.g. docs/guide.md) is NOT protected", () => {
    // Scoped, not 'all of docs/'. Only docs/factory/** is the implementer-immutable
    // spec artifact; ordinary in-repo docs stay writable.
    const p = join(repoRoot, "docs", "guide.md");
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(p, "x");
    expect(isTcbProtected(p, ctx())).toBeNull();
  });

  it("D46: ADVERSARIAL — a producer write to .factory/gates.json is DENIED", () => {
    // The committed gate contract is producer-immutable: an implementer that could
    // edit it could waive its own gates — the exact silent-skip S7 kills.
    const p = join(repoRoot, ".factory", "gates.json");
    mkdirSync(join(repoRoot, ".factory"), { recursive: true });
    writeFileSync(p, "{}");
    expect(isTcbProtected(p, ctx())?.rule.category).toBe("gate-contract");
  });

  it("D46: the gate-contract deny is context-free (absolute-path Bash write still denied)", () => {
    const p = join(repoRoot, ".factory", "gates.json");
    mkdirSync(join(repoRoot, ".factory"), { recursive: true });
    writeFileSync(p, "{}");
    expect(isTcbProtected(p)?.rule.category).toBe("gate-contract");
  });

  it("D46: `..` traversal into .factory/gates.json resolves to the same deny", () => {
    const sub = join(repoRoot, "src");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(repoRoot, ".factory"), { recursive: true });
    writeFileSync(join(repoRoot, ".factory", "gates.json"), "{}");
    const traversal = join(sub, "..", ".factory", "gates.json");
    expect(isTcbProtected(traversal, ctx())?.rule.category).toBe("gate-contract");
  });

  it("D46: a sibling file under .factory/ is NOT protected (scoped exactly to gates.json)", () => {
    const p = join(repoRoot, ".factory", "notes.md");
    mkdirSync(join(repoRoot, ".factory"), { recursive: true });
    writeFileSync(p, "x");
    expect(isTcbProtected(p, ctx())).toBeNull();
  });

  it("D46: a benign my.factory/gates.json is NOT protected (component-anchored)", () => {
    const p = join(repoRoot, "my.factory-data", "gates.json");
    mkdirSync(join(repoRoot, "my.factory-data"), { recursive: true });
    writeFileSync(p, "{}");
    expect(isTcbProtected(p, ctx())).toBeNull();
  });

  it("Δ W: a non-TCB repo path is NOT protected", () => {
    const p = join(repoRoot, "src", "feature.ts");
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(p, "x");
    expect(isTcbProtected(p, ctx())).toBeNull();
  });

  it("§4: `..` traversal into a workflow resolves to the same deny", () => {
    const sub = join(repoRoot, "src");
    mkdirSync(sub, { recursive: true });
    const wf = join(repoRoot, ".github", "workflows", "quality-gate.yml");
    writeFileSync(wf, "x");
    const traversal = join(sub, "..", ".github", "workflows", "quality-gate.yml");
    expect(isTcbProtected(traversal, ctx())?.rule.category).toBe("ci-workflows");
  });

  it("§4: a symlink escape into the holdout store is denied", () => {
    const holdout = join(dataDir, "runs", "run-1", "holdouts");
    const linkParent = join(repoRoot, "shortcut");
    symlinkSync(holdout, linkParent);
    const viaSymlink = join(linkParent, "answers.json");
    writeFileSync(join(holdout, "answers.json"), "x");
    expect(isTcbProtected(viaSymlink, ctx())?.rule.category).toBe("data-runs");
  });

  it("Δ W: the denylist does NOT consult config — a 'would-be allowlist' cannot unblock", () => {
    // buildTcbRules takes ONLY a path-resolution context; there is structurally
    // no config parameter. Even simulating a config that 'allows' the path has
    // no surface to pass it through — the path stays denied.
    const fakeConfigThatAllowsEverything = { "safety.writeBlockedPaths": [] };
    void fakeConfigThatAllowsEverything; // unused on purpose — no API accepts it
    const wf = join(repoRoot, ".github", "workflows", "quality-gate.yml");
    writeFileSync(wf, "x");
    // @ts-expect-error — buildTcbRules accepts only TcbContext, never a config.
    expect(() => buildTcbRules({ config: fakeConfigThatAllowsEverything })).not.toThrow();
    expect(isTcbProtected(wf, ctx())).not.toBeNull();
  });

  it("§4: the adversarial suite can enumerate the live rule set (TCB_DENY exported)", () => {
    expect(TCB_DENY.length).toBeGreaterThan(0);
    const categories = new Set(buildTcbRules(ctx()).map((r) => r.category));
    // Every protected category is present so a new one is covered automatically.
    expect(categories).toContain("ci-workflows");
    expect(categories).toContain("gate-config");
    expect(categories).toContain("hooks");
    expect(categories).toContain("data-runs");
    expect(categories).toContain("data-specs");
    expect(categories).toContain("data-config");
    expect(categories).toContain("docs-factory");
    expect(categories).toContain("e2e-suite");
    expect(categories).toContain("gate-contract");
  });

  it("canonicalizePath collapses ./ and .. for a non-existent leaf (create case)", () => {
    const p = join(repoRoot, "a", "..", "b.txt");
    // Per contract, the deepest existing ancestor (repoRoot) is realpath-resolved
    // (defeats a symlinked parent — e.g. macOS /tmp → /private/tmp); the
    // non-existent leaf is re-appended. So the expected value realpaths repoRoot too.
    expect(canonicalizePath(p)).toBe(join(realpathSync(repoRoot), "b.txt"));
  });
});
