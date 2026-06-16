/**
 * Prompt G (F-repo) — repo identity resolution for the `factory` CLI.
 *
 * `--repo owner/name` is redundant when the session is already cwd-rooted in the
 * target repo (the CLI resolves the repo from `process.cwd()`). This module makes
 * `--repo` OPTIONAL by deriving the slug from the `origin` remote, and centralizes
 * the explicit-vs-derived policy in ONE chokepoint ({@link resolveRepo}) that every
 * `--repo` consumer (run / spec / scaffold) calls.
 *
 *   - {@link parseRemoteUrl} — pure URL→`owner/name` parser (ssh / https / ssh:// /
 *     git:// forms, ports, credentials, trailing slash, `.git`, nested subgroups).
 *   - {@link validateRepoSlug} — the ONE `owner/name` validator (loud UsageError on
 *     a malformed slug). Replaces the per-call copies in scaffold.ts.
 *   - {@link resolveRepo} — the chokepoint: derive when omitted, MATCH (case-
 *     insensitive on owner/name) when both present, trust an explicit override when
 *     origin is not derivable, and fail LOUD on a real conflict or a dead end.
 */
import { UsageError } from "../shared/usage-error.js";
import type { GitClient } from "./git-client.js";

/**
 * Parse a git remote URL into a canonical `owner/name` slug, or `null` when it does
 * not carry an owner+name pair. Handles the wire forms a real `origin` can take:
 *   - scp-like SSH:  `git@github.com:owner/name(.git)?`
 *   - HTTPS:         `https://[user[:token]@]host[:port]/owner/name(.git)?[/]`
 *   - ssh:// URL:    `ssh://git@host[:port]/owner/name(.git)?`
 *   - git:// URL:    `git://host/owner/name(.git)?`
 * A trailing `.git` is stripped; a nested subgroup path collapses to its LAST two
 * segments (`owner` = the immediate parent of the repo). Pure — no IO.
 */
export function parseRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  // Extract the "path" portion (everything after host[:port]) for each form.
  let path: string | undefined;

  // scp-like SSH: user@host:owner/name  (no scheme, single colon before the path)
  const scp = /^[^/@]+@[^/:]+:(.+)$/.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    path = scp[1];
  } else {
    // URL forms with a scheme (https / ssh / git / http). Strip the scheme, any
    // credentials, and host[:port], leaving the path.
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.+)$/.exec(trimmed);
    if (withScheme) {
      const afterScheme = withScheme[1]!;
      const firstSlash = afterScheme.indexOf("/");
      if (firstSlash >= 0) path = afterScheme.slice(firstSlash + 1);
    }
  }

  if (path === undefined) return null;

  // Normalize: drop a trailing slash, drop a trailing `.git` (any case).
  let p = path.replace(/\/+$/, "");
  p = p.replace(/\.git$/i, "");

  const segments = p.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const name = segments[segments.length - 1]!;
  const owner = segments[segments.length - 2]!;
  if (owner.length === 0 || name.length === 0) return null;
  return `${owner}/${name}`;
}

/**
 * Validate a `owner/name` slug, returning it unchanged. LOUD {@link UsageError} when
 * it is not exactly two non-empty `/`-separated segments. The ONE repo-slug
 * validator (run / spec / scaffold reuse it).
 */
export function validateRepoSlug(slug: string): string {
  const parts = slug.split("/");
  if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) {
    throw new UsageError(`--repo must be '<owner>/<name>', got '${slug}'`);
  }
  return slug;
}

/** Split a validated `owner/name` slug into its parts. */
export function splitRepoSlug(slug: string): { owner: string; repo: string } {
  const parts = validateRepoSlug(slug).split("/");
  return { owner: parts[0]!, repo: parts[1]! };
}

/** Inputs to {@link resolveRepo}. */
export interface ResolveRepoArgs {
  /** An explicit `--repo owner/name` override, when the user passed one. */
  readonly explicit?: string | undefined;
  /** The working dir the git probe runs in (the target repo checkout). */
  readonly cwd: string;
  /** The git seam (real {@link DefaultGitClient} in prod; a fake in tests). */
  readonly gitClient: GitClient;
  /** The remote to derive from (defaults to `origin`). */
  readonly remote?: string;
}

/**
 * Resolve the target repo's `owner/name`, the ONE chokepoint every `--repo`
 * consumer calls. Policy:
 *   - explicit + derivable origin → must MATCH (case-insensitive on owner/name);
 *     a case-only difference is canonicalized to the ORIGIN casing (GitHub
 *     owner/name is case-insensitive and the remote is the authoritative form). A
 *     real conflict throws a LOUD {@link UsageError} naming both values.
 *   - explicit + NOT derivable (no origin / not a git repo) → trust the explicit
 *     value (an override is intentional — do not hard-fail on a missing remote).
 *   - no explicit + derivable → use the derived slug.
 *   - no explicit + NOT derivable → LOUD {@link UsageError}: pass `--repo` or run
 *     from a checkout with an `origin` remote.
 * A malformed explicit slug always fails loud (via {@link validateRepoSlug}).
 */
export async function resolveRepo(args: ResolveRepoArgs): Promise<string> {
  const remote = args.remote ?? "origin";
  const explicit =
    typeof args.explicit === "string" && args.explicit.length > 0
      ? validateRepoSlug(args.explicit)
      : undefined;

  const derived = await deriveRepo(args.gitClient, remote, args.cwd);

  if (explicit !== undefined) {
    if (derived === null) return explicit; // override trusted; origin not derivable
    if (explicit.toLowerCase() === derived.toLowerCase()) return derived; // canonical
    throw new UsageError(
      `--repo '${explicit}' disagrees with the '${remote}' remote ('${derived}'); ` +
        `omit --repo to use the remote, or fix the value`,
    );
  }

  if (derived === null) {
    throw new UsageError(
      `--repo is required: could not derive it from the '${remote}' remote ` +
        `(run from a repo checkout with an '${remote}' remote, or pass --repo <owner/name>)`,
    );
  }
  return derived;
}

/**
 * Best-effort derive `owner/name` from a remote URL. A missing remote / non-git dir
 * (probe returns null) OR an unparseable URL yields `null` — a NORMAL answer the
 * caller branches on, never an exception.
 */
async function deriveRepo(
  gitClient: GitClient,
  remote: string,
  cwd: string,
): Promise<string | null> {
  const url = await gitClient.remoteUrl(remote, { cwd });
  if (url === null) return null;
  return parseRemoteUrl(url);
}
