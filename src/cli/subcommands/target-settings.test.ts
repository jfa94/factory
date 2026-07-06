/**
 * Tests for the E1 (F-perm) target-repo `.claude/settings.json` emit + merge.
 *
 * `ensureTargetSettings` writes (or idempotently MERGES into) the TARGET repo's
 * `.claude/settings.json` so an interactive `/factory:run` stops prompting per
 * call. The invariants under test:
 *   - emit: a fresh repo gets the base allow-list + the BAKED data-dir rules
 *     (CLI-resolved canonical dir; tilde form for the allow globs, ABSOLUTE for
 *     additionalDirectories — `~/` does not expand there) + worktree.baseRef:"head".
 *   - NO literal `${CLAUDE_PLUGIN_DATA}` placeholder is ever emitted (it does not
 *     resolve — env-var interpolation is undocumented and the var is hijackable).
 *   - NO statusLine (would clobber the user's own statusline — E2 territory).
 *   - merge: an existing settings.json keeps the user's other keys; the allow-list
 *     is UNIONed (no duplicates); worktree.baseRef is set.
 *   - MIGRATION: a repo scaffolded by the OLD emitter carries stale literal
 *     `${CLAUDE_PLUGIN_DATA}` rules — the merge strips them and bakes the resolved
 *     dir in their place (and reports changed).
 *   - idempotent: re-running reports "present", makes no further change.
 */
import {mkdtemp, rm, readFile, writeFile, mkdir} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {
    FACTORY_TARGET_BASE_ALLOWLIST,
    buildTargetDataDirRules,
    mergeTargetSettings,
    ensureTargetSettings,
    type TargetDataDirRules,
} from './target-settings.js'

// A data dir UNDER $HOME → the baked rules use the git-safe tilde form. This is
// the canonical shape `resolveDataDir()` produces (corrects the env-var leak).
const HOME = '/Users/jo'
const DATA_DIR = '/Users/jo/.claude/plugins/data/factory-jfa94'
const TILDE_BASE = '~/.claude/plugins/data/factory-jfa94'
const RULES: TargetDataDirRules = buildTargetDataDirRules({dataDir: DATA_DIR, home: HOME})

const BAKED_ALLOW = [`Read(${TILDE_BASE}/**)`, `Write(${TILDE_BASE}/**)`, `Edit(${TILDE_BASE}/**)`]

// The stale literal-placeholder strings the OLD emitter wrote (migration targets).
const STALE_ALLOW = [
    'Read(${CLAUDE_PLUGIN_DATA}/**)',
    'Write(${CLAUDE_PLUGIN_DATA}/**)',
    'Edit(${CLAUDE_PLUGIN_DATA}/**)',
]
const STALE_ADDITIONAL = '${CLAUDE_PLUGIN_DATA}'

let root: string

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'factory-target-settings-'))
})

afterEach(async () => {
    await rm(root, {recursive: true, force: true})
})

const settingsPath = (): string => join(root, '.claude', 'settings.json')

async function readSettings(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(settingsPath(), 'utf8')) as Record<string, unknown>
}

