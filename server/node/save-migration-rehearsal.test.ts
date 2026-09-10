import { afterAll, afterEach, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
const { createFileKv } = require('./file-kv.cjs')
const { createUserDataRepository } = require('./user-data-repository.cjs')
const moduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-rehearsal-modules-'))
const priorDataRoot = process.env.RISUBARD_DATA_ROOT
process.env.RISUBARD_DATA_ROOT = moduleRoot
const { encodeRisuSaveLegacy } = require('./utils.cjs')
if (priorDataRoot === undefined) delete process.env.RISUBARD_DATA_ROOT
else process.env.RISUBARD_DATA_ROOT = priorDataRoot
afterAll(() => fs.rmSync(moduleRoot, { recursive: true, force: true }))
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))
function hashes(root: string, relative = ''): Record<string, string> {
    return Object.assign({}, ...fs.readdirSync(path.join(root, relative), { withFileTypes: true }).map(entry => {
        const name = path.join(relative, entry.name)
        return entry.isDirectory() ? hashes(root, name) : {
            [name]: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'),
        }
    }))
}
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-rehearsal-')); roots.push(root)
    const source = path.join(root, 'source'), output = path.join(root, 'result')
    const database = { characters: [{ chaId: 'char', name: 'Alice', desc: 'Original description', image: 'assets/image',
        chats: [{ id: 'chat', name: 'First chat', message: [{ role: 'user', data: 'original' }] }] }],
        modules: [], botPresets: [], personas: [], loreBook: [], emptySettings: {} }
    createUserDataRepository({ dataRoot: source }).importLegacyDatabase(database, { mode: 'replace' })
    const store = createFileKv({ dataRoot: source })
    store.kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(database)))
    store.kvSet('assets/image', Buffer.from('original image'))
    const draft = 'characters/char/chats/chat/draft.json'
    fs.writeFileSync(path.join(source, draft), '{"data":"unfinished draft"}')
    return { root, source, output, database, draft }
}
function convertedResult(output: string, database: object) {
    const converted = path.join(output, 'converted')
    const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'))
    expect(report).toMatchObject({ sourceUnchanged: true, wholeDatabaseRoundTrip: true, messages: 1, formatVersion: 2 })
    const repository = createUserDataRepository({ dataRoot: converted, formatVersion: 2 })
    expect(repository.exportLegacyDatabase()).toEqual(database)
    const index = repository.loadSidebarIndex()
    expect(index.schemaVersion).toBe(2)
    const character = index.characters[0]
    expect(character.path.replace(/\\/g, '/')).toBe('characters/Alice')
    expect(fs.readFileSync(path.join(converted, character.path, 'description.md'), 'utf8')).toBe('Original description')
    expect(fs.readFileSync(path.join(converted, character.chats[0].path, 'draft.json'), 'utf8')).toBe('{"data":"unfinished draft"}')
    expect(fs.existsSync(path.join(converted, 'characters/char'))).toBe(false)
    const archive = fs.readdirSync(path.join(converted, 'trash')).find(name => name.startsWith('layout-'))!
    expect(fs.readFileSync(path.join(converted, 'trash', archive, 'characters/char/chats/chat/draft.json'), 'utf8')).toBe('{"data":"unfinished draft"}')
    const assetIndex = JSON.parse(fs.readFileSync(path.join(converted, 'settings/asset-files.json'), 'utf8'))
    const asset = assetIndex.entries['assets/image']
    expect(asset).toBeDefined()
    expect(asset.paths[0]).toMatch(/^characters\/Alice\/assets\//)
    expect(fs.readFileSync(path.join(converted, asset.paths[0]), 'utf8')).toBe('original image')
    expect(createFileKv({ dataRoot: converted }).kvGet('assets/image').toString()).toBe('original image')
    expect(JSON.parse(fs.readFileSync(path.join(converted, 'kv/manifest.json'), 'utf8')).entries['assets/image']).toBeUndefined()
}

test('offline rehearsal preserves source bytes and migrates owned assets and drafts before archiving the ID tree', () => {
    const { source, output, database } = fixture()
    const before = hashes(source)
    execFileSync(process.execPath, [path.resolve('scripts/rehearse-save-migration.cjs'), source, output])
    expect(hashes(source)).toEqual(before)
    convertedResult(output, database)
})

test('rehearsal separates identical references belonging to different owners without retaining active KV asset entries', () => {
    const { source, output, database } = fixture()
    const input = { ...database, modules: [{ id: 'module', name: 'Module', assets: [['portrait', 'assets/image']] }] }
    createUserDataRepository({ dataRoot: source }).importLegacyDatabase(input, { mode: 'sync' })
    createFileKv({ dataRoot: source }).kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(input)))
    const before = hashes(source)
    execFileSync(process.execPath, [path.resolve('scripts/rehearse-save-migration.cjs'), source, output], { stdio: 'pipe' })
    const root = path.join(output, 'converted'), store = createFileKv({ dataRoot: root })
    const result = createUserDataRepository({ dataRoot: root }).exportLegacyDatabase()
    expect(result.characters[0].image).not.toBe(result.modules[0].assets[0][1])
    expect(store.kvGet(result.characters[0].image).toString()).toBe('original image')
    expect(store.kvGet(result.modules[0].assets[0][1]).toString()).toBe('original image')
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'kv/manifest.json'), 'utf8')).entries).filter(key => key.startsWith('assets/'))).toEqual([])
    expect(hashes(source)).toEqual(before)
})

