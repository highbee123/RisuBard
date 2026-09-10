import { afterAll, expect, test } from 'vitest'
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeBackup } from './helpers/decode.js'
import { zipSync } from 'fflate'

const require = createRequire(import.meta.url)
const { encodeRisuSaveLegacy, decodeRisuSave } = require('../../server/node/utils.cjs')
const { createUserDataRepository } = require('../../server/node/user-data-repository.cjs')
const { createFileKv } = require('../../server/node/file-kv.cjs')
const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(server => server.cleanup())) })
const fileHeaders = { 'file-path': Buffer.from('database/database.bin').toString('hex') }
const database = {
    language: 'ko', botPresets: [{ id: 'preset-1', name: 'Prompt' }],
    modules: [{ id: 'module-1', name: 'Module' }], personas: [], loreBook: [],
    characters: [{ chaId: 'char-1', name: 'Character', chats: [
        { id: 'chat-1', name: 'Chat', message: [{ role: 'user', data: 'Preserved message' }] },
    ] }],
}

test.each(['backup', 'save-folder', 'save-folder-path'])('%s publishes complete entity files immediately and rejects incomplete replacements', async route => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const upload = async (db: any) => {
        const bytes = Buffer.from(encodeRisuSaveLegacy(db))
        if (route === 'backup') return client.importBackup(encodeBackup([
            { name: 'database.risudat', data: bytes },
            { name: Buffer.from('test.png').toString('hex'), data: Buffer.from('preserved asset') },
        ]))
        if (route === 'save-folder-path') {
            const source = path.join(server.cwd, 'legacy-source')
            fs.mkdirSync(source, { recursive: true })
            const file = path.join(source, fileHeaders['file-path'])
            fs.writeFileSync(file, bytes)
            const response = await client.fetch('/api/migrate/save-folder/execute', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: source }),
            })
            expect(fs.readFileSync(file)).toEqual(bytes)
            return response.json()
        }
        const response = await client.fetch('/api/migrate/save-folder/upload', {
            method: 'POST', headers: { 'content-type': 'application/zip' },
            body: zipSync({ [fileHeaders['file-path']]: bytes,
                [Buffer.from('assets/test.png').toString('hex')]: Buffer.from('preserved asset') }),
        })
        return response.json()
    }
    expect((await upload(database)).ok).toBe(true)
    const root = path.join(server.cwd, 'save')
    // Inspect before any read/export route can lazily repair the imported format.
    expect(fs.existsSync(path.join(root, 'characters/Character/chats/Chat/messages.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'characters/char-1'))).toBe(false)
    const before = createUserDataRepository({ dataRoot: root }).exportLegacyDatabase()
    const manifest = fs.readFileSync(path.join(root, 'kv/manifest.json'))
    const invalid = structuredClone(database)
    delete (invalid.characters[0].chats[0] as any).message
    expect((await upload(invalid)).ok).not.toBe(true)
    expect(createUserDataRepository({ dataRoot: root }).exportLegacyDatabase()).toEqual(before)
    expect(fs.readFileSync(path.join(root, 'kv/manifest.json'))).toEqual(manifest)
})

test.each(['corrupt-jsonl', 'conflicting-native-data', 'forbidden-root'])('rejects %s in native backups before changing the active save', async kind => {
    const server = await spawnServer(); servers.push(server)
    const client = await createClient(server.port, server.password)
    expect((await client.importBackup(encodeBackup([{ name: 'database.risudat', data: Buffer.from(encodeRisuSaveLegacy(database)) }]))).ok).toBe(true)
    const entries = decodeBackup(await client.exportBackup())
    const root = path.join(server.cwd, 'save')
    const before = fs.readFileSync(path.join(root, 'kv/manifest.json'))
    if (kind === 'forbidden-root') entries.push({ name: 'risubard-data/__password', data: Buffer.from('replacement') })
    else {
        const body = entries.find(entry => entry.name.endsWith('messages.jsonl'))!
        body.data = Buffer.from(kind === 'corrupt-jsonl' ? '{' : JSON.stringify({ role: 'char', data: 'different body' }) + '\n')
    }
    expect((await client.importBackup(encodeBackup(entries))).ok).not.toBe(true)
    expect(fs.readFileSync(path.join(root, 'kv/manifest.json'))).toEqual(before)
    expect(createUserDataRepository({ dataRoot: root }).exportLegacyDatabase().characters).toEqual(database.characters)
})

test('portable backups retain prior revisions and archived asset objects on a fresh installation', async () => {
    let oldHash: string
    const server = await spawnServer({ seedSave: async dataRoot => {
        const legacy = createFileKv({ dataRoot })
        legacy.kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(database)))
        legacy.kvSet('assets/old-asset', Buffer.from('old-asset'))
        oldHash = JSON.parse(fs.readFileSync(path.join(dataRoot, 'kv/manifest.json'), 'utf8')).entries['assets/old-asset'].object
        createUserDataRepository({ dataRoot, formatVersion: 2 }).importLegacyDatabase(database, { mode: 'replace' })
    } }); servers.push(server)
    const client = await createClient(server.port, server.password)
    const payload = (asset: string) => encodeBackup([
        { name: 'database.risudat', data: Buffer.from(encodeRisuSaveLegacy(database)) },
        { name: Buffer.from(asset).toString('hex'), data: Buffer.from(asset) },
    ])
    const root = path.join(server.cwd, 'save')
    expect((await client.importBackup(payload('new-asset'))).ok).toBe(true)
    const revision = Buffer.from('preserved original revision')
    fs.writeFileSync(path.join(root, 'settings/app.json.bak'), revision)
    const backup = await client.exportBackup()
    const destination = await spawnServer(); servers.push(destination)
    const destinationClient = await createClient(destination.port, destination.password)
    expect((await destinationClient.importBackup(backup)).ok).toBe(true)
    const destinationRoot = path.join(destination.cwd, 'save')
    expect(fs.readFileSync(path.join(destinationRoot, 'settings/app.json.bak'))).toEqual(revision)
    createFileKv({ dataRoot: destinationRoot }).gcChunks()
    expect(fs.readFileSync(path.join(destinationRoot, 'kv/objects', oldHash), 'utf8')).toBe('old-asset')
})