describe('FACTORY_TARGET_BASE_ALLOWLIST', () => {
    it('covers the factory CLI, git/gh, and the agent tools', () => {
        // The pipeline shells `factory <subcommand>` and runs git/gh; reviewers and
        // producers use the agent tools.
        expect(FACTORY_TARGET_BASE_ALLOWLIST).toContain('Bash(factory:*)')
        expect(FACTORY_TARGET_BASE_ALLOWLIST).toContain('Bash(git:*)')
        expect(FACTORY_TARGET_BASE_ALLOWLIST).toContain('Bash(gh:*)')
        expect(FACTORY_TARGET_BASE_ALLOWLIST).toContain('Agent')
        expect(FACTORY_TARGET_BASE_ALLOWLIST).toContain('Read')
        expect(FACTORY_TARGET_BASE_ALLOWLIST).toContain('Write')
        expect(FACTORY_TARGET_BASE_ALLOWLIST).toContain('Edit')
        expect(FACTORY_TARGET_BASE_ALLOWLIST).toContain('Grep')
        expect(FACTORY_TARGET_BASE_ALLOWLIST).toContain('Glob')
    })

    it('carries NO data-dir-scoped rule (those are baked per-install, not constant)', () => {
        // The data-dir globs must come from buildTargetDataDirRules, never a literal
        // placeholder hard-coded into the base list.
        for (const entry of FACTORY_TARGET_BASE_ALLOWLIST) {
            expect(entry).not.toContain('${CLAUDE_PLUGIN_DATA}')
            expect(entry).not.toContain('/**')
        }
    })

    it("does NOT carry a statusLine — that would override the user's own", () => {
        for (const entry of FACTORY_TARGET_BASE_ALLOWLIST) {
            expect(entry.toLowerCase()).not.toContain('statusline')
        }
    })

    it('has no duplicate entries', () => {
        expect(new Set(FACTORY_TARGET_BASE_ALLOWLIST).size).toBe(FACTORY_TARGET_BASE_ALLOWLIST.length)
    })
})

describe('buildTargetDataDirRules', () => {
    it('uses the git-safe tilde form for the allow globs when the data dir is under $HOME', () => {
        expect(RULES.allowGlobBase).toBe(TILDE_BASE)
    })

    it('ALWAYS bakes additionalDir absolute — ~/ does not expand in additionalDirectories', () => {
        // Verified live: the tilde form left the working-directory-boundary prompt
        // firing on out-of-tree task-worktree writes (run-20260630-095544).
        expect(RULES.additionalDir).toBe(DATA_DIR)
        // The old tilde entry is surfaced as stale so the merge migrates it away.
        expect(RULES.staleAdditionalDirs).toEqual([TILDE_BASE])
    })

    it('falls back to the absolute path when the data dir is OUTSIDE $HOME', () => {
        const abs = buildTargetDataDirRules({dataDir: '/var/lib/factory-x', home: HOME})
        expect(abs.allowGlobBase).toBe('/var/lib/factory-x')
        expect(abs.additionalDir).toBe('/var/lib/factory-x')
        expect(abs.staleAdditionalDirs).toEqual([]) // tilde form never existed → nothing stale
    })
})

