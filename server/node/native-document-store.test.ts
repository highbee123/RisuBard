import { afterEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { createUserDataRepository } = require('./user-data-repository.cjs')
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })) })
function fixture() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-native-')); roots.push(dataRoot)
    const repository = createUserDataRepository({ dataRoot, formatVersion: 2 })
    repository.importLegacyDatabase({ characters: ['a', 'b'].map(chaId => ({ chaId, name: chaId, desc: 'old', chats: [{ id: 'c', name: 'Chat', message: [{ role: 'user', data: chaId }] }] })), modules: [{ id: 'm', name: 'Module', description: 'old' }], personas: [], botPresets: [], loreBook: [], language: 'en', apiKey: 'secret' }, { mode: 'replace' })
    const store = require('./native-document-store.cjs').createNativeDocumentStore({ dataRoot })
    return { dataRoot, store }
}
const character = (id = 'a') => ({ kind: 'character', id })
const chat = { kind: 'chat', id: 'c', parentId: 'a' }

test('conflicts identify the exact document and latest revision without writing it', () => {
    const { store } = fixture(), old = store.read(character())
    const latest = store.commit({ writes: [{ target: character(), expectedRevision: old.revision, value: { ...old.value, desc: 'external' } }] }).documents[0]
    try {
        store.commit({ writes: [{ target: character(), expectedRevision: old.revision, value: { ...old.value, desc: 'local' } }] })
        expect.fail('must conflict')
    } catch (error) {
        expect(error).toMatchObject({ statusCode: 409, target: character(), currentRevision: latest.revision })
    }
    expect(store.read(character()).value.desc).toBe('external')
})
test('reads only the requested document and accepts external Markdown without checksum adoption', () => {
    const { dataRoot, store } = fixture()
    fs.writeFileSync(path.join(dataRoot, 'characters/b/chats/Chat/metadata.json'), '{broken')
    fs.writeFileSync(path.join(dataRoot, 'characters/a/description.md'), 'external')
    expect(store.read(character()).value.desc).toBe('external')
    expect(store.read(character()).value.chats).toBeUndefined()
})
test('a Markdown-only edit writes only its mapped file and leaves catalog and all assets untouched', () => {
    const { dataRoot, store } = fixture(), old = store.read(character()), cat = store.catalog()
    const writes = vi.spyOn(fs, 'renameSync'), reads = vi.spyOn(fs, 'readFileSync')
    const result = store.commit({ writes: [{ ...old, expectedRevision: old.revision, value: { ...old.value, desc: 'new' } }] })
    const targets = writes.mock.calls.map(call => String(call[1])).filter(value => !value.includes('.journal') && !/\.(sha256|bak)$/.test(value))
    expect(targets).toEqual([path.join(dataRoot, 'characters/a/description.md')])
    expect(result.catalog).toEqual(cat)
    expect(reads.mock.calls.some(call => String(call[0]).includes('asset-files'))).toBe(false)
})
test('settings split secrets, do not inspect assets, and preserve unrelated documents', () => {
    const { store } = fixture(), old = store.read({ kind: 'settings', id: 'global' })
    const reads = vi.spyOn(fs, 'readFileSync')
    store.commit({ writes: [{ target: old.target, expectedRevision: old.revision, value: { ...old.value, language: 'ko' } }] })
    expect(reads.mock.calls.some(call => /asset-files|characters/.test(String(call[0])))).toBe(false)
    expect(store.read(old.target).value).toEqual({ language: 'ko', apiKey: 'secret' })
})
test('same-target byte changes conflict even with original size and mtime; unrelated edits succeed', () => {
    const { dataRoot, store } = fixture(), old = store.read(character()), unrelated = store.read(character('b'))
    const file = path.join(dataRoot, 'characters/a/description.md'), stat = fs.statSync(file)
    fs.writeFileSync(file, 'ext'); fs.utimesSync(file, stat.atime, stat.mtime)
    expect(() => store.commit({ writes: [{ ...old, expectedRevision: old.revision, value: { ...old.value, desc: 'new' } }] })).toThrow(/conflict/i)
    expect(() => store.commit({ writes: [{ ...unrelated, expectedRevision: unrelated.revision, value: { ...unrelated.value, desc: 'new' } }] })).not.toThrow()
})
test('malformed external metadata and ID changes fail without modifying checksum sidecars', () => {
    const { dataRoot, store } = fixture(), file = path.join(dataRoot, 'characters/a/character.json')
    const digest = fs.readFileSync(file + '.sha256', 'utf8')
    fs.writeFileSync(file, JSON.stringify({ chaId: 'wrong', name: 'a' }))
    expect(() => store.read(character())).toThrow(/ID/)
    expect(fs.readFileSync(file + '.sha256', 'utf8')).toBe(digest)
})
test('metadata-only chat save retains messages file and never reads its body', () => {
    const { dataRoot, store } = fixture(), old = store.read(chat, { metadataOnly: true }), file = path.join(dataRoot, 'characters/a/chats/Chat/messages.jsonl')
    const stamp = fs.statSync(file).mtimeMs
    const reads = vi.spyOn(fs, 'readFileSync')
    const result = store.commit({ writes: [{ target: chat, expectedRevision: old.revision, metadataOnly: true, value: { ...old.value, note: 'updated' } }] })
    expect(result.documents[0].value.message).toBeUndefined()
    expect(result.documents[0].metadataOnly).toBe(true)
    expect(reads.mock.calls.some(call => String(call[0]).endsWith('messages.jsonl'))).toBe(false)
    expect(fs.statSync(file).mtimeMs).toBe(stamp)
})

