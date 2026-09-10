import { afterAll, expect, test } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { normalizeBackup } from './helpers/normalize.js'

const require = createRequire(import.meta.url)
const { createUserDataRepository } = require('../../server/node/user-data-repository.cjs')
const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(server => server.cleanup())) })

async function fixture(corruptUnrelated = false) {
    let root = ''
    const server = await spawnServer({ seedSave: async directory => {
        root = directory
        createUserDataRepository({ dataRoot: root, formatVersion: 2 }).importLegacyDatabase({
            characters: ['a', 'b'].map(id => ({ chaId: id, name: id.toUpperCase(), type: 'character', desc: 'original',
                chats: [{ id: `${id}-chat`, name: 'Chat', message: [{ role: 'user', data: 'preserve me' }] }] })),
            modules: [{ id: 'module-a', name: 'Module', description: 'List description', lorebook: [{ content: 'Not a summary' }] }],
            personas: [], botPresets: [], loreBook: [], temperature: 80,
        }, { mode: 'sync', strictAssets: true })
        if (corruptUnrelated) fs.writeFileSync(path.join(root, 'characters/B/chats/Chat/messages.jsonl'), 'not-json')
    } })
    servers.push(server)
    return { server, root, client: await createClient(server.port, server.password) }
}
const documentUrl = '/api/native/document?kind=character&id=a'
const commit = (client: Awaited<ReturnType<typeof createClient>>, body: unknown) => client.fetch('/api/native/commit', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
function expectNoMonolith(root: string) {
    const manifestPath = path.join(root, 'kv/manifest.json')
    if (!fs.existsSync(manifestPath)) return
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    expect(manifest.entries['database/database.bin']).toBeUndefined()
}

test('native catalog and requested character work without a DB blob or unrelated chat reads', async () => {
    const { root, client } = await fixture(true)
    const catalog = await client.fetch('/api/native/catalog')
    expect(catalog.status).toBe(200)
    expect((await catalog.json()).value.characters.map((c: any) => c.id)).toEqual(['a', 'b'])
    const response = await client.fetch(documentUrl)
    expect(response.status).toBe(200)
    const entity = await response.json()
    expect(entity.value.desc).toBe('original')
    expect(entity.value.chats).toBeUndefined()
    expectNoMonolith(root)
})

test('durable native write changes only its document and survives a new read', async () => {
    const { root, client } = await fixture(true)
    const response = await client.fetch(documentUrl)
    expect(response.status).toBe(200)
    const entity = await response.json()
    const settingsFile = path.join(root, 'settings/app.json')
    const beforeSettings = fs.statSync(settingsFile).mtimeMs
    const saved = await commit(client, { writes: [{ target: entity.target, expectedRevision: entity.revision,
        value: { ...entity.value, desc: 'edited directly' } }] })
    expect(saved.status).toBe(200)
    expect(fs.readFileSync(path.join(root, 'characters/A/description.md'), 'utf8')).toBe('edited directly')
    expect(fs.statSync(settingsFile).mtimeMs).toBe(beforeSettings)
    expect(fs.readFileSync(path.join(root, 'characters/B/chats/Chat/messages.jsonl'), 'utf8')).toBe('not-json')
    expect((await (await client.fetch(documentUrl)).json()).value.desc).toBe('edited directly')
    expectNoMonolith(root)
})

test('external edits are visible and stale same-document writes conflict without overwriting', async () => {
    const { root, client } = await fixture()
    const response = await client.fetch(documentUrl)
    expect(response.status).toBe(200)
    const entity = await response.json()
    fs.writeFileSync(path.join(root, 'characters/A/description.md'), 'external edit')
    expect((await (await client.fetch(documentUrl)).json()).value.desc).toBe('external edit')
    const saved = await commit(client, { writes: [{ target: entity.target, expectedRevision: entity.revision,
        value: { ...entity.value, desc: 'stale browser' } }] })
    expect(saved.status).toBe(409)
    expect(fs.readFileSync(path.join(root, 'characters/A/description.md'), 'utf8')).toBe('external edit')
    expectNoMonolith(root)
})

test('legacy backup export reads current native files without creating a persistent whole DB', async () => {
    const { root, client } = await fixture()
    const response = await client.fetch(documentUrl)
    expect(response.status).toBe(200)
    const entity = await response.json()
    expect((await commit(client, { writes: [{ target: entity.target, expectedRevision: entity.revision,
        value: { ...entity.value, desc: 'native exported' } }] })).status).toBe(200)
    const { raw } = normalizeBackup(await client.exportBackup())
    expect((raw.characters as any[])[0].desc).toBe('native exported')
    expect((raw.characters as any[])[1].chats[0].message[0].data).toBe('preserve me')
    expectNoMonolith(root)
})

test('native endpoints require authentication', async () => {
    const { server } = await fixture()
    const response = await fetch(`http://127.0.0.1:${server.port}/api/native/catalog`)
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('No auth header')
})

test('chat metadata writes preserve unread messages and full chat writes persist independently', async () => {
    const { root, client } = await fixture(true)
    const target = { kind: 'chat', id: 'b-chat', parentId: 'b' }
    const url = '/api/native/document?kind=chat&id=b-chat&parentId=b&metadataOnly=1'
    const metadata = await (await client.fetch(url)).json()
    expect(metadata.metadataOnly).toBe(true)
    expect(metadata.value.message).toBeUndefined()
    expect((await commit(client, { writes: [{ target, expectedRevision: metadata.revision,
        metadataOnly: true, value: { ...metadata.value, note: 'metadata only' } }] })).status).toBe(200)
    expect(fs.readFileSync(path.join(root, 'characters/B/chats/Chat/messages.jsonl'), 'utf8')).toBe('not-json')

    const chat = await (await client.fetch('/api/native/document?kind=chat&id=a-chat&parentId=a')).json()
    const saved = await commit(client, { writes: [{ target: chat.target, expectedRevision: chat.revision,
        value: { ...chat.value, message: [...chat.value.message, { role: 'char', data: 'new reply' }] } }] })
    expect(saved.status).toBe(200)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'characters/A/chats/Chat/messages.jsonl'), 'utf8').trim().split('\n')[1]).data).toBe('new reply')
    expectNoMonolith(root)
})

