import { afterEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createClient } from '../../test/compat/helpers/client'
import { normalizeBackup } from '../../test/compat/helpers/normalize'

const { beforeStartup, needsMigration, inventory, inspect, recoverSwap } = require('./v2-migration-gate.cjs')
const roots: string[] = []
function fixture() {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-v2-gate-')); roots.push(parent)
    const root = path.join(parent, 'save'); fs.mkdirSync(root)
    const id = crypto.randomUUID(), backup = path.join(parent, 'backups', `save.v1-${id}`)
    return { root, parent, backup, id }
}
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })) })

function seed(root: string, missing = false) {
    const { encodeRisuSaveLegacy } = require('./utils.cjs')
    const { createFileKv } = require('./file-kv.cjs')
    const store = createFileKv({ dataRoot: root })
    store.kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy({
        characters: [{ chaId: 'a', name: 'Alice', image: 'assets/picture', chats: [{ id: 'chat', name: 'One', message: [{ role: 'user', data: 'Keep me' }] }] }],
        modules: [], personas: [], botPresets: [], loreBook: [],
    })))
    if (!missing) store.kvSet('assets/picture', Buffer.from('picture bytes'))
    fs.writeFileSync(path.join(root, 'custom.txt'), 'unrecognized file must survive')
}

test('empty and V2 stores skip consent; legacy files require it', async () => {
    const { root } = fixture()
    expect(needsMigration(root)).toBe(false)
    expect(await beforeStartup({ root })).toBe(true)
    fs.writeFileSync(path.join(root, 'risuai.db'), 'legacy')
    expect(needsMigration(root)).toBe(true)
    fs.mkdirSync(path.join(root, 'settings')); fs.writeFileSync(path.join(root, 'settings/layout.json'), '{"schemaVersion":2}')
    expect(needsMigration(root)).toBe(false)
})

test('consent is read-only; insufficient space cannot start; decline closes gate without conversion', async () => {
    const { root, backup } = fixture(); seed(root)
    const before = inventory(root, true), worker = vi.fn()
    let port: number, token: string
    let listening!: () => void
    const ready = new Promise<void>(resolve => { listening = resolve })
    const run = beforeStartup({ root, port: 0, worker, inspect: () => inspect(root, backup, () => ({ bavail: 1, bsize: 4096 })),
        onListening: (p: number, t: string) => { port = p; token = t; listening() } })
    await ready
    const url = `http://127.0.0.1:${port!}`, headers = { 'x-migration-token': token! }
    expect((await fetch(url + '/start', { method: 'POST' })).status).toBe(403)
    expect((await fetch(url + '/start', { method: 'POST', headers })).status).toBe(507)
    expect(worker).not.toHaveBeenCalled()
    expect(inventory(root, true)).toEqual(before)
    expect((await fetch(url + '/exit', { method: 'POST', headers })).ok).toBe(true)
    expect(await run).toBe(false)
    expect(inventory(root, true)).toEqual(before)
})

test('worker verifies and activates V2, retains byte-identical original and removes active duplicate assets', () => {
    const { root, backup } = fixture(); seed(root)
    const before = inventory(root, true)
    execFileSync(process.execPath, [path.resolve('server/node/v2-migration-worker.cjs'), root, backup], { stdio: 'pipe' })
    expect(inventory(backup, true)).toEqual(before)
    expect(fs.readFileSync(path.join(root, 'custom.txt'), 'utf8')).toContain('must survive')
    expect(needsMigration(root)).toBe(false)
    expect(fs.existsSync(path.join(root, 'settings/native-runtime.json'))).toBe(true)
    const { createUserDataRepository } = require('./user-data-repository.cjs')
    const data = createUserDataRepository({ dataRoot: root, formatVersion: 2 }).exportLegacyDatabase()
    expect(data.characters[0].chats[0].message[0].data).toBe('Keep me')
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'kv/manifest.json'), 'utf8'))
    expect(Object.keys(manifest.entries).filter(key => key.startsWith('assets/') || key === 'database/database.bin')).toEqual([])
    const { createFileKv } = require('./file-kv.cjs')
    expect(createFileKv({ dataRoot: root }).kvGet(data.characters[0].image).toString()).toBe('picture bytes')
})

