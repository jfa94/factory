/**
 * Prompt G (F-repo) — the git-remote → `owner/name` parser + the centralized
 * `resolveRepo` chokepoint every `--repo` consumer (run/spec/scaffold) calls.
 *
 * `parseRemoteUrl` is a pure URL→slug parser exercised across the wire forms a
 * real `origin` remote can take (ssh, https, ssh://, ports, trailing slash,
 * `.git`, nested subgroups). `resolveRepo` is the explicit-vs-derived policy:
 * derive when omitted, MATCH (case-insensitive) when both are present, trust an
 * explicit override when origin is not derivable, and fail LOUD on a real
 * conflict or a no-explicit/no-origin dead end.
 */
import {describe, it, expect} from 'vitest'
import {parseRemoteUrl, resolveRepo, validateRepoSlug} from './repo.js'
import {FakeGitClient} from './fakes.js'
import {isUsageError} from '../shared/usage-error.js'

describe('parseRemoteUrl', () => {
    it('parses the scp-like SSH form, stripping .git', () => {
        expect(parseRemoteUrl('git@github.com:acme/widgets.git')).toBe('acme/widgets')
    })

    it('parses the scp-like SSH form without a .git suffix', () => {
        expect(parseRemoteUrl('git@github.com:acme/widgets')).toBe('acme/widgets')
    })

    it('parses the HTTPS form, stripping .git', () => {
        expect(parseRemoteUrl('https://github.com/acme/widgets.git')).toBe('acme/widgets')
    })

    it('parses the HTTPS form without a .git suffix and a trailing slash', () => {
        expect(parseRemoteUrl('https://github.com/acme/widgets/')).toBe('acme/widgets')
    })

    it('parses an HTTPS URL carrying credentials and a port', () => {
        expect(parseRemoteUrl('https://user:token@github.com:443/acme/widgets.git')).toBe('acme/widgets')
    })

    it('parses the ssh:// URL form (with a port)', () => {
        expect(parseRemoteUrl('ssh://git@github.com:22/acme/widgets.git')).toBe('acme/widgets')
    })

    it('parses the git:// protocol form', () => {
        expect(parseRemoteUrl('git://github.com/acme/widgets.git')).toBe('acme/widgets')
    })

    it('collapses a nested subgroup path to the LAST two segments (owner/name)', () => {
        // GitLab-style group/subgroup/project → owner = the immediate parent group.
        expect(parseRemoteUrl('https://gitlab.com/group/subgroup/widgets.git')).toBe('subgroup/widgets')
        expect(parseRemoteUrl('git@gitlab.com:group/subgroup/widgets.git')).toBe('subgroup/widgets')
    })

    it('tolerates trailing whitespace/newline (git CLI output)', () => {
        expect(parseRemoteUrl('git@github.com:acme/widgets.git\n')).toBe('acme/widgets')
    })

    it('strips a trailing .git suffix case-insensitively', () => {
        expect(parseRemoteUrl('https://github.com/acme/widgets.GIT')).toBe('acme/widgets')
    })

    it('returns null for an unparseable / single-segment URL', () => {
        expect(parseRemoteUrl('')).toBeNull()
        expect(parseRemoteUrl('not-a-url')).toBeNull()
        expect(parseRemoteUrl('https://github.com/onlyowner')).toBeNull()
        expect(parseRemoteUrl('git@github.com:onlyowner.git')).toBeNull()
    })
})

describe('validateRepoSlug', () => {
    it('returns the canonical owner/name for a well-formed slug', () => {
        expect(validateRepoSlug('acme/widgets')).toBe('acme/widgets')
    })

    it('accepts the full legal charset (dots, underscores, hyphens)', () => {
        for (const ok of ['owner.name/repo.js', 'a-b_c/d', 'My.Repo/Some_Thing-1', '..foo/bar..']) {
            expect(validateRepoSlug(ok)).toBe(ok)
        }
    })

    it('throws a UsageError for a slug without exactly one slash', () => {
        for (const bad of ['no-slash', 'a/b/c', '/widgets', 'acme/', '']) {
            try {
                validateRepoSlug(bad)
                throw new Error(`expected validateRepoSlug(${JSON.stringify(bad)}) to throw`)
            } catch (err) {
                expect(isUsageError(err)).toBe(true)
                expect((err as Error).message).toMatch(/owner.*name/i)
            }
        }
    })

    it('rejects path-traversal and out-of-charset segments (security boundary)', () => {
        // `.`/`..` segments (traversal tokens), embedded slashes via encoding, spaces,
        // shell/URL metacharacters — all must fail loud before reaching a gh REST path.
        for (const bad of [
            '../etc',
            'owner/..',
            './x',
            'owner/.',
            'a b/c',
            'acme/wid gets',
            'acme/widgets;rm',
            'acme/wid?gets',
            'acme/wid#gets',
            'acme/wid@gets',
            'acme/wid:gets',
            'acme/wid%2egets',
            'acme/wid\\gets',
        ]) {
            try {
                validateRepoSlug(bad)
                throw new Error(`expected validateRepoSlug(${JSON.stringify(bad)}) to throw`)
            } catch (err) {
                expect(isUsageError(err)).toBe(true)
                expect((err as Error).message).toMatch(/owner.*name/i)
            }
        }
    })
})

