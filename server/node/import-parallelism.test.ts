import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('./server.cjs', import.meta.url), 'utf8')

describe('data import parallelism connections', () => {
    it('publishes backup and save-folder objects through asynchronous atomic KV replacement', () => {
        expect(server).toContain('await kvPublishImportAsync(nativeImport')
        expect(server).toContain("stagedKvEntries.filter(entry => entry.key !== 'database/database.bin') : stagedKvEntries")
        expect(server.includes('await publishImportedSnapshot(database, entries, canonicalStagingDir)')).toBe(true)
    })

    it('keeps backup entries and canonical transaction inputs disk-backed', () => {
        expect(server).toContain('stageBackupEntries(dataSource')
        expect(server.includes('collectImportFiles(canonicalStagingDir)')).toBe(true)
        const staging = readFileSync(new URL('./canonical-import.cjs', import.meta.url), 'utf8')
        expect(staging.includes('sourcePath: path.join(root, relative)')).toBe(true)
        expect(server).not.toContain('stagedKvEntries.push({ key: storageKey, value: Buffer.from(storageValue) })')
    })

    it('decompresses uploaded save-folder ZIPs through the worker-thread fflate API', () => {
        const route = server.slice(
            server.indexOf("app.post('/api/migrate/save-folder/upload'"),
            server.indexOf("app.post('/api/migrate/save-folder/cleanup/scan'"),
        )
        expect(route).toContain('fflate.unzip(')
        expect(route).not.toContain('unzipSync')
    })
})
