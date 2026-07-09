/**
 * Agent bodies are executable policy, and `agents/*.md` is markdown the typechecker never
 * sees — so when a body names an engine constant BY VALUE, only a grep-guard catches the
 * two drifting apart. Same shape and rationale as `src/orchestrator/review-base-ref.test.ts`,
 * one step stronger: this imports the constant rather than hand-copying its value, so a
 * rename in the engine fails here instead of rotting the prose.
 *
 * SCOPE, deliberately narrow. This guards RENAME drift, not SEMANTIC drift. It cannot tell
 * whether the body's prose about `[REDACTED]` is *correct* — a body can contain every right
 * literal and still say the wrong thing. A test asserting prose semantics is worse than the
 * disease it treats. Semantic drift is caught by treating an agent-body edit as a code
 * change (see CLAUDE.md); this file catches only what a machine can honestly check.
 */
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {describe, expect, it} from 'vitest'

import {REDACTION_TOKEN} from '../../shared/secret-patterns.js'

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../../..')
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), 'utf8')

describe('agent bodies name the engine literals they depend on', () => {
    it('finding-verifier.md teaches the agent to recognise a scrubbed quote by REDACTION_TOKEN', () => {
        // `citation-verify.ts` redacts a finding's `quote` AFTER machine-verifying it, so the
        // verifier can hold a quote that no longer matches source. Iron Law 3 tells it to
        // expect exactly this token. Rename the token's VALUE and that guidance goes silently
        // stale: the agent stops recognising a redacted quote and refutes real blockers —
        // precisely the false negative D27's verify-then-fix exists to prevent.
        expect(read('agents/finding-verifier.md')).toContain(REDACTION_TOKEN)
    })
})
