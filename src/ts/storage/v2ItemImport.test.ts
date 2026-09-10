import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '..', '..', '..')
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8')

describe('V2 item import connections', () => {
    it('connects authenticated preview and atomic execute routes', () => {
        const server = read('server/node/server.cjs')
        const nodeStorage = read('src/ts/storage/nodeStorage.ts')
        const autoStorage = read('src/ts/storage/autoStorage.ts')

        expect(server).toContain("app.post('/api/v2-items/preview'")
        expect(server).toContain("app.post('/api/v2-items/import'")
        expect(server).toContain('createV2ItemImportService')
        expect(server).toContain('canonicalProjectionSync.accept()')
        expect(nodeStorage).toContain('previewV2ItemImport')
        expect(nodeStorage).toContain('executeV2ItemImport')
        expect(autoStorage).toContain('previewV2ItemImport')
        expect(autoStorage).toContain('executeV2ItemImport')
    })
})