test.each(['missing-module-list', 'unresolved-chat-stub'])('a rejected %s HTTP save preserves canonical data and the cache', async kind => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const write = (value: any) => client.fetch('/api/write', {
        method: 'POST', headers: { ...fileHeaders, 'content-type': 'application/octet-stream' },
        body: new Uint8Array(encodeRisuSaveLegacy(value)),
    })
    expect((await write(database)).ok).toBe(true)
    const read = await client.fetch('/api/read', { headers: fileHeaders })
    expect(read.ok).toBe(true)
    const incomplete = await decodeRisuSave(Buffer.from(await read.arrayBuffer()))
    if (kind === 'missing-module-list') delete incomplete.modules
    else incomplete.characters[0].chats[0].id = 'unknown-chat'
    expect((await write(incomplete)).ok).toBe(false)
    // Read actual on-disk KV bytes, independently of server memory.
    const dataRoot = path.join(server.cwd, 'save')
    const manifest = JSON.parse(fs.readFileSync(path.join(dataRoot, 'kv/manifest.json'), 'utf8'))
    const entry = manifest.entries['database/database.bin']
    const persisted = await decodeRisuSave(fs.readFileSync(path.join(dataRoot, 'kv/objects', entry.object)))
    expect(persisted.modules).toEqual(database.modules)
    expect(createUserDataRepository({ dataRoot }).exportLegacyDatabase().modules).toEqual(database.modules)
    expect(persisted.characters[0].chats[0].message).toEqual(database.characters[0].chats[0].message)
    const after = await client.fetch('/api/read', { headers: fileHeaders })
    expect(after.ok).toBe(true)
    const visible = await decodeRisuSave(Buffer.from(await after.arrayBuffer()))
    expect(visible.modules).toEqual(database.modules)
    expect(visible.characters[0].chats[0].id).toBe('chat-1')
})

test('boots from canonical folders when both the sidebar and compatibility cache are absent', async () => {
    const server = await spawnServer({ seedSave: async dataRoot => {
        createUserDataRepository({ dataRoot, formatVersion: 2 }).importLegacyDatabase(database, { mode: 'replace' })
        fs.unlinkSync(path.join(dataRoot, 'index/sidebar.json'))
    } })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const response = await client.fetch('/api/read', { headers: fileHeaders })
    expect(response.ok).toBe(true)
    const recoveredBytes = Buffer.from(await response.arrayBuffer())
    expect(recoveredBytes.length).toBeGreaterThan(0)
    const recovered = await decodeRisuSave(recoveredBytes)
    expect(recovered.characters[0]?.chaId).toBe('char-1')
    expect(recovered.modules).toEqual(database.modules)
    expect(recovered.botPresets).toEqual(database.botPresets)
})