test('missing asset refuses migration and preserves the entire original', () => {
    const { root, backup } = fixture(); seed(root, true)
    const before = inventory(root, true)
    expect(() => execFileSync(process.execPath, [path.resolve('server/node/v2-migration-worker.cjs'), root, backup], { stdio: 'pipe' })).toThrow()
    expect(inventory(root, true)).toEqual(before)
    expect(fs.existsSync(backup)).toBe(false)
    expect(fs.readdirSync(path.dirname(root)).filter(name => name.includes('.v2-stage-'))).toEqual([])
})

test('never replays an original pending journal through its copied absolute staging paths', () => {
    const { root, backup } = fixture(); seed(root)
    fs.mkdirSync(path.join(root, '.journal'))
    fs.writeFileSync(path.join(root, '.journal/pending.json'), '{"state":"prepared"}')
    const before = inventory(root, true)
    expect(() => execFileSync(process.execPath, [path.resolve('server/node/v2-migration-worker.cjs'), root, backup], { stdio: 'pipe' })).toThrow()
    expect(inventory(root, true)).toEqual(before)
    expect(fs.existsSync(backup)).toBe(false)
})

test('interrupted swap restores the original instead of booting an empty store', () => {
    const { root, backup, parent, id } = fixture(); seed(root)
    const stage = fs.mkdtempSync(`${root}.v2-stage-`), before = inventory(root, true)
    fs.mkdirSync(path.dirname(backup)); fs.renameSync(root, backup)
    fs.writeFileSync(`${root}.v2-swap.json`, JSON.stringify({ root, backup, stage, id }))
    recoverSwap(root)
    expect(inventory(root, true)).toEqual(before)
    expect(fs.existsSync(path.join(parent, 'save.v2-swap.json'))).toBe(false)
})

test('actual server entry waits for consent, starts after migration, and exports a complete local backup', async () => {
    const { root, parent } = fixture(); seed(root)
    fs.writeFileSync(path.join(root, '__password'), 'migration-test')
    const before = inventory(root, true)
    // Reserve a free loopback port, then let the server bind it.
    const net = await import('node:net')
    const probe = net.createServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as import('node:net').AddressInfo).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    const child = spawn(process.execPath, [path.resolve('server/node/server.cjs')], {
        cwd: parent, env: { ...process.env, RISUBARD_DATA_ROOT: root, PORT: String(port), OPEN_BROWSER: '0', RISU_UPDATE_CHECK: 'false' },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    let speculative: import('node:net').Socket | undefined
    async function waitFor(text: string) {
        const until = Date.now() + 12000
        while (!output.includes(text)) {
            if (child.exitCode !== null || Date.now() > until) throw new Error(`Server did not reach ${text}: ${output}`)
            await new Promise(resolve => setTimeout(resolve, 40))
        }
    }
    try {
        await waitFor('V2 migration consent required')
        expect(inventory(root, true)).toEqual(before)
        const url = `http://127.0.0.1:${port}`
        const html = await (await fetch(url)).text()
        const token = html.match(/nonce="([a-f0-9]+)"/)![1]
        expect(html).toContain('프로그램 종료')
        expect((await fetch(url + '/api/native/catalog')).status).toBe(403)
        speculative = net.createConnection({ host: '127.0.0.1', port })
        await new Promise<void>(resolve => speculative!.once('connect', resolve))
        expect((await fetch(url + '/start', { method: 'POST', headers: { 'x-migration-token': token } })).ok).toBe(true)
        await waitFor('server is running')
        const client = await createClient(port, 'migration-test')
        const bytes = await client.exportBackup()
        const exported = normalizeBackup(bytes)
        expect(JSON.stringify(exported.normalized)).toContain('Keep me')
        expect((await client.importBackup(bytes)).ok).toBe(true)
        expect(normalizeBackup(await client.exportBackup()).normalized).toEqual(exported.normalized)
        const backups = fs.readdirSync(path.join(parent, 'backups'))
        expect(inventory(path.join(parent, 'backups', backups[0]), true)).toEqual(before)
    } finally {
        speculative?.destroy()
        if (child.exitCode === null) {
            const exit = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exit
        }
    }
}, 25000)

test.each(['hex', 'sqlite'])('upgrades a %s source without keeping its old DB in the active V2 tree', kind => {
    const { root, backup } = fixture()
    const { encodeRisuSaveLegacy } = require('./utils.cjs')
    const bytes = Buffer.from(encodeRisuSaveLegacy({ characters: [], modules: [], personas: [], botPresets: [], loreBook: [], temperature: 71 }))
    const filename = kind === 'hex' ? Buffer.from('database/database.bin').toString('hex') : 'risuai.db'
    if (kind === 'hex') fs.writeFileSync(path.join(root, filename), bytes)
    else {
        const { DatabaseSync } = require('node:sqlite')
        const db = new DatabaseSync(path.join(root, filename))
        db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB)')
        db.prepare('INSERT INTO kv VALUES (?, ?)').run('database/database.bin', bytes)
        db.close()
    }
    const before = inventory(root, true)
    execFileSync(process.execPath, [path.resolve('server/node/v2-migration-worker.cjs'), root, backup], { stdio: 'pipe' })
    expect(inventory(backup, true)).toEqual(before)
    expect(fs.existsSync(path.join(root, filename))).toBe(false)
    const { createUserDataRepository } = require('./user-data-repository.cjs')
    expect(createUserDataRepository({ dataRoot: root }).exportLegacyDatabase().temperature).toBe(71)
})

