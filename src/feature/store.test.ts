import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {FeatureStore} from './store.js'
import {featureRunFixture} from './test-fixtures.js'

let dataDir: string
beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'feature-store-'))
})
afterEach(async () => {
    await rm(dataDir, {recursive: true, force: true})
})

describe('FeatureStore integrity checks', () => {
    it('lists nothing before any run exists and names a missing run', async () => {
        const store = new FeatureStore(dataDir)
        await expect(store.list()).resolves.toEqual([])
        await expect(store.read('run')).rejects.toThrow(/run run is missing or uses an unsupported version/)
    })

    it('refuses to write a run whose spec digest does not match its snapshot', async () => {
        const run = featureRunFixture({spec_digest: 'f'.repeat(64)})
        await expect(new FeatureStore(dataDir).write(run)).rejects.toThrow(/spec snapshot digest mismatch/)
    })

    it('refuses to read a run whose state names another run id', async () => {
        const store = new FeatureStore(dataDir)
        await store.write(featureRunFixture())
        const path = join(store.dir('run'), 'state.json')
        const state = JSON.parse(await readFile(path, 'utf8')) as {run_id: string}
        await writeFile(path, JSON.stringify({...state, run_id: 'other'}))
        await expect(store.read('run')).rejects.toThrow(/corrupt identity or spec snapshot/)
    })

    it('surfaces malformed state JSON instead of treating it as missing', async () => {
        const store = new FeatureStore(dataDir)
        await store.write(featureRunFixture())
        await writeFile(join(store.dir('run'), 'state.json'), '{')
        await expect(store.read('run')).rejects.toThrow(SyntaxError)
    })
})
