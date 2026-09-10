import { afterEach, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
const { createLocalBackup } = require('./v2-local-backup.cjs')
const { inventory, beforeStartup } = require('./v2-migration-gate.cjs')
const roots: string[] = []
function fixture() {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-local-backup-')); roots.push(parent)
    const root = path.join(parent, 'save'); fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, 'risuai.db'), 'original bytes')
    fs.mkdirSync(path.join(root, 'empty'))
    return { root, parent }
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))
test('page displays completed backup path and disables conflicting actions during backup', async () => {
    const elements = new Map<string, any>()
    const element = (id: string) => {
        if (!elements.has(id)) elements.set(id, { textContent: '', value: '', disabled: false, hidden: true })
        return elements.get(id)
    }
    let state: any = { phase: 'backup', enoughSpace: true, localBackupDirectory: '/backups', localBackupProgress: { copiedBytes: 1, totalBytes: 2 } }
    const context = vm.createContext({ document: { getElementById: element }, setTimeout() {}, Date,
        fetch: async () => ({ ok: true, json: async () => state }) })
    const html = fs.readFileSync(path.resolve('server/node/v2-migration.html'), 'utf8')
    vm.runInContext(html.match(/<script nonce="__TOKEN__">([\s\S]*?)<\/script>/)![1], context)
    await vm.runInContext('poll()', context)
    for (const id of ['start', 'exit', 'local-create', 'local-directory']) expect(element(id).disabled).toBe(true)
    state = { ...state, phase: 'ready', localBackup: { path: '/backups/copy/data', infoPath: '/backups/copy/backup-info.json', completedAt: new Date().toISOString() } }
    await vm.runInContext('poll()', context)
    expect(element('local-result').hidden).toBe(false)
    expect(element('local-result').textContent).toContain('로컬 백업이 완료되었습니다.')
    expect(element('local-result').textContent).toContain('/backups/copy/data')
    expect(element('local-result').textContent).toContain('/backups/copy/backup-info.json')
    expect(element('start').disabled).toBe(false)
    expect(element('exit').disabled).toBe(false)
})
test('creates independent verified folder backups with restoration info and unique paths', () => {
    const { root, parent } = fixture(), before = inventory(root, true)
    const first = createLocalBackup(root, parent), second = createLocalBackup(root, parent)
    expect(first.path).not.toBe(second.path)
    expect(inventory(root, true)).toEqual(before)
    expect(inventory(first.path, true).map(e => [e[0], e[1], e[3]])).toEqual(before.map(e => [e[0], e[1], e[3]]))
    expect(JSON.parse(fs.readFileSync(first.infoPath, 'utf8')).format).toBe('original-data-folder')
    fs.writeFileSync(path.join(first.path, 'risuai.db'), 'edited copy')
    expect(fs.readFileSync(path.join(root, 'risuai.db'), 'utf8')).toBe('original bytes')
})
test('rejects nested and relative destinations, insufficient space and concurrent changes', () => {
    const { root, parent } = fixture(), before = inventory(root, true)
    expect(() => createLocalBackup(root, root)).toThrow()
    expect(() => createLocalBackup(root, path.join(root, 'empty'))).toThrow()
    expect(() => createLocalBackup(root, 'relative')).toThrow()
    expect(() => createLocalBackup(root, parent, { statfs: () => ({ bavail: 0, bsize: 4096 }) })).toThrow()
    expect(inventory(root, true)).toEqual(before)
    expect(() => createLocalBackup(root, parent, { beforeVerify() { fs.writeFileSync(path.join(root, 'new.txt'), 'changed') } })).toThrow()
    expect(fs.readdirSync(parent)).toEqual(['save'])
})
test('gate backs up without migrating, persists completion path, and remains exitable', async () => {
    const { root, parent } = fixture()
    let port = 0, token = '', listening!: () => void
    const ready = new Promise<void>(resolve => listening = resolve)
    const gate = beforeStartup({ root, port: 0,
        inspect: () => ({ sourcePath: root, requiredBytes: 1, availableBytes: 100, enoughSpace: true }),
        onListening(p, t) { port = p; token = t; listening() } })
    await ready
    const url = `http://127.0.0.1:${port}`, headers = { 'x-migration-token': token, 'content-type': 'application/json' }
    try {
        expect((await fetch(url + '/backup', { method: 'POST', body: '{}' })).status).toBe(403)
        expect((await fetch(url + '/backup', { method: 'POST', headers, body: JSON.stringify({ directory: root }) })).status).toBe(400)
        expect((await fetch(url + '/backup', { method: 'POST', headers, body: JSON.stringify({ directory: parent }) })).ok).toBe(true)
        expect((await fetch(url + '/start', { method: 'POST', headers })).status).toBe(409)
        let status: any
        const deadline = Date.now() + 10000
        do {
            status = await (await fetch(url + '/status', { headers })).json()
            if (status.phase !== 'backup') break
            await new Promise(resolve => setTimeout(resolve, 25))
        } while (Date.now() < deadline)
        expect(status.phase).toBe('ready')
        expect(status.localBackupError).toBeNull()
        expect(fs.readFileSync(path.join(status.localBackup.path, 'risuai.db'), 'utf8')).toBe('original bytes')
        expect(fs.existsSync(path.join(root, 'settings/layout.json'))).toBe(false)
        const html = await (await fetch(url)).text()
        expect(html).toContain('로컬 백업 생성')
        expect(html).toContain('원본 데이터 백업 경로:')
    } finally {
        await fetch(url + '/exit', { method: 'POST', headers })
        await gate
    }
})