test('imports owner-local images, serves disk edits with revalidation, and preserves native drafts and revisions', async () => {
    const server = await spawnServer(); servers.push(server)
    const client = await createClient(server.port, server.password)
    const db: any = structuredClone(database)
    db.characters[0].image = 'assets/portrait.png'
    db.modules[0].assets = [['공유 이미지', 'assets/portrait.png']]
    const original = Buffer.from('original image')
    expect(await client.importBackup(encodeBackup([
        { name: 'database.risudat', data: Buffer.from(encodeRisuSaveLegacy(db)) },
        { name: 'portrait.png', data: original },
        { name: 'unused.png', data: Buffer.from('unowned image') },
    ]))).toMatchObject({ ok: true })
    const dataRoot = path.join(server.cwd, 'save')
    const index = JSON.parse(fs.readFileSync(path.join(dataRoot, 'settings/asset-files.json'), 'utf8'))
    const canonical = createUserDataRepository({ dataRoot }).exportLegacyDatabase()
    const portraitKey = canonical.characters[0].image
    const moduleKey = canonical.modules[0].assets[0][1]
    expect(portraitKey).not.toBe(moduleKey)
    for (const key of [portraitKey, moduleKey]) {
        expect(index.entries[key].paths).toHaveLength(1)
        expect(fs.readFileSync(path.join(dataRoot, index.entries[key].paths[0]))).toEqual(original)
    }
    expect(index.entries['assets/unused.png'].paths[0]).toBe('shared/assets/unused.png')
    const assetUrl = `/api/asset/${Buffer.from(portraitKey).toString('hex')}`
    const cookie = (await client.fetch('/api/session', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0]
    const first = await client.fetch(assetUrl, { headers: { cookie } })
    expect(first.headers.get('cache-control')).toBe('no-cache')
    expect(Buffer.from(await first.arrayBuffer())).toEqual(original)
    const unchanged = await client.fetch(assetUrl, { headers: { cookie, 'if-none-match': first.headers.get('etag')! } })
    expect(unchanged.status).toBe(304)
    expect(unchanged.headers.get('cache-control')).toBe('no-cache')
    fs.writeFileSync(path.join(dataRoot, index.entries[portraitKey].paths[0]), 'externally edited image')
    expect(fs.readFileSync(path.join(dataRoot, index.entries[moduleKey].paths[0]))).toEqual(original)
    const changed = await client.fetch(assetUrl, { headers: { cookie, 'if-none-match': first.headers.get('etag')! } })
    expect(changed.status).toBe(200)
    expect(changed.headers.get('cache-control')).toBe('no-cache')
    expect(Buffer.from(await changed.arrayBuffer()).toString()).toBe('externally edited image')
    const draftPath = 'characters/Character/chats/Chat/draft.json'
    const draft = Buffer.from(JSON.stringify({ role: 'char', data: 'unfinished draft' }))
    fs.writeFileSync(path.join(dataRoot, draftPath), draft)
    fs.writeFileSync(path.join(dataRoot, 'characters/Character/character.json.bak'), 'original character revision')
    const native = decodeBackup(await client.exportBackup())
    expect(native.some(entry => entry.name.startsWith('risubard-data/prompts/'))).toBe(true)
    expect(native.some(entry => entry.name.startsWith('risubard-data/shared/'))).toBe(true)
    const destination = await spawnServer(); servers.push(destination)
    const destinationClient = await createClient(destination.port, destination.password)
    expect((await destinationClient.importBackup(encodeBackup(native))).ok).toBe(true)
    const restoredRoot = path.join(destination.cwd, 'save')
    expect(fs.readFileSync(path.join(restoredRoot, draftPath))).toEqual(draft)
    expect(fs.readFileSync(path.join(restoredRoot, 'characters/Character/character.json.bak'), 'utf8')).toBe('original character revision')
    const destinationCookie = (await destinationClient.fetch('/api/session', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0]
    const restored = await destinationClient.fetch(assetUrl, { headers: { cookie: destinationCookie } })
    expect(Buffer.from(await restored.arrayBuffer()).toString()).toBe('externally edited image')
    expect(fs.existsSync(path.join(restoredRoot, 'characters/char-1'))).toBe(false)
})

test('a live shared-image save returns canonical references consistently in the cache, chat store and reload signal', async () => {
    const server = await spawnServer(); servers.push(server)
    const client = await createClient(server.port, server.password)
    const db: any = structuredClone(database)
    db.characters[0].image = 'assets/live.png'
    expect(await client.importBackup(encodeBackup([
        { name: 'database.risudat', data: Buffer.from(encodeRisuSaveLegacy(db)) },
        { name: 'live.png', data: Buffer.from('image') },
    ]))).toMatchObject({ ok: true })
    db.modules[0].assets = [['shared', 'assets/live.png']]
    db.characters[0].chats[0].message[0].data = '<img src="assets/live.png">'
    const response = await client.fetch('/api/write', {
        method: 'POST', headers: { ...fileHeaders, 'content-type': 'application/octet-stream' },
        body: new Uint8Array(encodeRisuSaveLegacy(db)),
    })
    expect(response.ok).toBe(true)
    expect(await response.json()).toMatchObject({ canonicalReferencesChanged: true })
    const dataRoot = path.join(server.cwd, 'save')
    const canonical = createUserDataRepository({ dataRoot }).exportLegacyDatabase()
    const persisted = await decodeRisuSave(createFileKv({ dataRoot }).kvGet('database/database.bin'))
    expect(persisted).toEqual(canonical)
    const visible = await decodeRisuSave(Buffer.from(await (await client.fetch('/api/read', { headers: fileHeaders })).arrayBuffer()))
    expect(visible.characters[0].image).toBe(canonical.characters[0].image)
    expect(visible.modules[0].assets[0][1]).toBe(canonical.modules[0].assets[0][1])
    expect(canonical.characters[0].chats[0].message[0].data).toContain(canonical.characters[0].image)
})

test.each(['portrait', 'chat-only'])('a patch sharing an image is durably normalized before requesting client reload (%s)', async source => {
    const server = await spawnServer(); servers.push(server)
    const client = await createClient(server.port, server.password)
    const db: any = structuredClone(database)
    if (source === 'portrait') db.characters[0].image = 'assets/live.png'
    else db.characters[0].chats[0].message[0].data = '<img src="assets/live.png">'
    expect(await client.importBackup(encodeBackup([
        { name: 'database.risudat', data: Buffer.from(encodeRisuSaveLegacy(db)) }, { name: 'live.png', data: Buffer.from('image') },
    ]))).toMatchObject({ ok: true })
    const current = await decodeRisuSave(Buffer.from(await (await client.fetch('/api/read', { headers: fileHeaders })).arrayBuffer()))
    const response = await client.fetch('/api/patch', { method: 'POST', headers: { ...fileHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ patch: [{ op: 'add', path: '/modules/0/assets', value: [['shared', 'assets/live.png']] }],
            expectedHash: require('../../server/node/utils.cjs').calculateHash(current).toString(16) }),
    })
    expect(response.ok).toBe(true)
    expect(await response.json()).toMatchObject({ canonicalReferencesChanged: true })
    const persisted = createUserDataRepository({ dataRoot: path.join(server.cwd, 'save') }).exportLegacyDatabase()
    const characterImage = source === 'portrait' ? persisted.characters[0].image : persisted.characters[0].chats[0].message[0].data.match(/src="([^"]+)"/)[1]
    expect(characterImage).not.toBe(persisted.modules[0].assets[0][1])
})

