import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('src/lang', () => ({ language: { setNodePassword: 'Set password', inputNodePassword: 'Password' } }))
vi.mock('../alert', () => ({ alertInput: vi.fn(async () => 'password'), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))
vi.mock('./database.svelte', () => ({ normalizeChat: (value: any) => value }))
import { NodeStorage } from './nodeStorage'
import { alertInput } from '../alert'

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
describe('native request authentication', () => {
    it('coalesces fresh password setup for parallel catalog and settings requests', async () => {
        ;(NodeStorage as any).sessionInitialized = false
        let passwordSet = false
        const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
            if (url === '/api/test_auth') return Response.json({ status: 'unset' })
            if (url === '/api/crypto') return new Response('hashed')
            if (url === '/api/set_password') {
                const status = passwordSet ? 400 : 200; passwordSet = true
                return Response.json({}, { status })
            }
            if (url === '/api/login') return Response.json({ token: 'token' })
            if (url === '/api/session') return Response.json({})
            expect(new Headers(options?.headers).get('risu-auth')).toBe('token')
            expect(new Headers(options?.headers).get('x-session-id')).toBeTruthy()
            return Response.json({ value: {} })
        })
        vi.stubGlobal('fetch', fetcher)
        const storage = new NodeStorage()
        await expect(Promise.all([storage.nativeRequest('/api/native/catalog'), storage.nativeRequest('/api/native/document?kind=settings&id=global')])).resolves.toHaveLength(2)
        expect(alertInput).toHaveBeenCalledTimes(1)
        expect(fetcher.mock.calls.filter(([url]) => url === '/api/set_password')).toHaveLength(1)
        expect(fetcher.mock.calls.filter(([url]) => url === '/api/session')).toHaveLength(1)
    })
    it('releases a failed authentication attempt so the next request can retry', async () => {
        let attempt = 0
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (url === '/api/test_auth') { if (++attempt === 1) throw new Error('offline'); return Response.json({ status: 'correct', token: 'token' }) }
            return Response.json({ value: {} })
        }))
        const storage = new NodeStorage()
        await expect(storage.nativeRequest('/api/native/catalog')).rejects.toThrow('offline')
        await expect(storage.nativeRequest('/api/native/catalog')).resolves.toEqual({ value: {} })
        expect(attempt).toBe(2)
    })
})
