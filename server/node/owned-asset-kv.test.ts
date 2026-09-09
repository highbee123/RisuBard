import { afterEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { createFileKv } = require('./file-kv.cjs')
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { readOwnedAssetIndex } = require('./owned-assets.cjs')
const { atomicWriteJson } = require('./file-store.cjs')
const roots: string[] = []

test.each(['single', 'bulk', 'async', 'copy'])('V2 %s writes owned images without creating duplicate KV blobs', async mode => {
    const { root, store, files } = fixture()
    const before = fs.readdirSync(path.join(root, 'kv/objects')).sort()
    if (mode === 'single') store.kvSet('assets/portrait.png', Buffer.from('new bytes'))
    if (mode === 'bulk') store.kvSetMany([{ key: 'assets/portrait.png', value: Buffer.from('new bytes') }])
    if (mode === 'async') await store.kvSetManyAsync([{ key: 'assets/portrait.png', value: Buffer.from('new bytes') }])
    if (mode === 'copy') store.kvCopyValue('assets/portrait.png', 'assets/copied.png')
    expect(fs.readdirSync(path.join(root, 'kv/objects')).sort()).toEqual(before)
    const key = mode === 'copy' ? 'assets/copied.png' : 'assets/portrait.png'
    expect(JSON.parse(fs.readFileSync(path.join(root, 'kv/manifest.json'), 'utf8')).entries[key]).toBeUndefined()
    expect(createFileKv({ dataRoot: root }).kvGet(key).toString()).toBe(mode === 'copy' ? 'original' : 'new bytes')
    if (mode !== 'copy') expect(files.map((file: string) => fs.readFileSync(file, 'utf8'))).toEqual(['new bytes'])
})

test('a new V2 image is a standalone file before its owner metadata is saved', async () => {
    const { root, store } = fixture()
    const before = fs.readdirSync(path.join(root, 'kv/objects')).sort()
    await store.kvSetManyAsync([{ key: 'assets/new.png', value: Buffer.from('new image') }])
    const index = readOwnedAssetIndex(root)
    expect(index.entries['assets/new.png']?.paths).toHaveLength(1)
    expect(fs.readFileSync(path.join(root, index.entries['assets/new.png'].paths[0]), 'utf8')).toBe('new image')
    expect(fs.readdirSync(path.join(root, 'kv/objects')).sort()).toEqual(before)
    store.kvSet('config/ordinary', Buffer.from('ordinary KV'))
    expect(createFileKv({ dataRoot: root }).kvGet('config/ordinary').toString()).toBe('ordinary KV')
    store.kvDel('assets/new.png')
    expect(createFileKv({ dataRoot: root }).kvGet('assets/new.png')).toBeNull()
})

test('successive bulk imports reuse the strictly validated asset index from the previous batch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-owned-cache-')); roots.push(root)
    atomicWriteJson(root, 'settings/layout.json', { schemaVersion: 2 })
    atomicWriteJson(root, 'settings/asset-files.json', { schemaVersion: 2, entries: {} })
    const store = createFileKv({ dataRoot: root })
    const indexPath = path.join(root, 'settings/asset-files.json')
    const originalRead = fs.readFileSync
    let indexReads = 0
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => {
        if (typeof file === 'string' && path.resolve(file) === path.resolve(indexPath)) indexReads += 1
        return originalRead(file, ...args as [])
    }) as typeof fs.readFileSync)
    try {
        await store.kvSetManyAsync([{ key: 'assets/first.png', value: Buffer.from('first') }])
        const readsAfterFirstBatch = indexReads
        await store.kvSetManyAsync([{ key: 'assets/second.png', value: Buffer.from('second') }])
        expect(indexReads).toBe(readsAfterFirstBatch)
    } finally {
        readSpy.mockRestore()
    }
})

test.each(['prefix', 'all', 'prefix-async', 'all-async', 'files'])('legacy %s replacement cannot bypass V2 asset publication', async mode => {
    const { root, store } = fixture()
    const before = fs.readFileSync(path.join(root, 'kv/manifest.json'))
    const entry = { key: 'assets/portrait.png', value: Buffer.from('unsafe replacement') }
    const replace = async () => {
        if (mode === 'prefix') return store.kvReplacePrefixes([entry], ['assets/'])
        if (mode === 'all') return store.kvReplaceAll([entry])
        if (mode === 'prefix-async') return store.kvReplacePrefixesAsync([entry], ['assets/'])
        if (mode === 'all-async') return store.kvReplaceAllAsync([entry])
        return store.kvReplacePrefixesFromFilesAsync([{ key: entry.key, sourcePath: path.join(root, 'missing') }], ['assets/'])
    }
    await expect(replace()).rejects.toThrow(/canonical.*import/i)
    expect(fs.readFileSync(path.join(root, 'kv/manifest.json'))).toEqual(before)
    expect(store.kvGet(entry.key).toString()).toBe('original')
})