test('a conflicting multi-document commit cannot partially save valid earlier targets', async () => {
    const { root, client } = await fixture()
    const response = await client.fetch('/api/native/documents', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targets: [
            { kind: 'character', id: 'a' }, { kind: 'character', id: 'b' },
        ] }) })
    expect(response.status).toBe(200)
    const { documents } = await response.json()
    fs.writeFileSync(path.join(root, 'characters/B/description.md'), 'external edit')
    expect((await commit(client, { writes: documents.map((document: any) => ({
        target: document.target, expectedRevision: document.revision, value: { ...document.value, desc: 'browser edit' },
    })) })).status).toBe(409)
    expect(fs.readFileSync(path.join(root, 'characters/A/description.md'), 'utf8')).toBe('original')
    expect(fs.readFileSync(path.join(root, 'characters/B/description.md'), 'utf8')).toBe('external edit')
})

test('invalid batch read items produce a client error, not an internal server failure', async () => {
    const { client } = await fixture()
    const response = await client.fetch('/api/native/documents', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targets: [null] }) })
    expect(response.status).toBe(400)
})

test('backup round trip into a native runtime stays native and preserves every message', async () => {
    const { root, client } = await fixture()
    await client.fetch('/api/native/catalog')
    const backup = await client.exportBackup()
    expect((await client.importBackup(backup)).ok).toBe(true)
    expect((await client.fetch('/api/native/catalog')).status).toBe(200)
    const chat = await (await client.fetch('/api/native/document?kind=chat&id=b-chat&parentId=b')).json()
    expect(chat.value.message).toEqual([{ role: 'user', data: 'preserve me' }])
    expectNoMonolith(root)
})

