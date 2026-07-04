/**
 * WS9 — holdout read-confinement tests (Δ Y). Executor Read/Grep/Bash cat of the
 * holdout store (absolute + traversal) is denied; non-holdout reads pass. Theme D2
 * (CCR 2026-06-22): an UNRESOLVED data dir degrades observably — the textual arm
 * goes inert (ALLOW) but the failure is WARNED, never silently swallowed.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {decideHoldoutGuard} from './holdout-guard.js'
import {parseHookInput, isDeny} from './hook-io.js'
import {captureStream} from '../cli/test-helpers.js'

describe('holdout-guard — read confinement (Δ Y)', () => {
    let dataDir: string
    let repoRoot: string
    let holdoutFile: string

    beforeEach(() => {
        dataDir = mkdtempSync(join(tmpdir(), 'hg-data-'))
        repoRoot = mkdtempSync(join(tmpdir(), 'hg-repo-'))
        const holdouts = join(dataDir, 'runs', 'run-1', 'holdouts')
        mkdirSync(holdouts, {recursive: true})
        holdoutFile = join(holdouts, 'answers.json')
        writeFileSync(holdoutFile, '{"answer":42}')
    })
    afterEach(() => {
        rmSync(dataDir, {recursive: true, force: true})
        rmSync(repoRoot, {recursive: true, force: true})
    })

    const deps = () => ({dataDir, cwd: repoRoot})

    function readInput(tool: string, fields: Record<string, string>) {
        return parseHookInput(JSON.stringify({tool_name: tool, tool_input: fields}))
    }
    function bashInput(command: string) {
        return parseHookInput(JSON.stringify({tool_name: 'Bash', tool_input: {command}}))
    }

    it('Δ Y: Read of an absolute holdout path is denied', () => {
        expect(isDeny(decideHoldoutGuard(readInput('Read', {file_path: holdoutFile}), deps()))).toBe(true)
    })

    it('Δ Y: Grep with a holdout path is denied', () => {
        const holdouts = join(dataDir, 'runs', 'run-1', 'holdouts')
        expect(isDeny(decideHoldoutGuard(readInput('Grep', {path: holdouts}), deps()))).toBe(true)
    })

    it('Δ Y: Bash `cat` of the absolute holdout path is denied', () => {
        expect(isDeny(decideHoldoutGuard(bashInput(`cat ${holdoutFile}`), deps()))).toBe(true)
    })

    it('Δ Y: Bash `grep` of the holdout store is denied', () => {
        const holdouts = join(dataDir, 'runs', 'run-1', 'holdouts')
        expect(isDeny(decideHoldoutGuard(bashInput(`grep secret ${holdouts}/answers.json`), deps()))).toBe(true)
    })

    it('§4: a `..` traversal cat of the holdout store is denied', () => {
        const traversal = join(dataDir, 'runs', 'run-1', 'holdouts', '..', 'holdouts', 'answers.json')
        expect(isDeny(decideHoldoutGuard(bashInput(`cat ${traversal}`), deps()))).toBe(true)
    })

    it('non-holdout run artifact read passes (per policy)', () => {
        const other = join(dataDir, 'runs', 'run-1', 'state.json')
        writeFileSync(other, '{}')
        expect(isDeny(decideHoldoutGuard(readInput('Read', {file_path: other}), deps()))).toBe(false)
    })

    it('an in-repo read (no holdouts path) passes', () => {
        const src = join(repoRoot, 'src.ts')
        writeFileSync(src, 'x')
        expect(isDeny(decideHoldoutGuard(readInput('Read', {file_path: src}), deps()))).toBe(false)
    })

    it('a non-read Bash command (echo) passes', () => {
        expect(isDeny(decideHoldoutGuard(bashInput('echo hi'), deps()))).toBe(false)
    })

    // -- WS7: PATH-based denial, not a reader-binary denylist. The old guard only
    //         inspected cat/grep/head/… commands, so ANY other binary that opens a
    //         file (python/node/dd/base64/cp/tar/…) could exfiltrate the answer key.
    //         Denial is now keyed on the holdouts PATH appearing in argv, regardless
    //         of the binary; the reader list survives only as an optional signal.

    it('WS7: `python3 -c open(holdout).read()` is denied (not a reader binary)', () => {
        const cmd = `python3 -c "import sys; sys.stdout.write(open('${holdoutFile}').read())"`
        expect(isDeny(decideHoldoutGuard(bashInput(cmd), deps()))).toBe(true)
    })

    it('WS7: `node -e readFileSync(holdout)` is denied', () => {
        const cmd = `node -e "process.stdout.write(require('fs').readFileSync('${holdoutFile}','utf8'))"`
        expect(isDeny(decideHoldoutGuard(bashInput(cmd), deps()))).toBe(true)
    })

    it('WS7: `dd if=<holdout>` is denied', () => {
        expect(isDeny(decideHoldoutGuard(bashInput(`dd if=${holdoutFile} of=/tmp/x`), deps()))).toBe(true)
    })

    it('WS7: `base64 <holdout>` is denied', () => {
        expect(isDeny(decideHoldoutGuard(bashInput(`base64 ${holdoutFile}`), deps()))).toBe(true)
    })

    it('WS7: `cp <holdout> /tmp` exfiltration is denied', () => {
        expect(isDeny(decideHoldoutGuard(bashInput(`cp ${holdoutFile} /tmp/leak.json`), deps()))).toBe(true)
    })

    it('WS7: a non-holdout path under a non-reader binary still passes (no over-denial)', () => {
        const other = join(dataDir, 'runs', 'run-1', 'state.json')
        writeFileSync(other, '{}')
        expect(isDeny(decideHoldoutGuard(bashInput(`cp ${other} /tmp/x.json`), deps()))).toBe(false)
    })
})

describe('holdout-guard — unresolved data dir degrades observably (CCR Theme D2)', () => {
    let repoRoot: string
    let home: string

    beforeEach(() => {
        repoRoot = mkdtempSync(join(tmpdir(), 'hg-repo-'))
        home = mkdtempSync(join(tmpdir(), 'hg-home-'))
    })
    afterEach(() => {
        rmSync(repoRoot, {recursive: true, force: true})
        rmSync(home, {recursive: true, force: true})
    })

    // env:{} (no CLAUDE_PLUGIN_DATA) → resolveDataDir throws → the unresolved branch.
    const unresolvedDeps = () => ({env: {}, home, cwd: repoRoot})

    function bashInput(command: string) {
        return parseHookInput(JSON.stringify({tool_name: 'Bash', tool_input: {command}}))
    }

    /** Run with warn-level forced through, capturing stderr (mirrors serial-writer.test.ts). */
    function captureWarn<T>(fn: () => T): {result: T; stderr: string} {
        const saved = process.env.FACTORY_LOG_LEVEL
        process.env.FACTORY_LOG_LEVEL = 'info'
        const cap = captureStream(process.stderr)
        try {
            const result = fn()
            return {result, stderr: cap.read()}
        } finally {
            cap.restore()
            if (saved === undefined) {
                delete process.env.FACTORY_LOG_LEVEL
            } else {
                process.env.FACTORY_LOG_LEVEL = saved
            }
        }
    }

    it('unresolved data dir → the textual-match arm is inert (ALLOW) and the failure is WARNED', () => {
        // A command only the TEXTUAL arm could have caught: 'holdouts' as a substring,
        // not a clean path segment, so the canonical arm does not fire. With the store
        // unresolved the textual arm is dead → ALLOW — but loud, never silent.
        const {result, stderr} = captureWarn(() =>
            decideHoldoutGuard(bashInput('cat /some/data/runs/run-1/holdouts.bak'), unresolvedDeps())
        )
        expect(isDeny(result)).toBe(false)
        expect(stderr).toMatch(/\[WARN\]/)
        expect(stderr).toMatch(/holdout store dir unresolved/i)
    })

    it('unresolved data dir still DENIES a canonical holdouts-segment path (defense-in-depth holds)', () => {
        // The canonical-path arm is independent of the store location, so it keeps
        // denying even when resolveDataDir failed — only the textual fallback degrades.
        const target = join(repoRoot, 'runs', 'r', 'holdouts', 'answers.json')
        const {result} = captureWarn(() => decideHoldoutGuard(bashInput(`cat ${target}`), unresolvedDeps()))
        expect(isDeny(result)).toBe(true)
    })

    it('unresolved data dir leaves a non-holdouts command unaffected (ALLOW)', () => {
        const {result} = captureWarn(() => decideHoldoutGuard(bashInput('echo hello'), unresolvedDeps()))
        expect(isDeny(result)).toBe(false)
    })
})