describe('mergeTargetSettings', () => {
    it('from empty: sets baseRef:head + base allow-list + baked data-dir rules, no statusLine', () => {
        const {settings, changed} = mergeTargetSettings({}, RULES)
        expect(changed).toBe(true)
        expect((settings.worktree as {baseRef?: string}).baseRef).toBe('head')
        const allow = (settings.permissions as {allow: string[]}).allow
        for (const e of FACTORY_TARGET_BASE_ALLOWLIST) {
            expect(allow).toContain(e)
        }
        for (const e of BAKED_ALLOW) {
            expect(allow).toContain(e)
        }
        expect(settings).not.toHaveProperty('statusLine')
    })

    it('NEVER emits the literal ${CLAUDE_PLUGIN_DATA} placeholder', () => {
        const {settings} = mergeTargetSettings({}, RULES)
        const serialized = JSON.stringify(settings)
        expect(serialized).not.toContain('${CLAUDE_PLUGIN_DATA}')
    })

    it("unions the allow-list without clobbering the user's other keys", () => {
        const existing = {
            env: {MY_VAR: '1'},
            permissions: {allow: ['Bash(docker:*)'], deny: ['Bash(rm -rf /)']},
            worktree: {baseRef: 'fresh', other: 'keep-me'},
            statusLine: {type: 'command', command: 'my-own-statusline'},
        }
        const {settings} = mergeTargetSettings(existing, RULES)

        // User keys preserved.
        expect(settings.env).toEqual({MY_VAR: '1'})
        const perms = settings.permissions as {allow: string[]; deny: string[]}
        expect(perms.allow).toContain('Bash(docker:*)') // user's entry kept
        expect(perms.allow).toContain('Bash(factory:*)') // factory entry added
        expect(perms.allow).toContain(`Read(${TILDE_BASE}/**)`) // baked data-dir rule added
        expect(perms.deny).toEqual(['Bash(rm -rf /)']) // deny untouched
        // worktree.baseRef forced to head, sibling keys preserved.
        const wt = settings.worktree as {baseRef: string; other: string}
        expect(wt.baseRef).toBe('head')
        expect(wt.other).toBe('keep-me')
        // The user's OWN statusLine is never touched by E1.
        expect(settings.statusLine).toEqual({type: 'command', command: 'my-own-statusline'})
    })

    it('is idempotent: merging an already-merged settings reports no change + no dupes', () => {
        const {settings: once} = mergeTargetSettings({}, RULES)
        const {settings: twice, changed} = mergeTargetSettings(once, RULES)
        expect(changed).toBe(false)
        const allow = (twice.permissions as {allow: string[]}).allow
        expect(new Set(allow).size).toBe(allow.length) // no duplicates on re-merge
        const dirs = (twice.permissions as {additionalDirectories: string[]}).additionalDirectories
        expect(new Set(dirs).size).toBe(dirs.length) // no duplicate dirs on re-merge
    })

    it('from empty: declares the ABSOLUTE baked data dir in permissions.additionalDirectories', () => {
        // The allow-list grants the tool; additionalDirectories grants the
        // working-directory boundary for out-of-tree writes (results/, worktrees/).
        // Absolute form only — `~/` does not expand in additionalDirectories.
        const {settings} = mergeTargetSettings({}, RULES)
        const dirs = (settings.permissions as {additionalDirectories: string[]}).additionalDirectories
        expect(dirs).toContain(DATA_DIR)
        expect(dirs).not.toContain(TILDE_BASE)
        expect(dirs).not.toContain(STALE_ADDITIONAL)
    })

    it("unions additionalDirectories, preserving the user's own entries", () => {
        const existing = {
            permissions: {additionalDirectories: ['/my/extra/dir']},
        }
        const {settings, changed} = mergeTargetSettings(existing, RULES)
        expect(changed).toBe(true)
        const dirs = (settings.permissions as {additionalDirectories: string[]}).additionalDirectories
        expect(dirs).toContain('/my/extra/dir') // user entry kept
        expect(dirs).toContain(DATA_DIR) // baked entry added
    })

    it('reports changed when additionalDirectories is missing even if allow-list is complete', () => {
        // Build a fully-merged settings, then strip ONLY additionalDirectories: a
        // re-merge must re-add it (and report changed), independent of the allow-list.
        const base = mergeTargetSettings({}, RULES).settings
        delete (base.permissions as {additionalDirectories?: unknown}).additionalDirectories
        const {changed, settings} = mergeTargetSettings(base, RULES)
        expect(changed).toBe(true)
        const dirs = (settings.permissions as {additionalDirectories: string[]}).additionalDirectories
        expect(dirs).toContain(DATA_DIR)
    })

    it('migrates the stale TILDE additionalDirectories entry a previous emitter wrote', () => {
        // Repos scaffolded between the placeholder era and this fix carry the tilde
        // form, which Claude Code never matched (the observed prompt regression).
        const stale = {permissions: {additionalDirectories: [TILDE_BASE, '/my/extra/dir']}}
        const {settings, changed} = mergeTargetSettings(stale, RULES)
        expect(changed).toBe(true)
        const dirs = (settings.permissions as {additionalDirectories: string[]}).additionalDirectories
        expect(dirs).not.toContain(TILDE_BASE) // stale tilde gone
        expect(dirs).toContain(DATA_DIR) // absolute baked in
        expect(dirs).toContain('/my/extra/dir') // user entry preserved
    })

    it('reports changed when baseRef was not yet head even if allow-list is complete', () => {
        const base = mergeTargetSettings({}, RULES).settings
        ;(base.worktree as {baseRef: string}).baseRef = 'fresh'
        const {changed, settings} = mergeTargetSettings(base, RULES)
        expect(changed).toBe(true)
        expect((settings.worktree as {baseRef: string}).baseRef).toBe('head')
    })

    it('REPLACES a non-object worktree value with a fresh {baseRef:head}', () => {
        // The worktree value is not an object (a corrupt/hand-edited settings): it must
        // be replaced wholesale, not merged onto. Covers the E3 fresh-object branch for
        // every non-object shape (string / null / array).
        for (const bad of ['foo', null, [1, 2]] as const) {
            const {changed, settings} = mergeTargetSettings({worktree: bad}, RULES)
            expect(changed).toBe(true)
            expect(settings.worktree).toEqual({baseRef: 'head'})
        }
    })

    describe('migration of stale ${CLAUDE_PLUGIN_DATA} placeholder rules', () => {
        it('strips the stale allow + additionalDirectories entries and bakes the resolved dir', () => {
            // A repo scaffolded by the OLD emitter: literal placeholder rules on disk.
            const stale = {
                permissions: {
                    allow: [...FACTORY_TARGET_BASE_ALLOWLIST, ...STALE_ALLOW],
                    additionalDirectories: [STALE_ADDITIONAL],
                },
                worktree: {baseRef: 'head'},
            }
            const {settings, changed} = mergeTargetSettings(stale, RULES)
            expect(changed).toBe(true) // stale → baked is a real change

            const allow = (settings.permissions as {allow: string[]}).allow
            for (const s of STALE_ALLOW) {
                expect(allow).not.toContain(s)
            } // stale gone
            for (const b of BAKED_ALLOW) {
                expect(allow).toContain(b)
            } // baked in

            const dirs = (settings.permissions as {additionalDirectories: string[]}).additionalDirectories
            expect(dirs).not.toContain(STALE_ADDITIONAL)
            expect(dirs).toContain(DATA_DIR)
        })

        it('re-merge after migration is a stable no-op with zero placeholders left', () => {
            const stale = {
                permissions: {
                    allow: [...STALE_ALLOW],
                    additionalDirectories: [STALE_ADDITIONAL],
                },
            }
            const migrated = mergeTargetSettings(stale, RULES).settings
            const {changed, settings} = mergeTargetSettings(migrated, RULES)
            expect(changed).toBe(false)
            expect(JSON.stringify(settings)).not.toContain('${CLAUDE_PLUGIN_DATA}')
            const allow = (settings.permissions as {allow: string[]}).allow
            expect(new Set(allow).size).toBe(allow.length) // no dupes
        })

        it('strips ONLY the exact stale strings — a user rule referencing the var differently is kept', () => {
            // Exact-string match: a legitimately-different rule that mentions the var
            // (e.g. a Bash echo) must survive the migration, never get heuristically nuked.
            const userVarRule = 'Bash(echo ${CLAUDE_PLUGIN_DATA})'
            const existing = {
                permissions: {allow: [userVarRule, ...STALE_ALLOW]},
            }
            const {settings} = mergeTargetSettings(existing, RULES)
            const allow = (settings.permissions as {allow: string[]}).allow
            expect(allow).toContain(userVarRule) // user's distinct rule preserved
            for (const s of STALE_ALLOW) {
                expect(allow).not.toContain(s)
            } // exact stale stripped
        })
    })
})