test('list summaries exclude document bodies and do not require readable chat messages', async () => {
    const { client } = await fixture(true)
    const response = await client.fetch('/api/native/summaries', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targets: [
            { kind: 'character', id: 'b' }, { kind: 'chat', id: 'b-chat', parentId: 'b' },
            { kind: 'module', id: 'module-a' },
        ] }) })
    expect(response.status).toBe(200)
    const { summaries } = await response.json()
    expect(summaries[0]).toMatchObject({ summary: true, value: { chaId: 'b', name: 'B', type: 'character' } })
    expect(summaries[0].value.desc).toBeUndefined()
    expect(summaries[0].revision).toBeUndefined()
    expect(summaries[1].value).toEqual({ id: 'b-chat', name: 'Chat' })
    expect(summaries[2].value).toEqual({ id: 'module-a', name: 'Module', description: 'List description' })
})

const legacyFile = Buffer.from('database/database.bin').toString('hex')
test('acknowledged legacy patches are durable before a native commit invalidates compatibility caches', async () => {
    const { root, client } = await fixture()
    await client.fetch('/api/native/catalog')
    const original = await (await client.fetch(documentUrl)).json()
    const legacy = await client.fetch('/api/read', { headers: { 'file-path': legacyFile } })
    expect(legacy.status).toBe(200)
    const { decodeRisuSave, calculateHash } = require('../../server/node/utils.cjs')
    const expectedHash = calculateHash(await decodeRisuSave(Buffer.from(await legacy.arrayBuffer()))).toString(16)
    const patched = await client.fetch('/api/patch', { method: 'POST', headers: {
        'content-type': 'application/json', 'file-path': legacyFile, 'x-if-match': legacy.headers.get('x-db-etag')!,
    }, body: JSON.stringify({ patch: [{ op: 'replace', path: '/temperature', value: 90 }], expectedHash }) })
    expect(patched.status).toBe(200)
    expect((await commit(client, { writes: [{ target: original.target, expectedRevision: original.revision,
        value: { ...original.value, desc: 'native edit following legacy patch' } }] })).status).toBe(200)
    expect((await (await client.fetch('/api/native/document?kind=settings&id=global')).json()).value.temperature).toBe(90)
    expectNoMonolith(root)
})

test('explicit legacy writes work in native mode while external file changes still conflict', async () => {
    const { root, client } = await fixture()
    await client.fetch('/api/native/catalog')
    const { raw } = normalizeBackup(await client.exportBackup())
    const legacy = await client.fetch('/api/read', { headers: { 'file-path': legacyFile } })
    const { encodeRisuSaveLegacy } = require('../../server/node/utils.cjs')
    const saved = await client.fetch('/api/write', { method: 'POST', headers: {
        'content-type': 'application/octet-stream', 'file-path': legacyFile, 'x-if-match': legacy.headers.get('x-db-etag')!,
    }, body: new Uint8Array(encodeRisuSaveLegacy({ ...raw, temperature: 95 })) })
    expect(saved.status).toBe(200)
    expect((await (await client.fetch('/api/native/document?kind=settings&id=global')).json()).value.temperature).toBe(95)
    const latest = await client.fetch('/api/read', { headers: { 'file-path': legacyFile } })
    fs.writeFileSync(path.join(root, 'characters/A/description.md'), 'external guarded edit')
    const stale = await client.fetch('/api/write', { method: 'POST', headers: {
        'content-type': 'application/octet-stream', 'file-path': legacyFile, 'x-if-match': latest.headers.get('x-db-etag')!,
    }, body: new Uint8Array(encodeRisuSaveLegacy({ ...raw, temperature: 99 })) })
    expect(stale.status).toBe(409)
    expect(fs.readFileSync(path.join(root, 'characters/A/description.md'), 'utf8')).toBe('external guarded edit')
    expectNoMonolith(root)
})