test('plans only V2 output, preserves source during inspection, and fits below the former 3x free-space limit', async () => {
    const { root, backup } = fixture(); seed(root)
    const { createFileKv } = require('./file-kv.cjs')
    const store = createFileKv({ dataRoot: root })
    store.kvSet('assets/picture', Buffer.alloc(8 * 1024 * 1024, 7))
    store.kvSet('plugin/custom-state', Buffer.from('plugin state'))
    fs.mkdirSync(path.join(root, 'trash'))
    fs.writeFileSync(path.join(root, 'trash/old.bin'), Buffer.alloc(16 * 1024 * 1024))
    const before = inventory(root, true)
    const info = await inspect(root, backup, () => ({ bavail: 90 * 1024 * 1024, bsize: 1 }))
    expect(info.enoughSpace).toBe(true)
    expect(info.outputBytes).toBeLessThan(9 * 1024 * 1024)
    expect(info.requiredBytes).toBeLessThan(info.sourceBytes * 3 + 256 * 1024 * 1024)
    expect(inventory(root, true)).toEqual(before)
    expect(fs.readdirSync(path.dirname(root))).toEqual(['save'])
    const script = `require('./server/node/v2-migration-worker.cjs').migrate(process.argv[1], process.argv[2], {
        statfs: () => ({ bavail: 90 * 1024 * 1024, bsize: 1 }),
        onPhase(phase) { if (phase === 'verify') {
            const fs = require('fs'), path = require('path');
            const parent = path.dirname(process.argv[1]);
            const temp = fs.readdirSync(parent).filter(n => n.includes('.v2-stage-'));
            for (const n of temp) if (fs.existsSync(path.join(parent, n, 'trash/old.bin'))) throw Error('Copied old trash');
            const { inventory } = require('./server/node/v2-migration-gate.cjs');
            const bytes = temp.flatMap(n => inventory(path.join(parent, n))).reduce((sum,e) => sum + (typeof e[1] === 'number' ? e[1] : 0),0);
            if (bytes >= 9 * 1024 * 1024) throw Error('Duplicated source assets in temporary storage');
        } }
    }).catch(e => { console.error(e.message); process.exitCode = 1 })`
    execFileSync(process.execPath, ['-e', script, root, backup], { stdio: 'pipe' })
    expect(inventory(backup, true)).toEqual(before)
    expect(fs.existsSync(path.join(root, 'trash/old.bin'))).toBe(false)
    expect(createFileKv({ dataRoot: root }).kvGet('plugin/custom-state').toString()).toBe('plugin state')
})

