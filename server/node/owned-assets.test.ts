import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const assets = require('./owned-assets.cjs')
const { atomicWriteJson } = require('./file-store.cjs')
const roots: string[] = []
const root = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-owned-assets-'))
    roots.push(directory)
    return directory
}
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 42])
function publish(directory: string, plan: any) {
    for (const operation of plan.operations) {
        const target = path.join(directory, operation.path)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        if (operation.sourcePath) fs.copyFileSync(operation.sourcePath, target)
        else fs.writeFileSync(target, operation.data)
    }
    atomicWriteJson(directory, assets.ASSET_INDEX_PATH, plan.index)
}
afterEach(() => {
    vi.restoreAllMocks()
    for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('owner-local canonical assets', () => {
    it('does not read unchanged asset bytes again during repeated source lookup and save planning', () => {
        const directory = root()
        const owners = [{ folder: 'characters/c', entity: { image: 'assets/a' } }]
        const initial = assets.planOwnedAssets({ dataRoot: directory, owners, readAsset: () => png })
        publish(directory, initial)
        const sourcePath = assets.getOwnedAssetSource(directory, 'assets/a', initial.index)
        const input = { dataRoot: directory, owners, previousIndex: initial.index,
            readAsset: () => ({ sourcePath, checksum: initial.index.entries['assets/a'].checksum }) }
        expect(assets.planOwnedAssets(input).operations).toEqual([])
        const read = vi.spyOn(fs, 'readSync')
        expect(assets.getOwnedAssetSource(directory, 'assets/a', initial.index)).toBe(sourcePath)
        expect(assets.planOwnedAssets(input).operations).toEqual([])
        expect(read).not.toHaveBeenCalled()
    })

    it('invalidates cached checksums for same-size edits with restored modification time and renamed replacements', () => {
        const directory = root()
        const sourcePath = path.join(directory, 'source')
        fs.writeFileSync(sourcePath, 'first')
        const first = assets.checksumOwnedAssetFile(sourcePath)
        const before = fs.statSync(sourcePath)
        fs.writeFileSync(sourcePath, 'other')
        fs.utimesSync(sourcePath, before.atime, before.mtime)
        const edited = assets.checksumOwnedAssetFile(sourcePath)
        expect(edited).not.toBe(first)
        const replacement = path.join(directory, 'replacement')
        fs.writeFileSync(replacement, 'third')
        fs.utimesSync(replacement, before.atime, before.mtime)
        fs.renameSync(replacement, sourcePath)
        expect(assets.checksumOwnedAssetFile(sourcePath)).not.toBe(edited)
    })

    it('verifies claimed source checksums before planning writes, including previously cached files', () => {
        const directory = root()
        const sourcePath = path.join(directory, 'source')
        fs.writeFileSync(sourcePath, png)
        const input = { dataRoot: directory, owners: [{ folder: 'characters/c', entity: { image: 'assets/a' } }],
            readAsset: () => ({ sourcePath, checksum: '0'.repeat(64) }) }
        expect(() => assets.planOwnedAssets(input)).toThrow(/checksum/i)
        const digest = assets.checksumOwnedAssetFile(sourcePath)
        expect(assets.planOwnedAssets({ ...input, readAsset: () => ({ sourcePath, checksum: digest }) }).operations).toHaveLength(1)
        expect(() => assets.planOwnedAssets(input)).toThrow(/checksum/i)
    })

    it('limits new readable asset labels to 40 characters and uses the actual media extension', () => {
        const directory = root()
        const plan = assets.planOwnedAssets({ dataRoot: directory, readAsset: () => png,
            owners: [{ folder: 'characters/c', entity: { assets: [['가'.repeat(80), 'assets/a.webp']] } }] })
        expect(plan.index.entries['assets/a.webp'].paths).toEqual([`characters/c/assets/${'가'.repeat(40)}.png`])
    })

    it('unpacks legacy png-named WebP assets as ordinary WebP files without changing logical references', () => {
        const directory = root()
        const webp = Buffer.from('RIFF0000WEBPVP8 ')
        const plan = assets.planOwnedAssets({ dataRoot: directory, readAsset: () => webp,
            owners: [{ folder: 'modules/Images', entity: { assets: [['happy.webp', 'assets/hash.png', 'webp']] } }] })
        expect(plan.index.entries['assets/hash.png'].paths).toEqual(['modules/Images/assets/happy.webp'])
        expect(plan.operations[0].data).toEqual(webp)
    })

    it('requires the canonical asset index once the named-folder layout exists', () => {
        const directory = root()
        expect(assets.readOwnedAssetIndex(directory)).toEqual({ schemaVersion: 2, entries: {} })
        atomicWriteJson(directory, 'settings/layout.json', { schemaVersion: 2, format: 'risubard-named-folders' })
        expect(() => assets.readOwnedAssetIndex(directory)).toThrow(/missing.*asset.*index/i)
    })

    it('copies shared images into every owner and discovers structured, embedded and chat references', () => {
        const directory = root()
        const owners = [
            { kind: 'character', id: 'c', folder: 'characters/별', entity: {
                image: 'assets/shared', emotionImages: [['기쁨', 'assets/emotion']],
                additionalAssets: [['소품', 'assets/prop']], ccAssets: [{ name: '옷', uri: 'assets/clothing' }],
                personas: [{ image: 'assets/persona', embeddedModule: { assets: [['내장', 'assets/embedded']] } }],
                chats: [{ message: '<img src="assets/chat"> ![](assets/markdown)' }],
                extension: { ref: 'assets/extension', references: ['assets/list-one', 'assets/list-two'] },
            } },
            { kind: 'module', id: 'm', folder: 'modules/모듈', entity: { assets: [['배경', 'assets/shared']] } },
        ]
        const plan = assets.planOwnedAssets({ dataRoot: directory, owners, readAsset: () => png, strict: true })
        expect(plan.index.entries['assets/shared'].paths).toEqual(['characters/별/assets/portrait.png', 'modules/모듈/assets/배경.png'])
        expect(plan.index.entries['assets/emotion'].paths).toEqual(['characters/별/assets/기쁨.png'])
        expect(Object.keys(plan.index.entries)).toHaveLength(11)
        publish(directory, plan)
        expect(assets.readOwnedAsset(directory, 'assets/shared')).toEqual(png)
        expect(assets.planOwnedAssets({ dataRoot: directory, owners, readAsset: () => png }).operations).toEqual([])
    })

    it('sanitizes Windows names and resolves case-insensitive collisions without overwriting unrelated files', () => {
        const directory = root()
        fs.mkdirSync(path.join(directory, 'modules/m/assets'), { recursive: true })
        fs.writeFileSync(path.join(directory, 'modules/m/assets/같은.png'), 'unrelated')
        const plan = assets.planOwnedAssets({ dataRoot: directory, readAsset: () => png, owners: [{ folder: 'modules/m', entity: {
            assets: [['같은', 'assets/a'], ['같은', 'assets/b'], ['CON', 'assets/c'], ['A:B?*', 'assets/d']],
        } }] })
        expect(Object.values(plan.index.entries).map((entry: any) => entry.paths[0])).toEqual([
            'modules/m/assets/같은-2.png', 'modules/m/assets/같은-3.png', 'modules/m/assets/_CON.png', 'modules/m/assets/A_B__.png',
        ])
    })

    it('keeps readable extensions, detects signatures and preserves unowned assets', () => {
        const directory = root()
        const plan = assets.planOwnedAssets({ dataRoot: directory,
            database: { customBackground: 'assets/background.webp' }, allAssetKeys: ['assets/unrelated'], readAsset: () => png,
        })
        expect(plan.index.entries['assets/background.webp'].paths).toEqual(['shared/assets/background.webp.png'])
        expect(plan.index.entries['assets/unrelated'].paths).toEqual(['shared/assets/unrelated.png'])
    })

    it('requires referenced imports and never hides loss of a previously mapped asset', () => {
        const directory = root()
        const input = { dataRoot: directory, owners: [{ folder: 'personas/p', entity: { image: 'assets/a' } }], readAsset: () => null }
        expect(assets.planOwnedAssets(input).operations).toEqual([])
        expect(() => assets.planOwnedAssets({ ...input, strict: true })).toThrow('Missing referenced asset')
        expect(() => assets.planOwnedAssets({ ...input, previousIndex: { schemaVersion: 2, entries: {
            'assets/a': { paths: ['personas/p/assets/portrait.png'] },
        } } })).toThrow('Missing referenced asset')
    })

    it('ignores regex code and malformed speculative text references while preserving explicit and known assets', () => {
        const directory = root()
        const entity = {
            regex: [{ in: 'assets/[\\d+/', out: 'assets/../not-a-reference' }],
            script: 'const matcher = /assets/[a-z]+/; // assets/bad:expression',
            custom: 'assets/real[1].png', image: 'assets/portrait',
        }
        const before = structuredClone(entity)
        const requested: string[] = []
        const plan = assets.planOwnedAssets({ dataRoot: directory, owners: [{ folder: 'characters/c', entity }],
            allAssetKeys: ['assets/real[1].png'], strict: true,
            readAsset: (key: string) => { requested.push(key); return png },
        })
        expect(entity).toEqual(before)
        expect(requested.sort()).toEqual(['assets/portrait', 'assets/real[1].png'])
        expect(plan.index.entries['assets/real[1].png'].paths[0]).toMatch(/^characters\/c\/assets\//)
        expect(() => assets.planOwnedAssets({ dataRoot: directory, readAsset: () => png,
            owners: [{ folder: 'characters/c', entity: { image: 'assets/../outside' } }],
        })).toThrow('Invalid logical asset key')
        expect(() => assets.planOwnedAssets({ dataRoot: directory, readAsset: () => png,
            owners: [{ folder: 'characters/c', entity: { assets: [['image', 'assets/../outside']] } }],
        })).toThrow('Invalid logical asset key')
    })

    it('does not treat prebuilt asset exclusion entries as files that must exist', () => {
        const references = assets.collectReferences({
            image: 'assets/portrait.png',
            prebuiltAssetExclude: [
                'assets/deleted-one.webp',
                'assets/deleted-two.webp',
            ],
        })

        expect([...references.keys()]).toEqual(['assets/portrait.png'])
    })

    it('reads external edits, rejects conflicting replicas and missing files, and plans writes to all copies', () => {
        const directory = root()
        const plan = assets.planOwnedAssets({ dataRoot: directory, readAsset: () => png, owners: [
            { folder: 'characters/c', entity: { image: 'assets/a' } }, { folder: 'personas/p', entity: { image: 'assets/a' } },
        ] })
        publish(directory, plan)
        const [first, second] = plan.index.entries['assets/a'].paths.map((relative: string) => path.join(directory, relative))
        fs.writeFileSync(first, 'edited')
        expect(assets.readOwnedAsset(directory, 'assets/a').toString()).toBe('edited')
        expect(assets.getOwnedAssetSource(directory, 'assets/a')).toBe(first)
        fs.writeFileSync(second, 'competing edit')
        expect(() => assets.readOwnedAsset(directory, 'assets/a')).toThrow('Conflicting owned asset copies')
        fs.writeFileSync(second, 'edited')
        expect(assets.readOwnedAsset(directory, 'assets/a').toString()).toBe('edited')
        expect(assets.ownedAssetOperationsForWrite(directory, 'assets/a', Buffer.from('next'))).toHaveLength(2)
        fs.unlinkSync(second)
        expect(() => assets.readOwnedAsset(directory, 'assets/a')).toThrow('Missing or unreadable owned asset')
        expect(assets.readOwnedAsset(directory, 'assets/unmapped')).toBeNull()
    })

    it('accepts matching edits to multiple replicas and propagates their new baseline on save', () => {
        const directory = root()
        const owners = ['a', 'b', 'c'].map(id => ({ folder: `characters/${id}`, entity: { image: 'assets/a' } }))
        const initial = assets.planOwnedAssets({ dataRoot: directory, owners, readAsset: () => png })
        publish(directory, initial)
        const files = initial.index.entries['assets/a'].paths.map((relative: string) => path.join(directory, relative))
        fs.writeFileSync(files[0], 'matching edit')
        fs.writeFileSync(files[1], 'matching edit')
        expect(assets.readOwnedAsset(directory, 'assets/a').toString()).toBe('matching edit')
        const updated = assets.planOwnedAssets({ dataRoot: directory, owners,
            readAsset: (key: string) => ({ sourcePath: assets.getOwnedAssetSource(directory, key, initial.index) }),
        })
        expect(updated.operations).toHaveLength(1)
        expect(updated.index.entries['assets/a'].checksum).not.toBe(initial.index.entries['assets/a'].checksum)
        publish(directory, updated)
        expect(files.map((file: string) => fs.readFileSync(file, 'utf8'))).toEqual(['matching edit', 'matching edit', 'matching edit'])
        fs.writeFileSync(files[2], 'next edit')
        expect(assets.readOwnedAsset(directory, 'assets/a').toString()).toBe('next edit')
        const noBaseline = structuredClone(updated.index)
        delete noBaseline.entries['assets/a'].checksum
        expect(() => assets.readOwnedAsset(directory, 'assets/a', noBaseline)).toThrow('Conflicting owned asset copies')
    })

    it('streams file-backed sources into operation plans and reuses canonical source paths', () => {
        const directory = root()
        const sourcePath = path.join(directory, 'source')
        fs.writeFileSync(sourcePath, png)
        const input = { dataRoot: directory, owners: [{ folder: 'characters/c', entity: { image: 'assets/a' } }], readAsset: () => ({ sourcePath }) }
        const plan = assets.planOwnedAssets(input)
        expect(plan.operations).toEqual([{ path: 'characters/c/assets/portrait.png', sourcePath, checksumSidecar: false }])
        publish(directory, plan)
        expect(assets.getOwnedAssetSource(directory, 'assets/a', plan.index)).toBe(path.join(directory, 'characters/c/assets/portrait.png'))
        expect(assets.planOwnedAssets(input).operations).toEqual([])
        expect(() => assets.planOwnedAssets({ ...input, readAsset: () => ({ sourcePath: path.join(directory, '../outside') }) })).toThrow('Unsafe owned asset path')
    })

    it('rejects traversal, foreign mappings and symlinked owner folders', () => {
        const directory = root()
        expect(() => assets.planOwnedAssets({ dataRoot: directory, readAsset: () => png, owners: [{ folder: '../outside', entity: { image: 'assets/a' } }] })).toThrow('Unsafe owned asset path')
        expect(() => assets.planOwnedAssets({ dataRoot: directory, readAsset: () => png, owners: [{ folder: 'characters/c', entity: { image: 'assets/../outside' } }] })).toThrow('Invalid logical asset key')
        expect(() => assets.readOwnedAsset(directory, 'assets/a', { schemaVersion: 2, entries: { 'assets/a': { paths: ['settings/app.json'] } } })).toThrow('Invalid owned asset location')
        const outside = root()
        fs.symlinkSync(outside, path.join(directory, 'characters'), process.platform === 'win32' ? 'junction' : 'dir')
        expect(() => assets.planOwnedAssets({ dataRoot: directory, readAsset: () => png, owners: [{ folder: 'characters/c', entity: { image: 'assets/a' } }] })).toThrow('symbolic link')
    })

    it('validates shared asset parents once instead of statting every indexed image', () => {
        const directory = root()
        fs.mkdirSync(path.join(directory, 'shared/assets'), { recursive: true })
        const index = { schemaVersion: 2, entries: Object.fromEntries(Array.from({ length: 100 }, (_, item) => [
            `assets/${item}.png`,
            { paths: [`shared/assets/${item}.png`], checksum: '0'.repeat(64) },
        ])) }
        atomicWriteJson(directory, assets.ASSET_INDEX_PATH, index)
        const originalLstat = fs.lstatSync
        let calls = 0
        vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: any[]) => {
            calls += 1
            return originalLstat(...args as [fs.PathLike])
        }) as typeof fs.lstatSync)

        expect(assets.readOwnedAssetIndex(directory)).toEqual(index)
        expect(calls).toBeLessThan(10)
    })

    it('accepts sibling import sources only within an explicit trusted sourceRoot', () => {
        const trusted = root()
        const directory = path.join(trusted, 'normalized')
        fs.mkdirSync(directory)
        const sourcePath = path.join(trusted, 'incoming.png')
        fs.writeFileSync(sourcePath, png)
        const input = { dataRoot: directory, owners: [{ folder: 'characters/c', entity: { image: 'assets/a' } }], readAsset: () => ({ sourcePath }) }
        expect(() => assets.planOwnedAssets(input)).toThrow('Unsafe owned asset path')
        expect(assets.planOwnedAssets({ ...input, sourceRoot: trusted }).operations).toEqual([{ path: 'characters/c/assets/portrait.png', sourcePath, checksumSidecar: false }])
        expect(() => assets.planOwnedAssets({ ...input, sourceRoot: trusted, owners: [{ folder: '../outside', entity: { image: 'assets/a' } }] })).toThrow('Unsafe owned asset path')
    })
})