describe('ensureTargetSettings', () => {
    it('creates .claude/settings.json on a fresh repo and reports it created', async () => {
        const result = await ensureTargetSettings({targetRoot: root, dataDirRules: RULES})
        expect(result.created).toBe(true)
        expect(existsSync(settingsPath())).toBe(true)
        const written = await readSettings()
        expect((written.worktree as {baseRef: string}).baseRef).toBe('head')
        const allow = (written.permissions as {allow: string[]}).allow
        expect(allow).toContain('Bash(factory:*)')
        expect(allow).toContain(`Read(${TILDE_BASE}/**)`)
        expect(written).not.toHaveProperty('statusLine')
    })

    it('writes NO literal ${CLAUDE_PLUGIN_DATA} to disk on a fresh emit', async () => {
        await ensureTargetSettings({targetRoot: root, dataDirRules: RULES})
        const raw = await readFile(settingsPath(), 'utf8')
        expect(raw).not.toContain('${CLAUDE_PLUGIN_DATA}')
    })

    it('merges non-destructively into an existing settings.json', async () => {
        await mkdir(join(root, '.claude'), {recursive: true})
        await writeFile(
            settingsPath(),
            JSON.stringify({statusLine: {command: 'mine'}, permissions: {allow: ['Bash(make:*)']}}),
            'utf8'
        )
        const result = await ensureTargetSettings({targetRoot: root, dataDirRules: RULES})
        expect(result.created).toBe(false)
        expect(result.changed).toBe(true)
        const written = await readSettings()
        expect(written.statusLine).toEqual({command: 'mine'}) // untouched
        const allow = (written.permissions as {allow: string[]}).allow
        expect(allow).toContain('Bash(make:*)')
        expect(allow).toContain('Bash(factory:*)')
    })

    it('migrates a repo with stale placeholder rules on disk to the baked form', async () => {
        await mkdir(join(root, '.claude'), {recursive: true})
        await writeFile(
            settingsPath(),
            JSON.stringify({
                permissions: {
                    allow: [...FACTORY_TARGET_BASE_ALLOWLIST, ...STALE_ALLOW, 'Bash(make:*)'],
                    additionalDirectories: [STALE_ADDITIONAL],
                },
                worktree: {baseRef: 'head'},
            }),
            'utf8'
        )
        const result = await ensureTargetSettings({targetRoot: root, dataDirRules: RULES})
        expect(result.changed).toBe(true)
        const raw = await readFile(settingsPath(), 'utf8')
        expect(raw).not.toContain('${CLAUDE_PLUGIN_DATA}') // stale gone from disk
        const written = await readSettings()
        const allow = (written.permissions as {allow: string[]}).allow
        expect(allow).toContain('Bash(make:*)') // user entry preserved
        expect(allow).toContain(`Edit(${TILDE_BASE}/**)`) // baked rule present
    })

    it('is idempotent on disk: a second run reports no change', async () => {
        await ensureTargetSettings({targetRoot: root, dataDirRules: RULES})
        const second = await ensureTargetSettings({targetRoot: root, dataDirRules: RULES})
        expect(second.created).toBe(false)
        expect(second.changed).toBe(false)
    })

    it('WARNS (not silently coerces) when an existing settings.json is valid JSON but not an object', async () => {
        // A non-object settings.json (here a JSON array) is about to be REPLACED by the
        // merged object — that destructive overwrite must be surfaced, not swallowed.
        await mkdir(join(root, '.claude'), {recursive: true})
        await writeFile(settingsPath(), JSON.stringify(['not', 'an', 'object']), 'utf8')
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
        try {
            const result = await ensureTargetSettings({targetRoot: root, dataDirRules: RULES})
            expect(result.created).toBe(false)
            // The factory settings object replaced the array.
            const written = await readSettings()
            expect((written.worktree as {baseRef: string}).baseRef).toBe('head')
            // The replacement warned, naming the path + that it's being replaced.
            const warned = spy.mock.calls.map((c) => String(c[0])).join('')
            expect(warned).toMatch(/not an object/i)
            expect(warned).toContain('settings.json')
        } finally {
            spy.mockRestore()
        }
    })
})