test('reuses an isolated snapshot without writing its KV migration marker or changing any bytes', () => {
    const { root, source, output, database } = fixture()
    const snapshot = path.join(root, 'snapshot')
    fs.cpSync(source, snapshot, { recursive: true })
    fs.rmSync(path.join(snapshot, 'migration'), { recursive: true, force: true })
    const sourceBefore = hashes(source), snapshotBefore = hashes(snapshot)
    execFileSync(process.execPath, [path.resolve('scripts/rehearse-save-migration.cjs'), '--reuse-snapshot', snapshot, output])
    expect(hashes(source)).toEqual(sourceBefore)
    expect(hashes(snapshot)).toEqual(snapshotBefore)
    expect(fs.existsSync(path.join(output, 'snapshot'))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'))).toMatchObject({ reusedSnapshot: true, snapshot })
    convertedResult(output, database)
})

test('refuses existing output directories before touching the source', () => {
    const { source, output } = fixture()
    fs.mkdirSync(output)
    fs.writeFileSync(path.join(output, 'keep.txt'), 'keep')
    const before = hashes(source)
    expect(() => execFileSync(process.execPath, [path.resolve('scripts/rehearse-save-migration.cjs'), source, output], { stdio: 'pipe' })).toThrow()
    expect(hashes(source)).toEqual(before)
    expect(fs.readFileSync(path.join(output, 'keep.txt'), 'utf8')).toBe('keep')
})

test('explicitly confirmed deleted modules stay excluded through conversion and index recovery', () => {
    const { source, output, database } = fixture()
    const input = { ...database, modules: [{ id: 'deleted', name: 'Deleted', assets: [['missing', 'assets/missing.png', 'png']] }, { id: 'keep', name: 'Keep' }],
        enabledModules: ['deleted', 'keep'], collectionOrganizers: { modules: { itemOrder: ['deleted', 'keep'], folderByItemId: { deleted: 'folder', keep: 'folder' } } } }
    createUserDataRepository({ dataRoot: source }).importLegacyDatabase(input, { mode: 'sync' })
    createFileKv({ dataRoot: source }).kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(input)))
    const before = hashes(source)
    execFileSync(process.execPath, [path.resolve('scripts/rehearse-save-migration.cjs'), '--exclude-module-id', 'deleted', source, output], { stdio: 'pipe' })
    expect(hashes(source)).toEqual(before)
    const root = path.join(output, 'converted')
    const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'))
    expect(report.confirmedModuleDeletions).toEqual([{ id: 'deleted', name: 'Deleted' }])
    let repo = createUserDataRepository({ dataRoot: root })
    const expected = { ...input, modules: [input.modules[1]], enabledModules: ['keep'],
        collectionOrganizers: { modules: { itemOrder: ['keep'], folderByItemId: { keep: 'folder' } } } }
    expect(repo.exportLegacyDatabase()).toEqual(expected)
    // Orphan files and old archived revisions are not active membership.
    fs.copyFileSync(path.join(source, 'modules/deleted.json'), path.join(root, 'modules/deleted.json'))
    fs.unlinkSync(path.join(root, 'index/sidebar.json'))
    repo = createUserDataRepository({ dataRoot: root })
    expect(repo.exportLegacyDatabase()).toEqual(expected)
    repo.importLegacyDatabase(expected, { mode: 'sync', strictAssets: true })
    expect(createUserDataRepository({ dataRoot: root }).exportLegacyDatabase()).toEqual(expected)
})

test('an unknown explicit deletion ID is rejected rather than silently dropping something else', () => {
    const { source, output } = fixture()
    const before = hashes(source)
    expect(() => execFileSync(process.execPath, [path.resolve('scripts/rehearse-save-migration.cjs'), '--exclude-module-id', 'unknown', source, output], { stdio: 'pipe' })).toThrow()
    expect(hashes(source)).toEqual(before)
    expect(fs.existsSync(path.join(output, 'converted/settings/layout.json'))).toBe(false)
})
