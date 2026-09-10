import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

function read(path: string) {
    return readFileSync(path, 'utf8')
}

describe('local backup restore progress', () => {
    it('forwards server restore phases to the loading dialog', () => {
        const storage = read('src/ts/storage/nodeStorage.ts')
        const backupUi = read('src/ts/drive/backuplocal.ts')
        const serverBackupUi = read('src/lib/Setting/ServerBackupList.svelte')
        const server = read('server/node/server.cjs')
        const canonicalImport = read('server/node/canonical-import.cjs')
        const namedRepository = read('server/node/named-user-data-repository.cjs')

        expect(storage).toContain("msg.type === 'phase'")
        expect(storage).toContain('onProgress?.(msg.current ?? msg.bytes, msg.total ?? msg.totalBytes, msg.phase)')
        expect(storage).toContain("'converting'")
        expect(backupUi).toContain("phase === 'validating'")
        expect(backupUi).toContain("phase === 'converting'")
        expect(backupUi).toContain("phase === 'publishing'")
        expect(backupUi).toContain("phase === 'finalizing'")
        expect(backupUi).toContain('Math.floor((loaded / total) * 100)')
        expect(serverBackupUi).toContain("phase === 'validating'")
        expect(serverBackupUi).toContain("phase === 'converting'")
        expect(serverBackupUi).toContain("phase === 'publishing'")
        expect(serverBackupUi).toContain("phase === 'finalizing'")
        expect(server).toContain('onPublishProgress')
        expect(canonicalImport).toContain('onProgress: options.onProgress')
        expect(namedRepository).toContain('onProgress: importOptions.onProgress')
    })
})
