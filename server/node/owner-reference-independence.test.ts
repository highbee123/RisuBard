import { afterEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { readOwnedAssetIndex, readOwnedAsset } = require('./owned-assets.cjs')
const { atomicWriteJson } = require('./file-store.cjs')
const roots: string[] = []
const root = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-ref-')); roots.push(value); return value }
afterEach(() => { vi.restoreAllMocks(); for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }) })
const database = () => ({ characters: [{ chaId: 'c', name: 'C', image: 'assets/shared.png', chats: [{ id: 'chat', name: 'Chat', message: [{ data: '<img src="assets/shared.png"> assets/shared.png-extra https://host/assets/shared.png' }] }] }],
    personas: [{ id: 'p', name: 'P', image: 'assets/shared.png' }], modules: [], botPresets: [], loreBook: [], unknown: { preserve: 'verbatim' } })

test('shared owner references become independent without changing caller data or unrelated embedded text', () => {
    const dataRoot = root(), input = database(), before = structuredClone(input)
    const repository = createUserDataRepository({ dataRoot, formatVersion: 2, readAsset: () => Buffer.from('image') })
    const result = repository.importLegacyDatabase(input, { mode: 'sync' })
    const restored = repository.exportLegacyDatabase()
    expect(restored.characters[0].image).not.toBe(restored.personas[0].image)
    expect(input).toEqual(before)
    expect(result.database).toEqual(restored)
    expect(restored.characters[0].chats[0].message[0].data).toBe(`<img src="${restored.characters[0].image}"> assets/shared.png-extra https://host/assets/shared.png`)
    expect(restored.unknown).toEqual(input.unknown)
    const index = readOwnedAssetIndex(dataRoot)
    expect(index.entries[restored.characters[0].image].paths).toHaveLength(1)
    expect(index.entries[restored.personas[0].image].paths).toHaveLength(1)
})

test('legacy owner files retain different external edits through migration and renaming', () => {
    const dataRoot = root(), input = database()
    const repository = createUserDataRepository({ dataRoot, formatVersion: 2, readAsset: () => Buffer.from('original') })
    repository.importLegacyDatabase(input, { mode: 'sync' })
    const index = repository.loadSidebarIndex()
    const paths = [`${index.characters[0].path.replace(/\\/g, '/')}/assets/portrait.png`, `${index.paths.personas.p.replace(/\\/g, '/')}/assets/portrait.png`]
    paths.forEach((file, i) => fs.writeFileSync(path.join(dataRoot, file), `edit-${i}`))
    atomicWriteJson(dataRoot, 'settings/asset-files.json', { schemaVersion: 2, entries: { 'assets/shared.png': { paths } } })
    input.characters[0].name = 'Renamed'
    const diskRepository = createUserDataRepository({ dataRoot, formatVersion: 2 })
    const next = diskRepository.importLegacyDatabase(input, { mode: 'sync' }).database
    expect(readOwnedAsset(dataRoot, next.characters[0].image).toString()).toBe('edit-0')
    expect(readOwnedAsset(dataRoot, next.personas[0].image).toString()).toBe('edit-1')
    const reopened = createUserDataRepository({ dataRoot })
    expect(reopened.exportLegacyDatabase()).toEqual(next)
})

test('a cloned scoped reference gets its own key, while repeat saves and renames remain stable', () => {
    const dataRoot = root()
    const initial = createUserDataRepository({ dataRoot, formatVersion: 2, readAsset: () => Buffer.from('original') })
        .importLegacyDatabase(database(), { mode: 'sync' }).database
    const repository = createUserDataRepository({ dataRoot, formatVersion: 2 })
    const clone = structuredClone(initial.characters[0]); clone.chaId = 'clone'; clone.name = 'Clone'; initial.characters.push(clone)
    const saved = repository.importLegacyDatabase(initial, { mode: 'sync' }).database
    expect(saved.characters[1].image).not.toBe(saved.characters[0].image)
    const image = saved.characters[1].image
    saved.characters[1].name = 'Renamed clone'
    expect(repository.importLegacyDatabase(saved, { mode: 'sync' }).database.characters[1].image).toBe(image)
})