test('detaching duplicate asset KV references validates files and preserves recovery objects', () => {
    const { root, store, files } = fixture()
    const before = fs.readFileSync(path.join(root, 'kv/manifest.json'))
    expect(store.kvDetachOwnedAssets({ dryRun: true })).toMatchObject({ detached: 1, bytes: 8 })
    expect(fs.readFileSync(path.join(root, 'kv/manifest.json'))).toEqual(before)
    fs.renameSync(files[0], files[0] + '.missing')
    expect(() => store.kvDetachOwnedAssets()).toThrow()
    expect(fs.readFileSync(path.join(root, 'kv/manifest.json'))).toEqual(before)
    fs.renameSync(files[0] + '.missing', files[0])
    expect(store.kvDetachOwnedAssets()).toMatchObject({ detached: 1, bytes: 8 })
    expect(JSON.parse(fs.readFileSync(path.join(root, 'kv/manifest.json'), 'utf8')).entries['assets/portrait.png']).toBeUndefined()
    store.gcChunks()
    expect(store.kvListRecoveryObjects()).toHaveLength(1)
    expect(createFileKv({ dataRoot: root }).kvGet('assets/portrait.png').toString()).toBe('original')
    expect(store.kvDetachOwnedAssets()).toMatchObject({ detached: 0, bytes: 0 })
})

test('explicitly consumed legacy keys detach only after the independent owner files validate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-consumed-kv-')); roots.push(root)
    const store = createFileKv({ dataRoot: root })
    store.kvSet('assets/old', Buffer.from('original'))
    const database = { characters: ['a', 'b'].map(chaId => ({ chaId, name: chaId, image: 'assets/old', chats: [] })), modules: [], personas: [], botPresets: [], loreBook: [] }
    createUserDataRepository({ dataRoot: root, formatVersion: 2 }).importLegacyDatabase(database, { mode: 'replace', strictAssets: true })
    expect(store.kvDetachOwnedAssets({ consumedAssetKeys: ['assets/old'] })).toMatchObject({ detached: 1 })
    expect(store.kvGet('assets/old')).toBeNull()
    expect(store.kvList('assets/')).toHaveLength(2)
    store.gcChunks()
    expect(store.kvListRecoveryObjects()).toHaveLength(1)
})

test('database and configuration KV access does not load the entire asset catalog', () => {
    const { root, store } = fixture()
    store.kvSet('database/database.bin', Buffer.from('database cache'))
    fs.renameSync(path.join(root, 'settings/asset-files.json'), path.join(root, 'settings/asset-files.json.offline'))
    const reopened = createFileKv({ dataRoot: root })
    expect(reopened.kvGet('database/database.bin').toString()).toBe('database cache')
    expect(reopened.kvSize('database/database.bin')).toBe(14)
    expect(reopened.kvGetSourcePath('database/database.bin')).toBeTruthy()
    expect(reopened.kvGetUpdatedAt('database/database.bin')).toEqual(expect.any(Number))
    reopened.kvSet('config/cache', Buffer.from('value'))
    reopened.kvCopyValue('config/cache', 'config/copied')
    expect(reopened.kvList('config/')).toEqual(['config/cache', 'config/copied'])
    reopened.kvDelPrefix('config/')
    expect(reopened.kvList('config/')).toEqual([])
    expect(() => reopened.kvGet('assets/portrait.png')).toThrow(/missing.*asset.*index/i)
})

