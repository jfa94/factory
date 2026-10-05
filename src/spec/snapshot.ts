import {execOrThrow} from '../shared/exec.js'

export interface RepositorySnapshot {
    base_sha: string
    contracts: Record<string, string>
}

export async function repositorySnapshot(root: string, baseBranch: string): Promise<RepositorySnapshot> {
    const git = async (args: string[]) => (await execOrThrow('git', args, {cwd: root})).stdout.trim()
    await git(['fetch', 'origin', baseBranch])
    const base_sha = await git(['rev-parse', `origin/${baseBranch}`])
    const paths = (await git(['ls-tree', '-r', '--name-only', base_sha])).split('\n')
    const selected = paths.filter(
        (path) =>
            [
                'AGENTS.md',
                'CLAUDE.md',
                'package.json',
                '.factory/gates.json',
                'docs/glossary.md',
                'docs/architecture/overview.md',
            ].includes(path) || /^docs\/(?:adr|contracts)\/.*\.md$/.test(path)
    )
    const contracts: Record<string, string> = {}
    for (const path of selected) {
        contracts[path] = await git(['show', `${base_sha}:${path}`])
    }
    return {base_sha, contracts}
}
