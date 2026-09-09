import { afterEach, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { createFileKv } = require('./file-kv.cjs')
const { readVerifiedJson, recoverTransactions } = require('./file-store.cjs')
const roots: string[] = []

test.each(['bytes', 'file'])('a validated %s asset import publishes only the owner file, not a KV blob', async mode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-import-owned-'))
    roots.push(root)
    const store = createFileKv({ dataRoot: root })
    const bytes = Buffer.from('imported image')
    const sourcePath = path.join(root, 'incoming-image')
    fs.writeFileSync(sourcePath, bytes)
    const key = 'assets/image.png', relative = 'modules/Module/assets/image.png'
    const index = { schemaVersion: 2, entries: { [key]: { paths: [relative] } } }
    await store.kvPublishImportAsync([
        { key: 'database/database.bin', value: Buffer.from('new db') },
        mode === 'bytes' ? { key, value: bytes } : { key, sourcePath },
    ], { importId: 'import-owned', ownedAssetKeys: [key], operations: [
        { path: relative, data: bytes },
        { path: 'settings/asset-files.json', data: Buffer.from(JSON.stringify(index)) },
        { path: 'settings/layout.json', data: Buffer.from(JSON.stringify({ schemaVersion: 2 })) },
    ] })
    const manifest = readVerifiedJson(root, 'kv/manifest.json')
    expect(manifest.entries[key]).toBeUndefined()
    expect(fs.readdirSync(path.join(root, 'kv/objects'))).toHaveLength(1)
    expect(createFileKv({ dataRoot: root }).kvGet(key)).toEqual(bytes)
})

test('asset import elision requires its canonical mapping and file publication', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-import-owned-invalid-'))
    roots.push(root)
    const store = createFileKv({ dataRoot: root })
    await expect(store.kvPublishImportAsync([{ key: 'assets/missing', value: Buffer.from('image') }], {
        importId: 'import-invalid', ownedAssetKeys: ['assets/missing'], operations: [],
    })).rejects.toThrow(/canonical.*asset/i)
    expect(store.kvGet('assets/missing')).toBeNull()
})

test('consumed legacy asset keys can be archived without active KV duplicates', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-import-consumed-'))
    roots.push(root)
    const store = createFileKv({ dataRoot: root })
    const key = 'assets/old', bytes = Buffer.from('old shared baseline')
    const archivePath = `trash/import-consumed/incoming-assets/${'a'.repeat(64)}`
    await store.kvPublishImportAsync([{ key, value: bytes }], {
        importId: 'import-consumed', archivedAssetKeys: { [key]: archivePath }, operations: [{ path: archivePath, data: bytes }],
    })
    expect(store.kvGet(key)).toBeNull()
    expect(fs.readFileSync(path.join(root, archivePath))).toEqual(bytes)
    expect(fs.existsSync(path.join(root, 'kv/objects'))).toBe(false)
})
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))

test('import commits KV and canonical files together and retains old asset objects across GC', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-import-'))
    roots.push(root)
    const store = createFileKv({ dataRoot: root })
    store.kvSet('assets/old', Buffer.from('old asset'))
    await store.kvPublishImportAsync([{ key: 'database/database.bin', value: Buffer.from('new db') }], {
        importId: 'import-test', operations: [{ path: 'settings/app.json', data: Buffer.from('{}') }],
    })
    store.gcChunks()
    const previous = readVerifiedJson(root, 'trash/import-test/kv-manifest.json')
    expect(fs.readFileSync(path.join(root, 'kv/objects', previous.entries['assets/old'].object), 'utf8')).toBe('old asset')
    expect(store.kvGet('assets/old')).toBeNull()
    expect(store.kvGet('database/database.bin').toString()).toBe('new db')
    expect(readVerifiedJson(root, 'settings/app.json')).toEqual({})
})

test('a publication interruption leaves a recoverable journal, not a silently accepted partial import', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-import-'))
    roots.push(root)
    const store = createFileKv({ dataRoot: root })
    store.kvSet('database/database.bin', Buffer.from('old db'))
    await expect(store.kvPublishImportAsync([{ key: 'database/database.bin', value: Buffer.from('new db') }], {
        importId: 'import-crash', operations: [{ path: 'settings/app.json', data: Buffer.from('{}') }],
        transactionOptions: { failAfterPublish: 1 },
    })).rejects.toThrow(/simulated/)
    recoverTransactions(root)
    expect(createFileKv({ dataRoot: root }).kvGet('database/database.bin').toString()).toBe('new db')
    expect(readVerifiedJson(root, 'trash/import-crash/kv-manifest.json').entries['database/database.bin']).toBeTruthy()
})
