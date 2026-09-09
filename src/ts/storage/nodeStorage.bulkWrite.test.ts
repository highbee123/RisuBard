import { describe, expect, it, vi } from 'vitest'

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('src/ts/stores.svelte', () => ({
    selIdState: { selId: 0 },
    DBState: { db: { characters: [] } },
}))
vi.mock('./database.svelte', () => ({
    normalizeChat: (value: unknown) => value,
    getCurrentChat: () => null,
    getCurrentCharacter: () => null,
    getDatabase: () => ({
        modules: [], enabledModules: [], personas: [], selectedPersona: 0,
        personaEnabledModules: {}, characters: [],
    }),
}))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))
vi.mock('./chatContentPage', () => ({ assembleChatContentPages: vi.fn() }))

import { NodeStorage, ConflictError } from './nodeStorage'

describe('NodeStorage bulk asset writes', () => {
    it('requests canonical reload after a successful save rewrites owner references', async () => {
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async () => new Response(JSON.stringify({ success: true, etag: 'canonical', canonicalReferencesChanged: true }), { status: 200 }))
        await expect(storage.setItem('database/database.bin', Uint8Array.of(1))).rejects.toMatchObject({
            constructor: ConflictError, canonicalFilesChanged: true, currentEtag: 'canonical',
        })
    })
    it('uses the canonical reload path for a successful patch with normalized owner references', async () => {
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async () => new Response(JSON.stringify({ success: true, etag: 'canonical', canonicalReferencesChanged: true }), { status: 200 }))
        expect(await storage.patchItem('database/database.bin', {} as any)).toMatchObject({ canonicalFilesChanged: true, etag: 'canonical' })
    })
    it('sends up to 200 small assets per binary request without base64 expansion', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
            JSON.stringify({ success: true }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ))
        ;(storage as any).authFetch = authFetch
        const entries = Array.from({ length: 201 }, (_, index) => ({
            key: `assets/${index}`,
            value: Uint8Array.of(index % 256),
        }))

        await storage.setItems(entries)

        expect(authFetch).toHaveBeenCalledTimes(2)
        for (const [call, expectedCount] of [[authFetch.mock.calls[0], 200], [authFetch.mock.calls[1], 1]] as const) {
            expect(call?.[1]?.headers).toMatchObject({ 'content-type': 'application/octet-stream' })
            const body = Buffer.from(call?.[1]?.body as Uint8Array)
            expect(body.readUInt32BE(0)).toBe(expectedCount)
        }
    })
})
