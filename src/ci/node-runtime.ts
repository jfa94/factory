/**
 * Resolve the committed Node runtime declaration used by scaffolded CI.
 *
 * The factory must never infer this from the operator's host Node version: doing
 * so makes the committed managed workflow depend on which machine last ran
 * `factory scaffold`. The target repo owns the declaration; setup-node reads it
 * directly through `node-version-file`.
 */

export const NODE_VERSION_FILE = '.node-version' as const
export const NVMRC_FILE = '.nvmrc' as const
export const PACKAGE_JSON_FILE = 'package.json' as const

export type NodeVersionFile = typeof NODE_VERSION_FILE | typeof NVMRC_FILE | typeof PACKAGE_JSON_FILE

export interface NodeRuntime {
    readonly versionFile: NodeVersionFile
}

export interface NodeRuntimeDeclarations {
    readonly nodeVersion?: string
    readonly nvmrc?: string
    /** Present only when package.json explicitly contains engines.node. */
    readonly enginesNode?: unknown
    /** setup-node package.json fields that would take precedence over engines.node. */
    readonly packageJsonRuntimeShadows?: readonly string[]
}

function normalizeVersionFile(name: typeof NODE_VERSION_FILE | typeof NVMRC_FILE, raw: string): string {
    const value = raw.trim()
    if (value.length === 0) {
        throw new Error(`scaffold: ${name} must contain a non-empty Node version`)
    }
    if (/\r|\n/.test(value)) {
        throw new Error(`scaffold: ${name} must contain exactly one Node version line`)
    }
    return value
}

/** Pure declaration resolver; filesystem discovery stays in the scaffold seam. */
export function resolveNodeRuntimeDeclarations(declarations: NodeRuntimeDeclarations): NodeRuntime {
    const nodeVersion =
        declarations.nodeVersion === undefined
            ? undefined
            : normalizeVersionFile(NODE_VERSION_FILE, declarations.nodeVersion)
    const nvmrc = declarations.nvmrc === undefined ? undefined : normalizeVersionFile(NVMRC_FILE, declarations.nvmrc)

    if (Object.hasOwn(declarations, 'enginesNode')) {
        if (typeof declarations.enginesNode !== 'string' || declarations.enginesNode.trim().length === 0) {
            throw new Error('scaffold: package.json engines.node must be a non-empty string')
        }
    }

    if (nodeVersion !== undefined && nvmrc !== undefined && nodeVersion !== nvmrc) {
        throw new Error(
            `scaffold: ${NODE_VERSION_FILE} (${nodeVersion}) and ${NVMRC_FILE} (${nvmrc}) disagree; keep one source or make them identical`
        )
    }
    if (nodeVersion !== undefined) {
        return {versionFile: NODE_VERSION_FILE}
    }
    if (nvmrc !== undefined) {
        return {versionFile: NVMRC_FILE}
    }
    if (Object.hasOwn(declarations, 'enginesNode')) {
        if ((declarations.packageJsonRuntimeShadows?.length ?? 0) > 0) {
            throw new Error(
                `scaffold: package.json engines.node is shadowed by ${declarations.packageJsonRuntimeShadows?.join(', ')}; remove the shadowing field or declare .node-version/.nvmrc`
            )
        }
        return {versionFile: PACKAGE_JSON_FILE}
    }
    throw new Error(
        `scaffold: Node runtime is undeclared; add ${NODE_VERSION_FILE}, ${NVMRC_FILE}, or package.json engines.node`
    )
}