test('global references retain the original shared file while owners remain independent', () => {
    const dataRoot = root(), input = { ...database(), background: 'assets/shared.png' }
    const initial = createUserDataRepository({ dataRoot, formatVersion: 2, readAsset: () => Buffer.from('original') })
        .importLegacyDatabase(input, { mode: 'sync' }).database
    expect(initial.background).toBe('assets/shared.png')
    expect(readOwnedAssetIndex(dataRoot).entries[initial.background].paths).toHaveLength(1)
    const repository = createUserDataRepository({ dataRoot, formatVersion: 2 })
    expect(repository.importLegacyDatabase(initial, { mode: 'sync' }).database).toEqual(initial)
})

test('stale legacy references resolve to each existing owner after their files diverge', () => {
    const dataRoot = root(), input = database()
    const initial = createUserDataRepository({ dataRoot, formatVersion: 2, readAsset: () => Buffer.from('original') })
        .importLegacyDatabase(input, { mode: 'sync' }).database
    const index = readOwnedAssetIndex(dataRoot)
    fs.writeFileSync(path.join(dataRoot, index.entries[initial.characters[0].image].paths[0]), 'character edit')
    fs.writeFileSync(path.join(dataRoot, index.entries[initial.personas[0].image].paths[0]), 'persona edit')
    const next = createUserDataRepository({ dataRoot, formatVersion: 2 }).importLegacyDatabase(input, { mode: 'sync' }).database
    expect(next.characters[0].image).toBe(initial.characters[0].image)
    expect(readOwnedAsset(dataRoot, next.characters[0].image).toString()).toBe('character edit')
    expect(readOwnedAsset(dataRoot, next.personas[0].image).toString()).toBe('persona edit')
})

test('direct JavaScript callers may share nested objects without coupling owner reference rewrites', () => {
    const dataRoot = root(), input: any = database(), shared = { image: 'assets/shared.png' }
    input.characters[0].extension = shared
    input.personas[0].extension = shared
    const saved = createUserDataRepository({ dataRoot, formatVersion: 2, readAsset: () => Buffer.from('image') })
        .importLegacyDatabase(input, { mode: 'sync' }).database
    expect(saved.characters[0].extension.image).toBe(saved.characters[0].image)
    expect(saved.personas[0].extension.image).toBe(saved.personas[0].image)
    expect(shared.image).toBe('assets/shared.png')
})