test('metadata-only replacement can clear folder and note fields without restoring old values', () => {
    const { dataRoot, store } = fixture()
    const old = store.read(chat, { metadataOnly: true })
    store.commit({ writes: [{ target: chat, expectedRevision: old.revision, metadataOnly: true,
        value: { ...old.value, folderId: 'folder-a', note: 'old note' } }] })
    const current = store.read(chat, { metadataOnly: true })
    const value = { ...current.value }
    delete value.folderId; delete value.note
    store.commit({ writes: [{ target: chat, expectedRevision: current.revision, metadataOnly: true, value }] })
    const saved = store.read(chat, { metadataOnly: true })
    expect(saved.value.folderId).toBeUndefined()
    expect(saved.value.note).toBeUndefined()
    expect(fs.readFileSync(path.join(dataRoot, 'characters/a/chats/Chat/messages.jsonl'), 'utf8')).toContain('"data":"a"')
})
test('create/delete/reorder requires catalog CAS and never infers deletions from missing IDs or trusts paths', () => {
    const { store } = fixture(), old = store.catalog(), value = structuredClone(old.value)
    value.characters.reverse(); value.characters[0].path = '../../bad'
    store.commit({ writes: [], catalog: { expectedRevision: old.revision, value } })
    expect(store.catalog().value.characters.map((c: any) => c.id)).toEqual(['b', 'a'])
    expect(store.catalog().value.characters[0].path).toBe(old.value.characters[1].path)
    const current = store.catalog(); current.value.characters.pop()
    expect(() => store.commit({ writes: [], catalog: { expectedRevision: current.revision, value: current.value } })).toThrow(/delet/i)
    const mod = { kind: 'module', id: 'new' }
    expect(() => store.commit({ writes: [{ target: mod, expectedRevision: null, value: { id: 'new', name: 'New' } }] })).toThrow(/catalog/i)
    const beforeCreate = store.catalog(); beforeCreate.value.collections.modules.push('new')
    store.commit({ writes: [{ target: mod, expectedRevision: null, value: { id: 'new', name: 'New' } }], catalog: { expectedRevision: beforeCreate.revision, value: beforeCreate.value } })
    const added = store.read(mod), beforeDelete = store.catalog(); beforeDelete.value.collections.modules = ['m']
    store.commit({ writes: [{ target: mod, expectedRevision: added.revision, value: null }], catalog: { expectedRevision: beforeDelete.revision, value: beforeDelete.value } })
    expect(store.catalog().value.collections.modules).toEqual(['m'])
    expect(store.read({ kind: 'settings', id: 'global' }).value.apiKey).toBe('secret')
})
test('renaming migrates drafts and unknown extras and recovery completes a journaled save', () => {
    const { dataRoot, store } = fixture(), old = store.read(character())
    fs.writeFileSync(path.join(dataRoot, 'characters/a/chats/Chat/draft.json'), '{"draft":true}')
    fs.writeFileSync(path.join(dataRoot, 'characters/a/extra.md'), 'retain')
    const cat = store.catalog()
    expect(() => store.commit({ writes: [{ ...old, expectedRevision: old.revision, value: { ...old.value, name: 'Renamed' } }], catalog: { expectedRevision: cat.revision, value: cat.value } }, { failAfterPublish: 1 })).toThrow(/simulated crash/)
    const reopened = require('./native-document-store.cjs').createNativeDocumentStore({ dataRoot })
    expect(reopened.read(character()).value.name).toBe('Renamed')
    expect(fs.readFileSync(path.join(dataRoot, 'characters/Renamed/extra.md'), 'utf8')).toBe('retain')
    expect(fs.existsSync(path.join(dataRoot, 'characters/Renamed/chats/Chat/draft.json'))).toBe(true)
})
test('new foreign owner references are copied independently while same-owner and other mappings survive', () => {
    const { dataRoot, store } = fixture(), old = store.read(character()), indexFile = path.join(dataRoot, 'settings/asset-files.json')
    fs.mkdirSync(path.join(dataRoot, 'characters/b/assets'), { recursive: true })
    fs.writeFileSync(path.join(dataRoot, 'characters/b/assets/portrait.png'), 'original')
    fs.writeFileSync(indexFile, JSON.stringify({ schemaVersion: 2, entries: { 'assets/source.png': { paths: ['characters/b/assets/portrait.png'] }, 'assets/unrelated.png': { paths: ['characters/missing/assets/unrelated.png'] } } }))
    const result = store.commit({ writes: [{ target: old.target, expectedRevision: old.revision, value: { ...old.value, image: 'assets/source.png' } }] })
    const key = result.documents[0].value.image
    expect(key).toMatch(/^assets\/owned-/)
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    expect(index.entries['assets/source.png'].paths).toEqual(['characters/b/assets/portrait.png'])
    expect(index.entries['assets/unrelated.png']).toBeDefined()
    fs.writeFileSync(path.join(dataRoot, 'characters/b/assets/portrait.png'), 'different')
    expect(fs.readFileSync(path.join(dataRoot, index.entries[key].paths[0]), 'utf8')).toBe('original')
    const current = store.read(character()), reads = vi.spyOn(fs, 'readFileSync')
    store.commit({ writes: [{ target: current.target, expectedRevision: current.revision, value: { ...current.value, desc: 'ordinary' } }] })
    expect(reads.mock.calls.some(call => /asset-files|portrait\.png/.test(String(call[0])))).toBe(false)
})
test('an untouched 78000-entry asset index causes zero image walks or index reads', () => {
    const { dataRoot, store } = fixture(), file = path.join(dataRoot, 'settings/asset-files.json')
    const entries = Object.fromEntries(Array.from({ length: 78000 }, (_, index) => [`assets/${index}.png`, { paths: [`characters/unrelated/assets/${index}.png`] }]))
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, entries }))
    const old = store.read({ kind: 'settings', id: 'global' }), reads = vi.spyOn(fs, 'readFileSync'), stats = vi.spyOn(fs, 'lstatSync')
    store.commit({ writes: [{ target: old.target, expectedRevision: old.revision, value: { ...old.value, language: 'fr' } }] })
    expect(reads.mock.calls.some(call => String(call[0]) === file)).toBe(false)
    expect(stats.mock.calls.length).toBeLessThan(100)
})
test('a parent and child rename in one commit retains drafts without resurrecting the previous chat folder', () => {
    const { dataRoot, store } = fixture(), parent = store.read(character()), child = store.read(chat), cat = store.catalog()
    fs.writeFileSync(path.join(dataRoot, 'characters/a/chats/Chat/draft.json'), '{"draft":true}')
    store.commit({ writes: [{ target: child.target, expectedRevision: child.revision, value: { ...child.value, name: 'New chat' } }, { target: parent.target, expectedRevision: parent.revision, value: { ...parent.value, name: 'New parent' } }], catalog: { expectedRevision: cat.revision, value: cat.value } })
    expect(store.read(chat).value.name).toBe('New chat')
    expect(fs.existsSync(path.join(dataRoot, 'characters/New parent/chats/New chat/draft.json'))).toBe(true)
    expect(fs.existsSync(path.join(dataRoot, 'characters/New parent/chats/Chat'))).toBe(false)
})
test('deleting a chat during parent rename does not copy deleted chat into new parent tree', () => {
    const { dataRoot, store } = fixture(), parent = store.read(character()), child = store.read(chat), cat = store.catalog()
    cat.value.characters[0].chats = []
    store.commit({ writes: [{ target: child.target, expectedRevision: child.revision, value: null }, { target: parent.target, expectedRevision: parent.revision, value: { ...parent.value, name: 'New parent' } }], catalog: { expectedRevision: cat.revision, value: cat.value } })
    expect(fs.existsSync(path.join(dataRoot, 'characters/New parent/chats/Chat'))).toBe(false)
})
test('a same-target external edit during staging aborts before journal preparation and keeps external bytes', () => {
    const { dataRoot, store } = fixture(), old = store.read(character()), targetFile = path.join(dataRoot, 'characters/a/description.md')
    const open = fs.openSync.bind(fs); let injected = false
    vi.spyOn(fs, 'openSync').mockImplementation(((file: any, ...args: any[]) => {
        if (!injected && String(file).includes('.stage') && String(file).endsWith('.data')) { injected = true; fs.writeFileSync(targetFile, 'external during staging') }
        return (open as any)(file, ...args)
    }) as any)
    expect(() => store.commit({ writes: [{ target: old.target, expectedRevision: old.revision, value: { ...old.value, desc: 'new' } }] })).toThrow(/conflict/i)
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('external during staging')
    expect(fs.readdirSync(path.join(dataRoot, '.journal'))).toEqual([])
})
test('an unchanged catalog accompanying a simple edit retains its revision and original paths', () => {
    const { store } = fixture(), old = store.read(character()), cat = store.catalog()
    const result = store.commit({ writes: [{ target: old.target, expectedRevision: old.revision, value: { ...old.value, desc: 'updated' } }], catalog: { expectedRevision: cat.revision, value: cat.value } })
    expect(result.catalog).toEqual(cat)
})
test('invalid document shapes cannot prepare a transaction that fails only after publication', () => {
    const { store } = fixture(), old = store.read({ kind: 'settings', id: 'global' })
    expect(() => store.commit({ writes: [{ target: old.target, expectedRevision: old.revision, value: { ...old.value, schemaVersion: 2 } }] })).toThrow(/schema/i)
    expect(store.read(old.target)).toEqual(old)
})
test('metadata-only cannot create a chat without its message file', () => {
    const { dataRoot, store } = fixture()
    const cat = store.catalog(); cat.value.characters[0].chats.push({ id: 'new', name: 'New' })
    expect(() => store.commit({ writes: [{ target: { kind: 'chat', parentId: 'a', id: 'new' }, expectedRevision: null, metadataOnly: true, value: { id: 'new', name: 'New' } }], catalog: { expectedRevision: cat.revision, value: cat.value } })).toThrow(/metadata/i)
    expect(fs.existsSync(path.join(dataRoot, 'characters/a/chats/New'))).toBe(false)
})
test('explicit owner deletion removes only its active asset paths and archives the bytes', () => {
    const { dataRoot, store } = fixture(), old = store.read(character()), cat = store.catalog(), indexFile = path.join(dataRoot, 'settings/asset-files.json')
    fs.mkdirSync(path.join(dataRoot, 'characters/a/assets'), { recursive: true }); fs.writeFileSync(path.join(dataRoot, 'characters/a/assets/icon.png'), 'old owner')
    fs.writeFileSync(indexFile, JSON.stringify({ schemaVersion: 2, entries: { 'assets/deleted.png': { paths: ['characters/a/assets/icon.png'] }, 'assets/other.png': { paths: ['characters/b/assets/other.png'] } } }))
    cat.value.characters = cat.value.characters.filter((c: any) => c.id !== 'a')
    store.commit({ writes: [{ target: old.target, expectedRevision: old.revision, value: null }], catalog: { expectedRevision: cat.revision, value: cat.value } })
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    expect(index.entries['assets/deleted.png']).toBeUndefined()
    expect(index.entries['assets/other.png'].paths).toEqual(['characters/b/assets/other.png'])
    const archived = fs.readdirSync(path.join(dataRoot, 'trash')).find(name => name.startsWith('native-'))!
    expect(fs.readFileSync(path.join(dataRoot, 'trash', archived, 'characters/a/assets/icon.png'), 'utf8')).toBe('old owner')
})
test('foreign assets can be copied while their original owner is deleted in the same transaction', () => {
    const { dataRoot, store } = fixture(), removed = store.read(character('b')), updated = store.read(character()), cat = store.catalog()
    fs.mkdirSync(path.join(dataRoot, 'characters/b/assets'), { recursive: true }); fs.writeFileSync(path.join(dataRoot, 'characters/b/assets/icon.png'), 'transfer')
    fs.writeFileSync(path.join(dataRoot, 'settings/asset-files.json'), JSON.stringify({ schemaVersion: 2, entries: { 'assets/old.png': { paths: ['characters/b/assets/icon.png'] } } }))
    cat.value.characters = cat.value.characters.filter((c: any) => c.id !== 'b')
    store.commit({ writes: [{ target: removed.target, expectedRevision: removed.revision, value: null }, { target: updated.target, expectedRevision: updated.revision, value: { ...updated.value, image: 'assets/old.png' } }], catalog: { expectedRevision: cat.revision, value: cat.value } })
    const key = store.read(character()).value.image, index = JSON.parse(fs.readFileSync(path.join(dataRoot, 'settings/asset-files.json'), 'utf8'))
    expect(index.entries['assets/old.png']).toBeUndefined()
    expect(fs.readFileSync(path.join(dataRoot, index.entries[key].paths[0]), 'utf8')).toBe('transfer')
})
test.each(['edit', 'add', 'delete'])('parent rename rejects an external child %s after staging and retains the source tree', change => {
    const { dataRoot, store } = fixture(), old = store.read(character()), cat = store.catalog()
    const messages = path.join(dataRoot, 'characters/a/chats/Chat/messages.jsonl')
    const draft = path.join(dataRoot, 'characters/a/chats/Chat/draft.json')
    fs.writeFileSync(draft, '{"draft":"original"}')
    const copy = fs.copyFileSync.bind(fs); let injected = false
    vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, flags) => {
        copy(source, destination, flags)
        if (!injected && String(source) === messages && String(destination).includes('.stage')) {
            injected = true
            if (change === 'edit') fs.writeFileSync(messages, '{"role":"user","data":"external edit"}\n')
            else if (change === 'add') fs.writeFileSync(path.join(dataRoot, 'characters/a/new-extra.md'), 'external addition')
            else fs.unlinkSync(draft)
        }
    })
    expect(() => store.commit({ writes: [{ target: old.target, expectedRevision: old.revision, value: { ...old.value, name: 'Renamed' } }], catalog: { expectedRevision: cat.revision, value: cat.value } })).toThrow(/conflict/i)
    expect(injected).toBe(true)
    expect(store.catalog()).toEqual(cat)
    expect(fs.existsSync(path.join(dataRoot, 'characters/Renamed'))).toBe(false)
    expect(fs.readdirSync(path.join(dataRoot, '.journal'))).toEqual([])
    if (change === 'edit') expect(fs.readFileSync(messages, 'utf8')).toContain('external edit')
    else if (change === 'add') expect(fs.readFileSync(path.join(dataRoot, 'characters/a/new-extra.md'), 'utf8')).toBe('external addition')
    else expect(fs.existsSync(draft)).toBe(false)
})
test('summary edits update the current catalog without requiring client catalog CAS', () => {
    const { store } = fixture(), old = store.read(chat), cat = store.catalog()
    const result = store.commit({ writes: [{ target: old.target, expectedRevision: old.revision, value: { ...old.value, name: 'Renamed', lastDate: 42 } }] })
    expect(result.catalog.revision).not.toBe(cat.revision)
    expect(result.catalog.value.characters[0].chats[0]).toMatchObject({ name: 'Renamed', lastDate: 42 })
    expect(result.catalog.value.characters[1]).toEqual(cat.value.characters[1])
})
test.each(['same-owner', 'reused-scope'])('new %s asset references reject missing mapped files before publication', variant => {
    const { dataRoot, store } = fixture(), old = store.read(character()), indexFile = path.join(dataRoot, 'settings/asset-files.json')
    const { checksum } = require('./file-store.cjs')
    const key = 'assets/source.png', entries: any = { [key]: { paths: ['characters/a/assets/missing.png'] } }
    if (variant === 'reused-scope') {
        fs.mkdirSync(path.join(dataRoot, 'characters/b/assets'), { recursive: true }); fs.writeFileSync(path.join(dataRoot, 'characters/b/assets/source.png'), 'source')
        entries[key].paths = ['characters/b/assets/source.png']
        const scoped = `assets/owned-${checksum(Buffer.from(JSON.stringify(['character', 'a']))).slice(0, 16)}-${checksum(Buffer.from(key))}.png`
        entries[scoped] = { paths: ['characters/a/assets/missing.png'] }
    }
    fs.writeFileSync(indexFile, JSON.stringify({ schemaVersion: 2, entries }))
    expect(() => store.commit({ writes: [{ target: old.target, expectedRevision: old.revision, value: { ...old.value, image: key } }] })).toThrow(/missing|unreadable|ENOENT/i)
    expect(store.read(character())).toEqual(old)
})
test('missing imported asset errors identify the logical key and document target', () => {
    const { dataRoot, store } = fixture(), old = store.read(character())
    fs.mkdirSync(path.join(dataRoot, 'kv'), { recursive: true })
    fs.writeFileSync(path.join(dataRoot, 'kv/manifest.json'), JSON.stringify({ schemaVersion: 1, entries: {} }))
    expect(() => store.commit({ writes: [{ target: old.target, expectedRevision: old.revision,
        value: { ...old.value, image: 'assets/imported-but-missing.png' } }] }))
        .toThrow('Missing referenced asset: assets/imported-but-missing.png (character/a)')
})
test('character import preserves prebuilt asset exclusions without requiring deleted files', () => {
    const { store } = fixture(), old = store.read(character())
    const excluded = ['assets/deleted-one.webp', 'assets/deleted-two.webp']
    const result = store.commit({ writes: [{ target: old.target, expectedRevision: old.revision,
        value: { ...old.value, prebuiltAssetExclude: excluded } }] })

    expect(result.documents[0].value.prebuiltAssetExclude).toEqual(excluded)
    expect(store.read(character()).value.prebuiltAssetExclude).toEqual(excluded)
})
test('interrupted rename regenerates derived checksums and recovers without losing standalone sha256 files', () => {
    const { dataRoot, store } = fixture(), old = store.read(character())
    fs.writeFileSync(path.join(dataRoot, 'characters/a/standalone.sha256'), 'user document with no canonical sibling')
    expect(() => store.commit({ writes: [{ target: old.target, expectedRevision: old.revision, value: { ...old.value, name: 'Renamed' } }] }, { failAfterPublish: 2 })).toThrow(/simulated crash/)
    const reopened = require('./native-document-store.cjs').createNativeDocumentStore({ dataRoot })
    expect(reopened.read(character()).value.name).toBe('Renamed')
    expect(fs.existsSync(path.join(dataRoot, 'characters/Renamed/character.json.sha256.sha256'))).toBe(false)
    expect(fs.readFileSync(path.join(dataRoot, 'characters/Renamed/standalone.sha256'), 'utf8')).toBe('user document with no canonical sibling')
    const { checksum } = require('./file-store.cjs')
    expect(fs.readFileSync(path.join(dataRoot, 'characters/Renamed/character.json.sha256'), 'utf8').trim()).toBe(checksum(fs.readFileSync(path.join(dataRoot, 'characters/Renamed/character.json'))))
})
test('chat rename allocates around siblings relocated by a parent rename in the same commit', () => {
    const { dataRoot, store } = fixture(), beforeCreate = store.catalog()
    beforeCreate.value.characters[0].chats.push({ id: 'sibling', name: 'Other' })
    store.commit({ writes: [{ target: { kind: 'chat', id: 'sibling', parentId: 'a' }, expectedRevision: null, value: { id: 'sibling', name: 'Other', message: [{ role: 'user', data: 'sibling body' }] } }], catalog: { expectedRevision: beforeCreate.revision, value: beforeCreate.value } })
    const parent = store.read(character()), child = store.read(chat)
    store.commit({ writes: [{ target: parent.target, expectedRevision: parent.revision, value: { ...parent.value, name: 'Renamed' } }, { target: child.target, expectedRevision: child.revision, value: { ...child.value, name: 'Other' } }] })
    expect(store.catalog().value.characters[0].chats.find((entry: any) => entry.id === 'c').path).toBe('characters/Renamed/chats/Other (2)')
    expect(fs.readFileSync(path.join(dataRoot, 'characters/Renamed/chats/Other/messages.jsonl'), 'utf8')).toContain('sibling body')
    expect(store.read(chat).value.message).toEqual(child.value.message)
})
