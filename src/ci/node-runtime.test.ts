import {describe, expect, it} from 'vitest'
import fc from 'fast-check'

import {resolveNodeRuntimeDeclarations} from './node-runtime.js'

describe('resolveNodeRuntimeDeclarations', () => {
    it('requires a committed runtime declaration', () => {
        expect(() => resolveNodeRuntimeDeclarations({})).toThrow(
            /Node runtime is undeclared.*\.node-version.*\.nvmrc.*engines\.node/
        )
    })

    it('uses .node-version, then .nvmrc, then package.json engines.node', () => {
        expect(resolveNodeRuntimeDeclarations({enginesNode: '>=22'})).toEqual({versionFile: 'package.json'})
        expect(resolveNodeRuntimeDeclarations({nvmrc: '22\n', enginesNode: '>=20'})).toEqual({versionFile: '.nvmrc'})
        expect(resolveNodeRuntimeDeclarations({nodeVersion: '24\n', nvmrc: ' 24 ', enginesNode: '>=20'})).toEqual({
            versionFile: '.node-version',
        })
    })

    it('refuses conflicting version files', () => {
        expect(() => resolveNodeRuntimeDeclarations({nodeVersion: '24', nvmrc: '22'})).toThrow(
            /\.node-version \(24\).*\.nvmrc \(22\).*disagree/
        )
    })

    it('refuses setup-node package fields that shadow engines.node unless a version file wins', () => {
        const declarations = {
            enginesNode: '>=24',
            packageJsonRuntimeShadows: ['volta.node', 'devEngines.runtime'],
        }
        expect(() => resolveNodeRuntimeDeclarations(declarations)).toThrow(
            /engines\.node is shadowed by volta\.node, devEngines\.runtime/
        )
        expect(resolveNodeRuntimeDeclarations({...declarations, nvmrc: '24'})).toEqual({versionFile: '.nvmrc'})
    })

    it.each([
        [{nodeVersion: ''}, /\.node-version must contain a non-empty/],
        [{nodeVersion: '24\n22'}, /\.node-version must contain exactly one/],
        [{nvmrc: ' \n '}, /\.nvmrc must contain a non-empty/],
        [{nvmrc: '24\r\n22'}, /\.nvmrc must contain exactly one/],
        [{enginesNode: ''}, /engines\.node must be a non-empty string/],
        [{enginesNode: null}, /engines\.node must be a non-empty string/],
        [{enginesNode: 24}, /engines\.node must be a non-empty string/],
        [{nodeVersion: '24', enginesNode: null}, /engines\.node must be a non-empty string/],
    ] as const)('refuses malformed declarations: %j', (declarations, message) => {
        expect(() => resolveNodeRuntimeDeclarations(declarations)).toThrow(message)
    })

    it('property: any non-empty single-line version is trimmed and resolves deterministically', () => {
        fc.assert(
            fc.property(
                fc.string().filter((value) => value.trim().length > 0 && !/[\r\n]/.test(value.trim())),
                fc.stringMatching(/^[ \t]*$/),
                (version, padding) => {
                    expect(
                        resolveNodeRuntimeDeclarations({
                            nodeVersion: `${padding}${version}${padding}`,
                            nvmrc: version.trim(),
                            enginesNode: '>=1',
                        })
                    ).toEqual({versionFile: '.node-version'})
                }
            )
        )
    })
})
