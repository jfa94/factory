/**
 * WS5 — durable spec store (Δ X / #6).
 *
 * The CANONICAL spec lives at `<dataDir>/specs/<repo-key>/<spec-id>/{spec.md,
 * tasks.json}` (out-of-repo, Decision 5) and is REUSED across runs: a rerun
 * resolves an existing spec by the STABLE PRD issue number (the first segment of
 * `spec_id = "<issue>-<slug>"`) and picks it up rather than regenerating. A run
 * records only a {@link SpecPointer}, never the spec body. ALL reads
 * ({@link SpecStore.read} / {@link SpecStore.resolveByIssue}) resolve from the
 * dataDir store — the canonical read-path never touches the in-repo copy.
 *
 * F-specloc — the in-repo reviewable copy. On {@link SpecStore.write}, the store
 * ALSO mirrors `spec.md` + `tasks.json` into the TARGET REPO's
 * `<docsRoot>/factory/<spec-id>/` (versioned, PR-reviewable). The sidecar
 * (`spec.meta.json`, a dataDir reconstruction detail) is deliberately NOT copied.
 * The mirror is executor-immutable: the TCB write-deny covers `docs/factory/**`
 * (`src/hooks/tcb.ts`) so an executor cannot weaken its own acceptance criteria
 * via the in-repo copy. `docsRoot` defaults to `<cwd>/docs` — the factory CLI is
 * cwd-rooted in the target repo — but is injectable for tests.
 *
 * All paths go through the frozen `paths.ts` (traversal-safe `specDir` /
 * `specsRoot` / `repoKey` / `docsFactoryDir`); this module never hand-joins a
 * path segment. Writes go through the atomic-write seam.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../shared/atomic-write.js";
import { parseJson, stringifyJson } from "../shared/json.js";
import { slugify, validateId } from "../shared/ids.js";
import { createLogger } from "../shared/logging.js";
import { resolveDataDir, type DataDirOptions } from "../config/index.js";
import { specDir, specsRoot, repoKey, docsFactoryDir } from "../core/state/paths.js";
import type { SpecPointer } from "../types/index.js";
import { parseSpecManifest, parseSpecTasks, type SpecManifest } from "./schema.js";

const log = createLogger("spec:store");

const SPEC_MD_FILE = "spec.md";
const TASKS_FILE = "tasks.json";

/**
 * Construct a `spec_id` from the (stable) issue number + a human slug.
 * `makeSpecId(123, "Checkout Redesign") === "123-checkout-redesign"`.
 * The issue number is the rerun lookup key; the slug is derived once at creation
 * and is never re-derived on a rerun (resolveByIssue wins).
 */
export function makeSpecId(issueNumber: number, slug: string): string {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`makeSpecId: issue number must be a positive integer, got ${issueNumber}`);
  }
  const safeSlug = slugify(slug);
  if (safeSlug.length === 0) {
    throw new Error(`makeSpecId: slug '${slug}' has no usable characters`);
  }
  const specId = `${issueNumber}-${safeSlug}`;
  // Validate the final id charset (defense in depth; also catches an oversized
  // composite that would later be rejected by specDir()).
  validateId(specId, "spec-id");
  return specId;
}