test('rejects missing incoming image bytes without borrowing the previous save', async () => {
    const server = await spawnServer(); servers.push(server)
    const client = await createClient(server.port, server.password)
    const db: any = structuredClone(database)
    db.characters[0].image = 'assets/portrait.png'
    const databaseEntry = { name: 'database.risudat', data: Buffer.from(encodeRisuSaveLegacy(db)) }
    expect(await client.importBackup(encodeBackup([databaseEntry,
        { name: 'portrait.png', data: Buffer.from('retained image') },
    ]))).toMatchObject({ ok: true })
    const root = path.join(server.cwd, 'save')
    const before = fs.readFileSync(path.join(root, 'kv/manifest.json'))
    expect((await client.importBackup(encodeBackup([databaseEntry]))).ok).not.toBe(true)
    expect(fs.readFileSync(path.join(root, 'kv/manifest.json'))).toEqual(before)
    const native = decodeBackup(await client.exportBackup())
    const index = JSON.parse(fs.readFileSync(path.join(root, 'settings/asset-files.json'), 'utf8'))
    const missing = `risubard-data/${index.entries['assets/portrait.png'].paths[0]}`
    expect((await client.importBackup(encodeBackup(native.filter(entry => entry.name !== missing)))).ok).not.toBe(true)
    expect(fs.readFileSync(path.join(root, 'kv/manifest.json'))).toEqual(before)
})