test('assigning a shared upload to its first owner retires only the redundant indexed image', () => {
    const dataRoot = root(), empty = { characters: [], personas: [], modules: [], botPresets: [], loreBook: [] }
    const repository = createUserDataRepository({ dataRoot, formatVersion: 2 })
    repository.importLegacyDatabase(empty, { mode: 'sync' })
    const store = require('./file-kv.cjs').createFileKv({ dataRoot })
    store.kvSet('assets/upload.png', Buffer.from('image'))
    const oldPath = readOwnedAssetIndex(dataRoot).entries['assets/upload.png'].paths[0]
    fs.writeFileSync(path.join(dataRoot, `${oldPath}.bak`), 'previous revision')
    const unrelated = path.join(dataRoot, 'shared/assets/unrelated.png'); fs.writeFileSync(unrelated, 'unrelated')
    const saved = repository.importLegacyDatabase({ ...empty, personas: [{ id: 'p', name: 'P', image: 'assets/upload.png' }] }, { mode: 'sync' }).database
    expect(fs.existsSync(path.join(dataRoot, oldPath))).toBe(false)
    expect(fs.readFileSync(path.join(dataRoot, `${oldPath}.bak`), 'utf8')).toBe('previous revision')
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('unrelated')
    expect(readOwnedAsset(dataRoot, saved.personas[0].image).toString()).toBe('image')
    const active = readOwnedAssetIndex(dataRoot).entries[saved.personas[0].image].paths
    expect(active).toHaveLength(1)
    expect(active[0]).toMatch(/^personas\/P\/assets\//)
})

test('selecting a persona can point the global avatar at its scoped icon without losing its source', () => {
    const dataRoot = root(), input = { characters: [], personas: [{ id: 'p', name: 'P', icon: 'assets/a.png' }],
        modules: [], botPresets: [], loreBook: [], userIcon: 'assets/a.png' }
    const initial = createUserDataRepository({ dataRoot, formatVersion: 2, readAsset: () => Buffer.from('avatar') })
        .importLegacyDatabase(input, { mode: 'sync', strictAssets: true }).database
    initial.userIcon = initial.personas[0].icon
    const repository = createUserDataRepository({ dataRoot, formatVersion: 2 })
    const saved = repository.importLegacyDatabase(initial, { mode: 'sync', strictAssets: true }).database
    expect(saved.userIcon).toBe(saved.personas[0].icon)
    expect(repository.importLegacyDatabase(saved, { mode: 'sync', strictAssets: true }).database).toEqual(saved)
    const index = readOwnedAssetIndex(dataRoot)
    expect(index.entries[saved.userIcon].paths).toHaveLength(1)
    fs.writeFileSync(path.join(dataRoot, index.entries[saved.userIcon].paths[0]), 'edited avatar')
    expect(readOwnedAsset(dataRoot, saved.userIcon).toString()).toBe('edited avatar')
})

test('initial migration keeps the selected persona avatar linked and preserves unrelated custom avatars', () => {
    const dataRoot = root(), input = { characters: [], personas: [
        { id: 'p', name: 'P', icon: 'assets/a.png' }, { id: 'other', name: 'Other', icon: 'assets/a.png' },
    ], modules: [], botPresets: [], loreBook: [], selectedPersona: 0, userIcon: 'assets/a.png' }
    const saved = createUserDataRepository({ dataRoot, formatVersion: 2, readAsset: () => Buffer.from('avatar') })
        .importLegacyDatabase(input, { mode: 'sync', strictAssets: true }).database
    expect(saved.userIcon).toBe(saved.personas[0].icon)
    expect(saved.userIcon).not.toBe(saved.personas[1].icon)
    const index = readOwnedAssetIndex(dataRoot)
    expect(index.entries['assets/a.png']).toBeUndefined()
    fs.writeFileSync(path.join(dataRoot, index.entries[saved.personas[0].icon].paths[0]), 'selected avatar edit')
    expect(readOwnedAsset(dataRoot, saved.userIcon).toString()).toBe('selected avatar edit')
    const customRoot = root()
    const custom = createUserDataRepository({ dataRoot: customRoot, formatVersion: 2, readAsset: () => Buffer.from('avatar') })
        .importLegacyDatabase({ ...input, userIcon: 'assets/custom.png' }, { mode: 'sync', strictAssets: true }).database
    expect(custom.userIcon).toBe('assets/custom.png')
})

test('retirement does not rescan a large owner-only asset catalog for every old entry', () => {
    const dataRoot = root(), empty = { characters: [], personas: [], modules: [], botPresets: [], loreBook: [] }
    const repository = createUserDataRepository({ dataRoot, formatVersion: 2 })
    repository.importLegacyDatabase(empty, { mode: 'sync' })
    const entries = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`assets/${i}.png`, { paths: [`characters/C/assets/${i}.png`], checksum: 'a'.repeat(64) }]))
    const owned = require('./owned-assets.cjs')
    vi.spyOn(owned, 'readOwnedAssetIndex').mockReturnValue({ schemaVersion: 2, entries })
    let enumerations = 0
    const nextEntries = new Proxy(entries, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target) } })
    vi.spyOn(owned, 'planOwnedAssets').mockReturnValue({ operations: [], index: { schemaVersion: 2, entries: nextEntries } })
    repository.importLegacyDatabase(empty, { mode: 'sync' })
    expect(enumerations).toBeLessThanOrEqual(3)
})
