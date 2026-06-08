/**
 * WS3 — typed GhClient over an injectable {@link GhRunner}.
 *
 * Narrow `gh` surface for idempotent PR create (Δ P), serial merge (Δ L), and the
 * branch-protection probe (#2 / Δ A). Every JSON read goes through
 * {@link parseGhJson}, which FAILS LOUD when `ExecResult.truncated === true`
 * (reusing the frozen exec seam) — a clipped `gh --json` payload must NEVER be
 * silently mis-parsed into a wrong control-flow decision (e.g. "no PR exists" →
 * duplicate create).
 */
import { z } from "zod";
import type { ExecOptions, ExecResult } from "../shared/index.js";
import { createLogger, parseJson } from "../shared/index.js";
import { defaultGhRunner, runOrThrow, type GhRunner } from "./exec-tools.js";

const log = createLogger("gh");

/** A pull request as returned by `gh pr list/view --json`. */
export interface PullRequest {
  number: number;
  headRefName: string;
  baseRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  /** GitHub mergeable status (MERGEABLE | CONFLICTING | UNKNOWN), if requested. */
  mergeable?: string;
  /** Merge-state status (CLEAN | BEHIND | BLOCKED | DIRTY | ...), if requested. */
  mergeStateStatus?: string;
  url?: string;
}

/** Result of {@link GhClient.prCreate}. */
export interface CreatedPr {
  number: number;
  url: string;
}

/** Args for {@link GhClient.issueCreate} (one issue per failed task, Δ S). */
export interface IssueCreateArgs {
  title: string;
  body: string;
  /** Labels to attach (e.g. ["factory", "factory:dropped"]). */
  labels?: string[];
  /**
   * Repo to create the issue in, "owner/name". Passed as `--repo` so the issue
   * can be filed without being inside the repo's worktree (finalize runs from the
   * staging worktree). Omit to use the cwd's repo.
   */
  repo?: string;
}

/** Result of {@link GhClient.issueCreate}. */
export interface CreatedIssue {
  number: number;
  url: string;
}

/** Branch-protection facts as the probe reads them (raw GET shape, narrowed). */
export interface ProtectionApiResult {
  /** Whether a protection record exists at all (404 → false). */
  enabled: boolean;
  /** Required status-check contexts (may be empty). */
  requiredStatusChecks: string[];
  /** `required_status_checks.strict` — branches must be up-to-date before merge. */
  strictUpToDate: boolean;
  /** Whether native GitHub merge-queue is configured for this branch. */
  hasMergeQueue: boolean;
}

/** Args for {@link GhClient.prList}. */
export interface PrListArgs {
  head: string;
  base?: string;
  state?: "open" | "closed" | "merged" | "all";
}

/** Args for {@link GhClient.prCreate}. */
export interface PrCreateArgs {
  base: string;
  head: string;
  title: string;
  body: string;
}

/** Options for {@link GhClient.prMergeSquash}. */
export interface PrMergeOptions {
  deleteBranch?: boolean;
  /** Enqueue via merge-queue/auto rather than merge now (probe-detected upgrade). */
  auto?: boolean;
  /**
   * Override the squash-merge commit subject. The rollup uses this for the
   * `PARTIAL:` header on an incomplete run (Δ S) so the develop history records
   * that the rollup shipped a subset.
   */
  subject?: string;
  /** Override the squash-merge commit body. */
  body?: string;
}

/** Per-call gh options. */
export interface GhOpts {
  cwd?: string;
}