/** Extract the leading issue number from a `spec_id`, or null if it has none. */
function issueOf(specId: string): number | null {
  const m = /^(\d+)-/.exec(specId);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Options for {@link SpecStore}: the dataDir seam plus the in-repo docs root. */
export interface SpecStoreOptions extends DataDirOptions {
  /**
   * The TARGET REPO's `docs/` dir for the in-repo reviewable spec copy
   * (F-specloc). Defaults to `<cwd>/docs` — the factory CLI runs cwd-rooted in
   * the target repo, so this lands the mirror in the repo under review. Injected
   * in tests so they never depend on the real cwd.
   */
  readonly docsRoot?: string;
}

/** The durable spec store. */
export class SpecStore {
  private readonly dataDir: string;
  private readonly docsRoot: string;

  constructor(opts: SpecStoreOptions = {}) {
    this.dataDir = resolveDataDir(opts);
    this.docsRoot = opts.docsRoot ?? join(process.cwd(), "docs");
  }

  /**
   * Resolve an existing spec for `(repo, issueNumber)` — Δ X reuse. Scans the
   * repo's spec dir for a `spec_id` starting with `<issue>-` and returns its
   * parsed manifest, else null. The issue number (not the slug) is the lookup
   * key, so a rerun reuses the spec even if the slug would differ on regen.
   *
   * @throws if a matching dir exists but its manifest/tasks are unreadable or
   *         invalid (a corrupt durable spec is loud, never silently a miss).
   */
  async resolveByIssue(repo: string, issueNumber: number): Promise<SpecManifest | null> {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error(
        `resolveByIssue: issue number must be a positive integer, got ${issueNumber}`,
      );
    }
    const repoRoot = join(specsRoot(this.dataDir), repoKey(repo));

    let entries: string[];
    try {
      entries = await readdir(repoRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    const prefix = `${issueNumber}-`;
    const matches = entries.filter((e) => issueOf(e) === issueNumber && e.startsWith(prefix));
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      // Two dirs for the same stable issue key is a store-integrity defect (Δ X
      // says one spec per issue). Fail loud rather than arbitrarily pick one.
      throw new Error(
        `resolveByIssue: multiple specs for issue #${issueNumber} in ${repo}: ${matches.join(", ")}`,
      );
    }

    const specId = matches[0]!;
    return this.read(repo, specId);
  }

  /** Read + validate the manifest for a known `(repo, spec_id)`. */
  async read(repo: string, specId: string): Promise<SpecManifest> {
    const dir = specDir(this.dataDir, repo, specId);
    const tasksRaw = await readFile(join(dir, TASKS_FILE), "utf8");
    const tasks = parseSpecTasks(parseJson<unknown>(tasksRaw, join(dir, TASKS_FILE)));

    // The manifest header is reconstructed from the durable on-disk facts: the
    // tasks.json is the bare task array (the canonical consumer contract), and
    // the header fields are intrinsic to the dir identity. This keeps tasks.json
    // a single source of truth rather than duplicating tasks in a separate file.
    const meta = await this.readMeta(dir);
    return parseSpecManifest({
      spec_id: specId,
      issue_number: issueOf(specId) ?? meta.issue_number,
      slug: specId.replace(/^\d+-/, ""),
      repo,
      generated_at: meta.generated_at,
      tasks,
    });
  }

  /**
   * Durably write a spec: `spec.md` + the bare `tasks.json` array. The manifest
   * header is persisted as a sidecar so {@link read} can reconstruct
   * `generated_at` without re-running the generator.
   *
   * F-specloc — also mirrors `spec.md` + the bare `tasks.json` into the in-repo
   * reviewable copy (`<docsRoot>/factory/<spec-id>/`). The mirror is a strict
   * subset (no `spec.meta.json` sidecar): the sidecar is a dataDir reconstruction
   * detail, and the canonical read-path never consults the mirror. Reruns still
   * resolve by issue number against the dataDir store (unchanged).
   */
  async write(manifest: SpecManifest, specMd: string): Promise<SpecPointer> {
    const parsed = parseSpecManifest(manifest);
    const dir = specDir(this.dataDir, parsed.repo, parsed.spec_id);
    const tasksJson = stringifyJson(parsed.tasks);

    await atomicWriteFile(join(dir, SPEC_MD_FILE), specMd);
    // tasks.json is the BARE array — the canonical consumer contract.
    await atomicWriteFile(join(dir, TASKS_FILE), tasksJson);
    await atomicWriteFile(
      join(dir, META_FILE),
      stringifyJson({
        issue_number: parsed.issue_number,
        slug: parsed.slug,
        repo: parsed.repo,
        generated_at: parsed.generated_at,
      }),
    );

    // In-repo reviewable copy (F-specloc): spec.md + bare tasks.json only. This
    // is a PR-reviewable MIRROR, not the canonical source; reads never use it.
    //
    // Written to the WORKING TREE but intentionally NOT auto-committed: the
    // engine cannot safely commit it onto `staging`, because `ensureStaging`
    // (src/git/staging.ts) reconciles staging via `git checkout -B staging
    // origin/<base>` — a destructive reset that would silently discard any
    // engine-side staging commit ("looks committed but isn't"). Genuine
    // PR-inclusion needs a dedicated spec-ship path (spec branch → PR into
    // staging); that is net-new run-level orchestration and is DEFERRED.
    //
    // Best-effort-but-loud: the mirror is a reviewability convenience, NOT the
    // source of truth. The canonical spec above is already durably persisted, so
    // a mirror-write failure (read-only docs/, non-writable cwd, bad perms) must
    // NOT abort the store. We warn (degraded reviewability surfaced on stderr)
    // and continue; we never rethrow.
    const reviewDir = docsFactoryDir(this.docsRoot, parsed.spec_id);
    let mirrored = true;
    try {
      await atomicWriteFile(join(reviewDir, SPEC_MD_FILE), specMd);
      await atomicWriteFile(join(reviewDir, TASKS_FILE), tasksJson);
    } catch (err) {
      mirrored = false;
      log.warn(
        `could not write reviewable copy to ${reviewDir} ` +
          `(${err instanceof Error ? err.message : String(err)}) — the canonical ` +
          `spec at ${dir} is unaffected; run continues`,
      );
    }

    log.info(
      `wrote spec ${parsed.spec_id} (${parsed.tasks.length} tasks) to ${dir} ` +
        (mirrored ? `(reviewable copy: ${reviewDir})` : `(reviewable copy SKIPPED — see warning)`),
    );
    return this.toPointer(parsed);
  }

  /** Build the run-facing {@link SpecPointer} from a manifest. */
  toPointer(manifest: SpecManifest): SpecPointer {
    return {
      repo: manifest.repo,
      spec_id: manifest.spec_id,
      issue_number: manifest.issue_number,
    };
  }

  private async readMeta(dir: string): Promise<{ issue_number: number; generated_at: string }> {
    const raw = await readFile(join(dir, META_FILE), "utf8");
    const meta = parseJson<{ issue_number?: unknown; generated_at?: unknown }>(
      raw,
      join(dir, META_FILE),
    );
    const issueNumber = typeof meta.issue_number === "number" ? meta.issue_number : 0;
    const generatedAt = typeof meta.generated_at === "string" ? meta.generated_at : "";
    if (generatedAt.length === 0) {
      throw new Error(`spec meta at ${dir} is missing generated_at`);
    }
    return { issue_number: issueNumber, generated_at: generatedAt };
  }
}

const META_FILE = "spec.meta.json";
