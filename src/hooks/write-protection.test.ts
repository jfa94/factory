/**
 * WS9 — write-protection adversarial tests (Δ B/W/Y). An implementer Edit/Write/
 * MultiEdit against each TCB path is blocked; non-TCB passes; MultiEdit blocked
 * if ANY target is TCB.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {decideWriteProtection, bashWriteTargets} from './write-protection.js'
import {parseHookInput, isDeny} from './hook-io.js'

describe('write-protection — TCB write-deny (Δ W)', () => {
    let repoRoot: string
    let dataDir: string

    beforeEach(() => {
        repoRoot = mkdtempSync(join(tmpdir(), 'wp-repo-'))
        dataDir = mkdtempSync(join(tmpdir(), 'wp-data-'))
        mkdirSync(join(repoRoot, '.github', 'workflows'), {recursive: true})
        mkdirSync(join(repoRoot, 'hooks'), {recursive: true})
        mkdirSync(join(repoRoot, 'src'), {recursive: true})
        mkdirSync(join(dataDir, 'runs', 'run-1', 'holdouts'), {recursive: true})
    })
    afterEach(() => {
        rmSync(repoRoot, {recursive: true, force: true})
        rmSync(dataDir, {recursive: true, force: true})
    })

    function editInput(tool: string, filePath: string, edits?: string[]) {
        const tool_input: Record<string, unknown> = {file_path: filePath}
        if (edits) {
            tool_input.edits = edits.map((p) => ({file_path: p}))
        }
        return parseHookInput(JSON.stringify({tool_name: tool, tool_input}))
    }

    const deps = () => ({dataDir, repoRoot, cwd: repoRoot})

    it('Δ W: Edit to .github/workflows/quality-gate.yml is blocked', () => {
        const p = join(repoRoot, '.github', 'workflows', 'quality-gate.yml')
        writeFileSync(p, 'x')
        expect(isDeny(decideWriteProtection(editInput('Edit', p), deps()))).toBe(true)
    })

    it('Δ W: Write to .stryker.config.json (gate config) is blocked', () => {
        const p = join(repoRoot, '.stryker.config.json')
        expect(isDeny(decideWriteProtection(editInput('Write', p), deps()))).toBe(true)
    })

    // jfa94/factory#11: an UNPROTECTED Stryker config sibling could be created and
    // loaded by Stryker ahead of the scaffolded .stryker.config.json; the .mjs/.js/
    // .cjs variants run arbitrary JS in the trusted gate process. All must be denied.
    it('Δ W: Write to executable Stryker config siblings is blocked (shadow + code-exec vectors)', () => {
        for (const name of [
            'stryker.config.mjs',
            'stryker.config.js',
            'stryker.config.cjs',
            'stryker.conf.js',
            '.stryker.config.mjs', // the dotted variant the outsidey repo actually had
        ]) {
            const p = join(repoRoot, name)
            expect(isDeny(decideWriteProtection(editInput('Write', p), deps()))).toBe(true)
        }
    })

    // jfa94/factory#11 (same gap class): dependency-cruiser's discovery loads
    // `.dependency-cruiser.{json,js,cjs,mjs}`; the executable variants run arbitrary
    // JS in the arch/lint gate process. The prior denylist protected only .cjs/.js
    // (and a never-loaded `dependency-cruiser.config.cjs`) — .json and .mjs were open.
    it('Δ W: Write to dependency-cruiser config siblings is blocked (shadow + code-exec vectors)', () => {
        for (const name of [
            '.dependency-cruiser.json',
            '.dependency-cruiser.js',
            '.dependency-cruiser.cjs',
            '.dependency-cruiser.mjs',
        ]) {
            const p = join(repoRoot, name)
            expect(isDeny(decideWriteProtection(editInput('Write', p), deps()))).toBe(true)
        }
    })

    it('Δ W: Edit to hooks/* is blocked', () => {
        const p = join(repoRoot, 'hooks', 'write-protection.sh')
        writeFileSync(p, 'x')
        expect(isDeny(decideWriteProtection(editInput('Edit', p), deps()))).toBe(true)
    })

    it('D46: Write/Edit to .factory/gates.json (the gate contract) is blocked', () => {
        const p = join(repoRoot, '.factory', 'gates.json')
        mkdirSync(join(repoRoot, '.factory'), {recursive: true})
        expect(isDeny(decideWriteProtection(editInput('Write', p), deps()))).toBe(true)
        writeFileSync(p, '{}')
        expect(isDeny(decideWriteProtection(editInput('Edit', p), deps()))).toBe(true)
    })

    it('Δ Y: Write into the holdout store is blocked', () => {
        const p = join(dataDir, 'runs', 'run-1', 'holdouts', 'answers.json')
        expect(isDeny(decideWriteProtection(editInput('Write', p), deps()))).toBe(true)
    })

    it('non-TCB src write passes', () => {
        const p = join(repoRoot, 'src', 'feature.ts')
        expect(isDeny(decideWriteProtection(editInput('Write', p), deps()))).toBe(false)
    })

    it('MultiEdit blocked if ANY target is TCB', () => {
        const ok = join(repoRoot, 'src', 'a.ts')
        const tcb = join(repoRoot, '.github', 'workflows', 'ci.yml')
        writeFileSync(tcb, 'x')
        const input = editInput('MultiEdit', ok, [ok, tcb])
        expect(isDeny(decideWriteProtection(input, deps()))).toBe(true)
    })

    it('§4: a `..` traversal write into a workflow is blocked', () => {
        const traversal = join(repoRoot, 'src', '..', '.github', 'workflows', 'ci.yml')
        writeFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'x')
        expect(isDeny(decideWriteProtection(editInput('Edit', traversal), deps()))).toBe(true)
    })

    it('non-write tools (Read) pass through', () => {
        const p = join(repoRoot, '.github', 'workflows', 'ci.yml')
        writeFileSync(p, 'x')
        const input = parseHookInput(JSON.stringify({tool_name: 'Read', tool_input: {file_path: p}}))
        expect(isDeny(decideWriteProtection(input, deps()))).toBe(false)
    })

    // ── Bash arm: top-level shell writes to TCB paths (the config-bypass class the
    //    Edit/Write matcher alone could not see — a plain redirect is not a nested
    //    shell, so shell-bypass never fired either).
    describe('Bash write-target arm', () => {
        function bashInput(command: string) {
            return parseHookInput(JSON.stringify({tool_name: 'Bash', tool_input: {command}}))
        }
        const denied = (cmd: string) => isDeny(decideWriteProtection(bashInput(cmd), deps()))

        it('Δ W: redirect into a workflow is blocked (create + append + noclobber)', () => {
            writeFileSync(join(repoRoot, '.github', 'workflows', 'quality-gate.yml'), 'x')
            expect(denied("printf 'x' > .github/workflows/quality-gate.yml")).toBe(true)
            expect(denied('echo x >> .github/workflows/quality-gate.yml')).toBe(true)
            expect(denied('echo x >| .github/workflows/quality-gate.yml')).toBe(true)
            expect(denied('echo x &> .github/workflows/quality-gate.yml')).toBe(true)
        })

        it('Δ W: tee / cp / mv / install / dd / sed -i / truncate into TCB are blocked', () => {
            const wf = '.github/workflows/quality-gate.yml'
            writeFileSync(join(repoRoot, '.github', 'workflows', 'quality-gate.yml'), 'x')
            expect(denied(`cat /tmp/x | tee ${wf}`)).toBe(true)
            expect(denied(`cp /tmp/x ${wf}`)).toBe(true)
            expect(denied(`mv /tmp/x ${wf}`)).toBe(true)
            expect(denied(`install -m 644 /tmp/x ${wf}`)).toBe(true)
            expect(denied(`dd if=/tmp/x of=${wf}`)).toBe(true)
            expect(denied(`sed -i 's/a/b/' ${wf}`)).toBe(true)
            expect(denied(`sed -i.bak 's/a/b/' ${wf}`)).toBe(true)
            expect(denied(`perl -pi -e 's/a/b/' ${wf}`)).toBe(true)
            expect(denied(`truncate -s 0 ${wf}`)).toBe(true)
        })

        it('Δ W: deleting a gate config is blocked (rm neutralizes as surely as rewrite)', () => {
            writeFileSync(join(repoRoot, '.stryker.config.json'), '{}')
            expect(denied('rm .stryker.config.json')).toBe(true)
            expect(denied('rm -f .stryker.config.json')).toBe(true)
        })

        it('Δ W: gate-config shadow write via redirect is blocked', () => {
            expect(denied("echo 'module.exports={}' > .dependency-cruiser.cjs")).toBe(true)
        })

        it('Δ W: write to <dataDir>/config.json (setupCommand ACE vector) is blocked', () => {
            expect(denied(`tee ${join(dataDir, 'config.json')} < /tmp/x`)).toBe(true)
            expect(denied(`printf '{}' > ${join(dataDir, 'config.json')}`)).toBe(true)
        })

        it('D46: redirect / rm on .factory/gates.json is blocked', () => {
            mkdirSync(join(repoRoot, '.factory'), {recursive: true})
            writeFileSync(join(repoRoot, '.factory', 'gates.json'), '{}')
            expect(denied("echo '{}' > .factory/gates.json")).toBe(true)
            expect(denied('rm .factory/gates.json')).toBe(true)
        })

        it('Δ Y: redirect into the holdout store is blocked', () => {
            expect(denied(`echo x > ${join(dataDir, 'runs', 'run-1', 'holdouts', 'a.json')}`)).toBe(true)
        })

        it('§4: `..` traversal and quoted targets are blocked', () => {
            writeFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'x')
            expect(denied('echo x > src/../.github/workflows/ci.yml')).toBe(true)
            expect(denied('echo x > ".github/workflows/ci.yml"')).toBe(true)
        })

        it('compound commands are checked per segment', () => {
            writeFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'x')
            expect(denied('npm test && printf x > .github/workflows/ci.yml')).toBe(true)
            expect(denied('true; cp /tmp/x .github/workflows/ci.yml')).toBe(true)
        })

        it('wrapper binaries (env/xargs) do not hide the write', () => {
            writeFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'x')
            expect(denied('env FOO=1 tee .github/workflows/ci.yml')).toBe(true)
            expect(denied('echo x | xargs tee .github/workflows/ci.yml')).toBe(true)
        })

        it('benign Bash writes and TCB reads pass', () => {
            writeFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'x')
            expect(denied('echo hi > /tmp/out.txt')).toBe(false)
            expect(denied('npm run build')).toBe(false)
            expect(denied('cat .github/workflows/ci.yml')).toBe(false)
            expect(denied('grep -rn pattern hooks/')).toBe(false)
            expect(denied('cp src/a.ts src/b.ts')).toBe(false)
            expect(denied('ls -la 2>&1')).toBe(false)
            expect(denied('')).toBe(false)
        })
    })

    describe('bashWriteTargets extraction', () => {
        it('extracts redirect targets including inside substitutions', () => {
            expect(bashWriteTargets('echo $(date) > out.log')).toContain('out.log')
            expect(bashWriteTargets('x=`echo y > inner.txt`')).toContain('inner.txt')
        })

        it('ignores fd-dups and process substitution', () => {
            expect(bashWriteTargets('ls 2>&1')).toEqual([])
            expect(bashWriteTargets('diff <(a) >(b)')).toEqual([])
        })

        it('cp -t form yields the target directory', () => {
            expect(bashWriteTargets('cp -t dest/ a b')).toContain('dest/')
            expect(bashWriteTargets('cp --target-directory=dest2 a')).toContain('dest2')
        })

        it('sed without -i yields nothing', () => {
            expect(bashWriteTargets("sed 's/a/b/' file.txt")).toEqual([])
        })
    })
})