test('counts independent copies of a shared image for each owner', async () => {
    const { root, backup } = fixture(); seed(root)
    const { createFileKv } = require('./file-kv.cjs')
    const { encodeRisuSaveLegacy, decodeRisuSave } = require('./utils.cjs')
    const store = createFileKv({ dataRoot: root })
    const data = await decodeRisuSave(store.kvGet('database/database.bin'))
    const first = await inspect(root, backup)
    store.kvSet('assets/picture', Buffer.alloc(4 * 1024 * 1024, 5))
    data.characters.push({ ...data.characters[0], chaId: 'b', name: 'Bob', chats: [] })
    store.kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(data)))
    const second = await inspect(root, backup)
    expect(second.outputBytes - first.outputBytes).toBeGreaterThan(8 * 1024 * 1024 - 1024)
})

test.each(['before', 'during'])('disk exhaustion %s conversion leaves the original intact', when => {
    const { root, backup } = fixture(); seed(root)
    const before = inventory(root, true)
    const script = `let checks = 0; require('./server/node/v2-migration-worker.cjs').migrate(process.argv[1], process.argv[2], {
        statfs: () => ({ bavail: ++checks <= ${when === 'before' ? 0 : 3} ? 1e12 : 0, bsize: 1 })
    }).catch(e => { console.error(e.message); process.exitCode = 1 })`
    expect(() => execFileSync(process.execPath, ['-e', script, root, backup], { stdio: 'pipe' })).toThrow()
    expect(inventory(root, true)).toEqual(before)
    expect(fs.existsSync(backup)).toBe(false)
    expect(fs.readdirSync(path.dirname(root))).toEqual(['save'])
})

test('carries drafts, wiki and inlays into the new tree', () => {
    const { root, backup } = fixture(); seed(root)
    const { createUserDataRepository } = require('./user-data-repository.cjs')
    // Build the legacy canonical tree in a child, keeping fixture setup synchronous.
    const script = `const root = process.argv[1]; const { createFileKv } = require('./server/node/file-kv.cjs');
        require('./server/node/utils.cjs').decodeRisuSave(createFileKv({dataRoot:root}).kvGet('database/database.bin')).then(db => {
            const r = require('./server/node/user-data-repository.cjs').createUserDataRepository({dataRoot:root});
            r.importLegacyDatabase(db, {mode:'sync'}); r.saveAssistantDraft('a','chat',{text:'unfinished'});
        })`
    execFileSync(process.execPath, ['-e', script, root], { stdio: 'pipe' })
    for (const name of ['risubard', 'inlays']) { fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, 'keep.txt'), name) }
    const before = inventory(root, true)
    execFileSync(process.execPath, [path.resolve('server/node/v2-migration-worker.cjs'), root, backup], { stdio: 'pipe' })
    expect(inventory(backup, true)).toEqual(before)
    const r = createUserDataRepository({ dataRoot: root })
    expect(r.loadAssistantDraft('a', 'chat')).toEqual({ text: 'unfinished' })
    for (const name of ['risubard', 'inlays']) expect(fs.readFileSync(path.join(root, name, 'keep.txt'), 'utf8')).toBe(name)
})

test('detects source modification after planning and does not activate the result', () => {
    const { root, backup } = fixture(); seed(root)
    const script = `require('./server/node/v2-migration-worker.cjs').migrate(process.argv[1], process.argv[2], {
        beforePublish() { require('fs').writeFileSync(require('path').join(process.argv[1], 'custom.txt'), 'external edit') }
    }).catch(e => { console.error(e.message); process.exitCode = 1 })`
    expect(() => execFileSync(process.execPath, ['-e', script, root, backup], { stdio: 'pipe' })).toThrow()
    expect(fs.readFileSync(path.join(root, 'custom.txt'), 'utf8')).toBe('external edit')
    expect(needsMigration(root)).toBe(true)
    expect(fs.existsSync(backup)).toBe(false)
})