describe('resolveRepo', () => {
    /** A fake whose `origin` remote-url resolves to the given slug (or no remote). */
    function gitWithOrigin(slug: string | null): FakeGitClient {
        const git = new FakeGitClient()
        if (slug !== null) {
            git.setRemoteUrl('origin', `git@github.com:${slug}.git`)
        }
        return git
    }

    it('no explicit + derivable origin → uses the derived slug', async () => {
        const repo = await resolveRepo({cwd: '/repo', gitClient: gitWithOrigin('acme/widgets')})
        expect(repo).toBe('acme/widgets')
    })

    it('explicit + derivable origin that MATCHES → uses the (canonical) explicit slug', async () => {
        const repo = await resolveRepo({
            explicit: 'acme/widgets',
            cwd: '/repo',
            gitClient: gitWithOrigin('acme/widgets'),
        })
        expect(repo).toBe('acme/widgets')
    })

    it('explicit that matches the origin case-INSENSITIVELY → accepted, CANONICALIZED to the origin casing', async () => {
        // The origin remote is the authoritative canonical casing (GitHub owner/name
        // is case-insensitive); a case-only difference is not a conflict, and we pin to
        // the canonical form so the on-disk repo key is stable regardless of typing.
        const repo = await resolveRepo({
            explicit: 'Acme/Widgets',
            cwd: '/repo',
            gitClient: gitWithOrigin('acme/widgets'),
        })
        expect(repo).toBe('acme/widgets')
    })

    it('explicit that DISAGREES with the origin remote → fails LOUD naming both', async () => {
        try {
            await resolveRepo({
                explicit: 'acme/other',
                cwd: '/repo',
                gitClient: gitWithOrigin('acme/widgets'),
            })
            throw new Error('expected resolveRepo to throw on a mismatch')
        } catch (err) {
            expect(isUsageError(err)).toBe(true)
            const msg = (err as Error).message
            expect(msg).toContain('acme/other')
            expect(msg).toContain('acme/widgets')
        }
    })

    it('explicit + NO derivable origin → TRUSTS the explicit override (no hard-fail)', async () => {
        const repo = await resolveRepo({
            explicit: 'acme/widgets',
            cwd: '/repo',
            gitClient: gitWithOrigin(null),
        })
        expect(repo).toBe('acme/widgets')
    })

    it('no explicit + NO derivable origin → fails LOUD telling the user to pass --repo', async () => {
        try {
            await resolveRepo({cwd: '/repo', gitClient: gitWithOrigin(null)})
            throw new Error('expected resolveRepo to throw with no explicit + no origin')
        } catch (err) {
            expect(isUsageError(err)).toBe(true)
            expect((err as Error).message).toMatch(/--repo/)
        }
    })

    it('a malformed explicit slug fails LOUD even when origin is absent', async () => {
        await expect(resolveRepo({explicit: 'no-slash', cwd: '/repo', gitClient: gitWithOrigin(null)})).rejects.toThrow(
            /owner.*name/i
        )
    })

    it('no explicit + a DERIVED slug with a path-traversal/illegal segment → fails LOUD (security gate)', async () => {
        // A malicious/typo'd origin must not inject `..` (or metacharacters) into the
        // gh REST paths via the now-common auto-derive path. parseRemoteUrl yields the
        // slug; resolveRepo must hold it to the same charset as an explicit --repo.
        for (const badUrl of [
            'git@github.com:owner/..', // → "owner/.." (path traversal)
            'git@github.com:te st/re po', // → spaces
            'git@github.com:owner/re;po', // → shell metacharacter
        ]) {
            const git = new FakeGitClient()
            git.setRemoteUrl('origin', badUrl)
            await expect(resolveRepo({cwd: '/repo', gitClient: git})).rejects.toThrow(/owner.*name/i)
        }
    })

    it('a remote-url probe that throws (not-a-git-repo) is treated as not-derivable', async () => {
        const git = new FakeGitClient()
        git.failRemoteUrl = true // simulate `git remote get-url` exiting non-zero
        // explicit present → trusted; no explicit → loud.
        await expect(resolveRepo({explicit: 'acme/widgets', cwd: '/x', gitClient: git})).resolves.toBe('acme/widgets')
        await expect(resolveRepo({cwd: '/x', gitClient: git})).rejects.toThrow(/--repo/)
    })
})
