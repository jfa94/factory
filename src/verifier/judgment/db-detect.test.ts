import {describe, it, expect} from 'vitest'
import {isDbPath, touchesDatabase} from './db-detect.js'
import {FakeGitProbe} from '../deterministic/fakes.js'

describe('Decision 51 — DB-touch detection', () => {
    // Exhaustive over the supported layouts (finite domain — property test by enumeration).
    const DB_PATHS = [
        'migrations/0001_init.sql',
        'supabase/migrations/20260706_add_orders.sql',
        'apps/api/migrations/0002_users.py', // django-style, nested
        'db/migrate/20260706120000_create_orders.rb', // rails
        'alembic/versions/ae1027a6acf_add_col.py',
        'drizzle/0000_wild_penguin.sql',
        'drizzle/meta/_journal.json',
        'prisma/schema.prisma',
        'schema.prisma',
        'src/queries/report.SQL', // extension match is case-insensitive
    ]
    const NON_DB_PATHS = [
        'src/orders/service.ts',
        'src/orders/service.test.ts',
        'docs/how-to/migrations.md', // "migrations" as a filename word, not a directory
        'README.md',
        'package.json',
        'src/sqlite-helper.ts', // "sql" inside a word, not an extension
        'migrations.ts', // file named migrations, not a migrations/ dir
    ]

    it.each(DB_PATHS)('flags %s as a DB path', (p) => {
        expect(isDbPath(p)).toBe(true)
    })

    it.each(NON_DB_PATHS)('does NOT flag %s', (p) => {
        expect(isDbPath(p)).toBe(false)
    })

    it('touchesDatabase is true when ANY changed file is a DB path', async () => {
        const git = new FakeGitProbe({
            changedFiles: ['src/orders/service.ts', 'supabase/migrations/0001_init.sql'],
        })
        await expect(touchesDatabase(git, 'origin/staging-run-1', {cwd: '/wt'})).resolves.toBe(true)
    })

    it('touchesDatabase is false for a pure app-code diff', async () => {
        const git = new FakeGitProbe({changedFiles: ['src/orders/service.ts', 'src/orders/service.test.ts']})
        await expect(touchesDatabase(git, 'origin/staging-run-1', {cwd: '/wt'})).resolves.toBe(false)
    })

    it('touchesDatabase is false for an empty diff', async () => {
        const git = new FakeGitProbe({changedFiles: []})
        await expect(touchesDatabase(git, 'origin/staging-run-1', {cwd: '/wt'})).resolves.toBe(false)
    })
})
