import {describe, it, expect} from 'vitest'
import {isDbPath} from './db-detect.js'

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
})
