import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const {
    atomicWriteFile,
    atomicWriteJson,
    commitTransaction,
    moveToTrash,
    readVerifiedJson,
    recoverTransactions,
    checksum,
} = require('./file-store.cjs')
const { resolveDataRoot } = require('./data-root.cjs')

const roots: string[] = []

function tempRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-file-store-'))
    roots.push(root)
    return root
}

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('resolveDataRoot', () => {
    it('uses an explicit absolute user-data root independently from the app directory', () => {
        const root = path.resolve(tempRoot(), 'user-data')
        expect(resolveDataRoot({ env: { RISUBARD_DATA_ROOT: root }, cwd: 'C:\\app' })).toBe(root)
    })

    it('rejects shared Android storage as canonical Termux data', () => {
        expect(() => resolveDataRoot({
            env: { RISUBARD_DATA_ROOT: '/sdcard/RisuBard', PREFIX: '/data/data/com.termux/files/usr' },
            cwd: '/data/data/com.termux/files/home/app',
            platform: 'linux',
        })).toThrow(/shared Android storage/i)
    })
})

describe('crash-safe canonical writes', () => {
    it('reports monotonic preparation and publication progress', () => {
        const root = tempRoot()
        const progress: Array<{ phase: string, current: number, total: number }> = []

        commitTransaction(root, [
            { path: 'settings/app.json', data: Buffer.from('{}') },
            { path: 'index/sidebar.json', data: Buffer.from('{}') },
        ], { onProgress: (event: { phase: string, current: number, total: number }) => progress.push(event) })

        expect(progress[0]).toEqual({ phase: 'staging', current: 0, total: 4 })
        expect(progress.at(-1)).toEqual({ phase: 'publishing', current: 4, total: 4 })
        expect(progress.map(event => event.current)).toEqual([0, 1, 2, 3, 4])
    })

    it('rolls a user-visible import back when publication fails in-process', () => {
        const root = tempRoot()
        atomicWriteFile(root, 'settings/app.json', Buffer.from('old settings'))
        fs.writeFileSync(path.join(root, 'settings/app.json.bak'), 'older settings')
        const before = new Map([
            ['settings/app.json', fs.readFileSync(path.join(root, 'settings/app.json'))],
            ['settings/app.json.sha256', fs.readFileSync(path.join(root, 'settings/app.json.sha256'))],
            ['settings/app.json.bak', fs.readFileSync(path.join(root, 'settings/app.json.bak'))],
        ])

        expect(() => commitTransaction(root, [
            { path: 'settings/app.json', data: Buffer.from('new settings') },
            { path: 'characters/New/character.json', data: Buffer.from('{}') },
        ], { failAfterPublish: 1, rollbackOnFailure: true })).toThrow(/simulated/)

        for (const [relative, bytes] of before) {
            expect(fs.readFileSync(path.join(root, relative))).toEqual(bytes)
        }
        expect(fs.existsSync(path.join(root, 'characters/New/character.json'))).toBe(false)
        expect(fs.readdirSync(path.join(root, '.journal'))).toEqual([])
    })

    it.each([1, 3])('replays checksum-protected retirement after crash at publication %s', failAfterPublish => {
        const root = tempRoot(), bytes = Buffer.from('uploaded image'), digest = checksum(bytes)
        atomicWriteFile(root, 'shared/assets/upload.png', bytes)
        fs.writeFileSync(path.join(root, 'shared/assets/upload.png.bak'), 'preserved revision')
        const operations = [
            { path: 'shared/assets/upload.png', retireIfChecksum: digest, replacementPath: 'characters/A/assets/image.png' },
            { path: 'characters/A/assets/image.png', data: bytes },
            { path: 'settings/asset-files.json', data: Buffer.from('{"published":true}') },
        ]
        expect(() => commitTransaction(root, operations, { failAfterPublish })).toThrow(/simulated/)
        expect(() => commitTransaction(root, [{ path: 'settings/later.json', data: Buffer.from('{}') }])).toThrow(/recovery/i)
        recoverTransactions(root)
        expect(fs.existsSync(path.join(root, 'shared/assets/upload.png'))).toBe(false)
        expect(fs.readFileSync(path.join(root, 'characters/A/assets/image.png'))).toEqual(bytes)
        expect(fs.readFileSync(path.join(root, 'shared/assets/upload.png.bak'), 'utf8')).toBe('preserved revision')
        expect(readVerifiedJson(root, 'settings/asset-files.json')).toEqual({ published: true })
        expect(fs.readdirSync(path.join(root, '.journal'))).toEqual([])
    })
    it('refuses retirement with mismatched source bytes before preparing a journal', () => {
        const root = tempRoot()
        atomicWriteFile(root, 'shared/assets/upload.png', Buffer.from('external edit'))
        expect(() => commitTransaction(root, [
            { path: 'characters/A/assets/image.png', data: Buffer.from('baseline') },
            { path: 'shared/assets/upload.png', retireIfChecksum: checksum(Buffer.from('baseline')), replacementPath: 'characters/A/assets/image.png' },
        ])).toThrow(/retir.*checksum/i)
        expect(fs.readFileSync(path.join(root, 'shared/assets/upload.png'), 'utf8')).toBe('external edit')
        expect(fs.readdirSync(path.join(root, '.journal'))).toEqual([])
    })
    it('fails closed if the source changes after preparation, retaining its recovery journal', () => {
        const root = tempRoot(), bytes = Buffer.from('baseline'), digest = checksum(bytes)
        atomicWriteFile(root, 'shared/assets/upload.png', bytes)
        expect(() => commitTransaction(root, [
            { path: 'characters/A/assets/image.png', data: bytes },
            { path: 'shared/assets/upload.png', retireIfChecksum: digest, replacementPath: 'characters/A/assets/image.png' },
        ], { failAfterPublish: 1 })).toThrow(/simulated/)
        fs.writeFileSync(path.join(root, 'shared/assets/upload.png'), 'external edit')
        expect(() => recoverTransactions(root)).toThrow(/retir.*checksum/i)
        expect(fs.readFileSync(path.join(root, 'shared/assets/upload.png'), 'utf8')).toBe('external edit')
        expect(fs.readdirSync(path.join(root, '.journal')).some(name => name.endsWith('.json'))).toBe(true)
    })
    it.each(['missing', 'different'])('does not retire an upload when its replacement is %s', replacement => {
        const root = tempRoot(), bytes = Buffer.from('baseline')
        atomicWriteFile(root, 'shared/assets/upload.png', bytes)
        if (replacement === 'different') atomicWriteFile(root, 'characters/A/assets/image.png', Buffer.from('different'))
        expect(() => commitTransaction(root, [{ path: 'shared/assets/upload.png', retireIfChecksum: checksum(bytes), replacementPath: 'characters/A/assets/image.png' }])).toThrow()
        expect(fs.readFileSync(path.join(root, 'shared/assets/upload.png'))).toEqual(bytes)
        expect(fs.readdirSync(path.join(root, '.journal'))).toEqual([])
    })
    it('rejects retiring revisions and non-upload files even when their checksums match', () => {
        const root = tempRoot(), bytes = Buffer.from('baseline')
        for (const source of ['shared/assets/upload.png.bak', 'settings/important.json']) {
            atomicWriteFile(root, source, bytes)
            expect(() => commitTransaction(root, [
                { path: 'characters/A/assets/image.png', data: bytes },
                { path: source, retireIfChecksum: checksum(bytes), replacementPath: 'characters/A/assets/image.png' },
            ])).toThrow(/retirement/i)
            expect(fs.readFileSync(path.join(root, source))).toEqual(bytes)
        }
        expect(fs.readdirSync(path.join(root, '.journal'))).toEqual([])
    })
    it('replays interrupted individual asset archival without losing the source or replacement', () => {
        const root = tempRoot()
        atomicWriteFile(root, 'characters/A/assets/image.png', Buffer.from('old image'))
        const operations = [
            { path: 'characters/A/assets/image.png', archiveTo: 'trash/asset-test/image.png' },
            { path: 'characters/A/assets/image.png', data: Buffer.from('new image') },
        ]
        expect(() => commitTransaction(root, operations, { failAfterPublish: 1 })).toThrow(/simulated/)
        expect(() => commitTransaction(root, [{ path: 'settings/stale.json', data: Buffer.from('{}') }])).toThrow(/recovery/i)
        recoverTransactions(root)
        expect(fs.readFileSync(path.join(root, 'characters/A/assets/image.png'), 'utf8')).toBe('new image')
        expect(fs.readFileSync(path.join(root, 'trash/asset-test/image.png'), 'utf8')).toBe('old image')
    })
    it('removes unpublished staging files when preparation fails', () => {
        const root = tempRoot()
        expect(() => commitTransaction(root, [
            { path: 'settings/first.json', data: Buffer.from('{}') },
            { path: 'settings/second.json', data: Buffer.from('{}'), validate: () => false },
        ])).toThrow(/validation/i)
        expect(fs.readdirSync(path.join(root, '.journal'))).toEqual([])
        expect(fs.existsSync(path.join(root, 'settings'))).toBe(false)
    })
    it('replays an interrupted directory replacement without archiving the new files again', () => {
        const root = tempRoot()
        atomicWriteJson(root, 'characters/old.json', { old: true })
        const operations = [
            { path: 'characters', archiveTo: 'trash/import-test/characters' },
            { path: 'characters/new.json', data: Buffer.from('{"new":true}') },
            { path: 'index/sidebar.json', data: Buffer.from('{}') },
        ]
        expect(() => commitTransaction(root, operations, { failAfterPublish: 2 })).toThrow(/simulated/)
        recoverTransactions(root)
        expect(readVerifiedJson(root, 'characters/new.json')).toEqual({ new: true })
        expect(readVerifiedJson(root, 'trash/import-test/characters/old.json')).toEqual({ old: true })
        expect(fs.existsSync(path.join(root, 'characters/old.json'))).toBe(false)
    })
    it('validates bytes, publishes atomically, and preserves the previous revision', () => {
        const root = tempRoot()
        atomicWriteFile(root, 'settings/app.json', Buffer.from('{"revision":1}'), {
            validate: (bytes: Buffer) => JSON.parse(bytes.toString('utf8')).revision === 1,
        })
        atomicWriteFile(root, 'settings/app.json', Buffer.from('{"revision":2}'), {
            validate: (bytes: Buffer) => JSON.parse(bytes.toString('utf8')).revision === 2,
        })

        expect(fs.readFileSync(path.join(root, 'settings/app.json'), 'utf8')).toBe('{"revision":2}')
        expect(fs.readFileSync(path.join(root, 'settings/app.json.bak'), 'utf8')).toBe('{"revision":1}')
        expect(fs.readdirSync(path.join(root, 'settings')).some(name => name.endsWith('.tmp'))).toBe(false)
    })

    it('does not create redundant checksum sidecars for indexed binary assets', () => {
        const root = tempRoot()
        const target = 'shared/assets/imported.webp'

        commitTransaction(root, [{
            path: target,
            data: Buffer.from('asset bytes'),
            checksumSidecar: false,
        }])

        expect(fs.readFileSync(path.join(root, target), 'utf8')).toBe('asset bytes')
        expect(fs.existsSync(path.join(root, `${target}.sha256`))).toBe(false)
    })

    it('rejects invalid content without replacing the last good revision', () => {
        const root = tempRoot()
        atomicWriteJson(root, 'settings/app.json', { schemaVersion: 1, value: 'safe' })
        expect(() => atomicWriteFile(root, 'settings/app.json', Buffer.from('{}'), {
            validate: () => false,
        })).toThrow(/validation/i)
        expect(readVerifiedJson(root, 'settings/app.json')).toEqual({ schemaVersion: 1, value: 'safe' })
    })

    it('adopts a valid external JSON edit only through the explicit external-change path', () => {
        const root = tempRoot()
        const relativePath = 'settings/app.json'
        const target = path.join(root, relativePath)
        atomicWriteJson(root, relativePath, { schemaVersion: 1, value: 'safe' })
        fs.writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, value: 'external' }, null, 2)}\n`)

        expect(() => readVerifiedJson(root, relativePath)).toThrow(/checksum mismatch/i)
        expect(readVerifiedJson(root, relativePath, { acceptExternalChanges: true }))
            .toEqual({ schemaVersion: 1, value: 'external' })
        expect(readVerifiedJson(root, relativePath)).toEqual({ schemaVersion: 1, value: 'external' })

        fs.writeFileSync(target, '{ invalid json')
        expect(() => readVerifiedJson(root, relativePath, { acceptExternalChanges: true })).toThrow()
    })
})

describe('journal recovery and trash', () => {
    it('commits staged source files without requiring in-memory operation data', () => {
        const root = tempRoot()
        const source = path.join(root, '.import-staging', 'settings.json')
        fs.mkdirSync(path.dirname(source), { recursive: true })
        fs.writeFileSync(source, Buffer.from('{"streamed":true}'))

        commitTransaction(root, [
            { path: 'settings/app.json', sourcePath: source },
        ])

        expect(JSON.parse(fs.readFileSync(path.join(root, 'settings/app.json'), 'utf8')))
            .toEqual({ streamed: true })
    })

    it('finishes a prepared multi-file transaction after a simulated crash', () => {
        const root = tempRoot()
        expect(() => commitTransaction(root, [
            { path: 'settings/app.json', data: Buffer.from('{"ok":true}') },
            { path: 'presets/preset-1.json', data: Buffer.from('{"id":"preset-1"}') },
        ], { failAfterPublish: 1 })).toThrow(/simulated crash/i)

        recoverTransactions(root)
        expect(JSON.parse(fs.readFileSync(path.join(root, 'settings/app.json'), 'utf8'))).toEqual({ ok: true })
        expect(JSON.parse(fs.readFileSync(path.join(root, 'presets/preset-1.json'), 'utf8'))).toEqual({ id: 'preset-1' })
        expect(fs.readdirSync(path.join(root, '.journal'))).toHaveLength(0)
    })

    it('moves deleted canonical data to trash with recoverable bytes', () => {
        const root = tempRoot()
        atomicWriteFile(root, 'characters/char-1/metadata.json', Buffer.from('character'))
        const trashed = moveToTrash(root, 'characters/char-1/metadata.json')
        expect(fs.existsSync(path.join(root, 'characters/char-1/metadata.json'))).toBe(false)
        expect(fs.readFileSync(trashed, 'utf8')).toBe('character')
        expect(trashed).toContain(`${path.sep}trash${path.sep}`)
    })

    it('repairs the checksum when a crash occurs after data rename but before sidecar publication', () => {
        const root = tempRoot()
        atomicWriteJson(root, 'settings/app.json', { revision: 1 })
        const previousChecksum = fs.readFileSync(path.join(root, 'settings/app.json.sha256'))
        expect(() => commitTransaction(root, [
            { path: 'settings/app.json', data: Buffer.from('{"revision":2}') },
        ], { failAfterPublish: 1 })).toThrow(/simulated crash/i)
        // Reproduce the earlier crash window: new bytes, old checksum, prepared journal.
        fs.writeFileSync(path.join(root, 'settings/app.json.sha256'), previousChecksum)
        recoverTransactions(root)
        expect(readVerifiedJson(root, 'settings/app.json')).toEqual({ revision: 2 })
    })
})