test('an asset read validates only the requested mapping while full validation stays strict', () => {
    const { root } = fixture()
    const index = readOwnedAssetIndex(root)
    index.entries['assets/unrelated.png'] = { paths: ['../outside/assets/unrelated.png'] }
    atomicWriteJson(root, 'settings/asset-files.json', index)

    const reopened = createFileKv({ dataRoot: root })
    expect(reopened.kvGet('assets/portrait.png').toString()).toBe('original')
    expect(() => reopened.kvGet('assets/unrelated.png')).toThrow(/unsafe owned asset path/i)
    expect(() => readOwnedAssetIndex(root)).toThrow(/unsafe owned asset path/i)
})
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-owned-kv-')); roots.push(root)
    const store = createFileKv({ dataRoot: root })
    store.kvSet('assets/portrait.png', Buffer.from('original'))
    const repository = createUserDataRepository({ dataRoot: root, formatVersion: 2 })
    const database = { characters: ['a'].map(chaId => ({ chaId, name: chaId, image: 'assets/portrait.png', chats: [] })), modules: [], personas: [], botPresets: [], loreBook: [] }
    repository.importLegacyDatabase(database, { mode: 'replace', strictAssets: true })
    const files = readOwnedAssetIndex(root).entries['assets/portrait.png'].paths.map((p: string) => path.join(root, p))
    return { root, store, repository, database, files }
}
test('disk replacements are authoritative for reads, sizes, copies and reopen', () => {
    const { root, store, files } = fixture()
    const stamp = store.kvGetUpdatedAt('assets/portrait.png')
    fs.writeFileSync(files[0], 'replacement image')
    expect(store.kvGet('assets/portrait.png').toString()).toBe('replacement image')
    expect(store.kvSize('assets/portrait.png')).toBe(17)
    expect(store.kvGetUpdatedAt('assets/portrait.png')).not.toBe(stamp)
    store.kvCopyValue('assets/portrait.png', 'assets/copy.png')
    expect(store.kvGet('assets/copy.png').toString()).toBe('replacement image')
    expect(createFileKv({ dataRoot: root }).kvGet('assets/portrait.png').toString()).toBe('replacement image')
})
test('normal app writes update the owner file and advance the external-edit baseline', async () => {
    const { store, files } = fixture()
    store.kvSet('assets/portrait.png', Buffer.from('app edit'))
    expect(files.map((file: string) => fs.readFileSync(file, 'utf8'))).toEqual(['app edit'])
    fs.writeFileSync(files[0], 'disk edit')
    expect(store.kvGet('assets/portrait.png').toString()).toBe('disk edit')
    await store.kvSetManyAsync([{ key: 'assets/portrait.png', value: Buffer.from('bulk edit') }])
    expect(files.map((file: string) => fs.readFileSync(file, 'utf8'))).toEqual(['bulk edit'])
})
test('database save keeps the owner disk edit', () => {
    const { store, files, repository, database } = fixture()
    fs.writeFileSync(files[0], 'disk edit')
    repository.importLegacyDatabase(database, { mode: 'sync', strictAssets: true })
    expect(files.map((file: string) => fs.readFileSync(file, 'utf8'))).toEqual(['disk edit'])
    expect(store.kvGet('assets/portrait.png').toString()).toBe('disk edit')
})
test('missing canonical files never silently fall back to old KV bytes', () => {
    const { store, files } = fixture()
    fs.unlinkSync(files[0])
    expect(() => store.kvGet('assets/portrait.png')).toThrow()
})

test('explicit asset deletion removes mappings and archives every disk replica', () => {
    const { root, store, files } = fixture()
    expect(store.kvDelMany(['assets/portrait.png', 'assets/portrait.png']).count).toBe(1)
    expect(store.kvGet('assets/portrait.png')).toBeNull()
    expect(store.kvList('assets/')).toEqual([])
    expect(files.every((file: string) => !fs.existsSync(file))).toBe(true)
    expect(fs.existsSync(path.join(root, 'trash'))).toBe(true)
    expect(createFileKv({ dataRoot: root }).kvGet('assets/portrait.png')).toBeNull()
})

test('first layout migration pins the previous KV objects for archived legacy metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-layout-pin-')); roots.push(root)
    const store = createFileKv({ dataRoot: root })
    store.kvSet('assets/image.png', Buffer.from('old image'))
    const oldHash = JSON.parse(fs.readFileSync(path.join(root, 'kv/manifest.json'), 'utf8')).entries['assets/image.png'].object
    const db = { characters: [{ chaId: 'a', name: '캐릭터', image: 'assets/image.png', chats: [] }], modules: [], personas: [], botPresets: [], loreBook: [] }
    createUserDataRepository({ dataRoot: root, formatVersion: 1 }).importLegacyDatabase(db, { mode: 'replace' })
    createUserDataRepository({ dataRoot: root, formatVersion: 2 }).importLegacyDatabase(db, { mode: 'sync' })
    store.kvSet('assets/image.png', Buffer.from('new image'))
    store.gcChunks()
    expect(fs.readFileSync(path.join(root, 'kv/objects', oldHash), 'utf8')).toBe('old image')
    expect(store.kvListRecoveryObjects().some((item: any) => item.object === oldHash)).toBe(true)
})