test('assigns missing entity IDs before publishing the compatibility cache', async () => {
    const server = await spawnServer(); servers.push(server)
    const client = await createClient(server.port, server.password)
    const db: any = structuredClone(database)
    delete db.modules[0].id
    delete db.botPresets[0].id
    const response = await client.fetch('/api/write', {
        method: 'POST', headers: { ...fileHeaders, 'content-type': 'application/octet-stream' },
        body: new Uint8Array(encodeRisuSaveLegacy(db)),
    })
    expect(response.ok).toBe(true)
    await client.fetch('/api/read', { headers: fileHeaders })
    const dataRoot = path.join(server.cwd, 'save')
    const canonical = createUserDataRepository({ dataRoot }).exportLegacyDatabase()
    const persisted = await decodeRisuSave(createFileKv({ dataRoot }).kvGet('database/database.bin'))
    expect(canonical.modules[0].id).toBeTruthy()
    expect(persisted.modules[0].id).toBe(canonical.modules[0].id)
    expect(persisted.botPresets[0].id).toBe(canonical.botPresets[0].id)
})

test('converts an incoming ID-folder native backup without restoring obsolete folders over the named tree', async () => {
    const server = await spawnServer(); servers.push(server)
    const client = await createClient(server.port, server.password)
    const incomingRoot = path.join(server.cwd, 'incoming-id-tree')
    createUserDataRepository({ dataRoot: incomingRoot }).importLegacyDatabase(database, { mode: 'replace' })
    const draft = Buffer.from(JSON.stringify({ role: 'char', data: 'legacy draft' }))
    fs.writeFileSync(path.join(incomingRoot, 'characters/char-1/chats/chat-1/draft.json'), draft)
    fs.writeFileSync(path.join(incomingRoot, 'settings/app.json.bak'), 'prior settings revision')
    const entries = require('../../server/node/canonical-import.cjs').collectImportFiles(incomingRoot).map((entry: any) => ({
        name: `risubard-data/${entry.path.split(path.sep).join('/')}`, data: fs.readFileSync(entry.sourcePath),
    }))
    expect(await client.importBackup(encodeBackup([
        { name: 'database.risudat', data: Buffer.from(encodeRisuSaveLegacy(database)) }, ...entries,
    ]))).toMatchObject({ ok: true })
    const root = path.join(server.cwd, 'save')
    expect(fs.existsSync(path.join(root, 'characters/char-1'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'presets/preset-1.json'))).toBe(false)
    expect(fs.readFileSync(path.join(root, 'characters/Character/chats/Chat/draft.json'))).toEqual(draft)
    expect(fs.readFileSync(path.join(root, 'settings/app.json.bak'), 'utf8')).toBe('prior settings revision')
    const original = fs.readdirSync(path.join(root, 'trash')).find(name =>
        fs.existsSync(path.join(root, 'trash', name, 'incoming-original/characters/char-1/metadata.json')))
    expect(original).toBeTruthy()
})

test('rejects a stale app save after an external JSON edit changes a stable entity ID', async () => {
    const server = await spawnServer(); servers.push(server)
    const client = await createClient(server.port, server.password)
    expect(await client.importBackup(encodeBackup([
        { name: 'database.risudat', data: Buffer.from(encodeRisuSaveLegacy(database)) },
    ]))).toMatchObject({ ok: true })
    const root = path.join(server.cwd, 'save')
    const characterPath = path.join(root, 'characters/Character/character.json')
    const character = JSON.parse(fs.readFileSync(characterPath, 'utf8'))
    character.chaId = 'externally-changed-id'
    const edited = JSON.stringify(character, null, 2)
    fs.writeFileSync(characterPath, edited)
    const manifest = fs.readFileSync(path.join(root, 'kv/manifest.json'))
    const response = await client.fetch('/api/write', {
        method: 'POST', headers: { ...fileHeaders, 'content-type': 'application/octet-stream' },
        body: new Uint8Array(encodeRisuSaveLegacy(database)),
    })
    expect(response.ok).toBe(false)
    expect(fs.readFileSync(characterPath, 'utf8')).toBe(edited)
    expect(fs.readFileSync(path.join(root, 'kv/manifest.json'))).toEqual(manifest)
})