/** The typed `gh` surface WS3 depends on. */
export interface GhClient {
  /** `gh pr list --head <head> [--base] [--state] --json ...` (Δ P lookup). */
  prList(args: PrListArgs, opts?: GhOpts): Promise<PullRequest[]>;
  /** `gh pr create ...` → {number, url}. */
  prCreate(args: PrCreateArgs, opts?: GhOpts): Promise<CreatedPr>;
  /** `gh issue create --title --body [--label ...] [--repo ...]` → {number, url} (Δ S). */
  issueCreate(args: IssueCreateArgs, opts?: GhOpts): Promise<CreatedIssue>;
  /** `gh pr view <number> --json <fields>`. */
  prView(number: number, fields: readonly string[], opts?: GhOpts): Promise<PullRequest>;
  /** `gh pr merge <number> --squash [--auto] [--delete-branch]` (Δ L action). */
  prMergeSquash(number: number, opts?: PrMergeOptions & GhOpts): Promise<void>;
  /** GET branch-protection via `gh api` (probe; 404 → not enabled). */
  repoProtection(
    owner: string,
    repo: string,
    branch: string,
    opts?: GhOpts,
  ): Promise<ProtectionApiResult>;
  /** PUT branch-protection via `gh api` (--provision ONLY). */
  putProtection(
    owner: string,
    repo: string,
    branch: string,
    body: ProtectionPutBody,
    opts?: GhOpts,
  ): Promise<void>;
  /** Detect whether native GitHub merge-queue is available for this branch. */
  mergeQueueProbe(owner: string, repo: string, branch: string, opts?: GhOpts): Promise<boolean>;
}

/** Body for a branch-protection PUT (the subset WS3 sets). */
export interface ProtectionPutBody {
  requiredStatusChecks: string[];
  strict: boolean;
}

// ---------------------------------------------------------------------------
// Zod shapes for the gh JSON payloads (LOUD on a wrong shape).
// ---------------------------------------------------------------------------

const PullRequestSchema = z.object({
  number: z.number().int(),
  headRefName: z.string(),
  baseRefName: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergeable: z.string().optional(),
  mergeStateStatus: z.string().optional(),
  url: z.string().optional(),
});

/**
 * Parse a `gh --json` payload, FAILING LOUD on truncation. A clipped payload is
 * never parsed: a half-read JSON array would either throw a confusing JSON error
 * or — worse — parse to a wrong-but-valid prefix and drive a bad decision.
 */
export function parseGhJson<T>(result: ExecResult, schema: z.ZodType<T>, where: string): T {
  if (result.truncated) {
    throw new Error(
      `gh: output of '${where}' was TRUNCATED (hit maxBuffer) — refusing to parse a clipped JSON payload`,
    );
  }
  const raw = parseJson<unknown>(result.stdout, where);
  return schema.parse(raw);
}

/** Default GhClient over the real (or an injected) gh runner. */
export class DefaultGhClient implements GhClient {
  private readonly runner: GhRunner;

  constructor(runner: GhRunner = defaultGhRunner) {
    this.runner = runner;
  }

  private execOpts(opts?: GhOpts): ExecOptions {
    return opts?.cwd ? { cwd: opts.cwd } : {};
  }

  async prList(args: PrListArgs, opts?: GhOpts): Promise<PullRequest[]> {
    const argv = [
      "pr",
      "list",
      "--head",
      args.head,
      "--state",
      args.state ?? "open",
      "--json",
      "number,headRefName,baseRefName,state,mergeable,mergeStateStatus,url",
    ];
    if (args.base) argv.push("--base", args.base);
    const r = await runOrThrow("gh", this.runner, argv, this.execOpts(opts));
    return parseGhJson(r, z.array(PullRequestSchema), "gh pr list");
  }

  async prCreate(args: PrCreateArgs, opts?: GhOpts): Promise<CreatedPr> {
    // `gh pr create` prints the PR URL to stdout. Use --json on view afterwards
    // would need a number; instead create then parse the URL it emits.
    const r = await runOrThrow(
      "gh",
      this.runner,
      [
        "pr",
        "create",
        "--base",
        args.base,
        "--head",
        args.head,
        "--title",
        args.title,
        "--body",
        args.body,
      ],
      this.execOpts(opts),
    );
    if (r.truncated) {
      throw new Error("gh pr create: output truncated — cannot trust the emitted PR URL");
    }
    const url = r.stdout.trim().split(/\s+/).pop() ?? "";
    const m = url.match(/\/pull\/(\d+)\s*$/);
    if (!m) {
      throw new Error(`gh pr create: could not parse PR number from output: ${r.stdout.trim()}`);
    }
    return { number: Number(m[1]), url };
  }

