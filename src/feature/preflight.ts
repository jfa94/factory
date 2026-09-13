import type {Config} from '../config/schema.js'
import {DefaultGhClient, type GhClient} from '../git/gh-client.js'
import {effectiveProfiles, requireProtectionOrRefuse} from '../git/protection.js'
import {GateContractSchema, GATE_CONTRACT_REL, requiredCheckExtras} from '../verifier/deterministic/gate-contract.js'
import type {FeatureSpec} from './schema.js'

export async function assertFeatureEnvironment(
    spec: Pick<FeatureSpec, 'contracts'>,
    repo: string,
    config: Config,
    gh: Pick<GhClient, 'repoProtection'> = new DefaultGhClient()
): Promise<void> {
    const raw = spec.contracts[GATE_CONTRACT_REL]
    if (raw === undefined) {
        throw new Error('base commit has no gate contract; run factory scaffold, commit it, and regenerate the spec')
    }
    const contract = GateContractSchema.parse(JSON.parse(raw))
    const [owner, name] = repo.split('/')
    if (owner === undefined || owner === '' || name === undefined || name === '') {
        throw new Error('repository must be owner/name')
    }
    const protection = await gh.repoProtection(owner, name, config.git.baseBranch)
    requireProtectionOrRefuse(
        protection,
        effectiveProfiles(config.git, requiredCheckExtras(contract)).run,
        config.git.baseBranch
    )
}