test('blocks reads and writes after interrupted publication and replays the prepared journal on restart', async () => {
    const server = await spawnServer(); servers.push(server)
    const client = await createClient(server.port, server.password)
    expect(await client.importBackup(encodeBackup([
        { name: 'database.risudat', data: Buffer.from(encodeRisuSaveLegacy(database)) },
    ]))).toMatchObject({ ok: true })
    const root = path.join(server.cwd, 'save')
    const journalDirectory = path.join(root, '.journal')
    fs.mkdirSync(path.join(journalDirectory, 'unprepared.stage'), { recursive: true })
    // Staging without a prepared JSON journal has not published any bytes.
    expect((await client.fetch('/api/read', { headers: fileHeaders })).ok).toBe(true)
    const { commitTransaction } = require('../../server/node/file-store.cjs')
    expect(() => commitTransaction(root, [
        { path: 'settings/interrupted-first.txt', data: Buffer.from('first published') },
        { path: 'settings/interrupted-second.txt', data: Buffer.from('second recovered') },
    ], { failAfterPublish: 1 })).toThrow('simulated crash')
    const journalName = fs.readdirSync(journalDirectory).find(name => name.endsWith('.json'))!
    const journalBytes = fs.readFileSync(path.join(journalDirectory, journalName))
    const manifest = fs.readFileSync(path.join(root, 'kv/manifest.json'))
    expect((await client.fetch('/api/read', { headers: fileHeaders })).status).toBe(503)
    expect((await client.fetch('/api/write', {
        method: 'POST', headers: { ...fileHeaders, 'content-type': 'application/octet-stream' },
        body: new Uint8Array(encodeRisuSaveLegacy(database)),
    })).status).toBe(503)
    expect((await client.fetch(`/api/asset/${Buffer.from('assets/a').toString('hex')}`)).status).toBe(503)
    expect(fs.readFileSync(path.join(root, 'kv/manifest.json'))).toEqual(manifest)
    expect(fs.readFileSync(path.join(journalDirectory, journalName))).toEqual(journalBytes)
    const restarted = await spawnServer({ seedSave: async destination => {
        fs.cpSync(root, destination, { recursive: true })
        const journalPath = path.join(destination, '.journal', journalName)
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
        for (const entry of journal.entries) if (entry.staged) entry.staged = path.join(destination, path.relative(root, entry.staged))
        fs.writeFileSync(journalPath, JSON.stringify(journal))
    } }); servers.push(restarted)
    const restartedClient = await createClient(restarted.port, restarted.password)
    expect((await restartedClient.fetch('/api/read', { headers: fileHeaders })).ok).toBe(true)
    expect(fs.readFileSync(path.join(restarted.cwd, 'save/settings/interrupted-second.txt'), 'utf8')).toBe('second recovered')
    expect(fs.readdirSync(path.join(restarted.cwd, 'save/.journal')).filter(name => name.endsWith('.json'))).toEqual([])
})

test('fails closed when an interrupted publication leaves a blank journal', async () => {
    const server = await spawnServer(); servers.push(server)
    const client = await createClient(server.port, server.password)
    const journalDirectory = path.join(server.cwd, 'save/.journal')
    fs.mkdirSync(journalDirectory, { recursive: true })
    fs.writeFileSync(path.join(journalDirectory, 'unreadable.json'), '')
    expect((await client.fetch('/api/read', { headers: fileHeaders })).status).toBe(503)
})

test('rejects a normal save containing a missing module image before changing the canonical files or manifest', async () => {
    const server = await spawnServer(); servers.push(server)
    const client = await createClient(server.port, server.password)
    expect(await client.importBackup(encodeBackup([
        { name: 'database.risudat', data: Buffer.from(encodeRisuSaveLegacy(database)) },
    ]))).toMatchObject({ ok: true })
    const root = path.join(server.cwd, 'save')
    const manifest = fs.readFileSync(path.join(root, 'kv/manifest.json'))
    const modulePath = path.join(root, 'modules/Module/module.json')
    const module = fs.readFileSync(modulePath)
    const missing: any = structuredClone(database)
    missing.modules[0].assets = [['missing image', 'assets/missing-module-image.png']]
    const response = await client.fetch('/api/write', {
        method: 'POST', headers: { ...fileHeaders, 'content-type': 'application/octet-stream' },
        body: new Uint8Array(encodeRisuSaveLegacy(missing)),
    })
    expect(response.ok).toBe(false)
    expect(fs.readFileSync(path.join(root, 'kv/manifest.json'))).toEqual(manifest)
    expect(fs.readFileSync(modulePath)).toEqual(module)
})