  async issueCreate(args: IssueCreateArgs, opts?: GhOpts): Promise<CreatedIssue> {
    const argv = ["issue", "create", "--title", args.title, "--body", args.body];
    if (args.repo) argv.push("--repo", args.repo);
    for (const label of args.labels ?? []) argv.push("--label", label);
    const r = await runOrThrow("gh", this.runner, argv, this.execOpts(opts));
    if (r.truncated) {
      throw new Error("gh issue create: output truncated — cannot trust the emitted issue URL");
    }
    const url = r.stdout.trim().split(/\s+/).pop() ?? "";
    const m = url.match(/\/issues\/(\d+)\s*$/);
    if (!m) {
      throw new Error(
        `gh issue create: could not parse issue number from output: ${r.stdout.trim()}`,
      );
    }
    return { number: Number(m[1]), url };
  }

  async prView(number: number, fields: readonly string[], opts?: GhOpts): Promise<PullRequest> {
    const r = await runOrThrow(
      "gh",
      this.runner,
      ["pr", "view", String(number), "--json", fields.join(",")],
      this.execOpts(opts),
    );
    return parseGhJson(r, PullRequestSchema, "gh pr view");
  }

  async prMergeSquash(number: number, opts?: PrMergeOptions & GhOpts): Promise<void> {
    const argv = ["pr", "merge", String(number), "--squash"];
    if (opts?.auto) argv.push("--auto");
    if (opts?.deleteBranch) argv.push("--delete-branch");
    if (opts?.subject !== undefined) argv.push("--subject", opts.subject);
    if (opts?.body !== undefined) argv.push("--body", opts.body);
    await runOrThrow("gh", this.runner, argv, this.execOpts(opts));
  }

  async repoProtection(
    owner: string,
    repo: string,
    branch: string,
    opts?: GhOpts,
  ): Promise<ProtectionApiResult> {
    const path = `repos/${owner}/${repo}/branches/${branch}/protection`;
    const r = await this.runner(["api", path], this.execOpts(opts));
    // A 404 (no protection) is the ANSWER, not an error: gh exits non-zero. Only
    // a real failure (auth, network) should throw — distinguish by stderr.
    if (r.code !== 0) {
      if (/404|Not Found|Branch not protected/i.test(r.stderr)) {
        return {
          enabled: false,
          requiredStatusChecks: [],
          strictUpToDate: false,
          hasMergeQueue: false,
        };
      }
      throw new Error(`gh api ${path} failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`);
    }
    if (r.truncated) {
      throw new Error(
        `gh api ${path}: output truncated — refusing to parse clipped protection JSON`,
      );
    }
    const raw = parseJson<{
      required_status_checks?: { strict?: boolean; contexts?: string[] } | null;
    }>(r.stdout, path);
    const rsc = raw.required_status_checks ?? null;
    const mq = await this.mergeQueueProbe(owner, repo, branch, opts);
    return {
      enabled: true,
      requiredStatusChecks: rsc?.contexts ?? [],
      strictUpToDate: rsc?.strict === true,
      hasMergeQueue: mq,
    };
  }

  async putProtection(
    owner: string,
    repo: string,
    branch: string,
    body: ProtectionPutBody,
    opts?: GhOpts,
  ): Promise<void> {
    const path = `repos/${owner}/${repo}/branches/${branch}/protection`;
    const payload = JSON.stringify({
      required_status_checks: {
        strict: body.strict,
        contexts: body.requiredStatusChecks,
      },
      enforce_admins: true,
      required_pull_request_reviews: null,
      restrictions: null,
    });
    log.info(`provisioning branch protection for ${owner}/${repo}@${branch}`);
    await runOrThrow("gh", this.runner, ["api", "--method", "PUT", path, "--input", "-"], {
      ...this.execOpts(opts),
      input: payload,
    });
  }

  async mergeQueueProbe(
    owner: string,
    repo: string,
    branch: string,
    opts?: GhOpts,
  ): Promise<boolean> {
    // Detect a native merge-queue rule via the branch rulesets API. A missing
    // rule (or any non-zero / 404) means "no merge queue" — the app-level serial
    // path is used instead. We never throw here: absence is a normal answer.
    const path = `repos/${owner}/${repo}/rules/branches/${branch}`;
    const r = await this.runner(["api", path], this.execOpts(opts));
    if (r.code !== 0 || r.truncated) return false;
    try {
      const rules = parseJson<Array<{ type?: string }>>(r.stdout, path);
      return Array.isArray(rules) && rules.some((rule) => rule.type === "merge_queue");
    } catch {
      return false;
    }
  }
}
