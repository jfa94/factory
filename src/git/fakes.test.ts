import {describe, expect, it} from 'vitest'
import {FakeGhClient, FakeGitClient} from './fakes.js'
import type {GhClient, GitClient} from './index.js'

describe('Fakes contract — structural conformance', () => {
    it('FakeGitClient/FakeGhClient satisfy the GitClient/GhClient interfaces (compile-time)', () => {
        // Pure compile-time assignability check (the build/typecheck enforces it).
        const git: GitClient = new FakeGitClient()
        const gh: GhClient = new FakeGhClient()
        expect(git).toBeInstanceOf(FakeGitClient)
        expect(gh).toBeInstanceOf(FakeGhClient)
    })
})
